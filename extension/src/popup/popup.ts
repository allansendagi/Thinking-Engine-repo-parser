import {
  DEFAULT_API_BASE_URL,
  getPairingState,
  getSettings,
  setApiBaseUrl,
  setCredentials,
  setPairingState,
} from "../lib/storage";
import { parsePairingString } from "../lib/pairing";
import type { PairingState } from "../lib/types";

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el;
}
const input = (id: string) => document.getElementById(id) as HTMLInputElement;

function showError(message: string): void {
  $("error").textContent = message;
}

function render(state: PairingState): void {
  const paired = state.status === "paired";
  const labels: Record<PairingState["status"], string> = {
    paired: "Connected to Thread for Mac",
    unpaired: "Not connected",
    rejected: "Connection expired",
  };
  $("statusText").textContent = labels[state.status];
  $("statusDetail").textContent = paired
    ? "Capturing from this browser."
    : (state.detail ?? "Open Thread for Mac to connect.");
  $("dot").className = `dot ${state.status}`;

  // When connected, the big blue button is noise -- collapse it to a quiet "Reconnect" link.
  ($("connect") as HTMLButtonElement).hidden = paired;
  ($("reconnect") as HTMLButtonElement).hidden = !paired;
  // The code paste-in section only matters when the automatic path isn't working.
  ($("codeSection") as HTMLDetailsElement).hidden = paired;
}

async function refresh(): Promise<void> {
  const s = await getSettings();
  // Don't surface the default backend URL -- only show a value the user has deliberately set.
  input("apiBaseUrl").value = s.apiBaseUrl === DEFAULT_API_BASE_URL ? "" : s.apiBaseUrl;
  render(await getPairingState());
}

async function connect(): Promise<void> {
  showError("");
  $("statusText").textContent = "Connecting…";
  try {
    const res = (await chrome.runtime.sendMessage({ type: "thread:pair-now" })) as
      | { ok: true; state: PairingState }
      | { ok: false; error: string };
    if (res.ok) {
      render(res.state);
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
  // Tell Thread for Mac right away so its Settings flips to "Browser connected".
  void chrome.runtime.sendMessage({ type: "thread:announce" });
  input("pairingString").value = "";
  await refresh();
}

function init(): void {
  void refresh();
  // Opening the popup is a good moment to tell the Mac we're here.
  void chrome.runtime.sendMessage({ type: "thread:announce" });
  $("connect").addEventListener("click", () => void connect());
  $("reconnect").addEventListener("click", () => void connect());
  $("usePairingString").addEventListener("click", () => void usePairingString());
  $("saveUrl").addEventListener("click", async () => {
    // Blank = reset to the default backend.
    await setApiBaseUrl(input("apiBaseUrl").value.trim() || DEFAULT_API_BASE_URL);
    await refresh();
  });
}

init();
