import { addSentIds, getSentIds } from "../../lib/storage";
import { textHash } from "./domUtils";
import type { CaptureMessage, CaptureReport, CapturedMessage, HealthMessage } from "../../lib/types";
import type { SiteAdapter } from "./siteAdapter";

/**
 * Turns a SiteAdapter's raw DOM extraction into a debounced, deduplicated capture loop. This is
 * the part that's fully verifiable without a live browser (see capture.test.ts, run against
 * happy-dom fixtures) -- the site-specific selectors in each adapter are NOT, and are the part
 * most likely to need adjustment against the real, current DOM. See extension/README.md.
 *
 * Message ids are content-derived: `${conversationId}::${role[0]}${textHash(text)}`. So a turn
 * that shifts position -- an upstream edit, a branch switch, virtualized scrollback re-rendering
 * an older turn -- keeps its id, and a regenerated answer (new words, same slot) gets a new id
 * and is captured instead of silently dropped by a stale positional id. The backend matches an
 * incoming message to the canonical event that already carries its `(role, text)` regardless of
 * id (api/ingest.ts `remapToExistingIds`), so this scheme -- and any later change to it -- costs
 * no re-extraction of turns it has already seen.
 *
 * Streaming: the last turn, when it's an assistant reply, may still be growing token-by-token.
 * It's HELD OUT of the payload until its text is byte-stable for `assistantStableMs` OR a newer
 * turn appears after it -- so what's captured is the finished reply, not a mid-stream fragment.
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
  sendMessage?: (message: CaptureMessage | HealthMessage) => Promise<unknown>;
  now?: () => string;
  /** How long a trailing assistant turn's text must stay byte-identical before it's considered
   *  finished and allowed into the payload. Default 2500ms (> a debounce window). */
  assistantStableMs?: number;
}

export function startCapture(adapter: SiteAdapter, doc: ParentNode, options: CaptureOptions = {}): () => void {
  const debounceMs = options.debounceMs ?? 2000;
  const backstopMs = options.backstopMs ?? 4000;
  const assistantStableMs = options.assistantStableMs ?? 2500;
  const sendMessage =
    options.sendMessage ?? ((m: CaptureMessage | HealthMessage) => chrome.runtime.sendMessage(m));
  const now = options.now ?? (() => new Date().toISOString());
  const clock = () => Date.now();

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  /** The trailing assistant turn's text and when it last changed -- the streaming-tail guard. */
  let tailText = "";
  let tailChangedAt = 0;
  /** Last health report sent -- so an unchanged situation (idle, or steadily-broken) reports once,
   *  not on every mutation/backstop tick. */
  let lastHealthKey = "";

  function containerPresent(): boolean {
    if (adapter.conversationContainerPresent) return adapter.conversationContainerPresent(doc);
    const q = (doc as Document).querySelector?.bind(doc) ?? (doc as Element).querySelector?.bind(doc);
    return !!q?.("main");
  }

  async function reportHealth(report: CaptureReport): Promise<void> {
    const key = `${report.onConversation}|${report.containerPresent}|${report.extracted > 0}|${report.sent > 0}|${report.error ?? ""}`;
    if (key === lastHealthKey && report.sent === 0) return; // nothing changed -- don't spam
    lastHealthKey = key;
    try {
      await sendMessage({ type: "thread:health", report });
    } catch {
      /* health is best-effort; a failed report never affects capture */
    }
  }

  /**
   * After the extension is reloaded/updated, the content script already injected into an open
   * tab keeps running but every `chrome.*` handle in it is dead -- calls throw "Extension context
   * invalidated". The MutationObserver and the backstop interval would then re-throw that on a
   * loop forever, filling the page console. Detect it once and tear ourselves down instead.
   */
  function isContextInvalidated(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Extension context invalidated") || msg.includes("context invalidated")) return true;
    // A live content script always has chrome.runtime.id; its disappearance means the context died.
    return typeof chrome !== "undefined" && "runtime" in chrome && !chrome.runtime?.id;
  }

  async function flush(): Promise<void> {
    if (stopped) return;
    const at = now();
    try {
      const conversationId = adapter.getConversationId();
      if (!conversationId) {
        await reportHealth({
          source: adapter.source,
          onConversation: false,
          containerPresent: containerPresent(),
          extracted: 0,
          sent: 0,
          at,
        });
        return;
      }

      const raw = adapter.extractMessages(doc);
      const capturedAt = at;
      const messages: CapturedMessage[] = raw.map((m) => ({
        id: `${conversationId}::${m.role[0]}${textHash(m.text)}`,
        role: m.role,
        text: m.text,
        createdAt: capturedAt,
      }));

      // Streaming-tail guard: if the last turn is an assistant reply that's still changing, hold
      // it back until it's been byte-stable for `assistantStableMs`. A newer turn after it (last
      // turn is a user message, or an assistant turn that isn't last) proves it's finished.
      const tail = raw[raw.length - 1];
      let holdTail = false;
      if (tail && tail.role === "assistant") {
        if (tail.text !== tailText) {
          tailText = tail.text;
          tailChangedAt = clock();
        }
        holdTail = clock() - tailChangedAt < assistantStableMs;
      }
      const toSend = holdTail ? messages.slice(0, -1) : messages;

      const sentIds = toSend.length > 0 ? await getSentIds(conversationId) : new Set<string>();
      const fresh = toSend.filter((m) => !sentIds.has(m.id));

      if (fresh.length > 0) {
        const sourceUrl = adapter.getConversationUrl?.() ?? null;
        const res = (await sendMessage({
          type: "thread:capture",
          source: adapter.source,
          conversationId,
          sourceUrl,
          messages: toSend,
        })) as { ok?: boolean; queued?: boolean; retry?: boolean } | undefined;
        // Mark sent UNLESS the worker explicitly said to retry from here (not paired, or 401
        // before a re-pair landed). A transient backend failure comes back `queued: true` -- the
        // worker owns retrying it from durable storage, so this tab must not also re-send.
        if (res?.retry !== true) {
          await addSentIds(
            conversationId,
            toSend.map((m) => m.id),
          );
        }
      }

      // A held tail must keep the loop alive so it gets sent once it settles -- MutationObserver
      // may not fire again if the stream has stopped painting.
      if (holdTail) scheduleFlush();

      await reportHealth({
        source: adapter.source,
        onConversation: true,
        containerPresent: containerPresent(),
        extracted: raw.length,
        sent: fresh.length,
        at,
      });
    } catch (err) {
      if (isContextInvalidated(err)) {
        console.info("[Thread] extension was reloaded -- detaching capture from this tab. Reload the tab to resume.");
        teardown();
        return;
      }
      console.warn("[Thread] capture flush failed, will retry on next change", err);
      await reportHealth({
        source: adapter.source,
        onConversation: adapter.getConversationId() != null,
        containerPresent: containerPresent(),
        extracted: 0,
        sent: 0,
        at,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function scheduleFlush(): void {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void flush(), debounceMs);
  }

  const target = "body" in doc ? (doc as Document).body : (doc as Element);
  const observer = new MutationObserver(() => scheduleFlush());
  observer.observe(target, { childList: true, subtree: true, characterData: true });

  scheduleFlush(); // capture whatever's already on the page when we attach

  const backstop = backstopMs > 0 ? setInterval(() => void flush(), backstopMs) : null;

  function teardown(): void {
    stopped = true;
    observer.disconnect();
    if (timer) clearTimeout(timer);
    if (backstop) clearInterval(backstop);
  }

  return teardown;
}
