/**
 * Who may send each kind of message to the background worker.
 *
 * Messages from the extension's own pages (popup, welcome) can do anything. Messages from a
 * content script (running inside a ChatGPT / Claude / Gemini / Perplexity tab) may only report
 * what was captured and ask for the resume suggestion: they can't read account status, force a
 * re-pairing or start a history import, so a page that somehow reached the worker can't either.
 */

const AI_ORIGINS = new Set([
  "https://chatgpt.com",
  "https://chat.openai.com",
  "https://claude.ai",
  "https://gemini.google.com",
  "https://www.perplexity.ai",
  "https://perplexity.ai",
]);

/** Messages only the extension's own pages send. */
const EXTENSION_PAGE_ONLY = new Set(["thread:pair-now", "thread:status", "thread:announce", "thread:history-start"]);

/** Messages a content script in an AI tab sends. */
const CONTENT_SCRIPT = new Set([
  "thread:capture",
  "thread:health",
  "thread:import-batch",
  "thread:history-progress",
  "thread:resume-check",
  "thread:resume-dismiss",
  "thread:continue-packet",
]);

interface SenderLike {
  id?: string;
  url?: string;
  tab?: unknown;
}

export function senderAllowed(type: unknown, sender: SenderLike, extensionId: string): boolean {
  if (typeof type !== "string" || sender.id !== extensionId || typeof sender.url !== "string") return false;
  const fromExtensionPage = sender.url.startsWith(`chrome-extension://${extensionId}/`);
  if (EXTENSION_PAGE_ONLY.has(type)) return fromExtensionPage;
  if (CONTENT_SCRIPT.has(type)) {
    if (fromExtensionPage) return true;
    if (!sender.tab) return false;
    try {
      return AI_ORIGINS.has(new URL(sender.url).origin);
    } catch {
      return false;
    }
  }
  return false; // unknown message types are not ours
}
