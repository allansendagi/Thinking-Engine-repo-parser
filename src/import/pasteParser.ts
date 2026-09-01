import type { Role } from "../types";

export interface PastedMessage {
  role: Role;
  text: string;
}

const USER_MARKERS = ["user", "you", "human", "me"];
const ASSISTANT_MARKERS = ["assistant", "ai", "chatgpt", "claude", "gemini", "bot", "model"];

function matchMarker(line: string): Role | null {
  const trimmed = line.trim();
  const colonIndex = trimmed.indexOf(":");
  if (colonIndex === -1 || colonIndex > 20) return null; // "Label:" only, not a sentence with a colon in it

  const label = trimmed.slice(0, colonIndex).trim().toLowerCase();
  if (USER_MARKERS.includes(label)) return "user";
  if (ASSISTANT_MARKERS.includes(label)) return "assistant";
  return null;
}

/**
 * Turns raw pasted text into speaker-attributed turns. Recognizes a small set of common
 * "Label:" prefixes (User/You/Human/Me, Assistant/AI/ChatGPT/Claude/Gemini/Bot/Model) at the
 * start of a line -- deliberately conservative: a label only counts if it's a short line-initial
 * token before a colon, not any colon anywhere in the text, to avoid misfiring on something like
 * "Note: this matters".
 *
 * If no markers are found at all, the whole paste becomes a single user message. That's a
 * deliberate, safe default -- attributing unlabeled text to "user" can be manually corrected
 * later (see db/mutations.ts), while guessing wrong and inventing structure that isn't there
 * cannot be un-guessed as cleanly.
 */
export function parsePastedConversation(raw: string): PastedMessage[] {
  const lines = raw.split("\n");
  const messages: PastedMessage[] = [];
  let currentRole: Role | null = null;
  let buffer: string[] = [];

  function flush(): void {
    const text = buffer.join("\n").trim();
    if (currentRole && text.length > 0) messages.push({ role: currentRole, text });
    buffer = [];
  }

  for (const line of lines) {
    const marker = matchMarker(line);
    if (marker) {
      flush();
      currentRole = marker;
      const afterColon = line.slice(line.indexOf(":") + 1);
      if (afterColon.trim().length > 0) buffer.push(afterColon);
    } else {
      buffer.push(line);
    }
  }
  flush();

  if (messages.length === 0) {
    const text = raw.trim();
    if (text.length > 0) return [{ role: "user", text }];
    return [];
  }

  return messages;
}
