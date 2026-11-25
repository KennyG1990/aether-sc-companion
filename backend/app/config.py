"""Runtime configuration & persistent local settings for AETHER backend."""

from __future__ import annotations

import json
import os
from pathlib import Path
from pydantic import BaseModel, Field


BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)
SETTINGS_FILE = DATA_DIR / "aether_settings.json"

DEFAULT_PLAYER2_MOD_ID = "01a21115-8912-7b68-a847-f7b8e80a6afc"


def discover_player2_base_url() -> str:
    """Follow official Player2 spec: read %APPDATA%/game.player2.client/api.port on Windows, fallback 4315.

    Always uses 127.0.0.1 (never localhost) to avoid IPv6 conflicts.
    """
    env_override = os.getenv("PLAYER2_BASE_URL")
    if env_override:
        return env_override.rstrip("/")

    appdata = os.getenv("APPDATA")
    candidates = []
    if appdata:
        candidates.append(Path(appdata) / "game.player2.client" / "api.port")
    candidates.append(Path.home() / ".config" / "game.player2.client" / "api.port")
    candidates.append(Path.home() / "Library" / "Application Support" / "game.player2.client" / "api.port")

    for port_file in candidates:
        try:
            if port_file.is_file():
                port_str = port_file.read_text(encoding="utf-8").strip()
                if port_str.isdigit():
                    return f"http://127.0.0.1:{port_str}"
        except OSError:
            pass
    return "http://127.0.0.1:4315"


class PersonaProfile(BaseModel):
    ai_name: str = "Aether"
    pilot_name: str = "Commander"
    tone: str = "Sharp, loyal, calm tactical presence with dry British wit"
    verbosity: str = "Concise 1-2 sentence spoken responses unless detailed briefing requested"
    question_style: str = "Ask direct clarifying questions only when needed or before risky commands"
    humor_style: str = "Dry, understated spacer humor and occasional ship banter"
    custom_rules: str = "Monitor shields, hydrogen fuel, and allied fleet status proactively."
    persona_summary: str = (
        "A loyal, Jarvis/Cortana-inspired holographic flight AI with dry wit, razor-sharp tactical awareness, "
        "and concise voice cadence."
    )
    calibrated: bool = False


class AetherConfig(BaseModel):
    llm_provider: str = Field(
        default=os.getenv("AETHER_LLM_PROVIDER", "player2"),
        description="Active LLM backend: 'player2', 'openrouter', or 'demo'.",
    )
    player2_base_url: str = Field(default_factory=discover_player2_base_url)
    player2_mcp_url: str = Field(default=os.getenv("PLAYER2_MCP_URL", "http://127.0.0.1:9847/mcp"))
    player2_game_key: str = Field(
        default=os.getenv("PLAYER2_GAME_KEY", DEFAULT_PLAYER2_MOD_ID),
        description="Official Player2 Mod / Game Client ID sent in player2-game-key header + 60s heartbeat.",
    )
    player2_model: str = Field(
        default=os.getenv("PLAYER2_MODEL", ""),
        description="Optional model id from /v1/catalog/models?kind=llm sent via player2-suggested-model.",
    )
    openrouter_api_key: str = Field(default=os.getenv("OPENROUTER_API_KEY", ""))
    openrouter_model: str = Field(
        default=os.getenv("OPENROUTER_MODEL", "anthropic/claude-3.7-sonnet"),
    )
    tts_provider: str = Field(
        default=os.getenv("AETHER_TTS_PROVIDER", "player2_elevenlabs"),
        description="'elevenlabs_direct' (own ElevenLabs account), 'player2_elevenlabs', or 'browser'.",
    )
    elevenlabs_voice_id: str = Field(
        default=os.getenv("ELEVENLABS_VOICE_ID", "01955d76-ed5b-754f-a070-a570ddfed516"),
    )
    elevenlabs_model_id: str = Field(
        default=os.getenv("ELEVENLABS_MODEL_ID", "eleven_multilingual_v2"),
    )
    elevenlabs_api_key: str = Field(default=os.getenv("ELEVENLABS_API_KEY", ""))
    spotify_client_id: str = Field(default=os.getenv("SPOTIFY_CLIENT_ID", ""))
    spotify_redirect_uri: str = Field(
        default=os.getenv("SPOTIFY_REDIRECT_URI", "http://127.0.0.1:8785/api/spotify/callback")
    )
    spotify_access_token: str = ""
    spotify_refresh_token: str = ""
    spotify_token_expires_at: float = 0.0
    telemetry_mode: str = Field(
        default=os.getenv("AETHER_TELEMETRY_MODE", "simulator"),
        description="'simulator' (17Hz built-in) or 'grpc' (127.0.0.1:2942).",
    )
    grpc_target: str = Field(default=os.getenv("SC_GRPC_TARGET", "127.0.0.1:2942"))
    star_citizen_exe_path: str = Field(
        default=os.getenv("STAR_CITIZEN_EXE_PATH", ""),
        description="Optional path to StarCitizen.exe (auto-detected if left blank).",
    )
    db_path: str = Field(default=os.getenv("AETHER_DB_PATH", str(DATA_DIR / "aether_memory.db")))
    proactive_alerts_enabled: bool = True
    tts_enabled: bool = True
    wake_word_enabled: bool = True
    pilot_callsign: str = Field(default=os.getenv("AETHER_CALLSIGN", "CMDR-01"))
    ship_name: str = Field(default=os.getenv("AETHER_SHIP_NAME", "UEES Aetherion (Zeus Mk II ES)"))
    persona: PersonaProfile = Field(default_factory=PersonaProfile)

    def save_to_disk(self) -> None:
        try:
            SETTINGS_FILE.write_text(self.model_dump_json(indent=2), encoding="utf-8")
        except OSError:
            pass

    @classmethod
    def load_or_default(cls) -> "AetherConfig":
        cfg = cls()
        if SETTINGS_FILE.is_file():
            try:
                saved = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
                # Always ensure official Mod ID is populated if old placeholder existed
                if saved.get("player2_game_key") == "aether-star-citizen":
                    saved["player2_game_key"] = DEFAULT_PLAYER2_MOD_ID
                cfg = cls.model_validate(saved)
            except Exception:
                pass
        return cfg
