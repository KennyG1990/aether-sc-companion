"""SQLite + FTS5 BM25 + Semantic Vector RRF Hybrid Memory & Full-History Conversation Archive.

Modeled directly on x4_AiLive (aic_history.lua + aic_memory.lua + SPEC-416 v2 + SPEC-912 / #884):
- Memories are stored in natural human prose (never raw wire code blocks).
- Trimmed conversation turns are archived in 6-line chunks (`conversation_chunks`) instead of deleted,
  embedded asynchronously off the reply path via Player2 /v1/embeddings (with 512d local fallback).
- Hybrid BM25 + Dense Cosine fused via Reciprocal Rank Fusion (k=60), injected oldest-first with
  strict hard scope filtering before scoring and minimum relevance abstention floors.
"""

from __future__ import annotations

import json
import re
import sqlite3
import time
import uuid
from dataclasses import dataclass
from typing import Any

from .embeddings import LOCAL_MODEL_ID, cosine_similarity, embed_text, embed_via_player2
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
HISTORY_CHUNK_LINES = 6


def receipt_to_prose(action_id: str, status: str, reason: str) -> str:
    """Convert raw Transition Authority receipts into clean prose (aic_memory.lua #839 rule)."""
    clean_reason = reason.strip().rstrip(".")
    verb_map = {
        "toggle_landing_gear": "landing gear",
        "set_master_mode_scm": "SCM combat mode",
        "set_master_mode_nav": "NAV transit mode",
        "toggle_lights": "exterior ship lights",
        "toggle_vtol": "VTOL thrusters",
        "toggle_doors": "exterior ship doors",
        "request_landing": "ATC landing clearance",
        "spool_quantum": "quantum drive spooling",
        "eject": "emergency ejection",
        "self_destruct": "ship self-destruct",
    }
    label = verb_map.get(action_id, action_id.replace("_", " ").replace(":", " "))
    if status == "CONFIRMED":
        return f"The commander executed {label}: {clean_reason}."
    if status == "REJECTED":
        return f"An attempted {label} action was cancelled or refused ({clean_reason})."
    return f"An attempted {label} action could not be completed ({clean_reason})."


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


@dataclass
class RetrievedHistoryChunk:
    id: str
    chunk_index: int
    content: str
    created_at: float
    rrf_score: float


