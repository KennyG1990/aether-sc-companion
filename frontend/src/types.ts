export interface ShieldQuadrants {
  front: number;
  back: number;
  left: number;
  right: number;
}

export interface PlayerVitals {
  health_pct: number;
  oxygen_pct: number;
  hydration_pct: number;
  hunger_pct: number;
  heart_rate_bpm: number;
  body_temp_c: number;
  locomotion: string;
}

export interface ShipTelemetry {
  timestamp: number;
  source: string;
  zone: string;
  planet: string;
  speed_mps: number;
  vertical_speed_mps: number;
  radar_altitude_m: number;
  pitch_deg: number;
  roll_deg: number;
  yaw_deg: number;
  g_force: number;
  hydrogen_fuel_pct: number;
  quantum_fuel_pct: number;
  hull_pct: number;
  shields: ShieldQuadrants;
  master_mode: "SCM" | "NAV" | string;
  landing_gear_down: boolean;
  exterior_lights_on: boolean;
  vtol_enabled: boolean;
  doors_open: boolean;
  quantum_spooling: boolean;
  flight_assist: boolean;
  under_fire: boolean;
  alert_level: "NOMINAL" | "CAUTION" | "COMBAT" | string;
  vitals: PlayerVitals;
}

export interface AllyShipState {
  callsign: string;
  pilot_name: string;
  ship_name: string;
  ship_class: string;
  squad: string;
  role: string;
  planet: string;
  zone: string;
  orbit_angle_rad: number;
  orbit_radius: number;
  shields_pct: number;
  hull_pct: number;
  fuel_pct: number;
  status: string;
  under_fire: boolean;
  last_seen: number;
  relay_source: string;
}

export interface TelemetryEvent {
  event_id: string;
  event_type: string;
  severity: string;
  summary: string;
  timestamp: number;
}

export interface PendingConfirmation {
  token: string;
  action_id: string;
  created_at: number;
}

export interface RetrievedMemoryHit {
  id: string;
  domain: string;
  truth_class: string;
  provenance: string;
  content: string;
  bm25_rank?: number | null;
  vector_score?: number;
  rrf_score?: number;
}

export interface ActionReceipt {
  id: string;
  action_id: string;
  status: string;
  reason: string;
  source: string;
  created_at: number;
  confirmation_token?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "alert";
  content: string;
  mood?: string;
  provider?: string;
  injectionFlagged?: boolean;
  retrieved?: RetrievedMemoryHit[];
  receipts?: ActionReceipt[];
  timestamp: number;
}

export interface VoiceOption {
  voice_id: string;
  name: string;
  accent: string;
  gender: string;
  category: string;
}

export interface Player2Status {
  api_online: boolean;
  client_version: string | null;
  joules: number | null;
  patron_tier: string | null;
  elevenlabs_voices_count: number;
  mcp_online: boolean;
  mcp_server: string | null;
}

export interface CalibrationStep {
  id: string;
  label: string;
  status: "RUNNING" | "OK" | "WARN";
  detail: string;
  progress: number;
  timestamp: number;
}

export interface CalibrationResult {
  status: string;
  briefing: string;
  provider_used: string;
  duration_sec: number;
  steps: CalibrationStep[];
}

export interface AetherConfigData {
  llm_provider: string;
  player2_base_url: string;
  player2_mcp_url: string;
  player2_game_key: string;
  openrouter_api_key_set: boolean;
  openrouter_model: string;
  tts_provider: string;
  elevenlabs_voice_id: string;
  elevenlabs_model_id: string;
  elevenlabs_api_key_set: boolean;
  telemetry_mode: string;
  grpc_target: string;
  proactive_alerts_enabled: boolean;
  tts_enabled: boolean;
  pilot_callsign: string;
  ship_name: string;
  grpc_status?: {
    target: string;
    port_open: boolean;
    proto_loaded: boolean;
    last_error: string | null;
  };
  player2_status?: Player2Status;
}
