/**
 * Natural Wake-Word Gate for AETHER with Whisper phonetic resilience.
 *
 * - Rejects non-addressed chatter ("Hey John, pass the salt") locally with zero LLM/TTS calls.
 * - Accepts natural conversational lead-ins ("No, Ether. ...", "Wait, Aether, ...", "Remember this, Aether!")
 *   while preserving leading intent words ("No", "Wait", "Actually") so AETHER understands context.
 * - Handles common Whisper phonetic spellings ("Aether" -> "ether", "ather", "eather", "ayther", "aither";
 *   plus vocative "either" when paired with greeting or punctuation).
 * - Filters out common Whisper silence artifacts ("[BLANK_AUDIO]", "Thank you.", etc.).
 */

export interface WakeWordParseResult {
  matched: boolean;
  kind: "ignored" | "wake_only" | "command";
  command: string;
  raw: string;
}

const PHONETIC_ALIASES: Record<string, string[]> = {
  aether: ["aether", "ether", "ather", "eather", "ayther", "aither", "heather"],
  jarvis: ["jarvis", "jarvus", "jarves", "jarvish"],
  cortana: ["cortana", "kortana", "cortanna"],
};

// Ambiguous English words that Whisper occasionally outputs for "Aether" — only match in vocative positions
const VOCATIVE_ONLY_ALIASES: Record<string, string[]> = {
  aether: ["either", "eater"],
};

const LEAD_IN_WORDS = new Set([
  "hey",
  "hi",
  "hello",
  "yo",
  "ok",
  "okay",
  "no",
  "yes",
  "yeah",
  "yep",
  "nah",
  "wait",
  "hold",
  "on",
  "listen",
  "look",
  "actually",
  "well",
  "so",
  "please",
  "thanks",
  "thank",
  "sorry",
  "alright",
  "right",
  "come",
  "uh",
  "um",
  "oh",
]);

const GREETING_ONLY_WORDS = new Set(["hey", "hi", "hello", "yo", "ok", "okay", "uh", "um", "oh"]);

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

function tokenMatchesAiName(token: string, aiName: string, isVocativeContext: boolean): boolean {
  const tok = token.toLowerCase().replace(/[^a-z0-9]/g, "");
  const target = aiName.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!tok || !target) return false;
  if (tok === target) return true;

  const aliases = PHONETIC_ALIASES[target];
  if (aliases && aliases.includes(tok)) return true;

  if (isVocativeContext) {
    const vocAliases = VOCATIVE_ONLY_ALIASES[target];
    if (vocAliases && vocAliases.includes(tok)) return true;
  }

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

  let nameIdx = -1;
  for (let i = 0; i < words.length; i++) {
    const prevClean = i > 0 ? words[i - 1].toLowerCase().replace(/[^a-z]/g, "") : "";
    const hasTrailingPunct = /[,.:!?]$/.test(words[i]);
    const prevHasComma = i > 0 && /[,.:!?]$/.test(words[i - 1]);
    const isVocativeContext =
      i === 0 ||
      LEAD_IN_WORDS.has(prevClean) ||
      prevHasComma ||
      (hasTrailingPunct && i === words.length - 1);

    if (tokenMatchesAiName(words[i], cleanName, isVocativeContext)) {
      nameIdx = i;
      break;
    }
  }

  if (nameIdx === -1) {
    return { matched: false, kind: "ignored", command: "", raw };
  }

  // Separate words before and after the AI's name
  const beforeWords = words.slice(0, nameIdx);
  const afterWords = words.slice(nameIdx + 1);

  // Drop pure greetings ("Hey", "Okay") before the name, but KEEP meaningful lead-ins ("No", "Wait", "Actually")!
  const meaningfulBefore = beforeWords.filter(
    (w) => !GREETING_ONLY_WORDS.has(w.toLowerCase().replace(/[^a-z]/g, ""))
  );

  const combined = [...meaningfulBefore, ...afterWords]
    .join(" ")
    .replace(/^[,.:!?\s]+/, "")
    .trim();

  if (!combined) {
    return { matched: true, kind: "wake_only", command: "", raw };
  }
  return { matched: true, kind: "command", command: combined, raw };
}
