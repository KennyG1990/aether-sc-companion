"""AETHER FastAPI Server — Telemetry WebSocket, Fleet Relay Hub, RAG Memory & Dual LLM Co-Pilot."""

from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .config import AetherConfig
from .llm.router import LLMRouter
from .rag.compiler import PromptCompiler
from .rag.store import MemoryStore
from .telemetry.actions import ActionExecutor
from .telemetry.grpc_bridge import StarCitizenGrpcBridge
from .telemetry.simulator import TelemetrySimulator
from .telemetry.triggers import TriggerEngine


class ChatRequest(BaseModel):
    message: str


class MemoryCreateRequest(BaseModel):
    content: str
    domain: str = "episodic"
    truth_class: str = "user_claim"
    scope: str = "private"


class ActionRequest(BaseModel):
    action_id: str
    confirmed: bool = False


class ConfirmRequest(BaseModel):
    token: str
    approve: bool = True


class ScenarioRequest(BaseModel):
    scenario: str


class ConfigUpdateRequest(BaseModel):
    llm_provider: str | None = None
    player2_base_url: str | None = None
    player2_game_key: str | None = None
    openrouter_api_key: str | None = None
    openrouter_model: str | None = None
    telemetry_mode: str | None = None
    proactive_alerts_enabled: bool | None = None
    tts_enabled: bool | None = None


class AetherRuntime:
    def __init__(self) -> None:
        self.config = AetherConfig()
        self.store = MemoryStore(self.config.db_path)
        self.compiler = PromptCompiler(self.store)
        self.executor = ActionExecutor(self.store)
        self.simulator = TelemetrySimulator()
        self.grpc_bridge = StarCitizenGrpcBridge(self.config.grpc_target)
        self.triggers = TriggerEngine(cooldown_seconds=18.0)
        self.llm = LLMRouter(self.config, self.store, self.executor)

        self.recent_history: list[dict[str, str]] = []
        self.ui_clients: set[WebSocket] = set()
        self._telemetry_task: asyncio.Task[None] | None = None

        self.executor.set_dispatch_handler(self._dispatch_game_action)

    def _dispatch_game_action(self, action_id: str, params: dict[str, Any]) -> tuple[bool, str]:
        if self.config.telemetry_mode == "grpc":
            return self.grpc_bridge.dispatch_action(action_id, params)
        return self.simulator.apply_action(action_id, params)

    async def start_telemetry_loop(self) -> None:
        self._telemetry_task = asyncio.create_task(self._telemetry_loop())

    async def stop_telemetry_loop(self) -> None:
        if self._telemetry_task:
            self._telemetry_task.cancel()
            try:
                await self._telemetry_task
            except asyncio.CancelledError:
                pass

    async def _telemetry_loop(self) -> None:
        # ~17 Hz native Star Citizen cadence (58ms)
        while True:
            ship, fleet = self.simulator.step()
            events = self.triggers.evaluate(ship, fleet) if self.config.proactive_alerts_enabled else []

            if events:
                for ev in events:
                    self.store.add_memory(
                        content=f"Telemetry Alert [{ev.event_type}]: {ev.summary}",
                        domain="episodic",
                        truth_class="authoritative_telemetry",
                        provenance="trigger_engine",
                        scope="private",
                        semantic_key=f"alert.{ev.event_type}.{int(ev.timestamp)}",
                        confidence=1.0,
                    )

            packet = {
                "type": "telemetry_frame",
                "ship": ship.model_dump(),
                "fleet": [a.model_dump() for a in fleet],
                "events": [e.model_dump() for e in events],
                "pending_confirmations": self.executor.list_pending(),
                "grpc_status": {
                    "mode": self.config.telemetry_mode,
                    "target": self.config.grpc_target,
                    "connected": self.grpc_bridge.connected,
                },
            }
            await self.broadcast(packet)
            await asyncio.sleep(0.06)

    async def broadcast(self, payload: dict[str, Any]) -> None:
        if not self.ui_clients:
            return
        raw = json.dumps(payload)
        dead: list[WebSocket] = []
        for ws in list(self.ui_clients):
            try:
                await ws.send_text(raw)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.ui_clients.discard(ws)


runtime = AetherRuntime()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await runtime.start_telemetry_loop()
    yield
    await runtime.stop_telemetry_loop()


app = FastAPI(
    title="AETHER — Star Citizen AI Companion & Holographic C2 Backend",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "name": "AETHER",
        "version": "0.1.0",
        "llm_provider": runtime.config.llm_provider,
        "telemetry_mode": runtime.config.telemetry_mode,
        "grpc": runtime.grpc_bridge.status_dict(),
        "memory_count": len(runtime.store.list_memories(limit=500)),
        "fleet_count": len(runtime.simulator.allies),
    }


