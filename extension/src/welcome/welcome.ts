import { probeDesktop } from "../lib/pairing";
import { getPairingState } from "../lib/storage";
import { welcomeView, type WelcomeView } from "./view";

const $ = (id: string) => document.getElementById(id) as HTMLElement;

function render(v: WelcomeView): void {
  $("title").textContent = v.title;
  $("body").textContent = v.body;
  const actions = $("actions");
  actions.replaceChildren();
  for (const [link, primary] of [[v.primary, true], [v.secondary, false]] as const) {
    if (!link) continue;
    const a = document.createElement("a");
    a.className = primary ? "btn primary" : "btn";
    a.textContent = link.label;
    a.href = link.href;
    if (link.href.startsWith("http")) a.target = "_blank";
    actions.append(a);
  }
}

let adopting = false;

async function tick(): Promise<void> {
  const state = await getPairingState();
  const paired = state.status === "paired" && !!state.userId;
  const desktop = paired ? "closed" : await probeDesktop();
  render(welcomeView(paired, desktop));

  // The Mac is serving credentials right now: adopt them. The background worker owns pairing.
  if (!paired && desktop === "open" && !adopting) {
    adopting = true;
    try {
      await chrome.runtime.sendMessage({ type: "thread:pair-now" });
    } finally {
      adopting = false;
    }
    void tick();
  }
}

void tick();
// Keep checking: the page finishes the job on its own once the app is installed / the window opens.
setInterval(() => {
  if (!document.hidden) void tick();
}, 2000);
