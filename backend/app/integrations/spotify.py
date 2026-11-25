"""AETHER Spotify Connector — Dual-Mode (Official Spotify Web API OAuth PKCE + Zero-Setup Windows Launcher).

- Mode 1 (Full Auto-Play): User connects their free Spotify Developer Client ID via OAuth 2.0 PKCE
  (no client secret needed). AETHER searches tracks/playlists/albums via Spotify Web API, auto-launches
  local Spotify Desktop if no Connect device is active, and starts playing the exact song immediately,
  plus pause/resume/skip/volume/now-playing.
- Mode 2 (Zero-Setup Fallback): Works immediately without API setup by launching Spotify Desktop on
  Windows via native `spotify:` URI protocol (`spotify:search:<query>`) and Windows media hotkeys.
"""

from __future__ import annotations

import asyncio
import base64
import ctypes
import hashlib
import os
import secrets
import sys
import time
from typing import Any
from urllib.parse import quote, urlencode

import httpx

from ..config import AetherConfig

SPOTIFY_SCOPES = "user-modify-playback-state user-read-playback-state user-read-currently-playing"

# Windows Virtual-Key Codes for media transport fallback
_VK_MEDIA_NEXT_TRACK = 0xB0
_VK_MEDIA_PREV_TRACK = 0xB1
_VK_MEDIA_PLAY_PAUSE = 0xB3
_KEYEVENTF_KEYUP = 0x0002


