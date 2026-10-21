import { describe, expect, test } from "bun:test";
import { consolidate, wordSimilarity, type MiningThought } from "./consolidate";

let n = 0;
const th = (statement: string, type: MiningThought["type"], conv: string, position: number, day = 1, extra: Partial<MiningThought> = {}): MiningThought => ({
  id: `t${++n}`, type, statement, persistence: "high", sourceEventId: `m${n}`, conversationId: conv, position,
  createdAt: `2026-09-${String(day).padStart(2, "0")}T00:00:${String(n % 60).padStart(2, "0")}.000Z`, ...extra,
});

describe("v2 consolidation", () => {
  test("an option being weighed joins the idea but never becomes where it stands", () => {
    const idea = th("Charge per seat for team billing.", "new_idea", "c1", 0);
    const option = th("One option is billing per workspace for teams.", "claim", "c1", 1, 1, { role: "option" });
    const ideas = consolidate([idea, option]);
    expect(ideas).toHaveLength(1);
    expect(ideas[0]!.node.currentFormulation).toBe(idea.statement);
  });

  test("an adopted AI suggestion said once is an idea, not a spark", () => {
    const adopted = th("Ship the import before the redesign.", "claim", "c1", 2, 1, { adopted: true });
    expect(consolidate([adopted])[0]!.isSpark).toBe(false);
  });

  test("a question asked right after an idea attaches to it, even with no shared words", () => {
    const idea = th("We should charge per seat rather than a flat monthly fee.", "new_idea", "c1", 0);
    const q = th("Do guest collaborators count toward the bill?", "question", "c1", 2);
    const ideas = consolidate([idea, q]);
    expect(ideas).toHaveLength(1);
    expect(ideas[0]!.node.openLoops.map((l) => l.statement)).toEqual(["Do guest collaborators count toward the bill?"]);
    // the question did not become "where the idea stands"
    expect(ideas[0]!.node.currentFormulation).toBe(idea.statement);
  });

  test("meaning-vectors join a paraphrase from another conversation that shares no words", () => {
    const a = th("Charge per seat.", "new_idea", "c1", 0, 1);
    const b = th("The bill should grow with headcount.", "claim", "c2", 0, 9);
    const other = th("Publish the newsletter every second Tuesday.", "decision", "c3", 0, 5);
    const near = [1, 0.9, 0.1, 0];
    const vectors = new Map([[a.id, near], [b.id, [0.95, 1, 0.05, 0]], [other.id, [0, 0.1, 1, 0.9]]]);
    expect(consolidate([a, b, other]).length).toBe(3); // words alone can't tell
    const withMeaning = consolidate([a, b, other], { vectors });
    expect(withMeaning.find((i) => i.thoughtIds.includes(a.id))!.thoughtIds).toContain(b.id);
    expect(withMeaning.find((i) => i.thoughtIds.includes(other.id))!.thoughtIds).toEqual([other.id]);
  });

  test("an answer closes the question it answers, not every open question", () => {
    const idea = th("Annual billing per active member for teams.", "new_idea", "c1", 0);
    const q1 = th("Do guest collaborators count toward the billing?", "question", "c1", 1);
    const q2 = th("Should students get a discount on billing?", "question", "c1", 2);
    const a1 = th("Guest collaborators are free up to five, then billed.", "resolution", "c1", 3);
    const loops = consolidate([idea, q1, q2, a1])[0]!.node.openLoops;
    expect(loops.find((l) => l.statement === q1.statement)?.resolved).toBe(true);
    expect(loops.find((l) => l.statement === q2.statement)?.resolved).toBe(false);
  });

  test("rejecting an option never marks the whole idea rejected", () => {
    const idea = th("Price per seat for teams.", "new_idea", "c1", 0);
    const opt = th("Or price per workspace for teams.", "claim", "c1", 1);
    const rej = th("No to per-workspace pricing, it punishes small teams.", "rejection", "c1", 2);
    expect(consolidate([idea, opt, rej])[0]!.node.state).not.toBe("rejected");
  });

  test("a person's split (cannot-link) and merge (must-link) are respected", () => {
    const a = th("Verify a creator's identity before payout.", "new_idea", "c1", 0);
    const b = th("Verify institutional authority independently.", "claim", "c1", 1);
    expect(consolidate([a, b]).length).toBe(1); // close in one chat, overlapping words
    expect(consolidate([a, b], { constraints: { cannotLink: [[a.id, b.id]] } }).length).toBe(2);
    const c = th("Totally unrelated: move the offsite to May.", "decision", "c9", 0, 20);
    expect(consolidate([a, c], { constraints: { mustLink: [[a.id, c.id]] } }).length).toBe(1);
  });

  test("ideas keep the id the person already knows them by", () => {
    const a = th("Lead the paper with its conclusion.", "new_idea", "c1", 0);
    const b = th("Every section heading should be a claim, lead with conclusion.", "refinement", "c1", 1);
    const ideas = consolidate([a, b], { previousIdeaOf: new Map([[b.id, "idea_pinned_123"]]) });
    expect(ideas[0]!.node.id).toBe("idea_pinned_123");
  });

  test("a lone tentative thought is a spark; a firm new idea or a decision is an idea", () => {
    const spark = th("Maybe something with audio someday.", "claim", "c1", 0, 1, { persistence: "medium" });
    const firm = th("Build a podcast feature for summaries.", "new_idea", "c2", 0, 9);
    const ideas = consolidate([spark, firm]);
    expect(ideas.find((i) => i.thoughtIds.includes(spark.id))!.isSpark).toBe(true);
    expect(ideas.find((i) => i.thoughtIds.includes(firm.id))!.isSpark).toBe(false);
  });

  test("word similarity is length-fair and stem-aware", () => {
    expect(wordSimilarity("pricing", "We price per seat")).toBe(1);
    expect(wordSimilarity("Who verifies?", "banana bread recipe")).toBe(0);
  });

  test("order-independent: shuffling input gives the same grouping", () => {
    const ts = [
      th("Charge per seat for teams.", "new_idea", "c1", 0, 1),
      th("Seat pricing scales with teams.", "claim", "c2", 0, 4),
      th("Newsletter every second Tuesday.", "decision", "c3", 0, 2),
      th("Newsletter goes fortnightly.", "new_idea", "c3", 1, 2),
    ];
    const key = (ideas: ReturnType<typeof consolidate>) => ideas.map((i) => [...i.thoughtIds].sort().join(",")).sort().join(" | ");
    expect(key(consolidate([...ts].reverse()))).toBe(key(consolidate(ts)));
  });
});

