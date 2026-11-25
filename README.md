# AETHER — Star Citizen AI Companion & Holographic C2 Deck

> **AETHER** (*Autonomous Executive Telemetry & Holographic Engagement Relay*) is a Jarvis-style voice AI co-pilot, persistent RAG memory engine, and 3D Holographic Command & Control (C2) deck built for **Star Citizen**'s native local gRPC Telemetry API (`127.0.0.1:2942`).

---

## Key Capabilities

1. **Native Star Citizen Telemetry & Two-Way Actions (`127.0.0.1:2942`)**
   - Connects to `sc.game.telemetry.v1.GameTelemetryService` (4.10.x LIVE / 5.0 PTU) + `Game.log` events.
   - Streams ~17 Hz flight, shield, fuel, vitals, and ship state telemetry into a deterministic **Event Trigger Engine** so AETHER proactively speaks up when shields drop, fuel runs low, or combat starts.
   - Exposes `ListTriggerableActions` and `TriggerGameActions` as validated LLM tools with a **Safety Gate** (destructive actions like `eject` or `self_destruct` require explicit voice/UI confirmation).
   - Includes a **17 Hz Live Flight & Combat Simulator** so you can run and test the entire stack without Star Citizen open.

2. **Dual LLM Backends + Voice (STT / TTS)**
   - **Player2 Backend** (`http://127.0.0.1:4315`): Local companion API for LLM chat, tool calling, and voice.
   - **OpenRouter Backend** (`https://openrouter.ai/api/v1`): Access to Claude, Gemini, GPT, DeepSeek, Llama, and more with OpenAI-compatible tool calling.
   - **Offline Demo Co-Pilot**: Built-in deterministic co-pilot fallback so the PoC works out of the box with zero API keys.
   - **Speech-to-Text & Text-to-Speech**: Push-to-talk / browser Web Speech STT + audio-reactive TTS (with hooks for Player2 TTS).

3. **SPEC-912 / #884 Hardened SQLite Semantic RAG & Prompt Compiler**
   - Inspired by the AiLive Retrieval Compiler (`SPEC-912` & `#884` hardening):
   - **Three Distinct Authorities**:
     1. *World-State Authority*: Authoritative live gRPC telemetry + committed SQLite ledgers.
     2. *Decision Authority*: LLM chooses dialogue, humor, alerts, and proposed actions.
     3. *Transition Authority*: Deterministic validator + gRPC action executor records **truthful receipts** (never faking confirmation).
   - **Hybrid Retrieval**: SQLite FTS5 (**BM25**) + local semantic embeddings (**Cosine Similarity**) fused via **Reciprocal Rank Fusion (RRF)** with minimum relevance floors, deduplication, and token/character budgets.
   - **Prompt Injection Defense**: Untrusted user/chat/ally strings are sanitized at capture (stripping forged `[SYSTEM]`, `[RECEIPT]`, and role-override markers) and quarantined inside source-labeled `<retrieved_evidence>` data blocks with explicit truth classes (`authoritative_telemetry`, `committed_receipt`, `ally_relay`, `episodic_memory`, `lore_canon`, `user_claim`).

4. **Jarvis-Style 3D Animated Core & Holographic C2 Deck**
   - **3D Audio-Reactive AI Core**: Three.js wireframe neural sphere + orbital rings that pulse with TTS voice output and shift color by alert state (`NOMINAL`, `CAUTION`, `COMBAT`, `SPEAKING`, `HUMOR`).
   - **3D Holographic Command & Control Deck**:
     - **Stanton Fleet Hologram**: 3D planetary/orbital projection tracking your ship and allied fleet status (ship class, shields, hull, fuel, quantum state, combat alerts).
     - **Own-Ship Tactical View**: Live 3D attitude orientation (pitch/roll/yaw), shield quadrant arcs, speed, altitude, and fuel rings.
   - **Fleet Relay Architecture**: Because CIG restricts raw 3D coordinates of other players on a single client (anti-ESP), AETHER includes a lightweight companion relay (`relay/aether_relay.py`) that allies can run to stream their live ship/crew/zone status into your C2 hologram over WebSockets.

