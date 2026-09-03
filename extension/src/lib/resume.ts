import type { ThinkingState } from "./api";

/**
 * The browser-side twin of the Mac app's `pickResumeSuggestion` (macos-app ResumeBar.swift). Same
 * conservative rule, so a return nudge shown in Chrome and the one shown in the app never
 * disagree: an idea qualifies only if it's genuinely unfinished (an open loop, or contested),
 * not dormant/rejected, last touched 3-45 days ago, and not snoozed since its last activity.
 * Returns the single most-recently-touched qualifier, or null.
 *
 * Computed here from Thinking State rather than a dedicated endpoint -- getThinkingState()
 * already carries every field this needs, and keeping the rule identical on both clients matters
 * more than saving one API round-trip.
 */

export interface ResumeSuggestion {
  ideaId: string;
  title: string;
  daysAgo: number;
}

export interface ResumeCandidate {
  id: string;
  title: string;
  state: string;
  hasOpenLoop: boolean;
  lastTouched: Date; // ms since epoch wrapped
}

const DAY_MS = 86_400_000;

/** Build the candidate list from a Thinking State snapshot. Ideas with no recorded activity
 *  (nothing in recentChanges) can't be dated, so they're not candidates. */
export function candidatesFromState(state: ThinkingState): ResumeCandidate[] {
  const lastTouched = new Map<string, number>();
  for (const c of state.recentChanges) {
    const t = Date.parse(c.createdAt);
    if (Number.isNaN(t)) continue;
    lastTouched.set(c.ideaId, Math.max(lastTouched.get(c.ideaId) ?? 0, t));
  }

  const openLoopIdeaIds = new Set(state.openLoops.filter((l) => !l.resolved).map((l) => l.ideaId));

  const out: ResumeCandidate[] = [];
  for (const idea of state.currentIdeas) {
    const t = lastTouched.get(idea.id);
    if (t === undefined) continue;
    out.push({
      id: idea.id,
      title: idea.title,
      state: idea.state,
      hasOpenLoop: openLoopIdeaIds.has(idea.id),
      lastTouched: new Date(t),
    });
  }
  return out;
}

export function pickResumeSuggestion(
  candidates: ResumeCandidate[],
  snoozed: Record<string, string>,
  now: Date = new Date(),
): ResumeSuggestion | null {
  const qualifying = candidates.filter((c) => {
    if (c.state === "dormant" || c.state === "rejected") return false;
    if (!c.hasOpenLoop && c.state !== "contested") return false;
    const ageDays = (now.getTime() - c.lastTouched.getTime()) / DAY_MS;
    if (ageDays < 3 || ageDays > 45) return false;
    const s = snoozed[c.id];
    if (s !== undefined && c.lastTouched.getTime() <= Date.parse(s)) return false;
    return true;
  });
  if (qualifying.length === 0) return null;

  const best = qualifying.reduce((a, b) => (a.lastTouched.getTime() >= b.lastTouched.getTime() ? a : b));
  return {
    ideaId: best.id,
    title: best.title,
    daysAgo: Math.round((now.getTime() - best.lastTouched.getTime()) / DAY_MS),
  };
}

/** Convenience: state snapshot -> suggestion, the whole path the background worker uses. */
export function suggestionFromState(
  state: ThinkingState,
  snoozed: Record<string, string>,
  now: Date = new Date(),
): ResumeSuggestion | null {
  return pickResumeSuggestion(candidatesFromState(state), snoozed, now);
}
