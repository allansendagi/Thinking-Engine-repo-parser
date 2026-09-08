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

  /** Remove any live card and run its listener/timer cleanup (the render closure parks a
   *  `__threadCleanup` on the host so URL changes / teardown don't leak a keydown handler). */
  function removeCard(): void {
    const el = doc.getElementById(HOST_ID) as (HTMLElement & { __threadCleanup?: () => void }) | null;
    el?.__threadCleanup?.();
    el?.remove();
  }

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
        @keyframes thread-nudge-in {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .card {
          position: fixed; right: 20px; bottom: 84px; z-index: 2147483647;
          width: 320px; box-sizing: border-box; padding: 14px 14px 12px;
          font: 13px/1.45 -apple-system, "SF Pro Text", system-ui, sans-serif;
          color: #1d1d1f; background: rgba(250,250,252,0.98);
          border: 0.5px solid rgba(0,0,0,0.12); border-radius: 12px;
          box-shadow: 0 12px 32px rgba(0,0,0,0.16), 0 2px 8px rgba(0,0,0,0.08);
          backdrop-filter: saturate(180%) blur(20px);
          animation: thread-nudge-in 180ms cubic-bezier(0.22, 1, 0.36, 1);
        }
        .card.leaving { opacity: 0; transform: translateY(8px);
          transition: opacity 140ms ease, transform 140ms ease; }
        @media (prefers-reduced-motion: reduce) {
          .card { animation: none; }
          .card.leaving { transition: none; }
        }
        .eyebrow { display:flex; align-items:center; gap:6px;
          font-size: 10px; font-weight: 650; letter-spacing: 0.06em; text-transform: uppercase;
          color: rgba(0,0,0,0.4); margin-bottom: 6px; }
        .dot { width: 6px; height: 6px; border-radius: 50%; background: #0A6FFF;
          box-shadow: 0 0 6px rgba(10,111,255,0.5); }
        .title { font-size: 13px; font-weight: 600; margin: 0 0 1px; }
        .sub { font-size: 11.5px; color: rgba(0,0,0,0.45); margin: 0 0 11px; }
        .row { display: flex; align-items: center; gap: 10px; }
        button { all: unset; cursor: pointer; font: inherit; font-size: 12px;
          padding: 6px 12px; border-radius: 7px; }
        button[disabled] { opacity: 0.6; cursor: default; }
        .primary { background: #0A6FFF; color: #fff; font-weight: 600; }
        .primary:hover { background: #0960db; }
        .secondary { color: rgba(0,0,0,0.6); }
        .secondary:hover { color: rgba(0,0,0,0.9); }
        .later { color: rgba(0,0,0,0.45); margin-left: auto; }
        .later:hover { color: rgba(0,0,0,0.8); }
        @media (prefers-color-scheme: dark) {
          .card { color: #f5f5f7; background: rgba(30,30,32,0.98); border-color: rgba(255,255,255,0.12); }
          .eyebrow, .sub { color: rgba(255,255,255,0.5); }
          .secondary { color: rgba(255,255,255,0.6); }
          .secondary:hover { color: #fff; }
          .later { color: rgba(255,255,255,0.5); }
          .later:hover { color: #fff; }
        }
      </style>
      <div class="card" role="dialog" aria-label="Resume a thought in Thread">
        <div class="eyebrow"><span class="dot"></span>Pick up where you left off?</div>
        <p class="title"></p>
        <p class="sub">Last worked on ${ageText}</p>
        <div class="row"></div>
      </div>`;
    // textContent, not innerHTML, for the idea title -- it's user data.
    root.querySelector(".title")!.textContent = s.title;

    const rowEl = root.querySelector(".row")!;
    const cardEl = root.querySelector(".card") as HTMLElement;

    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (idleTimer) clearTimeout(idleTimer);
      doc.removeEventListener("keydown", onKey, true);
      host.remove();
    };
    // So an outer URL change / teardown can clear our listener + timer, not just the DOM node.
    (host as HTMLElement & { __threadCleanup?: () => void }).__threadCleanup = cleanup;
    /** Slide out, then remove. Used for every dismissal so nothing just vanishes. */
    const teardown = () => {
      if (idleTimer) clearTimeout(idleTimer);
      doc.removeEventListener("keydown", onKey, true);
      cardEl.classList.add("leaving");
      setTimeout(cleanup, 180);
    };
    /** Leave quietly WITHOUT recording a dismissal -- Escape and the idle timeout just clear the
     *  card; the same idea can nudge again on the next fresh surface. */
    const hideWithoutSnooze = () => teardown();
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        e.stopPropagation();
        hideWithoutSnooze();
      }
    }
    doc.addEventListener("keydown", onKey, true);
    // A nudge that's sat untouched for a while is clutter -- fade it, but don't snooze it.
    idleTimer = setTimeout(hideWithoutSnooze, 25_000);

    /** Hand off to the Mac app -- inside a user gesture so the OS protocol prompt is allowed. */
    const openInThread = () => {
      const a = doc.createElement("a");
      a.href = `thread://continue?idea=${encodeURIComponent(s.ideaId)}`;
      root.appendChild(a);
      a.click();
      dismiss(s.ideaId);
      teardown();
    };

    const mkButton = (cls: string, label: string): HTMLButtonElement => {
      const b = doc.createElement("button");
      b.className = cls;
      b.textContent = label;
      rowEl.appendChild(b);
      return b;
    };

    // Primary: drop the continuation packet straight into this tool's composer. Only when the
    // adapter can write to a composer AND this is genuinely a NEW chat (no conversation id) --
    // a loaded-but-slow existing thread also reads as "fresh" to the nudge heuristic, and we
    // must not prepend a checkpoint into a conversation that already has context. Otherwise
    // "Open in Thread" leads.
    const canInsert =
      typeof adapter.insertIntoComposer === "function" && adapter.getConversationId() === null;
    const continueBtn = mkButton("primary", canInsert ? "Continue here" : "Open in Thread");
    const secondaryBtn = canInsert ? mkButton("secondary", "Open in Thread") : null;
    mkButton("later", "Not now").addEventListener("click", () => {
      dismiss(s.ideaId);
      teardown();
    });
    secondaryBtn?.addEventListener("click", openInThread);

    continueBtn.addEventListener("click", () => {
      if (!canInsert) return openInThread();
      continueBtn.disabled = true;
      continueBtn.textContent = "Continuing…";
      chrome.runtime
        .sendMessage({ type: "thread:continue-packet", ideaId: s.ideaId })
        .then((res: { ok: boolean; text?: string; error?: string }) => {
          if (res?.ok && res.text && adapter.insertIntoComposer!(res.text, doc)) {
            dismiss(s.ideaId);
            teardown();
            return;
          }
          // Packet fetched but the composer wasn't found, or the fetch failed -- fall back to
          // the Mac app rather than leaving the user with a dead button.
          openInThread();
        })
        .catch(() => openInThread());
    });

    (doc.body ?? doc.documentElement).appendChild(host);
  }

  const initial = setTimeout(() => void maybeShow(), INITIAL_DELAY_MS);
  const poll = setInterval(() => {
    if (stopped || contextGone()) return;
    if (location.href !== lastSeenUrl) {
      lastSeenUrl = location.href;
      removeCard(); // stale card from the previous view
      setTimeout(() => void maybeShow(), 800);
    }
  }, URL_POLL_MS);

  return () => {
    stopped = true;
    clearTimeout(initial);
    clearInterval(poll);
    removeCard();
  };
}
