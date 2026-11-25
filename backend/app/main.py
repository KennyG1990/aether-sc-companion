"""AETHER FastAPI Server (v0.3.0) — Strict Player2 60s Heartbeat, Own ElevenLabs, Persona Interview & Telemetry."""

from __future__ import annotations

import asyncio
import json
import time
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, File, Response, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, StreamingResponse
from pydantic import BaseModel

from .config import AetherConfig, PersonaProfile
from .integrations.spotify import SpotifyConnector
from .llm.router import LLMRouter
from .rag.compiler import PromptCompiler
from .rag.embeddings import embed_via_player2
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


class PersonaInterviewRequest(BaseModel):
    ai_name: str = "Aether"
    pilot_name: str = "Commander"
    tone: str = ""
    verbosity: str = ""
    question_style: str = ""
    humor_style: str = ""
    custom_rules: str = ""


class SpotifyActionRequest(BaseModel):
    command: str
    query: str = ""
    media_type: str = "track"
    volume_pct: int | None = None
    dry_run: bool = False


class GameLinkTestRequest(BaseModel):
    state: str = "auto"  # auto | red | yellow | green


class MoodSetRequest(BaseModel):
    mood: str = "CALM"


class ConfigUpdateRequest(BaseModel):
    llm_provider: str | None = None
    player2_base_url: str | None = None
    player2_mcp_url: str | None = None
    player2_game_key: str | None = None
    player2_model: str | None = None
    openrouter_api_key: str | None = None
    openrouter_model: str | None = None
    tts_provider: str | None = None
    elevenlabs_voice_id: str | None = None
    elevenlabs_model_id: str | None = None
    elevenlabs_api_key: str | None = None
    spotify_client_id: str | None = None
    spotify_redirect_uri: str | None = None
    telemetry_mode: str | None = None
    grpc_target: str | None = None
    star_citizen_exe_path: str | None = None
    proactive_alerts_enabled: bool | None = None
    tts_enabled: bool | None = None
    wake_word_enabled: bool | None = None


