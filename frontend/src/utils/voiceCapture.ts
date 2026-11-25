/**
 * Real Microphone Capture + 16kHz PCM WAV Encoder + Voice Activity Detection (VAD)
 * powered by Player2 Local Whisper STT (/api/stt/transcribe) with automatic fallback
 * to Player2 Native OS Microphone (/api/stt/p2/start & /api/stt/p2/stop).
 *
 * Eliminates Google's broken Web Speech API (webkitSpeechRecognition) silent failure loops.
 */

export function encodeWav16k(samples: Float32Array, inputSampleRate: number): Blob {
  const targetRate = 16000;
  const ratio = inputSampleRate / targetRate;
  const outLength = Math.max(1, Math.floor(samples.length / ratio));
  const pcm = new Int16Array(outLength);

  for (let i = 0; i < outLength; i++) {
    const idx = Math.min(samples.length - 1, Math.floor(i * ratio));
    const s = Math.max(-1, Math.min(1, samples[idx]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }

  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + pcm.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // Linear PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, pcm.length * 2, true);

  let offset = 44;
  for (let i = 0; i < pcm.length; i++, offset += 2) {
    view.setInt16(offset, pcm[i], true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function concatFloat32(chunks: Float32Array[]): Float32Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export async function transcribeWavViaBackend(wavBlob: Blob): Promise<{ ok: boolean; text: string; error?: string }> {
  const form = new FormData();
  form.append("file", wavBlob, "speech.wav");
  const resp = await fetch("/api/stt/transcribe", {
    method: "POST",
    body: form,
  });
  if (!resp.ok) {
    return { ok: false, text: "", error: `STT HTTP ${resp.status}` };
  }
  return await resp.json();
}

export interface VadCallbacks {
  isAiSpeaking: () => boolean;
  onMicLevel: (level: number) => void;
  onStateChange: (status: string) => void;
  onTranscript: (text: string) => void;
  onError: (msg: string) => void;
}

/**
 * Hands-Free Voice Activity Detector (for WAKE mode) & Manual Push-to-Talk Recorder.
 */
export class AetherMicController {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;

  private mode: "idle" | "vad" | "ptt" | "p2_native_ptt" = "idle";
  private sampleRate = 48000;
  private preRoll: Float32Array[] = [];
  private activeChunks: Float32Array[] = [];
  private speechDetected = false;
  private lastVoiceMs = 0;
  private utteranceStartMs = 0;
  private transcribing = false;
  private lastAiSpokeMs = 0;
  private callbacks: VadCallbacks;

  constructor(callbacks: VadCallbacks) {
    this.callbacks = callbacks;
  }

  public getMode(): string {
    return this.mode;
  }

  private async openBrowserMic(): Promise<boolean> {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return false;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      this.ctx = new AudioCtx();
      if (this.ctx.state === "suspended") await this.ctx.resume();
      this.sampleRate = this.ctx.sampleRate;
      this.source = this.ctx.createMediaStreamSource(this.stream);
      this.processor = this.ctx.createScriptProcessor(4096, 1, 1);

      this.processor.onaudioprocess = (ev) => {
        const input = ev.inputBuffer.getChannelData(0);
        const copy = new Float32Array(input.length);
        copy.set(input);
        this.handleAudioChunk(copy);
      };

      this.source.connect(this.processor);
      // Connect through muted gain so ScriptProcessor ticks without playing mic feedback to speakers
      const silentGain = this.ctx.createGain();
      silentGain.gain.value = 0;
      this.processor.connect(silentGain);
      silentGain.connect(this.ctx.destination);
      return true;
    } catch {
      this.cleanupAudioNodes();
      return false;
    }
  }

  private cleanupAudioNodes(): void {
    try {
      this.processor?.disconnect();
      this.source?.disconnect();
      this.stream?.getTracks().forEach((t) => t.stop());
      if (this.ctx && this.ctx.state !== "closed") {
        void this.ctx.close();
      }
    } catch {
      // ignore
    }
    this.processor = null;
    this.source = null;
    this.stream = null;
    this.ctx = null;
    this.callbacks.onMicLevel(0);
  }

  private handleAudioChunk(chunk: Float32Array): void {
    const now = performance.now();

    // Compute RMS loudness
    let sumSq = 0;
    for (let i = 0; i < chunk.length; i++) sumSq += chunk[i] * chunk[i];
    const rms = Math.sqrt(sumSq / chunk.length);
    const displayLevel = Math.min(1.0, rms * 10.0);
    this.callbacks.onMicLevel(displayLevel);

    // Push-to-Talk mode: capture everything until user clicks STOP
    if (this.mode === "ptt") {
      this.activeChunks.push(chunk);
      return;
    }

    if (this.mode !== "vad") return;

    // Echo guard: do NOT trigger VAD while AETHER is talking (plus 500ms tail guard)
    if (this.callbacks.isAiSpeaking()) {
      this.lastAiSpokeMs = now;
      this.speechDetected = false;
      this.activeChunks = [];
      this.preRoll = [];
      return;
    }
    if (now - this.lastAiSpokeMs < 550) return;

    // Maintain ~350ms pre-roll ring buffer (4 chunks @ 4096/48kHz)
    this.preRoll.push(chunk);
    if (this.preRoll.length > 4) this.preRoll.shift();

    const SPEECH_THRESHOLD = 0.02;
    const SILENCE_HOLD_MS = 950;
    const MAX_UTTERANCE_MS = 9500;

    if (rms >= SPEECH_THRESHOLD) {
      if (!this.speechDetected) {
        this.speechDetected = true;
        this.utteranceStartMs = now;
        this.activeChunks = [...this.preRoll];
        this.callbacks.onStateChange("HEARING VOICE...");
      } else {
        this.activeChunks.push(chunk);
      }
      this.lastVoiceMs = now;
    } else if (this.speechDetected) {
      this.activeChunks.push(chunk);
      const silenceElapsed = now - this.lastVoiceMs;
      const totalElapsed = now - this.utteranceStartMs;
      if (silenceElapsed >= SILENCE_HOLD_MS || totalElapsed >= MAX_UTTERANCE_MS) {
        const captured = this.activeChunks;
        this.speechDetected = false;
        this.activeChunks = [];
        void this.flushChunksToWhisper(captured);
      }
    }
  }

  private async flushChunksToWhisper(chunks: Float32Array[]): Promise<void> {
    if (this.transcribing || chunks.length === 0) return;
    const pcm = concatFloat32(chunks);
    // Ignore tiny < 0.35s accidental pops
    if (pcm.length / this.sampleRate < 0.35) {
      this.callbacks.onStateChange(this.mode === "vad" ? "LISTENING (MIC LIVE)" : "IDLE");
      return;
    }

    this.transcribing = true;
    this.callbacks.onStateChange("TRANSCRIBING (P2 WHISPER)...");
    try {
      const wav = encodeWav16k(pcm, this.sampleRate);
      const res = await transcribeWavViaBackend(wav);
      if (!res.ok && res.error) {
        this.callbacks.onError(res.error);
      } else if (res.text) {
        this.callbacks.onTranscript(res.text);
      }
    } catch {
      this.callbacks.onError("Failed to contact /api/stt/transcribe.");
    } finally {
      this.transcribing = false;
      if (this.mode === "vad") {
        this.callbacks.onStateChange("LISTENING (MIC LIVE)");
      } else {
        this.callbacks.onStateChange("IDLE");
      }
    }
  }

  /** Start continuous Hands-Free Wake-Word VAD mode */
  public async startHandsFreeWake(): Promise<boolean> {
    await this.stop();
    const opened = await this.openBrowserMic();
    if (!opened) {
      this.callbacks.onError(
        "Browser tab blocked microphone access. Open http://localhost:5173 in Chrome/Edge for continuous WAKE — or use the TALK button right here (uses Player2's native Windows mic automatically!)."
      );
      return false;
    }
    this.mode = "vad";
    this.speechDetected = false;
    this.activeChunks = [];
    this.preRoll = [];
    this.callbacks.onStateChange("LISTENING (MIC LIVE)");
    return true;
  }

  /** Start Push-to-Talk (uses Browser Mic -> Player2 Whisper, or auto-falls back to Player2 Native Windows Mic!) */
  public async startPushToTalk(): Promise<boolean> {
    await this.stop();
    const opened = await this.openBrowserMic();
    if (opened) {
      this.mode = "ptt";
      this.activeChunks = [];
      this.callbacks.onStateChange("RECORDING (CLICK STOP)...");
      return true;
    }

    // Automatic fallback to Player2 App's native OS microphone!
    try {
      const resp = await fetch("/api/stt/p2/start", { method: "POST" });
      const data = await resp.json();
      if (data.ok) {
        this.mode = "p2_native_ptt";
        this.callbacks.onStateChange("RECORDING (PLAYER2 OS MIC)...");
        return true;
      }
      this.callbacks.onError(data.error || "Could not start Player2 native microphone.");
      return false;
    } catch {
      this.callbacks.onError("Microphone unavailable in browser and Player2 native STT unreachable.");
      return false;
    }
  }

  /** Stop active recording or hands-free listening */
  public async stop(): Promise<void> {
    const prevMode = this.mode;
    this.mode = "idle";

    if (prevMode === "ptt") {
      const captured = this.activeChunks;
      this.activeChunks = [];
      this.cleanupAudioNodes();
      await this.flushChunksToWhisper(captured);
      return;
    }

    if (prevMode === "p2_native_ptt") {
      this.callbacks.onStateChange("TRANSCRIBING (PLAYER2 OS MIC)...");
      try {
        const resp = await fetch("/api/stt/p2/stop", { method: "POST" });
        const data = await resp.json();
        if (data.ok && data.text) {
          this.callbacks.onTranscript(data.text);
        } else if (data.error) {
          this.callbacks.onError(data.error);
        }
      } catch {
        this.callbacks.onError("Failed to stop Player2 native STT.");
      } finally {
        this.callbacks.onStateChange("IDLE");
      }
      return;
    }

    this.speechDetected = false;
    this.activeChunks = [];
    this.preRoll = [];
    this.cleanupAudioNodes();
    this.callbacks.onStateChange("IDLE");
  }
}
