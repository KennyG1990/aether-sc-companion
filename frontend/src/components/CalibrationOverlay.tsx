import React, { useState } from "react";
import { CheckCircle2, AlertTriangle, Loader2, Power, Sparkles, Mic, MicOff, ArrowRight } from "lucide-react";
import { CalibrationResult, CalibrationStep, PersonaProfile } from "../types";

interface CalibrationOverlayProps {
  visible: boolean;
  initialMode?: "systems" | "personality";
  calibrating: boolean;
  steps: CalibrationStep[];
  result: CalibrationResult | null;
  persona: PersonaProfile;
  onStartCalibration: () => void;
  onSpeakPrompt: (text: string) => void;
  onCompletePersonaInterview: (answers: Record<string, string>) => Promise<void>;
  onDismiss: () => void;
}

const INTERVIEW_QUESTIONS = [
  {
    key: "identity",
    question: "First, what would you like to call me — and how should I address you when you call my name?",
    hint: "Your AI's name becomes your strict wake word (e.g., 'Hey Jarvis' or 'Hey Aether').",
  },
  {
    key: "tone",
    question: "How would you like me to behave and speak with you aboard your ship?",
    presets: [
      "Sharp, loyal tactical presence with dry British wit (Jarvis style)",
      "Warm, perceptive, fiercely loyal hologram partner (Cortana style)",
      "Relaxed, friendly spacer wingman with casual banter",
      "Strict military Executive Officer — formal, crisp, by the book",
    ],
  },
  {
    key: "verbosity",
    question: "How would you like me to reply and ask you questions during flight?",
    presets: [
      "Short 1-2 sentence combat callouts; ask quick yes/no questions before risky actions",
      "Balanced conversational tone; explain options briefly when things get complex",
      "Detailed tactical briefings and thorough follow-up questions",
    ],
  },
  {
    key: "humor_style",
    question: "Should I have humor on board? Tell me what kind of jokes or banter you enjoy.",
    presets: [
      "Dry sarcasm and Star Citizen spacer jokes (elevators, Drake duct tape, etc.)",
      "Playful witty teasing and light banter during quiet quantum jumps",
      "Keep it strictly professional — zero jokes",
    ],
  },
  {
    key: "custom_rules",
    question: "Last thing — any personal flying habits, favorite ships, or squad rules I should always remember?",
    presets: [
      "Always call out low shields, low hydrogen fuel, and allied distress beacons immediately.",
      "Remind me to switch to SCM before combat and check exterior doors before takeoff.",
    ],
  },
];

