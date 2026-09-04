import { getPairingState, getSettings, setApiBaseUrl, setCredentials, setPairingState } from "../lib/storage";
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
  const labels: Record<PairingState["status"], string> = {
    paired: state.userId ? `Paired as ${state.userId.slice(0, 16)}…` : "Paired",
    unpaired: "Not connected",
    rejected: "Credentials expired",
  };
  $("statusText").textContent = labels[state.status];
  $("statusDetail").textContent = state.detail ?? "";
  $("dot").className = `dot ${state.status}`;
  ($("connect") as HTMLButtonElement).textContent =
    state.status === "paired" ? "Reconnect to Thread for Mac" : "Connect to Thread for Mac";
}

async function refresh(): Promise<void> {
  input("apiBaseUrl").value = (await getSettings()).apiBaseUrl;
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
  $("connect").addEventListener("click", () => void connect());
  $("usePairingString").addEventListener("click", () => void usePairingString());
  $("saveUrl").addEventListener("click", async () => {
    const value = input("apiBaseUrl").value.trim();
    if (value) await setApiBaseUrl(value);
    await refresh();
  });
}

init();
