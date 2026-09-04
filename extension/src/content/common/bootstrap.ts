import { startCapture } from "./capture";
import { attachResumeNudge } from "./resumeNudge";
import type { SiteAdapter } from "./siteAdapter";

/** Holds the previous instance's capture-teardown fn on the shared isolated-world `window`. */
const TEARDOWN_KEY = "__threadCaptureTeardown";

/**
 * Content-script entry, safe to run more than once in a page. After the extension is
 * reloaded/updated the background worker re-injects this into every open ChatGPT/Claude/Gemini
 * tab (see background.ts `reinjectOpenTabs`) so capture resumes without the user reloading each
 * tab. All injections of one extension into one frame share an isolated world, so we can find
 * and tear down the previous instance before starting a fresh one -- no duplicate
 * MutationObserver / backstop loop, and (critically) a re-inject over a *dead* previous instance
 * still takes effect.
 */
export function bootstrapContentScript(adapter: SiteAdapter): void {
  const w = window as unknown as Record<string, unknown>;
  (w[TEARDOWN_KEY] as (() => void) | undefined)?.();
  document.getElementById("thread-resume-nudge")?.remove();

  w[TEARDOWN_KEY] = startCapture(adapter, document);
  attachResumeNudge(adapter, document);
}
