import React, { useEffect, useRef, useState } from "react";
import { Radio, Shield, Cpu, Power } from "lucide-react";
import { JarvisCore3D } from "./components/JarvisCore3D";
import { HoloDeck3D } from "./components/HoloDeck3D";
import { CommsPanel } from "./components/CommsPanel";
import { InspectorPanel } from "./components/InspectorPanel";
import { CalibrationOverlay } from "./components/CalibrationOverlay";
import {
  AetherConfigData,
  AllyShipState,
  CalibrationResult,
  CalibrationStep,
  ChatMessage,
  PendingConfirmation,
  ShipTelemetry,
  TelemetryEvent,
  VoiceOption,
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
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [wsConnected, setWsConnected] = useState(false);

  const [mood, setMood] = useState("NOMINAL");
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  // Startup Calibration state
  const [showCalibration, setShowCalibration] = useState(true);
  const [calibrating, setCalibrating] = useState(false);
  const [calSteps, setCalSteps] = useState<CalibrationStep[]>([]);
  const [calResult, setCalResult] = useState<CalibrationResult | null>(null);

  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "boot-1",
      role: "assistant",
      content:
        "AETHER standing by for startup calibration. Click POWER ON & CALIBRATE to sync Player2 neural LLM, ElevenLabs voice synthesis, SQLite RAG, and Star Citizen ship telemetry.",
      mood: "NOMINAL",
      provider: "system",
      timestamp: Date.now(),
    },
  ]);

  const recognitionRef = useRef<any>(null);
  const seenEventIdsRef = useRef<Set<string>>(new Set());
  const audioLevelRef = useRef<number>(0);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const ttsQueueRef = useRef<string[]>([]);
  const ttsPlayingRef = useRef<boolean>(false);
  const ttsEnabledRef = useRef<boolean>(true);
  const calibratingRef = useRef<boolean>(false);

  useEffect(() => {
    ttsEnabledRef.current = ttsEnabled;
  }, [ttsEnabled]);

  useEffect(() => {
    calibratingRef.current = calibrating;
  }, [calibrating]);

  const browserSpeakFallback = (text: string): Promise<void> =>
    new Promise((resolve) => {
      if (typeof window === "undefined" || !("speechSynthesis" in window)) {
        resolve();
        return;
      }
      try {
        window.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(text);
        utter.rate = 1.04;
        utter.pitch = 0.94;
        utter.onstart = () => setSpeaking(true);
        utter.onend = () => {
          setSpeaking(false);
          audioLevelRef.current = 0;
          resolve();
        };
        utter.onerror = () => {
          setSpeaking(false);
          audioLevelRef.current = 0;
          resolve();
        };
        window.speechSynthesis.speak(utter);
      } catch {
        setSpeaking(false);
        resolve();
      }
    });

  const playElevenLabsAudio = async (text: string): Promise<boolean> => {
    try {
      const res = await fetch("/api/tts/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) return false;
      const blob = await res.blob();
      if (!blob || blob.size < 100) return false;

      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.crossOrigin = "anonymous";

      // Attach Web Audio AnalyserNode so JarvisCore3D pulses to real ElevenLabs speech amplitude!
      let rafId = 0;
      try {
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        if (!audioCtxRef.current && AudioCtx) {
          audioCtxRef.current = new AudioCtx();
        }
        const ctx = audioCtxRef.current;
        if (ctx) {
          if (ctx.state === "suspended") await ctx.resume();
          const source = ctx.createMediaElementSource(audio);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 256;
          source.connect(analyser);
          analyser.connect(ctx.destination);
          const bins = new Uint8Array(analyser.frequencyBinCount);

          const sampleAmp = () => {
            analyser.getByteTimeDomainData(bins);
            let sumSq = 0;
            for (let i = 0; i < bins.length; i++) {
              const v = (bins[i] - 128) / 128;
              sumSq += v * v;
            }
            const rms = Math.sqrt(sumSq / bins.length);
            audioLevelRef.current = Math.min(1.0, rms * 3.8);
            rafId = requestAnimationFrame(sampleAmp);
          };
          rafId = requestAnimationFrame(sampleAmp);
        }
      } catch {
        // Fallback to plain Audio playback if AudioContext restricted
      }

      return await new Promise<boolean>((resolve) => {
        setSpeaking(true);
        const cleanup = (ok: boolean) => {
          if (rafId) cancelAnimationFrame(rafId);
          audioLevelRef.current = 0;
          setSpeaking(false);
          URL.revokeObjectURL(url);
          resolve(ok);
        };
        audio.onended = () => cleanup(true);
        audio.onerror = () => cleanup(false);
        audio.play().catch(() => cleanup(false));
      });
    } catch {
      return false;
    }
  };

  const drainSpeechQueue = async () => {
    if (ttsPlayingRef.current) return;
    ttsPlayingRef.current = true;
    try {
      while (ttsQueueRef.current.length > 0) {
        const nextText = ttsQueueRef.current.shift();
        if (!nextText || !ttsEnabledRef.current) continue;
        const played = await playElevenLabsAudio(nextText);
        if (!played && ttsEnabledRef.current) {
          await browserSpeakFallback(nextText);
        }
      }
    } finally {
      ttsPlayingRef.current = false;
      setSpeaking(false);
      audioLevelRef.current = 0;
    }
  };

  const speak = (text: string) => {
    if (!ttsEnabledRef.current || !text.trim()) return;
    ttsQueueRef.current.push(text.trim());
    void drainSpeechQueue();
  };

  const fetchConfigAndVoices = async () => {
    try {
      const [cfgRes, vRes] = await Promise.all([fetch("/api/config"), fetch("/api/tts/voices")]);
      if (cfgRes.ok) {
        const data: AetherConfigData = await cfgRes.json();
        setConfig(data);
        setTtsEnabled(data.tts_enabled);
      }
      if (vRes.ok) {
        const vData = await vRes.json();
        setVoices(vData.voices || []);
      }
    } catch {
      // Backend starting up
    }
  };

  const runCalibration = async () => {
    setShowCalibration(true);
    setCalibrating(true);
    setCalSteps([]);
    setCalResult(null);
    setMood("CALIBRATING");

    // Speak "Calibrating..." immediately via ElevenLabs while live probes run!
    speak("Calibrating. Running full neural link, voice matrix, and ship telemetry diagnostics.");

    try {
      const res = await fetch("/api/calibrate", { method: "POST" });
      if (res.ok) {
        const result: CalibrationResult = await res.json();
        setCalResult(result);
        setCalSteps(result.steps || []);
        setMood(result.status === "ALL_SYSTEMS_GREEN" ? "NOMINAL" : result.status);
        setMessages((prev) => [
          ...prev,
          {
            id: `cal-${Date.now()}`,
            role: "assistant",
            content: `[CALIBRATION ${result.status}] ${result.briefing}`,
            provider: result.provider_used,
            timestamp: Date.now(),
          },
        ]);
        speak(result.briefing);
        await fetchConfigAndVoices();
      }
    } finally {
      setCalibrating(false);
    }
  };

  useEffect(() => {
    fetchConfigAndVoices();
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const wsUrl = `${proto}://${window.location.host}/ws/telemetry`;
    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        if (!disposed) setWsConnected(true);
      };
      ws.onclose = () => {
        if (disposed) return;
        setWsConnected(false);
        reconnectTimer = window.setTimeout(connect, 1800);
      };
      ws.onmessage = (ev) => {
        if (disposed) return;
        try {
          const data = JSON.parse(ev.data);
          if (data.type === "calibration_progress" && data.steps) {
            setCalSteps(data.steps);
            return;
          }
          if (data.type === "telemetry_frame") {
            setShip(data.ship);
            setFleet(data.fleet || []);
            setPendingConfirmations(data.pending_confirmations || []);

            if (!calibratingRef.current) {
              const level = data.ship?.alert_level;
              if (level === "COMBAT") {
                setMood("COMBAT");
              } else if (level === "CAUTION") {
                setMood("CAUTION");
              } else if (level === "NOMINAL") {
                setMood((prev) => (prev === "COMBAT" || prev === "CAUTION" ? "NOMINAL" : prev));
              }
            }

            const events: TelemetryEvent[] = (data.events || []).filter((evt: TelemetryEvent) => {
              if (seenEventIdsRef.current.has(evt.event_id)) return false;
              seenEventIdsRef.current.add(evt.event_id);
              return true;
            });
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
      disposed = true;
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
          content: "Backend unreachable on port 8785. Start uvicorn app.main:app --port 8785 to connect AETHER.",
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
      <CalibrationOverlay
        visible={showCalibration}
        calibrating={calibrating}
        steps={calSteps}
        result={calResult}
        onStartCalibration={runCalibration}
        onDismiss={() => setShowCalibration(false)}
      />

      <header className="topbar">
        <div className="brand">
          <Cpu size={18} color="#22d3ee" />
          <div>
            <div className="brand-title">AETHER</div>
            <div className="brand-sub">Star Citizen AI Companion &amp; Holographic C2 Deck</div>
          </div>
        </div>

        <div className="status-pills">
          <button className="btn active" onClick={runCalibration} disabled={calibrating}>
            <Power size={12} /> {calibrating ? "CALIBRATING..." : "CALIBRATE"}
          </button>
          <span className={`pill ${wsConnected ? "emerald" : "crimson"}`}>
            <Radio size={12} /> {wsConnected ? "TELEMETRY 17Hz" : "DISCONNECTED"}
          </span>
          <span className={`pill ${alertPillClass}`}>
            <Shield size={12} /> {ship.alert_level}
          </span>
          <span className="pill">LLM: {(config?.llm_provider || "player2").toUpperCase()}</span>
          <span className="pill">TTS: {(config?.tts_provider === "browser" ? "BROWSER" : "ELEVENLABS")}</span>
        </div>
      </header>

      <main className="bridge-grid">
        <div className="left-col">
          <div className="panel jarvis-box">
            <div className="panel-header">
              <span>AETHER // NEURAL AVATAR</span>
              <span style={{ fontSize: 10, color: "#7ea3c4" }}>{config?.pilot_callsign || "CMDR-01"}</span>
            </div>
            <JarvisCore3D
              mood={mood}
              speaking={speaking}
              listening={listening}
              audioLevelRef={audioLevelRef}
            />
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
          voices={voices}
          onExecuteAction={executeAction}
          onTriggerScenario={triggerScenario}
          onSaveConfig={saveConfig}
          onTestVoice={() => speak("AETHER vocal synthesizer online. All systems green, Commander.")}
          refreshTick={refreshTick}
        />
      </main>
    </div>
  );
}
