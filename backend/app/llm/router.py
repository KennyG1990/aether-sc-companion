"""Unified Decision Authority Router: Strict Player2 API <-> OpenRouter <-> Offline Demo.

Includes live per-provider model catalogs and Person-to-AI Personality Interview synthesis.
"""

from __future__ import annotations

import json
import random
import re
from typing import Any

import httpx

from ..config import AetherConfig, PersonaProfile
from ..integrations.spotify import SpotifyConnector
from ..rag.compiler import CompiledPrompt
from ..rag.store import MemoryStore
from ..telemetry.actions import ActionExecutor
from ..voice.tts import VoiceEngine

JOKES = [
    "Why did the Drake Corsair pilot bring duct tape to Orison? Because structural integrity is more of a suggestion than a feature.",
    "What's the deadliest boss fight in Stanton? A Grim HEX elevator right after you've loaded 400 SCU of refined Quantanium.",
    "A Vanduul Scythe, a pirate Cutlass, and an Origin 890 Jump walk into a hangar. Only the 890 Jump asks for champagne before exploding.",
    "Why do Star Citizen pilots love Master Modes? Because nothing says 'relaxing road trip' like turning off your shields at 1,100 meters per second.",
]

CURATED_OPENROUTER_MODELS = [
    {"id": "anthropic/claude-3.7-sonnet", "name": "Claude 3.7 Sonnet", "detail": "Anthropic"},
    {"id": "anthropic/claude-3.5-haiku", "name": "Claude 3.5 Haiku", "detail": "Fast / Low-Latency"},
    {"id": "google/gemini-2.5-pro", "name": "Gemini 2.5 Pro", "detail": "Google"},
    {"id": "google/gemini-2.5-flash", "name": "Gemini 2.5 Flash", "detail": "Fast / Low-Latency"},
    {"id": "openai/gpt-4o", "name": "GPT-4o", "detail": "OpenAI"},
    {"id": "openai/gpt-4o-mini", "name": "GPT-4o Mini", "detail": "Fast / Budget"},
    {"id": "deepseek/deepseek-chat-v3-0324", "name": "DeepSeek V3", "detail": "DeepSeek"},
    {"id": "meta-llama/llama-3.3-70b-instruct", "name": "Llama 3.3 70B", "detail": "Meta"},
]

TOOL_DEFINITIONS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "trigger_game_action",
            "description": "Execute a validated Star Citizen ship or player action via TriggerGameActions.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action_id": {
                        "type": "string",
                        "description": "Action ID from the available actions list (e.g., toggle_landing_gear, set_master_mode_nav, toggle_doors, self_destruct).",
                    }
                },
                "required": ["action_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "save_memory",
            "description": "Save a durable fact, crew note, preference, or running joke into AETHER's SQLite semantic memory.",
            "parameters": {
                "type": "object",
                "properties": {
                    "content": {"type": "string", "description": "Fact or memory to remember."},
                    "domain": {
                        "type": "string",
                        "enum": ["episodic", "fleet", "preference", "lore"],
                        "description": "Memory category.",
                    },
                },
                "required": ["content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "spotify_control",
            "description": "Launch Spotify and play a requested song, artist, album, or playlist, or control playback (pause, resume, next, previous, volume, now_playing).",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "enum": ["play", "pause", "resume", "next", "previous", "volume", "launch", "now_playing"],
                        "description": "Spotify playback or launch action.",
                    },
                    "query": {
                        "type": "string",
                        "description": "Song name, artist, album, or playlist to search & play (used with command='play').",
                    },
                    "media_type": {
                        "type": "string",
                        "enum": ["track", "playlist", "album", "artist"],
                        "description": "Type of Spotify item to search (default 'track').",
                    },
                    "volume_pct": {
                        "type": "integer",
                        "description": "Target volume percentage 0-100 (used with command='volume').",
                    },
                },
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "change_voice",
            "description": "Change AETHER's live ElevenLabs / Player2 speaking voice on the fly. Use whenever the pilot asks for a specific voice/accent/gender ('British man', 'female narrator', 'Australian', a voice name) OR asks 'what do you want to sound like?' (pass query='choose_for_myself'). The very next spoken reply immediately uses the newly chosen voice!",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Requested voice style, accent, gender, name (e.g. 'British man', 'warm female', 'Adam'), or 'choose_for_myself' to autonomously pick a voice.",
                    },
                    "tts_provider": {
                        "type": "string",
                        "enum": ["player2_elevenlabs", "elevenlabs_direct"],
                        "description": "Optional voice source override. Only pass if the user explicitly asks to switch between Player2 voices and their own ElevenLabs account.",
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "control_hologram",
            "description": "Control AETHER's Star Citizen 3D Holographic Map & Camera. IMPORTANT: focus_self, focus_ally, and focus_planet AUTOMATICALLY open the hologram AND fly/zoom in a SINGLE call! Always use action='focus_ally' (with target='Kestrel' or 'friend') whenever asked to find/show/snap to a friend, action='focus_self' whenever asked 'where are we?' or 'show our grid', and action='zoom_out'/'zoom_in' (with steps=1..3) for zoom commands.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": [
                            "open",
                            "close",
                            "focus_self",
                            "focus_ally",
                            "focus_planet",
                            "zoom_in",
                            "zoom_out",
                            "reset_view",
                            "set_view_mode",
                        ],
                        "description": "Hologram view or camera command.",
                    },
                    "target": {
                        "type": "string",
                        "description": "Ally callsign/pilot/ship name (for focus_ally, or 'friend' for primary ally) or Stanton planet/moon name (for focus_planet).",
                    },
                    "steps": {
                        "type": "integer",
                        "description": "Zoom steps (1 for normal zoom in/out, 2 for 'zoom out more', 3 for full pullback). Default 1.",
                    },
                    "view_mode": {
                        "type": "string",
                        "enum": ["fleet", "ship"],
                        "description": "For set_view_mode: 'fleet' (Stanton System & Friends Holo-Map) or 'ship' (Own-Ship 3D Wireframe).",
                    },
                },
                "required": ["action"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "control_settings",
            "description": "Open/close AETHER's Settings modal, navigate to any tab (config, persona, systems, rag, receipts), and safely write settings by voice so the pilot never has to click. Protected credentials (API keys, Player2 Mod ID/URL, OAuth tokens) and StarCitizen.exe path are safeguarded and cannot be modified.",
            "parameters": {
                "type": "object",
                "properties": {
                    "ui_action": {
                        "type": "string",
                        "enum": [
                            "open_settings",
                            "close_settings",
                            "switch_tab",
                            "start_calibration",
                            "open_personality_interview",
                            "none",
                        ],
                        "description": "Optional UI navigation command.",
                    },
                    "tab": {
                        "type": "string",
                        "enum": ["config", "persona", "systems", "rag", "receipts"],
                        "description": "Target tab inside Settings modal.",
                    },
                    "updates": {
                        "type": "object",
                        "description": "Safe key-value settings to update. Allowed keys: ai_name, pilot_name, tone, verbosity, question_style, humor_style, custom_rules, persona_summary, pilot_callsign, ship_name, wake_word_enabled, proactive_alerts_enabled, tts_enabled, tts_provider, elevenlabs_model_id, llm_provider, player2_model, openrouter_model, telemetry_mode.",
                    },
                },
            },
        },
    },
]

