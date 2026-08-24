import { describe, expect, test } from "bun:test";
import { entityOverlap, lexicalOverlap, narrowCandidates, rankCandidates, temporalProximity } from "./signals";
import type { CanonicalEvent, CognitiveEvent, IdeaNode } from "../types";

function makeIdea(id: string, title: string, formulation: string, createdAt: string): IdeaNode {
  return {
    id,
    title,
    state: "developing",
    currentFormulation: formulation,
    evolution: [{ cognitiveEventId: `cog_${id}`, formulation, createdAt, sourceEventId: `src_${id}` }],
    openLoops: [],
    decisions: [],
    relatedIdeaIds: [],
    createdAt,
    updatedAt: createdAt,
  };
}

describe("lexicalOverlap", () => {
  test("scores shared significant words, ignores stopwords", () => {
    const score = lexicalOverlap(
      "Authority must be independently verifiable",
      "Boundaries need to be independently verifiable too",
    );
    expect(score).toBeGreaterThan(0);
    expect(lexicalOverlap("completely unrelated sentence", "totally different topic here")).toBe(0);
  });
});

describe("entityOverlap", () => {
  test("matches shared proper-noun-like tokens", () => {
    expect(entityOverlap("Working on NOMOS Protocol design", "NOMOS needs a governance layer")).toBeGreaterThan(0);
    expect(entityOverlap("no capitalized words here", "none here either")).toBe(0);
  });
});

describe("temporalProximity", () => {
  test("decays with distance and is 1.0 at zero distance", () => {
    const t = "2026-08-17T00:00:00.000Z";
    expect(temporalProximity(t, t)).toBe(1);
    const near = temporalProximity(t, "2026-08-19T00:00:00.000Z");
    const far = temporalProximity(t, "2026-09-17T00:00:00.000Z");
    expect(near).toBeGreaterThan(far);
  });
});

describe("rankCandidates / narrowCandidates", () => {
  test("a cross-topic vocabulary-overlap idea still survives narrowing among many distractors", async () => {
    // This is the specific case the pipeline depends on: the payments idea shares words
    // ("verification", "trust") with the authority idea, so the prefilter must NOT exclude it --
    // if it did, identity resolution would never even get the chance to correctly reject it.
    const authorityIdea = makeIdea(
      "idea_authority",
      "Computable Authority",
      "Institutional authority should be expressed in a form an AI can execute and verify.",
      "2026-08-17T00:00:00.000Z",
    );
    const distractors = Array.from({ length: 30 }, (_, i) =>
      makeIdea(`idea_distractor_${i}`, `Distractor ${i}`, `Some totally unrelated topic number ${i}.`, "2025-01-01T00:00:00.000Z"),
    );

    const event: CognitiveEvent = {
      id: "cog_c4",
      type: "refinement",
      statement:
        "Execution isn't enough. Authority also needs to be independently verifiable by a separate party.",
      confidence: 0.9,
      sourceEventId: "c4_u1",
      evidenceQuote: "independently verifiable",
      additionalSourceEventIds: [],
    };
    const sourceEvent: CanonicalEvent = {
      id: "c4_u1",
      conversationId: "conv_4",
      source: "fixture",
      role: "user",
      text: event.statement,
      createdAt: "2026-08-23T00:00:00.000Z",
      index: 0,
    };

    const ranked = await rankCandidates(event, sourceEvent, [authorityIdea, ...distractors]);
    const narrowed = narrowCandidates(ranked, { maxCandidates: 8 });

    expect(narrowed.map((c) => c.idea.id)).toContain("idea_authority");
    // Narrowing should actually narrow -- not just pass every idea through.
    expect(narrowed.length).toBeLessThan(distractors.length + 1);
  });
});