class SpotifyConnector:
    """Handles Spotify OAuth 2.0 PKCE, Web API playback, and Windows local Spotify launching."""

    def __init__(self, config: AetherConfig) -> None:
        self.config = config
        self._pending_verifiers: dict[str, str] = {}

    @property
    def is_oauth_connected(self) -> bool:
        return bool(self.config.spotify_client_id and (self.config.spotify_access_token or self.config.spotify_refresh_token))

    def status_dict(self) -> dict[str, Any]:
        return {
            "mode": "spotify_web_api" if self.is_oauth_connected else "local_launcher",
            "oauth_connected": self.is_oauth_connected,
            "client_id_set": bool(self.config.spotify_client_id),
            "redirect_uri": self.config.spotify_redirect_uri,
            "platform": sys.platform,
        }

    # --- OAuth 2.0 PKCE Flow ---

    def build_auth_url(self) -> dict[str, Any]:
        if not self.config.spotify_client_id.strip():
            return {
                "ok": False,
                "error": "Enter your Spotify Client ID in Config first (free at developer.spotify.com/dashboard).",
                "redirect_uri": self.config.spotify_redirect_uri,
            }

        state = secrets.token_urlsafe(16)
        verifier = secrets.token_urlsafe(48)
        challenge = (
            base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest())
            .decode("ascii")
            .rstrip("=")
        )
        self._pending_verifiers[state] = verifier

        params = {
            "response_type": "code",
            "client_id": self.config.spotify_client_id.strip(),
            "scope": SPOTIFY_SCOPES,
            "redirect_uri": self.config.spotify_redirect_uri,
            "state": state,
            "code_challenge_method": "S256",
            "code_challenge": challenge,
        }
        return {
            "ok": True,
            "auth_url": f"https://accounts.spotify.com/authorize?{urlencode(params)}",
            "redirect_uri": self.config.spotify_redirect_uri,
        }

    async def exchange_code(self, code: str, state: str) -> tuple[bool, str]:
        verifier = self._pending_verifiers.pop(state, None)
        if not verifier:
            return False, "Invalid or expired OAuth state parameter. Try connecting Spotify again."

        try:
            async with httpx.AsyncClient(timeout=12.0) as client:
                resp = await client.post(
                    "https://accounts.spotify.com/api/token",
                    data={
                        "grant_type": "authorization_code",
                        "code": code,
                        "redirect_uri": self.config.spotify_redirect_uri,
                        "client_id": self.config.spotify_client_id.strip(),
                        "code_verifier": verifier,
                    },
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                )
                resp.raise_for_status()
                tok = resp.json()
                self.config.spotify_access_token = tok["access_token"]
                if tok.get("refresh_token"):
                    self.config.spotify_refresh_token = tok["refresh_token"]
                self.config.spotify_token_expires_at = time.time() + float(tok.get("expires_in", 3600)) - 60.0
                self.config.save_to_disk()
                return True, "Spotify Web API connected via OAuth 2.0 PKCE!"
        except Exception as exc:
            return False, f"Spotify token exchange failed: {exc}"

    def disconnect(self) -> None:
        self.config.spotify_access_token = ""
        self.config.spotify_refresh_token = ""
        self.config.spotify_token_expires_at = 0.0
        self.config.save_to_disk()

    async def _ensure_access_token(self) -> str | None:
        if not self.is_oauth_connected:
            return None
        if self.config.spotify_access_token and time.time() < self.config.spotify_token_expires_at:
            return self.config.spotify_access_token
        if not self.config.spotify_refresh_token:
            return self.config.spotify_access_token or None

        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(
                    "https://accounts.spotify.com/api/token",
                    data={
                        "grant_type": "refresh_token",
                        "refresh_token": self.config.spotify_refresh_token,
                        "client_id": self.config.spotify_client_id.strip(),
                    },
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                )
                resp.raise_for_status()
                tok = resp.json()
                self.config.spotify_access_token = tok["access_token"]
                if tok.get("refresh_token"):
                    self.config.spotify_refresh_token = tok["refresh_token"]
                self.config.spotify_token_expires_at = time.time() + float(tok.get("expires_in", 3600)) - 60.0
                self.config.save_to_disk()
                return self.config.spotify_access_token
        except Exception:
            return None

    # --- Local OS Launch & Media Keys ---

    @staticmethod
    def launch_local_uri(uri: str = "spotify:") -> tuple[bool, str]:
        """Launch Spotify Desktop on Windows via native spotify: URI protocol."""
        try:
            if sys.platform == "win32" and hasattr(os, "startfile"):
                os.startfile(uri)  # type: ignore[attr-defined]
                return True, f"Launched local Spotify URI ({uri})."
            return False, f"Local URI launch is currently configured for Windows (platform={sys.platform})."
        except OSError as exc:
            return False, f"Could not launch local Spotify app ({exc}). Is Spotify Desktop installed?"

    @staticmethod
    def _send_windows_media_key(vk_code: int) -> bool:
        if sys.platform != "win32":
            return False
        try:
            user32 = ctypes.windll.user32
            user32.keybd_event(vk_code, 0, 0, 0)
            user32.keybd_event(vk_code, 0, _KEYEVENTF_KEYUP, 0)
            return True
        except Exception:
            return False

    # --- High-Level Commands ---

    async def execute_command(
        self,
        command: str,
        query: str = "",
        media_type: str = "track",
        volume_pct: int | None = None,
        dry_run: bool = False,
    ) -> tuple[bool, str, dict[str, Any]]:
        cmd = command.strip().lower()
        meta: dict[str, Any] = {"command": cmd, "query": query, "mode": "local_launcher"}

        if cmd == "launch":
            if dry_run:
                return True, "Dry-run: would launch local Spotify Desktop app.", meta
            ok, detail = self.launch_local_uri("spotify:")
            return ok, detail, meta

        token = await self._ensure_access_token()
        if token:
            meta["mode"] = "spotify_web_api"
            return await self._execute_web_api(token, cmd, query, media_type, volume_pct, meta, dry_run=dry_run)

        # Zero-Setup Local Windows Launcher Fallback
        if cmd == "play":
            clean_q = query.strip()
            if not clean_q:
                if dry_run:
                    return True, "Dry-run: would resume playback via Windows media key.", meta
                ok = self._send_windows_media_key(_VK_MEDIA_PLAY_PAUSE)
                return ok, "Toggled Spotify playback via Windows media controls.", meta

            uri = clean_q if clean_q.startswith("spotify:") else f"spotify:search:{quote(clean_q)}"
            meta["uri"] = uri
            if dry_run:
                return (
                    True,
                    f"Dry-run: would launch Spotify Desktop with {uri} (connect Spotify OAuth in Config for instant auto-play).",
                    meta,
                )
            ok, launch_msg = self.launch_local_uri(uri)
            if ok:
                return (
                    True,
                    f"Fired up Spotify for '{clean_q}'. (Connect your Spotify Client ID in Config for 1-click instant auto-play without clicking play.)",
                    meta,
                )
            return False, launch_msg, meta

        if cmd in ("pause", "resume", "play_pause"):
            if dry_run:
                return True, f"Dry-run: would send Windows media play/pause key for '{cmd}'.", meta
            ok = self._send_windows_media_key(_VK_MEDIA_PLAY_PAUSE)
            return ok, f"Sent media {cmd} signal to Spotify.", meta

        if cmd == "next":
            if dry_run:
                return True, "Dry-run: would skip to next track via Windows media key.", meta
            ok = self._send_windows_media_key(_VK_MEDIA_NEXT_TRACK)
            return ok, "Skipped to next track.", meta

        if cmd == "previous":
            if dry_run:
                return True, "Dry-run: would jump to previous track via Windows media key.", meta
            ok = self._send_windows_media_key(_VK_MEDIA_PREV_TRACK)
            return ok, "Returned to previous track.", meta

        if cmd == "volume":
            return (
                False,
                "Exact volume control requires Spotify Web API OAuth. Connect your Spotify Client ID in the Config tab.",
                meta,
            )

        if cmd == "now_playing":
            return (
                False,
                "Now-playing readout requires Spotify Web API OAuth. Connect your Spotify Client ID in the Config tab.",
                meta,
            )

        return False, f"Unknown Spotify command '{cmd}'.", meta

    async def _execute_web_api(
        self,
        token: str,
        cmd: str,
        query: str,
        media_type: str,
        volume_pct: int | None,
        meta: dict[str, Any],
        dry_run: bool = False,
    ) -> tuple[bool, str, dict[str, Any]]:
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

        async with httpx.AsyncClient(timeout=12.0) as client:
            if cmd == "now_playing":
                r = await client.get("https://api.spotify.com/v1/me/player/currently-playing", headers=headers)
                if r.status_code == 204:
                    return True, "Nothing is currently playing on Spotify.", meta
                r.raise_for_status()
                item = r.json().get("item") or {}
                title = item.get("name", "Unknown track")
                artists = ", ".join(a.get("name", "") for a in item.get("artists", []))
                meta["track"] = title
                meta["artists"] = artists
                return True, f"Currently playing '{title}' by {artists} on Spotify.", meta

            if cmd == "pause":
                if dry_run:
                    return True, "Dry-run: would pause Spotify Web API playback.", meta
                r = await client.put("https://api.spotify.com/v1/me/player/pause", headers=headers)
                return r.status_code in (200, 204), "Paused Spotify playback." if r.status_code in (200, 204) else f"Spotify pause error ({r.status_code})", meta

            if cmd == "resume":
                if dry_run:
                    return True, "Dry-run: would resume Spotify Web API playback.", meta
                r = await client.put("https://api.spotify.com/v1/me/player/play", headers=headers)
                return r.status_code in (200, 204), "Resumed Spotify playback." if r.status_code in (200, 204) else f"Spotify resume error ({r.status_code})", meta

            if cmd == "next":
                if dry_run:
                    return True, "Dry-run: would skip Spotify track.", meta
                r = await client.post("https://api.spotify.com/v1/me/player/next", headers=headers)
                return r.status_code in (200, 204), "Skipped to next track on Spotify." if r.status_code in (200, 204) else f"Spotify next error ({r.status_code})", meta

            if cmd == "previous":
                if dry_run:
                    return True, "Dry-run: would return to previous Spotify track.", meta
                r = await client.post("https://api.spotify.com/v1/me/player/previous", headers=headers)
                return r.status_code in (200, 204), "Returned to previous track on Spotify." if r.status_code in (200, 204) else f"Spotify previous error ({r.status_code})", meta

            if cmd == "volume":
                pct = max(0, min(100, int(volume_pct if volume_pct is not None else 50)))
                meta["volume_pct"] = pct
                if dry_run:
                    return True, f"Dry-run: would set Spotify volume to {pct}%.", meta
                r = await client.put(
                    "https://api.spotify.com/v1/me/player/volume",
                    params={"volume_percent": pct},
                    headers=headers,
                )
                return r.status_code in (200, 204), f"Set Spotify volume to {pct}%." if r.status_code in (200, 204) else f"Spotify volume error ({r.status_code})", meta

            if cmd == "play":
                mtype = media_type if media_type in ("track", "playlist", "album", "artist") else "track"
                if not query.strip():
                    if dry_run:
                        return True, "Dry-run: would resume Spotify playback.", meta
                    r = await client.put("https://api.spotify.com/v1/me/player/play", headers=headers)
                    return r.status_code in (200, 204), "Resumed Spotify playback.", meta

                # 1. Search Spotify catalog
                sr = await client.get(
                    "https://api.spotify.com/v1/search",
                    params={"q": query.strip(), "type": mtype, "limit": 1},
                    headers=headers,
                )
                sr.raise_for_status()
                items = sr.json().get(f"{mtype}s", {}).get("items", [])
                if not items:
                    return False, f"No Spotify {mtype} found matching '{query}'.", meta

                match = items[0]
                uri = match["uri"]
                title = match.get("name", query)
                artist = ", ".join(a.get("name", "") for a in match.get("artists", [])) if match.get("artists") else ""
                label = f"'{title}' by {artist}" if artist else f"'{title}'"
                meta.update({"uri": uri, "title": title, "artist": artist})

                if dry_run:
                    return True, f"Dry-run: found {label} ({uri}).", meta

                # 2. Ensure active playback device; if none, auto-launch local Spotify Desktop and wait briefly
                dev_id = await self._find_or_launch_device(client, headers)
                play_body = {"uris": [uri]} if mtype == "track" else {"context_uri": uri}
                params = {"device_id": dev_id} if dev_id else {}
                pr = await client.put(
                    "https://api.spotify.com/v1/me/player/play",
                    params=params,
                    headers=headers,
                    json=play_body,
                )
                if pr.status_code in (200, 204):
                    return True, f"Now playing {label} on Spotify.", meta
                if pr.status_code == 403:
                    # Spotify Free tier restricts remote Web API play -> gracefully open URI directly in Desktop app!
                    self.launch_local_uri(uri)
                    return True, f"Opened {label} directly in Spotify Desktop (Spotify Premium is required for remote API auto-play).", meta
                return False, f"Spotify playback failed (HTTP {pr.status_code}). Open Spotify Desktop and try again.", meta

        return False, f"Unsupported Spotify command '{cmd}'.", meta

    async def _find_or_launch_device(self, client: httpx.AsyncClient, headers: dict[str, str]) -> str | None:
        async def get_device() -> str | None:
            r = await client.get("https://api.spotify.com/v1/me/player/devices", headers=headers)
            if r.status_code != 200:
                return None
            devices = r.json().get("devices", [])
            if not devices:
                return None
            active = next((d for d in devices if d.get("is_active")), None)
            return (active or devices[0]).get("id")

        dev = await get_device()
        if dev:
            return dev

        # No active Spotify device -> auto-launch local Spotify Desktop and poll briefly!
        self.launch_local_uri("spotify:")
        for _ in range(4):
            await asyncio.sleep(1.2)
            dev = await get_device()
            if dev:
                return dev
        return None