class AetherRuntime:
    def __init__(self) -> None:
        self.config = AetherConfig.load_or_default()
        self.store = MemoryStore(self.config.db_path)
        self.compiler = PromptCompiler(self.store)
        self.executor = ActionExecutor(self.store)
        self.simulator = TelemetrySimulator()
        self.grpc_bridge = StarCitizenGrpcBridge(
            self.config.grpc_target,
            exe_path=self.config.star_citizen_exe_path,
        )
        self.triggers = TriggerEngine(cooldown_seconds=18.0)
        self.spotify = SpotifyConnector(self.config)
        self.voice = VoiceEngine(self.config)
        self.llm = LLMRouter(self.config, self.store, self.executor, spotify=self.spotify, voice=self.voice)

        self.recent_history: list[dict[str, str]] = []
        self._turns_since_distill: int = 0
        self.current_mood: str = "CALM"
        self._personality_cache: list[str] = [m["content"] for m in self.store.list_personality_memories(limit=24)]
        self._personality_cache_at: float = time.time()
        self.ui_clients: set[WebSocket] = set()
        self._telemetry_task: asyncio.Task[None] | None = None
        self._heartbeat_task: asyncio.Task[None] | None = None
        self._game_link_task: asyncio.Task[None] | None = None
        self.last_calibration: dict[str, Any] | None = None

        self.executor.set_dispatch_handler(self._dispatch_game_action)

    def _dispatch_game_action(self, action_id: str, params: dict[str, Any]) -> tuple[bool, str]:
        if self.config.telemetry_mode == "grpc":
            return self.grpc_bridge.dispatch_action(action_id, params)
        return self.simulator.apply_action(action_id, params)

    async def start_background_tasks(self) -> None:
        self._telemetry_task = asyncio.create_task(self._telemetry_loop())
        self._heartbeat_task = asyncio.create_task(self._player2_heartbeat_loop())
        self._game_link_task = asyncio.create_task(self._game_link_loop())
        # Kick off one quiet background embedding pass so seeded memories get dense Player2 vectors
        asyncio.create_task(self._background_embed_pass())

    async def _background_embed_pass(self) -> None:
        try:
            await self.store.embed_pending_via_player2(
                self.config.player2_base_url,
                self.config.player2_game_key,
            )
        except Exception:
            pass

    async def _background_distill_episode(self, turns_snapshot: list[dict[str, str]]) -> None:
        try:
            prose = await self.llm.distill_episode_prose(turns_snapshot)
            if prose:
                self.store.add_memory(
                    content=prose,
                    domain="episodic",
                    truth_class="model_summary",
                    provenance="auto_episode_distiller",
                    scope="private",
                )
            await self._background_embed_pass()
        except Exception:
            pass

    async def stop_background_tasks(self) -> None:
        for task in (self._telemetry_task, self._heartbeat_task, self._game_link_task):
            if task:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

    async def _game_link_loop(self) -> None:
        """Continuously watch for StarCitizen.exe & local gRPC API (127.0.0.1:2942) every 2.5s."""
        while True:
            try:
                info = await asyncio.to_thread(self.grpc_bridge.refresh_game_link)
                await self.broadcast({"type": "game_link_update", "game_link": info})
            except Exception:
                pass
            await asyncio.sleep(2.5)

    async def _player2_heartbeat_loop(self) -> None:
        """Official Player2 API requirement: ping GET /v1/health with player2-game-key every 60 seconds."""
        while True:
            hb = await self.voice.send_player2_heartbeat()
            await self.broadcast({"type": "player2_heartbeat", "heartbeat": hb})
            await asyncio.sleep(60.0)

    async def _telemetry_loop(self) -> None:
        while True:
            ship, fleet = self.simulator.step()
            now = time.time()
            if now - self._personality_cache_at >= 2.0:
                self._personality_cache = [m["content"] for m in self.store.list_personality_memories(limit=24)]
                self._personality_cache_at = now

            events = (
                self.triggers.evaluate(
                    ship,
                    fleet,
                    personality_memories=self._personality_cache,
                    persona_tone=self.config.persona.tone,
                    pilot_name=self.config.persona.pilot_name,
                )
                if self.config.proactive_alerts_enabled
                else []
            )

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
                "heartbeat": self.voice.heartbeat_state,
                "game_link": self.grpc_bridge.game_link_state,
                "mood": self.current_mood,
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
                "status": status,
                "detail": detail,
                "progress": progress,
                "timestamp": time.time(),
            }
            for idx, existing in enumerate(steps):
                if existing["id"] == step_id:
                    steps[idx] = item
                    break
            else:
                steps.append(item)
            await self.broadcast({"type": "calibration_progress", "step": item, "steps": steps})

        await emit_step("player2", "Player2 Neural Link, Heartbeat & MCP", "RUNNING", "Sending heartbeat ping & probing MCP...", 15)
        p2 = await self.voice.probe_player2()
        if p2["api_online"]:
            p2_detail = (
                f"Player2 v{p2['client_version']} (Mod {self.config.player2_game_key[:8]}..., "
                f"Heartbeat #{p2['heartbeat']['count']}, {p2['joules']} Joules) | MCP: {p2['mcp_server'] or 'offline'}"
            )
            await emit_step("player2", "Player2 Neural Link, Heartbeat & MCP", "OK", p2_detail, 30)
        else:
            await emit_step(
                "player2",
                "Player2 Neural Link, Heartbeat & MCP",
                "WARN",
                f"Player2 unreachable at {self.config.player2_base_url} (fallback active)",
                30,
            )
        await asyncio.sleep(0.3)

        await emit_step("voice", "ElevenLabs Voice Matrix", "RUNNING", "Verifying ElevenLabs vocal profiles...", 45)
        v_res = await self.voice.list_voices()
        voices = v_res.get("voices", [])
        selected_voice = next((v for v in voices if v["voice_id"] == self.config.elevenlabs_voice_id), None)
        voice_name = selected_voice["display_name"] if selected_voice else self.config.elevenlabs_voice_id[:12]
        if v_res.get("account_connected") and voices:
            await emit_step(
                "voice",
                "ElevenLabs Voice Matrix",
                "OK",
                f"Voice '{voice_name}' ready via {self.config.tts_provider} ({len(voices)} voices)",
                55,
            )
        else:
            await emit_step(
                "voice",
                "ElevenLabs Voice Matrix",
                "WARN",
                v_res.get("note", "ElevenLabs unavailable; browser speech fallback ready"),
                55,
            )
        await asyncio.sleep(0.3)

        await emit_step("rag", "SPEC-912 SQLite RAG & Persona Matrix", "RUNNING", "Verifying FTS5 BM25 + 512d index...", 70)
        mem_count = len(self.store.list_memories(limit=500))
        audit_count = len(self.store.list_security_audit(limit=50))
        probe_hits = self.store.hybrid_search("Stanton Master Modes", top_k=2)
        p = self.config.persona
        await emit_step(
            "rag",
            "SPEC-912 SQLite RAG & Persona Matrix",
            "OK",
            f"{mem_count} memories indexed (RRF hits: {len(probe_hits)}, {audit_count} injection blocks) | Identity: {p.ai_name} -> {p.pilot_name}",
            78,
        )
        await asyncio.sleep(0.3)

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
    await runtime.start_background_tasks()
    yield
    await runtime.stop_background_tasks()


