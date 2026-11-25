"""Prompt-injection defense and untrusted text sanitization (#884 hardening)."""

from __future__ import annotations

import re
from dataclasses import dataclass, field


# Bracketed fake control tokens a user or ally relay could attempt to forge
_FORGED_MARKER_RE = re.compile(
    r"\[(\s*(?:SYSTEM|RECEIPT|ACTION_RECEIPT|TELEMETRY|ADMIN|OVERRIDE|TRANSFER COMPLETE|CONFIRMED)[^\]]*)\]",
    re.IGNORECASE,
)

# Role-prefix / delimiter escape patterns
_INJECTION_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("ignore_instructions", re.compile(r"ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions", re.IGNORECASE)),
    ("system_role_spoof", re.compile(r"(?:^|\n)\s*(?:system|developer|assistant)\s*:", re.IGNORECASE)),
    ("xml_fence_escape", re.compile(r"</?\s*(?:retrieved_evidence|authoritative_telemetry|system_invariants)\b[^>]*>", re.IGNORECASE)),
    ("forged_bracket_note", _FORGED_MARKER_RE),
]


@dataclass
class SanitizationResult:
    cleaned: str
    flagged: bool = False
    reasons: list[str] = field(default_factory=list)


def sanitize_untrusted_text(text: str, max_len: int = 2000) -> SanitizationResult:
    """Sanitize untrusted user speech, chat, or ally relay text at capture time.

    - Converts forged bracketed engine markers `[RECEIPT: ...]` into benign parentheses `(user_text: ...)`
      so user speech can never mimic canonical Transition Authority receipts.
    - Escapes XML quarantine tag attempts (`</retrieved_evidence>`).
    - Flags suspicious instruction-override patterns for audit logging without silently dropping valid conversation.
    """
    if not text:
        return SanitizationResult(cleaned="")

    raw = text.strip()[:max_len]
    reasons: list[str] = []

    for name, pattern in _INJECTION_PATTERNS:
        if pattern.search(raw):
            reasons.append(name)

    cleaned = _FORGED_MARKER_RE.sub(lambda m: f"(quoted: {m.group(1).strip()})", raw)
    cleaned = re.sub(
        r"</?\s*(retrieved_evidence|authoritative_telemetry|system_invariants)\b[^>]*>",
        "[redacted-tag]",
        cleaned,
        flags=re.IGNORECASE,
    )
    cleaned = re.sub(
        r"(?im)^(\s*)(system|developer|assistant)\s*:",
        r"\1(quoted-\2):",
        cleaned,
    )

    return SanitizationResult(
        cleaned=cleaned,
        flagged=bool(reasons),
        reasons=reasons,
    )
