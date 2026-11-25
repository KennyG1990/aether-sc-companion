"""Context-aware 17Hz Star Citizen telemetry watcher -> personality-voiced proactive alerts.

Built to eliminate robotic nag loops & game-physics false alarms:
  1. Master Modes / Quantum Context Awareness: Dropping shields to 0% in NAV / Quantum mode or while
     landed is 100% expected Star Citizen physics — NEVER triggers SHIELDS_CRITICAL!
  2. Edge-Triggered Hysteresis Latches: Low shields / low fuel / low oxygen fire ONCE on threshold
     crossing and ONLY re-arm after genuine recovery (zero repetitive 25s nag loops).
  3. Living Personality Alert Suppression: If the pilot tells AETHER "stop mentioning my shields"
     (saved to domain='personality' memory), this engine respects it immediately!
  4. Privacy-First Buddy State Alerts: Announces connected squadmates' game states (almost dead,
     incapacitated, out of ammo, incoming missile, under fire) purely from structured telemetry —
     zero chat or persona leakage!
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


def _extract_suppressed_alerts(personality_memories: list[str]) -> set[str]:
    """Read Living Personality memories chronologically so telling AETHER 'stop mentioning shields'
    genuinely silences shield alerts — and 'warn me about shields again' re-enables them!"""
    suppressed: set[str] = set()
    mute_verbs = (
        "stop mentioning",
        "stop warning",
        "stop telling me about",
        "don't mention",
        "do not mention",
        "don't warn",
        "do not warn",
        "never mention",
        "ignore ",
        "shut up about",
        "mute ",
        "quit mentioning",
        "stop reminding",
        "don't bug me about",
        "don't alert",
        "not mention",
        "avoid mentioning",
    )
    unmute_verbs = (
        "start mentioning",
        "start warning",
        "warn me about",
        "tell me about",
        "unmute ",
        "re-enable",
        "resume warning",
        "back to warning",
    )
    topic_map = {
        "shields": ("shield", "shields"),
        "fuel": ("fuel", "hydrogen", "h2"),
        "oxygen": ("oxygen", "o2", "air"),
        "radar_lock": ("radar lock", "target lock", "lock-on", "lock on"),
        "missile": ("missile", "missiles"),
        "ally": ("ally", "allies", "buddy", "friend", "squad"),
        "all_alerts": ("all alerts", "all warnings", "stop all warnings", "stay quiet", "radio silence"),
    }

    for line in personality_memories:
        low = (line or "").lower()
        is_mute = any(v in low for v in mute_verbs)
        is_unmute = (not is_mute) and any(v in low for v in unmute_verbs)
        if not is_mute and not is_unmute:
            continue
        for topic, kws in topic_map.items():
            if any(k in low for k in kws):
                if is_mute:
                    suppressed.add(topic)
                elif is_unmute:
                    suppressed.discard(topic)
                    suppressed.discard("all_alerts")
    return suppressed


class TriggerEngine:
    """Context-aware, latch-debounced, personality-voiced 17Hz trigger engine."""

    def __init__(self, cooldown_seconds: float = 25.0) -> None:
        self.cooldown_seconds = cooldown_seconds
        self._last_fired: dict[str, float] = {}
        self._prev_under_fire: bool = False
        self._seen_missile_ids: set[str] = set()
        self._had_radar_lock: bool = False

        # Hysteresis latches (fire ONCE on crossing threshold; re-arm only on real recovery!)
        self._shields_latched: bool = False
        self._fuel_low_latched: bool = False
        self._fuel_crit_latched: bool = False
        self._oxygen_latched: bool = False

        # Per-ally state transition latches (pure game state — zero chat!)
        self._prev_distress_allies: set[str] = set()
        self._prev_critical_allies: set[str] = set()
        self._prev_incap_allies: set[str] = set()
        self._prev_no_ammo_allies: set[str] = set()
        self._prev_missile_allies: set[str] = set()

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
        mems = personality_memories or []
        plain = _prefers_plain_speech(mems, persona_tone)
        suppressed = _extract_suppressed_alerts(mems)

        if "all_alerts" in suppressed:
            return events

        # Star Citizen Master Modes & flight physics context:
        # In NAV mode / Quantum spooling / Quantum transit / parked on pad, shields dropping to 0% is NORMAL!
        in_nav_or_quantum = (
            ship.master_mode.upper() == "NAV" or ship.quantum_spooling or ship.in_quantum
        )
        landed_idle = ship.landing_gear_down and ship.speed_mps < 25.0 and not ship.under_fire
        shields_expected_online = (not in_nav_or_quantum) and (not landed_idle)

        # 1. INCOMING MISSILE (Top survival priority — instant split-second callout!)
        active_msl_ids = {m.missile_id for m in ship.incoming_missiles}
        if "missile" not in suppressed:
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
        if "radar_lock" not in suppressed and has_lock and not self._had_radar_lock and self._can_fire("radar_lock", now, cooldown_override=8.0):
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

        # 3. Shields critical — ONLY when shields SHOULD be online (SCM flight) + hysteresis latch!
        if not shields_expected_online:
            # In NAV/Quantum or parked: shields down is normal! Reset latch cleanly so returning to SCM works naturally.
            self._shields_latched = False
        else:
            if min_shield >= 55.0:
                self._shields_latched = False
            elif (
                "shields" not in suppressed
                and min_shield < 30.0
                and not self._shields_latched
                and self._can_fire("shields_critical", now)
            ):
                self._shields_latched = True
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

        # 4. Combat engagement transition (context-aware if caught in NAV mode!)
        if ship.under_fire and not self._prev_under_fire and self._can_fire("combat_start", now):
            if in_nav_or_quantum:
                summary = f"Taking fire in NAV mode with shields offline, {pilot_name} — drop to SCM!"
            elif plain:
                summary = f"Taking fire in {ship.zone}!"
            else:
                summary = f"Hostile fire detected in {ship.zone}! Current mode: {ship.master_mode}."
            events.append(
                TelemetryTriggerEvent(
                    event_id=f"evt_{uuid.uuid4().hex[:8]}",
                    event_type="UNDER_FIRE",
                    severity="CRITICAL",
                    summary=summary,
                    data={"zone": ship.zone, "master_mode": ship.master_mode, "in_nav": in_nav_or_quantum, "plain_speech": plain},
                )
            )
        self._prev_under_fire = ship.under_fire

        # 5. Low Hydrogen Fuel (2-stage hysteresis latch: once below 18%, once below 8%, re-arms > 28%)
        if ship.hydrogen_fuel_pct >= 28.0:
            self._fuel_low_latched = False
            self._fuel_crit_latched = False
        elif "fuel" not in suppressed:
            if ship.hydrogen_fuel_pct < 8.0 and not self._fuel_crit_latched and self._can_fire("crit_h2", now):
                self._fuel_crit_latched = True
                self._fuel_low_latched = True
                summary = (
                    f"Hydrogen's practically empty, {pilot_name} — find a pad now!"
                    if plain
                    else f"Hydrogen fuel emergency at {ship.hydrogen_fuel_pct:.0f}%! Immediate refuel required."
                )
                events.append(
                    TelemetryTriggerEvent(
                        event_id=f"evt_{uuid.uuid4().hex[:8]}",
                        event_type="LOW_HYDROGEN_FUEL",
                        severity="CRITICAL",
                        summary=summary,
                        data={"hydrogen_fuel_pct": round(ship.hydrogen_fuel_pct, 1), "plain_speech": plain},
                    )
                )
            elif ship.hydrogen_fuel_pct < 18.0 and not self._fuel_low_latched and self._can_fire("low_h2", now):
                self._fuel_low_latched = True
                summary = (
                    f"Hydrogen's running dry, {pilot_name} — we'll need a refuel soon."
                    if plain
                    else f"Hydrogen fuel critically low at {ship.hydrogen_fuel_pct:.0f}%. Nearest refuel pad advised."
                )
                events.append(
                    TelemetryTriggerEvent(
                        event_id=f"evt_{uuid.uuid4().hex[:8]}",
                        event_type="LOW_HYDROGEN_FUEL",
                        severity="CAUTION",
                        summary=summary,
                        data={"hydrogen_fuel_pct": round(ship.hydrogen_fuel_pct, 1), "plain_speech": plain},
                    )
                )

        # 6. Low Oxygen (hysteresis latch: fires < 35%, re-arms > 60%)
        if ship.vitals.oxygen_pct >= 60.0:
            self._oxygen_latched = False
        elif "oxygen" not in suppressed and ship.vitals.oxygen_pct < 35.0 and not self._oxygen_latched and self._can_fire("low_o2", now):
            self._oxygen_latched = True
            summary = "Suit air is getting dangerously low." if plain else f"Pilot suit oxygen dropping ({ship.vitals.oxygen_pct:.0f}%)."
            events.append(
                TelemetryTriggerEvent(
                    event_id=f"evt_{uuid.uuid4().hex[:8]}",
                    event_type="LOW_OXYGEN",
                    severity="CRITICAL",
                    summary=summary,
                    data={"oxygen_pct": round(ship.vitals.oxygen_pct, 1), "plain_speech": plain},
                )
            )

        # 7. Connected Squadmate / Buddy Game-State Alerts (PURE TELEMETRY — ZERO CHAT LEAKAGE!)
        current_incap = {a.callsign for a in fleet if a.incapacitated}
        current_critical = {a.callsign for a in fleet if (not a.incapacitated) and (a.health_pct < 28.0 or a.hull_pct < 28.0)}
        current_no_ammo = {a.callsign for a in fleet if a.ammo_pct <= 5.0}
        current_msl = {a.callsign for a in fleet if a.incoming_missile}
        current_distress = {a.callsign for a in fleet if a.status == "DISTRESS" or a.under_fire}

        if "ally" not in suppressed:
            # 7a. Buddy Incapacitated
            for cs in current_incap - self._prev_incap_allies:
                ally = next((a for a in fleet if a.callsign == cs), None)
                if ally and self._can_fire(f"ally_incap_{cs}", now, cooldown_override=15.0):
                    events.append(
                        TelemetryTriggerEvent(
                            event_id=f"evt_{uuid.uuid4().hex[:8]}",
                            event_type="ALLY_INCAPACITATED",
                            severity="CRITICAL",
                            summary=f"{ally.callsign} is down — incapacitated at {ally.zone}!",
                            data={"callsign": ally.callsign, "zone": ally.zone, "ship": ally.ship_name},
                        )
                    )

            # 7b. Buddy Almost Dead (Hull < 28% or Health < 28%)
            for cs in current_critical - self._prev_critical_allies:
                ally = next((a for a in fleet if a.callsign == cs), None)
                if ally and self._can_fire(f"ally_crit_{cs}", now, cooldown_override=15.0):
                    summary = (
                        f"Your buddy {ally.callsign} is almost dead over at {ally.zone}!"
                        if plain
                        else f"Ally critical: {ally.callsign} ({ally.ship_name}) hull at {ally.hull_pct:.0f}%, pilot health {ally.health_pct:.0f}% at {ally.zone}!"
                    )
                    events.append(
                        TelemetryTriggerEvent(
                            event_id=f"evt_{uuid.uuid4().hex[:8]}",
                            event_type="ALLY_CRITICAL",
                            severity="CRITICAL",
                            summary=summary,
                            data={"callsign": ally.callsign, "zone": ally.zone, "hull_pct": ally.hull_pct, "health_pct": ally.health_pct},
                        )
                    )

            # 7c. Buddy Out of Ammo
            for cs in current_no_ammo - self._prev_no_ammo_allies:
                ally = next((a for a in fleet if a.callsign == cs), None)
                if ally and self._can_fire(f"ally_ammo_{cs}", now, cooldown_override=20.0):
                    summary = (
                        f"{ally.callsign}'s out of ammo over at {ally.zone}!"
                        if plain
                        else f"Squad update: {ally.callsign} ballistic ammo depleted ({ally.ammo_pct:.0f}%) at {ally.zone}."
                    )
                    events.append(
                        TelemetryTriggerEvent(
                            event_id=f"evt_{uuid.uuid4().hex[:8]}",
                            event_type="ALLY_OUT_OF_AMMO",
                            severity="CAUTION",
                            summary=summary,
                            data={"callsign": ally.callsign, "zone": ally.zone, "ammo_pct": ally.ammo_pct},
                        )
                    )

            # 7d. Buddy Incoming Missile
            for cs in current_msl - self._prev_missile_allies:
                ally = next((a for a in fleet if a.callsign == cs), None)
                if ally and self._can_fire(f"ally_msl_{cs}", now, cooldown_override=10.0):
                    summary = (
                        f"{ally.callsign}'s got a missile on him at {ally.zone}!"
                        if plain
                        else f"Fleet threat: incoming missile tracked on {ally.callsign} at {ally.zone}."
                    )
                    events.append(
                        TelemetryTriggerEvent(
                            event_id=f"evt_{uuid.uuid4().hex[:8]}",
                            event_type="ALLY_INCOMING_MISSILE",
                            severity="CRITICAL",
                            summary=summary,
                            data={"callsign": ally.callsign, "zone": ally.zone},
                        )
                    )

            # 7e. Buddy Under Fire / Distress (only if we didn't already fire a higher-priority critical alert for them)
            for cs in current_distress - self._prev_distress_allies:
                if cs in (current_incap | current_critical):
                    continue
                ally = next((a for a in fleet if a.callsign == cs), None)
                if ally and self._can_fire(f"ally_distress_{cs}", now):
                    if plain:
                        sh_txt = "shields are nearly gone" if ally.shields_pct < 35 else "taking heavy fire"
                        summary = f"{ally.callsign}'s {sh_txt} near {ally.zone}!"
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

        self._prev_incap_allies = current_incap
        self._prev_critical_allies = current_critical
        self._prev_no_ammo_allies = current_no_ammo
        self._prev_missile_allies = current_msl
        self._prev_distress_allies = current_distress

        return events
