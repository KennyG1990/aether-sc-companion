"""ElevenLabs Voice Engine (Own ElevenLabs Account OR Player2 Proxy) + Strict Player2 Heartbeat & Status."""

from __future__ import annotations

import random
import re
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
            age = str(labels.get("age", "") or "")
            desc = str(labels.get("description", "") or v.get("description", "") or "")
            use_case = str(labels.get("use_case", "") or "")
            category = str(v.get("category", "") or "")
            key = f"{name}|{accent}|{gender}".lower()
            name_counts[key] = name_counts.get(key, 0) + 1
            normalized.append(
                {
                    "voice_id": vid,
                    "name": name,
                    "accent": accent,
                    "gender": gender,
                    "age": age,
                    "description": desc,
                    "use_case": use_case,
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

    async def find_and_set_voice(
        self,
        query: str,
        tts_provider: str | None = None,
    ) -> tuple[bool, str, dict[str, Any]]:
        """Autonomously match & switch AETHER's active ElevenLabs / Player2 voice on the fly.

        Updates self.config.elevenlabs_voice_id immediately and saves to disk so the VERY NEXT
        spoken sentence plays in the newly chosen voice!
        """
        target_provider = (tts_provider or self.config.tts_provider).strip().lower()
        if target_provider == "elevenlabs_direct" and not self.config.elevenlabs_api_key:
            return (
                False,
                "Cannot switch to your direct ElevenLabs account because no ElevenLabs API key is configured yet. Staying on Player2 ElevenLabs.",
                {"provider": self.config.tts_provider},
            )
        if target_provider not in {"player2_elevenlabs", "elevenlabs_direct"}:
            target_provider = (
                "elevenlabs_direct"
                if (self.config.tts_provider == "elevenlabs_direct" and self.config.elevenlabs_api_key)
                else "player2_elevenlabs"
            )

        res = await self.list_voices(target_provider)
        voices = res.get("voices") or []
        if not voices:
            return False, f"No voices available from {target_provider}.", {"provider": target_provider}

        raw_q = (query or "").strip().lower()
        current_vid = self.config.elevenlabs_voice_id

        # Autonomous self-selection ("what do you want to sound like?" / "surprise me" / "pick your own")
        self_pick_triggers = {
            "choose",
            "choose_for_myself",
            "surprise",
            "random",
            "pick",
            "anything",
            "whatever",
            "your choice",
            "different",
            "new voice",
            "something else",
        }
        is_self_pick = (not raw_q) or any(tok in raw_q for tok in self_pick_triggers)

        if is_self_pick:
            candidates = [v for v in voices if v["voice_id"] != current_vid] or voices
            # Prefer expressive, distinct voices so the shift is immediately noticeable
            preferred = [
                v
                for v in candidates
                if (v.get("accent") or "").lower() in {"british", "american", "australian", "irish", "scottish"}
            ] or candidates
            chosen = random.choice(preferred[:24])
        else:
            # Expand natural-language synonyms for gender, accent, and vibe
            expanded = raw_q
            synonym_groups = [
                (r"\b(man|male|guy|boy|dude|gentleman|masculine|bro|mr)\b", " male "),
                (r"\b(woman|female|lady|girl|feminine|gal|ms|mrs|cortana|friday)\b", " female "),
                (r"\b(uk|english|london|posh|jarvis|oxford|cockney|brit)\b", " british "),
                (r"\b(us|usa|yank|american|states)\b", " american "),
                (r"\b(aussie|oz|australia|australian)\b", " australian "),
                (r"\b(scots|scotland|scottish)\b", " scottish "),
                (r"\b(ireland|irish)\b", " irish "),
                (r"\b(india|indian)\b", " indian "),
                (r"\b(france|french)\b", " french "),
                (r"\b(germany|german)\b", " german "),
                (r"\b(spain|spanish|latino|mexican)\b", " spanish "),
                (r"\b(italy|italian)\b", " italian "),
            ]
            for pat, repl in synonym_groups:
                if re.search(pat, expanded):
                    expanded += repl

            tokens = [t for t in re.findall(r"[a-z0-9]+", expanded) if len(t) >= 2]
            want_gender = "female" if "female" in tokens else ("male" if "male" in tokens else None)
            accent_vocab = {
                "british",
                "american",
                "australian",
                "scottish",
                "irish",
                "indian",
                "french",
                "german",
                "spanish",
                "italian",
                "african",
                "swedish",
                "transatlantic",
            }
            want_accents = {t for t in tokens if t in accent_vocab}

            scored: list[tuple[float, dict[str, Any]]] = []
            for v in voices:
                v_name = (v.get("name") or "").lower()
                v_accent = (v.get("accent") or "").lower()
                v_gender = (v.get("gender") or "").lower()
                v_age = (v.get("age") or "").lower()
                v_desc = (v.get("description") or "").lower()
                v_use = (v.get("use_case") or "").lower()
                v_disp = (v.get("display_name") or "").lower()
                blob = f"{v_name} {v_accent} {v_gender} {v_age} {v_desc} {v_use} {v_disp}"

                score = 0.0
                # Exact voice name match wins strongly
                if raw_q == v_name or (len(v_name) >= 3 and re.search(rf"\b{re.escape(v_name)}\b", raw_q)):
                    score += 25.0
                if want_gender:
                    if v_gender == want_gender:
                        score += 8.0
                    elif v_gender and v_gender != want_gender:
                        score -= 9.0
                if want_accents:
                    if any(a in v_accent or a in blob for a in want_accents):
                        score += 9.0
                    else:
                        score -= 3.5

                for tok in tokens:
                    if tok in {"voice", "sound", "like", "change", "switch", "use", "make", "give", "yourself", "your", "to", "a", "an", "the"}:
                        continue
                    if tok in v_name:
                        score += 5.0
                    elif tok in blob:
                        score += 2.5

                # Slightly prefer switching away from current voice if multiple tie
                if v["voice_id"] != current_vid:
                    score += 0.6

                scored.append((score, v))

            scored.sort(key=lambda item: item[0], reverse=True)
            top_score = scored[0][0]
            # Pick cleanly from top tied matches so repeated requests feel alive
            top_band = [v for sc, v in scored[:6] if sc >= top_score - 0.8]
            chosen = random.choice(top_band) if len(top_band) > 1 and top_score < 20.0 else scored[0][1]

        self.config.tts_provider = target_provider
        self.config.elevenlabs_voice_id = chosen["voice_id"]
        self.config.save_to_disk()

        label = chosen.get("display_name") or chosen.get("name") or chosen["voice_id"]
        accent_note = ""
        if not is_self_pick and want_accents:
            chosen_blob = f"{chosen.get('accent','')} {chosen.get('description','')} {chosen.get('display_name','')}".lower()
            if not any(a in chosen_blob for a in want_accents):
                accent_note = f" (closest match; requested accent not present in {target_provider} catalog)"
        detail = f"Voice switched to {label} via {target_provider}{accent_note}."
        return True, detail, {
            "voice_id": chosen["voice_id"],
            "name": chosen.get("name"),
            "display_name": label,
            "accent": chosen.get("accent"),
            "gender": chosen.get("gender"),
            "tts_provider": target_provider,
        }

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

    # --- Player2 Speech-to-Text (Whisper Audio Upload + Native OS Microphone) ---

    async def transcribe_audio(
        self, audio_bytes: bytes, filename: str = "speech.wav", content_type: str = "audio/wav"
    ) -> dict[str, Any]:
        """Transcribe recorded audio via Player2 local Whisper endpoint (/v1/stt/whisper/audio/transcriptions)."""
        if not audio_bytes or len(audio_bytes) < 400:
            return {"ok": True, "text": "", "provider": "player2_whisper"}

        base = self.config.player2_base_url.rstrip("/")
        try:
            async with httpx.AsyncClient(timeout=25.0) as client:
                resp = await client.post(
                    f"{base}/v1/stt/whisper/audio/transcriptions",
                    headers=self._p2_headers("voice-stt"),
                    files={"file": (filename, audio_bytes, content_type)},
                    data={"model": "whisper-1", "language": "en"},
                )
                if resp.status_code == 200:
                    data = resp.json()
                    return {"ok": True, "text": (data.get("text") or "").strip(), "provider": "player2_whisper"}
                return {
                    "ok": False,
                    "text": "",
                    "error": f"Player2 Whisper HTTP {resp.status_code}: {resp.text[:160]}",
                    "provider": "player2_whisper",
                }
        except Exception as exc:
            return {"ok": False, "text": "", "error": f"Player2 Whisper unreachable ({exc.__class__.__name__})"}

    async def start_native_stt(self, timeout_sec: float = 30.0, keyterms: list[str] | None = None) -> dict[str, Any]:
        """Start Player2 App's native OS microphone recording (works even if embedded browser blocks mic)."""
        base = self.config.player2_base_url.rstrip("/")
        terms = keyterms or [
            self.config.persona.ai_name,
            self.config.persona.pilot_name,
            "Stanton",
            "Crusader",
            "Hurston",
            "MicroTech",
            "ArcCorp",
            "Grim HEX",
            "Quantum",
            "Spotify",
        ]
        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                resp = await client.post(
                    f"{base}/v1/stt/start",
                    headers={"Content-Type": "application/json", **self._p2_headers("voice-stt")},
                    json={"timeout": float(max(3.0, min(60.0, timeout_sec))), "keyterms": [t for t in terms if t][:40]},
                )
                if resp.status_code == 200:
                    data = resp.json() if resp.content else {}
                    if isinstance(data, dict) and data.get("message"):
                        return {"ok": False, "error": data["message"]}
                    return {"ok": True, "provider": "player2_native_mic"}
                return {"ok": False, "error": f"Player2 native STT HTTP {resp.status_code}: {resp.text[:160]}"}
        except Exception as exc:
            return {"ok": False, "error": f"Player2 native STT unreachable ({exc.__class__.__name__})"}

    async def stop_native_stt(self) -> dict[str, Any]:
        """Stop Player2 App's native OS microphone recording and collect recognized text."""
        base = self.config.player2_base_url.rstrip("/")
        try:
            async with httpx.AsyncClient(timeout=20.0) as client:
                resp = await client.post(
                    f"{base}/v1/stt/stop",
                    headers=self._p2_headers("voice-stt"),
                )
                if resp.status_code == 200:
                    data = resp.json() if resp.content else {}
                    if isinstance(data, dict) and data.get("message") and not data.get("text"):
                        return {"ok": False, "text": "", "error": data["message"]}
                    return {"ok": True, "text": (data.get("text") or "").strip(), "provider": "player2_native_mic"}
                return {"ok": False, "text": "", "error": f"Player2 native STT stop HTTP {resp.status_code}"}
        except Exception as exc:
            return {"ok": False, "text": "", "error": f"Player2 native STT stop error ({exc.__class__.__name__})"}

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
