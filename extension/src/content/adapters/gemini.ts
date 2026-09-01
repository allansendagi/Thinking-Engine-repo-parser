import type { SiteAdapter, RawMessage } from "../common/siteAdapter";
import { cleanText, matchFirst } from "../common/domUtils";

/**
 * Verified against live gemini.google.com (2026-09-01). Gemini's Angular app uses stable custom
 * element tags for conversation structure: `user-query` / `user-query-content` for prompts,
 * `model-response` / `message-content` for replies. We prefer the inner `*-content` elements --
 * `model-response` also wraps disclaimers, sources and action buttons, and `user-query` renders
 * the prompt text twice (once visible, once for the edit field). Screen-reader label prefixes
 * ("You said", "Gemini said") and that duplicated prompt text are both stripped.
 */

const USER_SELECTORS = ["user-query-content", "user-query"];
const ASSISTANT_SELECTORS = ["message-content", "model-response"];

function collect(root: ParentNode, selectors: string[]): HTMLElement[] {
  for (const selector of selectors) {
    const found = Array.from(root.querySelectorAll<HTMLElement>(selector));
    if (found.length > 0) return found;
  }
  return [];
}

function stripChrome(raw: string): string {
  let text = cleanText(raw).replace(/^(?:You said|Gemini said)\s*/i, "");
  // Gemini renders the prompt text twice inside user-query: "<Q> <Q>". Collapse an exact repeat.
  if (text.length < 8000) {
    const repeat = text.match(/^(.+?)\s+\1$/);
    if (repeat) text = repeat[1]!;
  }
  return text.trim();
}

export const geminiAdapter: SiteAdapter = {
  source: "gemini",

  getConversationId(): string | null {
    return matchFirst(location.pathname, [/\/app\/([a-zA-Z0-9-]+)/]);
  },

  extractMessages(root: ParentNode): RawMessage[] {
    const userNodes = collect(root, USER_SELECTORS).map((el) => ({ el, role: "user" as const }));
    const assistantNodes = collect(root, ASSISTANT_SELECTORS).map((el) => ({ el, role: "assistant" as const }));

    const all = [...userNodes, ...assistantNodes];
    if (all.length === 0) {
      if (document.querySelector("main")) {
        console.warn(
          "[Thread] gemini adapter found a conversation page but zero messages -- selectors need updating against the live DOM",
        );
      }
      return [];
    }

    all.sort((a, b) => {
      const position = a.el.compareDocumentPosition(b.el);
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });

    return all
      .map(({ el, role }) => ({ role, text: stripChrome(el.textContent ?? "") }))
      .filter((m) => m.text.length > 0);
  },
};