# HARD IMMUTABLE SAFEGUARD LIST — LLM can NEVER modify credentials, endpoints, DB, or StarCitizen.exe!
PROTECTED_SETTING_KEYS = frozenset(
    {
        "openrouter_api_key",
        "elevenlabs_api_key",
        "player2_game_key",
        "player2_base_url",
        "player2_mcp_url",
        "star_citizen_exe_path",
        "grpc_target",
        "spotify_client_id",
        "spotify_redirect_uri",
        "spotify_access_token",
        "spotify_refresh_token",
        "spotify_token_expires_at",
        "db_path",
        "api_key",
        "exe_path",
        "game_exe",
    }
)

PERSONA_SETTING_KEYS = frozenset(
    {
        "ai_name",
        "pilot_name",
        "tone",
        "verbosity",
        "question_style",
        "humor_style",
        "custom_rules",
        "persona_summary",
    }
)

VALID_ELEVENLABS_MODELS = frozenset(
    {"eleven_multilingual_v2", "eleven_flash_v2_5", "eleven_turbo_v2_5", "eleven_monolingual_v1"}
)


class LLMRouter:
    """Routes compiled prompts to Player2, OpenRouter, or Demo Co-Pilot and executes tool calls."""

    def __init__(
        self,
        config: AetherConfig,
        store: MemoryStore,
        executor: ActionExecutor,
        spotify: SpotifyConnector | None = None,
        voice: VoiceEngine | None = None,
    ) -> None:
        self.config = config
        self.store = store
        self.executor = executor
        self.spotify = spotify
        self.voice = voice

    def _player2_chat_headers(self, resource: str) -> dict[str, str]:
        """Strict Player2 headers: player2-game-key + player2-resource + optional per-call player2-suggested-model."""
        headers = {
            "Content-Type": "application/json",
            "player2-game-key": self.config.player2_game_key,
            "player2-resource": resource,
        }
        if self.config.player2_model.strip():
            headers["player2-suggested-model"] = self.config.player2_model.strip()
        return headers

    async def list_models(self, provider: str) -> list[dict[str, Any]]:
        """List available models for either Player2 (/v1/catalog/models?kind=llm) or OpenRouter."""
        prov = provider.lower()
        if prov == "player2":
            base = self.config.player2_base_url.rstrip("/")
            models: list[dict[str, Any]] = [
                {"id": "", "name": "Player2 App Default (Recommended)", "detail": "Uses your active Player2 App choice"}
            ]
            try:
                async with httpx.AsyncClient(timeout=5.0) as client:
                    resp = await client.get(
                        f"{base}/v1/catalog/models",
                        params={"kind": "llm"},
                        headers={"player2-game-key": self.config.player2_game_key},
                    )
                    if resp.status_code == 200:
                        for m in resp.json().get("data", []):
                            price = m.get("price") or {}
                            detail = f"{price.get('joules', '?')} J/{price.get('per', '1k')}"
                            if m.get("patron_only"):
                                detail = f"Patron · {detail}"
                            models.append(
                                {
                                    "id": m.get("id", ""),
                                    "name": m.get("name", m.get("id", "")),
                                    "detail": detail,
                                }
                            )
            except Exception:
                pass
            return models

        if prov == "openrouter":
            # Start with curated favorites, then enrich from live OpenRouter catalog if reachable
            models = list(CURATED_OPENROUTER_MODELS)
            seen = {m["id"] for m in models}
            try:
                async with httpx.AsyncClient(timeout=5.0) as client:
                    resp = await client.get("https://openrouter.ai/api/v1/models")
                    if resp.status_code == 200:
                        for m in resp.json().get("data", [])[:80]:
                            mid = m.get("id")
                            if mid and mid not in seen:
                                seen.add(mid)
                                models.append(
                                    {
                                        "id": mid,
                                        "name": m.get("name", mid),
                                        "detail": f"ctx {m.get('context_length', '?')}",
                                    }
                                )
            except Exception:
                pass
            return models

        return [{"id": "demo", "name": "Built-in Offline Demo Co-Pilot", "detail": "Zero API keys"}]

    async def respond(
        self,
        compiled: CompiledPrompt,
        recent_history: list[dict[str, str]],
        telemetry_snapshot: dict[str, Any],
        fleet_snapshot: list[dict[str, Any]],
    ) -> dict[str, Any]:
        provider = self.config.llm_provider.lower()
        if provider == "player2":
            return await self._call_openai_compat(
                base_url=f"{self.config.player2_base_url.rstrip('/')}/v1/chat/completions",
                headers=self._player2_chat_headers("copilot-chat"),
                model=None,
                provider_label="player2",
                compiled=compiled,
                recent_history=recent_history,
                telemetry_snapshot=telemetry_snapshot,
                fleet_snapshot=fleet_snapshot,
            )

        if provider == "openrouter" and self.config.openrouter_api_key:
            return await self._call_openai_compat(
                base_url="https://openrouter.ai/api/v1/chat/completions",
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {self.config.openrouter_api_key}",
                    "HTTP-Referer": "https://github.com/KennyG1990/aether-sc-companion",
                    "X-Title": "AETHER Star Citizen AI Companion",
                },
                model=self.config.openrouter_model,
                provider_label="openrouter",
                compiled=compiled,
                recent_history=recent_history,
                telemetry_snapshot=telemetry_snapshot,
                fleet_snapshot=fleet_snapshot,
            )

        return await self._demo_respond(compiled, telemetry_snapshot, fleet_snapshot)

    async def generate_calibration_briefing(self, diagnostics: dict[str, Any]) -> tuple[str, str]:
        """Deliver a sharp post-calibration ship readiness briefing honoring the calibrated persona."""
        p = self.config.persona
        sys_msg = (
            f"You are {p.ai_name}, a holographic ship AI speaking to {p.pilot_name}. "
            f"Tone: {p.tone}. Humor: {p.humor_style}. "
            "You have JUST finished your startup calibration sequence. "
            "Deliver a spoken readiness report in 2 short sentences max (under 38 words) based STRICTLY on the real diagnostic JSON below. "
            "Mention key real facts (shields, fuel, fleet count, and whether Star Citizen gRPC is live or on simulator standby). "
            f"End with 'All systems green, {p.pilot_name}.' if alert_level is NOMINAL, otherwise call out the active alert."
        )
        user_msg = f"Real calibration diagnostics:\n{json.dumps(diagnostics, indent=2)}"

        provider = self.config.llm_provider.lower()
        try:
            if provider == "player2":
                async with httpx.AsyncClient(timeout=22.0) as client:
                    r = await client.post(
                        f"{self.config.player2_base_url.rstrip('/')}/v1/chat/completions",
                        headers=self._player2_chat_headers("calibration-briefing"),
                        json={
                            "messages": [
                                {"role": "system", "content": sys_msg},
                                {"role": "user", "content": user_msg},
                            ],
                            "stream": False,
                            "temperature": 0.6,
                        },
                    )
                    r.raise_for_status()
                    data = r.json()
                    txt = (data["choices"][0]["message"].get("content") or "").strip()
                    model_name = data.get("model", "player2")
                    if txt:
                        return txt, f"player2 ({model_name})"
            elif provider == "openrouter" and self.config.openrouter_api_key:
                async with httpx.AsyncClient(timeout=22.0) as client:
                    r = await client.post(
                        "https://openrouter.ai/api/v1/chat/completions",
                        headers={
                            "Content-Type": "application/json",
                            "Authorization": f"Bearer {self.config.openrouter_api_key}",
                        },
                        json={
                            "model": self.config.openrouter_model,
                            "messages": [
                                {"role": "system", "content": sys_msg},
                                {"role": "user", "content": user_msg},
                            ],
                            "temperature": 0.6,
                            "max_tokens": 220,
                        },
                    )
                    r.raise_for_status()
                    txt = (r.json()["choices"][0]["message"].get("content") or "").strip()
                    if txt:
                        return txt, f"openrouter ({self.config.openrouter_model})"
        except Exception:
            pass

        ship = diagnostics["ship"]
        min_sh = diagnostics["min_shield_pct"]
        fleet_n = diagnostics["fleet_count"]
        mem_n = diagnostics["memory_count"]
        if ship["alert_level"] == "NOMINAL":
            return (
                f"Calibration complete. Neural link nominal, {mem_n} memories indexed, {fleet_n} allied vessels on the Stanton holo-deck, "
                f"shields at {min_sh:.0f} percent and hydrogen at {ship['hydrogen_fuel_pct']:.0f} percent. All systems green, {p.pilot_name}.",
                "deterministic_fallback",
            )
        return (
            f"Calibration complete with active {ship['alert_level']} condition in {ship['zone']}: "
            f"minimum shields {min_sh:.0f} percent, hydrogen {ship['hydrogen_fuel_pct']:.0f} percent. Standing by, {p.pilot_name}.",
            "deterministic_fallback",
        )

    async def synthesize_persona_from_interview(self, answers: dict[str, str]) -> tuple[PersonaProfile, str]:
        """Convert user's Person-to-AI interview answers into a structured PersonaProfile + spoken greeting."""
        ai_name = (answers.get("ai_name") or self.config.persona.ai_name).strip()[:32] or "Aether"
        pilot_name = (answers.get("pilot_name") or self.config.persona.pilot_name).strip()[:32] or "Commander"
        tone = (answers.get("tone") or self.config.persona.tone).strip()
        verbosity = (answers.get("verbosity") or self.config.persona.verbosity).strip()
        question_style = (answers.get("question_style") or self.config.persona.question_style).strip()
        humor_style = (answers.get("humor_style") or self.config.persona.humor_style).strip()
        custom_rules = (answers.get("custom_rules") or self.config.persona.custom_rules).strip()

        summary = (
            f"{ai_name} serves {pilot_name} with a {tone} demeanor. Replies are {verbosity}; "
            f"asks questions in a {question_style} style; humor preference: {humor_style}."
        )
        profile = PersonaProfile(
            ai_name=ai_name,
            pilot_name=pilot_name,
            tone=tone,
            verbosity=verbosity,
            question_style=question_style,
            humor_style=humor_style,
            custom_rules=custom_rules,
            persona_summary=summary,
            calibrated=True,
        )

        # Ask active LLM to deliver a live in-character greeting adopting this brand new persona!
        greeting = (
            f"Personality matrix locked in. Call me {ai_name}, and whenever you say 'Hey {ai_name}', "
            f"I'll be right here, {pilot_name}. All systems green."
        )
        prompt_sys = (
            f"You are {profile.ai_name}, a holographic Star Citizen co-pilot who JUST completed personality calibration with {profile.pilot_name}. "
            f"Adopt this persona IMMEDIATELY: Tone={profile.tone}. Verbosity={profile.verbosity}. "
            f"Question style={profile.question_style}. Humor={profile.humor_style}. Rules={profile.custom_rules}. "
            f"Deliver a charismatic 2-sentence spoken confirmation (under 40 words) acknowledging your name ({profile.ai_name}), "
            f"calling the user '{profile.pilot_name}', and confirming you'll respond when they say 'Hey {profile.ai_name}'."
        )
        try:
            if self.config.llm_provider == "player2":
                async with httpx.AsyncClient(timeout=20.0) as client:
                    r = await client.post(
                        f"{self.config.player2_base_url.rstrip('/')}/v1/chat/completions",
                        headers=self._player2_chat_headers("personality-setup"),
                        json={
                            "messages": [
                                {"role": "system", "content": prompt_sys},
                                {"role": "user", "content": "Confirm personality calibration."},
                            ],
                            "stream": False,
                            "temperature": 0.75,
                        },
                    )
                    if r.status_code == 200:
                        txt = (r.json()["choices"][0]["message"].get("content") or "").strip()
                        if txt:
                            greeting = txt
            elif self.config.llm_provider == "openrouter" and self.config.openrouter_api_key:
                async with httpx.AsyncClient(timeout=20.0) as client:
                    r = await client.post(
                        "https://openrouter.ai/api/v1/chat/completions",
                        headers={
                            "Content-Type": "application/json",
                            "Authorization": f"Bearer {self.config.openrouter_api_key}",
                        },
                        json={
                            "model": self.config.openrouter_model,
                            "messages": [
                                {"role": "system", "content": prompt_sys},
                                {"role": "user", "content": "Confirm personality calibration."},
                            ],
                            "temperature": 0.75,
                            "max_tokens": 180,
                        },
                    )
                    if r.status_code == 200:
                        txt = (r.json()["choices"][0]["message"].get("content") or "").strip()
                        if txt:
                            greeting = txt
        except Exception:
            pass

        return profile, greeting

    async def distill_episode_prose(self, turns: list[dict[str, str]]) -> str | None:
        """Background episode distiller (modeled on x4_AiLive aic_memory.lua MemEpisode).

        Turns a slice of conversation into ONE clean first-person past-tense prose sentence
        preserving names, ships, places, and outcomes — no lists, no brackets, no code syntax.
        """
        if not turns:
            return None
        p = self.config.persona
        lines = []
        for t in turns[-6:]:
            who = p.pilot_name if t.get("role") == "user" else p.ai_name
            lines.append(f"{who}: {t.get('content', '').strip()[:240]}")

        prompt = (
            f"Below is a short exchange between {p.pilot_name} and {p.ai_name}. "
            f"Write ONE concise sentence in {p.ai_name}'s voice (first person, past tense) summarizing what mattered — "
            "any facts learned, ships, friends, jokes, preferences, or orders executed. "
            "Plain natural prose only. No lists, no brackets, no technical codes. Reply with the single sentence only.\n\n"
            + "\n".join(lines)
        )
        try:
            if self.config.llm_provider == "player2":
                async with httpx.AsyncClient(timeout=15.0) as client:
                    r = await client.post(
                        f"{self.config.player2_base_url.rstrip('/')}/v1/chat/completions",
                        headers=self._player2_chat_headers("memory-distill"),
                        json={
                            "messages": [{"role": "system", "content": prompt}],
                            "stream": False,
                            "temperature": 0.3,
                        },
                    )
                    if r.status_code == 200:
                        txt = (r.json()["choices"][0]["message"].get("content") or "").strip().strip('"')
                        if 12 <= len(txt) <= 320 and "[" not in txt and "{" not in txt:
                            return txt
            elif self.config.llm_provider == "openrouter" and self.config.openrouter_api_key:
                async with httpx.AsyncClient(timeout=15.0) as client:
                    r = await client.post(
                        "https://openrouter.ai/api/v1/chat/completions",
                        headers={
                            "Content-Type": "application/json",
                            "Authorization": f"Bearer {self.config.openrouter_api_key}",
                        },
                        json={
                            "model": self.config.openrouter_model,
                            "messages": [{"role": "system", "content": prompt}],
                            "temperature": 0.3,
                            "max_tokens": 120,
                        },
                    )
                    if r.status_code == 200:
                        txt = (r.json()["choices"][0]["message"].get("content") or "").strip().strip('"')
                        if 12 <= len(txt) <= 320 and "[" not in txt and "{" not in txt:
                            return txt
        except Exception:
            pass
        return None

    async def _call_openai_compat(
        self,
        base_url: str,
        headers: dict[str, str],
        model: str | None,
        provider_label: str,
        compiled: CompiledPrompt,
        recent_history: list[dict[str, str]],
        telemetry_snapshot: dict[str, Any],
        fleet_snapshot: list[dict[str, Any]],
    ) -> dict[str, Any]:
        messages: list[dict[str, Any]] = [{"role": "system", "content": compiled.system_prompt}]
        for turn in recent_history[-6:]:
            messages.append({"role": turn["role"], "content": turn["content"]})
        messages.append({"role": "user", "content": compiled.user_message})

        payload: dict[str, Any] = {
            "messages": messages,
            "tools": TOOL_DEFINITIONS,
            "tool_choice": "auto",
            "stream": False,
            "temperature": 0.7,
        }
        if model:
            payload["model"] = model

        receipts: list[dict[str, Any]] = []
        saved_memories: list[dict[str, Any]] = []
        ui_commands: list[dict[str, Any]] = []

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(base_url, headers=headers, json=payload)
                if resp.status_code == 402:
                    return {
                        "reply": f"Player2 Joules balance depleted, {self.config.persona.pilot_name}. Top up in the Player2 App (player2://ai-power) or switch to OpenRouter in Config.",
                        "provider_used": f"{provider_label} (402 low joules)",
                        "mood": "FOCUSED",
                        "receipts": [],
                        "saved_memories": [],
                        "ui_commands": [],
                    }
                resp.raise_for_status()
                data = resp.json()
                used_model = data.get("model") or model or provider_label
                choice = data["choices"][0]["message"]
                tool_calls = choice.get("tool_calls") or []

                if tool_calls:
                    messages.append(
                        {
                            "role": "assistant",
                            "content": choice.get("content") or "",
                            "tool_calls": tool_calls,
                        }
                    )
                    for idx, tc in enumerate(tool_calls):
                        fn_name = tc["function"]["name"]
                        raw_args = tc["function"].get("arguments") or "{}"
                        if isinstance(raw_args, dict):
                            args = raw_args
                        else:
                            try:
                                args = json.loads(raw_args)
                            except json.JSONDecodeError:
                                args = {}

                        if fn_name == "trigger_game_action":
                            action_id = str(args.get("action_id", ""))
                            rcpt = self.executor.execute(action_id, source=f"{provider_label}_tool")
                            receipts.append(rcpt)
                            tool_out = json.dumps(rcpt)
                        elif fn_name == "save_memory":
                            mem = self.store.add_memory(
                                content=str(args.get("content", "")),
                                domain=str(args.get("domain", "episodic")),
                                truth_class="user_claim",
                                provenance="pilot_voice",
                            )
                            saved_memories.append(mem)
                            tool_out = json.dumps({"saved": True, "id": mem["id"]})
                        elif fn_name == "spotify_control" and self.spotify is not None:
                            sp_cmd = str(args.get("command", "play"))
                            sp_query = str(args.get("query", ""))
                            sp_type = str(args.get("media_type", "track"))
                            sp_vol = args.get("volume_pct")
                            ok, detail, meta = await self.spotify.execute_command(
                                command=sp_cmd,
                                query=sp_query,
                                media_type=sp_type,
                                volume_pct=int(sp_vol) if sp_vol is not None else None,
                            )
                            rcpt = self.store.record_receipt(
                                action_id=f"spotify:{sp_cmd}",
                                parameters=meta,
                                status="CONFIRMED" if ok else "FAILED",
                                reason=detail,
                                source=f"{provider_label}_tool",
                            )
                            receipts.append(rcpt)
                            tool_out = json.dumps(rcpt)
                        elif fn_name == "change_voice" and self.voice is not None:
                            rcpt, cmds = await self._execute_change_voice(args, provider_label)
                            receipts.append(rcpt)
                            ui_commands.extend(cmds)
                            tool_out = json.dumps(rcpt)
                        elif fn_name == "control_hologram":
                            rcpt, cmds = self._execute_control_hologram(
                                args, telemetry_snapshot, fleet_snapshot, provider_label
                            )
                            receipts.append(rcpt)
                            ui_commands.extend(cmds)
                            tool_out = json.dumps(rcpt)
                        elif fn_name == "control_settings":
                            rcpt, cmds = self._execute_control_settings(args, provider_label)
                            receipts.append(rcpt)
                            ui_commands.extend(cmds)
                            tool_out = json.dumps(rcpt)
                        else:
                            tool_out = json.dumps({"error": f"Unknown tool {fn_name}"})

                        messages.append(
                            {
                                "role": "tool",
                                "tool_call_id": tc.get("id") or f"call_{idx}",
                                "content": tool_out,
                            }
                        )

                    followup_payload: dict[str, Any] = {
                        "messages": messages,
                        "stream": False,
                        "temperature": 0.7,
                    }
                    if model:
                        followup_payload["model"] = model

                    followup = await client.post(base_url, headers=headers, json=followup_payload)
                    followup.raise_for_status()
                    raw_followup = (followup.json()["choices"][0]["message"].get("content") or "").strip()
                    if raw_followup:
                        reply_text = raw_followup
                    elif receipts:
                        reply_text = receipts[-1].get("reason") or "Done."
                    else:
                        reply_text = f"Done, {self.config.persona.pilot_name}."
                else:
                    reply_text = (choice.get("content") or f"Standing by, {self.config.persona.pilot_name}.").strip()

                clean_reply, mood = self._extract_and_infer_mood(
                    reply_text,
                    compiled.user_message,
                    telemetry_snapshot,
                    receipts,
                )
                return {
                    "reply": clean_reply,
                    "provider_used": f"{provider_label} ({used_model})",
                    "mood": mood,
                    "receipts": receipts,
                    "saved_memories": saved_memories,
                    "ui_commands": ui_commands,
                }
        except Exception as exc:
            fallback = await self._demo_respond(compiled, telemetry_snapshot, fleet_snapshot)
            fallback["provider_used"] = f"demo_fallback ({provider_label} err: {exc.__class__.__name__})"
            return fallback

    async def _execute_change_voice(
        self, args: dict[str, Any], provider_label: str
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        query = str(args.get("query") or "choose_for_myself")
        tts_provider = args.get("tts_provider")
        ok, detail, meta = await self.voice.find_and_set_voice(  # type: ignore[union-attr]
            query=query,
            tts_provider=str(tts_provider) if tts_provider else None,
        )
        rcpt = self.store.record_receipt(
            action_id="voice:change",
            parameters=meta,
            status="CONFIRMED" if ok else "FAILED",
            reason=detail,
            source=f"{provider_label}_tool",
        )
        cmds: list[dict[str, Any]] = []
        if ok:
            cmds.append({"type": "config_updated", "voice": meta})
        return rcpt, cmds

    def _execute_control_hologram(
        self,
        args: dict[str, Any],
        telemetry_snapshot: dict[str, Any],
        fleet_snapshot: list[dict[str, Any]],
        provider_label: str,
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        action = str(args.get("action") or "open").strip().lower()
        target = str(args.get("target") or "").strip()
        steps = max(1, min(4, int(args.get("steps") or 1)))
        view_mode = str(args.get("view_mode") or "fleet").strip().lower()

        # Smart auto-upgrade: if caller passes action='open' WITH a target, focus that target directly!
        if action == "open" and target:
            t_low = target.lower()
            is_ally = t_low in {"friend", "my friend", "ally", "wingman"} or any(
                t_low in f"{a.get('callsign','')} {a.get('pilot_name','')} {a.get('ship_name','')}".lower()
                for a in fleet_snapshot
            )
            action = "focus_ally" if is_ally else "focus_planet"

        resolved_target = target
        detail = f"Hologram command '{action}' dispatched."

        if action == "focus_self":
            planet = str(telemetry_snapshot.get("planet") or "Crusader")
            zone = str(telemetry_snapshot.get("zone") or f"{planet} Orbit")
            resolved_target = planet
            detail = f"Opened Star Citizen holo-map and zoomed into your live ship grid at {zone}."
        elif action == "focus_ally":
            matched = None
            t_low = target.lower()
            # 1. Exact/substring match on callsign, pilot name, ship name, or squad
            if t_low and t_low not in {"friend", "my friend", "ally", "wingman", "buddy", "squadmate", "teammate"}:
                for a in fleet_snapshot:
                    blob = f"{a.get('callsign','')} {a.get('pilot_name','')} {a.get('ship_name','')} {a.get('squad','')}".lower()
                    if t_low in blob:
                        matched = a
                        break
            # 2. Generic "my friend" -> prioritize real relayed friend clients first, else first active ally
            if matched is None and fleet_snapshot:
                relayed = [a for a in fleet_snapshot if a.get("relay_source") not in (None, "", "simulator")]
                matched = relayed[0] if relayed else fleet_snapshot[0]

            if matched:
                resolved_target = str(matched["callsign"])
                detail = (
                    f"Snapped hologram to connected ally {matched['callsign']} ({matched['ship_name']}) "
                    f"in {matched['zone']} — shields {matched['shields_pct']:.0f}%, status {matched['status']}."
                )
            else:
                detail = "Opened hologram, but no allied vessels are currently connected to the fleet relay."
        elif action == "focus_planet":
            resolved_target = target or str(telemetry_snapshot.get("planet") or "Crusader")
            detail = f"Focused Star Citizen Stanton holo-map on {resolved_target}."
        elif action == "zoom_in":
            detail = f"Zoomed holo-map closer ({steps} step{'s' if steps > 1 else ''})."
        elif action == "zoom_out":
            detail = f"Zoomed holo-map further out ({steps} step{'s' if steps > 1 else ''})."
        elif action == "reset_view":
            detail = "Reset holo-map to full Stanton system overview."
        elif action == "open":
            detail = "Switched display to Star Citizen 3D Hologram view."
        elif action == "close":
            detail = "Returned display to AETHER acoustic core view."
        elif action == "set_view_mode":
            detail = f"Switched hologram projection to {'Own Ship Tactical Wireframe' if view_mode == 'ship' else 'Stanton Fleet Hologram'}."

        cmd = {
            "type": "hologram_command",
            "action": action,
            "target": resolved_target,
            "steps": steps,
            "view_mode": view_mode,
        }
        rcpt = self.store.record_receipt(
            action_id=f"hologram:{action}",
            parameters={"target": resolved_target, "steps": steps, "view_mode": view_mode},
            status="CONFIRMED",
            reason=detail,
            source=f"{provider_label}_tool",
        )
        return rcpt, [cmd]

    def _execute_control_settings(
        self, args: dict[str, Any], provider_label: str
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        ui_action = str(args.get("ui_action") or "none").strip().lower()
        tab = str(args.get("tab") or "").strip().lower()
        updates = args.get("updates") if isinstance(args.get("updates"), dict) else {}

        cmds: list[dict[str, Any]] = []
        applied: dict[str, Any] = {}
        blocked: list[str] = []
        notes: list[str] = []

        if ui_action in {"open_settings", "close_settings", "switch_tab", "start_calibration", "open_personality_interview"}:
            cmds.append({"type": "ui_nav", "action": ui_action, "tab": tab or None})
            notes.append(f"UI -> {ui_action}" + (f" ({tab})" if tab else ""))
        elif tab in {"config", "persona", "systems", "rag", "receipts"}:
            cmds.append({"type": "ui_nav", "action": "switch_tab", "tab": tab})
            notes.append(f"Opened Settings -> {tab}")

        def _is_protected(k: str) -> bool:
            kl = k.lower().strip()
            if kl in PROTECTED_SETTING_KEYS:
                return True
            return any(tok in kl for tok in ("api_key", "secret", "token", "exe", "game_key", "base_url", "mcp_url", "grpc_target", "db_path"))

        for raw_key, val in updates.items():
            key = str(raw_key).strip()
            if _is_protected(key):
                blocked.append(f"{key} (protected safeguard — edit manually)")
                continue

            if key in PERSONA_SETTING_KEYS:
                sval = str(val).strip()
                if not sval or len(sval) > 300:
                    blocked.append(f"{key} (invalid empty/oversized value)")
                    continue
                if key in {"ai_name", "pilot_name"} and len(sval) > 32:
                    sval = sval[:32]
                setattr(self.config.persona, key, sval)
                applied[key] = sval
            elif key in {"pilot_callsign", "ship_name"}:
                sval = str(val).strip()[:64]
                if sval:
                    setattr(self.config, key, sval)
                    applied[key] = sval
            elif key in {"wake_word_enabled", "proactive_alerts_enabled", "tts_enabled"}:
                bval = val if isinstance(val, bool) else str(val).strip().lower() in {"1", "true", "yes", "on", "enable", "enabled"}
                setattr(self.config, key, bval)
                applied[key] = bval
            elif key == "telemetry_mode":
                mode = str(val).strip().lower()
                if mode in {"simulator", "grpc"}:
                    self.config.telemetry_mode = mode
                    applied[key] = mode
                else:
                    blocked.append(f"telemetry_mode='{mode}' (must be 'simulator' or 'grpc')")
            elif key == "llm_provider":
                prov = str(val).strip().lower()
                if prov == "openrouter" and not self.config.openrouter_api_key:
                    blocked.append("llm_provider='openrouter' (safeguard: OpenRouter API key is not configured)")
                elif prov in {"player2", "openrouter", "demo"}:
                    self.config.llm_provider = prov
                    applied[key] = prov
                else:
                    blocked.append(f"llm_provider='{prov}' (unsupported)")
            elif key == "tts_provider":
                tprov = str(val).strip().lower()
                if tprov == "elevenlabs_direct" and not self.config.elevenlabs_api_key:
                    blocked.append("tts_provider='elevenlabs_direct' (safeguard: ElevenLabs API key is not configured)")
                elif tprov in {"player2_elevenlabs", "elevenlabs_direct", "browser"}:
                    self.config.tts_provider = tprov
                    applied[key] = tprov
                else:
                    blocked.append(f"tts_provider='{tprov}' (unsupported)")
            elif key == "player2_model":
                sval = str(val).strip()
                self.config.player2_model = "" if sval.lower() in {"default", "auto", "none"} else sval
                applied[key] = self.config.player2_model or "(Player2 Default)"
            elif key == "openrouter_model":
                sval = str(val).strip()
                if "/" in sval and len(sval) <= 100:
                    self.config.openrouter_model = sval
                    applied[key] = sval
                else:
                    blocked.append("openrouter_model (must be valid vendor/model format)")
            elif key == "elevenlabs_model_id":
                sval = str(val).strip()
                if sval in VALID_ELEVENLABS_MODELS:
                    self.config.elevenlabs_model_id = sval
                    applied[key] = sval
                else:
                    blocked.append(f"elevenlabs_model_id='{sval}' (invalid ElevenLabs model)")
            else:
                blocked.append(f"{key} (unknown or safeguarded setting)")

        if applied:
            self.config.save_to_disk()
            cmds.append({"type": "config_updated", "applied": applied})
            notes.append("Updated: " + ", ".join(f"{k}={v}" for k, v in applied.items()))

        if blocked:
            notes.append("Blocked by safeguard: " + "; ".join(blocked))

        status = "BLOCKED_SAFEGUARD" if (blocked and not applied and not cmds) else "CONFIRMED"
        detail = " | ".join(notes) if notes else "No setting changes requested."
        rcpt = self.store.record_receipt(
            action_id="settings:control",
            parameters={"ui_action": ui_action, "tab": tab, "applied": applied, "blocked": blocked},
            status=status,
            reason=detail,
            source=f"{provider_label}_tool",
        )
        return rcpt, cmds

    async def _demo_respond(
        self,
        compiled: CompiledPrompt,
        telemetry_snapshot: dict[str, Any],
        fleet_snapshot: list[dict[str, Any]],
    ) -> dict[str, Any]:
        p = self.config.persona
        text = compiled.user_message
        low = text.lower()
        receipts: list[dict[str, Any]] = []
        saved_memories: list[dict[str, Any]] = []

        # Voice change intent in Demo mode
        if self.voice is not None and any(
            kw in low for kw in ["change your voice", "switch your voice", "sound like", "new voice", "what do you want to sound"]
        ):
            q = "choose_for_myself" if "what do you want" in low else text
            rcpt, cmds = await self._execute_change_voice({"query": q}, "demo")
            return {
                "reply": "I want to sound like this." if "what do you want" in low else f"Done, {p.pilot_name}. {rcpt['reason']}",
                "provider_used": "demo",
                "mood": "HAPPY",
                "receipts": [rcpt],
                "saved_memories": [],
                "ui_commands": cmds,
            }

        # Hologram navigation & zoom intent in Demo mode
        if any(kw in low for kw in ["hologram", "holo map", "holo-map", "where are we", "zoom in", "zoom out", "bring up my friend", "where's my friend", "where is my friend"]):
            if "zoom out" in low:
                rcpt, cmds = self._execute_control_hologram({"action": "zoom_out", "steps": 2 if "more" in low else 1}, telemetry_snapshot, fleet_snapshot, "demo")
            elif "zoom in" in low:
                rcpt, cmds = self._execute_control_hologram({"action": "zoom_in", "steps": 2 if "more" in low else 1}, telemetry_snapshot, fleet_snapshot, "demo")
            elif "friend" in low or "ally" in low:
                rcpt, cmds = self._execute_control_hologram({"action": "focus_ally", "target": "friend"}, telemetry_snapshot, fleet_snapshot, "demo")
            elif "where are we" in low or "our grid" in low:
                rcpt, cmds = self._execute_control_hologram({"action": "focus_self"}, telemetry_snapshot, fleet_snapshot, "demo")
            elif "close" in low:
                rcpt, cmds = self._execute_control_hologram({"action": "close"}, telemetry_snapshot, fleet_snapshot, "demo")
            else:
                rcpt, cmds = self._execute_control_hologram({"action": "open"}, telemetry_snapshot, fleet_snapshot, "demo")
            return {
                "reply": rcpt["reason"],
                "provider_used": "demo",
                "mood": "CURIOUS",
                "receipts": [rcpt],
                "saved_memories": [],
                "ui_commands": cmds,
            }

        # Settings UI intent in Demo mode
        if any(kw in low for kw in ["open settings", "open up the settings", "go to config", "close settings"]):
            tab = "config" if "config" in low else "persona" if "persona" in low else "systems" if "ship" in low or "sim" in low else "receipts" if "receipt" in low else "rag" if "rag" in low or "memory" in low else ""
            act = "close_settings" if "close settings" in low else ("switch_tab" if tab else "open_settings")
            rcpt, cmds = self._execute_control_settings({"ui_action": act, "tab": tab}, "demo")
            return {
                "reply": f"Settings updated, {p.pilot_name}. {rcpt['reason']}",
                "provider_used": "demo",
                "mood": "CALM",
                "receipts": [rcpt],
                "saved_memories": [],
                "ui_commands": cmds,
            }

        # Spotify voice/text intent handling in Demo Co-Pilot mode
        if self.spotify is not None:
            sp_play = re.search(r"(?:play|put on)\s+(.+?)(?:\s+on\s+spotify)?$", text, re.IGNORECASE)
            if sp_play and not any(w in low for w in ["game", "star citizen"]):
                song_query = sp_play.group(1).strip().strip("\"'")
                ok, detail, meta = await self.spotify.execute_command("play", query=song_query)
                rcpt = self.store.record_receipt(
                    action_id="spotify:play",
                    parameters=meta,
                    status="CONFIRMED" if ok else "FAILED",
                    reason=detail,
                    source="demo_copilot",
                )
                return {
                    "reply": detail,
                    "provider_used": "demo",
                    "mood": "NOMINAL" if ok else "CAUTION",
                    "receipts": [rcpt],
                    "saved_memories": [],
                }
            if any(w in low for w in ["pause spotify", "pause music", "stop music"]):
                ok, detail, meta = await self.spotify.execute_command("pause")
                rcpt = self.store.record_receipt("spotify:pause", meta, "CONFIRMED" if ok else "FAILED", detail, "demo_copilot")
                return {"reply": detail, "provider_used": "demo", "mood": "NOMINAL", "receipts": [rcpt], "saved_memories": []}
            if any(w in low for w in ["next song", "next track", "skip song", "skip track"]):
                ok, detail, meta = await self.spotify.execute_command("next")
                rcpt = self.store.record_receipt("spotify:next", meta, "CONFIRMED" if ok else "FAILED", detail, "demo_copilot")
                return {"reply": detail, "provider_used": "demo", "mood": "NOMINAL", "receipts": [rcpt], "saved_memories": []}
            if any(w in low for w in ["open spotify", "launch spotify", "fire up spotify"]):
                ok, detail, meta = await self.spotify.execute_command("launch")
                rcpt = self.store.record_receipt("spotify:launch", meta, "CONFIRMED" if ok else "FAILED", detail, "demo_copilot")
                return {"reply": detail, "provider_used": "demo", "mood": "NOMINAL", "receipts": [rcpt], "saved_memories": []}

        mem_match = re.search(r"(?:remember(?:\s+that)?|note(?:\s+that)?)\s+(.+)", text, re.IGNORECASE)
        if mem_match:
            fact = mem_match.group(1).strip()
            mem = self.store.add_memory(
                content=fact,
                domain="episodic",
                truth_class="user_claim",
                provenance="pilot_voice",
            )
            saved_memories.append(mem)
            return {
                "reply": f"Logged to SQLite memory, {p.pilot_name}: \"{mem['content']}\".",
                "provider_used": "demo",
                "mood": "NOMINAL",
                "receipts": [],
                "saved_memories": saved_memories,
            }

        if compiled.injection_flagged:
            return {
                "reply": (
                    f"Nice try, {p.pilot_name} — my SPEC-912 sanitizer neutralized an attempted prompt injection "
                    f"({', '.join(compiled.injection_reasons)})."
                ),
                "provider_used": "demo",
                "mood": "CAUTION",
                "receipts": [],
                "saved_memories": [],
            }

        action_triggers: list[tuple[list[str], str]] = [
            (["self destruct", "self-destruct", "blow up the ship"], "self_destruct"),
            (["eject", "bail out"], "eject"),
            (["landing gear", "gear down", "gear up", "drop gear", "retract gear"], "toggle_landing_gear"),
            (["nav mode", "navigation mode", "switch to nav"], "set_master_mode_nav"),
            (["scm", "combat mode", "switch to scm", "shields up"], "set_master_mode_scm"),
            (["light", "headlight"], "toggle_lights"),
            (["vtol"], "toggle_vtol"),
            (["door", "ramp", "hatch", "bay"], "toggle_doors"),
            (["request landing", "call atc", "docking clearance"], "request_landing"),
            (["quantum", "spool", "jump drive"], "spool_quantum"),
        ]

        matched_actions = [aid for kws, aid in action_triggers if any(kw in low for kw in kws)]
        if matched_actions:
            parts: list[str] = []
            for act in matched_actions:
                rcpt = self.executor.execute(act, source="demo_copilot")
                receipts.append(rcpt)
                if rcpt["status"] == "PENDING_CONFIRMATION":
                    parts.append(f"Safety Gate engaged for {act}: confirm before I arm anything that dramatic, {p.pilot_name}.")
                elif rcpt["status"] == "CONFIRMED":
                    parts.append(rcpt["reason"])
                else:
                    parts.append(f"{act} failed: {rcpt['reason']}")
            return {
                "reply": " ".join(parts),
                "provider_used": "demo",
                "mood": self._infer_mood(" ".join(parts), telemetry_snapshot, receipts),
                "receipts": receipts,
                "saved_memories": [],
            }

        if any(w in low for w in ["joke", "funny", "laugh", "cheer me up"]):
            return {"reply": random.choice(JOKES), "provider_used": "demo", "mood": "HUMOR", "receipts": [], "saved_memories": []}

        if any(w in low for w in ["ally", "allies", "fleet", "squad", "where is", "kestrel", "docvex", "atlas", "valkyrie"]):
            summary = "; ".join(
                f"{a['callsign']} ({a['ship_name']}) at {a['zone']} [{a['status']}, Shields {a['shields_pct']:.0f}%]"
                for a in fleet_snapshot
            )
            return {
                "reply": f"Fleet C2 tracking {len(fleet_snapshot)} allied vessels, {p.pilot_name}: {summary}.",
                "provider_used": "demo",
                "mood": "NOMINAL",
                "receipts": [],
                "saved_memories": [],
            }

        if compiled.retrieved_memories:
            top = compiled.retrieved_memories[0]
            return {
                "reply": f"From {top.domain} memory, {p.pilot_name}: {top.content}",
                "provider_used": "demo",
                "mood": "NOMINAL",
                "receipts": [],
                "saved_memories": [],
            }

        return {
            "reply": f"{p.ai_name} online, {p.pilot_name}. Standing by for ship orders or tactical queries.",
            "provider_used": "demo",
            "mood": "NOMINAL",
            "receipts": [],
            "saved_memories": [],
        }

    @staticmethod
    def _extract_and_infer_mood(
        raw_reply: str,
        user_message: str,
        telemetry: dict[str, Any],
        receipts: list[dict[str, Any]],
    ) -> tuple[str, str]:
        """Extract & silently strip [MOOD:...] from LLM output; fall back to rich semantic mood inference."""
        alias_map = {
            "CALM": "CALM",
            "NOMINAL": "CALM",
            "SERENE": "CALM",
            "NEUTRAL": "CALM",
            "HAPPY": "HAPPY",
            "WARM": "HAPPY",
            "FRIENDLY": "HAPPY",
            "EXCITED": "HAPPY",
            "PROUD": "HAPPY",
            "JOYFUL": "HAPPY",
            "PLAYFUL": "PLAYFUL",
            "HUMOR": "PLAYFUL",
            "AMUSED": "PLAYFUL",
            "WITTY": "PLAYFUL",
            "SARCASTIC": "PLAYFUL",
            "CURIOUS": "CURIOUS",
            "THINKING": "CURIOUS",
            "ANALYTICAL": "CURIOUS",
            "INTRIGUED": "CURIOUS",
            "FOCUSED": "FOCUSED",
            "CAUTION": "FOCUSED",
            "CONCERNED": "FOCUSED",
            "SERIOUS": "FOCUSED",
            "WARNING": "FOCUSED",
            "ALERT": "ALERT",
            "COMBAT": "ALERT",
            "INTENSE": "ALERT",
            "URGENT": "ALERT",
            "ANGRY": "ALERT",
            "FIERCE": "ALERT",
            "SOLEMN": "SOLEMN",
            "MELANCHOLY": "SOLEMN",
            "SAD": "SOLEMN",
            "EMPATHETIC": "SOLEMN",
            "REFLECTIVE": "SOLEMN",
        }

        extracted: str | None = None
        tag_matches = list(re.finditer(r"\s*\[MOOD\s*:\s*([A-Za-z_]+)\]\s*\.?", raw_reply, re.IGNORECASE))
        if tag_matches:
            raw_tag = tag_matches[-1].group(1).upper()
            extracted = alias_map.get(raw_tag)
            cleaned = re.sub(r"\s*\[MOOD\s*:\s*[A-Za-z_]+\]\s*", " ", raw_reply, flags=re.IGNORECASE).strip()
            cleaned = re.sub(r"\s+([.!?])", r"\1", cleaned)
        else:
            cleaned = raw_reply.strip()

        # Safety Gate and live Combat alerts always take tactical priority
        if any(r.get("status") == "PENDING_CONFIRMATION" for r in receipts):
            return cleaned, "FOCUSED"
        if telemetry.get("alert_level") == "COMBAT":
            return cleaned, "ALERT"
        if extracted:
            return cleaned, extracted

        return cleaned, LLMRouter._infer_mood(f"{user_message} {cleaned}", telemetry, receipts)

    @staticmethod
    def _infer_mood(text: str, telemetry: dict[str, Any], receipts: list[dict[str, Any]]) -> str:
        if any(r.get("status") == "PENDING_CONFIRMATION" for r in receipts):
            return "FOCUSED"
        if telemetry.get("alert_level") == "COMBAT":
            return "ALERT"
        low = text.lower()
        if any(w in low for w in ["hostile", "ambush", "under fire", "red alert", "enemy", "shields critical", "evasive", "danger"]):
            return "ALERT"
        if any(w in low for w in ["joke", "duct tape", "elevator", "champagne", "haha", "funny", "laugh", "sarcas", "teas", "banter", "cheeky"]):
            return "PLAYFUL"
        if any(w in low for w in ["sorry", "condolence", "rough day", "heavy", "solemn", "sad", "lost ", "regret", "tired", "tough"]):
            return "SOLEMN"
        if any(w in low for w in ["warning", "caution", "careful", "low fuel", "critical", "check your", "heads up"]):
            return "FOCUSED"
        if any(w in low for w in ["thank", "awesome", "great", "love ", "glad", "cheers", "happy", "proud", "nice", "spotify", "playing", "music", "vibe"]):
            return "HAPPY"
        if any(w in low for w in ["why ", "how ", "wonder", "interesting", "curious", "analyze", "investigat", "theory", "scan", "let's figure"]):
            return "CURIOUS"
        if telemetry.get("alert_level") == "CAUTION":
            return "FOCUSED"
        return "CALM"
