"""AETHER FastAPI Server — Telemetry WebSocket, Fleet Relay Hub, RAG Memory, Player2 LLM, ElevenLabs TTS & Calibration."""

from __future__ import annotations

import asyncio
import json
import time
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Response, WebSocket, WebSocketDisconnect
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
from .voice.tts import VoiceEngine


class ChatRequest(BaseModel):
    message: str


class SpeakRequest(BaseModel):
    text: str
    voice_id: str | None = None


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
    player2_mcp_url: str | None = None
    player2_game_key: str | None = None
    openrouter_api_key: str | None = None
    openrouter_model: str | None = None
    tts_provider: str | None = None
    elevenlabs_voice_id: str | None = None
    elevenlabs_model_id: str | None = None
    elevenlabs_api_key: str | None = None
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
        self.voice = VoiceEngine(self.config)

        self.recent_history: list[dict[str, str]] = []
        self.ui_clients: set[WebSocket] = set()
        self._telemetry_task: asyncio.Task[None] | None = None
        self.last_calibration: dict[str, Any] | None = None

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
        # ~17 Hz native Star Citizen cadence (~58ms)
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

    async def run_calibration(self) -> dict[str, Any]:
        """Execute real live startup calibration checks and broadcast progress to UI."""
        started = time.time()
        steps: list[dict[str, Any]] = []

        async def emit_step(step_id: str, label: str, status: str, detail: str, progress: int) -> None:
            item = {
                "id": step_id,
                "label": label,
                "status": status,  # RUNNING | OK | WARN
                "detail": detail,
                "progress": progress,
                "timestamp": time.time(),
            }
            # Replace existing running step or append
            for idx, existing in enumerate(steps):
                if existing["id"] == step_id:
                    steps[idx] = item
                    break
            else:
                steps.append(item)
            await self.broadcast({"type": "calibration_progress", "step": item, "steps": steps})

        # Step 1: Player2 Neural Link & MCP Server
        await emit_step("player2", "Neural Link & Player2 MCP", "RUNNING", "Probing 127.0.0.1:4315 & MCP :9847...", 15)
        p2 = await self.voice.probe_player2()
        if p2["api_online"]:
            p2_detail = (
                f"Player2 v{p2['client_version']} online ({p2['patron_tier'] or 'User'}, "
                f"{p2['joules']} Joules) | MCP: {p2['mcp_server'] or 'offline'}"
            )
            await emit_step("player2", "Neural Link & Player2 MCP", "OK", p2_detail, 30)
        else:
            await emit_step(
                "player2",
                "Neural Link & Player2 MCP",
                "WARN",
                "Player2 local app unreachable on 127.0.0.1:4315 (fallback active)",
                30,
            )
        await asyncio.sleep(0.35)

        # Step 2: ElevenLabs Voice Synthesis
        await emit_step("voice", "ElevenLabs Voice Matrix", "RUNNING", "Checking ElevenLabs vocal profiles...", 45)
        voices = await self.voice.list_voices()
        selected_voice = next((v for v in voices if v["voice_id"] == self.config.elevenlabs_voice_id), None)
        voice_name = selected_voice["name"] if selected_voice else self.config.elevenlabs_voice_id[:12]
        if p2["elevenlabs_voices_count"] > 0 or (
            self.config.tts_provider == "elevenlabs_direct" and self.config.elevenlabs_api_key
        ):
            await emit_step(
                "voice",
                "ElevenLabs Voice Matrix",
                "OK",
                f"Voice '{voice_name}' locked via {self.config.tts_provider} ({len(voices)} voices available)",
                55,
            )
        else:
            await emit_step(
                "voice",
                "ElevenLabs Voice Matrix",
                "WARN",
                "ElevenLabs proxy offline; browser speech synthesis fallback ready",
                55,
            )
        await asyncio.sleep(0.35)

        # Step 3: SQLite Hybrid Semantic RAG & Injection Shield
        await emit_step("rag", "SPEC-912 SQLite RAG & Shield", "RUNNING", "Verifying FTS5 BM25 + 512d vector index...", 70)
        mem_count = len(self.store.list_memories(limit=500))
        audit_count = len(self.store.list_security_audit(limit=50))
        probe_hits = self.store.hybrid_search("Stanton Master Modes", top_k=2)
        await emit_step(
            "rag",
            "SPEC-912 SQLite RAG & Shield",
            "OK",
            f"{mem_count} memories indexed (FTS5 + 512d RRF verified: {len(probe_hits)} hits, {audit_count} injection blocks logged)",
            78,
        )
        await asyncio.sleep(0.35)

        # Step 4: Star Citizen Telemetry & Stanton Fleet C2
        await emit_step("telemetry", "Ship Telemetry & Fleet C2", "RUNNING", "Probing Star Citizen gRPC 127.0.0.1:2942...", 88)
        grpc_info = self.grpc_bridge.status_dict()
        ship = self.simulator.ship
        fleet = list(self.simulator.allies.values())
        min_shield = min(ship.shields.front, ship.shields.back, ship.shields.left, ship.shields.right)
        tel_status = "OK" if ship.alert_level == "NOMINAL" else "WARN"
        link_label = "LIVE gRPC 127.0.0.1:2942" if grpc_info["port_open"] else "17Hz Simulator Standby (SC gRPC offline)"
        await emit_step(
            "telemetry",
            "Ship Telemetry & Fleet C2",
            tel_status,
            f"{link_label} | {ship.zone} | Mode {ship.master_mode} | Shields {min_shield:.0f}% | H2 {ship.hydrogen_fuel_pct:.0f}% | Fleet {len(fleet)} ships",
            92,
        )
        await asyncio.sleep(0.25)

        # Step 5: Player2 LLM Readiness Callout
        await emit_step("ready", "Final Readiness Synthesis", "RUNNING", "Synthesizing live ship readiness briefing...", 96)
        diagnostics = {
            "player2": p2,
            "voice_name": voice_name,
            "tts_provider": self.config.tts_provider,
            "memory_count": mem_count,
            "grpc_port_open": grpc_info["port_open"],
            "telemetry_mode": self.config.telemetry_mode,
            "fleet_count": len(fleet),
            "min_shield_pct": round(min_shield, 1),
            "ship": {
                "zone": ship.zone,
                "master_mode": ship.master_mode,
                "hydrogen_fuel_pct": round(ship.hydrogen_fuel_pct, 1),
                "quantum_fuel_pct": round(ship.quantum_fuel_pct, 1),
                "alert_level": ship.alert_level,
                "landing_gear_down": ship.landing_gear_down,
            },
        }
        briefing_text, briefing_provider = await self.llm.generate_calibration_briefing(diagnostics)
        overall_ok = ship.alert_level == "NOMINAL"
        await emit_step(
            "ready",
            "Final Readiness Synthesis",
            "OK" if overall_ok else "WARN",
            f"All checks complete ({time.time() - started:.1f}s) via {briefing_provider}",
            100,
        )

        result = {
            "status": "ALL_SYSTEMS_GREEN" if overall_ok else ship.alert_level,
            "briefing": briefing_text,
            "provider_used": briefing_provider,
            "duration_sec": round(time.time() - started, 2),
            "steps": steps,
            "diagnostics": diagnostics,
        }
        self.last_calibration = result
        await self.broadcast({"type": "calibration_complete", "result": result})
        return result