app = FastAPI(
    title="AETHER — Star Citizen AI Companion & Holographic C2 Backend",
    version="0.3.0",
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
        "version": "0.3.0",
        "ai_name": runtime.config.persona.ai_name,
        "pilot_name": runtime.config.persona.pilot_name,
        "llm_provider": runtime.config.llm_provider,
        "tts_provider": runtime.config.tts_provider,
        "telemetry_mode": runtime.config.telemetry_mode,
        "heartbeat": runtime.voice.heartbeat_state,
        "grpc": runtime.grpc_bridge.status_dict(),
        "memory_count": len(runtime.store.list_memories(limit=500)),
        "fleet_count": len(runtime.simulator.allies),
    }


@app.get("/api/player2/status")
async def player2_status() -> dict[str, Any]:
    return await runtime.voice.probe_player2()


@app.post("/api/player2/heartbeat")
async def trigger_heartbeat() -> dict[str, Any]:
    return await runtime.voice.send_player2_heartbeat()


@app.get("/api/llm/models")
async def llm_models(provider: str | None = None) -> dict[str, Any]:
    prov = (provider or runtime.config.llm_provider).lower()
    models = await runtime.llm.list_models(prov)
    selected = runtime.config.player2_model if prov == "player2" else runtime.config.openrouter_model
    return {"provider": prov, "selected_model": selected, "models": models}


