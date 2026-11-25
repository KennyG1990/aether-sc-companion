import React, { useEffect, useRef, useState } from "react";
import { Radio, Shield, Cpu, Power, Sparkles, HeartPulse } from "lucide-react";
import { JarvisCore3D } from "./components/JarvisCore3D";
import { HoloDeck3D } from "./components/HoloDeck3D";
import { CommsPanel } from "./components/CommsPanel";
import { InspectorPanel } from "./components/InspectorPanel";
import { CalibrationOverlay } from "./components/CalibrationOverlay";
import { parseWakeWord } from "./utils/wakeWord";
import {
  AetherConfigData,
  AllyShipState,
  CalibrationResult,
  CalibrationStep,
  ChatMessage,
  HeartbeatState,
  PendingConfirmation,
  PersonaProfile,
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

const DEFAULT_PERSONA: PersonaProfile = {
  ai_name: "Aether",
  pilot_name: "Commander",
  tone: "Sharp, loyal, calm tactical presence with dry British wit",
  verbosity: "Concise 1-2 sentence spoken responses unless detailed briefing requested",
  question_style: "Ask direct clarifying questions only when needed",
  humor_style: "Dry, understated spacer humor",
  custom_rules: "Monitor shields, hydrogen fuel, and allied fleet status proactively.",
  persona_summary: "Holographic flight AI",
  calibrated: false,
};

export default function App() {
  const [ship, setShip] = useState<ShipTelemetry>(DEFAULT_SHIP);
  const [fleet, setFleet] = useState<AllyShipState[]>([]);
  const [selectedAlly, setSelectedAlly] = useState<AllyShipState | null>(null);
  const [pendingConfirmations, setPendingConfirmations] = useState<PendingConfirmation[]>([]);
  const [config, setConfig] = useState<AetherConfigData | null>(null);
  const [heartbeat, setHeartbeat] = useState<HeartbeatState | null>(null);
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [voicesNote, setVoicesNote] = useState<string | null>(null);
  const [wsConnected, setWsConnected] = useState(false);

  const [mood, setMood] = useState("NOMINAL");
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);
  const [handsFreeListening, setHandsFreeListening] = useState(false);
  const [wakeWindowActive, setWakeWindowActive] = useState(false);
  const [lastIgnoredSpeech, setLastIgnoredSpeech] = useState<string | null>(null);
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  // Startup Calibration & Personality Interview Modal
  const [showCalibration, setShowCalibration] = useState(true);
  const [calibrationMode, setCalibrationMode] = useState<"systems" | "personality">("systems");
  const [calibrating, setCalibrating] = useState(false);
  const [calSteps, setCalSteps] = useState<CalibrationStep[]>([]);
  const [calResult, setCalResult] = useState<CalibrationResult | null>(null);

  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "boot-1",
      role: "assistant",
      content:
        "Standing by for startup calibration. Click POWER ON & CALIBRATE for live diagnostics, or PERSONALITY SETUP to teach me my name, voice vibe, and how you want me to behave.",
      mood: "NOMINAL",
      provider: "system",
      timestamp: Date.now(),
    },
  ]);

  const recognitionRef = useRef<any>(null);
  const handsFreeRef = useRef<boolean>(false);
  const seenEventIdsRef = useRef<Set<string>>(new Set());
  const audioLevelRef = useRef<number>(0);
  const audioFreqRef = useRef<Uint8Array | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const ttsQueueRef = useRef<string[]>([]);
  const ttsPlayingRef = useRef<boolean>(false);
  const ttsEnabledRef = useRef<boolean>(true);
  const calibratingRef = useRef<boolean>(false);
  const wakeTimerRef = useRef<number | null>(null);
  const wakeWindowRef = useRef<boolean>(false);
  const configRef = useRef<AetherConfigData | null>(null);

  useEffect(() => {
    ttsEnabledRef.current = ttsEnabled;
  }, [ttsEnabled]);

  useEffect(() => {
    calibratingRef.current = calibrating;
  }, [calibrating]);

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  useEffect(() => {
    handsFreeRef.current = handsFreeListening;
  }, [handsFreeListening]);

  const openWakeWindow = (ms = 15000) => {
    wakeWindowRef.current = true;
    setWakeWindowActive(true);
    if (wakeTimerRef.current) clearTimeout(wakeTimerRef.current);
    wakeTimerRef.current = window.setTimeout(() => {
      wakeWindowRef.current = false;
      setWakeWindowActive(false);
    }, ms);
  };

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
          audioFreqRef.current = null;
          resolve();
        };
        utter.onerror = () => {
          setSpeaking(false);
          audioLevelRef.current = 0;
          audioFreqRef.current = null;
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
          const timeBins = new Uint8Array(analyser.frequencyBinCount);
          const freqBins = new Uint8Array(analyser.frequencyBinCount);

          const sampleAudio = () => {
            analyser.getByteTimeDomainData(timeBins);
            analyser.getByteFrequencyData(freqBins);
            let sumSq = 0;
            for (let i = 0; i < timeBins.length; i++) {
              const v = (timeBins[i] - 128) / 128;
              sumSq += v * v;
            }
            const rms = Math.sqrt(sumSq / timeBins.length);
            audioLevelRef.current = Math.min(1.0, rms * 3.8);
            audioFreqRef.current = freqBins;
            rafId = requestAnimationFrame(sampleAudio);
          };
          rafId = requestAnimationFrame(sampleAudio);
        }
      } catch {
        // Plain playback fallback
      }

      return await new Promise<boolean>((resolve) => {
        setSpeaking(true);
        const cleanup = (ok: boolean) => {
          if (rafId) cancelAnimationFrame(rafId);
          audioLevelRef.current = 0;
          audioFreqRef.current = null;
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
      audioFreqRef.current = null;
    }
  };

  const speak = (text: string) => {
    if (!ttsEnabledRef.current || !text.trim()) return;
    ttsQueueRef.current.push(text.trim());
    void drainSpeechQueue();
  };

  const refreshVoices = async (providerOverride?: string) => {
    try {
      const qs = providerOverride ? `?provider=${encodeURIComponent(providerOverride)}` : "";
      const vRes = await fetch(`/api/tts/voices${qs}`);
      if (vRes.ok) {
        const vData = await vRes.json();
        setVoices(vData.voices || []);
        setVoicesNote(vData.note || null);
      }
    } catch {
      // ignore
    }
  };

  const fetchConfigAndVoices = async () => {
    try {
      const cfgRes = await fetch("/api/config");
      if (cfgRes.ok) {
        const data: AetherConfigData = await cfgRes.json();
        setConfig(data);
        setTtsEnabled(data.tts_enabled);
        if (data.player2_status?.heartbeat) {
          setHeartbeat(data.player2_status.heartbeat);
        }
        await refreshVoices(data.tts_provider);
      }
    } catch {
      // Backend starting up
    }
  };

  const runCalibration = async () => {
    setCalibrationMode("systems");
    setShowCalibration(true);
    setCalibrating(true);
    setCalSteps([]);
    setCalResult(null);
    setMood("CALIBRATING");

    speak("Calibrating. Running neural link, Player2 heartbeat, voice matrix, and ship telemetry diagnostics.");

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

  const handleCompletePersonaInterview = async (answers: Record<string, string>) => {
    const res = await fetch("/api/persona/interview/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(answers),
    });
    if (res.ok) {
      const data = await res.json();
      await fetchConfigAndVoices();
      setMessages((prev) => [
        ...prev,
        {
          id: `persona-${Date.now()}`,
          role: "assistant",
          content: `[PERSONA LOCKED: ${data.persona.ai_name}] ${data.greeting}`,
          provider: "personality-calibration",
          timestamp: Date.now(),
        },
      ]);
      speak(data.greeting);
      setRefreshTick((t) => t + 1);
    }
  };

  const handleSavePersonaDirect = async (profile: PersonaProfile) => {
    const res = await fetch("/api/persona", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(profile),
    });
    if (res.ok) {
      await fetchConfigAndVoices();
      speak(`Identity matrix updated. Call me ${profile.ai_name}, ${profile.pilot_name}.`);
      setRefreshTick((t) => t + 1);
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
          if (data.type === "player2_heartbeat" && data.heartbeat) {
            setHeartbeat(data.heartbeat);
            return;
          }
          if (data.type === "telemetry_frame") {
            setShip(data.ship);
            setFleet(data.fleet || []);
            setPendingConfirmations(data.pending_confirmations || []);
            if (data.heartbeat) setHeartbeat(data.heartbeat);

            if (!calibratingRef.current) {
              const level = data.ship?.alert_level;
              if (level === "COMBAT") setMood("COMBAT");
              else if (level === "CAUTION") setMood("CAUTION");
              else if (level === "NOMINAL") {
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
      if (wakeTimerRef.current) clearTimeout(wakeTimerRef.current);
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

  const sendMessage = async (rawText: string) => {
    const activeCfg = configRef.current;
    const aiName = activeCfg?.persona?.ai_name || "Aether";
    const pilotName = activeCfg?.persona?.pilot_name || "Commander";
    const wakeEnabled = activeCfg?.wake_word_enabled ?? true;

    const parsed = parseWakeWord(rawText, aiName, wakeEnabled, wakeWindowRef.current);

    if (!parsed.matched) {
      // Strictly ignore non-addressed chatter (e.g. "Hey John")!
      setLastIgnoredSpeech(rawText);
      return;
    }

    setLastIgnoredSpeech(null);

    if (parsed.kind === "wake_only") {
      // User just said "Hey Jarvis" / "Aether" -> greet by configured pilot title & open 15s follow-up window!
      openWakeWindow(15000);
      const reply = `${pilotName}?`;
      setMessages((prev) => [
        ...prev,
        { id: `u-${Date.now()}`, role: "user", content: rawText, timestamp: Date.now() },
        {
          id: `w-${Date.now() + 1}`,
          role: "assistant",
          content: reply,
          provider: "wake-word-gate",
          timestamp: Date.now(),
        },
      ]);
      speak(reply);
      return;
    }

    // Valid command addressed to AI -> extend active conversation window briefly and dispatch to LLM
    openWakeWindow(12000);
    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: "user",
      content: rawText,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setBusy(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: parsed.command }),
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

  const startSpeechRecognizer = (continuous: boolean) => {
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

    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // ignore
      }
    }

    const rec = new SpeechRec();
    rec.lang = "en-US";
    rec.continuous = continuous;
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onstart = () => setListening(true);
    rec.onerror = () => {
      setListening(false);
    };
    rec.onend = () => {
      setListening(false);
      // Auto-restart in hands-free wake-word mode
      if (handsFreeRef.current) {
        window.setTimeout(() => {
          if (handsFreeRef.current) startSpeechRecognizer(true);
        }, 400);
      }
    };
    rec.onresult = (event: any) => {
      const lastResult = event.results?.[event.results.length - 1];
      if (!lastResult?.isFinal) return;
      const transcript = lastResult?.[0]?.transcript;
      if (transcript) void sendMessage(transcript);
    };
    recognitionRef.current = rec;
    rec.start();
  };

  const toggleMic = () => {
    if (listening && recognitionRef.current) {
      setHandsFreeListening(false);
      handsFreeRef.current = false;
      recognitionRef.current.stop();
      setListening(false);
      return;
    }
    startSpeechRecognizer(false);
  };

  const toggleHandsFree = () => {
    if (handsFreeListening) {
      setHandsFreeListening(false);
      handsFreeRef.current = false;
      recognitionRef.current?.stop();
      setListening(false);
    } else {
      setHandsFreeListening(true);
      handsFreeRef.current = true;
      startSpeechRecognizer(true);
    }
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
      if (updated.player2_status?.heartbeat) setHeartbeat(updated.player2_status.heartbeat);
    }
  };

  const pingHeartbeat = async () => {
    const res = await fetch("/api/player2/heartbeat", { method: "POST" });
    if (res.ok) setHeartbeat(await res.json());
  };

  const persona = config?.persona || DEFAULT_PERSONA;
  const alertPillClass =
    ship.alert_level === "COMBAT" ? "crimson" : ship.alert_level === "CAUTION" ? "amber" : "emerald";

  return (
    <div className="app-shell">
      <CalibrationOverlay
        visible={showCalibration}
        initialMode={calibrationMode}
        calibrating={calibrating}
        steps={calSteps}
        result={calResult}
        persona={persona}
        onStartCalibration={runCalibration}
        onSpeakPrompt={speak}
        onCompletePersonaInterview={handleCompletePersonaInterview}
        onDismiss={() => setShowCalibration(false)}
      />

      <header className="topbar">
        <div className="brand">
          <Cpu size={18} color="#22d3ee" />
          <div>
            <div className="brand-title">{persona.ai_name.toUpperCase()}</div>
            <div className="brand-sub">Star Citizen AI Companion &amp; Holographic C2 Deck</div>
          </div>
        </div>

        <div className="status-pills">
          <button className="btn active" onClick={runCalibration} disabled={calibrating}>
            <Power size={12} /> {calibrating ? "CALIBRATING..." : "CALIBRATE"}
          </button>
          <button
            className="btn amber"
            onClick={() => {
              setCalibrationMode("personality");
              setShowCalibration(true);
            }}
          >
            <Sparkles size={12} /> PERSONA
          </button>
          <span
            className={`pill ${heartbeat?.last_ok ? "emerald" : "amber"}`}
            title={`Official Player2 60s Heartbeat | Mod ID: ${config?.player2_game_key || ""}`}
          >
            <HeartPulse size={12} /> P2 ♥ #{heartbeat?.count ?? 0}
          </span>
          <span className={`pill ${wsConnected ? "emerald" : "crimson"}`}>
            <Radio size={12} /> 17Hz
          </span>
          <span className={`pill ${alertPillClass}`}>
            <Shield size={12} /> {ship.alert_level}
          </span>
          <span className="pill">
            {(config?.llm_provider || "player2").toUpperCase()} /{" "}
            {config?.tts_provider === "elevenlabs_direct"
              ? "OWN 11LABS"
              : config?.tts_provider === "browser"
                ? "BROWSER"
                : "P2 11LABS"}
          </span>
        </div>
      </header>

      <main className="bridge-grid">
        <div className="left-col">
          <div className="panel jarvis-box" style={{ height: 300 }}>
            <div className="panel-header">
              <span>{persona.ai_name.toUpperCase()} // HOLOGRAM AVATAR</span>
              <span style={{ fontSize: 10, color: "#7ea3c4" }}>{persona.pilot_name}</span>
            </div>
            <JarvisCore3D
              mood={mood}
              speaking={speaking}
              listening={listening || wakeWindowActive}
              aiName={persona.ai_name}
              audioLevelRef={audioLevelRef}
              audioFreqRef={audioFreqRef}
            />
          </div>

          <CommsPanel
            aiName={persona.ai_name}
            pilotName={persona.pilot_name}
            wakeWordEnabled={config?.wake_word_enabled ?? true}
            wakeWindowActive={wakeWindowActive}
            handsFreeListening={handsFreeListening}
            lastIgnoredSpeech={lastIgnoredSpeech}
            messages={messages}
            pendingConfirmations={pendingConfirmations}
            listening={listening}
            ttsEnabled={ttsEnabled}
            busy={busy}
            onSend={sendMessage}
            onToggleMic={toggleMic}
            onToggleHandsFree={toggleHandsFree}
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
          heartbeat={heartbeat}
          voices={voices}
          voicesNote={voicesNote}
          onExecuteAction={executeAction}
          onTriggerScenario={triggerScenario}
          onSaveConfig={saveConfig}
          onSavePersona={handleSavePersonaDirect}
          onOpenPersonaInterview={() => {
            setCalibrationMode("personality");
            setShowCalibration(true);
          }}
          onPingHeartbeat={pingHeartbeat}
          onRefreshVoices={refreshVoices}
          onTestVoice={() =>
            speak(`Hello ${persona.pilot_name}. ${persona.ai_name} vocal synthesizer is online and calibrated.`)
          }
          refreshTick={refreshTick}
        />
      </main>
    </div>
  );
}
