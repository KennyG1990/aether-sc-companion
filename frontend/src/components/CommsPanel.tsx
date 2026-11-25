import React, { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Send, ShieldAlert, Volume2, VolumeX, Ear } from "lucide-react";
import { ChatMessage, PendingConfirmation } from "../types";

interface CommsPanelProps {
  aiName: string;
  pilotName: string;
  wakeWordEnabled: boolean;
  wakeWindowActive: boolean;
  handsFreeListening: boolean;
  lastIgnoredSpeech: string | null;
  messages: ChatMessage[];
  pendingConfirmations: PendingConfirmation[];
  listening: boolean;
  ttsEnabled: boolean;
  busy: boolean;
  onSend: (text: string) => void;
  onToggleMic: () => void;
  onToggleHandsFree: () => void;
  onToggleTts: () => void;
  onConfirmAction: (token: string, approve: boolean) => void;
}

export const CommsPanel: React.FC<CommsPanelProps> = ({
  aiName,
  pilotName,
  wakeWordEnabled,
  wakeWindowActive,
  handsFreeListening,
  lastIgnoredSpeech,
  messages,
  pendingConfirmations,
  listening,
  ttsEnabled,
  busy,
  onSend,
  onToggleMic,
  onToggleHandsFree,
  onToggleTts,
  onConfirmAction,
}) => {
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || busy) return;
    onSend(input.trim());
    setInput("");
  };

  const quickPrompts = [
    `Hey ${aiName}`,
    "Hey John, pass the salt",
    `Hey ${aiName}, drop landing gear`,
    `Hey ${aiName}, tell me a joke`,
    `Hey ${aiName}, where are our allies?`,
    `Hey ${aiName}, self destruct`,
  ];

  return (
    <div className="panel comms-box">
      <div className="panel-header">
        <span>VOICE &amp; COMMS ({aiName.toUpperCase()})</span>
        <div style={{ display: "flex", gap: 5 }}>
          <button className={`btn ${ttsEnabled ? "active" : ""}`} onClick={onToggleTts} title="Toggle TTS Voice">
            {ttsEnabled ? <Volume2 size={12} /> : <VolumeX size={12} />}
          </button>
          <button
            className={`btn ${handsFreeListening ? "active" : ""}`}
            onClick={onToggleHandsFree}
            title={`Hands-Free Wake-Word Listener ("Hey ${aiName}")`}
          >
            <Ear size={12} />
            {handsFreeListening ? "WAKE ON" : "WAKE"}
          </button>
          <button
            className={`btn ${listening ? "danger" : ""}`}
            onClick={onToggleMic}
            title="Push-to-Talk Speech-to-Text"
          >
            {listening ? <MicOff size={12} /> : <Mic size={12} />}
            {listening ? "STOP" : "TALK"}
          </button>
        </div>
      </div>

      {/* Wake-Word Gate Status Strip */}
      {wakeWordEnabled && (
        <div
          style={{
            padding: "5px 10px",
            fontSize: 10.5,
            borderBottom: "1px solid rgba(34, 211, 238, 0.14)",
            background: wakeWindowActive ? "rgba(16, 185, 129, 0.12)" : "rgba(4, 12, 26, 0.65)",
            color: wakeWindowActive ? "#6ee7b7" : "#7ea3c4",
            display: "flex",
            justifyContent: "space-between",
            gap: 8,
            flexShrink: 0,
          }}
        >
          <span>
            {wakeWindowActive
              ? `ACTIVE WINDOW: Listening directly to ${pilotName}...`
              : `WAKE GATE: Say "Hey ${aiName}" or "${aiName}"`}
          </span>
          {lastIgnoredSpeech && !wakeWindowActive && (
            <span style={{ color: "#94a3b8", fontStyle: "italic", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 140 }}>
              Ignored: “{lastIgnoredSpeech}”
            </span>
          )}
        </div>
      )}

      {/* Destructive Action Safety Gate */}
      {pendingConfirmations.map((p) => (
        <div key={p.token} className="safety-banner">
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 700, color: "#fca5a5" }}>
            <ShieldAlert size={14} /> SAFETY GATE: Confirm `{p.action_id}`?
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button className="btn danger" onClick={() => onConfirmAction(p.token, true)}>
              CONFIRM EXECUTE
            </button>
            <button className="btn" onClick={() => onConfirmAction(p.token, false)}>
              ABORT
            </button>
          </div>
        </div>
      ))}

      <div className="chat-scroll">
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            <div>{m.content}</div>
            <div className="msg-meta">
              {m.provider && <span>via {m.provider}</span>}
              {m.injectionFlagged && <span style={{ color: "#f59e0b" }}>INJECTION QUARANTINED</span>}
              {m.retrieved && m.retrieved.length > 0 && (
                <span style={{ color: "#22d3ee" }}>RAG hits: {m.retrieved.length}</span>
              )}
              {m.receipts && m.receipts.length > 0 && (
                <span style={{ color: "#6ee7b7" }}>
                  Receipts: {m.receipts.map((r) => `${r.action_id}:${r.status}`).join(", ")}
                </span>
              )}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <div className="quick-chips">
        {quickPrompts.map((q) => (
          <button key={q} className="chip" onClick={() => onSend(q)}>
            {q}
          </button>
        ))}
      </div>

      <form className="chat-input-bar" onSubmit={submit}>
        <input
          className="text-input"
          placeholder={wakeWordEnabled ? `Say "Hey ${aiName}..." or type command` : `Talk to ${aiName}...`}
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button className="btn active" type="submit" disabled={busy}>
          <Send size={13} />
        </button>
      </form>
    </div>
  );
};
