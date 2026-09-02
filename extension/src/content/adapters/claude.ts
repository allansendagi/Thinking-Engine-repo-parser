import type { SiteAdapter, RawMessage } from "../common/siteAdapter";
import { cleanText, matchFirst } from "../common/domUtils";

/**
 * Verified against live claude.ai (2026-09-01): user turns carry `data-testid="user-message"`;
 * an assistant turn's actual prose is `.standard-markdown` inside `.font-claude-response` --
 * `.font-claude-response` alone also swallows status chips ("Thought for 3s", "Read and edited
 * memory") rendered before the text. Every list keeps older guesses as ordered fallbacks so a
 * single rename degrades instead of breaking capture; `stripChrome` is a second line of defence
 * for the fallback path. Logs loudly (devtools) on a conversation page with zero messages.
 */

const USER_SELECTORS = ['[data-testid="user-message"]', '[data-testid="human-turn"]'];
const ASSISTANT_SELECTORS = [
  ".font-claude-response .standard-markdown",
  ".standard-markdown",
  ".font-claude-response",
  "[data-is-streaming]",
  '[data-testid="assistant-message"]',
  '[data-testid="ai-turn"]',
];

function collect(root: ParentNode, selectors: string[]): HTMLElement[] {
  for (const selector of selectors) {
    const found = Array.from(root.querySelectorAll<HTMLElement>(selector));
    if (found.length > 0) return found;
  }
  return [];
}

/**
 * Fallback cleanup for when only `.font-claude-response` matched (no `.standard-markdown`):
 * strip the leading status chips Claude renders before the prose, and any a11y label prefix.
 * Each chip's text tends to render twice, hence the `+`.
 */
function stripChrome(raw: string): string {
  return cleanText(raw)
    .replace(/^(?:You said:|Claude responded:)\s*/i, "")
    .replace(/^(?:(?:Thought for \d+m?\s?\d*s|Read and edited memory|Searched (?:the web|for [^.]+?))\s*)+/i, "")
    .trim();
}

export const claudeAdapter: SiteAdapter = {
  source: "claude",

  getConversationId(): string | null {
    return matchFirst(location.pathname, [/\/chat\/([a-zA-Z0-9-]+)/]);
  },

  getConversationUrl(): string | null {
    return this.getConversationId() ? location.origin + location.pathname : null;
  },

  extractMessages(root: ParentNode): RawMessage[] {
    const userNodes = collect(root, USER_SELECTORS).map((el) => ({ el, role: "user" as const }));
    const assistantNodes = collect(root, ASSISTANT_SELECTORS).map((el) => ({ el, role: "assistant" as const }));

    const all = [...userNodes, ...assistantNodes];

    if (all.length === 0) {
      if (document.querySelector("main")) {
        console.warn(
          "[Thread] claude adapter found a conversation page but zero messages -- selectors need updating against the live DOM",
        );
      }
      return [];
    }

    // DOM order, not selector-group order -- compareDocumentPosition sorts by actual page position.
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
