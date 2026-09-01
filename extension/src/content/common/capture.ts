import { addSentIds, getSentIds } from "../../lib/storage";
import type { CaptureMessage, CapturedMessage } from "../../lib/types";
import type { SiteAdapter } from "./siteAdapter";

/**
 * Turns a SiteAdapter's raw DOM extraction into a debounced, deduplicated capture loop. This is
 * the part that's fully verifiable without a live browser (see capture.test.ts, run against
 * happy-dom fixtures) -- the site-specific selectors in each adapter are NOT, and are the part
 * most likely to need adjustment against the real, current DOM. See extension/README.md.
 *
 * Message ids are position-based (`${conversationId}::${index}`), not derived from message text.
 * That's deliberate: an assistant reply's text grows token-by-token while streaming, and hashing
 * text into the id would make the id change on every partial render, defeating deduplication
 * entirely. A stable position-based id means a still-streaming message may occasionally be
 * captured with truncated text if the debounce window closes mid-stream -- a real, accepted
 * limitation, not silently ignored: it only affects context completeness for future extraction
 * calls, not correctness, because only user turns are ever extracted from (see the backend's
 * extraction prompt) and a truncated assistant reply can't produce a fabricated user statement.
 */
export interface CaptureOptions {
  debounceMs?: number;
  /**
   * Backstop re-check interval, independent of MutationObserver callbacks. A page's first render
   * after a hard reload (fetch conversation -> render -> possibly re-render on hydration) can
   * settle in ways that leave the very first debounced flush racing an incomplete DOM -- this
   * catches that case within one interval instead of depending on a mutation firing again later.
   * Set to 0/undefined-safe: pass 0 to disable (used by tests, which run far faster than any
   * real interval and don't want an extra timer alive after the test ends).
   */
  backstopMs?: number;
  /** Injectable for tests -- defaults to the real chrome.runtime.sendMessage. */
  sendMessage?: (message: CaptureMessage) => Promise<unknown>;
  now?: () => string;
}

export function startCapture(adapter: SiteAdapter, doc: ParentNode, options: CaptureOptions = {}): () => void {
  const debounceMs = options.debounceMs ?? 2000;
  const backstopMs = options.backstopMs ?? 4000;
  const sendMessage = options.sendMessage ?? ((m: CaptureMessage) => chrome.runtime.sendMessage(m));
  const now = options.now ?? (() => new Date().toISOString());

  let timer: ReturnType<typeof setTimeout> | null = null;

  async function flush(): Promise<void> {
    const conversationId = adapter.getConversationId();
    if (!conversationId) return;

    const raw = adapter.extractMessages(doc);
    if (raw.length === 0) return;

    const capturedAt = now();
    const messages: CapturedMessage[] = raw.map((m, i) => ({
      id: `${conversationId}::${i}`,
      role: m.role,
      text: m.text,
      createdAt: capturedAt,
    }));

    const sentIds = await getSentIds(conversationId);
    const hasNew = messages.some((m) => !sentIds.has(m.id));
    if (!hasNew) return;

    try {
      await sendMessage({ type: "thread:capture", source: adapter.source, conversationId, messages });
      await addSentIds(
        conversationId,
        messages.map((m) => m.id),
      );
    } catch (err) {
      console.warn("[Thread] capture send failed, will retry on next change", err);
    }
  }

  function scheduleFlush(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void flush(), debounceMs);
  }

  const target = "body" in doc ? (doc as Document).body : (doc as Element);
  const observer = new MutationObserver(() => scheduleFlush());
  observer.observe(target, { childList: true, subtree: true, characterData: true });

  scheduleFlush(); // capture whatever's already on the page when we attach

  const backstop = backstopMs > 0 ? setInterval(() => void flush(), backstopMs) : null;

  return () => {
    observer.disconnect();
    if (timer) clearTimeout(timer);
    if (backstop) clearInterval(backstop);
  };
}
