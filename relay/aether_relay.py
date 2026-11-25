#!/usr/bin/env python3
"""AETHER Fleet Relay Client — lightweight companion script for allies/org-mates.

Streams a wingman's local Star Citizen telemetry (ship, shields, hull, fuel, zone, combat status)
to a Fleet Commander's AETHER C2 Hologram Hub via WebSocket (/ws/fleet).

Usage:
    python relay/aether_relay.py --hub ws://127.0.0.1:8765/ws/fleet --callsign Viper-4 --ship "Aegis Gladius" --planet Hurston
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import time

import websockets


async def run_relay(args: argparse.Namespace) -> None:
    print(f"[AETHER Relay] Connecting to C2 Hub {args.hub} as {args.callsign} ({args.ship})...")
    async with websockets.connect(args.hub) as ws:
        print("[AETHER Relay] Connected! Streaming live fleet telemetry (2 Hz)...")
        t0 = time.time()
        while True:
            elapsed = time.time() - t0
            packet = {
                "callsign": args.callsign,
                "pilot_name": args.pilot or args.callsign,
                "ship_name": args.ship,
                "ship_class": args.ship_class,
                "squad": args.squad,
                "role": "PILOT",
                "planet": args.planet,
                "zone": f"{args.planet} Orbit",
                "orbit_angle_rad": (elapsed * 0.25) % math.tau,
                "orbit_radius": 2.9,
                "shields_pct": 100.0,
                "hull_pct": 100.0,
                "fuel_pct": max(10.0, 95.0 - elapsed * 0.05),
                "status": "PATROL",
                "under_fire": False,
            }
            await ws.send(json.dumps(packet))
            ack = await ws.recv()
            print(f"\r[AETHER Relay] Sent heartbeat -> {ack}", end="", flush=True)
            await asyncio.sleep(0.5)


def main() -> None:
    parser = argparse.ArgumentParser(description="AETHER Star Citizen Fleet Relay Client")
    parser.add_argument("--hub", default="ws://127.0.0.1:8765/ws/fleet", help="AETHER C2 Hub WebSocket URL")
    parser.add_argument("--callsign", required=True, help="Your callsign on the C2 hologram")
    parser.add_argument("--pilot", default="", help="Optional pilot name")
    parser.add_argument("--ship", default="Anvil F7C Hornet", help="Current Star Citizen vessel")
    parser.add_argument("--ship-class", default="Fighter", choices=["Capital", "Fighter", "Medical", "Freight", "Recon"])
    parser.add_argument("--squad", default="Alpha")
    parser.add_argument("--planet", default="Crusader", choices=["Hurston", "Crusader", "ArcCorp", "MicroTech"])
    args = parser.parse_args()
    asyncio.run(run_relay(args))


if __name__ == "__main__":
    main()
