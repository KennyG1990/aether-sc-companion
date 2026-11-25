"""Semantic Embedding Engine (AiLive SPEC-912 + Player2 /v1/embeddings with offline 512d fallback).

- When Player2 Local API is reachable, computes real dense semantic embeddings via POST /v1/embeddings
  (tagged with embedding_model_id so mixed models never collide).
- Falls back seamlessly to zero-dependency 512d hashed semantic + concept embeddings offline.
"""

from __future__ import annotations

import hashlib
import math
import re
from typing import Any

import httpx

VECTOR_DIM = 512
LOCAL_MODEL_ID = "local-hash-512d-v1"

_TOKEN_RE = re.compile(r"[a-z0-9_]+")

_CONCEPT_MAP: dict[str, list[str]] = {
    "fuel": ["hydrogen", "quantum", "tank", "refuel", "propellant", "qt", "h2"],
    "hydrogen": ["fuel", "propellant", "h2", "thruster"],
    "quantum": ["qt", "jump", "spool", "calibrate", "warp", "travel", "nav"],
    "shield": ["shields", "defense", "hull", "damage", "combat", "under_fire", "hit"],
    "shields": ["shield", "defense", "hull", "combat"],
    "gear": ["landing", "touchdown", "dock", "hangar", "pad"],
    "landing": ["gear", "touchdown", "dock", "hangar", "pad", "atc"],
    "ramp": ["door", "doors", "exterior", "hatch", "airlock", "cargo"],
    "door": ["doors", "ramp", "exterior", "hatch", "airlock"],
    "ally": ["allies", "squad", "fleet", "wingman", "friend", "crew", "party", "org"],
    "allies": ["ally", "squad", "fleet", "wingman", "friend", "crew", "party"],
    "squad": ["ally", "allies", "fleet", "wingman", "bravo", "alpha"],
    "joke": ["humor", "funny", "laugh", "banter", "pun"],
    "medical": ["medbay", "heal", "health", "vitals", "oxygen", "cutlass_red", "rescue"],
    "combat": ["hostile", "enemy", "pirate", "fight", "weapons", "scm", "missiles", "shields"],
    "pirate": ["hostile", "combat", "grim_hex", "bounty", "outlaw", "pyro"],
    "destruct": ["self_destruct", "eject", "abandon", "emergency"],
    "stanton": ["crusader", "hurston", "arccorp", "microtech", "orison", "lorville", "area18", "new_babbage"],
    "music": ["spotify", "song", "track", "playlist", "play", "audio"],
    "spotify": ["music", "song", "track", "playlist", "play"],
}


def _hash_bucket(feature: str, dim: int = VECTOR_DIM) -> tuple[int, float]:
    digest = hashlib.blake2b(feature.encode("utf-8"), digest_size=8).digest()
    val = int.from_bytes(digest, "little")
    bucket = val % dim
    sign = 1.0 if ((val >> 16) & 1) == 0 else -1.0
    return bucket, sign


def embed_text(text: str, dim: int = VECTOR_DIM) -> list[float]:
    """Deterministic L2-normalized local semantic vector (zero cloud startup requirement)."""
    vec = [0.0] * dim
    tokens = _TOKEN_RE.findall(text.lower())
    if not tokens:
        return vec

    for tok in tokens:
        if len(tok) <= 1:
            continue
        b, s = _hash_bucket(f"w:{tok}", dim)
        vec[b] += s * 2.0

        for syn in _CONCEPT_MAP.get(tok, ()):
            sb, ss = _hash_bucket(f"c:{syn}", dim)
            vec[sb] += ss * 0.9

        padded = f"^{tok}$"
        for i in range(len(padded) - 2):
            gram = padded[i : i + 3]
            gb, gs = _hash_bucket(f"g:{gram}", dim)
            vec[gb] += gs * 0.45

    for i in range(len(tokens) - 1):
        bg = f"b:{tokens[i]}_{tokens[i+1]}"
        bb, bs = _hash_bucket(bg, dim)
        vec[bb] += bs * 1.1

    norm = math.sqrt(sum(v * v for v in vec))
    if norm > 1e-9:
        vec = [round(v / norm, 6) for v in vec]
    return vec


def cosine_similarity(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    return float(sum(x * y for x, y in zip(a, b)))


async def embed_via_player2(
    texts: list[str],
    base_url: str,
    game_key: str,
) -> tuple[list[list[float]], str] | None:
    """Compute real dense semantic embeddings via Player2 POST /v1/embeddings (off-reply-path or query-time)."""
    if not texts:
        return None
    cleaned = [t.strip()[:2000] for t in texts if t.strip()]
    if not cleaned:
        return None
    try:
        async with httpx.AsyncClient(timeout=6.0) as client:
            resp = await client.post(
                f"{base_url.rstrip('/')}/v1/embeddings",
                headers={
                    "Content-Type": "application/json",
                    "player2-game-key": game_key,
                    "player2-resource": "rag-embeddings",
                },
                json={"input": cleaned, "encoding_format": "float"},
            )
            if resp.status_code != 200:
                return None
            payload: dict[str, Any] = resp.json()
            model_id = str(payload.get("model") or "player2-embed")
            items = sorted(payload.get("data", []), key=lambda x: x.get("index", 0))
            vecs: list[list[float]] = []
            for item in items:
                raw_v = item.get("embedding")
                if isinstance(raw_v, list) and raw_v:
                    # L2 normalize for exact dot-product cosine
                    norm = math.sqrt(sum(float(x) * float(x) for x in raw_v)) or 1.0
                    vecs.append([round(float(x) / norm, 6) for x in raw_v])
            if len(vecs) == len(cleaned):
                return vecs, model_id
    except Exception:
        pass
    return None
