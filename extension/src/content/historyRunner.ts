import { addHistorySynced, getHistoryComplete, getHistorySynced, setHistoryComplete } from "../lib/storage";
import type { HistorySyncStatus, ImportBatchMessage } from "../lib/types";
import { historyErrorText } from "../lib/historyText";
import { runHistorySync, type SyncProgress } from "./historySync";
import type { SiteAdapter } from "./common/siteAdapter";

/** The link that starts a sync on arrival -- what Thread for Mac's "Recover my thinking" opens. */
export const HISTORY_HASH = "#thread-import";
/** The same, bringing in the older conversations too -- the popup's "Bring in" on them. */
export const HISTORY_OLDER_HASH = "#thread-import-older";

const RUNNING_KEY = "__threadHistorySyncRunning";
const PILL_ID = "thread-history-pill";

/**
 * Hooks history sync into a page: start on `#thread-import` in the URL (then strip it, so a
 * reload doesn't restart), or on a `thread:history-run` message from the popup. One run per page.
 */
export function attachHistorySync(adapter: SiteAdapter, doc: Document = document): void {
  if (!adapter.history) return;
  const start = (includeOlder = false) => void runInPage(adapter, doc, includeOlder);

  if (location.hash === HISTORY_HASH || location.hash === HISTORY_OLDER_HASH) {
    const older = location.hash === HISTORY_OLDER_HASH;
    history.replaceState(null, "", location.pathname + location.search);
    start(older);
  }
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    const m = message as { type?: unknown; older?: unknown } | null;
    if (m?.type !== "thread:history-run") return false;
    start(m.older === true);
    sendResponse({ ok: true });
    return false;
  });
}

async function runInPage(adapter: SiteAdapter, doc: Document, includeOlder: boolean): Promise<void> {
  const w = window as unknown as Record<string, unknown>;
  if (w[RUNNING_KEY]) return;
  w[RUNNING_KEY] = true;
  const reader = adapter.history!();
  const source = adapter.source;
  const pill = showPill(doc);
  try {
    const before = await getHistoryComplete(source);
    const result = await runHistorySync({
      reader,
      previouslyComplete: before !== null,
      includeOlder,
      synced: await getHistorySynced(source),
      async sendBatch(conversations) {
        const msg: ImportBatchMessage = { type: "thread:import-batch", format: reader.format, conversations };
        const res = (await chrome.runtime.sendMessage(msg)) as
          | { ok: true; ideaCount?: number }
          | { ok: false; capped?: boolean; error?: string };
        if (res.ok) return { ideaCount: res.ideaCount };
        if (res.capped) return { capped: true };
        throw new Error(res.error ?? "Import failed");
      },
      markSynced: (entries) => addHistorySynced(source, entries),
      onProgress(p) {
        pill.update(p);
        const status: HistorySyncStatus = { ...p, updatedAt: new Date().toISOString() };
        void chrome.runtime.sendMessage({ type: "thread:history-progress", source, status }).catch(() => {});
      },
    });
    if (result.state === "done") {
      const total = Object.keys(await getHistorySynced(source)).length;
      // A "check for new" run only lists the newest pages, so it can't count what's older: keep
      // the earlier count. Bringing in the older ones leaves none.
      const older = includeOlder ? 0 : before !== null ? (before.older ?? 0) : result.older;
      await setHistoryComplete(source, { at: new Date().toISOString(), conversations: total, older });
    }
  } finally {
    w[RUNNING_KEY] = false;
  }
}

/** A small, quiet progress pill in the page corner -- the user sees it working, then it fades. */
function showPill(doc: Document): { update(p: SyncProgress): void } {
  doc.getElementById(PILL_ID)?.remove();
  const el = doc.createElement("div");
  el.id = PILL_ID;
  el.setAttribute("role", "status");
  el.style.cssText = [
    "position:fixed", "right:16px", "bottom:16px", "z-index:2147483647",
    "padding:10px 14px", "border-radius:12px", "max-width:320px",
    "font:500 13px/1.35 -apple-system,BlinkMacSystemFont,'SF Pro Text',system-ui,sans-serif",
    "color:#fff", "background:rgba(28,28,32,.92)", "box-shadow:0 8px 28px rgba(0,0,0,.28)",
    "backdrop-filter:blur(12px)", "transition:opacity .4s ease",
  ].join(";");
  el.textContent = "Thread · finding your conversations…";
  doc.body.appendChild(el);

  return {
    update(p) {
      const total = Math.max(p.found - p.skipped, 0);
      switch (p.state) {
        case "listing":
          el.textContent = `Thread · found ${p.found} conversations…`;
          break;
        case "importing":
          el.textContent = `Thread · bringing in your thinking — ${p.imported} of ${total}`;
          break;
        case "done":
          el.textContent = total === 0
            ? "Thread · already up to date"
            : `Thread · done — ${p.imported} conversations in.${p.ideaCount != null ? ` ${p.ideaCount} ideas so far.` : ""} Recall them anytime from Thread.`;
          fadeOut();
          break;
        case "capped":
          el.textContent = "Thread · Free plan's 25 ideas reached. Upgrade to Pro to bring in the rest.";
          fadeOut(9000);
          break;
        case "stopped":
          el.textContent = "Thread · paused. It picks up where it left off next time.";
          fadeOut();
          break;
        case "error":
          el.textContent = `Thread · ${historyErrorText(p.error)}`;
          fadeOut(9000);
          break;
      }
    },
  };

  function fadeOut(after = 6000): void {
    setTimeout(() => {
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 500);
    }, after);
  }
}

