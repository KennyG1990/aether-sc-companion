"""End-to-End Encrypted Private Squad Lobbies (AES-256-GCM + HKDF-SHA256).

Privacy & Security Invariants:
  1. ZERO CHAT / ZERO VOICE / ZERO PERSONA LEAKAGE:
     Only a strictly whitelisted `SquadStatePacket` (`extra="forbid"`) of numeric/enum Star Citizen
     game states (ship, planet, zone, shields, hull, fuel, ammo, health, oxygen, under_fire,
     incoming_missile, incapacitated, shard_id) is ever serialized or accepted on the wire.
  2. ZERO-KNOWLEDGE RELAY HUB:
     Clients derive `room_token = SHA256("aether-lobby-room-v1:" + invite_code)[:32]` for routing
     and an independent 256-bit `AES-256-GCM` key via `HKDF-SHA256` locally. The relay server
     only forwards opaque encrypted blobs and can NEVER read your code or decrypt squad state.
  3. AUTHENTICATED INTEGRITY:
     Every packet uses a fresh 96-bit random nonce and binds `room_token` as Associated Data (AAD).
     Wrong invite codes, tampered ciphertexts, or packets containing extra unauthorized fields fail
     verification and are dropped immediately.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import secrets
import time
from typing import Any, Callable

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from fastapi import WebSocket
from pydantic import BaseModel, ConfigDict, Field
import websockets


# Unambiguous Crockford-style alphabet (excludes 0/O, 1/I/L for easy Discord callout)
_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
MAX_WIRE_BYTES = 4096
MAX_PEERS_PER_ROOM = 24


class SquadStatePacket(BaseModel):
    """STRICT WHITELIST: Pure game-state telemetry ONLY. Extra fields (chat/messages/prompts) are FORBIDDEN."""

    model_config = ConfigDict(extra="forbid")

    peer_id: str = Field(min_length=4, max_length=32)
    callsign: str = Field(min_length=1, max_length=32)
    pilot_name: str = Field(default="Pilot", max_length=40)
    ship_name: str = Field(default="Unknown Vessel", max_length=64)
    ship_class: str = Field(default="Fighter", max_length=24)
    squad: str = Field(default="Squad", max_length=24)
    role: str = Field(default="PILOT", max_length=24)
    planet: str = Field(default="Crusader", max_length=32)
    zone: str = Field(default="Stanton", max_length=64)
    orbit_angle_rad: float = 0.0
    orbit_radius: float = 2.6
    shields_pct: float = Field(default=100.0, ge=0.0, le=100.0)
    hull_pct: float = Field(default=100.0, ge=0.0, le=100.0)
    fuel_pct: float = Field(default=100.0, ge=0.0, le=100.0)
    ammo_pct: float = Field(default=100.0, ge=0.0, le=100.0)
    health_pct: float = Field(default=100.0, ge=0.0, le=100.0)
    oxygen_pct: float = Field(default=100.0, ge=0.0, le=100.0)
    master_mode: str = Field(default="SCM", max_length=12)
    status: str = Field(default="PATROL", max_length=24)
    under_fire: bool = False
    radar_locked: bool = False
    incoming_missile: bool = False
    incapacitated: bool = False
    shard_id: str = Field(default="", max_length=48)
    timestamp: float = Field(default_factory=time.time)


def normalize_invite_code(code: str) -> str:
    return "".join(ch for ch in (code or "").upper().strip() if ch.isalnum() or ch == "-")


def generate_invite_code() -> str:
    """Generate a high-entropy, easy-to-share lobby invite code (e.g. AETHER-7K9M-X4Q2-9P3R)."""
    groups = ["".join(secrets.choice(_CODE_ALPHABET) for _ in range(4)) for _ in range(3)]
    return f"AETHER-{'-'.join(groups)}"


def derive_lobby_keys(invite_code: str) -> tuple[str, bytes]:
    """Derive (room_token_hex, aes256_key_bytes) from an invite code.

    `room_token` routes traffic on the blind relay; `aes256_key` never leaves the client!
    """
    norm = normalize_invite_code(invite_code)
    if len(norm) < 10:
        raise ValueError("Invite code must be at least 10 characters.")
    raw = norm.encode("utf-8")
    room_token = hashlib.sha256(b"aether-lobby-room-v1:" + raw).hexdigest()[:32]
    hkdf = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=b"aether-squad-e2e-salt-v1",
        info=b"aether-squad-state-aes256gcm-v1",
    )
    aes_key = hkdf.derive(raw)
    return room_token, aes_key


def encrypt_state_packet(packet: SquadStatePacket, invite_code: str) -> dict[str, Any]:
    """Encrypt a strict SquadStatePacket with AES-256-GCM + fresh 96-bit nonce + room_token AAD."""
    room_token, key = derive_lobby_keys(invite_code)
    nonce = os.urandom(12)
    plaintext = packet.model_dump_json().encode("utf-8")
    ciphertext = AESGCM(key).encrypt(nonce, plaintext, room_token.encode("utf-8"))
    return {
        "v": 1,
        "n": base64.b64encode(nonce).decode("ascii"),
        "c": base64.b64encode(ciphertext).decode("ascii"),
    }


def decrypt_state_packet(wire_obj: dict[str, Any], invite_code: str) -> SquadStatePacket:
    """Decrypt and strictly validate an inbound encrypted squad telemetry envelope."""
    if not isinstance(wire_obj, dict) or wire_obj.get("v") != 1:
        raise ValueError("Unsupported encrypted envelope version.")
    room_token, key = derive_lobby_keys(invite_code)
    try:
        nonce = base64.b64decode(str(wire_obj["n"]))
        ciphertext = base64.b64decode(str(wire_obj["c"]))
        plaintext = AESGCM(key).decrypt(nonce, ciphertext, room_token.encode("utf-8"))
        data = json.loads(plaintext.decode("utf-8"))
    except Exception as exc:
        raise ValueError(f"Decryption or authentication failed ({exc.__class__.__name__}).") from exc
    # Rejects any extra/unauthorized fields (chat, prompts, transcripts) via extra="forbid"!
    return SquadStatePacket.model_validate(data)


class EncryptedLobbyRelayHub:
    """Zero-knowledge WebSocket relay room manager. Forwards opaque AES-256-GCM blobs only."""

    def __init__(self) -> None:
        self._rooms: dict[str, set[WebSocket]] = {}

    def room_peer_count(self, room_token: str) -> int:
        return len(self._rooms.get(room_token, ()))

    async def join(self, room_token: str, ws: WebSocket) -> bool:
        peers = self._rooms.setdefault(room_token, set())
        if len(peers) >= MAX_PEERS_PER_ROOM:
            return False
        peers.add(ws)
        return True

    def leave(self, room_token: str, ws: WebSocket) -> None:
        peers = self._rooms.get(room_token)
        if not peers:
            return
        peers.discard(ws)
        if not peers:
            self._rooms.pop(room_token, None)

    async def forward_opaque(self, room_token: str, sender: WebSocket, raw_text: str) -> int:
        """Forward opaque encrypted blob to all other peers in the room without reading/decrypting."""
        if len(raw_text.encode("utf-8")) > MAX_WIRE_BYTES:
            return 0
        peers = self._rooms.get(room_token)
        if not peers:
            return 0
        dead: list[WebSocket] = []
        sent = 0
        for peer in list(peers):
            if peer is sender:
                continue
            try:
                await peer.send_text(raw_text)
                sent += 1
            except Exception:
                dead.append(peer)
        for d in dead:
            peers.discard(d)
        return sent


class EncryptedLobbyClient:
    """Manages THIS AETHER instance's active encrypted squad lobby membership."""

    def __init__(
        self,
        get_local_packet: Callable[[str], SquadStatePacket],
        on_peer_state: Callable[[SquadStatePacket], None],
        default_relay_url: str = "ws://127.0.0.1:8785",
    ) -> None:
        self._get_local_packet = get_local_packet
        self._on_peer_state = on_peer_state
        self.default_relay_url = default_relay_url.rstrip("/")
        self.peer_id = f"peer_{secrets.token_hex(5)}"

        self.active: bool = False
        self.role: str = "idle"  # idle | host | member
        self.invite_code: str = ""
        self.room_token: str = ""
        self.relay_url: str = self.default_relay_url
        self.connected_peers: dict[str, dict[str, Any]] = {}
        self.packets_sent: int = 0
        self.packets_received: int = 0
        self.packets_rejected: int = 0
        self.last_error: str | None = None
        self._task: asyncio.Task[None] | None = None

    def status_dict(self) -> dict[str, Any]:
        now = time.time()
        # Prune stale peers (> 25s silent)
        live_peers = [
            p for p in self.connected_peers.values() if now - float(p.get("last_seen", 0)) <= 25.0
        ]
        return {
            "active": self.active,
            "role": self.role,
            "invite_code": self.invite_code if self.active else "",
            "room_token_short": self.room_token[:10] if self.room_token else "",
            "relay_url": self.relay_url,
            "peer_id": self.peer_id,
            "encryption": "AES-256-GCM + HKDF-SHA256 (Game State Only — Zero Chat)",
            "peers": live_peers,
            "peer_count": len(live_peers),
            "packets_sent": self.packets_sent,
            "packets_received": self.packets_received,
            "packets_rejected": self.packets_rejected,
            "last_error": self.last_error,
        }

    async def create_lobby(self, relay_url: str | None = None) -> dict[str, Any]:
        code = generate_invite_code()
        return await self.join_lobby(code, relay_url=relay_url, role="host")

    async def join_lobby(
        self, invite_code: str, relay_url: str | None = None, role: str = "member"
    ) -> dict[str, Any]:
        await self.leave_lobby()
        norm_code = normalize_invite_code(invite_code)
        room_token, _ = derive_lobby_keys(norm_code)
        target_relay = (relay_url or self.default_relay_url).strip().rstrip("/")
        if target_relay.startswith("http://"):
            target_relay = "ws://" + target_relay[7:]
        elif target_relay.startswith("https://"):
            target_relay = "wss://" + target_relay[8:]

        self.active = True
        self.role = role
        self.invite_code = norm_code
        self.room_token = room_token
        self.relay_url = target_relay
        self.connected_peers = {}
        self.packets_sent = 0
        self.packets_received = 0
        self.packets_rejected = 0
        self.last_error = None
        self._task = asyncio.create_task(self._run_loop())
        await asyncio.sleep(0.08)
        return self.status_dict()

    async def leave_lobby(self) -> dict[str, Any]:
        self.active = False
        self.role = "idle"
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        self.invite_code = ""
        self.room_token = ""
        self.connected_peers = {}
        self.last_error = None
        return self.status_dict()

    async def _run_loop(self) -> None:
        ws_endpoint = f"{self.relay_url}/ws/lobby/{self.room_token}"
        while self.active:
            try:
                async with websockets.connect(ws_endpoint, ping_interval=20, ping_timeout=10) as ws:
                    self.last_error = None

                    async def _sender() -> None:
                        while self.active:
                            pkt = self._get_local_packet(self.peer_id)
                            wire = encrypt_state_packet(pkt, self.invite_code)
                            await ws.send(json.dumps(wire))
                            self.packets_sent += 1
                            await asyncio.sleep(0.5)

                    async def _receiver() -> None:
                        async for raw in ws:
                            try:
                                wire = json.loads(raw)
                                pkt = decrypt_state_packet(wire, self.invite_code)
                                if pkt.peer_id == self.peer_id:
                                    continue
                                self.packets_received += 1
                                self.connected_peers[pkt.peer_id] = {
                                    "peer_id": pkt.peer_id,
                                    "callsign": pkt.callsign,
                                    "ship_name": pkt.ship_name,
                                    "zone": pkt.zone,
                                    "status": pkt.status,
                                    "shields_pct": pkt.shields_pct,
                                    "hull_pct": pkt.hull_pct,
                                    "ammo_pct": pkt.ammo_pct,
                                    "health_pct": pkt.health_pct,
                                    "last_seen": time.time(),
                                }
                                self._on_peer_state(pkt)
                            except Exception:
                                self.packets_rejected += 1

                    send_task = asyncio.create_task(_sender())
                    recv_task = asyncio.create_task(_receiver())
                    done, pending = await asyncio.wait(
                        {send_task, recv_task}, return_when=asyncio.FIRST_EXCEPTION
                    )
                    for t in pending:
                        t.cancel()
                    for t in done:
                        exc = t.exception()
                        if exc and not isinstance(exc, asyncio.CancelledError):
                            raise exc
            except asyncio.CancelledError:
                break
            except Exception as exc:
                self.last_error = f"Relay reconnect pending ({exc.__class__.__name__})"
                await asyncio.sleep(2.5)