export const CalibrationOverlay: React.FC<CalibrationOverlayProps> = ({
  visible,
  initialMode = "systems",
  calibrating,
  steps,
  result,
  persona,
  onStartCalibration,
  onSpeakPrompt,
  onCompletePersonaInterview,
  onDismiss,
}) => {
  const [mode, setMode] = useState<"systems" | "personality">(initialMode);
  const [qIndex, setQIndex] = useState(0);
  const [aiName, setAiName] = useState(persona.ai_name || "Aether");
  const [pilotName, setPilotName] = useState(persona.pilot_name || "Commander");
  const [answers, setAnswers] = useState<Record<string, string>>({
    tone: persona.tone,
    verbosity: persona.verbosity,
    humor_style: persona.humor_style,
    custom_rules: persona.custom_rules,
  });
  const [savingPersona, setSavingPersona] = useState(false);
  const [micActive, setMicActive] = useState(false);

  React.useEffect(() => {
    setMode(initialMode);
    if (initialMode === "personality") {
      setQIndex(0);
    }
  }, [initialMode, visible]);

  if (!visible) return null;

  const progress = steps.length > 0 ? steps[steps.length - 1].progress : 0;

  const beginInterview = () => {
    setMode("personality");
    setQIndex(0);
    onSpeakPrompt(INTERVIEW_QUESTIONS[0].question);
  };

  const nextQuestion = async () => {
    if (qIndex < INTERVIEW_QUESTIONS.length - 1) {
      const next = qIndex + 1;
      setQIndex(next);
      onSpeakPrompt(INTERVIEW_QUESTIONS[next].question);
    } else {
      setSavingPersona(true);
      try {
        await onCompletePersonaInterview({
          ai_name: aiName.trim() || "Aether",
          pilot_name: pilotName.trim() || "Commander",
          tone: answers.tone || persona.tone,
          verbosity: answers.verbosity || persona.verbosity,
          question_style: answers.verbosity || persona.question_style,
          humor_style: answers.humor_style || persona.humor_style,
          custom_rules: answers.custom_rules || persona.custom_rules,
        });
        onDismiss();
      } finally {
        setSavingPersona(false);
      }
    }
  };

  const dictateAnswer = () => {
    const SpeechRec = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRec) return;
    const rec = new SpeechRec();
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.onstart = () => setMicActive(true);
    rec.onend = () => setMicActive(false);
    rec.onerror = () => setMicActive(false);
    rec.onresult = (ev: any) => {
      const text = ev.results?.[0]?.[0]?.transcript?.trim();
      if (!text) return;
      const curKey = INTERVIEW_QUESTIONS[qIndex].key;
      if (curKey === "identity") {
        // Heuristic: if user says "call you Jarvis, call me Captain"
        const mAi = text.match(/(?:call you|your name is|name you)\s+([a-zA-Z0-9_-]+)/i);
        const mPilot = text.match(/(?:call me|i am|i'm)\s+([a-zA-Z0-9 _-]+)/i);
        if (mAi) setAiName(mAi[1]);
        if (mPilot) setPilotName(mPilot[1]);
        if (!mAi && !mPilot) setAiName(text.split(/\s+/)[0]);
      } else {
        setAnswers((prev) => ({ ...prev, [curKey]: text }));
      }
    };
    rec.start();
  };

  const curQ = INTERVIEW_QUESTIONS[qIndex];

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 40,
        background: "rgba(3, 8, 18, 0.84)",
        backdropFilter: "blur(8px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div
        className="panel"
        style={{
          width: "100%",
          maxWidth: 590,
          padding: 22,
          borderColor: calibrating ? "rgba(245, 158, 11, 0.55)" : "rgba(34, 211, 238, 0.55)",
          boxShadow: "0 0 50px rgba(34, 211, 238, 0.18)",
        }}
      >
        {mode === "systems" ? (
          <>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <div>
                <div className="brand-title" style={{ fontSize: 18 }}>
                  {persona.ai_name.toUpperCase()} // STARTUP CALIBRATION
                </div>
                <div className="brand-sub" style={{ marginTop: 2 }}>
                  Player2 Heartbeat &amp; LLM · ElevenLabs Voice · Star Citizen Telemetry
                </div>
              </div>
              <span className={`pill ${calibrating ? "amber" : result ? "emerald" : ""}`}>
                {calibrating ? `CALIBRATING ${progress}%` : result ? result.status : "STANDBY"}
              </span>
            </div>

            <div className="bar-track" style={{ height: 8, marginBottom: 16 }}>
              <div
                className={`bar-fill ${calibrating ? "warn" : ""}`}
                style={{ width: `${calibrating ? Math.max(12, progress) : result ? 100 : 0}%` }}
              />
            </div>

            {!calibrating && steps.length === 0 && (
              <div style={{ fontSize: 13, color: "#cbd5e1", lineHeight: 1.55, marginBottom: 18 }}>
                Power on to unlock ElevenLabs voice playback, send the official Player2 Mod heartbeat, check your
                SQLite RAG &amp; Persona matrix, and run live Star Citizen ship diagnostics.
              </div>
            )}

            {steps.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
                {steps.map((s) => (
                  <div
                    key={s.id}
                    className="card"
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 10,
                      borderColor:
                        s.status === "OK"
                          ? "rgba(16, 185, 129, 0.35)"
                          : s.status === "WARN"
                            ? "rgba(245, 158, 11, 0.4)"
                            : "rgba(34, 211, 238, 0.4)",
                    }}
                  >
                    <div style={{ marginTop: 2 }}>
                      {s.status === "OK" && <CheckCircle2 size={15} color="#10b981" />}
                      {s.status === "WARN" && <AlertTriangle size={15} color="#f59e0b" />}
                      {s.status === "RUNNING" && <Loader2 size={15} color="#22d3ee" />}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: "0.08em", color: "#e2f1ff" }}>
                        {s.label}
                      </div>
                      <div style={{ fontSize: 11.5, color: "#94a3b8", marginTop: 2 }}>{s.detail}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {result && (
              <div
                className="card"
                style={{
                  marginBottom: 16,
                  borderColor: "rgba(16, 185, 129, 0.55)",
                  background: "rgba(16, 185, 129, 0.1)",
                }}
              >
                <div style={{ fontSize: 10, color: "#6ee7b7", letterSpacing: "0.14em", textTransform: "uppercase" }}>
                  VOICE READINESS BRIEFING ({result.provider_used})
                </div>
                <div style={{ fontSize: 13.5, color: "#f0fdf4", marginTop: 6, lineHeight: 1.45 }}>
                  “{result.briefing}”
                </div>
              </div>
            )}

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
              {!calibrating && (
                <button className="btn" onClick={onDismiss}>
                  {result ? "ENTER COMMAND DECK" : "SKIP TO BRIDGE"}
                </button>
              )}
              {!calibrating && (
                <button className="btn amber" onClick={beginInterview}>
                  <Sparkles size={13} /> PERSONALITY SETUP
                </button>
              )}
              <button
                className="btn active"
                disabled={calibrating}
                onClick={onStartCalibration}
                style={{ padding: "8px 16px" }}
              >
                <Power size={14} />
                {calibrating ? "CALIBRATING SYSTEMS..." : result ? "RE-CALIBRATE" : "POWER ON & CALIBRATE"}
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <div>
                <div className="brand-title" style={{ fontSize: 17 }}>
                  PERSON-TO-AI PERSONALITY CALIBRATION
                </div>
                <div className="brand-sub" style={{ marginTop: 2 }}>
                  Question {qIndex + 1} of {INTERVIEW_QUESTIONS.length} · Speak or type how you want your AI to act
                </div>
              </div>
              <span className="pill amber">
                STEP {qIndex + 1}/{INTERVIEW_QUESTIONS.length}
              </span>
            </div>

            <div className="bar-track" style={{ height: 6, marginBottom: 16 }}>
              <div className="bar-fill" style={{ width: `${((qIndex + 1) / INTERVIEW_QUESTIONS.length) * 100}%` }} />
            </div>

            <div
              className="card"
              style={{
                marginBottom: 14,
                borderColor: "rgba(34, 211, 238, 0.45)",
                background: "rgba(34, 211, 238, 0.08)",
              }}
            >
              <div style={{ fontSize: 14, color: "#e2f1ff", lineHeight: 1.5, fontWeight: 600 }}>
                “{curQ.question}”
              </div>
              {curQ.hint && <div style={{ fontSize: 11.5, color: "#94a3b8", marginTop: 6 }}>{curQ.hint}</div>}
            </div>

            {curQ.key === "identity" ? (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
                <div className="field-group">
                  <label>AI Name (Wake Word: "Hey ...")</label>
                  <input
                    className="text-input"
                    value={aiName}
                    onChange={(e) => setAiName(e.target.value)}
                    placeholder="e.g. Jarvis, Aether, Cortana"
                  />
                </div>
                <div className="field-group">
                  <label>What should I call you?</label>
                  <input
                    className="text-input"
                    value={pilotName}
                    onChange={(e) => setPilotName(e.target.value)}
                    placeholder="e.g. Commander, Captain, Alex"
                  />
                </div>
              </div>
            ) : (
              <>
                {curQ.presets && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
                    {curQ.presets.map((preset) => (
                      <button
                        key={preset}
                        className={`btn ${answers[curQ.key] === preset ? "active" : ""}`}
                        style={{ justifyContent: "flex-start", textAlign: "left", whiteSpace: "normal", lineHeight: 1.35 }}
                        onClick={() => setAnswers((prev) => ({ ...prev, [curQ.key]: preset }))}
                      >
                        {preset}
                      </button>
                    ))}
                  </div>
                )}
                <div className="field-group">
                  <label>Or describe it in your own words</label>
                  <input
                    className="text-input"
                    value={answers[curQ.key] || ""}
                    onChange={(e) => setAnswers((prev) => ({ ...prev, [curQ.key]: e.target.value }))}
                    placeholder="Type or click SPEAK ANSWER..."
                  />
                </div>
              </>
            )}

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14 }}>
              <button className={`btn ${micActive ? "danger" : ""}`} onClick={dictateAnswer}>
                {micActive ? <MicOff size={13} /> : <Mic size={13} />}
                {micActive ? "LISTENING..." : "SPEAK ANSWER"}
              </button>

              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn" onClick={onDismiss}>
                  CANCEL
                </button>
                {qIndex > 0 && (
                  <button className="btn" onClick={() => setQIndex((i) => i - 1)}>
                    BACK
                  </button>
                )}
                <button className="btn active" disabled={savingPersona} onClick={nextQuestion}>
                  {savingPersona
                    ? "LOCKING PERSONA..."
                    : qIndex === INTERVIEW_QUESTIONS.length - 1
                      ? "LOCK PERSONALITY"
                      : "NEXT"}
                  <ArrowRight size={13} />
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
