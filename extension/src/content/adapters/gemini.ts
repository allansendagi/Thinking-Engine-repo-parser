import type { SiteAdapter, RawMessage } from "../common/siteAdapter";
import { cleanText, matchFirst } from "../common/domUtils";

/**
 * UNVERIFIED against the live site -- Gemini's web app is Angular-based, which tends to produce
 * obfuscated CSS class names that change across deploys, so this leans on custom element tag
 * names (`user-query`, `model-response`), which are part of the component structure rather than
 * styling and tend to be more stable. Still unverified against the real, current page. Logs
 * loudly if it finds nothing so a stale selector is visible in devtools rather than silent.
 * See extension/README.md.
 */
export const geminiAdapter: SiteAdapter = {
  source: "gemini",

  getConversationId(): string | null {
    return matchFirst(location.pathname, [/\/app\/([a-zA-Z0-9-]+)/]);
  },

  extractMessages(root: ParentNode): RawMessage[] {
    const userNodes = Array.from(root.querySelectorAll<HTMLElement>("user-query")).map((el) => ({
      el,
      role: "user" as const,
    }));
    const assistantNodes = Array.from(root.querySelectorAll<HTMLElement>("model-response")).map((el) => ({
      el,
      role: "assistant" as const,
    }));

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
      .map(({ el, role }) => ({ role, text: cleanText(el.textContent) }))
      .filter((m) => m.text.length > 0);
  },
};
