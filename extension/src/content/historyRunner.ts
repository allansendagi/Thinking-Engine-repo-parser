import { addHistorySynced, getHistorySynced } from "../lib/storage";
import type { HistorySyncStatus, ImportBatchMessage } from "../lib/types";
import { runHistorySync, type SyncProgress } from "./historySync";
import type { SiteAdapter } from "./common/siteAdapter";

/** The link that starts a sync on arrival -- what Thread for Mac's "Recover my thinking" opens. */
export const HISTORY_HASH = "#thread-import";

const RUNNING_KEY = "__threadHistorySyncRunning";
const PILL_ID = "thread-history-pill";

/**
 * Hooks history sync into a page: start on `#thread-import` in the URL (then strip it, so a
 * reload doesn't restart), or on a `thread:history-run` message from the popup. One run per page.
 */
export function attachHistorySync(adapter: SiteAdapter, doc: Document = document): void {
  if (!adapter.history) return;
  const start = () => void runInPage(adapter, doc);

  if (location.hash === HISTORY_HASH) {
    history.replaceState(null, "", location.pathname + location.search);
    start();
  }
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if ((message as { type?: unknown } | null)?.type !== "thread:history-run") return false;
    start();
    sendResponse({ ok: true });
    return false;
  });
}

async function runInPage(adapter: SiteAdapter, doc: Document): Promise<void> {
  const w = window as unknown as Record<string, unknown>;
  if (w[RUNNING_KEY]) return;
  w[RUNNING_KEY] = true;
  const reader = adapter.history!();
  const source = adapter.source;
  const pill = showPill(doc);
  try {
    await runHistorySync({
      reader,
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
          el.textContent = `Thread · couldn't read your history here (${p.error ?? "unknown error"}). Are you signed in?`;
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
