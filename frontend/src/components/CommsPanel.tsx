import React, { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Send, ShieldAlert, Volume2, VolumeX } from "lucide-react";
import { ChatMessage, PendingConfirmation } from "../types";

interface CommsPanelProps {
  messages: ChatMessage[];
  pendingConfirmations: PendingConfirmation[];
  listening: boolean;
  ttsEnabled: boolean;
  busy: boolean;
  onSend: (text: string) => void;
  onToggleMic: () => void;
  onToggleTts: () => void;
  onConfirmAction: (token: string, approve: boolean) => void;
}

const QUICK_PROMPTS = [
  "Drop landing gear",
  "Switch to NAV mode",
  "Where are our allies?",
  "Tell me a joke",
  "Remember Alex flies a Cutlass Red",
  "Self destruct",
];

export const CommsPanel: React.FC<CommsPanelProps> = ({
  messages,
  pendingConfirmations,
  listening,
  ttsEnabled,
  busy,
  onSend,
  onToggleMic,
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

  return (
    <div className="panel comms-box">
      <div className="panel-header">
        <span>VOICE &amp; COMMS LINK</span>
        <div style={{ display: "flex", gap: 6 }}>
          <button className={`btn ${ttsEnabled ? "active" : ""}`} onClick={onToggleTts} title="Toggle TTS Voice">
            {ttsEnabled ? <Volume2 size={13} /> : <VolumeX size={13} />}
          </button>
          <button
            className={`btn ${listening ? "danger" : ""}`}
            onClick={onToggleMic}
            title="Push-to-Talk Speech-to-Text"
          >
            {listening ? <MicOff size={13} /> : <Mic size={13} />}
            {listening ? "STOP" : "TALK"}
          </button>
        </div>
      </div>

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
        {QUICK_PROMPTS.map((q) => (
          <button key={q} className="chip" onClick={() => onSend(q)}>
            {q}
          </button>
        ))}
      </div>

      <form className="chat-input-bar" onSubmit={submit}>
        <input
          className="text-input"
          placeholder="Talk to AETHER or issue ship commands..."
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