@app.get("/api/tts/voices")
async def tts_voices(provider: str | None = None) -> dict[str, Any]:
    res = await runtime.voice.list_voices(provider)
    return {
        "tts_provider": res["provider"],
        "account_connected": res["account_connected"],
        "note": res.get("note"),
        "selected_voice_id": runtime.config.elevenlabs_voice_id,
        "voices": res["voices"],
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


@app.post("/api/stt/transcribe")
async def stt_transcribe(file: UploadFile = File(...)) -> dict[str, Any]:
    audio_bytes = await file.read()
    return await runtime.voice.transcribe_audio(
        audio_bytes=audio_bytes,
        filename=file.filename or "speech.wav",
        content_type=file.content_type or "audio/wav",
    )


@app.post("/api/stt/p2/start")
async def stt_p2_start() -> dict[str, Any]:
    return await runtime.voice.start_native_stt(timeout_sec=30.0)


@app.post("/api/stt/p2/stop")
async def stt_p2_stop() -> dict[str, Any]:
    return await runtime.voice.stop_native_stt()


@app.post("/api/calibrate")
async def calibrate() -> dict[str, Any]:
    return await runtime.run_calibration()


@app.get("/api/persona")
def get_persona() -> dict[str, Any]:
    return runtime.config.persona.model_dump()


@app.post("/api/persona")
def save_persona(profile: PersonaProfile) -> dict[str, Any]:
    runtime.config.persona = profile
    runtime.config.save_to_disk()
    runtime.store.add_memory(
        content=f"Personality calibration updated: AI name={profile.ai_name}, Pilot={profile.pilot_name}, Tone={profile.tone}, Humor={profile.humor_style}.",
        domain="preference",
        truth_class="firsthand_observation",
        provenance="persona_calibration",
        semantic_key="persona.active_profile",
    )
    return runtime.config.persona.model_dump()


@app.post("/api/persona/interview/complete")
async def complete_persona_interview(req: PersonaInterviewRequest) -> dict[str, Any]:
    profile, greeting = await runtime.llm.synthesize_persona_from_interview(req.model_dump())
    runtime.config.persona = profile
    runtime.config.save_to_disk()
    runtime.store.add_memory(
        content=f"Personality interview completed: {profile.persona_summary} Rules: {profile.custom_rules}",
        domain="preference",
        truth_class="firsthand_observation",
        provenance="persona_interview",
        semantic_key="persona.active_profile",
    )
    return {"persona": profile.model_dump(), "greeting": greeting}


@app.get("/api/config")
async def get_config() -> dict[str, Any]:
    data = runtime.config.model_dump()
    data["openrouter_api_key_set"] = bool(data.pop("openrouter_api_key"))
    data["elevenlabs_api_key_set"] = bool(data.pop("elevenlabs_api_key"))
    data.pop("spotify_access_token", None)
    data.pop("spotify_refresh_token", None)
    data["spotify_status"] = runtime.spotify.status_dict()
    data["grpc_status"] = runtime.grpc_bridge.status_dict()
    data["game_link"] = runtime.grpc_bridge.game_link_state
    data["mood"] = runtime.current_mood
    data["player2_status"] = await runtime.voice.probe_player2()
    return data


@app.get("/api/game-link")
async def get_game_link() -> dict[str, Any]:
    return await asyncio.to_thread(runtime.grpc_bridge.refresh_game_link)


@app.post("/api/game-link/test")
async def test_game_link(req: GameLinkTestRequest) -> dict[str, Any]:
    state = None if req.state.lower() == "auto" else req.state.lower()
    info = await asyncio.to_thread(runtime.grpc_bridge.set_test_override, state)
    await runtime.broadcast({"type": "game_link_update", "game_link": info})
    return info


@app.post("/api/mood")
async def set_mood(req: MoodSetRequest) -> dict[str, Any]:
    runtime.current_mood = (req.mood or "CALM").strip().upper()
    await runtime.broadcast({"type": "mood_update", "mood": runtime.current_mood})
    return {"mood": runtime.current_mood}


@app.get("/api/spotify/status")
def spotify_status() -> dict[str, Any]:
    return runtime.spotify.status_dict()


@app.get("/api/spotify/auth/start")
def spotify_auth_start() -> dict[str, Any]:
    return runtime.spotify.build_auth_url()


@app.get("/api/spotify/callback", response_class=HTMLResponse)
async def spotify_callback(code: str | None = None, state: str | None = None, error: str | None = None) -> str:
    if error or not code or not state:
        msg = f"Spotify authorization cancelled or failed ({error or 'missing parameters'})."
        return (
            "<html><body style='background:#040914;color:#fca5a5;font-family:Segoe UI,sans-serif;padding:40px;'>"
            f"<h2>AETHER // Spotify Connector</h2><p>{msg}</p><p>You may close this tab.</p></body></html>"
        )
    ok, detail = await runtime.spotify.exchange_code(code, state)
    color = "#6ee7b7" if ok else "#fca5a5"
    return (
        f"<html><body style='background:#040914;color:{color};font-family:Segoe UI,sans-serif;padding:40px;'>"
        f"<h2>AETHER // Spotify Connector</h2><p>{detail}</p>"
        "<p style='color:#94a3b8'>You can close this tab and return to AETHER — voice playback is ready!</p></body></html>"
    )


@app.post("/api/spotify/action")
async def spotify_action(req: SpotifyActionRequest) -> dict[str, Any]:
    ok, detail, meta = await runtime.spotify.execute_command(
        command=req.command,
        query=req.query,
        media_type=req.media_type,
        volume_pct=req.volume_pct,
        dry_run=req.dry_run,
    )
    return runtime.store.record_receipt(
        action_id=f"spotify:{req.command}",
        parameters=meta,
        status="CONFIRMED" if ok else "FAILED",
        reason=detail,
        source="ui_spotify",
    )


@app.post("/api/spotify/disconnect")
def spotify_disconnect() -> dict[str, Any]:
    runtime.spotify.disconnect()
    return runtime.spotify.status_dict()


@app.post("/api/config")
async def update_config(req: ConfigUpdateRequest) -> dict[str, Any]:
    updates = req.model_dump(exclude_none=True)
    for key, val in updates.items():
        if hasattr(runtime.config, key):
            setattr(runtime.config, key, val)
    if "grpc_target" in updates:
        runtime.grpc_bridge.target = runtime.config.grpc_target
    if "star_citizen_exe_path" in updates:
        runtime.grpc_bridge.set_configured_exe(runtime.config.star_citizen_exe_path)
    runtime.config.save_to_disk()
    info = await asyncio.to_thread(runtime.grpc_bridge.refresh_game_link)
    await runtime.broadcast({"type": "game_link_update", "game_link": info})
    return await get_config()


def _finalize_chat_turn(compiled: Any, result: dict[str, Any]) -> None:
    """Commit conversation history, lossless 6-line archiving & off-path embedding/distillation."""
    runtime.recent_history.append({"role": "user", "content": compiled.user_message})
    runtime.recent_history.append({"role": "assistant", "content": result["reply"]})
    runtime._turns_since_distill += 2
    if any(m.get("domain") == "personality" for m in (result.get("saved_memories") or [])):
        runtime._personality_cache = [m["content"] for m in runtime.store.list_personality_memories(limit=24)]
        runtime._personality_cache_at = time.time()

    # Full-history Conversation RAG (aic_history.lua): archive trimmed turns instead of deleting!
    if len(runtime.recent_history) > 8:
        overflow = runtime.recent_history[:-8]
        runtime.recent_history = runtime.recent_history[-8:]
        runtime.store.archive_turns(overflow)

    # Automatic background prose memory distillation & dense embedding off the reply path (aic_memory.lua)
    if runtime._turns_since_distill >= 6:
        runtime._turns_since_distill = 0
        asyncio.create_task(runtime._background_distill_episode(list(runtime.recent_history[-6:])))
    else:
        asyncio.create_task(runtime._background_embed_pass())


@app.post("/api/chat")
async def chat(req: ChatRequest) -> dict[str, Any]:
    ship_dict = runtime.simulator.ship.model_dump()
    fleet_list = [a.model_dump() for a in runtime.simulator.allies.values()]
    actions = runtime.executor.list_triggerable_actions()

    # Non-blocking fast RAG on hot reply path (<2 ms local BM25 + 512d RRF); dense Player2 vectors backfill in background!
    compiled = runtime.compiler.compile(
        user_utterance=req.message,
        telemetry_snapshot=ship_dict,
        fleet_snapshot=fleet_list,
        available_actions=actions,
        recent_history=runtime.recent_history,
        pilot_callsign=runtime.config.pilot_callsign,
        ship_name=runtime.config.ship_name,
        persona=runtime.config.persona,
    )

    result = await runtime.llm.respond(
        compiled=compiled,
        recent_history=runtime.recent_history,
        telemetry_snapshot=ship_dict,
        fleet_snapshot=fleet_list,
    )

    _finalize_chat_turn(compiled, result)
    if result.get("mood"):
        runtime.current_mood = str(result["mood"]).upper()
        await runtime.broadcast({"type": "mood_update", "mood": runtime.current_mood})

    for cmd in result.get("ui_commands") or []:
        cmd_stamped = {**cmd, "cmd_id": f"cmd_{int(time.time() * 1000)}_{id(cmd) % 10000}"}
        await runtime.broadcast({"type": "ui_command", "command": cmd_stamped})

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
        "retrieved_history_count": len(compiled.retrieved_history),
        "pending_confirmations": runtime.executor.list_pending(),
    }


