"""Deterministic 17Hz telemetry delta watcher -> personality-shaped proactive AI alerts.

Monitors:
  - INCOMING_MISSILE (bearing/clock, distance, closing speed, ETA) — instant split-second warning
  - RADAR_LOCK (hostile radar / missile lock-on with bearing, distance, closing speed)
  - SHIELDS_CRITICAL, UNDER_FIRE, LOW_HYDROGEN_FUEL, LOW_OXYGEN, ALLY_DISTRESS

Alert wording adapts automatically from AETHER's Living Personality memories (domain='personality')
— never a manual settings toggle! When AETHER remembers to "speak plainly / no statistics",
every warning drops raw percentages and uses natural human callouts ("Incoming missile!",
"Shields are almost gone!", "Close and coming in fast!").
"""

from __future__ import annotations

import time
import uuid

from .models import AllyShipState, ShipTelemetry, TelemetryTriggerEvent


def _plain_distance_phrase(distance_m: float) -> str:
    if distance_m <= 600:
        return "right on top of us"
    if distance_m <= 1600:
        return "very close"
    if distance_m <= 3600:
        return "close"
    if distance_m <= 7500:
        return "mid-range"
    return "way out"


def _plain_speed_phrase(speed_mps: float) -> str:
    if speed_mps >= 800:
        return "screaming in"
    if speed_mps >= 520:
        return "coming in fast"
    if speed_mps >= 260:
        return "closing fast"
    return "closing in"


def _fmt_range_tactical(distance_m: float) -> str:
    if distance_m >= 1000:
        return f"{distance_m / 1000.0:.1f} klicks"
    return f"{distance_m:.0f} meters"


def _prefers_plain_speech(personality_memories: list[str], tone: str = "") -> bool:
    """Detect whether AETHER's living personality favors plain speech over raw statistics.

    Evaluated in chronological order so later pilot directions cleanly override earlier ones!
    """
    plain = False
    plain_markers = (
        "plain",
        "plainly",
        "no stats",
        "no statistics",
        "don't give me statistics",
        "without statistics",
        "no numbers",
        "no percentages",
        "avoid percentages",
        "avoid numbers",
        "natural language",
        "talk normal",
        "casual",
        "human way",
    )
    stats_markers = (
        "exact numbers",
        "give me statistics",
        "use percentages",
        "full telemetry numbers",
        "back to stats",
        "give me exact stats",
    )
    for line in [tone, *personality_memories]:
        low = (line or "").lower()
        if any(m in low for m in stats_markers):
            plain = False
        if any(m in low for m in plain_markers):
            plain = True
    return plain