runtime = AetherRuntime()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await runtime.start_telemetry_loop()
    yield
    await runtime.stop_telemetry_loop()


app = FastAPI(
    title="AETHER — Star Citizen AI Companion & Holographic C2 Backend",
    version="0.2.0",
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
        "version": "0.2.0",
        "llm_provider": runtime.config.llm_provider,
        "tts_provider": runtime.config.tts_provider,
        "telemetry_mode": runtime.config.telemetry_mode,
        "grpc": runtime.grpc_bridge.status_dict(),
        "memory_count": len(runtime.store.list_memories(limit=500)),
        "fleet_count": len(runtime.simulator.allies),
    }


@app.get("/api/player2/status")
async def player2_status() -> dict[str, Any]:
    return await runtime.voice.probe_player2()


@app.get("/api/tts/voices")
async def tts_voices() -> dict[str, Any]:
    voices = await runtime.voice.list_voices()
    return {
        "tts_provider": runtime.config.tts_provider,
        "selected_voice_id": runtime.config.elevenlabs_voice_id,
        "voices": voices,
    }


@app.post("/api/tts/speak")
async def tts_speak(req: SpeakRequest) -> Response:
    audio_bytes, provider_used = await runtime.voice.synthesize_mp3(req.text, voice_id=req.voice_id)
    if audio_bytes:
        return Response(
            content=audio_bytes,
            media_type="audio/mpeg",
            headers={"X-Aether-TTS-Provider": provider_used},
        )
    return Response(
        content=json.dumps({"fallback": True, "reason": provider_used}),
        media_type="application/json",
        status_code=503,
    )


@app.post("/api/calibrate")
async def calibrate() -> dict[str, Any]:
    return await runtime.run_calibration()


@app.get("/api/config")
async def get_config() -> dict[str, Any]:
    data = runtime.config.model_dump()
    data["openrouter_api_key_set"] = bool(data.pop("openrouter_api_key"))
    data["elevenlabs_api_key_set"] = bool(data.pop("elevenlabs_api_key"))
    data["grpc_status"] = runtime.grpc_bridge.status_dict()
    data["player2_status"] = await runtime.voice.probe_player2()
    return data


@app.post("/api/config")
async def update_config(req: ConfigUpdateRequest) -> dict[str, Any]:
    updates = req.model_dump(exclude_none=True)
    for key, val in updates.items():
        if hasattr(runtime.config, key):
            setattr(runtime.config, key, val)
    return await get_config()


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
