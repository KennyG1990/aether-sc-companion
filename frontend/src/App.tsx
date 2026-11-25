import React, { useEffect, useRef, useState } from "react";
import { Radio, Shield, Cpu } from "lucide-react";
import { JarvisCore3D } from "./components/JarvisCore3D";
import { HoloDeck3D } from "./components/HoloDeck3D";
import { CommsPanel } from "./components/CommsPanel";
import { InspectorPanel } from "./components/InspectorPanel";
import {
  AetherConfigData,
  AllyShipState,
  ChatMessage,
  PendingConfirmation,
  ShipTelemetry,
  TelemetryEvent,
} from "./types";

const DEFAULT_SHIP: ShipTelemetry = {
  timestamp: Date.now() / 1000,
  source: "simulator",
  zone: "Crusader Orbit",
  planet: "Crusader",
  speed_mps: 185,
  vertical_speed_mps: 0,
  radar_altitude_m: 4200,
  pitch_deg: 0,
  roll_deg: 0,
  yaw_deg: 140,
  g_force: 1.0,
  hydrogen_fuel_pct: 78,
  quantum_fuel_pct: 64,
  hull_pct: 100,
  shields: { front: 100, back: 100, left: 100, right: 100 },
  master_mode: "SCM",
  landing_gear_down: false,
  exterior_lights_on: false,
  vtol_enabled: false,
  doors_open: false,
  quantum_spooling: false,
  flight_assist: true,
  under_fire: false,
  alert_level: "NOMINAL",
  vitals: {
    health_pct: 100,
    oxygen_pct: 100,
    hydration_pct: 92,
    hunger_pct: 88,
    heart_rate_bpm: 72,
    body_temp_c: 37.0,
    locomotion: "PILOT_SEAT",
  },
};