class TriggerEngine:
    """Filters high-frequency telemetry into discrete, personality-voiced events for AETHER."""

    def __init__(self, cooldown_seconds: float = 25.0) -> None:
        self.cooldown_seconds = cooldown_seconds
        self._last_fired: dict[str, float] = {}
        self._prev_under_fire: bool = False
        self._prev_distress_allies: set[str] = set()
        self._seen_missile_ids: set[str] = set()
        self._had_radar_lock: bool = False

    def _can_fire(self, key: str, now: float, cooldown_override: float | None = None) -> bool:
        cd = self.cooldown_seconds if cooldown_override is None else cooldown_override
        last = self._last_fired.get(key, 0.0)
        if now - last >= cd:
            self._last_fired[key] = now
            return True
        return False

    def evaluate(
        self,
        ship: ShipTelemetry,
        fleet: list[AllyShipState],
        personality_memories: list[str] | None = None,
        persona_tone: str = "",
        pilot_name: str = "Commander",
    ) -> list[TelemetryTriggerEvent]:
        now = time.time()
        events: list[TelemetryTriggerEvent] = []
        plain = _prefers_plain_speech(personality_memories or [], persona_tone)

        # 1. INCOMING MISSILE (Top survival priority — instant split-second callout!)
        active_msl_ids = {m.missile_id for m in ship.incoming_missiles}
        for msl in ship.incoming_missiles:
            is_new = msl.missile_id not in self._seen_missile_ids
            if is_new and self._can_fire(f"missile_{msl.missile_id}", now, cooldown_override=3.0):
                self._seen_missile_ids.add(msl.missile_id)
                if plain:
                    dist_txt = _plain_distance_phrase(msl.distance_m)
                    spd_txt = _plain_speed_phrase(msl.speed_mps)
                    summary = f"Incoming missile! {msl.bearing_clock.capitalize()}, {dist_txt} and {spd_txt} — pop decoys!"
                else:
                    rng = _fmt_range_tactical(msl.distance_m)
                    summary = (
                        f"Incoming {msl.missile_type} missile! {msl.bearing_clock.capitalize()}, "
                        f"{rng} out, {msl.speed_mps:.0f} meters per second — {msl.eta_sec:.1f} seconds!"
                    )
                events.append(
                    TelemetryTriggerEvent(
                        event_id=f"evt_{uuid.uuid4().hex[:8]}",
                        event_type="INCOMING_MISSILE",
                        severity="CRITICAL",
                        summary=summary,
                        data={
                            "missile_id": msl.missile_id,
                            "missile_type": msl.missile_type,
                            "bearing_clock": msl.bearing_clock,
                            "bearing_deg": msl.bearing_deg,
                            "distance_m": msl.distance_m,
                            "speed_mps": msl.speed_mps,
                            "eta_sec": msl.eta_sec,
                            "plain_speech": plain,
                        },
                    )
                )
        self._seen_missile_ids &= active_msl_ids

        # 2. RADAR / MISSILE LOCK-ON
        has_lock = bool(ship.radar_locks)
        if has_lock and not self._had_radar_lock and self._can_fire("radar_lock", now, cooldown_override=8.0):
            lk = ship.radar_locks[0]
            if plain:
                dist_txt = _plain_distance_phrase(lk.distance_m)
                spd_txt = _plain_speed_phrase(lk.closing_speed_mps)
                lock_word = "Missile lock!" if lk.lock_type == "MISSILE_LOCK" else "Target lock!"
                summary = f"{lock_word} {lk.source_name} on your {lk.bearing_clock}, {dist_txt} and {spd_txt}."
            else:
                rng = _fmt_range_tactical(lk.distance_m)
                lock_word = "Missile lock" if lk.lock_type == "MISSILE_LOCK" else "Radar lock"
                summary = (
                    f"{lock_word} from {lk.source_name}, {lk.bearing_clock}, "
                    f"{rng} out, closing at {lk.closing_speed_mps:.0f} meters per second."
                )
            events.append(
                TelemetryTriggerEvent(
                    event_id=f"evt_{uuid.uuid4().hex[:8]}",
                    event_type="RADAR_LOCK",
                    severity="CRITICAL" if lk.lock_type == "MISSILE_LOCK" else "CAUTION",
                    summary=summary,
                    data={
                        "source_name": lk.source_name,
                        "bearing_clock": lk.bearing_clock,
                        "distance_m": lk.distance_m,
                        "closing_speed_mps": lk.closing_speed_mps,
                        "lock_type": lk.lock_type,
                        "plain_speech": plain,
                    },
                )
            )
        self._had_radar_lock = has_lock

        min_shield = min(
            ship.shields.front,
            ship.shields.back,
            ship.shields.left,
            ship.shields.right,
        )

        # 3. Shields critical
        if min_shield < 30.0 and self._can_fire("shields_critical", now):
            if plain:
                summary = f"Shields are almost gone, {pilot_name}! Break off!"
            else:
                summary = f"Shield quadrant critical at {min_shield:.0f}%. Recommend evasive maneuvers or power to shields."
            events.append(
                TelemetryTriggerEvent(
                    event_id=f"evt_{uuid.uuid4().hex[:8]}",
                    event_type="SHIELDS_CRITICAL",
                    severity="CRITICAL",
                    summary=summary,
                    data={"min_shield": round(min_shield, 1), "plain_speech": plain},
                )
            )

        # 4. Combat engagement transition
        if ship.under_fire and not self._prev_under_fire and self._can_fire("combat_start", now):
            if plain:
                summary = f"Taking fire in {ship.zone}!"
            else:
                summary = f"Hostile fire detected in {ship.zone}! Current mode: {ship.master_mode}."
            events.append(
                TelemetryTriggerEvent(
                    event_id=f"evt_{uuid.uuid4().hex[:8]}",
                    event_type="UNDER_FIRE",
                    severity="CRITICAL",
                    summary=summary,
                    data={"zone": ship.zone, "master_mode": ship.master_mode, "plain_speech": plain},
                )
            )
        self._prev_under_fire = ship.under_fire

        # 5. Low Hydrogen Fuel
        if ship.hydrogen_fuel_pct < 18.0 and self._can_fire("low_h2", now):
            if plain:
                summary = f"Hydrogen's running dry, {pilot_name} — we'll need a refuel soon."
            else:
                summary = f"Hydrogen fuel critically low at {ship.hydrogen_fuel_pct:.0f}%. Nearest refuel pad advised."
            events.append(
                TelemetryTriggerEvent(
                    event_id=f"evt_{uuid.uuid4().hex[:8]}",
                    event_type="LOW_HYDROGEN_FUEL",
                    severity="CAUTION",
                    summary=summary,
                    data={"hydrogen_fuel_pct": round(ship.hydrogen_fuel_pct, 1), "plain_speech": plain},
                )
            )

        # 6. Low Oxygen
        if ship.vitals.oxygen_pct < 35.0 and self._can_fire("low_o2", now):
            if plain:
                summary = "Suit air is getting dangerously low."
            else:
                summary = f"Pilot suit oxygen dropping ({ship.vitals.oxygen_pct:.0f}%)."
            events.append(
                TelemetryTriggerEvent(
                    event_id=f"evt_{uuid.uuid4().hex[:8]}",
                    event_type="LOW_OXYGEN",
                    severity="CRITICAL",
                    summary=summary,
                    data={"oxygen_pct": round(ship.vitals.oxygen_pct, 1), "plain_speech": plain},
                )
            )

        # 7. Allied fleet distress call
        current_distress = {a.callsign for a in fleet if a.status == "DISTRESS" or a.under_fire}
        new_distress = current_distress - self._prev_distress_allies
        for callsign in new_distress:
            ally = next((a for a in fleet if a.callsign == callsign), None)
            if ally and self._can_fire(f"ally_distress_{callsign}", now):
                if plain:
                    sh_txt = "shields are nearly gone" if ally.shields_pct < 35 else "shields are taking a beating"
                    summary = f"{ally.callsign}'s taking heavy fire near {ally.zone} — {sh_txt}!"
                else:
                    summary = (
                        f"Fleet alert: {ally.callsign} ({ally.ship_name}) is under fire at {ally.zone} "
                        f"(Shields {ally.shields_pct:.0f}%, Hull {ally.hull_pct:.0f}%)."
                    )
                events.append(
                    TelemetryTriggerEvent(
                        event_id=f"evt_{uuid.uuid4().hex[:8]}",
                        event_type="ALLY_DISTRESS",
                        severity="CRITICAL",
                        summary=summary,
                        data={"callsign": ally.callsign, "zone": ally.zone, "ship": ally.ship_name, "plain_speech": plain},
                    )
                )
        self._prev_distress_allies = current_distress

        return events
