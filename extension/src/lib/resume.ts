import type { ThinkingState } from "./api";

/**
 * The browser-side twin of the Mac app's `pickResumeSuggestion` (macos-app ResumeBar.swift). The
 * rule is a scored judgment, not a filter — every factor is in [0, 1], the score is their
 * product, and it must clear the confidence floor to show anything. Held to "never wrong": one
 * bad nudge costs more than ten missed ones. Kept identical to the Swift so a nudge shown in
 * Chrome and the one shown in the app never disagree.
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
  /** The unfinished thing is a logged contradiction (or the idea's state is contested) — the
   *  one "act now" signal, weighted well above a plain open question. */
  isContradiction: boolean;
  lastTouched: Date;
}

/** How many times this idea's nudge has been shown, and the activity timestamp it was showing
 *  against — so a fresh edit to the idea resets the count. */
export interface ResumeShown {
  count: number;
  sinceActivity: string; // ISO
}

const DAY_MS = 86_400_000;
export const RESUME_CONFIDENCE_FLOOR = 0.5;

/** Peaks a few days out (interrupted, still warm), decays to nothing by ~7 weeks. */
export function resumeRecencyWeight(ageDays: number): number {
  if (ageDays < 1.5) return 0;
  if (ageDays < 3.5) return 0.2 + ((ageDays - 1.5) / 2.0) * 0.8;
  if (ageDays <= 16) return 1.0;
  if (ageDays <= 35) return 1.0 - ((ageDays - 16) / 19) * 0.6;
  if (ageDays <= 50) return 0.4 - ((ageDays - 35) / 15) * 0.4;
  return 0;
}

export function resumeUnfinishedWeight(contradiction: boolean, openLoop: boolean): number {
  if (contradiction) return 1.0;
  if (openLoop) return 0.72;
  return 0;
}

export function resumeFatigueWeight(shownCount: number): number {
  if (shownCount < 1) return 1.0;
  if (shownCount === 1) return 0.75;
  if (shownCount === 2) return 0.5;
  return 0; // offered enough times without a resume — it isn't live
}

export function scoreResumeCandidate(c: ResumeCandidate, shownCount: number, now: Date): number {
  const ageDays = (now.getTime() - c.lastTouched.getTime()) / DAY_MS;
  return (
    resumeRecencyWeight(ageDays) *
    resumeUnfinishedWeight(c.isContradiction || c.state === "contested", c.hasOpenLoop) *
    resumeFatigueWeight(shownCount)
  );
}

/** Ideas with no recorded activity can't be dated, so they're not candidates. */
export function candidatesFromState(state: ThinkingState): ResumeCandidate[] {
  const lastTouched = new Map<string, number>();
  for (const c of state.recentChanges) {
    const t = Date.parse(c.createdAt);
    if (Number.isNaN(t)) continue;
    lastTouched.set(c.ideaId, Math.max(lastTouched.get(c.ideaId) ?? 0, t));
  }

  const unresolved = state.openLoops.filter((l) => !l.resolved);
  const openLoopIdeaIds = new Set(unresolved.map((l) => l.ideaId));
  const contradictionIdeaIds = new Set(
    unresolved.filter((l) => /^\s*Unresolved contradiction:/i.test(l.statement)).map((l) => l.ideaId),
  );

  const out: ResumeCandidate[] = [];
  for (const idea of state.currentIdeas) {
    const t = lastTouched.get(idea.id);
    if (t === undefined) continue;
    out.push({
      id: idea.id,
      title: idea.title,
      state: idea.state,
      hasOpenLoop: openLoopIdeaIds.has(idea.id),
      isContradiction: contradictionIdeaIds.has(idea.id) || idea.state === "contested",
      lastTouched: new Date(t),
    });
  }
  return out;
}

/**
 * The single idea worth resuming right now, or null. Scores every eligible candidate, drops
 * anything snoozed or below the confidence floor, and stays quiet when the top two are close
 * enough that guessing which one you mean would be a coin flip.
 */
export function pickResumeSuggestion(
  candidates: ResumeCandidate[],
  snoozed: Record<string, string>,
  history: Record<string, ResumeShown> = {},
  now: Date = new Date(),
): ResumeSuggestion | null {
  const scored = candidates
    .flatMap((c) => {
      if (c.state === "dormant" || c.state === "rejected") return [];
      const s = snoozed[c.id];
      if (s !== undefined && c.lastTouched.getTime() <= Date.parse(s)) return [];
      const h = history[c.id];
      const shown = h && c.lastTouched.getTime() <= Date.parse(h.sinceActivity) ? h.count : 0;
      const score = scoreResumeCandidate(c, shown, now);
      if (score <= 0) return [];
      return [{ c, score, age: (now.getTime() - c.lastTouched.getTime()) / DAY_MS }];
    })
    .sort((a, b) => (a.score !== b.score ? b.score - a.score : a.age - b.age));

  const top = scored[0];
  if (!top) return null;

  // If a second candidate is nearly as strong *and* nearly as recent, we don't know which you
  // mean — say nothing rather than risk the wrong one.
  const second = scored[1];
  if (second && top.score - second.score < 0.08 && Math.abs(top.age - second.age) < 2.5) return null;

  if (top.score < RESUME_CONFIDENCE_FLOOR) return null;

  return { ideaId: top.c.id, title: top.c.title, daysAgo: Math.max(1, Math.round(top.age)) };
}

/** State snapshot -> suggestion, the whole path the background worker uses. */
export function suggestionFromState(
  state: ThinkingState,
  snoozed: Record<string, string>,
  history: Record<string, ResumeShown> = {},
  now: Date = new Date(),
): ResumeSuggestion | null {
  return pickResumeSuggestion(candidatesFromState(state), snoozed, history, now);
}
