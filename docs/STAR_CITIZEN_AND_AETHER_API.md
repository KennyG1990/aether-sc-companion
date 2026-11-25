# Star Citizen Telemetry API & AETHER Companion API Reference

> **Canonical Reference Document** — Formatted for human inspection inside **AETHER Settings -> API Docs** AND automatically chunked into AETHER's SQLite Auto-RAG (`domain="api_canon"`, `truth_class="lore_canon"`) so you can ask AETHER directly about any endpoint, gRPC service, or exposed function.

---

## 1. Star Citizen Native Local gRPC Telemetry API (`127.0.0.1:2942`)

Cloud Imperium Games (CIG) embeds an official local gRPC server directly inside `StarCitizen.exe` (EAC-clean, zero memory reading, zero screen scraping).

- **Host / Port:** `127.0.0.1:2942` (loopback only)
- **Proto Package & Service:** `sc.game.telemetry.v1.GameTelemetryService`
- **Cadence:** ~17 Hz real-time state stream
- **How to Enable:**
  - **Alpha 4.10.x LIVE:** Run `setx GRPC_CLIENT_SERVER_ENABLED true` once in PowerShell before launching `StarCitizen.exe`.
  - **Alpha 5.0 PTU+:** Enable `server.game.telemetry.enabled 1` (or `GRPC_CLIENT_SERVER_ENABLED=true`).
- **Schema Extraction:** Extract compiled Python bindings (`sc_telemetry_pb2.py`, `sc_telemetry_pb2_grpc.py`) directly from your local `StarCitizen.exe` via `Purzifal/sc_make_proto`.

### Exposed Star Citizen gRPC Functions (RPCs)

| RPC Function | Availability | Purpose & Data Exposed |
| --- | --- | --- |
| `StreamTelemetry(TelemetryRequest) -> stream TelemetryFrame` | 4.10.x LIVE & 5.0+ | Streams live ~17 Hz ship flight dynamics (speed, vertical speed, radar altitude, pitch/roll/yaw, G-force), 4-quadrant shields (front/back/left/right), hull integrity, hydrogen & quantum fuel, Master Mode (`SCM` / `NAV`), landing gear, lights, VTOL, doors/ramps, quantum spooling, and pilot vitals (health, oxygen, hydration, hunger, heart rate, body temp, locomotion). |
| `ListTriggerableActions(Empty) -> ActionList` | 5.0 PTU+ | Queries the live list of action IDs currently permitted by the player's ship/seat state. |
| `TriggerGameActions(TriggerRequest) -> TriggerResponse` | 5.0 PTU+ | Executes validated cockpit and player actions natively inside `StarCitizen.exe` (landing gear, lights, doors/ramps, VTOL, Master Modes, quantum spool, ATC hail, etc.). |

### CIG Anti-ESP Boundaries
- Star Citizen's local gRPC API **never** exposes raw 3D coordinates of *other* players or hostile ships (anti-ESP protection).
- Cooperative friend tracking in AETHER solves this cleanly via consenting teammates running AETHER's **AES-256-GCM Encrypted Squad Lobbies** (sharing only their own verified game state).

---

## 2. AETHER Local Backend REST & WebSocket API (`http://127.0.0.1:8785`)

All endpoints run locally on `127.0.0.1:8785` (proxied by Vite at `http://localhost:5173/api` and `/ws`).

### 2.1 Health, Config & StarCitizen.exe Game Link

| Method & Route | Exposed Function & Behavior |
| --- | --- |
| `GET /api/health` | Returns backend version, active AI/pilot names, LLM/TTS providers, Player2 60s heartbeat state, gRPC status, memory count, and fleet count. |
| `GET /api/config` | Returns current non-secret configuration, `game_link` (Red/Yellow/Green `StarCitizen.exe` + `127.0.0.1:2942` status), `spotify_status`, `player2_status`, `persona`, and active `mood`. |
| `POST /api/config` | Saves local settings (`llm_provider`, `player2_model`, `openrouter_model`, `tts_provider`, `elevenlabs_voice_id`, `elevenlabs_model_id`, `telemetry_mode`, `star_citizen_exe_path`, `wake_word_enabled`, API keys) to gitignored `backend/data/aether_settings.json`. |
| `GET /api/game-link` | Polls Win32 `CreateToolhelp32Snapshot` for `StarCitizen.exe`, checks `GRPC_CLIENT_SERVER_ENABLED`, probes `127.0.0.1:2942`, and returns `state: "red" \| "yellow" \| "green"`. |
| `POST /api/game-link/test` | Previews `red` / `yellow` / `green` beacon transitions or returns to `auto` live `.exe` detection. |
| `GET /api/docs/reference` | Returns this formatted Star Citizen Telemetry & AETHER API Reference document (markdown + structured sections) for UI inspection. |

