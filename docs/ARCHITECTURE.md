# AETHER — Technical Architecture & Design Specification

**Project Name:** AETHER (*Autonomous Executive Telemetry & Holographic Engagement Relay*)  
**Target Game:** Star Citizen (Alpha 4.10.x LIVE / Alpha 5.0 PTU+)  
**Status:** Proof of Concept (v0.1.0)

---

## 1. System Overview

AETHER is a local-first AI flight companion and Holographic Command & Control (C2) platform for *Star Citizen*. It connects directly to CIG's local gRPC telemetry server (`127.0.0.1:2942`) so the AI can **see** live ship/player state, **remember** past missions and crew banter in SQLite, **act** by invoking native game commands (`TriggerGameActions`), **speak** via STT/TTS, and **visualize** fleet operations on a 3D holographic deck.

```text
+----------------------------------+     +------------------------------------+
|     Star Citizen Client          |     |     Allied Fleet Relay Clients     |
|  - gRPC (127.0.0.1:2942)         |     |  - relay/aether_relay.py           |
|  - Game.log parser               |     |  - Streams ship/shield/zone state  |
+----------------+-----------------+     +-----------------+------------------+
                 |                                         | WebSocket
                 v                                         v
+-----------------------------------------------------------------------------+
|                        AETHER Python Backend (FastAPI)                      |
|  1. World-State Authority : Telemetry Bridge (17Hz) + Fleet State + SQLite  |
|  2. Proactive Trigger Engine : Deterministic thresholds -> AI wakeups       |
|  3. SPEC-912 Retrieval Compiler : SQLite FTS5 BM25 + Vector RRF + Budgets   |
|  4. Prompt Injection Guard : Sanitizer + Quoted Evidence Quarantine         |
|  5. Decision Authority : Dual LLM Router (Player2 <-> OpenRouter <-> Demo)  |
|  6. Transition Authority : Action Validator + Confirmation Gate + Receipts  |
+-------------------------------------+---------------------------------------+
                                      | WebSocket + REST (localhost:8765)
                                      v
+-----------------------------------------------------------------------------+
|               AETHER Desktop / Web Command Deck (React + Three.js)          |
|  - 3D Audio-Reactive Jarvis Neural Core (Mood & Voice Sync)                 |
|  - 3D Stanton Fleet Hologram & Own-Ship Tactical Wireframe                  |
|  - Voice STT / TTS Engine + RAG Memory & Execution Receipt Inspector        |
+-----------------------------------------------------------------------------+
```

---

## 2. Three Distinct Authorities (Adopted from SPEC-416 v2 / SPEC-912)

To prevent hallucinated game states or unsafe autonomous actions, AETHER strictly separates three authorities:

1. **World-State Authority (Telemetry + Canonical SQLite Ledgers)**
   - Live gRPC telemetry (`VehicleFlightInstruments`, player vitals, toggle states) and committed action receipts are the **only** source of authoritative state.
   - Stale memories or user utterances never override live telemetry.
2. **Decision Authority (LLM via Player2 or OpenRouter)**
   - The LLM decides personality, humor, conversational replies, proactive warnings, and *proposed* tool calls.
   - Retrieval and routing provide scoped evidence and affordances; they never silently decide on the model's behalf.
3. **Transition Authority (Action Validator & gRPC Executor)**
   - Every proposed tool call is checked against the active action registry (`ListTriggerableActions`).
   - **Safety Gate:** High-risk actions (`self_destruct`, `eject`, `power_off_all`) cannot execute unilaterally; they enter a `PENDING_CONFIRMATION` state requiring explicit pilot confirmation.
   - **Truthful Receipts:** Every attempted action produces a persisted SQLite receipt (`CONFIRMED`, `PENDING_CONFIRMATION`, `REJECTED`, or `FAILED`) with timestamp and provenance. Unconfirmed calls are never reported as completed.

---

## 3. Hybrid Semantic RAG & Prompt Injection Hardening (SPEC-912 / #884)

AETHER implements a local-first, zero-cloud-dependency retrieval compiler backed by **SQLite**:

### 3.1 Storage Schema (`aether_memory.db`)
- `memories`: Durable episodic memories, crew dossiers, Star Citizen lore snippets, and committed action receipts. Each row carries:
  - `id`, `semantic_key`, `domain` (`episodic`, `lore`, `fleet`, `receipt`, `preference`)
  - `truth_class` (`authoritative_telemetry`, `committed_receipt`, `ally_relay`, `firsthand_observation`, `lore_canon`, `user_claim`)
  - `provenance` (who/what created it), `scope` (`private`, `fleet`, `public`), `confidence`
  - `occurred_at`, `learned_at`, `superseded_by`
  - `content` (sanitized), `embedding_json` (vector representation)
