import { describe, expect, test } from "bun:test";
import { buildThinkingState } from "./thinkingState";
import type { CognitiveEvent, IdeaNode } from "../types";

const now = new Date().toISOString();
const longAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

function idea(overrides: Partial<IdeaNode> = {}): IdeaNode {
  return {
    id: "idea_1",
    title: "Computable Authority",
    state: "developing",
    currentFormulation: "Authority must be verifiable.",
    evolution: [
      { cognitiveEventId: "cog_1", formulation: "Authority needs boundaries.", createdAt: longAgo, sourceEventId: "src_1" },
      { cognitiveEventId: "cog_2", formulation: "Authority must be verifiable.", createdAt: now, sourceEventId: "src_2" },
    ],
    openLoops: [{ id: "loop_1", statement: "Who verifies it?", createdAt: now, resolved: false }],
    decisions: [{ id: "dec_1", statement: "Ship per-agent scoping.", decidedAt: now, sourceEventId: "src_3" }],
    relatedIdeaIds: ["idea_2"],
    createdAt: longAgo,
    updatedAt: now,
    ...overrides,
  };
}

function cognitiveEvents(): CognitiveEvent[] {
  return [
    { id: "cog_1", type: "new_idea", statement: "x", confidence: 0.9, sourceEventId: "src_1", evidenceQuote: "x", additionalSourceEventIds: [] },
    { id: "cog_2", type: "contradiction", statement: "y", confidence: 0.9, sourceEventId: "src_2", evidenceQuote: "y", additionalSourceEventIds: [] },
  ];
}

describe("buildThinkingState", () => {
  test("aggregates current ideas, decisions, open loops, and related ideas", () => {
    const related = idea({ id: "idea_2", title: "Related Idea", relatedIdeaIds: ["idea_1"], evolution: [], openLoops: [], decisions: [] });
    const state = buildThinkingState([idea(), related], cognitiveEvents());

    expect(state.currentIdeas.map((i) => i.id)).toEqual(["idea_1", "idea_2"]);
    expect(state.decisions).toHaveLength(1);
    expect(state.openLoops.filter((l) => !l.resolved)).toHaveLength(1);
  });

  test("classifies evolution steps whose source cognitive event was a contradiction", () => {
    const state = buildThinkingState([idea()], cognitiveEvents());
    expect(state.contradictions).toHaveLength(1);
    expect(state.contradictions[0]?.formulation).toBe("Authority must be verifiable.");
  });

  test("recentChanges respects the window and excludes the old step", () => {
    const state = buildThinkingState([idea()], cognitiveEvents(), { recentWindowDays: 30 });
    expect(state.recentChanges).toHaveLength(1);
    expect(state.recentChanges[0]?.formulation).toBe("Authority must be verifiable.");
  });

  test("topic filter narrows currentIdeas by title/formulation substring", () => {
    const other = idea({ id: "idea_2", title: "Unrelated", currentFormulation: "Nothing to do with it.", evolution: [], relatedIdeaIds: [] });
    const state = buildThinkingState([idea(), other], cognitiveEvents(), { topic: "authority" });
    expect(state.currentIdeas.map((i) => i.id)).toEqual(["idea_1"]);
  });

  test("relatedIdeas lists ideas outside the filtered set that are still linked", () => {
    const related = idea({ id: "idea_2", title: "Unrelated On Purpose", currentFormulation: "Nothing.", evolution: [], relatedIdeaIds: [] });
    const state = buildThinkingState([idea(), related], cognitiveEvents(), { topic: "authority" });
    expect(state.relatedIdeas.map((r) => r.id)).toEqual(["idea_2"]);
  });
});
