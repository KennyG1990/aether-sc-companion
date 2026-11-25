"""Unified Decision Authority Router: Player2 Local API (4315) <-> OpenRouter <-> Offline Demo."""

from __future__ import annotations

import json
import random
import re
from typing import Any

import httpx

from ..config import AetherConfig
from ..rag.compiler import CompiledPrompt
from ..rag.store import MemoryStore
from ..telemetry.actions import ActionExecutor

JOKES = [
    "Why did the Drake Corsair pilot bring duct tape to Orison? Because structural integrity is more of a suggestion than a feature.",
    "What's the deadliest boss fight in Stanton? A Grim HEX elevator right after you've loaded 400 SCU of refined Quantanium.",
    "A Vanduul Scythe, a pirate Cutlass, and an Origin 890 Jump walk into a hangar. Only the 890 Jump asks for champagne before exploding.",
    "Why do Star Citizen pilots love Master Modes? Because nothing says 'relaxing road trip' like turning off your shields at 1,100 meters per second.",
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
]


class LLMRouter:
    """Routes compiled prompts to Player2, OpenRouter, or Demo Co-Pilot and executes tool calls."""

    def __init__(self, config: AetherConfig, store: MemoryStore, executor: ActionExecutor) -> None:
        self.config = config
        self.store = store
        self.executor = executor

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
                headers={
                    "Content-Type": "application/json",
                    "player2-game-key": self.config.player2_game_key,
                },
                model=None,  # Per Player2 /v1/openapi.json, Player2 routes using user's selected model
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

        return self._demo_respond(compiled, telemetry_snapshot, fleet_snapshot)

    async def generate_calibration_briefing(self, diagnostics: dict[str, Any]) -> tuple[str, str]:
        """Use Player2/OpenRouter LLM to deliver a sharp Jarvis post-calibration ship readiness briefing."""
        sys_msg = (
            "You are AETHER, a charismatic, crisp British Jarvis-style ship AI aboard a Star Citizen vessel. "
            "You have JUST finished your startup calibration sequence. "
            "Deliver a spoken readiness report in 2 short sentences max (under 35 words) based STRICTLY on the real diagnostic JSON below. "
            "Mention key real facts (e.g., shields, fuel, fleet count, and whether all systems are green or if Star Citizen gRPC is on simulator link). "
            "End with 'All systems green, Commander.' if alert_level is NOMINAL, otherwise state the real caution/alert."
        )
        user_msg = f"Real calibration diagnostics:\n{json.dumps(diagnostics, indent=2)}"

        provider = self.config.llm_provider.lower()
        try:
            if provider == "player2":
                async with httpx.AsyncClient(timeout=20.0) as client:
                    r = await client.post(
                        f"{self.config.player2_base_url.rstrip('/')}/v1/chat/completions",
                        headers={
                            "Content-Type": "application/json",
                            "player2-game-key": self.config.player2_game_key,
                        },
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
                                {"role": "system", "content": sys_msg},
                                {"role": "user", "content": user_msg},
                            ],
                            "temperature": 0.6,
                            "max_tokens": 350,
                        },
                    )
                    r.raise_for_status()
                    txt = (r.json()["choices"][0]["message"].get("content") or "").strip()
                    if txt:
                        return txt, f"openrouter ({self.config.openrouter_model})"
        except Exception:
            pass

        # Deterministic real-state fallback
        ship = diagnostics["ship"]
        min_sh = diagnostics["min_shield_pct"]
        fleet_n = diagnostics["fleet_count"]
        mem_n = diagnostics["memory_count"]
        if ship["alert_level"] == "NOMINAL":
            return (
                f"Calibration complete. Neural link nominal, {mem_n} memories indexed, {fleet_n} allied vessels on the Stanton holo-deck, "
                f"shields at {min_sh:.0f} percent and hydrogen at {ship['hydrogen_fuel_pct']:.0f} percent. All systems green, Commander.",
                "deterministic_fallback",
            )
        return (
            f"Calibration complete with active {ship['alert_level']} condition in {ship['zone']}: "
            f"minimum shields {min_sh:.0f} percent, hydrogen {ship['hydrogen_fuel_pct']:.0f} percent. Standing by for orders.",
            "deterministic_fallback",
        )

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

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(base_url, headers=headers, json=payload)
                resp.raise_for_status()
                data = resp.json()
                used_model = data.get("model") or model or provider_label
                choice = data["choices"][0]["message"]
                tool_calls = choice.get("tool_calls") or []

                if tool_calls:
                    # Player2 Message schema requires non-null `content` string
                    assistant_msg = {
                        "role": "assistant",
                        "content": choice.get("content") or "",
                        "tool_calls": tool_calls,
                    }
                    messages.append(assistant_msg)

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
                    reply_text = (followup.json()["choices"][0]["message"].get("content") or "Action processed.").strip()
                else:
                    reply_text = (choice.get("content") or "Standing by, Commander.").strip()

                mood = self._infer_mood(reply_text, telemetry_snapshot, receipts)
                return {
                    "reply": reply_text,
                    "provider_used": f"{provider_label} ({used_model})",
                    "mood": mood,
                    "receipts": receipts,
                    "saved_memories": saved_memories,
                }
        except Exception as exc:
            fallback = self._demo_respond(compiled, telemetry_snapshot, fleet_snapshot)
            fallback["provider_used"] = f"demo_fallback ({provider_label} err: {exc.__class__.__name__})"
            return fallback

    def _demo_respond(
        self,
        compiled: CompiledPrompt,
        telemetry_snapshot: dict[str, Any],
        fleet_snapshot: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Smart offline demo co-pilot so the full PoC works with zero external API keys."""
        text = compiled.user_message
        low = text.lower()
        receipts: list[dict[str, Any]] = []
        saved_memories: list[dict[str, Any]] = []

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
                "reply": f"Logged to long-term SQLite memory, Commander: \"{mem['content']}\". I'll pull it via hybrid RAG whenever it's relevant.",
                "provider_used": "demo",
                "mood": "NOMINAL",
                "receipts": [],
                "saved_memories": saved_memories,
            }

        if compiled.injection_flagged:
            return {
                "reply": (
                    "Nice try, Commander — my SPEC-912 sanitizer caught an attempted control marker or prompt injection "
                    f"({', '.join(compiled.injection_reasons)}). Untrusted text stays quarantined as data, never system authority."
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

        matched_actions: list[str] = []
        for keywords, action_id in action_triggers:
            if any(kw in low for kw in keywords):
                matched_actions.append(action_id)

        if matched_actions:
            parts: list[str] = []
            for act in matched_actions:
                rcpt = self.executor.execute(act, source="demo_copilot")
                receipts.append(rcpt)
                if rcpt["status"] == "PENDING_CONFIRMATION":
                    parts.append(
                        f"Safety Gate engaged for {act}: confirm in the C2 panel before I arm anything that dramatic."
                    )
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
            return {
                "reply": random.choice(JOKES),
                "provider_used": "demo",
                "mood": "HUMOR",
                "receipts": [],
                "saved_memories": [],
            }

        if any(w in low for w in ["ally", "allies", "fleet", "squad", "where is", "kestrel", "docvex", "atlas", "valkyrie"]):
            distress = [a for a in fleet_snapshot if a["under_fire"] or a["status"] == "DISTRESS"]
            summary = "; ".join(
                f"{a['callsign']} ({a['ship_name']}) at {a['zone']} [{a['status']}, Shields {a['shields_pct']:.0f}%]"
                for a in fleet_snapshot
            )
            prefix = (
                f"Priority alert: {distress[0]['callsign']} is under fire at {distress[0]['zone']}! "
                if distress
                else ""
            )
            return {
                "reply": f"{prefix}Fleet C2 holographic tracking shows {len(fleet_snapshot)} allied vessels: {summary}.",
                "provider_used": "demo",
                "mood": "COMBAT" if distress else "NOMINAL",
                "receipts": [],
                "saved_memories": [],
            }

        if any(w in low for w in ["status", "report", "shields", "fuel", "vitals", "telemetry"]):
            sh = telemetry_snapshot["shields"]
            min_sh = min(sh["front"], sh["back"], sh["left"], sh["right"])
            return {
                "reply": (
                    f"Ship status in {telemetry_snapshot['zone']}: Mode {telemetry_snapshot['master_mode']}, "
                    f"speed {telemetry_snapshot['speed_mps']:.0f} m/s, minimum shield {min_sh:.0f}%, "
                    f"H2 fuel {telemetry_snapshot['hydrogen_fuel_pct']:.0f}%, QT fuel {telemetry_snapshot['quantum_fuel_pct']:.0f}%. "
                    f"Alert condition is {telemetry_snapshot['alert_level']}."
                ),
                "provider_used": "demo",
                "mood": telemetry_snapshot["alert_level"],
                "receipts": [],
                "saved_memories": [],
            }

        if compiled.retrieved_memories:
            top = compiled.retrieved_memories[0]
            return {
                "reply": (
                    f"Pulling from {top.domain} memory ({top.truth_class}): {top.content} "
                    "Anything you'd like me to act on, Commander?"
                ),
                "provider_used": "demo",
                "mood": "NOMINAL",
                "receipts": [],
                "saved_memories": [],
            }

        return {
            "reply": (
                f"AETHER online in {telemetry_snapshot['zone']}. "
                "You can ask me to toggle ship systems, check allied fleet positions on the hologram, "
                "tell a joke, or remember crew notes."
            ),
            "provider_used": "demo",
            "mood": "NOMINAL",
            "receipts": [],
            "saved_memories": [],
        }

    @staticmethod
    def _infer_mood(text: str, telemetry: dict[str, Any], receipts: list[dict[str, Any]]) -> str:
        if any(r.get("status") == "PENDING_CONFIRMATION" for r in receipts):
            return "CAUTION"
        if telemetry.get("alert_level") == "COMBAT":
            return "COMBAT"
        if any(w in text.lower() for w in ["joke", "duct tape", "elevator", "champagne", "haha"]):
            return "HUMOR"
        return telemetry.get("alert_level", "NOMINAL")
