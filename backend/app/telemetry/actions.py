"""Transition Authority: Action Registry, Safety Confirmation Gate & Truthful Receipts."""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass
from typing import Any, Callable

from ..rag.store import MemoryStore


@dataclass(frozen=True)
class ActionDefinition:
    id: str
    description: str
    category: str
    destructive: bool = False


ACTION_REGISTRY: dict[str, ActionDefinition] = {
    "toggle_landing_gear": ActionDefinition(
        id="toggle_landing_gear",
        description="Deploy or retract the ship's landing gear.",
        category="flight",
    ),
    "set_master_mode_scm": ActionDefinition(
        id="set_master_mode_scm",
        description="Switch Master Mode to SCM (Standard Combat Mode — shields and weapons online).",
        category="flight",
    ),
    "set_master_mode_nav": ActionDefinition(
        id="set_master_mode_nav",
        description="Switch Master Mode to NAV (Navigation / Quantum transit mode).",
        category="flight",
    ),
    "toggle_lights": ActionDefinition(
        id="toggle_lights",
        description="Toggle exterior ship headlights.",
        category="utility",
    ),
    "toggle_vtol": ActionDefinition(
        id="toggle_vtol",
        description="Toggle VTOL thruster orientation.",
        category="flight",
    ),
    "toggle_doors": ActionDefinition(
        id="toggle_doors",
        description="Open or close exterior ship doors and cargo ramp.",
        category="utility",
    ),
    "request_landing": ActionDefinition(
        id="request_landing",
        description="Contact local ATC to request landing/docking clearance.",
        category="comms",
    ),
    "spool_quantum": ActionDefinition(
        id="spool_quantum",
        description="Toggle Quantum Drive spooling (requires NAV mode).",
        category="flight",
    ),
    "eject": ActionDefinition(
        id="eject",
        description="Emergency pilot ejection seat activation.",
        category="emergency",
        destructive=True,
    ),
    "self_destruct": ActionDefinition(
        id="self_destruct",
        description="Arm ship self-destruct countdown.",
        category="emergency",
        destructive=True,
    ),
}


class ActionExecutor:
    """Validates LLM-proposed actions against ACTION_REGISTRY and enforces Safety Gate."""

    def __init__(self, store: MemoryStore) -> None:
        self.store = store
        self.pending_confirmations: dict[str, dict[str, Any]] = {}
        self._dispatch_handler: Callable[[str, dict[str, Any]], tuple[bool, str]] | None = None

    def set_dispatch_handler(self, handler: Callable[[str, dict[str, Any]], tuple[bool, str]]) -> None:
        self._dispatch_handler = handler

    def list_triggerable_actions(self) -> list[dict[str, Any]]:
        return [
            {
                "id": a.id,
                "description": a.description,
                "category": a.category,
                "destructive": a.destructive,
            }
            for a in ACTION_REGISTRY.values()
        ]

    def execute(
        self,
        action_id: str,
        parameters: dict[str, Any] | None = None,
        source: str = "llm_tool",
        confirmed: bool = False,
    ) -> dict[str, Any]:
        params = parameters or {}
        action_def = ACTION_REGISTRY.get(action_id)
        if not action_def:
            return self.store.record_receipt(
                action_id=action_id,
                parameters=params,
                status="REJECTED",
                reason=f"Unknown or unregistered action '{action_id}'. Transition Authority refused execution.",
                source=source,
            )

        # Destructive Safety Gate: require explicit human confirmation
        if action_def.destructive and not confirmed:
            token = f"confirm_{uuid.uuid4().hex[:6]}"
            self.pending_confirmations[token] = {
                "token": token,
                "action_id": action_id,
                "parameters": params,
                "created_at": time.time(),
            }
            receipt = self.store.record_receipt(
                action_id=action_id,
                parameters={**params, "confirmation_token": token},
                status="PENDING_CONFIRMATION",
                reason=f"Safety Gate held destructive action '{action_id}'. Explicit pilot confirmation required.",
                source=source,
            )
            receipt["confirmation_token"] = token
            return receipt

        if self._dispatch_handler is None:
            return self.store.record_receipt(
                action_id=action_id,
                parameters=params,
                status="FAILED",
                reason="No active telemetry/game dispatch backend attached.",
                source=source,
            )

        ok, detail = self._dispatch_handler(action_id, params)
        return self.store.record_receipt(
            action_id=action_id,
            parameters=params,
            status="CONFIRMED" if ok else "FAILED",
            reason=detail,
            source=source,
        )

    def confirm_pending(self, token: str, approve: bool = True) -> dict[str, Any]:
        pending = self.pending_confirmations.pop(token, None)
        if not pending:
            return self.store.record_receipt(
                action_id="unknown",
                parameters={"confirmation_token": token},
                status="REJECTED",
                reason="Confirmation token expired or not found.",
                source="pilot_confirmation",
            )
        if not approve:
            return self.store.record_receipt(
                action_id=pending["action_id"],
                parameters=pending["parameters"],
                status="REJECTED",
                reason="Pilot cancelled destructive action at Safety Gate.",
                source="pilot_confirmation",
            )
        return self.execute(
            action_id=pending["action_id"],
            parameters=pending["parameters"],
            source="pilot_confirmed",
            confirmed=True,
        )

    def list_pending(self) -> list[dict[str, Any]]:
        now = time.time()
        # Expire confirmations older than 120 seconds
        expired = [k for k, v in self.pending_confirmations.items() if now - v["created_at"] > 120]
        for k in expired:
            del self.pending_confirmations[k]
        return list(self.pending_confirmations.values())
