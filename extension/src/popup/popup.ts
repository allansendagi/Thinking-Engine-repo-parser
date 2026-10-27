import {
  getAccountInfo,
  getCaptureHealth,
  getCaptureQueue,
  getHistoryComplete,
  getHistoryImportedCount,
  getHistoryStatus,
  getPairingState,
  setCredentials,
  setPairingState,
} from "../lib/storage";
import { escapeHtml } from "../lib/escape";
import { parsePairingString } from "../lib/pairing";
import { historyErrorText } from "../lib/historyText";
import type { AccountInfo, CaptureHealth, ExtensionStatus, PairingState, Source, SourceHealth } from "../lib/types";

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el;
}
const input = (id: string) => document.getElementById(id) as HTMLInputElement;

function showError(message: string): void {
  $("error").textContent = message;
}

/** "just now" / "4m ago" / "2h ago" / "3d ago" -- a coarse relative time, no library. */
function ago(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const SOURCE_LABEL: Record<Source, string> = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  gemini: "Gemini",
  perplexity: "Perplexity",
  grok: "Grok",
};
const SOURCE_ORDER: Source[] = ["chatgpt", "claude", "gemini", "perplexity", "grok"];

function renderConnection(state: PairingState, account: AccountInfo | null): void {
  const paired = state.status === "paired";
  const labels: Record<PairingState["status"], string> = {
    paired: "Connected to Thread for Mac",
    unpaired: "Not connected",
    rejected: "Connection expired",
  };
  $("statusText").textContent = labels[state.status];
  $("dot").className = `dot ${state.status}`;

  // Line 2: which account (so a stray account is visible), else the pairing detail.
  const who = account
    ? `${account.email ?? `${account.userId.slice(0, 13)}…`}${account.isPro ? " · Pro" : ""}`
    : null;
  $("statusDetail").textContent = paired
    ? (who ?? "Capturing from this browser.")
    : (state.detail ?? "Open Thread for Mac to connect.");

  ($("connect") as HTMLButtonElement).hidden = paired;
  ($("reconnect") as HTMLButtonElement).hidden = !paired;
  ($("codeSection") as HTMLDetailsElement).hidden = paired;
}

function renderCapture(health: CaptureHealth, paired: boolean, queued: number): void {
  const wrap = $("capture");
  wrap.hidden = !paired;
  if (!paired) return;

  const rows = SOURCE_ORDER.map((src) => {
    const h: SourceHealth | undefined = health[src];
    const cls = !h
      ? "muted"
      : h.state === "ok"
        ? "ok"
        : h.state === "degraded" || h.state === "error"
          ? "bad"
          : "muted";
    // No entry at all = we've never heard from a content script for this tool. Almost always:
    // the tab was open before the extension (re)loaded and needs a reload to attach.
    const line = !h
      ? "open a tab, or reload it if it's already open"
      : h.state === "ok"
        ? h.lastCaptureAt
          ? `last capture ${ago(h.lastCaptureAt)}`
          : "up to date"
        : h.state === "idle"
          ? "no conversation open"
          : (h.detail ?? "not working");
    return `
      <div class="srow">
        <span class="sdot ${cls}"></span>
        <span class="sname">${SOURCE_LABEL[src]}</span>
        <span class="sdetail ${h && (h.state === "degraded" || h.state === "error") ? "warn" : ""}">${escapeHtml(line)}</span>
      </div>`;
  }).join("");

  const backlog =
    queued > 0
      ? `<div class="srow"><span class="sdot muted"></span><span class="sdetail">${queued} conversation${queued === 1 ? "" : "s"} waiting to retry</span></div>`
      : "";
  wrap.innerHTML = `<div class="chdr">Capture</div>${rows}${backlog}`;
}

function render(status: ExtensionStatus): void {
  renderConnection(status.pairing, status.account);
  renderCapture(status.health, status.pairing.status === "paired", status.queued);
  $("history").hidden = status.pairing.status !== "paired";
  void renderHistory();
}

const HISTORY_LABEL: Record<string, string> = { chatgpt: "ChatGPT", claude: "Claude" };

const HISTORY_SOURCES = ["chatgpt", "claude"] as const;

/**
 * Before any import: the "Bring in your history" card. After a full import from a site: one quiet
 * line per site ("ChatGPT history in · 312 conversations · 15 Oct") with a small "Check for new" --
 * new conversations arrive on their own, so the big button would only invite a needless re-run.
 * Below either, a line per site that is running or ended badly.
 */
