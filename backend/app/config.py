"""Runtime configuration for AETHER backend."""

from __future__ import annotations

import os
from pathlib import Path
from pydantic import BaseModel, Field


BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)


class AetherConfig(BaseModel):
    llm_provider: str = Field(
        default=os.getenv("AETHER_LLM_PROVIDER", "demo"),
        description="Active LLM backend: 'player2', 'openrouter', or 'demo'.",
    )
    player2_base_url: str = Field(
        default=os.getenv("PLAYER2_BASE_URL", "http://127.0.0.1:4315"),
    )
    player2_game_key: str = Field(
        default=os.getenv("PLAYER2_GAME_KEY", "aether-star-citizen"),
    )
    openrouter_api_key: str = Field(
        default=os.getenv("OPENROUTER_API_KEY", ""),
    )
    openrouter_model: str = Field(
        default=os.getenv("OPENROUTER_MODEL", "anthropic/claude-3.7-sonnet"),
    )
    telemetry_mode: str = Field(
        default=os.getenv("AETHER_TELEMETRY_MODE", "simulator"),
        description="'simulator' (17Hz built-in) or 'grpc' (127.0.0.1:2942).",
    )
    grpc_target: str = Field(
        default=os.getenv("SC_GRPC_TARGET", "127.0.0.1:2942"),
    )
    db_path: str = Field(
        default=os.getenv("AETHER_DB_PATH", str(DATA_DIR / "aether_memory.db")),
    )
    proactive_alerts_enabled: bool = True
    tts_enabled: bool = True
    pilot_callsign: str = Field(default=os.getenv("AETHER_CALLSIGN", "CMDR-01"))
    ship_name: str = Field(default=os.getenv("AETHER_SHIP_NAME", "UEES Aetherion (Zeus Mk II ES)"))
