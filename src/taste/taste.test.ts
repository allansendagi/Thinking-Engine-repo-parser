import { describe, expect, test } from "bun:test";
import { ACCEPTANCE_WINDOW, buildTasteReport, MIN_LABELS_PER_CLASS, thoughtTaste, tierFor } from "./taste";
import type { TasteLabels } from "../mining/corrections";

// Two clusters in 2-D: "keeper-like" thoughts point along +x, "junk-like" along +y.
const vec = (kind: "k" | "j", jitter = 0) => (kind === "k" ? [1, jitter] : [jitter, 1]);
const labels = (pos: string[], neg: string[], history?: TasteLabels["history"]): TasteLabels => ({
  positives: new Set(pos),
  negatives: new Set(neg),
  keptIdeaIds: new Set(),
  keptThoughtIds: new Set(),
  history: history ?? [...pos.map(() => ({ verdict: "keep" as const, at: "2026-01-01" })), ...neg.map(() => ({ verdict: "not_idea" as const, at: "2026-01-02" }))],
  reviewed: { keeps: 0, notIdeas: 0 },
  taught: { keeps: 0, notIdeas: 0 },
});

describe("thoughtTaste", () => {
  const ids = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}${i}`);
  const vectors = new Map<string, number[]>();
  for (const id of ids("k", 8)) vectors.set(id, vec("k", Math.random() * 0.1));
  for (const id of ids("j", 8)) vectors.set(id, vec("j", Math.random() * 0.1));
  const pos = new Set(ids("k", 8)), neg = new Set(ids("j", 8));

  test("a thought that sits among kept ones scores high; among rejected ones, low", () => {
    vectors.set("newK", vec("k", 0.05));
    vectors.set("newJ", vec("j", 0.05));
    expect(thoughtTaste("newK", vectors, pos, neg)).toBe(1);
    expect(thoughtTaste("newJ", vectors, pos, neg)).toBe(0);
  });

  test("a labelled thought never votes for itself", () => {
    const only = new Map([["a", [1, 0]], ["b", [1, 0.01]]]);
    expect(thoughtTaste("a", only, new Set(["a"]), new Set(["b"]))).toBe(0); // only neighbour is b (rejected)
  });

  test("no vector, or nothing labelled to compare with, means no opinion", () => {
    expect(thoughtTaste("ghost", vectors, pos, neg)).toBeNull();
    expect(thoughtTaste("newK", new Map([["newK", [1, 0]]]), new Set(), new Set())).toBeNull();
  });
});

describe("tierFor", () => {
  test("boundaries: likely at 0.6+, unlikely at 0.2-, unsure between, suggested when there is no score", () => {
    expect(tierFor(null)).toBe("suggested");
    expect(tierFor(0.6)).toBe("likely");
    expect(tierFor(0.4)).toBe("unsure");
    expect(tierFor(0.2)).toBe("unlikely");
    expect(tierFor(0)).toBe("unlikely");
  });
});

describe("buildTasteReport", () => {
  const vectors = new Map<string, number[]>();
  const keptThoughts = Array.from({ length: MIN_LABELS_PER_CLASS }, (_, i) => `k${i}`);
  const junkThoughts = Array.from({ length: MIN_LABELS_PER_CLASS }, (_, i) => `j${i}`);
  keptThoughts.forEach((t) => vectors.set(t, vec("k", 0.02)));
  junkThoughts.forEach((t) => vectors.set(t, vec("j", 0.02)));
  vectors.set("ideaLikeKept", vec("k", 0.03));
  vectors.set("ideaLikeJunk", vec("j", 0.03));
  const ideas = [
    { id: "A", thoughtIds: ["ideaLikeKept"] },
    { id: "B", thoughtIds: ["ideaLikeJunk"] },
    { id: "C", thoughtIds: ["noVector"] },
  ];

  test("before there are enough labels of both kinds, nothing is guessed: everything is merely 'suggested'", () => {
    const r = buildTasteReport(ideas, labels(keptThoughts.slice(0, 3), junkThoughts.slice(0, 3)), vectors);
    expect(r.ready).toBe(false);
    expect(r.ideas.every((i) => i.tier === "suggested")).toBe(true);
  });

  test("once ready, ideas sort by what the person keeps -- and an idea with no vectors stays 'suggested'", () => {
    const r = buildTasteReport(ideas, labels(keptThoughts, junkThoughts), vectors);
    expect(r.ready).toBe(true);
    const tier = Object.fromEntries(r.ideas.map((i) => [i.ideaId, i.tier]));
    expect(tier).toEqual({ A: "likely", B: "unlikely", C: "suggested" });
  });

  test("an explicit Keep always wins over taste's guess", () => {
    const l = labels(keptThoughts, junkThoughts);
    l.keptIdeaIds.add("B");
    const r = buildTasteReport(ideas, l, vectors);
    expect(r.ideas.find((i) => i.ideaId === "B")?.tier).toBe("confirmed");
  });

  test("acceptance rate is the share of the LAST 20 verdicts that were Keep", () => {
    const history: TasteLabels["history"] = [
      ...Array.from({ length: 10 }, (_, i) => ({ verdict: "not_idea" as const, at: `2026-01-01T00:00:${String(i).padStart(2, "0")}` })),
      ...Array.from({ length: 20 }, (_, i) => ({ verdict: (i < 18 ? "keep" : "not_idea") as "keep" | "not_idea", at: `2026-02-01T00:00:${String(i).padStart(2, "0")}` })),
    ];
    const r = buildTasteReport([], labels([], [], history), vectors);
    expect(r.window).toBe(ACCEPTANCE_WINDOW);
    expect(r.acceptanceRate).toBeCloseTo(18 / 20); // the older rejections have scrolled out
    expect(buildTasteReport([], labels([], []), vectors).acceptanceRate).toBeNull();
  });
});