@app.post("/api/chat/stream")
async def chat_stream(req: ChatRequest) -> StreamingResponse:
    """Real-time SSE chat stream: instant token updates, first-sentence parallel ElevenLabs TTS,
    single-turn tool execution, and immediate WebSocket UI command broadcast."""
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
        persona=runtime.config.persona,
    )

    async def event_gen():
        started = time.perf_counter()

        async def _broadcast_ui(cmd: dict[str, Any]) -> None:
            if "cmd_id" not in cmd:
                cmd["cmd_id"] = f"cmd_{int(time.time() * 1000)}_{id(cmd) % 10000}"
            await runtime.broadcast({"type": "ui_command", "command": cmd})

        async for evt in runtime.llm.respond_stream(
            compiled=compiled,
            recent_history=runtime.recent_history,
            telemetry_snapshot=ship_dict,
            fleet_snapshot=fleet_list,
            on_ui_command=_broadcast_ui,
        ):
            ev_name = evt["event"]
            if ev_name == "done":
                result = evt["result"]
                _finalize_chat_turn(compiled, result)
                if result.get("mood"):
                    runtime.current_mood = str(result["mood"]).upper()
                    await runtime.broadcast({"type": "mood_update", "mood": runtime.current_mood})
                payload = {
                    **result,
                    "elapsed_ms": round((time.perf_counter() - started) * 1000),
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
                    "retrieved_history_count": len(compiled.retrieved_history),
                    "pending_confirmations": runtime.executor.list_pending(),
                }
                yield f"event: done\ndata: {json.dumps(payload)}\n\n"
            elif ev_name == "ui_command":
                cmd = evt["command"]
                if "cmd_id" not in cmd:
                    cmd["cmd_id"] = f"cmd_{int(time.time() * 1000)}_{id(cmd) % 10000}"
                yield f"event: ui_command\ndata: {json.dumps(cmd)}\n\n"
            else:
                yield f"event: {ev_name}\ndata: {json.dumps(evt)}\n\n"

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


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