describe("v2 consolidation at real-account scale", () => {
  test("1,500 thoughts with 512-d vectors consolidate in a few seconds", () => {
    const ts: MiningThought[] = [];
    const vectors = new Map<string, number[]>();
    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 1500; i++) {
      const topic = i % 60;
      const t = th(`topic ${topic} thought ${i} about subject${topic} detail${i % 7}`, i % 5 === 0 ? "question" : "claim", `c${Math.floor(i / 6)}`, i % 6, 1 + (i % 28));
      ts.push(t);
      vectors.set(t.id, Array.from({ length: 512 }, (_, d) => (d % 60 === topic ? 1 : 0) + rand() * 0.2));
    }
    const started = performance.now();
    const ideas = consolidate(ts, { vectors });
    const ms = performance.now() - started;
    expect(ideas.length).toBeGreaterThan(30);
    expect(ms).toBeLessThan(15_000);
  }, 30_000);
});

describe("v2 grouping signals", () => {
  test("two new ideas raised in one chat stay apart unless their words say otherwise", () => {
    const a = th("Add an AI reviewer that comments on pull requests.", "new_idea", "c1", 0);
    const b = th("Build a reusable security questionnaire kit.", "new_idea", "c1", 2);
    expect(consolidate([a, b]).length).toBe(2);
  });

  test("rare shared words count, common ones don't", () => {
    // "first" appears everywhere in this person's thinking; "SOC" only in the security thoughts.
    const filler = [1, 2, 3, 4, 5].map((i) => th(`First thing on item ${i} for the first time.`, "claim", `f${i}`, 0, i));
    const soc = th("We need SOC 2 for the first enterprise deal.", "new_idea", "s1", 0, 1);
    const soc2 = th("Is SOC 2 required before the first enterprise customer?", "question", "s2", 0, 9);
    const hire = th("Is the first engineer remote?", "question", "h1", 0, 9);
    const ideas = consolidate([...filler, soc, soc2, hire]);
    expect(ideas.find((i) => i.thoughtIds.includes(soc.id))!.thoughtIds).toContain(soc2.id);
    expect(ideas.find((i) => i.thoughtIds.includes(soc.id))!.thoughtIds).not.toContain(hire.id);
  });
});

