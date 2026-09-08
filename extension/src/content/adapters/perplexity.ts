import type { SiteAdapter, RawMessage } from "../common/siteAdapter";
import { cleanText, fillComposer, firstMatch, matchFirst } from "../common/domUtils";

/**
 * Perplexity (perplexity.ai). UNVERIFIED against the live DOM -- selectors are best-effort with
 * ordered fallbacks, the same shape the ChatGPT/Claude/Gemini adapters shipped as before they
 * were checked. Capture health (`conversationContainerPresent` + the background's degraded
 * verdict) surfaces it as broken rather than failing silent, so tuning is a selector change here,
 * not a redesign.
 *
 * A Perplexity thread is a stack of blocks, each a question followed by its answer. We collect
 * the query and answer nodes separately and order them by DOM position (same as the Claude /
 * Gemini adapters).
 */

const USER_SELECTORS = [
  '[data-testid="query-text"]',
  '[class*="group/query"] [dir="auto"]',
  'div[class*="query"] .whitespace-pre-line',
];
const ASSISTANT_SELECTORS = [
  '[data-testid="answer-text"]',
  '[id^="markdown-content"]',
  ".prose",
];
const COMPOSER_SELECTORS = [
  'textarea[placeholder*="follow" i]',
  'textarea[placeholder*="Ask" i]',
  'main textarea',
  'div[contenteditable="true"]',
];

function collect(root: ParentNode, selectors: string[]): HTMLElement[] {
  for (const selector of selectors) {
    const found = Array.from(root.querySelectorAll<HTMLElement>(selector));
    if (found.length > 0) return found;
  }
  return [];
}

function strip(raw: string): string {
  return cleanText(raw).replace(/^(?:You asked:|Answer:)\s*/i, "").trim();
}

export const perplexityAdapter: SiteAdapter = {
  source: "perplexity",

  getConversationId(): string | null {
    // /search/<slug-with-trailing-uuid>  (also /page/<slug> for saved pages)
    return matchFirst(location.pathname, [/\/(?:search|page)\/([^/?#]+)/]);
  },

  getConversationUrl(): string | null {
    return this.getConversationId() ? location.origin + location.pathname : null;
  },

  extractMessages(root: ParentNode): RawMessage[] {
    const userNodes = collect(root, USER_SELECTORS).map((el) => ({ el, role: "user" as const }));
    const assistantNodes = collect(root, ASSISTANT_SELECTORS).map((el) => ({ el, role: "assistant" as const }));
    const all = [...userNodes, ...assistantNodes];

    if (all.length === 0) {
      if (this.conversationContainerPresent?.(root)) {
        console.warn(
          "[Thread] perplexity adapter found a conversation page but zero messages -- selectors need updating against the live DOM",
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
      .map(({ el, role }) => ({ role, text: strip(el.textContent ?? "") }))
      .filter((m) => m.text.length > 0);
  },

  conversationContainerPresent(root: ParentNode): boolean {
    return !!root.querySelector("main") && !!firstMatch(root, COMPOSER_SELECTORS);
  },

  insertIntoComposer(text: string, root: ParentNode = document): boolean {
    const el = firstMatch(root, COMPOSER_SELECTORS);
    return el ? fillComposer(el, text) : false;
  },
};
