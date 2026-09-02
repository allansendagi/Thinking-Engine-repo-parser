import { describe, expect, test } from "bun:test";
import { runPipeline } from "./pipeline";
import { FakeProvider } from "../providers/fake";
import type { CanonicalEvent } from "../types";

function extractionResponse(events: object[]): string {
  return JSON.stringify({ events });
}

function identityResponse(matchedIdeaId: string | null, confidence = 0.9): string {
  return JSON.stringify({ matched_idea_id: matchedIdeaId, confidence, reasoning: "scripted", also_related_idea_id: null });
}

const conv1: CanonicalEvent[] = [
  {
    id: "u1",
    conversationId: "conv_1",
    source: "fixture",
    role: "user",
    text: "Authority needs explicit boundaries to mean anything.",
    createdAt: "2026-08-17T00:00:00.000Z",
    index: 0,
  },
  {
    id: "u2",
    conversationId: "conv_2",
    source: "fixture",
    role: "user",
    text: "Those authority boundaries need to be executable, not just written policy.",
    createdAt: "2026-08-19T00:00:00.000Z",
    index: 0,
  },
  {
    id: "u3",
    conversationId: "conv_3",
    source: "fixture",
    role: "user",
    text: "Decided: authority boundaries get enforced at the runtime layer, not just documented.",
    createdAt: "2026-08-21T00:00:00.000Z",
    index: 0,
  },
];

