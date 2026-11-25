"""Zero-dependency local semantic embedding engine (SPEC-912 offline-first guarantee).

Combines normalized word tokens, domain synonym expansion (Star Citizen flight/combat/lore),
and character 3-gram hashing into a dense L2-normalized float vector so semantic paraphrase
retrieval works locally with zero cloud startup requirement.
"""

from __future__ import annotations

import hashlib
import math
import re

VECTOR_DIM = 512

_TOKEN_RE = re.compile(r"[a-z0-9_]+")

# Lightweight domain concept expansion for Star Citizen paraphrase recall
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
}


def _hash_bucket(feature: str, dim: int = VECTOR_DIM) -> tuple[int, float]:
    digest = hashlib.blake2b(feature.encode("utf-8"), digest_size=8).digest()
    val = int.from_bytes(digest, "little")
    bucket = val % dim
    sign = 1.0 if ((val >> 16) & 1) == 0 else -1.0
    return bucket, sign


def embed_text(text: str, dim: int = VECTOR_DIM) -> list[float]:
    """Compute a deterministic L2-normalized semantic vector for text."""
    vec = [0.0] * dim
    tokens = _TOKEN_RE.findall(text.lower())
    if not tokens:
        return vec

    for tok in tokens:
        if len(tok) <= 1:
            continue
        # Direct lexical token (strongest weight)
        b, s = _hash_bucket(f"w:{tok}", dim)
        vec[b] += s * 2.0

        # Domain concept synonyms (semantic bridge)
        for syn in _CONCEPT_MAP.get(tok, ()):
            sb, ss = _hash_bucket(f"c:{syn}", dim)
            vec[sb] += ss * 0.9

        # Character 3-grams (morphological / fuzzy resilience)
        padded = f"^{tok}$"
        for i in range(len(padded) - 2):
            gram = padded[i : i + 3]
            gb, gs = _hash_bucket(f"g:{gram}", dim)
            vec[gb] += gs * 0.45

    # Word bigrams for phrase fidelity
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