export default function App() {
  const [ship, setShip] = useState<ShipTelemetry>(DEFAULT_SHIP);
  const [fleet, setFleet] = useState<AllyShipState[]>([]);
  const [selectedAlly, setSelectedAlly] = useState<AllyShipState | null>(null);
  const [pendingConfirmations, setPendingConfirmations] = useState<PendingConfirmation[]>([]);
  const [config, setConfig] = useState<AetherConfigData | null>(null);
  const [wsConnected, setWsConnected] = useState(false);

  const [mood, setMood] = useState("NOMINAL");
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "boot-1",
      role: "assistant",
      content:
        "AETHER online, Commander. Local telemetry stream active, Stanton Fleet C2 hologram synced, and SQLite Hybrid RAG standing by. Give me a voice order or try triggering a Pirate Ambush.",
      mood: "NOMINAL",
      provider: "system",
      timestamp: Date.now(),
    },
  ]);

  const recognitionRef = useRef<any>(null);

  const speak = (text: string) => {
    if (!ttsEnabled || typeof window === "undefined" || !("speechSynthesis" in window)) return;
    try {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.rate = 1.05;
      utter.pitch = 0.95;
      utter.onstart = () => setSpeaking(true);
      utter.onend = () => setSpeaking(false);
      utter.onerror = () => setSpeaking(false);
      window.speechSynthesis.speak(utter);
    } catch {
      setSpeaking(false);
    }
  };

  const fetchConfig = async () => {
    try {
      const res = await fetch("/api/config");
      if (res.ok) {
        const data: AetherConfigData = await res.json();
        setConfig(data);
        setTtsEnabled(data.tts_enabled);
      }
    } catch {
      // Backend starting up
    }
  };

  useEffect(() => {
    fetchConfig();
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const wsUrl = `${proto}://${window.location.host}/ws/telemetry`;
    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;

    const connect = () => {
      ws = new WebSocket(wsUrl);
      ws.onopen = () => setWsConnected(true);
      ws.onclose = () => {
        setWsConnected(false);
        reconnectTimer = window.setTimeout(connect, 1800);
      };
      ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data.type === "telemetry_frame") {
            setShip(data.ship);
            setFleet(data.fleet || []);
            setPendingConfirmations(data.pending_confirmations || []);

            if (data.ship?.alert_level === "COMBAT") {
              setMood("COMBAT");
            } else if (data.ship?.alert_level === "CAUTION") {
              setMood("CAUTION");
            }

            const events: TelemetryEvent[] = data.events || [];
            if (events.length > 0) {
              events.forEach((evt) => {
                setMessages((prev) => [
                  ...prev,
                  {
                    id: evt.event_id,
                    role: "alert",
                    content: `[PROACTIVE ALERT] ${evt.summary}`,
                    timestamp: Date.now(),
                  },
                ]);
                speak(evt.summary);
              });
              setRefreshTick((t) => t + 1);
            }
          }
        } catch {
          // Ignore malformed frame
        }
      };
    };

    connect();
    return () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, []);

  useEffect(() => {
    if (!selectedAlly && fleet.length > 0) {
      setSelectedAlly(fleet[0]);
    } else if (selectedAlly) {
      const updated = fleet.find((a) => a.callsign === selectedAlly.callsign);
      if (updated) setSelectedAlly(updated);
    }
  }, [fleet]);

  const sendMessage = async (text: string) => {
    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: "user",
      content: text,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setBusy(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      const data = await res.json();
      setMood(data.mood || ship.alert_level || "NOMINAL");
      setPendingConfirmations(data.pending_confirmations || []);
      setMessages((prev) => [
        ...prev,
        {
          id: `a-${Date.now()}`,
          role: "assistant",
          content: data.reply,
          mood: data.mood,
          provider: data.provider_used,
          injectionFlagged: data.injection_flagged,
          retrieved: data.retrieved_memories,
          receipts: data.receipts,
          timestamp: Date.now(),
        },
      ]);
      speak(data.reply);
      setRefreshTick((t) => t + 1);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          role: "alert",
          content: "Backend unreachable on port 8765. Start uvicorn app.main:app to connect AETHER.",
          timestamp: Date.now(),
        },
      ]);
    } finally {
      setBusy(false);
    }
  };

  const toggleMic = () => {
    const SpeechRec = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRec) {
      setMessages((prev) => [
        ...prev,
        {
          id: `mic-${Date.now()}`,
          role: "alert",
          content: "Web Speech STT is unavailable in this browser. Use Chromium/Edge or type commands below.",
          timestamp: Date.now(),
        },
      ]);
      return;
    }

    if (listening && recognitionRef.current) {
      recognitionRef.current.stop();
      setListening(false);
      return;
    }

    const rec = new SpeechRec();
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onstart = () => setListening(true);
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    rec.onresult = (event: any) => {
      const transcript = event.results?.[0]?.[0]?.transcript;
      if (transcript) sendMessage(transcript);
    };
    recognitionRef.current = rec;
    rec.start();
  };

  const executeAction = async (actionId: string) => {
    const res = await fetch("/api/actions/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action_id: actionId }),
    });
    const rcpt = await res.json();
    setMessages((prev) => [
      ...prev,
      {
        id: `act-${Date.now()}`,
        role: rcpt.status === "CONFIRMED" ? "assistant" : "alert",
        content: `[${rcpt.status}] ${rcpt.reason}`,
        receipts: [rcpt],
        timestamp: Date.now(),
      },
    ]);
    speak(rcpt.reason);
    setRefreshTick((t) => t + 1);
  };

  const confirmAction = async (token: string, approve: boolean) => {
    const res = await fetch("/api/actions/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, approve }),
    });
    const rcpt = await res.json();
    setMessages((prev) => [
      ...prev,
      {
        id: `cfm-${Date.now()}`,
        role: rcpt.status === "CONFIRMED" ? "assistant" : "alert",
        content: `[SAFETY GATE -> ${rcpt.status}] ${rcpt.reason}`,
        receipts: [rcpt],
        timestamp: Date.now(),
      },
    ]);
    speak(rcpt.reason);
    setRefreshTick((t) => t + 1);
  };

  const triggerScenario = async (scenario: string) => {
    const res = await fetch("/api/scenario", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenario }),
    });
    const data = await res.json();
    setMessages((prev) => [
      ...prev,
      {
        id: `sc-${Date.now()}`,
        role: scenario === "all_clear" ? "assistant" : "alert",
        content: `[SIMULATOR] ${data.detail}`,
        timestamp: Date.now(),
      },
    ]);
  };

  const saveConfig = async (patch: Record<string, unknown>) => {
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (res.ok) {
      const updated = await res.json();
      setConfig(updated);
    }
  };

  const alertPillClass =
    ship.alert_level === "COMBAT" ? "crimson" : ship.alert_level === "CAUTION" ? "amber" : "emerald";

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <Cpu size={18} color="#22d3ee" />
          <div>
            <div className="brand-title">AETHER</div>
            <div className="brand-sub">Star Citizen AI Companion &amp; Holographic C2 Deck</div>
          </div>
        </div>

        <div className="status-pills">
          <span className={`pill ${wsConnected ? "emerald" : "crimson"}`}>
            <Radio size={12} /> {wsConnected ? "TELEMETRY 17Hz" : "DISCONNECTED"}
          </span>
          <span className={`pill ${alertPillClass}`}>
            <Shield size={12} /> {ship.alert_level}
          </span>
          <span className="pill">LLM: {(config?.llm_provider || "demo").toUpperCase()}</span>
          <span className="pill">{ship.zone.toUpperCase()}</span>
        </div>
      </header>

      <main className="bridge-grid">
        <div className="left-col">
          <div className="panel jarvis-box">
            <div className="panel-header">
              <span>AETHER // NEURAL AVATAR</span>
              <span style={{ fontSize: 10, color: "#7ea3c4" }}>{config?.pilot_callsign || "CMDR-01"}</span>
            </div>
            <JarvisCore3D mood={mood} speaking={speaking} listening={listening} />
          </div>

          <CommsPanel
            messages={messages}
            pendingConfirmations={pendingConfirmations}
            listening={listening}
            ttsEnabled={ttsEnabled}
            busy={busy}
            onSend={sendMessage}
            onToggleMic={toggleMic}
            onToggleTts={() => setTtsEnabled((v) => !v)}
            onConfirmAction={confirmAction}
          />
        </div>

        <HoloDeck3D
          ship={ship}
          fleet={fleet}
          selectedAlly={selectedAlly}
          onSelectAlly={setSelectedAlly}
        />

        <InspectorPanel
          ship={ship}
          config={config}
          onExecuteAction={executeAction}
          onTriggerScenario={triggerScenario}
          onSaveConfig={saveConfig}
          refreshTick={refreshTick}
        />
      </main>
    </div>
  );
}