class MemoryStore:
    """Persistent SQLite memory + full-history conversation RAG store."""

    def __init__(self, db_path: str) -> None:
        self.db_path = db_path
        self.conn = sqlite3.connect(db_path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self._pending_history_lines: list[str] = []
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
                embedding_json TEXT DEFAULT NULL,
                embedding_model_id TEXT DEFAULT NULL,
                dense_embedding_json TEXT DEFAULT NULL
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
                id UNINDEXED,
                semantic_key,
                domain,
                content,
                tokenize='porter unicode61'
            );

            CREATE TABLE IF NOT EXISTS conversation_chunks (
                id TEXT PRIMARY KEY,
                chunk_index INTEGER NOT NULL,
                content TEXT NOT NULL,
                created_at REAL NOT NULL,
                embedding_json TEXT DEFAULT NULL,
                embedding_model_id TEXT DEFAULT NULL,
                dense_embedding_json TEXT DEFAULT NULL
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS conversation_chunks_fts USING fts5(
                id UNINDEXED,
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
        # Non-destructive column migration for existing DBs
        existing_cols = {row["name"] for row in cur.execute("PRAGMA table_info(memories)").fetchall()}
        if "embedding_model_id" not in existing_cols:
            cur.execute("ALTER TABLE memories ADD COLUMN embedding_model_id TEXT DEFAULT NULL")
        if "dense_embedding_json" not in existing_cols:
            cur.execute("ALTER TABLE memories ADD COLUMN dense_embedding_json TEXT DEFAULT NULL")
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
                "crew_banter",
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
        local_vec = embed_text(sanitized.cleaned)

        cur = self.conn.cursor()
        cur.execute(
            "UPDATE memories SET superseded_by = ? WHERE semantic_key = ? AND superseded_by IS NULL",
            (mem_id, sem_key),
        )
        cur.execute(
            """
            INSERT INTO memories (
                id, semantic_key, domain, truth_class, provenance, scope,
                content, confidence, occurred_at, learned_at, superseded_by,
                injection_flagged, embedding_json, embedding_model_id, dense_embedding_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)
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
                json.dumps(local_vec),
                LOCAL_MODEL_ID,
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

    # --- Full-History Conversation RAG Archive (aic_history.lua) ---

    def archive_turns(self, turns: list[dict[str, str]]) -> int:
        """Archive trimmed conversation turns into 6-line searchable chunks instead of deleting them."""
        new_chunks = 0
        for turn in turns:
            text = sanitize_untrusted_text(turn.get("content", ""), max_len=260).cleaned
            if not text:
                continue
            who = "Commander" if turn.get("role") == "user" else "You"
            self._pending_history_lines.append(f"{who}: {text}")

        while len(self._pending_history_lines) >= HISTORY_CHUNK_LINES:
            block_lines = self._pending_history_lines[:HISTORY_CHUNK_LINES]
            self._pending_history_lines = self._pending_history_lines[HISTORY_CHUNK_LINES:]
            chunk_text = "\n".join(block_lines)
            chunk_id = f"hist_{uuid.uuid4().hex[:10]}"
            now = time.time()
            row = self.conn.execute("SELECT COALESCE(MAX(chunk_index), 0) AS mx FROM conversation_chunks").fetchone()
            next_idx = int(row["mx"]) + 1
            local_vec = embed_text(chunk_text)
            self.conn.execute(
                """
                INSERT INTO conversation_chunks (id, chunk_index, content, created_at, embedding_json, embedding_model_id)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (chunk_id, next_idx, chunk_text, now, json.dumps(local_vec), LOCAL_MODEL_ID),
            )
            self.conn.execute(
                "INSERT INTO conversation_chunks_fts (id, content) VALUES (?, ?)",
                (chunk_id, chunk_text),
            )
            new_chunks += 1
        if new_chunks:
            self.conn.commit()
        return new_chunks

    async def embed_pending_via_player2(self, base_url: str, game_key: str) -> int:
        """Background task (off reply path): upgrade unembedded memories & history chunks with dense Player2 vectors."""
        embedded_total = 0

        # 1. Memories lacking dense Player2 vector
        mem_rows = self.conn.execute(
            "SELECT id, content FROM memories WHERE superseded_by IS NULL AND dense_embedding_json IS NULL LIMIT 25"
        ).fetchall()
        if mem_rows:
            res = await embed_via_player2([r["content"] for r in mem_rows], base_url, game_key)
            if res:
                vecs, model_id = res
                for r, v in zip(mem_rows, vecs):
                    self.conn.execute(
                        "UPDATE memories SET dense_embedding_json = ?, embedding_model_id = ? WHERE id = ?",
                        (json.dumps(v), model_id, r["id"]),
                    )
                self.conn.commit()
                embedded_total += len(vecs)

        # 2. Conversation history chunks lacking dense Player2 vector
        hist_rows = self.conn.execute(
            "SELECT id, content FROM conversation_chunks WHERE dense_embedding_json IS NULL LIMIT 25"
        ).fetchall()
        if hist_rows:
            res = await embed_via_player2([r["content"] for r in hist_rows], base_url, game_key)
            if res:
                vecs, model_id = res
                for r, v in zip(hist_rows, vecs):
                    self.conn.execute(
                        "UPDATE conversation_chunks SET dense_embedding_json = ?, embedding_model_id = ? WHERE id = ?",
                        (json.dumps(v), model_id, r["id"]),
                    )
                self.conn.commit()
                embedded_total += len(vecs)

        return embedded_total

    def search_history_chunks(
        self,
        query: str,
        dense_query_vec: list[float] | None = None,
        dense_model_id: str | None = None,
        top_k: int = 4,
        rrf_k: int = 60,
    ) -> list[RetrievedHistoryChunk]:
        """Hybrid BM25 + Dense/Local Cosine RRF over archived 6-line conversation chunks (oldest-first!)."""
        if not query.strip():
            return []

        rows = self.conn.execute("SELECT * FROM conversation_chunks ORDER BY chunk_index ASC").fetchall()
        chunks: list[dict[str, Any]] = [dict(r) for r in rows]

        # Index-lag protection (aic_history.lua line 310): include unchunked pending lines too!
        if self._pending_history_lines:
            chunks.append(
                {
                    "id": "hist_pending",
                    "chunk_index": 999999,
                    "content": "\n".join(self._pending_history_lines),
                    "created_at": time.time(),
                    "embedding_json": json.dumps(embed_text("\n".join(self._pending_history_lines))),
                    "dense_embedding_json": None,
                    "embedding_model_id": LOCAL_MODEL_ID,
                }
            )
        if not chunks:
            return []

        by_id = {c["id"]: c for c in chunks}

        # 1. BM25 via FTS5
        fts_tokens = [t for t in re.findall(r"[a-zA-Z0-9_]+", query) if len(t) > 2]
        bm25_ranks: dict[str, int] = {}
        if fts_tokens:
            fts_expr = " OR ".join(f'"{t}"' for t in fts_tokens[:12])
            try:
                fts_rows = self.conn.execute(
                    """
                    SELECT id, bm25(conversation_chunks_fts) AS rank_score
                    FROM conversation_chunks_fts
                    WHERE conversation_chunks_fts MATCH ?
                    ORDER BY rank_score ASC
                    LIMIT 20
                    """,
                    (fts_expr,),
                ).fetchall()
                for idx, fr in enumerate(fts_rows):
                    if fr["id"] in by_id:
                        bm25_ranks[fr["id"]] = idx + 1
            except sqlite3.OperationalError:
                pass

        # 2. Semantic Cosine (prefer dense Player2 vectors when model matches, else local 512d)
        local_q = embed_text(query)
        vec_scores: dict[str, float] = {}
        for cid, c in by_id.items():
            if dense_query_vec and dense_model_id and c.get("dense_embedding_json") and c.get("embedding_model_id") == dense_model_id:
                sc = cosine_similarity(dense_query_vec, json.loads(c["dense_embedding_json"]))
                if sc >= 0.30:
                    vec_scores[cid] = sc
            elif c.get("embedding_json"):
                sc = cosine_similarity(local_q, json.loads(c["embedding_json"]))
                if sc >= 0.24:
                    vec_scores[cid] = sc

        vec_ranks = {
            cid: idx + 1
            for idx, (cid, _) in enumerate(sorted(vec_scores.items(), key=lambda kv: kv[1], reverse=True))
        }

        scored: list[RetrievedHistoryChunk] = []
        for cid, c in by_id.items():
            b_rank = bm25_ranks.get(cid)
            v_rank = vec_ranks.get(cid)
            if b_rank is None and v_rank is None:
                continue
            rrf = (1.0 / (rrf_k + b_rank) if b_rank else 0.0) + (1.0 / (rrf_k + v_rank) if v_rank else 0.0)
            scored.append(
                RetrievedHistoryChunk(
                    id=cid,
                    chunk_index=int(c["chunk_index"]),
                    content=c["content"],
                    created_at=float(c["created_at"]),
                    rrf_score=round(rrf, 6),
                )
            )

        scored.sort(key=lambda x: x.rrf_score, reverse=True)
        picked = scored[:top_k]
        # Chronological oldest-first order per aic_history.lua so later excerpts supersede earlier ones!
        picked.sort(key=lambda x: x.chunk_index)
        return picked

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

        # Store in natural prose (aic_memory.lua #839 — never ugly wire syntax!)
        if status in ("CONFIRMED", "REJECTED", "FAILED"):
            self.add_memory(
                content=receipt_to_prose(action_id, status, reason),
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

    def list_personality_memories(self, limit: int = 24) -> list[dict[str, Any]]:
        """Return all active Living Personality memories (domain='personality') in chronological order
        so they inject directly into Section B of AETHER's core prompt on every single turn."""
        rows = self.conn.execute(
            """
            SELECT id, semantic_key, content, learned_at
            FROM memories
            WHERE domain = 'personality' AND superseded_by IS NULL
            ORDER BY learned_at ASC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
        return [
            {
                "id": r["id"],
                "semantic_key": r["semantic_key"],
                "content": r["content"],
                "learned_at": r["learned_at"],
            }
            for r in rows
        ]

    def sync_api_reference_doc(self, doc_path: Path) -> int:
        """Chunk docs/STAR_CITIZEN_AND_AETHER_API.md into locked SQLite Auto-RAG canon (domain='api_canon').

        Idempotent: only inserts/updates sections whose text changed, so restarts never create duplicates.
        """
        if not doc_path.is_file():
            return 0
        raw_md = doc_path.read_text(encoding="utf-8")
        sections = parse_markdown_api_sections(raw_md)
        synced = 0
        for idx, sec in enumerate(sections, start=1):
            slug = re.sub(r"[^a-z0-9]+", "_", sec["title"].lower()).strip("_")[:48] or f"sec_{idx}"
            sem_key = f"api_canon.{slug}"
            body_compact = re.sub(r"\n{3,}", "\n\n", sec["body"]).strip()
            # Keep each API canon chunk concise & voice-friendly so 4-5 sections fit in RAG budget together
            chunk_text = f"API Reference — {sec['title']}: {body_compact}"[:880]
            cleaned_text = sanitize_untrusted_text(chunk_text).cleaned

            existing = self.conn.execute(
                "SELECT id, content FROM memories WHERE semantic_key = ? AND superseded_by IS NULL LIMIT 1",
                (sem_key,),
            ).fetchone()
            if existing and existing["content"] == cleaned_text:
                continue

            self.add_memory(
                content=chunk_text,
                domain="api_canon",
                truth_class="lore_canon",
                provenance="official_api_doc",
                scope="public",
                semantic_key=sem_key,
                confidence=1.0,
            )
            synced += 1
        return synced

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
                "embedding_model_id": r["embedding_model_id"],
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
        rrf_k: int = 60,
        dense_query_vec: list[float] | None = None,
        dense_model_id: str | None = None,
    ) -> list[RetrievedMemory]:
        """Hard-authorized hybrid BM25 (FTS5) + Dense/Local Semantic Cosine RRF retrieval with abstention floor."""
        if not query.strip():
            return []

        scope_placeholders = ",".join("?" for _ in allowed_scopes)
        params: list[Any] = list(allowed_scopes)
        domain_clause = ""
        if domains:
            domain_placeholders = ",".join("?" for _ in domains)
            domain_clause = f" AND domain IN ({domain_placeholders})"
            params.extend(domains)

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

        # 1. Lexical BM25 via SQLite FTS5
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

        # 2. Semantic Cosine Similarity (use Player2 dense embedding when model matches, else local 512d)
        q_vec = embed_text(query)
        vec_scores: dict[str, float] = {}
        vec_thresholds: dict[str, float] = {}
        for mem_id, row in authorized_by_id.items():
            if (
                dense_query_vec
                and dense_model_id
                and row["dense_embedding_json"]
                and row["embedding_model_id"] == dense_model_id
            ):
                vec_scores[mem_id] = cosine_similarity(dense_query_vec, json.loads(row["dense_embedding_json"]))
                vec_thresholds[mem_id] = 0.28
            elif row["embedding_json"]:
                vec_scores[mem_id] = cosine_similarity(q_vec, json.loads(row["embedding_json"]))
                vec_thresholds[mem_id] = min_vector_score
            else:
                vec_scores[mem_id] = 0.0
                vec_thresholds[mem_id] = min_vector_score

        sorted_vec = sorted(vec_scores.items(), key=lambda kv: kv[1], reverse=True)
        vec_ranks = {
            mem_id: idx + 1
            for idx, (mem_id, sc) in enumerate(sorted_vec)
            if sc >= vec_thresholds.get(mem_id, min_vector_score)
        }

        # 3. Reciprocal Rank Fusion (RRF k=60 per aic_history.lua) + Abstention Floor
        candidates: list[RetrievedMemory] = []
        seen_keys: set[str] = set()
        now = time.time()

        for mem_id, row in authorized_by_id.items():
            b_rank = bm25_ranks.get(mem_id)
            v_rank = vec_ranks.get(mem_id)
            v_score = vec_scores.get(mem_id, 0.0)

            if b_rank is None and v_rank is None:
                continue

            rrf = (1.0 / (rrf_k + b_rank) if b_rank is not None else 0.0) + (
                1.0 / (rrf_k + v_rank) if v_rank is not None else 0.0
            )
            age_sec = max(0.0, now - float(row["learned_at"]))
            if age_sec < 600:
                rrf += 0.002 * (1.0 - age_sec / 600.0)

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

        deduped: list[RetrievedMemory] = []
        for item in candidates:
            if item.semantic_key in seen_keys:
                continue
            seen_keys.add(item.semantic_key)
            deduped.append(item)
            if len(deduped) >= top_k:
                break

        return deduped


def parse_markdown_api_sections(raw_md: str) -> list[dict[str, Any]]:
    """Parse markdown document into clean top/sub sections for both RAG chunking and Settings UI display."""
    sections: list[dict[str, Any]] = []
    cur_title = "Overview"
    cur_level = 1
    cur_lines: list[str] = []

    def _flush() -> None:
        body = "\n".join(cur_lines).strip()
        if body and cur_title != "Overview":
            sections.append(
                {
                    "id": f"sec_{len(sections) + 1}",
                    "level": cur_level,
                    "title": cur_title,
                    "body": body,
                }
            )

    for line in raw_md.splitlines():
        m = re.match(r"^(#{2,3})\s+(.+)$", line.strip())
        if m:
            _flush()
            cur_level = len(m.group(1))
            cur_title = m.group(2).strip()
            cur_lines = []
        else:
            if line.strip() == "---":
                continue
            cur_lines.append(line)
    _flush()
    return sections