describe("a person's merge holds whatever kind of thought it names", () => {
  test("two ideas joined by a must-link on their questions end up as one idea", () => {
    const t = (id: string, type: MiningThought["type"], statement: string, conv: string): MiningThought => ({
      id, type, statement, persistence: "high", sourceEventId: `m_${id}`, conversationId: conv, position: 0, createdAt: `2026-09-0${id.length}T00:00:00Z`,
    });
    const thoughts = [
      t("q1", "question", "How should we price the workshop?", "c1"),
      t("a1x", "new_idea", "Charge per seat for workshops.", "c1"),
      t("q2xx", "question", "Do onboarding emails need a tour?", "c2"),
      t("a2xxx", "new_idea", "Onboarding should show value in five minutes.", "c2"),
    ];
    const apart = consolidate(thoughts);
    expect(apart.find((i) => i.thoughtIds.includes("q1"))).not.toBe(apart.find((i) => i.thoughtIds.includes("q2xx")));
    const together = consolidate(thoughts, { constraints: { mustLink: [["q1", "q2xx"]] } });
    const home = together.find((i) => i.thoughtIds.includes("q1"))!;
    expect(home.thoughtIds).toContain("q2xx");
  });
});

describe("an answer that names its question", () => {
  const idea = () => th("We should charge per seat rather than a flat monthly fee.", "new_idea", "c1", 0);

  test("closes that question whatever type the answer was labelled", () => {
    const i = idea();
    const q = th("Do guest collaborators count toward the bill?", "question", "c1", 1);
    const answer = th("Five free guests per account, then they are billed like members.", "decision", "c1", 3, 1, { answersEventId: q.sourceEventId });
    const out = consolidate([i, q, answer]);
    expect(out).toHaveLength(1);
    expect(out[0]!.node.openLoops.map((l) => l.resolved)).toEqual([true]);
  });

  test("closes the question it names, not the one it merely resembles more", () => {
    const i = idea();
    const guests = th("Do guest collaborators count toward the bill?", "question", "c1", 1);
    const discount = th("Should we offer a yearly discount on the bill?", "question", "c1", 2);
    // Reads like the discount answer, but names the guests question.
    const answer = th("A yearly discount of two months free on the bill.", "resolution", "c1", 4, 1, { answersEventId: guests.sourceEventId });
    const loops = consolidate([i, guests, discount, answer])[0]!.node.openLoops;
    expect(loops.find((l) => l.statement.startsWith("Do guest"))!.resolved).toBe(true);
    expect(loops.find((l) => l.statement.startsWith("Should we offer"))!.resolved).toBe(false);
  });

  test("an answer to a question that is not here (the AI asked it, or it was never captured) closes nothing", () => {
    const i = idea();
    const q = th("Do guest collaborators count toward the bill?", "question", "c1", 1);
    const answer = th("Yes, guests count after the first five.", "resolution", "c1", 3, 1, { answersEventId: "an-ai-message" });
    const loops = consolidate([i, q, answer])[0]!.node.openLoops;
    expect(loops.map((l) => l.resolved)).toEqual([false]); // without the link it would have closed this one
  });

  test("an answer with no link behaves as before: a resolution closes the closest open question", () => {
    const i = idea();
    const q = th("Do guest collaborators count toward the bill?", "question", "c1", 1);
    const answer = th("Guests count after the first five.", "resolution", "c1", 3);
    expect(consolidate([i, q, answer])[0]!.node.openLoops.map((l) => l.resolved)).toEqual([true]);
  });

  test("an answer joins the idea that holds its question, not the one it sounds like", () => {
    const pricing = th("Charge per seat for team billing.", "new_idea", "c1", 0, 1);
    const onboarding = th("Show imported history on the very first screen.", "new_idea", "c2", 0, 2);
    const q = th("Can we pull history without waiting for the export email?", "question", "c2", 1, 2);
    // Sounds like pricing; names the onboarding question.
    const answer = th("Charge per seat for team billing: no, the extension reads it directly.", "resolution", "c3", 0, 9, { answersEventId: q.sourceEventId });
    const out = consolidate([pricing, onboarding, q, answer]);
    const home = out.find((o) => o.thoughtIds.includes(answer.id))!;
    expect(home.thoughtIds).toContain(q.id);
    expect(home.thoughtIds).not.toContain(pricing.id);
    expect(home.node.openLoops.map((l) => l.resolved)).toEqual([true]);
  });
});