describe("runPipeline (FakeProvider, no API key)", () => {
  test("threads a new idea through a refinement and a decision end to end", async () => {
    // One extraction call per conversation (3 conversations -> 3 canned responses).
    const extraction = new FakeProvider([
      extractionResponse([
        {
          type: "new_idea",
          statement: "Authority needs explicit boundaries.",
          confidence: 0.95,
          source_event_id: "u1",
          evidence_quote: "explicit boundaries",
        },
      ]),
      extractionResponse([
        {
          type: "refinement",
          statement: "Authority boundaries need to be executable.",
          confidence: 0.9,
          source_event_id: "u2",
          evidence_quote: "executable",
        },
      ]),
      extractionResponse([
        {
          type: "decision",
          statement: "Authority boundaries get enforced at the runtime layer.",
          confidence: 0.9,
          source_event_id: "u3",
          evidence_quote: "enforced at the runtime layer",
        },
      ]),
    ]);

    // Identity resolution is only called when there's at least one candidate: skipped for the
    // very first event (no ideas exist yet), called for the refinement and the decision.
    const reasoning = new FakeProvider([
      identityResponse("idea_cog_u1_0"), // for the refinement -- must match the deterministic id
      identityResponse("idea_cog_u1_0"), // for the decision
    ]);

    const result = await runPipeline(conv1, { extraction, reasoning });

    expect(result.ideas.size).toBe(1);
    const idea = [...result.ideas.values()][0];
    expect(idea?.evolution).toHaveLength(3);
    expect(idea?.state).toBe("established");
    expect(idea?.decisions).toHaveLength(1);
    expect(idea?.currentFormulation).toBe("Authority boundaries get enforced at the runtime layer.");
    expect(result.rejectedExtractions).toHaveLength(0);
  });

  test("a genuinely unrelated event creates a new idea without consuming a reasoning call", async () => {
    const events: CanonicalEvent[] = [
      { ...conv1[0]!, id: "u1" },
      {
        id: "u2",
        conversationId: "conv_2",
        source: "fixture",
        role: "user",
        text: "For payments reconciliation we need to check the ledger against the bank feed nightly.",
        // Deliberately far in time from u1 as well as unrelated in wording -- both the lexical
        // and temporal signals should land near zero, keeping the candidate list empty.
        createdAt: "2027-02-17T00:00:00.000Z",
        index: 0,
      },
    ];

    const extraction = new FakeProvider([
      extractionResponse([
        { type: "new_idea", statement: "Authority needs explicit boundaries.", confidence: 0.95, source_event_id: "u1", evidence_quote: "explicit boundaries" },
      ]),
      extractionResponse([
        {
          type: "new_idea",
          statement: "Payments reconciliation needs a nightly ledger check.",
          confidence: 0.9,
          source_event_id: "u2",
          evidence_quote: "ledger against the bank feed",
        },
      ]),
    ]);

    // No responses scripted at all: if the pipeline tried to call the reasoning provider here,
    // FakeProvider throws (out of scripted responses) and the test fails loudly.
    const reasoning = new FakeProvider([]);

    const result = await runPipeline(events, { extraction, reasoning });
    expect(result.ideas.size).toBe(2);
  });

  test("the signal gate discards a low-persistence event: no idea, no reasoning call, kept in discardedEvents", async () => {
    const extraction = new FakeProvider([
      extractionResponse([
        {
          type: "claim",
          statement: "A throwaway aside, not worth remembering.",
          confidence: 0.92,
          persistence: "low",
          persistence_reason: "vague gesture, no specific claim",
          source_event_id: "u1",
          evidence_quote: "explicit boundaries",
        },
      ]),
    ]);
    const reasoning = new FakeProvider([]); // gate must reject before identity resolution

    const result = await runPipeline([conv1[0]!], { extraction, reasoning });
    expect(result.ideas.size).toBe(0);
    expect(result.cognitiveEvents).toHaveLength(0);
    expect(result.discardedEvents).toHaveLength(1);
    expect(result.discardedEvents[0]?.gateReason).toContain("persistence=low");
    expect(result.discardedEvents[0]?.gateVersion).toBe(1);
  });

  test("a medium-persistence claim is kept only when it extends an existing idea", async () => {
    const events: CanonicalEvent[] = [
      { id: "u1", conversationId: "c1", source: "fixture", role: "user", text: "Authority boundaries must be explicit and enforced.", createdAt: "2026-08-17T00:00:00.000Z", index: 0 },
      { id: "u2", conversationId: "c2", source: "fixture", role: "user", text: "Those authority boundaries should be enforced at runtime, not just written down.", createdAt: "2026-08-18T00:00:00.000Z", index: 0 },
      { id: "u3", conversationId: "c3", source: "fixture", role: "user", text: "Unrelatedly, the office coffee machine is broken again.", createdAt: "2027-06-01T00:00:00.000Z", index: 0 },
    ];
    const extraction = new FakeProvider([
      extractionResponse([{ type: "new_idea", statement: "Authority boundaries must be explicit and enforced.", confidence: 0.95, persistence: "high", source_event_id: "u1", evidence_quote: "Authority boundaries" }]),
      extractionResponse([{ type: "claim", statement: "Authority boundaries should be enforced at runtime.", confidence: 0.9, persistence: "medium", source_event_id: "u2", evidence_quote: "enforced at runtime" }]),
      extractionResponse([{ type: "claim", statement: "The office coffee machine is broken.", confidence: 0.9, persistence: "medium", source_event_id: "u3", evidence_quote: "coffee machine is broken" }]),
    ]);
    // Only the kept medium claim (u2) reaches identity resolution.
    const reasoning = new FakeProvider([identityResponse("idea_cog_u1_0")]);

    const result = await runPipeline(events, { extraction, reasoning });
    expect(result.cognitiveEvents.map((e) => e.sourceEventId).sort()).toEqual(["u1", "u2"]);
    expect(result.discardedEvents.map((d) => d.event.sourceEventId)).toEqual(["u3"]);
    expect(result.ideas.size).toBe(1);
  });

  // A strong retrieval score clears the phase-2 gate, but the idea model is the real authority on
  // "same idea". These two cases must NOT produce a new standalone idea.
  for (const [name, identity] of [
    ["identity returns no match", identityResponse(null)],
    ["identity confidence is below the merge threshold", identityResponse("idea_cog_u1_0", 0.6)],
  ] as const) {
    test(`a medium leaky event with a strong candidate is discarded when ${name}`, async () => {
      const events: CanonicalEvent[] = [
        { id: "u1", conversationId: "c1", source: "fixture", role: "user", text: "Authority boundaries must be explicit and enforced.", createdAt: "2026-08-17T00:00:00.000Z", index: 0 },
        { id: "u2", conversationId: "c2", source: "fixture", role: "user", text: "Those authority boundaries should be enforced at runtime, not just written down.", createdAt: "2026-08-18T00:00:00.000Z", index: 0 },
      ];
      const extraction = new FakeProvider([
        extractionResponse([{ type: "new_idea", statement: "Authority boundaries must be explicit and enforced.", confidence: 0.95, persistence: "high", source_event_id: "u1", evidence_quote: "Authority boundaries" }]),
        extractionResponse([{ type: "claim", statement: "Authority boundaries should be enforced at runtime.", confidence: 0.9, persistence: "medium", source_event_id: "u2", evidence_quote: "enforced at runtime" }]),
      ]);
      // u2 clears retrieval (strong lexical overlap) so identity IS consulted -- and says no.
      const reasoning = new FakeProvider([identity]);

      const result = await runPipeline(events, { extraction, reasoning });

      expect(result.ideas.size).toBe(1); // NOT a second thin thread
      expect(result.cognitiveEvents.map((e) => e.sourceEventId)).toEqual(["u1"]);
      const d = result.discardedEvents.find((x) => x.event.sourceEventId === "u2");
      expect(d).toBeDefined();
      expect(d!.gateReason).toContain("identity gave");
      // still replayable: the reason keeps the needs-match marker
      expect(d!.gateReason).toContain("persist only if it extends an existing idea");
    });
  }

  test("evidence quotes that don't verbatim-match their source are rejected, not silently kept", async () => {
    const extraction = new FakeProvider([
      extractionResponse([
        {
          type: "new_idea",
          statement: "Something the model claims but did not actually say.",
          confidence: 0.9,
          source_event_id: "u1",
          evidence_quote: "words that are not in the source text at all",
        },
      ]),
    ]);
    const reasoning = new FakeProvider([]);

    const result = await runPipeline([conv1[0]!], { extraction, reasoning });
    expect(result.ideas.size).toBe(0);
    expect(result.rejectedExtractions).toHaveLength(1);
    expect(result.rejectedExtractions[0]?.reason).toContain("evidence_quote not found");
  });

  test("an event attributed to a message that was never sent at all is rejected, not silently kept", async () => {
    // Reproduces a real failure observed live: given a single short message, the extraction
    // model sometimes fabricates additional conversation turns wholesale (invented ids,
    // invented statements) and extracts events from its own fabrication. The grounding check
    // must catch this even though there's no real message for evidence_quote to be "wrong"
    // against -- the source_event_id itself doesn't exist.
    const extraction = new FakeProvider([
      extractionResponse([
        {
          type: "decision",
          statement: "A decision from a conversation turn that was never actually sent.",
          confidence: 0.95,
          source_event_id: "u1_fabricated_turn_that_does_not_exist",
          evidence_quote: "Okay, let's go with that.",
        },
      ]),
    ]);
    const reasoning = new FakeProvider([]);

    const result = await runPipeline([conv1[0]!], { extraction, reasoning });
    expect(result.ideas.size).toBe(0);
    expect(result.rejectedExtractions).toHaveLength(1);
    expect(result.rejectedExtractions[0]?.reason).toContain("does not exist in this conversation");
  });
});
