"""ElevenLabs Voice Engine (Own ElevenLabs Account OR Player2 Proxy) + Strict Player2 Heartbeat & Status."""

from __future__ import annotations

import time
from typing import Any

import httpx

from ..config import AetherConfig


class VoiceEngine:
    """Manages ElevenLabs TTS (Direct Own Account OR Player2 Proxy) and Player2 API/Heartbeat probes."""

    def __init__(self, config: AetherConfig) -> None:
        self.config = config
        self._cached_p2_voices: list[dict[str, Any]] = []
        self._cached_direct_voices: list[dict[str, Any]] = []
        self.heartbeat_state: dict[str, Any] = {
            "count": 0,
            "last_ok": False,
            "last_at": None,
            "client_version": None,
            "mod_id": config.player2_game_key,
            "interval_sec": 60,
            "last_error": None,
        }

    def _p2_headers(self, resource: str | None = None) -> dict[str, str]:
        headers = {"player2-game-key": self.config.player2_game_key}
        if resource:
            headers["player2-resource"] = resource
        return headers

    async def send_player2_heartbeat(self) -> dict[str, Any]:
        """Official Player2 60s heartbeat: GET /v1/health with player2-game-key header."""
        base = self.config.player2_base_url.rstrip("/")
        now = time.time()
        self.heartbeat_state["mod_id"] = self.config.player2_game_key
        try:
            async with httpx.AsyncClient(timeout=4.0) as client:
                resp = await client.get(f"{base}/v1/health", headers=self._p2_headers())
                if resp.status_code == 200:
                    ver = resp.json().get("client_version")
                    self.heartbeat_state["count"] += 1
                    self.heartbeat_state["last_ok"] = True
                    self.heartbeat_state["last_at"] = now
                    self.heartbeat_state["client_version"] = ver
                    self.heartbeat_state["last_error"] = None
                else:
                    self.heartbeat_state["last_ok"] = False
                    self.heartbeat_state["last_at"] = now
                    self.heartbeat_state["last_error"] = f"HTTP {resp.status_code}"
        except Exception as exc:
            self.heartbeat_state["last_ok"] = False
            self.heartbeat_state["last_at"] = now
            self.heartbeat_state["last_error"] = exc.__class__.__name__
        return dict(self.heartbeat_state)

    async def list_voices(self, provider_override: str | None = None) -> dict[str, Any]:
        """Fetch live voices from either Own ElevenLabs Account or Player2 ElevenLabs Proxy."""
        provider = (provider_override or self.config.tts_provider).lower()

        if provider == "elevenlabs_direct":
            if not self.config.elevenlabs_api_key:
                return {
                    "provider": "elevenlabs_direct",
                    "account_connected": False,
                    "voices": self._cached_direct_voices,
                    "note": "Enter your ElevenLabs xi-api-key in Config to load your account voices.",
                }
            try:
                async with httpx.AsyncClient(timeout=8.0) as client:
                    resp = await client.get(
                        "https://api.elevenlabs.io/v1/voices",
                        headers={"xi-api-key": self.config.elevenlabs_api_key},
                    )
                    resp.raise_for_status()
                    raw = resp.json().get("voices", [])
                    voices = self._normalize_voices(raw)
                    self._cached_direct_voices = voices
                    return {
                        "provider": "elevenlabs_direct",
                        "account_connected": True,
                        "voices": voices,
                    }
            except Exception as exc:
                return {
                    "provider": "elevenlabs_direct",
                    "account_connected": False,
                    "voices": self._cached_direct_voices,
                    "note": f"Could not reach ElevenLabs API ({exc.__class__.__name__}). Check your API key.",
                }

        # Player2 ElevenLabs compatibility endpoint
        base = self.config.player2_base_url.rstrip("/")
        try:
            async with httpx.AsyncClient(timeout=6.0) as client:
                resp = await client.get(
                    f"{base}/v1/tts/eleven/voices",
                    headers=self._p2_headers("voice-tts"),
                )
                resp.raise_for_status()
                raw = resp.json().get("voices", [])
                voices = self._normalize_voices(raw)
                self._cached_p2_voices = voices
                return {
                    "provider": "player2_elevenlabs",
                    "account_connected": True,
                    "voices": voices,
                }
        except Exception:
            fallback = self._cached_p2_voices or [
                {
                    "voice_id": self.config.elevenlabs_voice_id,
                    "name": "Harry",
                    "display_name": "Harry (british male)",
                    "accent": "british",
                    "gender": "male",
                    "category": "premade",
                }
            ]
            return {
                "provider": provider,
                "account_connected": False,
                "voices": fallback,
            }

    @staticmethod
    def _normalize_voices(raw_voices: list[dict[str, Any]]) -> list[dict[str, Any]]:
        normalized: list[dict[str, Any]] = []
        seen_ids: set[str] = set()
        name_counts: dict[str, int] = {}

        for v in raw_voices:
            vid = v.get("voice_id")
            if not vid or vid in seen_ids:
                continue
            seen_ids.add(vid)
            labels = v.get("labels") or {}
            name = v.get("name", "Unknown")
            accent = str(labels.get("accent", "") or "")
            gender = str(labels.get("gender", "") or "")
            category = str(v.get("category", "") or "")
            key = f"{name}|{accent}|{gender}".lower()
            name_counts[key] = name_counts.get(key, 0) + 1
            normalized.append(
                {
                    "voice_id": vid,
                    "name": name,
                    "accent": accent,
                    "gender": gender,
                    "category": category,
                    "_dup_key": key,
                }
            )

        # Disambiguate identical display names cleanly with short voice ID tag
        for item in normalized:
            tag = f"{item['accent']} {item['gender']}".strip()
            base_label = f"{item['name']} ({tag})" if tag else item["name"]
            if item["category"] in ("cloned", "generated"):
                base_label = f"★ {base_label} [{item['category']}]"
            if name_counts.get(item["_dup_key"], 0) > 1:
                base_label = f"{base_label} · {item['voice_id'][:6]}"
            item["display_name"] = base_label
            del item["_dup_key"]

        # Float custom/cloned voices first, then British Jarvis-style voices
        normalized.sort(
            key=lambda x: (
                0 if x["category"] in ("cloned", "generated") else 1,
                0 if (x["accent"] == "british" and x["gender"] == "male") else 1,
                0 if x["accent"] == "british" else 1,
                x["name"],
            )
        )
        return normalized

    async def synthesize_mp3(self, text: str, voice_id: str | None = None) -> tuple[bytes | None, str]:
        """Return (mp3_bytes, provider_used). Returns (None, reason) if unavailable."""
        cleaned = text.strip()
        if not cleaned:
            return None, "empty"

        provider = self.config.tts_provider.lower()
        vid = voice_id or self.config.elevenlabs_voice_id

        if provider == "browser":
            return None, "browser_selected"

        if provider == "elevenlabs_direct":
            if not self.config.elevenlabs_api_key:
                return None, "elevenlabs_direct_missing_key"
            url = f"https://api.elevenlabs.io/v1/text-to-speech/{vid}"
            headers = {
                "Content-Type": "application/json",
                "Accept": "audio/mpeg",
                "xi-api-key": self.config.elevenlabs_api_key,
            }
            body = {
                "text": cleaned,
                "model_id": self.config.elevenlabs_model_id,
                "voice_settings": {"stability": 0.52, "similarity_boost": 0.78, "style": 0.25},
            }
            try:
                async with httpx.AsyncClient(timeout=25.0) as client:
                    resp = await client.post(url, headers=headers, json=body)
                    resp.raise_for_status()
                    return resp.content, "elevenlabs_direct"
            except Exception as exc:
                return None, f"elevenlabs_direct_error:{exc.__class__.__name__}"

        # Player2 local ElevenLabs TTS endpoint (strict player2-game-key + player2-resource)
        base = self.config.player2_base_url.rstrip("/")
        url = f"{base}/v1/tts/eleven/text-to-speech/{vid}"
        headers = {
            "Content-Type": "application/json",
            **self._p2_headers("voice-tts"),
        }
        body = {
            "text": cleaned,
            "model_id": self.config.elevenlabs_model_id,
            "voice_settings": {"stability": 0.55, "similarity_boost": 0.78, "speed": 1.04},
        }
        try:
            async with httpx.AsyncClient(timeout=25.0) as client:
                resp = await client.post(url, headers=headers, json=body)
                resp.raise_for_status()
                if resp.content:
                    return resp.content, "player2_elevenlabs"
                return None, "player2_elevenlabs_empty"
        except Exception as exc:
            return None, f"player2_elevenlabs_error:{exc.__class__.__name__}"

    async def probe_player2(self) -> dict[str, Any]:
        """Check live Player2 local API, heartbeat state, Joules, ElevenLabs voices, and MCP server."""
        base = self.config.player2_base_url.rstrip("/")
        hb = await self.send_player2_heartbeat()
        status: dict[str, Any] = {
            "api_online": bool(hb["last_ok"]),
            "base_url": base,
            "mod_id": self.config.player2_game_key,
            "client_version": hb["client_version"],
            "heartbeat": hb,
            "joules": None,
            "patron_tier": None,
            "elevenlabs_voices_count": 0,
            "mcp_online": False,
            "mcp_server": None,
        }
        async with httpx.AsyncClient(timeout=4.0) as client:
            if status["api_online"]:
                try:
                    r_j = await client.get(f"{base}/v1/joules", headers=self._p2_headers())
                    if r_j.status_code == 200:
                        jd = r_j.json()
                        status["joules"] = jd.get("joules")
                        status["patron_tier"] = jd.get("patron_tier")
                except Exception:
                    pass
                try:
                    v_res = await self.list_voices("player2_elevenlabs")
                    status["elevenlabs_voices_count"] = len(v_res.get("voices", []))
                except Exception:
                    pass

            try:
                r_mcp = await client.post(
                    self.config.player2_mcp_url,
                    headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream"},
                    json={
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "initialize",
                        "params": {
                            "protocolVersion": "2025-03-26",
                            "capabilities": {},
                            "clientInfo": {"name": "aether", "version": "0.3.0"},
                        },
                    },
                )
                if r_mcp.status_code == 200:
                    info = r_mcp.json().get("result", {}).get("serverInfo", {})
                    status["mcp_online"] = True
                    status["mcp_server"] = f"{info.get('name', 'player2')} v{info.get('version', '?')}"
            except Exception:
                pass

        return status
