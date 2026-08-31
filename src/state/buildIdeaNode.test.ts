import { describe, expect, test } from "bun:test";
import { applyCognitiveEvent } from "./buildIdeaNode";
import { IDENTITY_RESOLUTION_MERGE_THRESHOLD } from "../types";
import type { CognitiveEvent, IdeaNode, IdentityResolution } from "../types";

const T = "2026-08-17T00:00:00.000Z";

function makeEvent(overrides: Partial<CognitiveEvent> = {}): CognitiveEvent {
  return {
    id: "cog_1",
    type: "new_idea",
    statement: "Authority needs explicit boundaries.",
    confidence: 0.9,
    sourceEventId: "src_1",
    evidenceQuote: "explicit boundaries",
    additionalSourceEventIds: [],
    ...overrides,
  };
}

describe("applyCognitiveEvent", () => {
  test("creates a new idea when there is no match", () => {
    const ideas = new Map<string, IdeaNode>();
    const resolution: IdentityResolution = {
      cognitiveEventId: "cog_1",
      matchedIdeaId: null,
      confidence: 1,
      reasoning: "no candidates",
    };
    const idea = applyCognitiveEvent(ideas, makeEvent(), resolution, T);
    expect(ideas.size).toBe(1);
    expect(idea.evolution).toHaveLength(1);
    expect(idea.state).toBe("developing");
    expect(idea.createdAt).toBe(T); // uses the conversation's time, not wall-clock
  });

  test("never merges below the threshold, even with a matchedIdeaId set", () => {
    const ideas = new Map<string, IdeaNode>();
    applyCognitiveEvent(
      ideas,
      makeEvent(),
      { cognitiveEventId: "cog_1", matchedIdeaId: null, confidence: 1, reasoning: "seed" },
      T,
    );
    const existingId = [...ideas.keys()][0] as string;

    const belowThreshold = IDENTITY_RESOLUTION_MERGE_THRESHOLD - 0.01;
    applyCognitiveEvent(
      ideas,
      makeEvent({ id: "cog_2", sourceEventId: "src_2", statement: "Maybe related, maybe not." }),
      { cognitiveEventId: "cog_2", matchedIdeaId: existingId, confidence: belowThreshold, reasoning: "uncertain" },
      T,
    );

    expect(ideas.size).toBe(2); // stayed a duplicate, did not merge
  });

  test("merges at or above the threshold and appends an evolution step", () => {
    const ideas = new Map<string, IdeaNode>();
    applyCognitiveEvent(
      ideas,
      makeEvent(),
      { cognitiveEventId: "cog_1", matchedIdeaId: null, confidence: 1, reasoning: "seed" },
      T,
    );
    const existingId = [...ideas.keys()][0] as string;

    applyCognitiveEvent(
      ideas,
      makeEvent({ id: "cog_2", sourceEventId: "src_2", type: "refinement", statement: "Boundaries need to be executable." }),
      { cognitiveEventId: "cog_2", matchedIdeaId: existingId, confidence: IDENTITY_RESOLUTION_MERGE_THRESHOLD, reasoning: "clear refinement" },
      "2026-08-19T00:00:00.000Z",
    );

    expect(ideas.size).toBe(1);
    const idea = ideas.get(existingId as string) as IdeaNode;
    expect(idea.evolution).toHaveLength(2);
    expect(idea.currentFormulation).toBe("Boundaries need to be executable.");
    expect(idea.updatedAt).toBe("2026-08-19T00:00:00.000Z");
  });

  test("decision events flip state to established and record a Decision", () => {
    const ideas = new Map<string, IdeaNode>();
    applyCognitiveEvent(ideas, makeEvent(), { cognitiveEventId: "cog_1", matchedIdeaId: null, confidence: 1, reasoning: "seed" }, T);
    const existingId = [...ideas.keys()][0] as string;

    applyCognitiveEvent(
      ideas,
      makeEvent({ id: "cog_2", sourceEventId: "src_2", type: "decision", statement: "Going with per-agent scoping." }),
      { cognitiveEventId: "cog_2", matchedIdeaId: existingId, confidence: 0.99, reasoning: "clear decision" },
      T,
    );

    const idea = ideas.get(existingId as string) as IdeaNode;
    expect(idea.state).toBe("established");
    expect(idea.decisions).toHaveLength(1);
    expect(idea.decisions[0]?.statement).toBe("Going with per-agent scoping.");
  });

  test("connection events link two ideas symmetrically without merging them", () => {
    const ideas = new Map<string, IdeaNode>();
    applyCognitiveEvent(ideas, makeEvent({ id: "cog_a" }), { cognitiveEventId: "cog_a", matchedIdeaId: null, confidence: 1, reasoning: "seed a" }, T);
    applyCognitiveEvent(
      ideas,
      makeEvent({ id: "cog_b", sourceEventId: "src_b", statement: "A totally separate idea." }),
      { cognitiveEventId: "cog_b", matchedIdeaId: null, confidence: 1, reasoning: "seed b" },
      T,
    );
    const [ideaAId, ideaBId] = [...ideas.keys()];

    applyCognitiveEvent(
      ideas,
      makeEvent({ id: "cog_c", sourceEventId: "src_c", type: "connection", statement: "These two connect." }),
      {
        cognitiveEventId: "cog_c",
        matchedIdeaId: ideaAId as string,
        confidence: 0.9,
        reasoning: "connects a and b",
        alsoRelatedIdeaId: ideaBId,
      },
      T,
    );

    expect(ideas.size).toBe(2); // still two distinct ideas, not merged
    expect(ideas.get(ideaAId as string)?.relatedIdeaIds).toContain(ideaBId);
    expect(ideas.get(ideaBId as string)?.relatedIdeaIds).toContain(ideaAId);
  });
});
