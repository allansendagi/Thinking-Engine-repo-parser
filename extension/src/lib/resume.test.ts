import { describe, expect, test } from "bun:test";
import { candidatesFromState, pickResumeSuggestion, type ResumeCandidate } from "./resume";
import type { ThinkingState } from "./api";

// Ported 1:1 from macos-app ResumeSuggestionTests.swift -- the two clients must apply the same rule.
const NOW = new Date(1_760_000_000 * 1000);
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const iso = (n: number) => daysAgo(n).toISOString();

function cand(
  id: string,
  { state = "developing", loop = true, touchedDaysAgo }: { state?: string; loop?: boolean; touchedDaysAgo: number },
): ResumeCandidate {
  return { id, title: id[0]!.toUpperCase() + id.slice(1), state, hasOpenLoop: loop, lastTouched: daysAgo(touchedDaysAgo) };
}

describe("pickResumeSuggestion", () => {
  test("picks the most recent qualifier", () => {
    const out = pickResumeSuggestion(
      [cand("a", { touchedDaysAgo: 20 }), cand("b", { touchedDaysAgo: 6 }), cand("c", { touchedDaysAgo: 12 })],
      {},
      NOW,
    );
    expect(out?.ideaId).toBe("b");
    expect(out?.daysAgo).toBe(6);
  });

  test("needs something unfinished (open loop or contested)", () => {
    expect(pickResumeSuggestion([cand("a", { loop: false, touchedDaysAgo: 10 })], {}, NOW)).toBeNull();
    expect(
      pickResumeSuggestion([cand("a", { state: "contested", loop: false, touchedDaysAgo: 10 })], {}, NOW),
    ).not.toBeNull();
  });

  test("age window is 3-45 days", () => {
    expect(pickResumeSuggestion([cand("a", { touchedDaysAgo: 1 })], {}, NOW)).toBeNull();
    expect(pickResumeSuggestion([cand("a", { touchedDaysAgo: 60 })], {}, NOW)).toBeNull();
    expect(pickResumeSuggestion([cand("a", { touchedDaysAgo: 3 })], {}, NOW)).not.toBeNull();
    expect(pickResumeSuggestion([cand("a", { touchedDaysAgo: 45 })], {}, NOW)).not.toBeNull();
  });

  test("skips dormant and rejected", () => {
    expect(pickResumeSuggestion([cand("a", { state: "dormant", touchedDaysAgo: 10 })], {}, NOW)).toBeNull();
    expect(pickResumeSuggestion([cand("a", { state: "rejected", touchedDaysAgo: 10 })], {}, NOW)).toBeNull();
  });

  test("snooze suppresses until the idea is touched again", () => {
    const c = cand("a", { touchedDaysAgo: 10 });
    expect(pickResumeSuggestion([c], { a: iso(2) }, NOW)).toBeNull(); // snoozed after last activity
    expect(pickResumeSuggestion([c], { a: iso(20) }, NOW)).not.toBeNull(); // idea moved since the snooze
  });

  test("no qualifiers means no nudge", () => {
    expect(pickResumeSuggestion([], {}, NOW)).toBeNull();
  });
});

describe("candidatesFromState", () => {
  const state: ThinkingState = {
    topic: null,
    currentIdeas: [
      { id: "i1", title: "One", state: "developing", currentFormulation: "…" },
      { id: "i2", title: "Two", state: "established", currentFormulation: "…" },
      { id: "i3", title: "Three (untouched)", state: "developing", currentFormulation: "…" },
    ],
    recentChanges: [
      { ideaId: "i1", ideaTitle: "One", formulation: "a", createdAt: iso(9) },
      { ideaId: "i1", ideaTitle: "One", formulation: "b", createdAt: iso(4) }, // newer wins
      { ideaId: "i2", ideaTitle: "Two", formulation: "c", createdAt: iso(30) },
    ],
    decisions: [],
    openLoops: [
      { ideaId: "i1", ideaTitle: "One", loopId: "l1", statement: "?", resolved: false },
      { ideaId: "i2", ideaTitle: "Two", loopId: "l2", statement: "?", resolved: true },
    ],
    contradictions: [],
    relatedIdeas: [],
  };

  test("dates each idea by its newest change and flags unresolved open loops", () => {
    const cands = candidatesFromState(state);
    expect(cands.map((c) => c.id).sort()).toEqual(["i1", "i2"]); // i3 has no activity -> not a candidate
    const i1 = cands.find((c) => c.id === "i1")!;
    expect(i1.hasOpenLoop).toBe(true);
    expect(Math.round((NOW.getTime() - i1.lastTouched.getTime()) / 86_400_000)).toBe(4);
    const i2 = cands.find((c) => c.id === "i2")!;
    expect(i2.hasOpenLoop).toBe(false); // its only loop is resolved
  });

  test("end to end: i1 qualifies, i2 is too old", () => {
    const out = pickResumeSuggestion(candidatesFromState(state), {}, NOW);
    expect(out?.ideaId).toBe("i1");
  });
});
