import React from "react";
import { X, Power, Sparkles } from "lucide-react";
import { InspectorPanel } from "./InspectorPanel";
import {
  AetherConfigData,
  GameLinkStatus,
  HeartbeatState,
  PersonaProfile,
  ShipTelemetry,
  VoiceOption,
} from "../types";

interface SettingsModalProps {
  visible: boolean;
  ship: ShipTelemetry;
  config: AetherConfigData | null;
  heartbeat: HeartbeatState | null;
  gameLink: GameLinkStatus;
  currentMood: string;
  voices: VoiceOption[];
  voicesNote: string | null;
  refreshTick: number;
  onClose: () => void;
  onStartCalibration: () => void;
  onOpenPersonaInterview: () => void;
  onExecuteAction: (actionId: string) => void;
  onTriggerScenario: (scenario: string) => void;
  onPreviewGameLink: (state: "auto" | "red" | "yellow" | "green") => Promise<void>;
  onSetMood: (mood: string) => Promise<void>;
  onSaveConfig: (patch: Record<string, unknown>) => Promise<void>;
  onSavePersona: (profile: PersonaProfile) => Promise<void>;
  onPingHeartbeat: () => Promise<void>;
  onRefreshVoices: (providerOverride?: string) => Promise<void>;
  onTestVoice: () => void;
}

/**
 * Hidden behind the tiny bottom-right gear icon.
 * Houses Config (Player2 / OpenRouter / Own ElevenLabs / Spotify), Persona, Systems/Sim,
 * and behind-the-scenes SQLite RAG & Receipts diagnostics so the main stage stays pure.
 */
export const SettingsModal: React.FC<SettingsModalProps> = ({
  visible,
  ship,
  config,
  heartbeat,
  gameLink,
  currentMood,
  voices,
  voicesNote,
  refreshTick,
  onClose,
  onStartCalibration,
  onOpenPersonaInterview,
  onExecuteAction,
  onTriggerScenario,
  onPreviewGameLink,
  onSetMood,
  onSaveConfig,
  onSavePersona,
  onPingHeartbeat,
  onRefreshVoices,
  onTestVoice,
}) => {
  if (!visible) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: "0.24em", color: "var(--teal-bright)" }}>
              {(config?.persona?.ai_name || "AETHER").toUpperCase()} // SYSTEM SETTINGS
            </div>
            <div style={{ fontSize: 10.5, color: "var(--text-muted)", marginTop: 3 }}>
              Background RAG, Player2 60s Heartbeat, Voice, Spotify &amp; Ship Telemetry Diagnostics
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              className="btn"
              onClick={() => {
                onClose();
                onStartCalibration();
              }}
            >
              <Power size={12} /> Calibrate
            </button>
            <button
              className="btn amber"
              onClick={() => {
                onClose();
                onOpenPersonaInterview();
              }}
            >
              <Sparkles size={12} /> Interview
            </button>
            <button className="btn icon-only" onClick={onClose} title="Close Settings">
              <X size={15} />
            </button>
          </div>
        </div>

        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <InspectorPanel
            ship={ship}
            config={config}
            heartbeat={heartbeat}
            gameLink={gameLink}
            currentMood={currentMood}
            voices={voices}
            voicesNote={voicesNote}
            onExecuteAction={onExecuteAction}
            onTriggerScenario={onTriggerScenario}
            onPreviewGameLink={onPreviewGameLink}
            onSetMood={onSetMood}
            onSaveConfig={onSaveConfig}
            onSavePersona={onSavePersona}
            onOpenPersonaInterview={() => {
              onClose();
              onOpenPersonaInterview();
            }}
            onPingHeartbeat={onPingHeartbeat}
            onRefreshVoices={onRefreshVoices}
            onTestVoice={onTestVoice}
            refreshTick={refreshTick}
          />
        </div>
      </div>
    </div>
  );
};
