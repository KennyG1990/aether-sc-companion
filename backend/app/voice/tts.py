"""ElevenLabs Text-to-Speech via Player2 Local API (127.0.0.1:4315) or Direct ElevenLabs API."""

from __future__ import annotations

from typing import Any

import httpx

from ..config import AetherConfig


class VoiceEngine:
    """Synthesizes speech using Player2's ElevenLabs endpoint or direct ElevenLabs API."""

    def __init__(self, config: AetherConfig) -> None:
        self.config = config
        self._cached_voices: list[dict[str, Any]] = []

    async def list_voices(self) -> list[dict[str, Any]]:
        base = self.config.player2_base_url.rstrip("/")
        try:
            async with httpx.AsyncClient(timeout=6.0) as client:
                resp = await client.get(
                    f"{base}/v1/tts/eleven/voices",
                    headers={"player2-game-key": self.config.player2_game_key},
                )
                resp.raise_for_status()
                raw_voices = resp.json().get("voices", [])
                normalized = []
                seen_ids: set[str] = set()
                for v in raw_voices:
                    vid = v.get("voice_id")
                    if not vid or vid in seen_ids:
                        continue
                    seen_ids.add(vid)
                    labels = v.get("labels") or {}
                    normalized.append(
                        {
                            "voice_id": vid,
                            "name": v.get("name", "Unknown"),
                            "accent": labels.get("accent", ""),
                            "gender": labels.get("gender", ""),
                            "category": v.get("category", ""),
                        }
                    )
                # Float British male voices (Jarvis style) to the top for convenience
                normalized.sort(
                    key=lambda x: (
                        0 if (x["accent"] == "british" and x["gender"] == "male") else 1,
                        0 if x["accent"] == "british" else 1,
                        x["name"],
                    )
                )
                self._cached_voices = normalized
                return normalized
        except Exception:
            return self._cached_voices or [
                {
                    "voice_id": self.config.elevenlabs_voice_id,
                    "name": "Harry (British Male)",
                    "accent": "british",
                    "gender": "male",
                    "category": "premade",
                }
            ]

    async def synthesize_mp3(self, text: str, voice_id: str | None = None) -> tuple[bytes | None, str]:
        """Return (mp3_bytes, provider_used). Returns (None, reason) if unavailable."""
        cleaned = text.strip()
        if not cleaned:
            return None, "empty"

        provider = self.config.tts_provider.lower()
        vid = voice_id or self.config.elevenlabs_voice_id

        if provider == "browser":
            return None, "browser_selected"

        if provider == "elevenlabs_direct" and self.config.elevenlabs_api_key:
            url = f"https://api.elevenlabs.io/v1/text-to-speech/{vid}"
            headers = {
                "Content-Type": "application/json",
                "Accept": "audio/mpeg",
                "xi-api-key": self.config.elevenlabs_api_key,
            }
            body = {
                "text": cleaned,
                "model_id": self.config.elevenlabs_model_id,
                "voice_settings": {"stability": 0.55, "similarity_boost": 0.78, "style": 0.25},
            }
            try:
                async with httpx.AsyncClient(timeout=25.0) as client:
                    resp = await client.post(url, headers=headers, json=body)
                    resp.raise_for_status()
                    return resp.content, "elevenlabs_direct"
            except Exception as exc:
                return None, f"elevenlabs_direct_error:{exc.__class__.__name__}"

        # Default: Player2 local ElevenLabs TTS endpoint
        base = self.config.player2_base_url.rstrip("/")
        url = f"{base}/v1/tts/eleven/text-to-speech/{vid}"
        headers = {
            "Content-Type": "application/json",
            "player2-game-key": self.config.player2_game_key,
        }
        body = {
            "text": cleaned,
            "model_id": self.config.elevenlabs_model_id,
            "voice_settings": {
                "stability": 0.55,
                "similarity_boost": 0.78,
                "speed": 1.04,
            },
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
        """Check live Player2 local API (4315) and local MCP server (9847)."""
        base = self.config.player2_base_url.rstrip("/")
        status: dict[str, Any] = {
            "api_online": False,
            "client_version": None,
            "joules": None,
            "patron_tier": None,
            "elevenlabs_voices_count": 0,
            "mcp_online": False,
            "mcp_server": None,
        }
        async with httpx.AsyncClient(timeout=3.5) as client:
            try:
                r_health = await client.get(f"{base}/v1/health")
                if r_health.status_code == 200:
                    status["api_online"] = True
                    status["client_version"] = r_health.json().get("client_version")
            except Exception:
                pass

            if status["api_online"]:
                try:
                    r_j = await client.get(f"{base}/v1/joules")
                    if r_j.status_code == 200:
                        jd = r_j.json()
                        status["joules"] = jd.get("joules")
                        status["patron_tier"] = jd.get("patron_tier")
                except Exception:
                    pass
                try:
                    voices = await self.list_voices()
                    status["elevenlabs_voices_count"] = len(voices)
                except Exception:
                    pass

            # Probe Player2 local MCP server
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
                            "clientInfo": {"name": "aether", "version": "0.1.0"},
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
