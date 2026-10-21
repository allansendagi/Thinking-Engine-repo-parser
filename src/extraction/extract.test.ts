import { describe, expect, test } from "bun:test";
import { FakeProvider } from "../providers/fake";
import type { CanonicalEvent } from "../types";
import { extractCognitiveEvents } from "./extract";
import { EXTRACTION_SYSTEM_PROMPT } from "./prompt";

const ev = (index: number, role: "user" | "assistant", text: string, conversationId = "c1"): CanonicalEvent => ({
  id: `${conversationId}_m${index}`,
  conversationId,
  source: "chatgpt",
  role,
  text,
  createdAt: `2026-09-01T00:0${index}:00.000Z`,
  index,
});

const convo: CanonicalEvent[] = [
  ev(0, "user", "How should we price this?"),
  ev(1, "assistant", "You could bill per active member, so price tracks real usage."),
  ev(2, "user", "Yes, let's do that -- per active member it is."),
  ev(3, "assistant", "Another idea: a flat fee for small teams."),
  ev(4, "user", "Unrelated: what's a good font for slides?"),
  ev(5, "user", "And go with annual plans only."),
];

const event = (over: Record<string, unknown>) => ({
  type: "decision",
  statement: "Bill per active member.",
  confidence: 0.9,
  source_event_id: "c1_m2",
  evidence_quote: "per active member it is",
  ...over,
});

async function run(...events: Record<string, unknown>[]) {
  return extractCognitiveEvents(convo, new FakeProvider([JSON.stringify({ events })]));
}

describe("adoption grounding", () => {
  test("accepts an AI proposal quoted verbatim from the message right before the acceptance", async () => {
    const out = await run(event({ adopted_from_event_id: "c1_m1", adopted_quote: "bill per active member" }));
    expect(out.rejected).toEqual([]);
    expect(out.events[0]!.adoptedFrom).toEqual({ sourceEventId: "c1_m1", quote: "bill per active member" });
  });

  test("rejects a quote the AI never said", async () => {
    const out = await run(event({ adopted_from_event_id: "c1_m1", adopted_quote: "charge per seat" }));
    expect(out.events).toEqual([]);
    expect(out.rejected[0]!.reason).toContain("verbatim");
  });

  test("rejects an AI message that isn't right before the acceptance", async () => {
    const out = await run(
      event({ source_event_id: "c1_m5", evidence_quote: "annual plans only", adopted_from_event_id: "c1_m1", adopted_quote: "bill per active member" }),
    );
    expect(out.events).toEqual([]);
    expect(out.rejected[0]!.reason).toContain("right before");
  });

  test("rejects pointing at the person's own message, or an AI message after it", async () => {
    const own = await run(event({ adopted_from_event_id: "c1_m0", adopted_quote: "price this" }));
    expect(own.rejected[0]!.reason).toContain("assistant message");
    const later = await run(event({ adopted_from_event_id: "c1_m3", adopted_quote: "a flat fee" }));
    expect(later.rejected[0]!.reason).toContain("right before");
  });

  test("roles are kept on claims only", async () => {
    const out = await run(
      event({ type: "claim", statement: "Per-member billing is one option.", role: "option" }),
      event({ type: "decision", role: "option" }),
    );
    expect(out.events.map((e) => e.role)).toEqual(["option", undefined]);
  });

  test("an odd field or one malformed event never sinks the capture", async () => {
    const out = await run(
      event({ type: "question", statement: "Do guests count?", evidence_quote: "per active member it is", role: "question" }),
      event({ title: "x".repeat(200), why_it_matters: "" }),
      { type: "claim" }, // missing everything -- dropped on its own
    );
    expect(out.events).toHaveLength(2);
    expect(out.events[0]!.role).toBeUndefined();
    expect(out.events[1]!.title).toBeUndefined();
  });
});

describe("narration and duplicate hygiene", () => {
  test("third-person narration is repaired from the person's own quoted words, capped at medium", async () => {
    const out = await run(
      event({
        statement: "The user decides to bill per active member.",
        persistence: "high",
        persistence_reason: "makes a decision",
      }),
    );
    expect(out.rejected).toEqual([]);
    expect(out.events[0]!.statement).toBe("per active member it is");
    expect(out.events[0]!.persistence).toBe("medium");
    expect(out.events[0]!.persistenceReason).toContain("repaired");
  });

  test("a legitimate sentence about other people is not touched", async () => {
    const out = await run(event({ statement: "They are overpaying for seats.", persistence: "high" }));
    expect(out.events[0]!.statement).toBe("They are overpaying for seats.");
    expect(out.events[0]!.persistence).toBe("high");
  });

  test("narration whose quote is too short to stand on its own is dropped", async () => {
    const out = await run(event({ statement: "The human is asking about pricing.", evidence_quote: "do that" }));
    expect(out.events).toEqual([]);
    expect(out.rejected[0]!.reason).toContain("third-person");
  });

  test("the same statement twice from one message becomes one event, ignoring case and punctuation", async () => {
    const out = await run(
      event({ statement: "Bill per active member." }),
      event({ statement: "bill per active member" }),
    );
    expect(out.events).toHaveLength(1);
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0]!.reason).toContain("duplicate");
  });

  test("the same statement from two different messages is left for identity resolution", async () => {
    const out = await run(
      event({ statement: "Annual plans only.", source_event_id: "c1_m2", evidence_quote: "per active member it is" }),
      event({ statement: "Annual plans only.", source_event_id: "c1_m5", evidence_quote: "annual plans only" }),
    );
    expect(out.events).toHaveLength(2);
  });
});

describe("answers_event_id", () => {
  // c1_m0 is the person's question; c1_m1 is the AI's; c1_m2 and c1_m5 are the person's later turns.
  const answer = (over: Record<string, unknown>) => event({ type: "resolution", statement: "Bill per active member.", answers_event_id: "c1_m0", ...over });

  test("keeps a link to the person's own earlier message", async () => {
    const out = await run(answer({}));
    expect(out.events[0]!.answersEventId).toBe("c1_m0");
  });

  test("whatever the answer was labelled, the link is kept", async () => {
    const out = await run(answer({ type: "decision" }));
    expect(out.events[0]!.type).toBe("decision");
    expect(out.events[0]!.answersEventId).toBe("c1_m0");
  });

  test("drops a link to the AI's message, a later message, itself, an invented id, or from a question -- the event itself stays", async () => {
    for (const bad of ["c1_m1", "c1_m5", "c1_m2", "c1_m99", "not-an-id"]) {
      const out = await run(answer({ answers_event_id: bad }));
      expect(out.events).toHaveLength(1);
      expect(out.events[0]!.answersEventId).toBeUndefined();
    }
    const q = await run(answer({ type: "question", statement: "How should we price this?", answers_event_id: "c1_m0", source_event_id: "c1_m2", evidence_quote: "per active member it is" }));
    expect(q.events[0]!.answersEventId).toBeUndefined();
  });

  test("absent or null is fine", async () => {
    expect((await run(event({}))).events[0]!.answersEventId).toBeUndefined();
    expect((await run(answer({ answers_event_id: null }))).events[0]!.answersEventId).toBeUndefined();
  });
});

describe("the extraction prompt asks for the link", () => {
  test("it names the field in the rule and in the reply shape, and says when to leave it out", () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("- ANSWERS.");
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('"answers_event_id": "... (answers only, optional)"');
    expect(EXTRACTION_SYSTEM_PROMPT).toMatch(/If the AI asked it, or you are not sure which question it answers, omit it/);
  });
});

