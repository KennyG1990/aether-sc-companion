/**
 * Strict Wake-Word Gate for AETHER.
 *
 * Ensures background chatter or addressing someone else (e.g. "Hey John") is ignored locally,
 * while addressing the AI by name ("Hey Jarvis", "Jarvis", "Hey Aether, drop gear") wakes it up
 * or dispatches the command cleanly.
 */

export interface WakeWordParseResult {
  matched: boolean;
  kind: "ignored" | "wake_only" | "command";
  command: string;
  raw: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseWakeWord(
  transcript: string,
  aiName: string,
  wakeWordEnabled: boolean,
  inActiveWindow: boolean
): WakeWordParseResult {
  const raw = transcript.trim();
  if (!raw) return { matched: false, kind: "ignored", command: "", raw };

  // If wake-word gate is disabled OR the pilot already woke the AI within the active follow-up window
  if (!wakeWordEnabled || inActiveWindow) {
    return { matched: true, kind: "command", command: raw, raw };
  }

  const cleanName = (aiName || "Aether").trim();
  const escaped = escapeRegExp(cleanName);

  // Match optional greeting ("hey", "yo", "okay", "ok", "hi", "hello") + exact AI name word boundary
  const wakeRegex = new RegExp(
    `^(?:(?:hey|hi|hello|yo|ok|okay)\\s+)?${escaped}\\b[,.:!?\\s]*(.*)$`,
    "i"
  );
  const match = raw.match(wakeRegex);
  if (!match) {
    // Also allow mid-sentence direct address like "computer, hey jarvis drop gear"
    const midRegex = new RegExp(`(?:^|\\s)(?:hey|ok|okay)\\s+${escaped}\\b[,.:!?\\s]*(.*)$`, "i");
    const mid = raw.match(midRegex);
    if (!mid) {
      return { matched: false, kind: "ignored", command: "", raw };
    }
    const remainder = (mid[1] || "").trim();
    if (!remainder) {
      return { matched: true, kind: "wake_only", command: "", raw };
    }
    return { matched: true, kind: "command", command: remainder, raw };
  }

  const remainder = (match[1] || "").trim();
  if (!remainder) {
    return { matched: true, kind: "wake_only", command: "", raw };
  }
  return { matched: true, kind: "command", command: remainder, raw };
}
