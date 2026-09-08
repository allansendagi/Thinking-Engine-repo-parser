import {
  DEFAULT_API_BASE_URL,
  getAccountInfo,
  getCaptureHealth,
  getCaptureQueue,
  getPairingState,
  getSettings,
  setApiBaseUrl,
  setCredentials,
  setPairingState,
} from "../lib/storage";
import { parsePairingString } from "../lib/pairing";
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
};
const SOURCE_ORDER: Source[] = ["chatgpt", "claude", "gemini", "perplexity"];

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
    const state = h?.state ?? "idle";
    const cls =
      state === "ok" ? "ok" : state === "degraded" || state === "error" ? "bad" : "muted";
    const line =
      state === "ok"
        ? h?.lastCaptureAt
          ? `last capture ${ago(h.lastCaptureAt)}`
          : "up to date"
        : state === "idle"
          ? "no conversation open"
          : (h?.detail ?? "not working");
    return `
      <div class="srow">
        <span class="sdot ${cls}"></span>
        <span class="sname">${SOURCE_LABEL[src]}</span>
        <span class="sdetail ${state === "degraded" || state === "error" ? "warn" : ""}">${line}</span>
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
  const s = await getSettings();
  input("apiBaseUrl").value = s.apiBaseUrl === DEFAULT_API_BASE_URL ? "" : s.apiBaseUrl;
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
        showError("Thread for Mac isn't reachable. Open the app, or pair with a code below.");
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
  $("saveUrl").addEventListener("click", async () => {
    await setApiBaseUrl(input("apiBaseUrl").value.trim() || DEFAULT_API_BASE_URL);
    await refresh();
  });
}

init();
