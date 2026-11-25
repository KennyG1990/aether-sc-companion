/**
 * Strict Wake-Word Gate for AETHER with Whisper phonetic resilience.
 *
 * - Rejects non-addressed speech ("Hey John, pass the salt") locally with zero LLM/TTS calls.
 * - Handles common Whisper phonetic spellings (e.g. "Aether" transcribed as "ether"/"either"/"ather").
 * - Filters out common Whisper silence artifacts ("[BLANK_AUDIO]", "Thank you.", etc.).
 */

export interface WakeWordParseResult {
  matched: boolean;
  kind: "ignored" | "wake_only" | "command";
  command: string;
  raw: string;
}

const PHONETIC_ALIASES: Record<string, string[]> = {
  aether: ["aether", "ether", "either", "ather", "eather", "ayther", "aither"],
  jarvis: ["jarvis", "jarvus", "jarves", "jarvish"],
  cortana: ["cortana", "kortana", "cortanna"],
};

const WHISPER_NOISE_PHRASES = new Set([
  "thank you",
  "thanks for watching",
  "thank you for watching",
  "you",
  "bye",
  "mbc",
  "subtitles by",
]);

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

function tokenMatchesAiName(token: string, aiName: string): boolean {
  const tok = token.toLowerCase().replace(/[^a-z0-9]/g, "");
  const target = aiName.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!tok || !target) return false;
  if (tok === target) return true;

  const aliases = PHONETIC_ALIASES[target];
  if (aliases && aliases.includes(tok)) return true;

  // Allow edit-distance <= 1 for names of length >= 5 (prevents short false positives like "john")
  if (target.length >= 5 && Math.abs(tok.length - target.length) <= 1) {
    return levenshtein(tok, target) <= 1;
  }
  return false;
}

export function isWhisperSilenceNoise(transcript: string): boolean {
  const t = transcript.trim().toLowerCase().replace(/[.!?,]/g, "").trim();
  if (!t || t.length < 2) return true;
  if (t.startsWith("[") && t.endsWith("]")) return true;
  if (t.startsWith("(") && t.endsWith(")")) return true;
  return WHISPER_NOISE_PHRASES.has(t);
}

export function parseWakeWord(
  transcript: string,
  aiName: string,
  wakeWordEnabled: boolean,
  inActiveWindow: boolean
): WakeWordParseResult {
  const raw = transcript.trim();
  if (!raw || isWhisperSilenceNoise(raw)) {
    return { matched: false, kind: "ignored", command: "", raw };
  }

  if (!wakeWordEnabled || inActiveWindow) {
    return { matched: true, kind: "command", command: raw, raw };
  }

  const cleanName = (aiName || "Aether").trim();
  const words = raw.split(/\s+/);
  const greetings = new Set(["hey", "hi", "hello", "yo", "ok", "okay"]);

  let matchEndIdx = -1;

  // Case 1: "<AiName> ..."
  if (words.length >= 1 && tokenMatchesAiName(words[0], cleanName)) {
    matchEndIdx = 1;
  }
  // Case 2: "Hey <AiName> ..."
  else if (
    words.length >= 2 &&
    greetings.has(words[0].toLowerCase().replace(/[^a-z]/g, "")) &&
    tokenMatchesAiName(words[1], cleanName)
  ) {
    matchEndIdx = 2;
  }
  // Case 3: Mid-sentence "hey <AiName> ..."
  else {
    for (let i = 0; i < words.length - 1; i++) {
      if (
        greetings.has(words[i].toLowerCase().replace(/[^a-z]/g, "")) &&
        tokenMatchesAiName(words[i + 1], cleanName)
      ) {
        matchEndIdx = i + 2;
        break;
      }
    }
  }

  if (matchEndIdx === -1) {
    return { matched: false, kind: "ignored", command: "", raw };
  }

  const remainder = words
    .slice(matchEndIdx)
    .join(" ")
    .replace(/^[,.:!?\s]+/, "")
    .trim();

  if (!remainder) {
    return { matched: true, kind: "wake_only", command: "", raw };
  }
  return { matched: true, kind: "command", command: remainder, raw };
}
