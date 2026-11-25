"""Deterministic 17Hz telemetry delta watcher -> proactive AI triggers with cooldowns."""

from __future__ import annotations

import time
import uuid

from .models import AllyShipState, ShipTelemetry, TelemetryTriggerEvent


class TriggerEngine:
    """Filters high-frequency telemetry into discrete, meaningful events for AETHER."""

    def __init__(self, cooldown_seconds: float = 25.0) -> None:
        self.cooldown_seconds = cooldown_seconds
        self._last_fired: dict[str, float] = {}
        self._prev_under_fire: bool = False
        self._prev_distress_allies: set[str] = set()

    def _can_fire(self, key: str, now: float) -> bool:
        last = self._last_fired.get(key, 0.0)
        if now - last >= self.cooldown_seconds:
            self._last_fired[key] = now
            return True
        return False

    def evaluate(
        self,
        ship: ShipTelemetry,
        fleet: list[AllyShipState],
    ) -> list[TelemetryTriggerEvent]:
        now = time.time()
        events: list[TelemetryTriggerEvent] = []

        min_shield = min(
            ship.shields.front,
            ship.shields.back,
            ship.shields.left,
            ship.shields.right,
        )

        # 1. Shields critical
        if min_shield < 30.0 and self._can_fire("shields_critical", now):
            events.append(
                TelemetryTriggerEvent(
                    event_id=f"evt_{uuid.uuid4().hex[:8]}",
                    event_type="SHIELDS_CRITICAL",
                    severity="CRITICAL",
                    summary=f"Shield quadrant critical ({min_shield:.0f}%). Recommend evasive maneuvers or SCM power to shields.",
                    data={"min_shield": round(min_shield, 1)},
                )
            )

        # 2. Combat engagement transition
        if ship.under_fire and not self._prev_under_fire and self._can_fire("combat_start", now):
            events.append(
                TelemetryTriggerEvent(
                    event_id=f"evt_{uuid.uuid4().hex[:8]}",
                    event_type="UNDER_FIRE",
                    severity="CRITICAL",
                    summary=f"Hostile fire detected in {ship.zone}! Current mode: {ship.master_mode}.",
                    data={"zone": ship.zone, "master_mode": ship.master_mode},
                )
            )
        self._prev_under_fire = ship.under_fire

        # 3. Low Hydrogen Fuel
        if ship.hydrogen_fuel_pct < 18.0 and self._can_fire("low_h2", now):
            events.append(
                TelemetryTriggerEvent(
                    event_id=f"evt_{uuid.uuid4().hex[:8]}",
                    event_type="LOW_HYDROGEN_FUEL",
                    severity="CAUTION",
                    summary=f"Hydrogen fuel critically low at {ship.hydrogen_fuel_pct:.0f}%. Nearest refuel pad advised.",
                    data={"hydrogen_fuel_pct": round(ship.hydrogen_fuel_pct, 1)},
                )
            )

        # 4. Low Oxygen
        if ship.vitals.oxygen_pct < 35.0 and self._can_fire("low_o2", now):
            events.append(
                TelemetryTriggerEvent(
                    event_id=f"evt_{uuid.uuid4().hex[:8]}",
                    event_type="LOW_OXYGEN",
                    severity="CRITICAL",
                    summary=f"Pilot suit oxygen dropping ({ship.vitals.oxygen_pct:.0f}%).",
                    data={"oxygen_pct": round(ship.vitals.oxygen_pct, 1)},
                )
            )

        # 5. Allied fleet distress call
        current_distress = {a.callsign for a in fleet if a.status == "DISTRESS" or a.under_fire}
        new_distress = current_distress - self._prev_distress_allies
        for callsign in new_distress:
            ally = next((a for a in fleet if a.callsign == callsign), None)
            if ally and self._can_fire(f"ally_distress_{callsign}", now):
                events.append(
                    TelemetryTriggerEvent(
                        event_id=f"evt_{uuid.uuid4().hex[:8]}",
                        event_type="ALLY_DISTRESS",
                        severity="CRITICAL",
                        summary=(
                            f"Fleet alert: {ally.callsign} ({ally.ship_name}) is under fire at {ally.zone} "
                            f"(Shields {ally.shields_pct:.0f}%, Hull {ally.hull_pct:.0f}%)."
                        ),
                        data={"callsign": ally.callsign, "zone": ally.zone, "ship": ally.ship_name},
                    )
                )
        self._prev_distress_allies = current_distress

        return events
