"""17Hz Star Citizen Telemetry & Stanton Allied Fleet Simulator for PoC testing."""

from __future__ import annotations

import math
import time
from typing import Any

from .models import AllyShipState, ShipTelemetry


class TelemetrySimulator:
    """Produces smooth 17Hz ship telemetry + live Stanton allied fleet state."""

    def __init__(self) -> None:
        self.ship = ShipTelemetry(source="simulator")
        self._start_time = time.time()
        self._combat_until = 0.0
        self.allies: dict[str, AllyShipState] = {
            "Kestrel": AllyShipState(
                callsign="Kestrel",
                pilot_name="Bravo-1",
                ship_name="Anvil F7A Hornet Mk II",
                ship_class="Fighter",
                squad="Bravo",
                role="PILOT",
                planet="Crusader",
                zone="Yela / Grim HEX",
                orbit_angle_rad=0.6,
                orbit_radius=2.8,
                shields_pct=96.0,
                hull_pct=100.0,
                fuel_pct=74.0,
                status="PATROL",
            ),
            "DocVex": AllyShipState(
                callsign="DocVex",
                pilot_name="Medevac-2",
                ship_name="Drake Cutlass Red",
                ship_class="Medical",
                squad="Support",
                role="MEDIC",
                planet="Hurston",
                zone="Hurston / Everus Harbor",
                orbit_angle_rad=2.1,
                orbit_radius=2.5,
                shields_pct=100.0,
                hull_pct=100.0,
                fuel_pct=91.0,
                status="DOCKED",
            ),
            "Atlas-9": AllyShipState(
                callsign="Atlas-9",
                pilot_name="Hauler-Actual",
                ship_name="Crusader C2 Hercules",
                ship_class="Freight",
                squad="Logistics",
                role="PILOT",
                planet="ArcCorp",
                zone="ArcCorp / Baijini Point",
                orbit_angle_rad=4.0,
                orbit_radius=2.9,
                shields_pct=88.0,
                hull_pct=94.0,
                fuel_pct=62.0,
                status="QUANTUM",
            ),
            "Valkyrie-Lead": AllyShipState(
                callsign="Valkyrie-Lead",
                pilot_name="Org-Commander",
                ship_name="Aegis Polaris",
                ship_class="Capital",
                squad="Command",
                role="CAPTAIN",
                planet="MicroTech",
                zone="MicroTech / Port Tressler",
                orbit_angle_rad=5.2,
                orbit_radius=3.1,
                shields_pct=100.0,
                hull_pct=100.0,
                fuel_pct=83.0,
                status="PATROL",
            ),
        }

    def step(self) -> tuple[ShipTelemetry, list[AllyShipState]]:
        now = time.time()
        t = now - self._start_time
        self.ship.timestamp = now

        # Smooth flight dynamics
        target_speed = 920.0 if self.ship.master_mode == "NAV" else (210.0 if not self.ship.landing_gear_down else 42.0)
        self.ship.speed_mps += (target_speed - self.ship.speed_mps) * 0.08
        self.ship.pitch_deg = round(math.sin(t * 0.55) * (14.0 if self.ship.under_fire else 4.5), 2)
        self.ship.roll_deg = round(math.cos(t * 0.42) * (28.0 if self.ship.under_fire else 9.0), 2)
        self.ship.yaw_deg = round((self.ship.yaw_deg + (0.45 if self.ship.under_fire else 0.12)) % 360.0, 2)
        self.ship.radar_altitude_m = round(
            max(12.0, 4200.0 + math.sin(t * 0.3) * 180.0 - (3800.0 if self.ship.landing_gear_down else 0.0)),
            1,
        )
        self.ship.g_force = round(1.0 + abs(math.sin(t * 0.9)) * (3.4 if self.ship.under_fire else 0.35), 2)

        # Fuel burn
        burn = 0.008 if self.ship.master_mode == "NAV" else 0.0025
        self.ship.hydrogen_fuel_pct = max(2.0, round(self.ship.hydrogen_fuel_pct - burn, 2))

        # Combat simulation / shield recharge
        if now < self._combat_until:
            self.ship.under_fire = True
            self.ship.shields.front = max(12.0, round(self.ship.shields.front - 0.55, 1))
            self.ship.shields.left = max(28.0, round(self.ship.shields.left - 0.25, 1))
            self.ship.vitals.heart_rate_bpm = min(136.0, round(self.ship.vitals.heart_rate_bpm + 0.6, 1))
        else:
            self.ship.under_fire = False
            if self.ship.master_mode == "SCM":
                self.ship.shields.front = min(100.0, round(self.ship.shields.front + 0.35, 1))
                self.ship.shields.back = min(100.0, round(self.ship.shields.back + 0.35, 1))
                self.ship.shields.left = min(100.0, round(self.ship.shields.left + 0.35, 1))
                self.ship.shields.right = min(100.0, round(self.ship.shields.right + 0.35, 1))
            else:
                # NAV mode drops shields gradually per Star Citizen Master Modes
                self.ship.shields.front = max(0.0, round(self.ship.shields.front - 0.8, 1))
                self.ship.shields.back = max(0.0, round(self.ship.shields.back - 0.8, 1))
                self.ship.shields.left = max(0.0, round(self.ship.shields.left - 0.8, 1))
                self.ship.shields.right = max(0.0, round(self.ship.shields.right - 0.8, 1))
            self.ship.vitals.heart_rate_bpm = max(70.0, round(self.ship.vitals.heart_rate_bpm - 0.25, 1))

        # Derive alert level
        min_shield = min(
            self.ship.shields.front,
            self.ship.shields.back,
            self.ship.shields.left,
            self.ship.shields.right,
        )
        if self.ship.under_fire or min_shield < 30.0 or self.ship.vitals.oxygen_pct < 35.0:
            self.ship.alert_level = "COMBAT"
        elif self.ship.hydrogen_fuel_pct < 20.0 or min_shield < 60.0:
            self.ship.alert_level = "CAUTION"
        else:
            self.ship.alert_level = "NOMINAL"

        # Animate simulated allies in orbit
        for ally in self.allies.values():
            if ally.relay_source == "simulated":
                speed = 0.035 if ally.status == "QUANTUM" else (0.004 if ally.status == "DOCKED" else 0.012)
                ally.orbit_angle_rad = (ally.orbit_angle_rad + speed) % (math.tau)
                ally.last_seen = now
                if ally.under_fire:
                    ally.shields_pct = max(18.0, round(ally.shields_pct - 0.3, 1))
                else:
                    ally.shields_pct = min(100.0, round(ally.shields_pct + 0.15, 1))

        return self.ship, list(self.allies.values())

    def apply_action(self, action_id: str, parameters: dict[str, Any]) -> tuple[bool, str]:
        _ = parameters
        if action_id == "toggle_landing_gear":
            self.ship.landing_gear_down = not self.ship.landing_gear_down
            state = "DEPLOYED" if self.ship.landing_gear_down else "RETRACTED"
            return True, f"Landing gear {state}."
        if action_id == "set_master_mode_scm":
            self.ship.master_mode = "SCM"
            self.ship.quantum_spooling = False
            return True, "Master Mode switched to SCM (Combat). Shields charging."
        if action_id == "set_master_mode_nav":
            self.ship.master_mode = "NAV"
            return True, "Master Mode switched to NAV (Transit). Quantum systems unlocked."
        if action_id == "toggle_lights":
            self.ship.exterior_lights_on = not self.ship.exterior_lights_on
            return True, f"Exterior lights {'ON' if self.ship.exterior_lights_on else 'OFF'}."
        if action_id == "toggle_vtol":
            self.ship.vtol_enabled = not self.ship.vtol_enabled
            return True, f"VTOL thrusters {'ENGAGED' if self.ship.vtol_enabled else 'DISENGAGED'}."
        if action_id == "toggle_doors":
            self.ship.doors_open = not self.ship.doors_open
            return True, f"Exterior ramp & doors {'OPEN' if self.ship.doors_open else 'SEALED'}."
        if action_id == "request_landing":
            return True, f"ATC hailing sent in {self.ship.zone}. Hangar pad assignment pending."
        if action_id == "spool_quantum":
            if self.ship.master_mode != "NAV":
                self.ship.master_mode = "NAV"
            self.ship.quantum_spooling = not self.ship.quantum_spooling
            return True, f"Quantum Drive {'SPOOLING' if self.ship.quantum_spooling else 'STANDBY'}."
        if action_id == "eject":
            self.ship.vitals.locomotion = "EVA"
            return True, "Pilot confirmed emergency ejection. Canopy blown; pilot in EVA."
        if action_id == "self_destruct":
            self.ship.alert_level = "COMBAT"
            return True, "Pilot confirmed self-destruct sequence. Countdown armed (15s)."
        return False, f"Simulator does not implement '{action_id}'."

    def trigger_scenario(self, scenario: str) -> str:
        now = time.time()
        if scenario == "combat_ambush":
            self._combat_until = now + 18.0
            self.ship.under_fire = True
            self.ship.shields.front = 26.0
            self.ship.shields.left = 44.0
            self.ship.master_mode = "SCM"
            return "Simulated pirate ambush triggered: forward shields dropped to 26%."
        if scenario == "low_fuel":
            self.ship.hydrogen_fuel_pct = 14.0
            return "Simulated low hydrogen fuel scenario (14%)."
        if scenario == "ally_distress":
            kestrel = self.allies.get("Kestrel")
            if kestrel:
                kestrel.status = "DISTRESS"
                kestrel.under_fire = True
                kestrel.shields_pct = 24.0
                kestrel.hull_pct = 71.0
            return "Simulated distress beacon from Kestrel (F7A Hornet Mk II) near Grim HEX."
        if scenario == "all_clear":
            self._combat_until = 0.0
            self.ship.under_fire = False
            self.ship.shields.front = 100.0
            self.ship.shields.back = 100.0
            self.ship.shields.left = 100.0
            self.ship.shields.right = 100.0
            self.ship.hydrogen_fuel_pct = 82.0
            self.ship.vitals.oxygen_pct = 100.0
            for ally in self.allies.values():
                ally.under_fire = False
                if ally.status == "DISTRESS":
                    ally.status = "PATROL"
                ally.shields_pct = 100.0
                ally.hull_pct = 100.0
            return "All systems restored to NOMINAL."
        return f"Unknown scenario '{scenario}'."

    def upsert_relay_ally(self, payload: dict[str, Any]) -> AllyShipState:
        callsign = str(payload.get("callsign", "Ally-Unknown"))[:32]
        existing = self.allies.get(callsign)
        ally = AllyShipState(
            callsign=callsign,
            pilot_name=str(payload.get("pilot_name", callsign))[:40],
            ship_name=str(payload.get("ship_name", "Unknown Vessel"))[:48],
            ship_class=str(payload.get("ship_class", "Fighter"))[:24],
            squad=str(payload.get("squad", "Org"))[:24],
            role=str(payload.get("role", "PILOT"))[:24],
            planet=str(payload.get("planet", existing.planet if existing else "Crusader"))[:32],
            zone=str(payload.get("zone", "Stanton"))[:64],
            orbit_angle_rad=float(payload.get("orbit_angle_rad", existing.orbit_angle_rad if existing else 1.2)),
            orbit_radius=float(payload.get("orbit_radius", existing.orbit_radius if existing else 2.7)),
            shields_pct=float(payload.get("shields_pct", 100.0)),
            hull_pct=float(payload.get("hull_pct", 100.0)),
            fuel_pct=float(payload.get("fuel_pct", 80.0)),
            status=str(payload.get("status", "PATROL"))[:24],
            under_fire=bool(payload.get("under_fire", False)),
            last_seen=time.time(),
            relay_source="live_relay",
        )
        self.allies[callsign] = ally
        return ally