---

## Quick Start (Proof of Concept)

### 1. Backend (Python 3.12+)
```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8785
```

### 2. Frontend (Node 20+)
```powershell
cd frontend
npm install
npm run dev
```
Open **http://localhost:5173** in your browser (or wrap with Electron/Tauri for a dedicated second-monitor window).

### 3. Optional: Connect to Live Star Citizen Telemetry
Enable the local gRPC server in Star Citizen:
```cmd
setx GRPC_CLIENT_SERVER_ENABLED true
```
Or in Alpha 5.0 PTU console (`~`):
```text
server.game.telemetry.enabled 1
```
Then toggle **Telemetry Source -> Live gRPC (`127.0.0.1:2942`)** inside AETHER's Settings panel.

---

## Project Structure

```text
StarCitizen_AI_Manager/
├── README.md
├── docs/
│   └── ARCHITECTURE.md          # Full system design, SPEC-912 RAG compiler & C2 hologram spec
├── backend/
│   ├── requirements.txt
│   ├── app/
│   │   ├── main.py              # FastAPI + WebSockets (/ws/telemetry, /ws/fleet) + REST API
│   │   ├── config.py            # Runtime settings (Player2, OpenRouter, gRPC, Simulator)
│   │   ├── rag/
│   │   │   ├── sanitizer.py     # Prompt-injection defense & untrusted text quarantine
│   │   │   ├── embeddings.py    # Zero-dependency local semantic n-gram + optional API embedder
│   │   │   ├── store.py         # SQLite + FTS5 BM25 + Vector RRF Hybrid Memory Store
│   │   │   └── compiler.py      # SPEC-912 Prompt Compiler (authorities, budgets, provenance)
│   │   ├── telemetry/
│   │   │   ├── models.py        # Ship, player, ally, event & receipt Pydantic models
│   │   │   ├── triggers.py      # Deterministic 17Hz delta watcher -> proactive AI triggers
│   │   │   ├── actions.py       # Transition Authority: Action registry, safety gate & receipts
│   │   │   ├── grpc_bridge.py   # Star Citizen 127.0.0.1:2942 gRPC adapter + proto loader
│   │   │   └── simulator.py     # 17Hz live flight, combat & Stanton fleet simulator
│   │   └── llm/
│   │       └── router.py        # Unified Player2 + OpenRouter + Offline Demo LLM router
│   └── tests/
│       └── test_rag_and_actions.py  # Automated tests for RAG, injection defense & safety gates
├── relay/
│   └── aether_relay.py          # Lightweight ally telemetry relay for Fleet C2 Hologram
└── frontend/
    ├── package.json
    ├── vite.config.ts
    └── src/
        ├── App.tsx              # Main C2 Deck Layout + Voice STT/TTS + WebSocket client
        ├── components/
        │   ├── JarvisCore3D.tsx # Audio-reactive 3D Jarvis Hologram Face / Neural Core
        │   ├── HoloDeck3D.tsx   # 3D Stanton Fleet Hologram + Own-Ship Tactical Wireframe
        │   ├── CommsPanel.tsx   # Voice / Text Co-Pilot Chat & Action Execution Feed
        │   └── InspectorPanel.tsx # SQLite RAG Memory, Receipts & Backend Config panels
        └── types.ts
```

---

## Roadmap
- [x] **Phase 0 (PoC)**: FastAPI backend, SQLite Hybrid BM25+Vector RAG, prompt-injection sanitizer, SPEC-912 prompt compiler, Player2/OpenRouter router, 17 Hz simulator, 3D Jarvis core, 3D Stanton Fleet Hologram, Web Speech STT/TTS.
- [ ] **Phase 1**: Drop-in compiled `sc_telemetry_pb2.py` from live `StarCitizen.exe` 5.0 PTU (`sc_make_proto`) + `Game.log` tailer for zone/kill/death tracking.
- [ ] **Phase 2**: Electron / Tauri native desktop wrapper with global push-to-talk hotkey and transparent overlay mode.
- [ ] **Phase 3**: Authenticated org Fleet C2 relay server with encrypted squad channels and voice-pinned tactical markers.
