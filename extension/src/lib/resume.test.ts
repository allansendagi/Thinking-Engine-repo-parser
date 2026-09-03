import { describe, expect, test } from "bun:test";
import { candidatesFromState, pickResumeSuggestion, type ResumeCandidate, type ResumeShown } from "./resume";
import type { ThinkingState } from "./api";

// Ported 1:1 from macos-app ResumeSuggestionTests.swift -- the two clients must apply the same rule.
const NOW = new Date(1_760_000_000 * 1000);
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const iso = (n: number) => daysAgo(n).toISOString();

function cand(
  id: string,
  {
    state = "developing",
    loop = true,
    contradiction = false,
    touchedDaysAgo,
  }: { state?: string; loop?: boolean; contradiction?: boolean; touchedDaysAgo: number },
): ResumeCandidate {
  return {
    id,
    title: id[0]!.toUpperCase() + id.slice(1),
    state,
    hasOpenLoop: loop,
    isContradiction: contradiction,
    lastTouched: daysAgo(touchedDaysAgo),
  };
}
const pick = (cs: ResumeCandidate[], snoozed = {}, history: Record<string, ResumeShown> = {}) =>
  pickResumeSuggestion(cs, snoozed, history, NOW);

describe("pickResumeSuggestion — scored, held to 'never wrong'", () => {
  test("fires for an open question in the sweet spot", () => {
    const out = pick([cand("a", { touchedDaysAgo: 7 })]);
    expect(out?.ideaId).toBe("a");
    expect(out?.daysAgo).toBe(7);
  });

  test("fires for a contradiction / contested idea", () => {
    expect(pick([cand("a", { loop: false, contradiction: true, touchedDaysAgo: 9 })])).not.toBeNull();
    expect(pick([cand("a", { state: "contested", loop: false, touchedDaysAgo: 9 })])).not.toBeNull();
  });

  test("too fresh stays silent", () => {
    expect(pick([cand("a", { touchedDaysAgo: 1 })])).toBeNull();
    expect(pick([cand("a", { touchedDaysAgo: 0.5 })])).toBeNull();
  });

  test("abandoned stays silent, incl. a month-old plain open question", () => {
    expect(pick([cand("a", { touchedDaysAgo: 55 })])).toBeNull();
    expect(pick([cand("a", { touchedDaysAgo: 32 })])).toBeNull();
  });

  test("a contradiction carries further than an open question", () => {
    expect(pick([cand("q", { touchedDaysAgo: 30 })])).toBeNull();
    expect(pick([cand("c", { contradiction: true, touchedDaysAgo: 30 })])).not.toBeNull();
  });

  test("nothing unfinished is never a candidate", () => {
    expect(pick([cand("a", { loop: false, touchedDaysAgo: 7 })])).toBeNull();
  });

  test("skips dormant and rejected", () => {
    expect(pick([cand("a", { state: "dormant", touchedDaysAgo: 7 })])).toBeNull();
    expect(pick([cand("a", { state: "rejected", touchedDaysAgo: 7 })])).toBeNull();
  });

  test("two near-identical candidates stay silent (ambiguity gate)", () => {
    expect(pick([cand("a", { touchedDaysAgo: 7 }), cand("b", { touchedDaysAgo: 8 })])).toBeNull();
  });

  test("a clearly more recent candidate still wins", () => {
    expect(pick([cand("a", { touchedDaysAgo: 7 }), cand("b", { touchedDaysAgo: 20 })])?.ideaId).toBe("a");
  });

  test("a stronger signal breaks a three-way tie", () => {
    const out = pick([
      cand("q1", { touchedDaysAgo: 7 }),
      cand("q2", { touchedDaysAgo: 8 }),
      cand("c", { contradiction: true, touchedDaysAgo: 9 }),
    ]);
    expect(out?.ideaId).toBe("c");
  });

  test("an open question stops being offered after a couple of unacted shows", () => {
    const c = cand("a", { touchedDaysAgo: 7 });
    const h = (count: number): Record<string, ResumeShown> => ({ a: { count, sinceActivity: iso(7) } });
    expect(pick([c], {}, h(0))).not.toBeNull();
    expect(pick([c], {}, h(1))).not.toBeNull();
    expect(pick([c], {}, h(2))).toBeNull();
  });

  test("fatigue resets when the idea moves again", () => {
    const c = cand("a", { touchedDaysAgo: 7 }); // last activity 7 days ago
    expect(pick([c], {}, { a: { count: 5, sinceActivity: iso(20) } })).not.toBeNull();
  });

  test("snooze suppresses until the idea is touched again", () => {
    const c = cand("a", { touchedDaysAgo: 7 });
    expect(pick([c], { a: iso(2) })).toBeNull();
    expect(pick([c], { a: iso(20) })).not.toBeNull();
  });

  test("nothing to suggest", () => {
    expect(pick([])).toBeNull();
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
      { ideaId: "i1", ideaTitle: "One", loopId: "l1", statement: "Unresolved contradiction: a vs b", resolved: false },
      { ideaId: "i2", ideaTitle: "Two", loopId: "l2", statement: "?", resolved: true },
    ],
    contradictions: [],
    relatedIdeas: [],
  };

  test("dates each idea by its newest change, flags open loops and contradictions", () => {
    const cands = candidatesFromState(state);
    expect(cands.map((c) => c.id).sort()).toEqual(["i1", "i2"]); // i3 has no activity
    const i1 = cands.find((c) => c.id === "i1")!;
    expect(i1.hasOpenLoop).toBe(true);
    expect(i1.isContradiction).toBe(true); // loop statement is a logged contradiction
    expect(Math.round((NOW.getTime() - i1.lastTouched.getTime()) / 86_400_000)).toBe(4);
    const i2 = cands.find((c) => c.id === "i2")!;
    expect(i2.hasOpenLoop).toBe(false); // its only loop is resolved
  });

  test("end to end: i1 (recent contradiction) qualifies, i2 (30-day resolved) does not", () => {
    expect(pickResumeSuggestion(candidatesFromState(state), {}, {}, NOW)?.ideaId).toBe("i1");
  });
});
