import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CapturedConversation, SourceAdapter } from "./sourceAdapter";

/**
 * UNVERIFIED against a real Cursor install -- this is the single most speculative piece of the
 * entire build, more so than the browser extension's DOM adapters, which at least target a
 * documented consumer web UI. This targets Cursor's *internal, undocumented* local storage.
 *
 * What's reasonably solid: Cursor is a VS Code fork, and VS Code's storage service has used a
 * `state.vscdb` SQLite file with a single `ItemTable (key TEXT, value BLOB)` key-value table for
 * global/workspace state for years -- that mechanism is core, stable VS Code behavior, not
 * something specific to any one extension or fork.
 *
 * What's NOT solid: which exact keys Cursor stores chat/composer history under, and what shape
 * the JSON in those values takes. Rather than hardcode a guessed key name (which would silently
 * find nothing the moment it's wrong), this scans every value whose key plausibly relates to
 * chat/composer, parses it as JSON, and recursively searches for arrays that structurally look
 * like message lists (objects with a role-like field taking a recognizable value, and a
 * text-like field). That's a deliberate hedge against not knowing the exact schema: it degrades
 * to "found nothing" rather than "crashed" or "silently wrong" if the real shape differs, and it
 * has a real chance of working even if the exact key names have changed across versions.
 *
 * Verify before trusting: run this against a real Cursor install with real chat history and
 * check whether `extract()` returns anything, and whether what it returns actually looks like
 * real conversation content.
 */

function stateDbPath(): string {
  return (
    process.env.THREAD_CURSOR_STATE_DB_PATH ??
    join(homedir(), "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb")
  );
}

const USER_ROLE_VALUES = new Set(["user", "human"]);
const ASSISTANT_ROLE_VALUES = new Set(["assistant", "ai", "model", "bot"]);

interface ScannedMessage {
  role: "user" | "assistant";
  text: string;
}

function tryAsMessage(item: unknown): ScannedMessage | null {
  if (item === null || typeof item !== "object") return null;
  const obj = item as Record<string, unknown>;

  const roleRaw = obj.role ?? obj.type ?? obj.author ?? obj.sender;
  if (typeof roleRaw !== "string") return null;
  const roleLower = roleRaw.toLowerCase();

  let role: "user" | "assistant" | null = null;
  if (USER_ROLE_VALUES.has(roleLower)) role = "user";
  else if (ASSISTANT_ROLE_VALUES.has(roleLower)) role = "assistant";
  if (!role) return null;

  const textRaw = obj.text ?? obj.content ?? obj.message;
  if (typeof textRaw !== "string" || textRaw.trim().length === 0) return null;

  return { role, text: textRaw.trim() };
}

/** Recursively searches an arbitrary JSON value for arrays that structurally look like message lists. */
export function scanForMessages(value: unknown, depth = 0): ScannedMessage[] {
  if (depth > 6 || value === null || typeof value !== "object") return [];

  if (Array.isArray(value)) {
    const asMessages = value.map(tryAsMessage).filter((m): m is ScannedMessage => m !== null);
    // Require most entries to look like messages -- an incidental array (e.g. a list of file
    // paths that happens to contain one dict with a "type" field) shouldn't be mistaken for a
    // conversation just because one element parsed.
    if (value.length > 0 && asMessages.length >= value.length * 0.6) {
      return asMessages;
    }
    return value.flatMap((v) => scanForMessages(v, depth + 1));
  }

  return Object.values(value as Record<string, unknown>).flatMap((v) => scanForMessages(v, depth + 1));
}

export function extractFromStateDb(dbPath: string): CapturedConversation[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .query("SELECT key, value FROM ItemTable WHERE key LIKE '%chat%' OR key LIKE '%composer%' OR key LIKE '%aichat%'")
      .all() as { key: string; value: string | Uint8Array }[];

    const conversations: CapturedConversation[] = [];

    for (const row of rows) {
      const raw = typeof row.value === "string" ? row.value : Buffer.from(row.value).toString("utf-8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }

      const messages = scanForMessages(parsed);
      if (messages.length === 0) continue;

      conversations.push({
        conversationId: `cursor::${row.key}`,
        messages: messages.map((m, i) => ({
          id: `cursor::${row.key}::${i}`,
          role: m.role,
          text: m.text,
          // No reliable per-message timestamp is available from this heuristic scan -- sequential
          // placeholders preserve order, which is what identity resolution's temporal signal
          // actually needs, without claiming a real time that isn't known.
          createdAt: new Date(Date.now() + i * 1000).toISOString(),
        })),
      });
    }

    return conversations;
  } finally {
    db.close();
  }
}

export const cursorAdapter: SourceAdapter = {
  name: "cursor",
  source: "cursor",

  locateWatchTargets(): string[] {
    const path = stateDbPath();
    return existsSync(path) ? [path] : [];
  },

  extract: extractFromStateDb,
};
