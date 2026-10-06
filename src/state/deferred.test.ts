import { describe, expect, test } from "bun:test";
import { openDb } from "../db/client";
import { loadCanonicalEvents, loadIdeas } from "../db/queries";
import { ingestConversation } from "../api/ingest";
import { importIntoDb } from "../import/run";
import { FakeProvider } from "../providers/fake";
import type { CompletionProvider } from "../providers/types";
import { deferredStatus, retryDeferredExtraction } from "./deferred";

/** An AI provider that's down the way an unpaid account is: every call refused. */
const unpaid: CompletionProvider = {
  async complete() {
    throw Object.assign(new Error("Your credit balance is too low to access the Anthropic API."), { status: 400 });
  },
};

const extraction = (sourceId: string, statement: string, quote: string) =>
  JSON.stringify({
    events: [{ type: "new_idea", statement, title: statement.split(" ").slice(0, 3).join(" "), confidence: 0.9, persistence: "high", source_event_id: sourceId, evidence_quote: quote }],
  });
const newIdea = JSON.stringify({ matched_idea_id: null, confidence: 0.2, reasoning: "unrelated", also_related_idea_id: null });

const capture = (conversationId: string, id: string, text: string) => ({
  conversationId,
  source: "claude" as const,
  messages: [{ id, role: "user" as const, text, createdAt: "2026-10-06T09:00:00.000Z" }],
});

describe("captures survive an unavailable AI", () => {
  test("the conversation is stored, the reason recorded, and nothing throws", async () => {
    const db = openDb(":memory:");
    const r = await ingestConversation(db, capture("c1", "m1", "We should charge per seat, not a flat fee."), {
      extraction: unpaid,
      reasoning: unpaid,
    });
    expect(r.newCanonicalEvents).toBe(1);
    expect(r.extractionPending).toBe(1);
    expect(r.extractionError).toContain("credit balance is too low");
    expect(loadCanonicalEvents(db).map((e) => e.id)).toEqual(["m1"]);
    expect(deferredStatus(db)).toMatchObject({ count: 1 });
  });

  test("once the AI is back, waiting captures become ideas -- oldest first, nothing re-sent", async () => {
    const db = openDb(":memory:");
    await ingestConversation(db, capture("c1", "m1", "We should charge per seat, not a flat fee."), { extraction: unpaid, reasoning: unpaid });
    // The client re-sending the same message changes nothing (already stored, still waiting).
    const again = await ingestConversation(db, capture("c1", "m1", "We should charge per seat, not a flat fee."), { extraction: unpaid, reasoning: unpaid });
    expect(again.newCanonicalEvents).toBe(0);
    expect(deferredStatus(db).count).toBe(1);

    const r = await retryDeferredExtraction(db, {
      extraction: new FakeProvider([extraction("m1", "Charge per seat rather than a flat fee.", "charge per seat")]),
      reasoning: new FakeProvider([newIdea]),
    });
    expect(r).toEqual({ processed: 1, error: null });
    expect(deferredStatus(db).count).toBe(0);
    expect(loadIdeas(db)).toHaveLength(1);
  });

  test("a new capture first clears the backlog, so ideas build in the order thinking happened", async () => {
    const db = openDb(":memory:");
    await ingestConversation(db, capture("c1", "m1", "We should charge per seat, not a flat fee."), { extraction: unpaid, reasoning: unpaid });
    const r = await ingestConversation(db, capture("c2", "m2", "Annual plans only for teams."), {
      extraction: new FakeProvider([
        extraction("m1", "Charge per seat rather than a flat fee.", "charge per seat"),
        extraction("m2", "Annual plans only for teams.", "Annual plans only"),
      ]),
      reasoning: new FakeProvider([newIdea, newIdea, newIdea]),
    });
    expect(r.extractionError ?? null).toBeNull();
    expect(r.extractionPending ?? 0).toBe(0);
    expect(deferredStatus(db).count).toBe(0);
    expect(loadIdeas(db)).toHaveLength(2);
  });

  test("history import is stored even when the AI is down", async () => {
    const db = openDb(":memory:");
    const events = [
      { id: "h1", conversationId: "imp1", source: "chatgpt" as const, role: "user" as const, text: "Let's make the newsletter biweekly.", createdAt: "2026-09-01T10:00:00.000Z", index: 0 },
    ];
    const s = await importIntoDb(db, events, { extraction: unpaid, reasoning: unpaid });
    expect(s.newCanonicalEvents).toBe(1);
    expect(s.extractionPending).toBe(1);
    expect(loadCanonicalEvents(db)).toHaveLength(1);
  });
});