@app.get("/api/config")
def get_config() -> dict[str, Any]:
    data = runtime.config.model_dump()
    # Never expose raw API key back to browser
    data["openrouter_api_key_set"] = bool(data.pop("openrouter_api_key"))
    data["grpc_status"] = runtime.grpc_bridge.status_dict()
    return data


@app.post("/api/config")
def update_config(req: ConfigUpdateRequest) -> dict[str, Any]:
    updates = req.model_dump(exclude_none=True)
    for key, val in updates.items():
        if hasattr(runtime.config, key):
            setattr(runtime.config, key, val)
    return get_config()


@app.post("/api/chat")
async def chat(req: ChatRequest) -> dict[str, Any]:
    ship_dict = runtime.simulator.ship.model_dump()
    fleet_list = [a.model_dump() for a in runtime.simulator.allies.values()]
    actions = runtime.executor.list_triggerable_actions()

    compiled = runtime.compiler.compile(
        user_utterance=req.message,
        telemetry_snapshot=ship_dict,
        fleet_snapshot=fleet_list,
        available_actions=actions,
        recent_history=runtime.recent_history,
        pilot_callsign=runtime.config.pilot_callsign,
        ship_name=runtime.config.ship_name,
    )

    result = await runtime.llm.respond(
        compiled=compiled,
        recent_history=runtime.recent_history,
        telemetry_snapshot=ship_dict,
        fleet_snapshot=fleet_list,
    )

    runtime.recent_history.append({"role": "user", "content": compiled.user_message})
    runtime.recent_history.append({"role": "assistant", "content": result["reply"]})
    runtime.recent_history = runtime.recent_history[-16:]

    return {
        **result,
        "injection_flagged": compiled.injection_flagged,
        "injection_reasons": compiled.injection_reasons,
        "retrieved_memories": [
            {
                "id": m.id,
                "domain": m.domain,
                "truth_class": m.truth_class,
                "provenance": m.provenance,
                "content": m.content,
                "bm25_rank": m.bm25_rank,
                "vector_score": m.vector_score,
                "rrf_score": m.rrf_score,
            }
            for m in compiled.retrieved_memories
        ],
        "pending_confirmations": runtime.executor.list_pending(),
    }


@app.get("/api/memories")
def list_memories(q: str | None = None, domain: str | None = None) -> dict[str, Any]:
    if q:
        hits = runtime.store.hybrid_search(q, top_k=10)
        return {
            "mode": "hybrid_rrf",
            "query": q,
            "items": [
                {
                    "id": m.id,
                    "semantic_key": m.semantic_key,
                    "domain": m.domain,
                    "truth_class": m.truth_class,
                    "provenance": m.provenance,
                    "scope": m.scope,
                    "content": m.content,
                    "bm25_rank": m.bm25_rank,
                    "vector_score": m.vector_score,
                    "rrf_score": m.rrf_score,
                }
                for m in hits
            ],
        }
    return {
        "mode": "list",
        "items": runtime.store.list_memories(limit=60, domain=domain),
        "security_audit": runtime.store.list_security_audit(limit=15),
    }


@app.post("/api/memories")
def create_memory(req: MemoryCreateRequest) -> dict[str, Any]:
    return runtime.store.add_memory(
        content=req.content,
        domain=req.domain,
        truth_class=req.truth_class,
        provenance="pilot_manual_entry",
        scope=req.scope,
    )


@app.get("/api/actions")
def list_actions() -> dict[str, Any]:
    return {
        "actions": runtime.executor.list_triggerable_actions(),
        "receipts": runtime.store.list_receipts(limit=30),
        "pending_confirmations": runtime.executor.list_pending(),
    }


@app.post("/api/actions/execute")
def execute_action(req: ActionRequest) -> dict[str, Any]:
    return runtime.executor.execute(
        action_id=req.action_id,
        source="ui_command",
        confirmed=req.confirmed,
    )


@app.post("/api/actions/confirm")
def confirm_action(req: ConfirmRequest) -> dict[str, Any]:
    return runtime.executor.confirm_pending(req.token, approve=req.approve)


@app.post("/api/scenario")
def trigger_scenario(req: ScenarioRequest) -> dict[str, Any]:
    detail = runtime.simulator.trigger_scenario(req.scenario)
    return {"scenario": req.scenario, "detail": detail}


@app.websocket("/ws/telemetry")
async def ws_telemetry(ws: WebSocket) -> None:
    await ws.accept()
    runtime.ui_clients.add(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        runtime.ui_clients.discard(ws)


@app.websocket("/ws/fleet")
async def ws_fleet_relay(ws: WebSocket) -> None:
    """Inbound WebSocket endpoint for allied Fleet Relay clients (relay/aether_relay.py)."""
    await ws.accept()
    try:
        while True:
            raw = await ws.receive_text()
            payload = json.loads(raw)
            ally = runtime.simulator.upsert_relay_ally(payload)
            await ws.send_text(json.dumps({"ack": True, "callsign": ally.callsign}))
    except WebSocketDisconnect:
        pass
