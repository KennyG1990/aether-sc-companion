import React, { useEffect, useRef, useState } from "react";
import {
  Settings,
  Mic,
  MicOff,
  Ear,
  Volume2,
  VolumeX,
  Orbit,
  CircleDot,
  Send,
  ShieldAlert,
  Power,
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  Loader2,
} from "lucide-react";
import { JarvisCore3D } from "./components/JarvisCore3D";
import { HoloDeck3D } from "./components/HoloDeck3D";
import { CalibrationOverlay } from "./components/CalibrationOverlay";
import { SettingsModal } from "./components/SettingsModal";
import { parseWakeWord } from "./utils/wakeWord";
import { AetherMicController } from "./utils/voiceCapture";
import {
  AetherConfigData,
  AllyShipState,
  CalibrationResult,
  CalibrationStep,
  GameLinkStatus,
  HeartbeatState,
  PendingConfirmation,
  PersonaProfile,
  ShipTelemetry,
  TelemetryEvent,
  VoiceOption,
} from "./types";

const DEFAULT_GAME_LINK: GameLinkStatus = {
  state: "red",
  status: "NOT_CONFIGURED",
  exe_configured: false,
  exe_path: "",
  exe_running: false,
  exe_pid: null,
  grpc_env_enabled: false,
  api_connected: false,
  grpc_target: "127.0.0.1:2942",
  label: "StarCitizen.exe offline",
  detail: "Scanning for StarCitizen.exe and local gRPC API on 127.0.0.1:2942...",
};

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
  const [stageMode, setStageMode] = useState<"core" | "hologram">("core");
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [ship, setShip] = useState<ShipTelemetry>(DEFAULT_SHIP);
  const [fleet, setFleet] = useState<AllyShipState[]>([]);
  const [selectedAlly, setSelectedAlly] = useState<AllyShipState | null>(null);
  const [pendingConfirmations, setPendingConfirmations] = useState<PendingConfirmation[]>([]);
  const [config, setConfig] = useState<AetherConfigData | null>(null);
  const [heartbeat, setHeartbeat] = useState<HeartbeatState | null>(null);
  const [gameLink, setGameLink] = useState<GameLinkStatus>(DEFAULT_GAME_LINK);
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [voicesNote, setVoicesNote] = useState<string | null>(null);
  const [, setWsConnected] = useState(false);

  const [mood, setMood] = useState("CALM");
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);
  const [handsFreeListening, setHandsFreeListening] = useState(false);
  const [micStatus, setMicStatus] = useState("IDLE");
  const [micLevel, setMicLevel] = useState(0);
  const [wakeWindowActive, setWakeWindowActive] = useState(false);
  const [lastIgnoredSpeech, setLastIgnoredSpeech] = useState<string | null>(null);
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  // Subtle single-line subtitle under the floating orb (no cluttered chat box!)
  const [subtitle, setSubtitle] = useState<string>("");
  const [subtitleMeta, setSubtitleMeta] = useState<string>("");
  const [whisperInput, setWhisperInput] = useState<string>("");

  // Calibration & Personality Interview state
  const [calibrating, setCalibrating] = useState(false);
  const [hasCalibratedOnce, setHasCalibratedOnce] = useState(false);
  const [calSteps, setCalSteps] = useState<CalibrationStep[]>([]);
  const [calResult, setCalResult] = useState<CalibrationResult | null>(null);
  const [showPersonaModal, setShowPersonaModal] = useState(false);

  const micControllerRef = useRef<AetherMicController | null>(null);
  const sendMessageRef = useRef<(text: string) => void>(() => {});
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
    const controller = new AetherMicController({
      isAiSpeaking: () => ttsPlayingRef.current,
      onMicLevel: (lvl) => setMicLevel(lvl),
      onStateChange: (st) => setMicStatus(st),
      onTranscript: (text) => {
        if (text.trim()) {
          sendMessageRef.current(text.trim());
        }
      },
      onError: (msg) => {
        setHandsFreeListening(false);
        setListening(false);
        setSubtitle(msg);
        setSubtitleMeta("MICROPHONE");
      },
    });
    micControllerRef.current = controller;
    return () => {
      void controller.stop();
    };
  }, []);

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
        if (data.player2_status?.heartbeat) setHeartbeat(data.player2_status.heartbeat);
        if (data.game_link) setGameLink(data.game_link);
        if (data.mood) setMood(data.mood);
        await refreshVoices(data.tts_provider);
      }
    } catch {
      // Backend starting
    }
  };

  const runCalibration = async () => {
    setStageMode("core");
    setCalibrating(true);
    setCalSteps([]);
    setCalResult(null);
    setMood("CALIBRATING");
    setSubtitle("Calibrating neural link, voice matrix, and ship telemetry...");
    setSubtitleMeta("STARTUP DIAGNOSTICS");

    speak("Calibrating. Running neural link, voice matrix, and ship telemetry diagnostics.");

    try {
      const res = await fetch("/api/calibrate", { method: "POST" });
      if (res.ok) {
        const result: CalibrationResult = await res.json();
        setCalResult(result);
        setCalSteps(result.steps || []);
        setHasCalibratedOnce(true);
        setMood(result.status === "ALL_SYSTEMS_GREEN" ? "NOMINAL" : result.status);
        setSubtitle(result.briefing);
        setSubtitleMeta(result.status.replace(/_/g, " "));
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
      setSubtitle(data.greeting);
      setSubtitleMeta(`PERSONA LOCKED // ${data.persona.ai_name.toUpperCase()}`);
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
      const line = `Identity matrix updated. Call me ${profile.ai_name}, ${profile.pilot_name}.`;
      setSubtitle(line);
      speak(line);
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
          if (data.type === "game_link_update" && data.game_link) {
            setGameLink(data.game_link);
            return;
          }
          if (data.type === "mood_update" && data.mood) {
            if (!calibratingRef.current) setMood(String(data.mood).toUpperCase());
            return;
          }
          if (data.type === "telemetry_frame") {
            setShip(data.ship);
            setFleet(data.fleet || []);
            setPendingConfirmations(data.pending_confirmations || []);
            if (data.heartbeat) setHeartbeat(data.heartbeat);
            if (data.game_link) setGameLink(data.game_link);

            if (!calibratingRef.current) {
              const level = data.ship?.alert_level;
              if (level === "COMBAT") setMood("ALERT");
              else if (level === "CAUTION") setMood("FOCUSED");
              else if (level === "NOMINAL") {
                setMood((prev) =>
                  prev === "COMBAT" || prev === "CAUTION" || prev === "ALERT" || prev === "FOCUSED"
                    ? "CALM"
                    : prev
                );
              }
            }

            const events: TelemetryEvent[] = (data.events || []).filter((evt: TelemetryEvent) => {
              if (seenEventIdsRef.current.has(evt.event_id)) return false;
              seenEventIdsRef.current.add(evt.event_id);
              return true;
            });
            if (events.length > 0) {
              events.forEach((evt) => {
                setSubtitle(evt.summary);
                setSubtitleMeta(`ALERT // ${evt.event_type.replace(/_/g, " ")}`);
                speak(evt.summary);
              });
              setRefreshTick((t) => t + 1);
            }
          }
        } catch {
          // ignore
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
      setLastIgnoredSpeech(rawText);
      return;
    }

    setLastIgnoredSpeech(null);

    if (parsed.kind === "wake_only") {
      openWakeWindow(15000);
      const reply = `${pilotName}?`;
      setSubtitle(reply);
      setSubtitleMeta(`LISTENING TO ${pilotName.toUpperCase()}`);
      speak(reply);
      return;
    }

    openWakeWindow(12000);
    setBusy(true);
    setSubtitleMeta(`HEARD: “${parsed.command}”`);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: parsed.command }),
      });
      const data = await res.json();
      setMood(data.mood || ship.alert_level || "NOMINAL");
      setPendingConfirmations(data.pending_confirmations || []);
      setSubtitle(data.reply);
      setSubtitleMeta(
        data.receipts?.length
          ? `${data.receipts.map((r: any) => `${r.action_id.replace(/_/g, " ")}: ${r.status}`).join(" · ")}`
          : `${aiName.toUpperCase()} // ONLINE`
      );
      speak(data.reply);
      setRefreshTick((t) => t + 1);
    } catch {
      setSubtitle("Backend link offline on port 8785.");
      setSubtitleMeta("DISCONNECTED");
    } finally {
      setBusy(false);
    }
  };

  sendMessageRef.current = (txt: string) => {
    void sendMessage(txt);
  };

  const toggleMic = async () => {
    const ctrl = micControllerRef.current;
    if (!ctrl) return;
    if (listening && !handsFreeListening) {
      setListening(false);
      await ctrl.stop();
      return;
    }
    setHandsFreeListening(false);
    const ok = await ctrl.startPushToTalk();
    setListening(ok);
  };

  const toggleHandsFree = async () => {
    const ctrl = micControllerRef.current;
    if (!ctrl) return;
    if (handsFreeListening) {
      setHandsFreeListening(false);
      setListening(false);
      await ctrl.stop();
      return;
    }
    const ok = await ctrl.startHandsFreeWake();
    setHandsFreeListening(ok);
    setListening(ok);
  };

  const executeAction = async (actionId: string) => {
    const res = await fetch("/api/actions/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action_id: actionId }),
    });
    const rcpt = await res.json();
    setSubtitle(rcpt.reason);
    setSubtitleMeta(`${rcpt.action_id.replace(/_/g, " ")} // ${rcpt.status}`);
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
    setSubtitle(rcpt.reason);
    setSubtitleMeta(`SAFETY GATE // ${rcpt.status}`);
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
    setSubtitle(data.detail);
    setSubtitleMeta(`SIMULATOR // ${scenario.replace(/_/g, " ").toUpperCase()}`);
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

  const previewGameLink = async (state: "auto" | "red" | "yellow" | "green") => {
    const res = await fetch("/api/game-link/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state }),
    });
    if (res.ok) {
      setGameLink(await res.json());
    }
  };

  const applyMood = async (nextMood: string) => {
    setMood(nextMood);
    await fetch("/api/mood", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mood: nextMood }),
    });
  };

  const submitWhisper = (e: React.FormEvent) => {
    e.preventDefault();
    if (!whisperInput.trim() || busy) return;
    void sendMessage(whisperInput.trim());
    setWhisperInput("");
  };

  const persona = config?.persona || DEFAULT_PERSONA;
  const moodKey = (mood || "CALM").toLowerCase();
  const moodClass = moodKey === "calm" || moodKey === "nominal" ? "" : `mood-${moodKey}`;
  const gameDotClass = `game-${gameLink.state}`;

  const showMicFilament = handsFreeListening || listening || micStatus !== "IDLE";

  return (
    <div className={`stage-shell ${moodClass}`}>
      {/* Whisper-subtle ambient top-left identity + animated StarCitizen.exe Game Link beacon */}
      <div
        className="ambient-brand"
        onClick={() => setSettingsOpen(true)}
        title={`${gameLink.label} — ${gameLink.detail} (Click to configure StarCitizen.exe)`}
      >
        <span className={`ambient-dot ${gameDotClass}`} />
        <div>
          <div className="ambient-name">{persona.ai_name}</div>
          <div className={`ambient-sub ${gameDotClass}`}>
            {speaking
              ? "Speaking"
              : listening || wakeWindowActive
                ? "Listening"
                : calibrating
                  ? "Calibrating"
                  : gameLink.state === "green"
                    ? ship.zone
                    : gameLink.label}
          </div>
        </div>
      </div>

      {/* Floating Destructive Safety Gate Pill (only visible when needed) */}
      {pendingConfirmations.map((p) => (
        <div key={p.token} className="safety-pill">
          <ShieldAlert size={15} />
          <span>
            Confirm <strong>{p.action_id.replace(/_/g, " ")}</strong>?
          </span>
          <button className="btn danger" onClick={() => confirmAction(p.token, true)}>
            Confirm
          </button>
          <button className="btn" onClick={() => confirmAction(p.token, false)}>
            Abort
          </button>
        </div>
      ))}

      {/* === STAGE 1: PURE FLOATING ACOUSTIC ORB + OBSIDIAN FLOOR REFLECTION === */}
      {stageMode === "core" && (
        <div className="orb-center-stage">
          <JarvisCore3D
            mood={mood}
            speaking={speaking}
            listening={listening || wakeWindowActive}
            audioLevelRef={audioLevelRef}
            audioFreqRef={audioFreqRef}
            showReflection={true}
          />

          <div className="subtitle-stage">
            {subtitle ? (
              <div className="subtitle-text">{subtitle}</div>
            ) : (
              <div className="subtitle-text" style={{ color: "rgba(122, 163, 165, 0.72)", fontSize: 14 }}>
                Say “Hey {persona.ai_name}” or initialize calibration below.
              </div>
            )}

            <div className="subtitle-meta">
              {subtitleMeta && <span>{subtitleMeta}</span>}
              {lastIgnoredSpeech && !wakeWindowActive && (
                <span style={{ opacity: 0.65 }}>Ignored: “{lastIgnoredSpeech}”</span>
              )}
              {busy && <span style={{ color: "var(--teal-bright)" }}>Thinking...</span>}
            </div>

            {/* Minimal boot calibration trigger before first calibration */}
            {!hasCalibratedOnce && !calibrating && (
              <div className="boot-prompt-row">
                <button className="btn active" onClick={runCalibration}>
                  <Power size={12} /> Power On &amp; Calibrate
                </button>
                <button className="btn" onClick={() => setShowPersonaModal(true)}>
                  <Sparkles size={12} /> Personality Setup
                </button>
              </div>
            )}

            {/* Live minimalist diagnostic lines strictly while calibrating */}
            {calibrating && calSteps.length > 0 && (
              <div className="cal-live-strip">
                {calSteps.map((s) => (
                  <div
                    key={s.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      fontSize: 11.5,
                      color: s.status === "OK" ? "#a7f3d0" : s.status === "WARN" ? "#fde68a" : "#7aa3a5",
                      marginBottom: 4,
                    }}
                  >
                    {s.status === "OK" && <CheckCircle2 size={13} color="#10b981" />}
                    {s.status === "WARN" && <AlertTriangle size={13} color="#f59e0b" />}
                    {s.status === "RUNNING" && <Loader2 size={13} color="#2dd4bf" />}
                    <span style={{ fontWeight: 600 }}>{s.label}</span>
                    <span style={{ opacity: 0.75, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      — {s.detail}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* === STAGE 2: FULL-VIEWPORT FRIENDS HOLOGRAM + MINI FLOATING CORNER ORB === */}
      {stageMode === "hologram" && (
        <>
          <HoloDeck3D
            ship={ship}
            fleet={fleet}
            selectedAlly={selectedAlly}
            onSelectAlly={setSelectedAlly}
          />
          <div
            className="orb-corner-pip"
            onClick={() => setStageMode("core")}
            title={`Return to ${persona.ai_name} Core`}
          >
            <JarvisCore3D
              mood={mood}
              speaking={speaking}
              listening={listening || wakeWindowActive}
              audioLevelRef={audioLevelRef}
              audioFreqRef={audioFreqRef}
              showReflection={false}
            />
          </div>
        </>
      )}

      {/* Subtle floating mic level filament ONLY when mic is live */}
      {showMicFilament && (
        <div className="mic-filament">
          <span>{micStatus}</span>
          <div className="bar-track" style={{ width: 90, height: 4 }}>
            <div
              className="bar-fill"
              style={{ width: `${Math.max(6, Math.round(micLevel * 100))}%` }}
            />
          </div>
        </div>
      )}

      {/* Minimalist Floating Obsidian Bottom Dock */}
      <div className="bottom-dock">
        <button
          className={`btn ${stageMode === "core" ? "active" : ""}`}
          onClick={() => setStageMode("core")}
          title="AI Core Stage"
        >
          <CircleDot size={13} /> Core
        </button>
        <button
          className={`btn ${stageMode === "hologram" ? "active" : ""}`}
          onClick={() => setStageMode("hologram")}
          title="3D Friends & Fleet Hologram"
        >
          <Orbit size={13} /> Hologram
        </button>

        <div className="dock-divider" />

        <button
          className={`btn ${handsFreeListening ? "active" : ""}`}
          onClick={toggleHandsFree}
          title={`Hands-Free Wake Listening ("Hey ${persona.ai_name}")`}
        >
          <Ear size={13} /> {handsFreeListening ? "Wake On" : "Wake"}
        </button>
        <button
          className={`btn ${listening && !handsFreeListening ? "danger" : ""}`}
          onClick={toggleMic}
          title="Push-to-Talk (Browser Mic or Player2 Native OS Mic)"
        >
          {listening && !handsFreeListening ? <MicOff size={13} /> : <Mic size={13} />}
          {listening && !handsFreeListening ? "Stop" : "Talk"}
        </button>

        <div className="dock-divider" />

        <form onSubmit={submitWhisper} style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <input
            className="dock-input"
            placeholder={
              config?.wake_word_enabled ?? true
                ? `Say "Hey ${persona.ai_name}..."`
                : `Speak to ${persona.ai_name}...`
            }
            value={whisperInput}
            onChange={(e) => setWhisperInput(e.target.value)}
          />
          <button className="btn icon-only" type="submit" disabled={busy} title="Send">
            <Send size={13} />
          </button>
        </form>

        <button
          className={`btn icon-only ${ttsEnabled ? "active" : ""}`}
          onClick={() => setTtsEnabled((v) => !v)}
          title={ttsEnabled ? "Mute Voice" : "Unmute Voice"}
        >
          {ttsEnabled ? <Volume2 size={13} /> : <VolumeX size={13} />}
        </button>
      </div>

      {/* Tiny unobtrusive Settings Gear tucked quietly in bottom-right corner */}
      <button
        className="gear-fab"
        onClick={() => setSettingsOpen(true)}
        title={`Settings & Diagnostics (Player2 Heartbeat #${heartbeat?.count ?? 0})`}
        aria-label="Open Settings"
      >
        <Settings size={17} />
        {heartbeat?.last_ok && <span className="gear-hb-dot" />}
      </button>

      {/* Hidden Settings & Diagnostics Modal (Systems, RAG, Receipts, Persona, Config) */}
      <SettingsModal
        visible={settingsOpen}
        ship={ship}
        config={config}
        heartbeat={heartbeat}
        gameLink={gameLink}
        currentMood={mood}
        voices={voices}
        voicesNote={voicesNote}
        refreshTick={refreshTick}
        onClose={() => setSettingsOpen(false)}
        onStartCalibration={runCalibration}
        onOpenPersonaInterview={() => setShowPersonaModal(true)}
        onExecuteAction={executeAction}
        onTriggerScenario={triggerScenario}
        onPreviewGameLink={previewGameLink}
        onSetMood={applyMood}
        onSaveConfig={saveConfig}
        onSavePersona={handleSavePersonaDirect}
        onPingHeartbeat={pingHeartbeat}
        onRefreshVoices={refreshVoices}
        onTestVoice={() =>
          speak(`Hello ${persona.pilot_name}. ${persona.ai_name} vocal synthesizer is online and calibrated.`)
        }
      />

      {/* Person-to-AI Personality Interview Modal (only shown when invoked) */}
      <CalibrationOverlay
        visible={showPersonaModal}
        initialMode="personality"
        calibrating={calibrating}
        steps={calSteps}
        result={calResult}
        persona={persona}
        onStartCalibration={runCalibration}
        onSpeakPrompt={speak}
        onCompletePersonaInterview={handleCompletePersonaInterview}
        onDismiss={() => setShowPersonaModal(false)}
      />
    </div>
  );
}
