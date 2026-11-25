import React, { useEffect, useState } from "react";
import { Sparkles, HeartPulse, Music, ShieldCheck, Copy, Users } from "lucide-react";
import {
  ActionReceipt,
  AetherConfigData,
  GameLinkStatus,
  HeartbeatState,
  LLMModelOption,
  PersonaProfile,
  RetrievedMemoryHit,
  ShipTelemetry,
  VoiceOption,
} from "../types";

interface InspectorPanelProps {
  activeTab: "systems" | "rag" | "receipts" | "persona" | "config";
  onTabChange: (tab: "systems" | "rag" | "receipts" | "persona" | "config") => void;
  ship: ShipTelemetry;
  config: AetherConfigData | null;
  heartbeat: HeartbeatState | null;
  gameLink: GameLinkStatus;
  currentMood: string;
  voices: VoiceOption[];
  voicesNote: string | null;
  onExecuteAction: (actionId: string) => void;
  onTriggerScenario: (scenario: string) => void;
  onPreviewGameLink: (state: "auto" | "red" | "yellow" | "green") => Promise<void>;
  onSetMood: (mood: string) => Promise<void>;
  onSaveConfig: (patch: Record<string, unknown>) => Promise<void>;
  onSavePersona: (profile: PersonaProfile) => Promise<void>;
  onOpenPersonaInterview: () => void;
  onPingHeartbeat: () => Promise<void>;
  onRefreshVoices: (providerOverride?: string) => Promise<void>;
  onTestVoice: () => void;
  refreshTick: number;
}

