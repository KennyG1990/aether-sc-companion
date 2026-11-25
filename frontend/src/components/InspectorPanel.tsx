import React, { useEffect, useState } from "react";
import { ActionReceipt, AetherConfigData, RetrievedMemoryHit, ShipTelemetry, VoiceOption } from "../types";

interface InspectorPanelProps {
  ship: ShipTelemetry;
  config: AetherConfigData | null;
  voices: VoiceOption[];
  onExecuteAction: (actionId: string) => void;
  onTriggerScenario: (scenario: string) => void;
  onSaveConfig: (patch: Record<string, unknown>) => void;
  onTestVoice: () => void;
  refreshTick: number;
}

export const InspectorPanel: React.FC<InspectorPanelProps> = ({
  ship,
  config,
  voices,
  onExecuteAction,
  onTriggerScenario,
  onSaveConfig,
  onTestVoice,
  refreshTick,
}) => {
  const [tab, setTab] = useState<"systems" | "rag" | "receipts" | "config">("systems");
  const [memories, setMemories] = useState<RetrievedMemoryHit[]>([]);
  const [ragQuery, setRagQuery] = useState("");
  const [newMem, setNewMem] = useState("");
  const [receipts, setReceipts] = useState<ActionReceipt[]>([]);

  // Config form state
  const [provider, setProvider] = useState("player2");
  const [ttsProvider, setTtsProvider] = useState("player2_elevenlabs");
  const [voiceId, setVoiceId] = useState("01955d76-ed5b-754f-a070-a570ddfed516");
  const [elevenKey, setElevenKey] = useState("");
  const [telemetryMode, setTelemetryMode] = useState("simulator");
  const [openRouterKey, setOpenRouterKey] = useState("");
  const [openRouterModel, setOpenRouterModel] = useState("anthropic/claude-3.7-sonnet");
  const [player2Url, setPlayer2Url] = useState("http://127.0.0.1:4315");

  useEffect(() => {
    if (config) {
      setProvider(config.llm_provider);
      setTtsProvider(config.tts_provider);
      setVoiceId(config.elevenlabs_voice_id);
      setTelemetryMode(config.telemetry_mode);
      setOpenRouterModel(config.openrouter_model);
      setPlayer2Url(config.player2_base_url);
    }
  }, [config]);

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

  useEffect(() => {
    if (tab === "rag") loadMemories(ragQuery || undefined);
    if (tab === "receipts") loadReceipts();
  }, [tab, refreshTick]);

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

  const barClass = (pct: number) => (pct < 30 ? "crit" : pct < 60 ? "warn" : "");

  return (
    <div className="panel" style={{ height: "100%" }}>
      <div className="tabs">
        <button className={`tab-btn ${tab === "systems" ? "active" : ""}`} onClick={() => setTab("systems")}>
          Systems
        </button>
        <button className={`tab-btn ${tab === "rag" ? "active" : ""}`} onClick={() => setTab("rag")}>
          SQLite RAG
        </button>
        <button className={`tab-btn ${tab === "receipts" ? "active" : ""}`} onClick={() => setTab("receipts")}>
          Receipts
        </button>
        <button className={`tab-btn ${tab === "config" ? "active" : ""}`} onClick={() => setTab("config")}>
          Config
        </button>
      </div>

      <div className="inspector-body">
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
              <div className="card-title">Proactive Trigger Scenarios (Demo)</div>
              <div className="toggle-grid">
                <button className="btn danger" onClick={() => onTriggerScenario("combat_ambush")}>
                  PIRATE AMBUSH
                </button>
                <button className="btn danger" onClick={() => onTriggerScenario("ally_distress")}>
                  ALLY DISTRESS
                </button>
                <button className="btn amber" onClick={() => onTriggerScenario("low_fuel")}>
                  LOW H2 FUEL
                </button>
                <button className="btn active" onClick={() => onTriggerScenario("all_clear")}>
                  ALL CLEAR
                </button>
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

        {tab === "config" && (
          <>
            {config?.player2_status && (
              <div className="card">
                <div className="card-title">Live Player2 Link (4315 / MCP 9847)</div>
                <div style={{ fontSize: 11.5, lineHeight: 1.6, color: "#cbd5e1" }}>
                  <div>
                    API:{" "}
                    <strong style={{ color: config.player2_status.api_online ? "#6ee7b7" : "#fca5a5" }}>
                      {config.player2_status.api_online
                        ? `ONLINE (v${config.player2_status.client_version})`
                        : "OFFLINE"}
                    </strong>
                  </div>
                  {config.player2_status.joules !== null && (
                    <div>
                      Account: {config.player2_status.patron_tier} · {config.player2_status.joules} Joules
                    </div>
                  )}
                  <div>
                    MCP Server:{" "}
                    <strong style={{ color: config.player2_status.mcp_online ? "#6ee7b7" : "#f59e0b" }}>
                      {config.player2_status.mcp_online ? config.player2_status.mcp_server : "OFFLINE"}
                    </strong>
                  </div>
                  <div>ElevenLabs Voices: {config.player2_status.elevenlabs_voices_count}</div>
                </div>
              </div>
            )}

            <div className="card">
              <div className="card-title">LLM, ElevenLabs Voice &amp; Telemetry</div>
              <div className="field-group">
                <label>LLM Decision Backend</label>
                <select className="select-input" value={provider} onChange={(e) => setProvider(e.target.value)}>
                  <option value="player2">Player2 Local LLM (127.0.0.1:4315)</option>
                  <option value="openrouter">OpenRouter Cloud API</option>
                  <option value="demo">Offline Demo Co-Pilot (Zero Keys)</option>
                </select>
              </div>
              <div className="field-group">
                <label>TTS Voice Engine</label>
                <select className="select-input" value={ttsProvider} onChange={(e) => setTtsProvider(e.target.value)}>
                  <option value="player2_elevenlabs">ElevenLabs via Player2 (Zero Key)</option>
                  <option value="elevenlabs_direct">Direct ElevenLabs API (Custom Key)</option>
                  <option value="browser">Browser SpeechSynthesis Fallback</option>
                </select>
              </div>
              <div className="field-group">
                <label>ElevenLabs Voice (Jarvis British Male at top)</label>
                <select className="select-input" value={voiceId} onChange={(e) => setVoiceId(e.target.value)}>
                  {voices.map((v) => (
                    <option key={v.voice_id} value={v.voice_id}>
                      {v.name} {v.accent || v.gender ? `(${v.accent} ${v.gender})` : ""}
                    </option>
                  ))}
                </select>
              </div>
              {ttsProvider === "elevenlabs_direct" && (
                <div className="field-group">
                  <label>
                    ElevenLabs API Key {config?.elevenlabs_api_key_set ? "(Configured)" : "(Required for Direct)"}
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
              <div className="field-group">
                <label>Player2 Base URL</label>
                <input className="text-input" value={player2Url} onChange={(e) => setPlayer2Url(e.target.value)} />
              </div>
              <div className="field-group">
                <label>OpenRouter Model</label>
                <input
                  className="text-input"
                  value={openRouterModel}
                  onChange={(e) => setOpenRouterModel(e.target.value)}
                />
              </div>
              <div className="field-group">
                <label>
                  OpenRouter API Key {config?.openrouter_api_key_set ? "(Configured)" : "(Optional)"}
                </label>
                <input
                  className="text-input"
                  type="password"
                  placeholder="sk-or-v1-..."
                  value={openRouterKey}
                  onChange={(e) => setOpenRouterKey(e.target.value)}
                />
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
                <button
                  className="btn active"
                  style={{ flex: 1, justifyContent: "center" }}
                  onClick={() => {
                    const patch: Record<string, unknown> = {
                      llm_provider: provider,
                      tts_provider: ttsProvider,
                      elevenlabs_voice_id: voiceId,
                      player2_base_url: player2Url,
                      openrouter_model: openRouterModel,
                      telemetry_mode: telemetryMode,
                    };
                    if (openRouterKey.trim()) patch.openrouter_api_key = openRouterKey.trim();
                    if (elevenKey.trim()) patch.elevenlabs_api_key = elevenKey.trim();
                    onSaveConfig(patch);
                    setOpenRouterKey("");
                    setElevenKey("");
                  }}
                >
                  APPLY CONFIG
                </button>
                <button className="btn" onClick={onTestVoice}>
                  TEST VOICE
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
