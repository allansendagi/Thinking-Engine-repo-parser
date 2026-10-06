import { describe, expect, test } from "bun:test";
import { report, scoreScenario } from "./metrics";
import { generateScenario, standardSuite } from "./generate";
import type { MinedIdea, Scenario } from "./types";

const t = (messageId: string, idea: string, role: "position" | "question" | "answer" | "decision", loop?: string) => ({
  messageId, idea, role, loop, type: "claim" as const, statement: messageId, quote: messageId,
});

const scenario: Scenario = {
  name: "tiny", persona: "t", events: [],
  thoughts: [t("a1", "A", "position"), t("a2", "A", "question", "q"), t("a3", "A", "decision"), t("b1", "B", "position")],
  ideas: [
    { key: "A", title: "A", finalPositionMessageId: "a3", openLoops: ["q"], resolvedLoops: [], decisions: ["a3"], confusableWith: ["B"] },
    { key: "B", title: "B", finalPositionMessageId: "b1", openLoops: [], resolvedLoops: [], decisions: [], confusableWith: ["A"] },
  ],
  noiseMessageIds: ["n1"],
};
const idea = (id: string, msgs: string[], extra: Partial<MinedIdea> = {}): MinedIdea => ({
  id, title: id, messageIds: msgs, currentFormulation: "", openLoops: [], decisionMessageIds: [], state: "developing", ...extra,
});

describe("bench scoring", () => {
  test("a perfect miner scores perfectly", () => {
    const r = report(scoreScenario(scenario, {
      ideas: [
        idea("x", ["a1", "a2", "a3"], { currentFormulationMessageId: "a3", openLoops: [{ statement: "", resolved: false, messageId: "a2" }], decisionMessageIds: ["a3"] }),
        idea("y", ["b1"], { currentFormulationMessageId: "b1" }),
      ],
      sparkMessageIds: [],
    }));
    expect(r.groupingF1).toBe(1);
    expect(r.positionAccuracy).toBe(1);
    expect(r.openLoopRecall).toBe(1);
    expect(r.decisionRecall).toBe(1);
    expect(r.wrongMerges).toBe(0);
  });

  test("merging look-alike ideas is a critical merge; splitting one idea is a split", () => {
    const merged = report(scoreScenario(scenario, { ideas: [idea("x", ["a1", "a2", "a3", "b1"])], sparkMessageIds: [] }));
    expect(merged.criticalMerges).toBe(1);
    expect(merged.groupingPrecision).toBeLessThan(1);
    const split = report(scoreScenario(scenario, { ideas: [idea("x", ["a1"]), idea("y", ["a2", "a3"]), idea("z", ["b1"])], sparkMessageIds: [] }));
    expect(split.ideasSplitRate).toBe(0.5);
    expect(split.groupingRecall).toBeLessThan(1);
  });

  test("noise in an idea and missed thoughts are counted", () => {
    const r = report(scoreScenario(scenario, { ideas: [idea("x", ["a1", "n1"])], sparkMessageIds: ["b1"] }));
    expect(r.noiseRate).toBe(1);
    expect(r.thoughtRecall).toBe(0.5);
  });
});

describe("scenario generator", () => {
  test("is deterministic per seed and grounds every gold quote verbatim", () => {
    const a = generateScenario({ persona: "polymath", seed: 7 });
    const b = generateScenario({ persona: "polymath", seed: 7 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    for (const s of standardSuite()) {
      const byId = new Map(s.events.map((e) => [e.id, e]));
      for (const th of s.thoughts) {
        expect(byId.get(th.messageId)?.text).toContain(th.quote);
        if (th.adopted) expect(byId.get(th.adopted.assistantMessageId)?.text).toContain(th.adopted.quote);
      }
    }
  });

  test("beats of one idea are spread across several conversations", () => {
    const s = generateScenario({ persona: "founder", seed: 1 });
    const convsOf = (k: string) => new Set(s.thoughts.filter((t) => t.idea === k).map((t) => t.messageId.replace(/_m\d+$/, "")));
    expect(convsOf("pricing-model").size).toBeGreaterThan(1);
  });
});