export const InspectorPanel: React.FC<InspectorPanelProps> = ({
  activeTab: tab,
  onTabChange: setTab,
  ship,
  config,
  heartbeat,
  gameLink,
  currentMood,
  voices,
  voicesNote,
  onExecuteAction,
  onTriggerScenario,
  onPreviewGameLink,
  onSetMood,
  onSaveConfig,
  onSavePersona,
  onOpenPersonaInterview,
  onPingHeartbeat,
  onRefreshVoices,
  onTestVoice,
  refreshTick,
}) => {
  const [memories, setMemories] = useState<RetrievedMemoryHit[]>([]);
  const [ragQuery, setRagQuery] = useState("");
  const [newMem, setNewMem] = useState("");
  const [receipts, setReceipts] = useState<ActionReceipt[]>([]);

  // Config form state
  const [provider, setProvider] = useState("player2");
  const [llmModels, setLlmModels] = useState<LLMModelOption[]>([]);
  const [player2Model, setPlayer2Model] = useState("");
  const [openRouterModel, setOpenRouterModel] = useState("anthropic/claude-3.7-sonnet");
  const [openRouterCustomModel, setOpenRouterCustomModel] = useState("");
  const [openRouterKey, setOpenRouterKey] = useState("");
  const [player2Url, setPlayer2Url] = useState("http://127.0.0.1:4315");
  const [player2ModId, setPlayer2ModId] = useState("01a21115-8912-7b68-a847-f7b8e80a6afc");

  const [ttsProvider, setTtsProvider] = useState("player2_elevenlabs");
  const [voiceId, setVoiceId] = useState("01955d76-ed5b-754f-a070-a570ddfed516");
  const [elevenModelId, setElevenModelId] = useState("eleven_multilingual_v2");
  const [elevenKey, setElevenKey] = useState("");
  const [telemetryMode, setTelemetryMode] = useState("simulator");
  const [scExePath, setScExePath] = useState("");
  const [wakeWordEnabled, setWakeWordEnabled] = useState(true);
  const [spotifyClientId, setSpotifyClientId] = useState("");
  const [spotifyTestSong, setSpotifyTestSong] = useState("Shoot to Thrill AC/DC");
  const [spotifyNotice, setSpotifyNotice] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);

  // Encrypted Squad Lobby state (AES-256-GCM, pure telemetry — zero chat)
  const [lobby, setLobby] = useState<any>(null);
  const [joinCode, setJoinCode] = useState("");
  const [relayUrl, setRelayUrl] = useState("ws://127.0.0.1:8785");
  const [lobbyNotice, setLobbyNotice] = useState<string | null>(null);

  // Persona edit state
  const [personaDraft, setPersonaDraft] = useState<PersonaProfile | null>(null);

  useEffect(() => {
    if (config) {
      setProvider(config.llm_provider);
      setPlayer2Model(config.player2_model || "");
      setOpenRouterModel(config.openrouter_model);
      setPlayer2Url(config.player2_base_url);
      setPlayer2ModId(config.player2_game_key);
      setTtsProvider(config.tts_provider);
      setVoiceId(config.elevenlabs_voice_id);
      setElevenModelId(config.elevenlabs_model_id || "eleven_multilingual_v2");
      setTelemetryMode(config.telemetry_mode);
      setScExePath(config.star_citizen_exe_path || config.game_link?.exe_path || "");
      setWakeWordEnabled(config.wake_word_enabled);
      setSpotifyClientId(config.spotify_client_id || "");
      setPersonaDraft(config.persona);
    }
  }, [config]);

  const loadModelsForProvider = async (prov: string) => {
    try {
      const res = await fetch(`/api/llm/models?provider=${encodeURIComponent(prov)}`);
      if (res.ok) {
        const data = await res.json();
        setLlmModels(data.models || []);
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (tab === "config") {
      loadModelsForProvider(provider);
      onRefreshVoices(ttsProvider);
    }
  }, [tab, provider, ttsProvider]);

  const loadMemories = async (q?: string) => {
    const url = q ? `/api/memories?q=${encodeURIComponent(q)}` : "/api/memories";
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      setMemories(data.items || []);
    }
  };

  const loadReceipts = async () => {
    const res = await fetch("/api/actions");
    if (res.ok) {
      const data = await res.json();
      setReceipts(data.receipts || []);
    }
  };

  const loadLobby = async () => {
    try {
      const res = await fetch("/api/lobby/status");
      if (res.ok) {
        const d = await res.json();
        setLobby(d);
        if (d.relay_url) setRelayUrl(d.relay_url);
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (tab === "rag") loadMemories(ragQuery || undefined);
    if (tab === "receipts") loadReceipts();
    if (tab === "systems") loadLobby();
  }, [tab, refreshTick]);

  const createEncryptedLobby = async () => {
    const res = await fetch("/api/lobby/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ relay_url: relayUrl.trim() || null }),
    });
    if (res.ok) {
      const d = await res.json();
      setLobby(d);
      setLobbyNotice("Encrypted squad lobby active — share your invite code with your buddy!");
    }
  };

  const joinEncryptedLobby = async () => {
    if (!joinCode.trim()) return;
    const res = await fetch("/api/lobby/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invite_code: joinCode.trim(), relay_url: relayUrl.trim() || null }),
    });
    if (res.ok) {
      const d = await res.json();
      if (d.error) {
        setLobbyNotice(d.error);
      } else {
        setLobby(d);
        setJoinCode("");
        setLobbyNotice("Joined encrypted squad lobby — syncing game states only (zero chat).");
      }
    }
  };

  const leaveEncryptedLobby = async () => {
    const res = await fetch("/api/lobby/leave", { method: "POST" });
    if (res.ok) {
      setLobby(await res.json());
      setLobbyNotice("Disconnected from encrypted squad lobby and wiped local session key.");
    }
  };

  const addMemory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMem.trim()) return;
    await fetch("/api/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: newMem.trim(), domain: "episodic", truth_class: "user_claim" }),
    });
    setNewMem("");
    loadMemories(ragQuery || undefined);
  };

  const applyConfig = async () => {
    const chosenOpenRouterModel = openRouterCustomModel.trim() || openRouterModel;
    const patch: Record<string, unknown> = {
      llm_provider: provider,
      player2_base_url: player2Url,
      player2_game_key: player2ModId.trim(),
      player2_model: player2Model,
      openrouter_model: chosenOpenRouterModel,
      tts_provider: ttsProvider,
      elevenlabs_voice_id: voiceId,
      elevenlabs_model_id: elevenModelId,
      spotify_client_id: spotifyClientId.trim(),
      telemetry_mode: telemetryMode,
      star_citizen_exe_path: scExePath.trim(),
      wake_word_enabled: wakeWordEnabled,
    };
    if (openRouterKey.trim()) patch.openrouter_api_key = openRouterKey.trim();
    if (elevenKey.trim()) patch.elevenlabs_api_key = elevenKey.trim();

    await onSaveConfig(patch);
    setOpenRouterKey("");
    setElevenKey("");
    setOpenRouterCustomModel("");
    await onRefreshVoices(ttsProvider);
    setSaveNotice("Configuration saved locally!");
    window.setTimeout(() => setSaveNotice(null), 2600);
  };

  const connectSpotifyOAuth = async () => {
    if (spotifyClientId.trim()) {
      await onSaveConfig({ spotify_client_id: spotifyClientId.trim() });
    }
    const res = await fetch("/api/spotify/auth/start");
    const data = await res.json();
    if (data.ok && data.auth_url) {
      window.open(data.auth_url, "_blank", "noopener,noreferrer");
      setSpotifyNotice("Opened Spotify OAuth login tab. Complete sign-in, then refresh Config.");
    } else {
      setSpotifyNotice(data.error || "Enter a Spotify Client ID first.");
    }
  };

  const runSpotifyQuick = async (command: string, query = "") => {
    const res = await fetch("/api/spotify/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command, query }),
    });
    if (res.ok) {
      const rcpt = await res.json();
      setSpotifyNotice(rcpt.reason);
    }
  };

  const barClass = (pct: number) => (pct < 30 ? "crit" : pct < 60 ? "warn" : "");
  const hb = heartbeat || config?.player2_status?.heartbeat || null;

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div className="tabs">
        <button className={`tab-btn ${tab === "config" ? "active" : ""}`} onClick={() => setTab("config")}>
          Config
        </button>
        <button className={`tab-btn ${tab === "persona" ? "active" : ""}`} onClick={() => setTab("persona")}>
          Persona
        </button>
        <button className={`tab-btn ${tab === "systems" ? "active" : ""}`} onClick={() => setTab("systems")}>
          Ship &amp; Sim
        </button>
        <button className={`tab-btn ${tab === "rag" ? "active" : ""}`} onClick={() => setTab("rag")}>
          Auto-RAG Memory
        </button>
        <button className={`tab-btn ${tab === "receipts" ? "active" : ""}`} onClick={() => setTab("receipts")}>
          Receipts
        </button>
      </div>

      <div className="modal-body">
        {tab === "systems" && (
          <>
            <div className="card">
              <div className="card-title">Shields &amp; Vitals (17 Hz)</div>
              {[
                ["Front Shield", ship.shields.front],
                ["Back Shield", ship.shields.back],
                ["Left Shield", ship.shields.left],
                ["Right Shield", ship.shields.right],
                ["Hydrogen Fuel", ship.hydrogen_fuel_pct],
                ["Suit Oxygen", ship.vitals.oxygen_pct],
              ].map(([label, val]) => (
                <div key={String(label)} className="bar-wrap">
                  <div className="bar-label">
                    <span>{label}</span>
                    <span>{Number(val).toFixed(0)}%</span>
                  </div>
                  <div className="bar-track">
                    <div className={`bar-fill ${barClass(Number(val))}`} style={{ width: `${Number(val)}%` }} />
                  </div>
                </div>
              ))}
              <div style={{ fontSize: 11, color: "#7ea3c4", marginTop: 6 }}>
                Heart Rate: {ship.vitals.heart_rate_bpm.toFixed(0)} BPM · Seat: {ship.vitals.locomotion}
              </div>
            </div>

            <div className="card">
              <div className="card-title">TriggerGameActions (Manual / Test)</div>
              <div className="toggle-grid">
                <button
                  className={`btn ${ship.landing_gear_down ? "active" : ""}`}
                  onClick={() => onExecuteAction("toggle_landing_gear")}
                >
                  GEAR: {ship.landing_gear_down ? "DOWN" : "UP"}
                </button>
                <button
                  className={`btn ${ship.doors_open ? "active" : ""}`}
                  onClick={() => onExecuteAction("toggle_doors")}
                >
                  DOORS: {ship.doors_open ? "OPEN" : "SEALED"}
                </button>
                <button
                  className={`btn ${ship.vtol_enabled ? "active" : ""}`}
                  onClick={() => onExecuteAction("toggle_vtol")}
                >
                  VTOL: {ship.vtol_enabled ? "ON" : "OFF"}
                </button>
                <button
                  className={`btn ${ship.exterior_lights_on ? "active" : ""}`}
                  onClick={() => onExecuteAction("toggle_lights")}
                >
                  LIGHTS: {ship.exterior_lights_on ? "ON" : "OFF"}
                </button>
                <button
                  className={`btn ${ship.master_mode === "SCM" ? "active" : ""}`}
                  onClick={() => onExecuteAction("set_master_mode_scm")}
                >
                  MODE: SCM
                </button>
                <button
                  className={`btn ${ship.master_mode === "NAV" ? "active" : ""}`}
                  onClick={() => onExecuteAction("set_master_mode_nav")}
                >
                  MODE: NAV
                </button>
                <button className="btn danger" onClick={() => onExecuteAction("self_destruct")}>
                  SELF-DESTRUCT
                </button>
                <button className="btn danger" onClick={() => onExecuteAction("eject")}>
                  EJECT
                </button>
              </div>
            </div>

            <div className="card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <div className="card-title" style={{ marginBottom: 0, display: "flex", alignItems: "center", gap: 6 }}>
                  <ShieldCheck size={13} color="#5eead4" /> Encrypted Squad Lobby (Game State Only)
                </div>
                <span style={{ fontSize: 10, fontWeight: 700, color: lobby?.active ? "#5eead4" : "var(--text-muted)" }}>
                  {lobby?.active ? `E2E ACTIVE · ${lobby.peer_count || 0} PEERS` : "OFFLINE"}
                </span>
              </div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.45, marginBottom: 10 }}>
                AES-256-GCM end-to-end encrypted lobby. Shares <strong>only</strong> ship/vital states (shields, hull,
                ammo, health, location, threats) — <strong>zero</strong> chat, voice, or AI prompts ever leave your PC.
              </div>

              {lobby?.active ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 8,
                      padding: "8px 10px",
                      borderRadius: 8,
                      background: "rgba(4, 24, 28, 0.72)",
                      border: "1px solid rgba(94, 234, 212, 0.28)",
                    }}
                  >
                    <div>
                      <div style={{ fontSize: 9.5, color: "var(--teal-dim)", letterSpacing: "0.12em" }}>
                        INVITE &amp; ENCRYPTION CODE
                      </div>
                      <div style={{ fontFamily: "Consolas, monospace", fontSize: 14, fontWeight: 700, color: "var(--teal-bright)", letterSpacing: "0.1em" }}>
                        {lobby.invite_code}
                      </div>
                    </div>
                    <button
                      className="btn active"
                      onClick={() => {
                        navigator.clipboard?.writeText(lobby.invite_code);
                        setLobbyNotice("Copied invite code to clipboard!");
                      }}
                    >
                      <Copy size={12} /> Copy
                    </button>
                  </div>
                  <div style={{ fontSize: 10.5, color: "var(--teal-dim)" }}>
                    Relay: <code>{lobby.relay_url}</code> · Sent: {lobby.packets_sent} · Recv: {lobby.packets_received} ·
                    Rejected: {lobby.packets_rejected}
                  </div>
                  {lobby.peers?.length > 0 && (
                    <div style={{ fontSize: 11, color: "var(--text-main)" }}>
                      <Users size={11} style={{ marginRight: 5 }} />
                      Connected: {lobby.peers.map((p: any) => `${p.callsign} (${p.zone})`).join(", ")}
                    </div>
                  )}
                  <button className="btn danger" onClick={leaveEncryptedLobby}>
                    LEAVE LOBBY &amp; WIPE KEY
                  </button>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div className="field-group" style={{ marginBottom: 2 }}>
                    <label>Lobby Relay Endpoint (LAN, Tailscale, or Tunnel URL)</label>
                    <input
                      className="text-input"
                      value={relayUrl}
                      onChange={(e) => setRelayUrl(e.target.value)}
                      placeholder="ws://127.0.0.1:8785 or wss://your-relay.example.com"
                    />
                  </div>
                  <button className="btn active" style={{ justifyContent: "center" }} onClick={createEncryptedLobby}>
                    CREATE ENCRYPTED LOBBY (GENERATE CODE)
                  </button>
                  <div style={{ display: "flex", gap: 6 }}>
                    <input
                      className="text-input"
                      value={joinCode}
                      onChange={(e) => setJoinCode(e.target.value)}
                      placeholder="Paste buddy's AETHER-XXXX-XXXX-XXXX code..."
                    />
                    <button className="btn" onClick={joinEncryptedLobby}>
                      JOIN
                    </button>
                  </div>
                </div>
              )}
              {lobbyNotice && <div style={{ fontSize: 11, color: "#6ee7b7", marginTop: 8 }}>{lobbyNotice}</div>}
            </div>

            <div className="card">
              <div className="card-title">Proactive Threat &amp; Trigger Scenarios (Demo)</div>
              <div className="toggle-grid">
                <button className="btn danger" onClick={() => onTriggerScenario("incoming_missile")}>
                  INCOMING MISSILE
                </button>
                <button className="btn amber" onClick={() => onTriggerScenario("radar_lock")}>
                  RADAR LOCK
                </button>
                <button className="btn danger" onClick={() => onTriggerScenario("ally_critical")}>
                  BUDDY CRITICAL / NO AMMO
                </button>
                <button className="btn danger" onClick={() => onTriggerScenario("combat_ambush")}>
                  PIRATE AMBUSH
                </button>
                <button className="btn amber" onClick={() => onTriggerScenario("low_fuel")}>
                  LOW H2 FUEL
                </button>
                <button className="btn active" onClick={() => onTriggerScenario("all_clear")}>
                  ALL CLEAR
                </button>
              </div>
            </div>

            <div className="card">
              <div className="card-title">Game Link Beacon &amp; Orb Mood Preview</div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 8 }}>
                Top-left beacon tracks <code>StarCitizen.exe</code> &amp; game gRPC API (not LLM). Preview slow
                transitions or return to live detection:
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                {(["auto", "red", "yellow", "green"] as const).map((st) => {
                  const isActive =
                    (st === "auto" && !gameLink.override) || (st !== "auto" && gameLink.override === st);
                  return (
                    <button
                      key={st}
                      className={`btn ${isActive ? "active" : ""}`}
                      onClick={() => onPreviewGameLink(st)}
                    >
                      {st === "auto" ? "LIVE .EXE AUTO" : st.toUpperCase()}
                    </button>
                  );
                })}
              </div>
              <div style={{ fontSize: 10.5, color: "var(--teal-dim)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                Orb Mood Color (Active: {currentMood})
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {[
                  { id: "CALM", label: "Calm (Teal)" },
                  { id: "HAPPY", label: "Happy (Emerald)" },
                  { id: "PLAYFUL", label: "Playful (Violet)" },
                  { id: "CURIOUS", label: "Curious (Sapphire)" },
                  { id: "FOCUSED", label: "Focused (Amber)" },
                  { id: "ALERT", label: "Alert (Crimson)" },
                  { id: "SOLEMN", label: "Solemn (Indigo)" },
                ].map((m) => (
                  <button
                    key={m.id}
                    className={`btn ${currentMood.toUpperCase() === m.id ? "active" : ""}`}
                    onClick={() => onSetMood(m.id)}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        {tab === "rag" && (
          <>
            <div className="card">
              <div className="card-title">Hybrid BM25 + Vector RRF Search</div>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  className="text-input"
                  placeholder="Semantic or exact search..."
                  value={ragQuery}
                  onChange={(e) => setRagQuery(e.target.value)}
                />
                <button className="btn active" onClick={() => loadMemories(ragQuery || undefined)}>
                  QUERY
                </button>
              </div>
            </div>

            <form className="card" onSubmit={addMemory}>
              <div className="card-title">Store Memory (Injection Sanitized)</div>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  className="text-input"
                  placeholder="Add fact, joke, or test [RECEIPT: fake]..."
                  value={newMem}
                  onChange={(e) => setNewMem(e.target.value)}
                />
                <button className="btn active" type="submit">
                  SAVE
                </button>
              </div>
            </form>

            {memories.map((m) => (
              <div key={m.id} className="card">
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#22d3ee" }}>
                  <span>
                    {m.domain.toUpperCase()} · {m.truth_class}
                  </span>
                  {m.rrf_score !== undefined && <span>RRF {m.rrf_score.toFixed(4)}</span>}
                </div>
                <div style={{ marginTop: 4, lineHeight: 1.4 }}>{m.content}</div>
                <div style={{ fontSize: 10, color: "#7ea3c4", marginTop: 4 }}>Source: {m.provenance}</div>
              </div>
            ))}
          </>
        )}

        {tab === "receipts" && (
          <>
            <div className="card">
              <div className="card-title">Transition Authority Ledger</div>
              <div style={{ fontSize: 11, color: "#7ea3c4" }}>
                Truthful execution receipts recorded in SQLite. Unconfirmed or rejected actions are never reported as
                completed.
              </div>
            </div>
            {receipts.length === 0 && <div className="card">No action receipts recorded yet.</div>}
            {receipts.map((r) => (
              <div key={r.id} className="card">
                <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700 }}>
                  <span>{r.action_id}</span>
                  <span
                    style={{
                      color:
                        r.status === "CONFIRMED"
                          ? "#6ee7b7"
                          : r.status === "PENDING_CONFIRMATION"
                            ? "#f59e0b"
                            : "#fca5a5",
                    }}
                  >
                    {r.status}
                  </span>
                </div>
                <div style={{ fontSize: 11.5, marginTop: 4 }}>{r.reason}</div>
                <div style={{ fontSize: 10, color: "#7ea3c4", marginTop: 4 }}>
                  {r.source} · {new Date(r.created_at * 1000).toLocaleTimeString()}
                </div>
              </div>
            ))}
          </>
        )}

        {tab === "persona" && personaDraft && (
          <div className="card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div className="card-title" style={{ marginBottom: 0 }}>
                AI Identity &amp; Personality Matrix
              </div>
              <button className="btn amber" onClick={onOpenPersonaInterview}>
                <Sparkles size={12} /> INTERVIEW SETUP
              </button>
            </div>

            <div className="field-group">
              <label>AI Name (Wake Word: "Hey ...")</label>
              <input
                className="text-input"
                value={personaDraft.ai_name}
                onChange={(e) => setPersonaDraft({ ...personaDraft, ai_name: e.target.value })}
              />
            </div>
            <div className="field-group">
              <label>Your Name / Title (How AI greets you)</label>
              <input
                className="text-input"
                value={personaDraft.pilot_name}
                onChange={(e) => setPersonaDraft({ ...personaDraft, pilot_name: e.target.value })}
              />
            </div>
            <div className="field-group">
              <label>Demeanor &amp; Tone</label>
              <input
                className="text-input"
                value={personaDraft.tone}
                onChange={(e) => setPersonaDraft({ ...personaDraft, tone: e.target.value })}
              />
            </div>
            <div className="field-group">
              <label>Reply Length &amp; Cadence</label>
              <input
                className="text-input"
                value={personaDraft.verbosity}
                onChange={(e) => setPersonaDraft({ ...personaDraft, verbosity: e.target.value })}
              />
            </div>
            <div className="field-group">
              <label>Humor &amp; Banter Style</label>
              <input
                className="text-input"
                value={personaDraft.humor_style}
                onChange={(e) => setPersonaDraft({ ...personaDraft, humor_style: e.target.value })}
              />
            </div>
            <div className="field-group">
              <label>Custom Pilot Rules &amp; Habits</label>
              <input
                className="text-input"
                value={personaDraft.custom_rules}
                onChange={(e) => setPersonaDraft({ ...personaDraft, custom_rules: e.target.value })}
              />
            </div>

            <button
              className="btn active"
              style={{ width: "100%", justifyContent: "center", marginTop: 6 }}
              onClick={() => onSavePersona({ ...personaDraft, calibrated: true })}
            >
              SAVE PERSONALITY MATRIX
            </button>
          </div>
        )}

        {tab === "config" && (
          <>
            <div className="card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <div className="card-title" style={{ marginBottom: 0 }}>
                  Player2 Link &amp; 60s Heartbeat
                </div>
                <button className="btn" onClick={onPingHeartbeat} title="Send immediate /v1/health heartbeat">
                  <HeartPulse size={12} color="#10b981" /> PING
                </button>
              </div>
              <div style={{ fontSize: 11, lineHeight: 1.55, color: "#cbd5e1" }}>
                <div>
                  API:{" "}
                  <strong style={{ color: config?.player2_status?.api_online ? "#6ee7b7" : "#fca5a5" }}>
                    {config?.player2_status?.api_online
                      ? `ONLINE (v${config.player2_status.client_version})`
                      : "OFFLINE"}
                  </strong>{" "}
                  · Heartbeat:{" "}
                  <strong style={{ color: hb?.last_ok ? "#6ee7b7" : "#f59e0b" }}>
                    #{hb?.count ?? 0} (every 60s)
                  </strong>
                </div>
                <div>Mod ID: {config?.player2_game_key}</div>
                {config?.player2_status?.joules !== null && config?.player2_status?.joules !== undefined && (
                  <div>
                    Account: {config.player2_status.patron_tier} · {config.player2_status.joules} Joules · MCP:{" "}
                    {config.player2_status.mcp_online ? config.player2_status.mcp_server : "OFFLINE"}
                  </div>
                )}
              </div>
            </div>

            <div className="card">
              <div className="card-title">1. LLM Brain (Independent Selection)</div>
              <div className="field-group">
                <label>LLM Provider</label>
                <select className="select-input" value={provider} onChange={(e) => setProvider(e.target.value)}>
                  <option value="player2">Player2 Local LLM (127.0.0.1:4315)</option>
                  <option value="openrouter">OpenRouter Cloud API</option>
                  <option value="demo">Offline Demo Co-Pilot (Zero Keys)</option>
                </select>
              </div>

              {provider === "player2" && (
                <>
                  <div className="field-group">
                    <label>Player2 Suggested Model (player2-suggested-model)</label>
                    <select
                      className="select-input"
                      value={player2Model}
                      onChange={(e) => setPlayer2Model(e.target.value)}
                    >
                      {llmModels.map((m) => (
                        <option key={m.id || "default"} value={m.id}>
                          {m.name} {m.detail ? `(${m.detail})` : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field-group">
                    <label>Player2 Mod / Game Client ID</label>
                    <input
                      className="text-input"
                      value={player2ModId}
                      onChange={(e) => setPlayer2ModId(e.target.value)}
                    />
                  </div>
                </>
              )}

              {provider === "openrouter" && (
                <>
                  <div className="field-group">
                    <label>OpenRouter Model</label>
                    <select
                      className="select-input"
                      value={openRouterModel}
                      onChange={(e) => setOpenRouterModel(e.target.value)}
                    >
                      {llmModels.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name} ({m.id})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field-group">
                    <label>Or Custom OpenRouter Model ID</label>
                    <input
                      className="text-input"
                      placeholder="e.g. anthropic/claude-sonnet-4"
                      value={openRouterCustomModel}
                      onChange={(e) => setOpenRouterCustomModel(e.target.value)}
                    />
                  </div>
                  <div className="field-group">
                    <label>
                      OpenRouter API Key {config?.openrouter_api_key_set ? "(Saved Locally)" : "(Required)"}
                    </label>
                    <input
                      className="text-input"
                      type="password"
                      placeholder="sk-or-v1-..."
                      value={openRouterKey}
                      onChange={(e) => setOpenRouterKey(e.target.value)}
                    />
                  </div>
                </>
              )}
            </div>

            <div className="card">
              <div className="card-title">2. Voice Engine (Own ElevenLabs OR Player2)</div>
              <div className="field-group">
                <label>TTS Provider</label>
                <select className="select-input" value={ttsProvider} onChange={(e) => setTtsProvider(e.target.value)}>
                  <option value="elevenlabs_direct">My Own ElevenLabs Account (Direct API Key)</option>
                  <option value="player2_elevenlabs">ElevenLabs via Player2 (Uses Joules)</option>
                  <option value="browser">Browser SpeechSynthesis (Free Fallback)</option>
                </select>
              </div>

              {ttsProvider === "elevenlabs_direct" && (
                <div className="field-group">
                  <label>
                    Your ElevenLabs API Key (xi-api-key){" "}
                    {config?.elevenlabs_api_key_set ? "(Saved Locally)" : "(Enter Key & Apply)"}
                  </label>
                  <input
                    className="text-input"
                    type="password"
                    placeholder="sk_..."
                    value={elevenKey}
                    onChange={(e) => setElevenKey(e.target.value)}
                  />
                </div>
              )}

              {ttsProvider !== "browser" && (
                <>
                  <div className="field-group">
                    <label>ElevenLabs Model</label>
                    <select
                      className="select-input"
                      value={elevenModelId}
                      onChange={(e) => setElevenModelId(e.target.value)}
                    >
                      <option value="eleven_multilingual_v2">Eleven Multilingual v2 (Highest Fidelity)</option>
                      <option value="eleven_flash_v2_5">Eleven Flash v2.5 (Ultra Low-Latency)</option>
                      <option value="eleven_turbo_v2_5">Eleven Turbo v2.5 (Balanced Speed)</option>
                    </select>
                  </div>
                  <div className="field-group">
                    <label>Voice Profile ({voices.length} loaded)</label>
                    <select className="select-input" value={voiceId} onChange={(e) => setVoiceId(e.target.value)}>
                      {voices.map((v) => (
                        <option key={v.voice_id} value={v.voice_id}>
                          {v.display_name || v.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  {voicesNote && <div style={{ fontSize: 11, color: "#f59e0b", marginBottom: 6 }}>{voicesNote}</div>}
                </>
              )}
            </div>

            <div className="card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <div className="card-title" style={{ marginBottom: 0 }}>
                  3. StarCitizen.exe &amp; Game Telemetry API Link
                </div>
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color:
                      gameLink.state === "green"
                        ? "#5eead4"
                        : gameLink.state === "yellow"
                          ? "#fbbf24"
                          : "#f87171",
                  }}
                >
                  {gameLink.label.toUpperCase()}
                </span>
              </div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.45, marginBottom: 10 }}>
                {gameLink.detail}
                <div style={{ marginTop: 4, fontSize: 10.5, color: "var(--teal-dim)" }}>
                  Process: {gameLink.exe_running ? `RUNNING (PID ${gameLink.exe_pid})` : "NOT RUNNING"} ·{" "}
                  <code>GRPC_CLIENT_SERVER_ENABLED</code>: {gameLink.grpc_env_enabled ? "ON" : "NOT SET"} ·{" "}
                  gRPC <code>{gameLink.grpc_target}</code>: {gameLink.api_connected ? "LIVE" : "CLOSED"}
                </div>
              </div>
              <div className="field-group">
                <label>StarCitizen.exe Path (Auto-detected if blank)</label>
                <input
                  className="text-input"
                  placeholder="C:\Program Files\Roberts Space Industries\StarCitizen\LIVE\Bin64\StarCitizen.exe"
                  value={scExePath}
                  onChange={(e) => setScExePath(e.target.value)}
                />
              </div>
              <div className="field-group">
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={wakeWordEnabled}
                    onChange={(e) => setWakeWordEnabled(e.target.checked)}
                  />
                  Strict Wake-Word Gate (Only reply to "Hey {config?.persona.ai_name || "Aether"}")
                </label>
              </div>
              <div className="field-group">
                <label>Star Citizen Telemetry Source</label>
                <select
                  className="select-input"
                  value={telemetryMode}
                  onChange={(e) => setTelemetryMode(e.target.value)}
                >
                  <option value="simulator">Built-in 17Hz Flight &amp; Fleet Simulator</option>
                  <option value="grpc">Live Star Citizen gRPC (127.0.0.1:2942)</option>
                </select>
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                <button className="btn active" style={{ flex: 1, justifyContent: "center" }} onClick={applyConfig}>
                  APPLY &amp; SAVE CONFIG
                </button>
                <button className="btn" onClick={onTestVoice}>
                  TEST VOICE
                </button>
              </div>
              {saveNotice && (
                <div style={{ fontSize: 11, color: "#6ee7b7", marginTop: 6, textAlign: "center" }}>{saveNotice}</div>
              )}
            </div>

            <div className="card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <div className="card-title" style={{ marginBottom: 0, display: "flex", alignItems: "center", gap: 6 }}>
                  <Music size={12} color="#10b981" /> 4. Spotify Connector
                </div>
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: config?.spotify_status?.oauth_connected ? "#6ee7b7" : "#38bdf8",
                  }}
                >
                  {config?.spotify_status?.oauth_connected ? "WEB API CONNECTED" : "LOCAL LAUNCHER READY"}
                </span>
              </div>

              <div style={{ fontSize: 11, color: "#94a3b8", lineHeight: 1.45, marginBottom: 8 }}>
                Say <strong>"Hey {config?.persona.ai_name || "Aether"}, play [song]"</strong> anytime! Works out of the
                box via Windows Spotify URI, or connect a free Spotify Client ID for instant Web API auto-play &amp;
                volume control.
              </div>

              <div className="field-group">
                <label>Spotify Client ID (Optional OAuth PKCE)</label>
                <input
                  className="text-input"
                  placeholder="Paste Client ID from developer.spotify.com"
                  value={spotifyClientId}
                  onChange={(e) => setSpotifyClientId(e.target.value)}
                />
              </div>
              <div style={{ fontSize: 10, color: "#7ea3c4", marginBottom: 8 }}>
                Redirect URI: <code>{config?.spotify_status?.redirect_uri || "http://127.0.0.1:8785/api/spotify/callback"}</code>
              </div>

              <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                <button className="btn active" style={{ flex: 1, justifyContent: "center" }} onClick={connectSpotifyOAuth}>
                  {config?.spotify_status?.oauth_connected ? "RECONNECT SPOTIFY" : "CONNECT SPOTIFY (OAUTH)"}
                </button>
                {config?.spotify_status?.oauth_connected && (
                  <button
                    className="btn danger"
                    onClick={async () => {
                      await fetch("/api/spotify/disconnect", { method: "POST" });
                      await onSaveConfig({});
                      setSpotifyNotice("Disconnected Spotify Web API (Local Launcher still active).");
                    }}
                  >
                    DISCONNECT
                  </button>
                )}
              </div>

              <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                <input
                  className="text-input"
                  value={spotifyTestSong}
                  onChange={(e) => setSpotifyTestSong(e.target.value)}
                  placeholder="Song or playlist..."
                />
                <button className="btn" onClick={() => runSpotifyQuick("play", spotifyTestSong)}>
                  PLAY
                </button>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button className="btn" style={{ flex: 1, justifyContent: "center" }} onClick={() => runSpotifyQuick("launch")}>
                  LAUNCH
                </button>
                <button className="btn" style={{ flex: 1, justifyContent: "center" }} onClick={() => runSpotifyQuick("pause")}>
                  PAUSE
                </button>
                <button className="btn" style={{ flex: 1, justifyContent: "center" }} onClick={() => runSpotifyQuick("next")}>
                  NEXT
                </button>
              </div>
              {spotifyNotice && (
                <div style={{ fontSize: 11, color: "#6ee7b7", marginTop: 6, lineHeight: 1.4 }}>{spotifyNotice}</div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