### 2.2 Conversational AI, Streaming & Mood

| Method & Route | Exposed Function & Behavior |
| --- | --- |
| `POST /api/chat/stream` | **Primary real-time SSE chat endpoint.** Compiles compact SPEC-416 v2 / SPEC-912 prompt with Living Personality + local RAG, executes tool calls in a single turn (`spoken_reply`), streams live `token` events, flushes `sentence` events for parallel ElevenLabs TTS, broadcasts instant `ui_command` packets, and returns final `done` metadata. |
| `POST /api/chat` | Non-streaming JSON equivalent of `/api/chat/stream` (used by automated test harness & scripts). |
| `POST /api/mood` | Updates AETHER's live orb emotional mood (`CALM`, `HAPPY`, `PLAYFUL`, `CURIOUS`, `FOCUSED`, `ALERT`, `SOLEMN`, `CALIBRATING`) and broadcasts `mood_update` to UI clients. |
| `POST /api/calibrate` | Runs the 5-step live hardware & systems Startup Calibration (Player2 Heartbeat/MCP -> ElevenLabs -> SQLite RAG -> Ship Telemetry -> Spoken LLM readiness report). |

### 2.3 Voice (ElevenLabs TTS & Player2 Whisper STT) & Player2 Compliance

| Method & Route | Exposed Function & Behavior |
| --- | --- |
| `GET /api/player2/status` | Probes Player2 Local API (`127.0.0.1:4315`), 60s heartbeat count, Joules balance, Patron tier, voice count, and local MCP (`127.0.0.1:9847/mcp`). |
| `POST /api/player2/heartbeat` | Manually triggers an official Player2 heartbeat (`GET /v1/health` with `player2-game-key: 01a21115-8912-7b68-a847-f7b8e80a6afc`). Also runs automatically every 60s. |
| `GET /api/llm/models` | Lists available LLM models from live Player2 catalog (`/v1/catalog/models?kind=llm`) or OpenRouter catalog. |
| `GET /api/tts/voices` | Lists live voices from either your **Own ElevenLabs Account** (`api.elevenlabs.io/v1/voices`) or **Player2 ElevenLabs Proxy** (106+ voices). |
| `POST /api/tts/speak` | Synthesizes spoken text into `audio/mpeg` MP3 bytes using the active ElevenLabs provider (`eleven_flash_v2_5` default) for Web Audio FFT orb visualization. |
| `POST /api/stt/transcribe` | Transcribes 16 kHz PCM WAV voice recordings via Player2 local Whisper (`/v1/stt/whisper/audio/transcriptions`). |
| `POST /api/stt/p2/start` & `POST /api/stt/p2/stop` | Starts/stops Player2 App's native OS microphone STT fallback with Star Citizen keyterms. |

### 2.4 Ship Actions, Safety Gate & Telemetry Streams

| Method & Route | Exposed Function & Behavior |
| --- | --- |
| `GET /api/actions` | Lists all triggerable ship actions (with `destructive` flags), recent Transition Authority SQLite receipts, and pending Safety Gate confirmations. |
| `POST /api/actions/execute` | Executes a validated ship action (`toggle_landing_gear`, `toggle_doors`, `toggle_lights`, `toggle_vtol`, `set_master_mode_scm`, `set_master_mode_nav`, `request_landing`, `spool_quantum`, `eject`, `self_destruct`). Destructive actions hold at the Safety Gate (`PENDING_CONFIRMATION`). |
| `POST /api/actions/confirm` | Approves or aborts a pending Safety Gate confirmation token (`CONFIRMED` or `REJECTED`) and logs a prose receipt. |
| `POST /api/scenario` | Triggers simulator test scenarios (`incoming_missile`, `radar_lock`, `ally_critical`, `combat_ambush`, `ally_distress`, `low_fuel`, `all_clear`). |
| `WS /ws/telemetry` | 17 Hz real-time WebSocket stream pushing `telemetry_frame` (ship vitals, shields, radar locks, incoming missiles, fleet allies, context-aware proactive alerts, `game_link`, `heartbeat`), `mood_update`, `ui_command`, and `calibration_progress`. |

