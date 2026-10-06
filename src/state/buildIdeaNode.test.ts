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
    persistence: "high",
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

  test("lexical backstop: a near word-for-word twin merges even with no confident identity match", () => {
    const ideas = new Map<string, IdeaNode>();
    applyCognitiveEvent(
      ideas,
      makeEvent({ statement: "Institutional authority must be independently verifiable and machine-executable." }),
      { cognitiveEventId: "cog_1", matchedIdeaId: null, confidence: 1, reasoning: "seed" },
      T,
    );
    applyCognitiveEvent(
      ideas,
      makeEvent({
        id: "cog_2",
        sourceEventId: "src_2",
        statement: "Institutional authority must be independently verifiable and machine executable.",
      }),
      { cognitiveEventId: "cog_2", matchedIdeaId: null, confidence: 1, reasoning: "no match" },
      "2026-08-20T00:00:00.000Z",
    );
    expect(ideas.size).toBe(1);
    expect([...ideas.values()][0]!.evolution).toHaveLength(2);
  });

  test("lexical backstop does NOT fire for merely related statements", () => {
    const ideas = new Map<string, IdeaNode>();
    applyCognitiveEvent(
      ideas,
      makeEvent({ statement: "Authority needs explicit boundaries." }),
      { cognitiveEventId: "cog_1", matchedIdeaId: null, confidence: 1, reasoning: "seed" },
      T,
    );
    applyCognitiveEvent(
      ideas,
      makeEvent({
        id: "cog_2",
        sourceEventId: "src_2",
        statement: "Verification should be performed by an independent third party.",
      }),
      { cognitiveEventId: "cog_2", matchedIdeaId: null, confidence: 1, reasoning: "no match" },
      T,
    );
    expect(ideas.size).toBe(2);
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

  test("a contradiction on an existing idea contests it and files the tension as an open loop", () => {
    const ideas = new Map<string, IdeaNode>();
    applyCognitiveEvent(ideas, makeEvent(), { cognitiveEventId: "cog_1", matchedIdeaId: null, confidence: 1, reasoning: "seed" }, T);
    const existingId = [...ideas.keys()][0] as string;

    applyCognitiveEvent(
      ideas,
      makeEvent({
        id: "cog_2",
        sourceEventId: "src_2",
        type: "contradiction",
        statement: "Actually, explicit boundaries make authority brittle under multiple obligations.",
      }),
      { cognitiveEventId: "cog_2", matchedIdeaId: existingId, confidence: 0.95, reasoning: "conflicts with the boundaries claim" },
      "2026-08-20T00:00:00.000Z",
    );

    const idea = ideas.get(existingId) as IdeaNode;
    expect(idea.state).toBe("contested");
    expect(idea.openLoops).toHaveLength(1);
    expect(idea.openLoops[0]?.resolved).toBe(false);
    expect(idea.openLoops[0]?.statement).toContain("Unresolved contradiction");

    // A later resolution settles it and returns the idea to developing.
    applyCognitiveEvent(
      ideas,
      makeEvent({ id: "cog_3", sourceEventId: "src_3", type: "resolution", statement: "Resolved: obligations accumulate, they don't compete." }),
      { cognitiveEventId: "cog_3", matchedIdeaId: existingId, confidence: 0.95, reasoning: "resolves the contradiction" },
      "2026-08-22T00:00:00.000Z",
    );
    expect((ideas.get(existingId) as IdeaNode).state).toBe("developing");
    expect((ideas.get(existingId) as IdeaNode).openLoops.every((l) => l.resolved)).toBe(true);
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

describe("what a matched event does to the idea", () => {
  const seed = (ideas: Map<string, IdeaNode>) => {
    applyCognitiveEvent(ideas, makeEvent(), { cognitiveEventId: "cog_1", matchedIdeaId: null, confidence: 1, reasoning: "seed" }, T);
    return [...ideas.keys()][0] as string;
  };
  const match = (id: string, cog: string) => ({ cognitiveEventId: cog, matchedIdeaId: id, confidence: 0.95, reasoning: "same idea" });

  test("a question about the idea is recorded, but doesn't replace what the idea currently says", () => {
    const ideas = new Map<string, IdeaNode>();
    const id = seed(ideas);
    const before = (ideas.get(id) as IdeaNode).currentFormulation;
    applyCognitiveEvent(ideas, makeEvent({ id: "cog_q", sourceEventId: "src_q", type: "question", statement: "Who verifies the boundaries?" }), match(id, "cog_q"), T);
    const idea = ideas.get(id) as IdeaNode;
    expect(idea.currentFormulation).toBe(before);
    expect(idea.evolution).toHaveLength(2);
    expect(idea.openLoops.map((l) => l.statement)).toEqual(["Who verifies the boundaries?"]);
  });

  test("a resolution closes the question it answers, not every open question", () => {
    const ideas = new Map<string, IdeaNode>();
    const id = seed(ideas);
    applyCognitiveEvent(ideas, makeEvent({ id: "cog_q1", sourceEventId: "s1", type: "question", statement: "Who verifies the boundaries?" }), match(id, "cog_q1"), "2026-08-19T00:00:00.000Z");
    applyCognitiveEvent(ideas, makeEvent({ id: "cog_q2", sourceEventId: "s2", type: "open_loop", statement: "How do we price enforcement?" }), match(id, "cog_q2"), "2026-08-20T00:00:00.000Z");
    applyCognitiveEvent(ideas, makeEvent({ id: "cog_r", sourceEventId: "s3", type: "resolution", statement: "An independent auditor verifies the boundaries." }), match(id, "cog_r"), "2026-08-21T00:00:00.000Z");
    const loops = (ideas.get(id) as IdeaNode).openLoops;
    expect(loops.find((l) => l.statement.startsWith("Who verifies"))?.resolved).toBe(true);
    expect(loops.find((l) => l.statement.startsWith("How do we price"))?.resolved).toBe(false);
  });
});
