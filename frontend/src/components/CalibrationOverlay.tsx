import React from "react";
import { CheckCircle2, AlertTriangle, Loader2, Power } from "lucide-react";
import { CalibrationResult, CalibrationStep } from "../types";

interface CalibrationOverlayProps {
  visible: boolean;
  calibrating: boolean;
  steps: CalibrationStep[];
  result: CalibrationResult | null;
  onStartCalibration: () => void;
  onDismiss: () => void;
}

export const CalibrationOverlay: React.FC<CalibrationOverlayProps> = ({
  visible,
  calibrating,
  steps,
  result,
  onStartCalibration,
  onDismiss,
}) => {
  if (!visible) return null;

  const progress = steps.length > 0 ? steps[steps.length - 1].progress : 0;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 40,
        background: "rgba(3, 8, 18, 0.82)",
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
          maxWidth: 560,
          padding: 22,
          borderColor: calibrating ? "rgba(245, 158, 11, 0.55)" : "rgba(34, 211, 238, 0.55)",
          boxShadow: "0 0 50px rgba(34, 211, 238, 0.18)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <div>
            <div className="brand-title" style={{ fontSize: 18 }}>
              AETHER // STARTUP CALIBRATION
            </div>
            <div className="brand-sub" style={{ marginTop: 2 }}>
              Player2 Neural LLM · ElevenLabs Voice · Star Citizen Telemetry
            </div>
          </div>
          <span className={`pill ${calibrating ? "amber" : result ? "emerald" : ""}`}>
            {calibrating ? `CALIBRATING ${progress}%` : result ? result.status : "STANDBY"}
          </span>
        </div>

        {/* Progress Bar */}
        <div className="bar-track" style={{ height: 8, marginBottom: 16 }}>
          <div
            className={`bar-fill ${calibrating ? "warn" : ""}`}
            style={{ width: `${calibrating ? Math.max(12, progress) : result ? 100 : 0}%` }}
          />
        </div>

        {!calibrating && steps.length === 0 && (
          <div style={{ fontSize: 13, color: "#cbd5e1", lineHeight: 1.55, marginBottom: 18 }}>
            Power on AETHER to unlock ElevenLabs voice synthesis, probe your local Player2 LLM &amp; MCP server
            (<code style={{ color: "#22d3ee" }}>:4315</code> / <code style={{ color: "#22d3ee" }}>:9847</code>), verify
            your SQLite RAG index, and run live ship telemetry checks.
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
              AETHER VOICE READINESS BRIEFING ({result.provider_used})
            </div>
            <div style={{ fontSize: 13.5, color: "#f0fdf4", marginTop: 6, lineHeight: 1.45 }}>
              “{result.briefing}”
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          {!calibrating && (
            <button className="btn" onClick={onDismiss}>
              {result ? "ENTER COMMAND DECK" : "SKIP TO BRIDGE"}
            </button>
          )}
          <button
            className="btn active"
            disabled={calibrating}
            onClick={onStartCalibration}
            style={{ padding: "8px 16px" }}
          >
            <Power size={14} />
            {calibrating ? "CALIBRATING SYSTEMS..." : result ? "RE-RUN CALIBRATION" : "POWER ON & CALIBRATE"}
          </button>
        </div>
      </div>
    </div>
  );
};