async function renderHistory(): Promise<void> {
  const [all, complete] = await Promise.all([
    getHistoryStatus(),
    Promise.all(
      HISTORY_SOURCES.map(async (s) => {
        // A run cut short still brought conversations in: show them as in, offer to continue.
        const c = await getHistoryComplete(s);
        const imported = c ? 0 : await getHistoryImportedCount(s);
        return [s, c ?? (imported > 0 ? { at: "", conversations: imported, partial: true } : null)] as const;
      }),
    ),
  ]);
  const done = complete.filter(([, c]) => c !== null);
  $("historyIntro").hidden = done.length > 0;
  $("historyDone").hidden = done.length === 0;
  const rows = $("historyRows");
  rows.textContent = "";
  for (const [source, c] of complete) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin:2px 0";
    const label = document.createElement("span");
    const name = HISTORY_LABEL[source] ?? source;
    const action = document.createElement("button");
    action.className = "link";
    action.style.cssText = "background:none;border:0;padding:0;color:inherit;opacity:.7;text-decoration:underline;cursor:pointer;font:inherit";
    if (c && "partial" in c) {
      label.textContent = `${name} · ${c.conversations.toLocaleString()} conversations in`;
      action.textContent = "Finish";
    } else if (c) {
      const when = new Date(c.at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
      label.textContent = `${name} · ${c.conversations.toLocaleString()} conversations · ${when}`;
      action.textContent = "Check for new";
    } else {
      label.textContent = `${name} · not brought in`;
      action.textContent = "Bring in";
    }
    action.addEventListener("click", () => void startHistory(source));
    row.append(label, action);
    rows.appendChild(row);
  }

  const lines = Object.entries(all).flatMap(([source, s]) => {
    const name = HISTORY_LABEL[source] ?? source;
    const todo = Math.max(s.found - s.skipped, 0);
    switch (s.state) {
      case "listing": return [`${name}: checking for conversations… (${s.found})`];
      case "importing": return [`${name}: bringing in ${s.imported} of ${todo}…`];
      case "done": return done.some(([d]) => d === source) ? [] : [`${name}: up to date · ${s.found} conversations`];
      case "capped": return [`${name}: stopped at the Free plan's 25 ideas — upgrade to bring in the rest`];
      case "stopped": return [`${name}: paused at ${s.imported} of ${todo} — run again to continue`];
      case "error": return [`${name}: ${historyErrorText(s.error)}`];
    }
  });
  $("historyStatus").textContent = lines.join("\n");
  ($("historyStatus") as HTMLElement).style.whiteSpace = "pre-line";
}

async function startHistory(source: "chatgpt" | "claude"): Promise<void> {
  const res = (await chrome.runtime.sendMessage({ type: "thread:history-start", source })) as
    | { ok: boolean; error?: string }
    | undefined;
  if (!res?.ok) showError(res?.error ?? "Couldn't start the import.");
  else window.close(); // the page shows live progress
}

/** Ask the worker for the whole picture; fall back to reading storage directly if it's asleep. */
async function loadStatus(): Promise<ExtensionStatus> {
  try {
    const res = (await chrome.runtime.sendMessage({ type: "thread:status" })) as
      | { ok: true; status: ExtensionStatus }
      | { ok: false };
    if (res && res.ok) return res.status;
  } catch {
    /* worker not up -- read storage below */
  }
  return {
    pairing: await getPairingState(),
    account: await getAccountInfo(),
    health: await getCaptureHealth(),
    queued: (await getCaptureQueue()).length,
  };
}

async function refresh(): Promise<void> {
  render(await loadStatus());
}

async function connect(): Promise<void> {
  showError("");
  $("statusText").textContent = "Connecting…";
  try {
    const res = (await chrome.runtime.sendMessage({ type: "thread:pair-now" })) as
      | { ok: true; state: PairingState }
      | { ok: false; error: string };
    if (res.ok) {
      await refresh();
      if (res.state.status !== "paired") {
        // Same guided page as first install: it knows whether the app is missing or just needs
        // its pairing window reopened, and says which.
        void chrome.tabs.create({ url: chrome.runtime.getURL("dist/welcome.html") });
      }
    } else {
      showError(res.error);
      await refresh();
    }
  } catch (err) {
    showError(err instanceof Error ? err.message : "Could not reach the extension worker.");
    await refresh();
  }
}

async function usePairingString(): Promise<void> {
  showError("");
  const parsed = parsePairingString(input("pairingString").value);
  if (!parsed) {
    showError("That doesn't look like a pairing string. Expected user_<24 hex>:<64 hex>.");
    return;
  }
  await setCredentials(parsed);
  await setPairingState({
    status: "paired",
    userId: parsed.userId,
    lastAttemptAt: new Date().toISOString(),
    detail: "Paired with a code.",
  });
  void chrome.runtime.sendMessage({ type: "thread:announce" });
  input("pairingString").value = "";
  await refresh();
}

function init(): void {
  void refresh();
  void chrome.runtime.sendMessage({ type: "thread:announce" });
  $("connect").addEventListener("click", () => void connect());
  $("reconnect").addEventListener("click", () => void connect());
  $("usePairingString").addEventListener("click", () => void usePairingString());
  $("historyChatgpt").addEventListener("click", () => void startHistory("chatgpt"));
  $("historyClaude").addEventListener("click", () => void startHistory("claude"));
  chrome.storage.onChanged.addListener((changes) => {
    if (Object.keys(changes).some((k) => k === "historyStatus" || k.startsWith("historyComplete:"))) void renderHistory();
  });
}

init();
