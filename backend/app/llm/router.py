"""Unified Decision Authority Router: Player2 Local API <-> OpenRouter <-> Offline Demo."""

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
                model="player2-default",
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

    async def _call_openai_compat(
        self,
        base_url: str,
        headers: dict[str, str],
        model: str,
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
            "model": model,
            "messages": messages,
            "tools": TOOL_DEFINITIONS,
            "tool_choice": "auto",
            "temperature": 0.7,
        }

        receipts: list[dict[str, Any]] = []
        saved_memories: list[dict[str, Any]] = []

        try:
            async with httpx.AsyncClient(timeout=25.0) as client:
                resp = await client.post(base_url, headers=headers, json=payload)
                resp.raise_for_status()
                data = resp.json()
                choice = data["choices"][0]["message"]
                tool_calls = choice.get("tool_calls") or []

                if tool_calls:
                    messages.append(choice)
                    for tc in tool_calls:
                        fn_name = tc["function"]["name"]
                        try:
                            args = json.loads(tc["function"].get("arguments") or "{}")
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
                                "tool_call_id": tc["id"],
                                "content": tool_out,
                            }
                        )

                    # Second turn so the LLM speaks using ONLY the truthful receipts
                    followup = await client.post(
                        base_url,
                        headers=headers,
                        json={"model": model, "messages": messages, "temperature": 0.7},
                    )
                    followup.raise_for_status()
                    reply_text = followup.json()["choices"][0]["message"].get("content") or "Action processed."
                else:
                    reply_text = choice.get("content") or "Standing by, Commander."

                mood = self._infer_mood(reply_text, telemetry_snapshot, receipts)
                return {
                    "reply": reply_text,
                    "provider_used": provider_label,
                    "mood": mood,
                    "receipts": receipts,
                    "saved_memories": saved_memories,
                }
        except Exception as exc:
            fallback = self._demo_respond(compiled, telemetry_snapshot, fleet_snapshot)
            fallback["provider_used"] = f"demo_fallback ({provider_label} unavailable: {exc.__class__.__name__})"
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

        # 1. Explicit memory save ("remember that ...")
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

        # 2. Prompt-injection demonstration
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

        # 3. Ship action intent parsing -> Transition Authority
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

        # 4. Jokes & banter
        if any(w in low for w in ["joke", "funny", "laugh", "cheer me up"]):
            return {
                "reply": random.choice(JOKES),
                "provider_used": "demo",
                "mood": "HUMOR",
                "receipts": [],
                "saved_memories": [],
            }

        # 5. Fleet / Allies C2 Hologram query
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

        # 6. Ship status / telemetry report
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

        # 7. RAG memory recall response
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
                "tell a joke, or remember crew notes. Connect Player2 or OpenRouter in Config for full conversational AI!"
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
        if any(w in text.lower() for w in ["joke", "duct tape", "elevator", "champagne"]):
            return "HUMOR"
        return telemetry.get("alert_level", "NOMINAL")
