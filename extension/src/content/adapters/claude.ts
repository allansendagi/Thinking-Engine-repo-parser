import type { SiteAdapter, RawMessage } from "../common/siteAdapter";
import { cleanText, matchFirst } from "../common/domUtils";

/**
 * UNVERIFIED against the live site -- Claude's DOM is less publicly documented than ChatGPT's, so
 * this is a best-effort guess, more likely than the other two adapters to need real adjustment.
 * Tries several candidate selectors in order rather than committing to one, and logs loudly if
 * none of them find anything, so a stale selector fails visibly (in devtools) instead of silently
 * capturing nothing forever. See extension/README.md.
 */

const USER_SELECTORS = ['[data-testid="user-message"]', '[data-testid="human-turn"]'];
const ASSISTANT_SELECTORS = ['[data-testid="assistant-message"]', '[data-testid="ai-turn"]'];

function collect(root: ParentNode, selectors: string[]): HTMLElement[] {
  for (const selector of selectors) {
    const found = Array.from(root.querySelectorAll<HTMLElement>(selector));
    if (found.length > 0) return found;
  }
  return [];
}

export const claudeAdapter: SiteAdapter = {
  source: "claude",

  getConversationId(): string | null {
    return matchFirst(location.pathname, [/\/chat\/([a-zA-Z0-9-]+)/]);
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
      .map(({ el, role }) => ({ role, text: cleanText(el.textContent) }))
      .filter((m) => m.text.length > 0);
  },
};
