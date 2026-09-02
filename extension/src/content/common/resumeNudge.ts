import type { SiteAdapter } from "./siteAdapter";
import type { ResumeSuggestion } from "../../lib/resume";

/**
 * "You opened Claude / ChatGPT / Gemini and there's an unfinished thought you might be coming
 * back to." A single restrained nudge, shown only on a *fresh* surface (a new/empty chat -- not
 * when you open an existing thread), at most once per URL, and never again for an idea you've
 * dismissed until that idea actually moves (the snooze lives server-adjacent in chrome.storage;
 * the rule is lib/resume.ts, shared with the Mac app).
 *
 * The decision of *what* to suggest is the background worker's (it has the credentials and the
 * API). This file is purely the trigger + the DOM: ask, and if there's an answer, draw a small
 * card in a shadow root so the host page's CSS can't touch it.
 */

const INITIAL_DELAY_MS = 3500; // let the SPA finish its first render before deciding "empty"
const URL_POLL_MS = 1500;
const HOST_ID = "thread-resume-nudge";

interface ResumeCheckResponse {
  ok: boolean;
  suggestion: ResumeSuggestion | null;
}

export function attachResumeNudge(adapter: SiteAdapter, doc: Document): () => void {
  let stopped = false;
  let lastHandledUrl: string | null = null;
  let lastSeenUrl = location.href;

  function contextGone(): boolean {
    return typeof chrome === "undefined" || !("runtime" in chrome) || !chrome.runtime?.id;
  }

  function isFreshSurface(): boolean {
    if (!adapter.getConversationId()) return true;
    try {
      return adapter.extractMessages(doc).length === 0;
    } catch {
      return false;
    }
  }

  async function maybeShow(): Promise<void> {
    if (stopped || contextGone()) return;
    if (doc.getElementById(HOST_ID)) return; // a card is already up
    const url = location.href;
    if (url === lastHandledUrl) return;
    if (!isFreshSurface()) {
      lastHandledUrl = url; // an existing thread -- don't reconsider this URL
      return;
    }

    let res: ResumeCheckResponse | undefined;
    try {
      res = (await chrome.runtime.sendMessage({ type: "thread:resume-check" })) as ResumeCheckResponse;
    } catch {
      return; // worker asleep / context torn down -- try again on the next URL change
    }
    if (stopped) return;
    lastHandledUrl = url;
    if (res?.suggestion) render(res.suggestion);
  }

  function dismiss(ideaId: string): void {
    try {
      void chrome.runtime.sendMessage({ type: "thread:resume-dismiss", ideaId });
    } catch {
      /* best effort */
    }
  }

  function render(s: ResumeSuggestion): void {
    if (doc.getElementById(HOST_ID)) return;
    const host = doc.createElement("div");
    host.id = HOST_ID;
    const root = host.attachShadow({ mode: "open" });

    const ageText = s.daysAgo <= 1 ? "1 day ago" : `${s.daysAgo} days ago`;
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .card {
          position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
          width: 320px; box-sizing: border-box; padding: 14px 14px 12px;
          font: 13px/1.45 -apple-system, "SF Pro Text", system-ui, sans-serif;
          color: #1d1d1f; background: rgba(250,250,252,0.98);
          border: 0.5px solid rgba(0,0,0,0.12); border-radius: 12px;
          box-shadow: 0 12px 32px rgba(0,0,0,0.16), 0 2px 8px rgba(0,0,0,0.08);
          backdrop-filter: saturate(180%) blur(20px);
        }
        .eyebrow { display:flex; align-items:center; gap:6px;
          font-size: 10px; font-weight: 650; letter-spacing: 0.06em; text-transform: uppercase;
          color: rgba(0,0,0,0.4); margin-bottom: 6px; }
        .dot { width: 6px; height: 6px; border-radius: 50%; background: #0A6FFF;
          box-shadow: 0 0 6px rgba(10,111,255,0.5); }
        .title { font-size: 13px; font-weight: 600; margin: 0 0 1px; }
        .sub { font-size: 11.5px; color: rgba(0,0,0,0.45); margin: 0 0 11px; }
        .row { display: flex; gap: 8px; }
        button { all: unset; cursor: pointer; font: inherit; font-size: 12px;
          padding: 6px 12px; border-radius: 7px; }
        .resume { background: #0A6FFF; color: #fff; font-weight: 600; }
        .resume:hover { background: #0960db; }
        .later { color: rgba(0,0,0,0.5); }
        .later:hover { color: rgba(0,0,0,0.8); }
        @media (prefers-color-scheme: dark) {
          .card { color: #f5f5f7; background: rgba(30,30,32,0.98); border-color: rgba(255,255,255,0.12); }
          .eyebrow, .sub { color: rgba(255,255,255,0.5); }
          .later { color: rgba(255,255,255,0.55); }
          .later:hover { color: #fff; }
        }
      </style>
      <div class="card" role="dialog" aria-label="Resume a thought in Thread">
        <div class="eyebrow"><span class="dot"></span>Pick up where you left off?</div>
        <p class="title"></p>
        <p class="sub">Last worked on ${ageText}</p>
        <div class="row">
          <button class="resume">Resume in Thread</button>
          <button class="later">Not now</button>
        </div>
      </div>`;
    // textContent, not innerHTML, for the idea title -- it's user data.
    root.querySelector(".title")!.textContent = s.title;

    const teardown = () => host.remove();
    root.querySelector(".resume")!.addEventListener("click", () => {
      // Hand off to the Mac app inside the user gesture so the OS protocol prompt is allowed.
      const a = doc.createElement("a");
      a.href = `thread://continue?idea=${encodeURIComponent(s.ideaId)}`;
      root.appendChild(a);
      a.click();
      dismiss(s.ideaId);
      teardown();
    });
    root.querySelector(".later")!.addEventListener("click", () => {
      dismiss(s.ideaId);
      teardown();
    });

    (doc.body ?? doc.documentElement).appendChild(host);
  }

  const initial = setTimeout(() => void maybeShow(), INITIAL_DELAY_MS);
  const poll = setInterval(() => {
    if (stopped || contextGone()) return;
    if (location.href !== lastSeenUrl) {
      lastSeenUrl = location.href;
      doc.getElementById(HOST_ID)?.remove(); // stale card from the previous view
      setTimeout(() => void maybeShow(), 800);
    }
  }, URL_POLL_MS);

  return () => {
    stopped = true;
    clearTimeout(initial);
    clearInterval(poll);
    doc.getElementById(HOST_ID)?.remove();
  };
}
