import type { SiteAdapter, RawMessage } from "../common/siteAdapter";
import { cleanText, fillComposer, firstMatch, matchFirst } from "../common/domUtils";

/**
 * Grok (grok.com). Selectors read from the live page on 27 Oct 2026, a signed-in conversation:
 * every turn is a `[data-testid="user-message"]` or `[data-testid="assistant-message"]`, and the
 * text itself is in `.response-content-markdown` inside it -- the bubble around it also carries
 * the "You" / "Grok" label and "Worked for 20s", which must not be captured. Conversations live
 * at /c/<uuid>. The composer is a ProseMirror editor inside `[data-testid="chat-input"]` on a
 * conversation and a textarea on the start page.
 */

const TURN = '[data-testid="user-message"], [data-testid="assistant-message"]';
const TEXT = ".response-content-markdown";
const COMPOSER_SELECTORS = [
  '[data-testid="chat-input"] [contenteditable="true"]',
  'textarea[aria-label*="Grok" i]',
  'textarea[placeholder*="Grok" i]',
];

export const grokAdapter: SiteAdapter = {
  source: "grok",

  getConversationId(): string | null {
    return matchFirst(location.pathname, [/^\/c\/([0-9a-f-]{8,})/i]);
  },

  getConversationUrl(): string | null {
    const id = this.getConversationId();
    return id ? `${location.origin}/c/${id}` : null;
  },

  extractMessages(root: ParentNode): RawMessage[] {
    const turns = Array.from(root.querySelectorAll<HTMLElement>(TURN));
    if (turns.length === 0) {
      if (this.conversationContainerPresent?.(root)) {
        console.warn("[Thread] grok adapter found a conversation page but zero messages -- selectors need updating against the live DOM");
      }
      return [];
    }
    return turns
      .map((el) => ({
        role: el.getAttribute("data-testid") === "user-message" ? ("user" as const) : ("assistant" as const),
        // The text only: without its markdown body the turn isn't rendered yet, so skip it.
        text: cleanText(el.querySelector(TEXT)?.textContent ?? ""),
      }))
      .filter((m) => m.text.length > 0);
  },

  conversationContainerPresent(root: ParentNode): boolean {
    return !!root.querySelector('[data-testid="chat-transcript-scroller"]') || !!firstMatch(root, COMPOSER_SELECTORS);
  },

  insertIntoComposer(text: string, root: ParentNode = document): boolean {
    const el = firstMatch(root, COMPOSER_SELECTORS);
    return el ? fillComposer(el, text) : false;
  },
};