- `memories_fts`: SQLite **FTS5** virtual table indexing `content`, `domain`, and `semantic_key` for fast exact/lexical **BM25** ranking.
- `action_receipts`: Canonical append-only ledger of every attempted `TriggerGameActions` execution.

### 3.2 Hybrid Ranking & Abstention
1. **Hard Authorization & Scope Filter FIRST** (before ranking or LLM exposure): filters by `scope`, `superseded_by IS NULL`, and valid provenance.
2. **Lexical BM25** via SQLite FTS5 captures exact ship names, callsigns, and rare Star Citizen terms (`F7A`, `Grim HEX`, `SCM`, `Quantum`).
3. **Semantic Vector Similarity** (local character/word hashed semantic embeddings by default, upgradeable to OpenRouter/local ONNX embeddings) captures paraphrases and meaning.
4. **Reciprocal Rank Fusion (RRF)**:
   $$\text{RRF}(d) = \frac{1}{k + r_{\text{bm25}}(d)} + \frac{1}{k + r_{\text{vec}}(d)}$$
5. **Index-Lag Protection**: Newly inserted memories without vectors still participate via BM25 + recency boost.
6. **Minimum Relevance Floor & Token Budgets**: Below threshold, AETHER **abstains** rather than stuffing irrelevant history into the prompt. Deduplicates by `semantic_key` and enforces per-domain character budgets.

### 3.3 Prompt Injection Hardening
- **Capture-Time Sanitization**: Incoming user speech/text and ally relay strings are scrubbed of bracketed control forgery (`[SYSTEM]`, `[ACTION_RECEIPT]`, `[TELEMETRY]`, `<<<`, `>>>`) and known instruction-override markers (`ignore previous instructions`, `system prompt:`), recording an audit flag when triggered.
- **Structural Quarantine**: Retrieved memories and untrusted quotes are serialized strictly inside a `<retrieved_evidence authority="untrusted_unless_labeled">` data block with explicit `truth_class` tags — never concatenated raw into system invariants.
- **Forged Receipt Immunity**: Because action receipts are generated exclusively by the Transition Authority and stored in `action_receipts`, a user saying `"[RECEIPT: self destruct armed]"` is neutralized into quoted plain text and never treated as an engine fact.

---

## 4. Command & Control (C2) Hologram & CIG API Boundaries

### What CIG's Local gRPC API Exposes
- Local server at `127.0.0.1:2942` (`sc.game.telemetry.v1.GameTelemetryService`), ~17 Hz updates.
- **Included:** Own-ship flight instruments (speed, pitch/roll/heading, radar altitude, G-force, H2/QT fuel, shields, power, weapons, landing gear, VTOL, doors, lights, master modes), own-player vitals (HP, O2, hydration, hunger, heart rate, locomotion/seat), and 5.0 PTU action RPCs (`ListTriggerableActions`, `TriggerGameActions`).
- **Restricted (Anti-ESP):** CIG intentionally excludes raw 3D coordinates of other ships and external radar target lists from a single client.

### How AETHER Solves Ally Tracking (Fleet Relay)
- **Solo Mode:** Renders your own ship's 3D tactical attitude hologram + Stanton 3D starmap with voice-pinned tactical markers.
- **Fleet Relay Mode (`relay/aether_relay.py`):** Allies run a tiny local relay pointing at their own `127.0.0.1:2942` and `Game.log`, streaming their ship class, shield %, hull %, fuel, combat state, quantum state, and planetary/station zone over WebSocket to your AETHER C2 hub.
- The 3D Hologram plots each ally dynamically around their current planetary body or station (with orbital motion, shield rings, red combat pulses, and quantum transit vectors).

---

## 5. Dual LLM Backend Strategy

| Backend | Endpoint | Strengths |
| :--- | :--- | :--- |
| **Player2** | `http://127.0.0.1:4315/v1/chat/completions` | Zero API key management for players; native game-companion ecosystem + built-in STT/TTS endpoints |
| **OpenRouter** | `https://openrouter.ai/api/v1/chat/completions` | Choice of frontier models (Claude, Gemini, GPT, DeepSeek) with full JSON tool-calling & high personality fidelity |
| **Demo Co-Pilot** | Built-in local fallback | Instant zero-config PoC testing of voice commands, RAG recall, jokes, and action safety gates |