### 2.5 Encrypted Private Squad Lobbies (`AES-256-GCM`, Pure Game State — Zero Chat)

| Method & Route | Exposed Function & Behavior |
| --- | --- |
| `GET /api/lobby/status` | Returns active encrypted lobby state, invite code (if active), peer count, sent/received/rejected packet counters, and connected peers. |
| `POST /api/lobby/create` | Generates a high-entropy invite code (`AETHER-XXXX-XXXX-XXXX`), derives a local `AES-256-GCM` key via `HKDF-SHA256`, and joins `/ws/lobby/{room_token}` as host. |
| `POST /api/lobby/join` | Joins a friend's encrypted squad lobby using their invite code + relay URL. Rejects invalid packets or unauthorized fields (`extra="forbid"`). |
| `POST /api/lobby/leave` | Disconnects from the squad lobby and wipes the local encryption key from memory. |
| `WS /ws/lobby/{room_token}` | Zero-knowledge relay hub: forwards opaque `AES-256-GCM` game-state ciphertexts between peers in the same room without ever seeing keys or plaintext. Shares **only** numeric/enum ship & vital states — zero chat, voice, or prompts. |
| `WS /ws/fleet` | Legacy local relay endpoint for `relay/aether_relay.py`. |

### 2.6 Auto-RAG Memory, Living Personality & Spotify Connector

| Method & Route | Exposed Function & Behavior |
| --- | --- |
| `GET /api/memories` & `POST /api/memories` | Lists/searches SQLite Hybrid BM25 + Vector RRF memories (`?q=...`, `?domain=...`) and security audit logs, or manually captures a prompt-injection-sanitized memory. |
| `GET /api/persona` & `POST /api/persona` | Reads or updates base persona profile (`ai_name`, `pilot_name`, `tone`, `verbosity`, `question_style`, `humor_style`, `custom_rules`). |
| `POST /api/persona/interview/complete` | Synthesizes a calibrated persona profile + spoken greeting from the 5-question Person-to-AI Personality Interview. |
| `GET /api/spotify/status`, `GET /api/spotify/auth/start`, `GET /api/spotify/callback`, `POST /api/spotify/action`, `POST /api/spotify/disconnect` | Dual-mode Spotify Connector: zero-setup Windows `spotify:search:` URI & virtual media keys + optional OAuth 2.0 PKCE Spotify Web API playback & volume control. |

---

## 3. AETHER Autonomous LLM Tool Functions (Voice-Executable)

These are the exact functions exposed directly to AETHER's LLM brain during conversation:

1. **`trigger_game_action(action_id, spoken_reply)`** — Executes validated Star Citizen ship actions (`toggle_landing_gear`, `toggle_doors`, `toggle_lights`, `toggle_vtol`, `set_master_mode_scm`, `set_master_mode_nav`, `request_landing`, `spool_quantum`, plus Safety-Gated `eject` & `self_destruct`).
2. **`save_memory(content, domain, spoken_reply)`** — Saves durable memories into SQLite. Using `domain="personality"` injects traits/rules directly into AETHER's core Living Personality prompt on every turn (and governs plain-speech & alert muting automatically).
3. **`change_voice(query, tts_provider, spoken_reply)`** — Searches live ElevenLabs / Player2 voices (accent, gender, name, or `choose_for_myself`) and switches voices on the fly so the very next reply speaks in the new voice.
4. **`control_hologram(action, target, steps, view_mode, spoken_reply)`** — Opens/closes the 3D Star Citizen Stanton Holo-Map, focuses your live ship grid (`focus_self`), snaps onto connected friends (`focus_ally`), focuses Stanton planets/moons (`focus_planet`), or progressively zooms in/out (`zoom_in`, `zoom_out`, `reset_view`).
5. **`control_settings(ui_action, tab, updates, spoken_reply)`** — Opens/closes the hidden Settings modal, navigates tabs (`config`, `persona`, `systems`, `rag`, `receipts`, `api`), and writes safe settings. **Immutable Safeguard (`BLOCKED_SAFEGUARD`):** strictly blocks modifying API keys, Player2 Mod ID/URLs, OAuth secrets, `grpc_target`, `db_path`, or `StarCitizen.exe`.
6. **`spotify_control(command, query, media_type, volume_pct, spoken_reply)`** — Launches Spotify and plays songs/artists/playlists or controls pause, resume, next, previous, volume, and now playing.
