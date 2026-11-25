"""Pydantic models for Star Citizen telemetry, fleet allies, and proactive events."""

from __future__ import annotations

import time
from typing import Any
from pydantic import BaseModel, Field


class ShieldQuadrants(BaseModel):
    front: float = 100.0
    back: float = 100.0
    left: float = 100.0
    right: float = 100.0


class PlayerVitals(BaseModel):
    health_pct: float = 100.0
    oxygen_pct: float = 100.0
    hydration_pct: float = 92.0
    hunger_pct: float = 88.0
    heart_rate_bpm: float = 72.0
    body_temp_c: float = 37.0
    locomotion: str = "PILOT_SEAT"  # ON_FOOT | PILOT_SEAT | GUNNER | EVA


class ShipTelemetry(BaseModel):
    timestamp: float = Field(default_factory=time.time)
    source: str = "simulator"  # simulator | grpc_live
    zone: str = "Crusader Orbit"
    planet: str = "Crusader"
    speed_mps: float = 185.0
    vertical_speed_mps: float = 0.0
    radar_altitude_m: float = 4250.0
    pitch_deg: float = 0.0
    roll_deg: float = 0.0
    yaw_deg: float = 142.0
    g_force: float = 1.0
    hydrogen_fuel_pct: float = 78.0
    quantum_fuel_pct: float = 64.0
    hull_pct: float = 100.0
    shields: ShieldQuadrants = Field(default_factory=ShieldQuadrants)
    master_mode: str = "SCM"  # SCM | NAV
    landing_gear_down: bool = False
    exterior_lights_on: bool = False
    vtol_enabled: bool = False
    doors_open: bool = False
    quantum_spooling: bool = False
    flight_assist: bool = True
    under_fire: bool = False
    alert_level: str = "NOMINAL"  # NOMINAL | CAUTION | COMBAT
    vitals: PlayerVitals = Field(default_factory=PlayerVitals)


class AllyShipState(BaseModel):
    callsign: str
    pilot_name: str
    ship_name: str
    ship_class: str = "Fighter"  # Capital | Fighter | Medical | Freight | Recon
    squad: str = "Alpha"
    role: str = "PILOT"
    planet: str = "Crusader"  # Hurston | Crusader | ArcCorp | MicroTech | Stanton
    zone: str = "Yela / Grim HEX"
    orbit_angle_rad: float = 0.0
    orbit_radius: float = 2.6
    shields_pct: float = 100.0
    hull_pct: float = 100.0
    fuel_pct: float = 85.0
    status: str = "PATROL"  # PATROL | COMBAT | QUANTUM | DOCKED | DISTRESS
    under_fire: bool = False
    last_seen: float = Field(default_factory=time.time)
    relay_source: str = "simulated"


class TelemetryTriggerEvent(BaseModel):
    event_id: str
    event_type: str
    severity: str  # INFO | CAUTION | CRITICAL
    summary: str
    data: dict[str, Any] = Field(default_factory=dict)
    timestamp: float = Field(default_factory=time.time)
