"""SQLite + FTS5 BM25 + Semantic Vector RRF Hybrid Memory Store (SPEC-912 / #884)."""

from __future__ import annotations

import json
import re
import sqlite3
import time
import uuid
from dataclasses import dataclass
from typing import Any

from .embeddings import cosine_similarity, embed_text
from .sanitizer import sanitize_untrusted_text

VALID_TRUTH_CLASSES = {
    "authoritative_telemetry",
    "committed_receipt",
    "firsthand_observation",
    "ally_relay",
    "lore_canon",
    "user_claim",
    "model_summary",
}

VALID_SCOPES = {"private", "fleet", "public"}


@dataclass
class RetrievedMemory:
    id: str
    semantic_key: str
    domain: str
    truth_class: str
    provenance: str
    scope: str
    content: str
    confidence: float
    occurred_at: float
    learned_at: float
    bm25_rank: int | None
    vector_score: float
    rrf_score: float


class MemoryStore:
    """Persistent SQLite memory store implementing hybrid BM25 + vector RRF retrieval."""

    def __init__(self, db_path: str) -> None:
        self.db_path = db_path
        self.conn = sqlite3.connect(db_path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self._init_schema()
        self._seed_initial_knowledge()

    def _init_schema(self) -> None:
        cur = self.conn.cursor()
        cur.executescript(
            """
            PRAGMA journal_mode=WAL;

            CREATE TABLE IF NOT EXISTS memories (
                id TEXT PRIMARY KEY,
                semantic_key TEXT NOT NULL,
                domain TEXT NOT NULL,
                truth_class TEXT NOT NULL,
                provenance TEXT NOT NULL,
                scope TEXT NOT NULL DEFAULT 'private',
                content TEXT NOT NULL,
                confidence REAL NOT NULL DEFAULT 0.9,
                occurred_at REAL NOT NULL,
                learned_at REAL NOT NULL,
                superseded_by TEXT DEFAULT NULL,
                injection_flagged INTEGER NOT NULL DEFAULT 0,
                embedding_json TEXT DEFAULT NULL
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
                id UNINDEXED,
                semantic_key,
                domain,
                content,
                tokenize='porter unicode61'
            );

            CREATE TABLE IF NOT EXISTS action_receipts (
                id TEXT PRIMARY KEY,
                action_id TEXT NOT NULL,
                parameters_json TEXT NOT NULL,
                status TEXT NOT NULL,
                reason TEXT NOT NULL,
                source TEXT NOT NULL,
                created_at REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS security_audit (
                id TEXT PRIMARY KEY,
                source TEXT NOT NULL,
                reasons_json TEXT NOT NULL,
                snippet TEXT NOT NULL,
                created_at REAL NOT NULL
            );
            """
        )
        self.conn.commit()

    def _seed_initial_knowledge(self) -> None:
        cur = self.conn.execute("SELECT COUNT(*) AS cnt FROM memories")
        if cur.fetchone()["cnt"] > 0:
            return

        now = time.time()
        seeds = [
            (
                "lore.stanton.overview",
                "lore",
                "lore_canon",
                "starcitizen_galactapedia",
                "public",
                "Stanton is a four-planet UEE corporate super-system consisting of Hurston (Lorville), Crusader (Orison), ArcCorp (Area18), and MicroTech (New Babbage), plus the outlaw asteroid base Grim HEX orbiting Yela.",
                1.0,
            ),
            (
                "lore.master_modes",
                "lore",
                "lore_canon",
                "starcitizen_flight_manual",
                "public",
                "Master Modes separate Star Citizen flight into SCM (Standard Combat Mode — shields and weapons active, capped combat speeds) and NAV (Navigation Mode — quantum drive and high-speed transit, shields drop to reserve).",
                1.0,
            ),
            (
                "lore.telemetry_api",
                "lore",
                "lore_canon",
                "aether_system_manual",
                "public",
                "AETHER reads live Star Citizen telemetry via local gRPC on 127.0.0.1:2942 (GameTelemetryService) and executes verified commands through TriggerGameActions. Destructive commands like eject or self_destruct always require pilot confirmation.",
                1.0,
            ),
            (
                "fleet.callsign.vanguard",
                "fleet",
                "firsthand_observation",
                "org_roster",
                "fleet",
                "Bravo-1 (Callsign: Kestrel) flies an Anvil F7A Hornet Mk II as combat escort around Crusader and Grim HEX.",
                0.95,
            ),
            (
                "fleet.callsign.medevac",
                "fleet",
                "firsthand_observation",
                "org_roster",
                "fleet",
                "Medevac-2 (Callsign: DocVex) pilots a Drake Cutlass Red stationed near Hurston and frequently reminds pilots to check oxygen levels before EVA.",
                0.95,
            ),
            (
                "episodic.joke.elevator",
                "episodic",
                "firsthand_observation",
                "aether_banter_bank",
                "private",
                "Running crew joke: The most lethal apex predator in the Stanton system is not a Vanduul Kingship — it is a Grim HEX elevator with an attitude.",
                0.9,
            ),
        ]
        for key, domain, truth_class, provenance, scope, content, conf in seeds:
            self.add_memory(
                content=content,
                domain=domain,
                truth_class=truth_class,
                provenance=provenance,
                scope=scope,
                semantic_key=key,
                confidence=conf,
                occurred_at=now,
            )

    def add_memory(
        self,
        content: str,
        domain: str = "episodic",
        truth_class: str = "user_claim",
        provenance: str = "pilot_voice",
        scope: str = "private",
        semantic_key: str | None = None,
        confidence: float = 0.85,
        occurred_at: float | None = None,
    ) -> dict[str, Any]:
        if truth_class not in VALID_TRUTH_CLASSES:
            truth_class = "user_claim"
        if scope not in VALID_SCOPES:
            scope = "private"

        sanitized = sanitize_untrusted_text(content)
        now = time.time()
        mem_id = f"mem_{uuid.uuid4().hex[:10]}"
        sem_key = semantic_key or f"{domain}.{uuid.uuid4().hex[:8]}"
        occ = occurred_at if occurred_at is not None else now
        vec = embed_text(sanitized.cleaned)

        cur = self.conn.cursor()
        # Supersede prior record with the exact same semantic_key so newer facts win
        cur.execute(
            "UPDATE memories SET superseded_by = ? WHERE semantic_key = ? AND superseded_by IS NULL",
            (mem_id, sem_key),
        )
        cur.execute(
            """
            INSERT INTO memories (
                id, semantic_key, domain, truth_class, provenance, scope,
                content, confidence, occurred_at, learned_at, superseded_by,
                injection_flagged, embedding_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
            """,
            (
                mem_id,
                sem_key,
                domain,
                truth_class,
                provenance,
                scope,
                sanitized.cleaned,
                float(confidence),
                float(occ),
                now,
                1 if sanitized.flagged else 0,
                json.dumps(vec),
            ),
        )
        cur.execute(
            "INSERT INTO memories_fts (id, semantic_key, domain, content) VALUES (?, ?, ?, ?)",
            (mem_id, sem_key, domain, sanitized.cleaned),
        )
        if sanitized.flagged:
            cur.execute(
                "INSERT INTO security_audit (id, source, reasons_json, snippet, created_at) VALUES (?, ?, ?, ?, ?)",
                (
                    f"sec_{uuid.uuid4().hex[:8]}",
                    provenance,
                    json.dumps(sanitized.reasons),
                    content[:240],
                    now,
                ),
            )
        self.conn.commit()
        return {
            "id": mem_id,
            "semantic_key": sem_key,
            "domain": domain,
            "truth_class": truth_class,
            "provenance": provenance,
            "scope": scope,
            "content": sanitized.cleaned,
            "injection_flagged": sanitized.flagged,
            "injection_reasons": sanitized.reasons,
            "occurred_at": occ,
            "learned_at": now,
        }

    def record_receipt(
        self,
        action_id: str,
        parameters: dict[str, Any],
        status: str,
        reason: str,
        source: str,
    ) -> dict[str, Any]:
        receipt_id = f"rcpt_{uuid.uuid4().hex[:10]}"
        now = time.time()
        self.conn.execute(
            """
            INSERT INTO action_receipts (id, action_id, parameters_json, status, reason, source, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (receipt_id, action_id, json.dumps(parameters), status, reason, source, now),
        )
        self.conn.commit()

        # Store confirmed/rejected receipts in episodic memory with authoritative truth_class
        if status in ("CONFIRMED", "REJECTED", "FAILED"):
            self.add_memory(
                content=f"Action {action_id} ({status}): {reason}",
                domain="receipt",
                truth_class="committed_receipt",
                provenance="transition_authority",
                scope="private",
                semantic_key=f"receipt.{action_id}.{int(now)}",
                confidence=1.0,
                occurred_at=now,
            )

        return {
            "id": receipt_id,
            "action_id": action_id,
            "parameters": parameters,
            "status": status,
            "reason": reason,
            "source": source,
            "created_at": now,
        }

    def list_receipts(self, limit: int = 25) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT * FROM action_receipts ORDER BY created_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [
            {
                "id": r["id"],
                "action_id": r["action_id"],
                "parameters": json.loads(r["parameters_json"]),
                "status": r["status"],
                "reason": r["reason"],
                "source": r["source"],
                "created_at": r["created_at"],
            }
            for r in rows
        ]

    def list_security_audit(self, limit: int = 20) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT * FROM security_audit ORDER BY created_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [
            {
                "id": r["id"],
                "source": r["source"],
                "reasons": json.loads(r["reasons_json"]),
                "snippet": r["snippet"],
                "created_at": r["created_at"],
            }
            for r in rows
        ]

    def list_memories(self, limit: int = 50, domain: str | None = None) -> list[dict[str, Any]]:
        if domain:
            rows = self.conn.execute(
                "SELECT * FROM memories WHERE superseded_by IS NULL AND domain = ? ORDER BY learned_at DESC LIMIT ?",
                (domain, limit),
            ).fetchall()
        else:
            rows = self.conn.execute(
                "SELECT * FROM memories WHERE superseded_by IS NULL ORDER BY learned_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [
            {
                "id": r["id"],
                "semantic_key": r["semantic_key"],
                "domain": r["domain"],
                "truth_class": r["truth_class"],
                "provenance": r["provenance"],
                "scope": r["scope"],
                "content": r["content"],
                "confidence": r["confidence"],
                "occurred_at": r["occurred_at"],
                "learned_at": r["learned_at"],
                "injection_flagged": bool(r["injection_flagged"]),
            }
            for r in rows
        ]

    def hybrid_search(
        self,
        query: str,
        allowed_scopes: tuple[str, ...] = ("private", "fleet", "public"),
        domains: tuple[str, ...] | None = None,
        top_k: int = 6,
        min_vector_score: float = 0.22,
        rrf_k: int = 30,
    ) -> list[RetrievedMemory]:
        """Hard-authorized hybrid BM25 (FTS5) + Semantic Cosine RRF retrieval with abstention floor."""
        if not query.strip():
            return []

        scope_placeholders = ",".join("?" for _ in allowed_scopes)
        params: list[Any] = list(allowed_scopes)
        domain_clause = ""
        if domains:
            domain_placeholders = ",".join("?" for _ in domains)
            domain_clause = f" AND domain IN ({domain_placeholders})"
            params.extend(domains)

        # 1. Hard Authorization Filter BEFORE scoring (SPEC-912 §4.4 / §5.2)
        rows = self.conn.execute(
            f"""
            SELECT * FROM memories
            WHERE superseded_by IS NULL
              AND scope IN ({scope_placeholders})
              {domain_clause}
            """,
            params,
        ).fetchall()
        if not rows:
            return []

        authorized_by_id = {r["id"]: r for r in rows}

        # 2. Lexical BM25 via SQLite FTS5
        fts_tokens = [t for t in re.findall(r"[a-zA-Z0-9_]+", query) if len(t) > 1]
        bm25_ranks: dict[str, int] = {}
        if fts_tokens:
            fts_expr = " OR ".join(f'"{t}"' for t in fts_tokens[:12])
            try:
                fts_rows = self.conn.execute(
                    """
                    SELECT id, bm25(memories_fts) AS rank_score
                    FROM memories_fts
                    WHERE memories_fts MATCH ?
                    ORDER BY rank_score ASC
                    LIMIT 30
                    """,
                    (fts_expr,),
                ).fetchall()
                rank = 1
                for fr in fts_rows:
                    if fr["id"] in authorized_by_id:
                        bm25_ranks[fr["id"]] = rank
                        rank += 1
            except sqlite3.OperationalError:
                pass

        # 3. Semantic Cosine Similarity
        q_vec = embed_text(query)
        vec_scores: dict[str, float] = {}
        for mem_id, row in authorized_by_id.items():
            emb_raw = row["embedding_json"]
            if emb_raw:
                vec_scores[mem_id] = cosine_similarity(q_vec, json.loads(emb_raw))
            else:
                vec_scores[mem_id] = 0.0

        sorted_vec = sorted(vec_scores.items(), key=lambda kv: kv[1], reverse=True)
        vec_ranks = {mem_id: idx + 1 for idx, (mem_id, sc) in enumerate(sorted_vec) if sc >= min_vector_score}

        # 4. Reciprocal Rank Fusion (RRF) + Minimum Relevance Floor (Abstain below floor)
        candidates: list[RetrievedMemory] = []
        seen_keys: set[str] = set()
        now = time.time()

        for mem_id, row in authorized_by_id.items():
            b_rank = bm25_ranks.get(mem_id)
            v_rank = vec_ranks.get(mem_id)
            v_score = vec_scores.get(mem_id, 0.0)

            # Abstain if neither lexical BM25 matched nor semantic floor was met (#884 gap #7)
            if b_rank is None and v_rank is None:
                continue

            rrf = 0.0
            if b_rank is not None:
                rrf += 1.0 / (rrf_k + b_rank)
            if v_rank is not None:
                rrf += 1.0 / (rrf_k + v_rank)

            # Mild index-lag/recency bonus for memories learned within the last 10 minutes
            age_sec = max(0.0, now - float(row["learned_at"]))
            if age_sec < 600:
                rrf += 0.004 * (1.0 - age_sec / 600.0)

            candidates.append(
                RetrievedMemory(
                    id=mem_id,
                    semantic_key=row["semantic_key"],
                    domain=row["domain"],
                    truth_class=row["truth_class"],
                    provenance=row["provenance"],
                    scope=row["scope"],
                    content=row["content"],
                    confidence=float(row["confidence"]),
                    occurred_at=float(row["occurred_at"]),
                    learned_at=float(row["learned_at"]),
                    bm25_rank=b_rank,
                    vector_score=round(v_score, 4),
                    rrf_score=round(rrf, 6),
                )
            )

        candidates.sort(key=lambda m: m.rrf_score, reverse=True)

        # 5. Deduplicate by semantic_key
        deduped: list[RetrievedMemory] = []
        for item in candidates:
            if item.semantic_key in seen_keys:
                continue
            seen_keys.add(item.semantic_key)
            deduped.append(item)
            if len(deduped) >= top_k:
                break

        return deduped
