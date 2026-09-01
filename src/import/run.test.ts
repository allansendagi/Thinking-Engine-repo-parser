import { describe, expect, test } from "bun:test";
import { openDb } from "../db/client";
import { loadIdeas } from "../db/queries";
import { importIntoDb, parseExportFile } from "./run";
import { FakeProvider } from "../providers/fake";

describe("parseExportFile", () => {
  test("dispatches to the correct parser by format", () => {
    const chatgptRaw = [
      {
        id: "conv1",
        current_node: "n1",
        mapping: {
          n1: { id: "n1", parent: null, children: [], message: { id: "n1", author: { role: "user" }, content: { content_type: "text", parts: ["hi"] }, create_time: 1 } },
        },
      },
    ];
    expect(parseExportFile("chatgpt", chatgptRaw)).toHaveLength(1);

    const claudeRaw = [{ uuid: "conv1", chat_messages: [{ uuid: "m1", sender: "human", text: "hi" }] }];
    expect(parseExportFile("claude", claudeRaw)).toHaveLength(1);
  });
});

describe("importIntoDb", () => {
  test("re-importing the same file is a no-op the second time", async () => {
    const db = openDb(":memory:");
    const events = [
      { id: "u1", conversationId: "c1", source: "fixture" as const, role: "user" as const, text: "Authority needs explicit boundaries.", createdAt: "2026-08-17T00:00:00.000Z", index: 0 },
    ];
    const providers = {
      extraction: new FakeProvider([
        JSON.stringify({ events: [{ type: "new_idea", statement: "Authority needs explicit boundaries.", confidence: 0.9, source_event_id: "u1", evidence_quote: "explicit boundaries" }] }),
      ]),
      reasoning: new FakeProvider([]),
    };

    const first = await importIntoDb(db, events, providers);
    expect(first.newCanonicalEvents).toBe(1);
    expect(first.ideaCount).toBe(1);

    const second = await importIntoDb(db, events, providers); // providers have nothing left scripted
    expect(second.newCanonicalEvents).toBe(0);
    expect(loadIdeas(db)).toHaveLength(1);
  });

  test("an export with an overlapping conversation only re-processes the new messages", async () => {
    const db = openDb(":memory:");
    const firstBatch = [
      { id: "u1", conversationId: "c1", source: "fixture" as const, role: "user" as const, text: "Authority needs explicit boundaries.", createdAt: "2026-08-17T00:00:00.000Z", index: 0 },
    ];
    await importIntoDb(db, firstBatch, {
      extraction: new FakeProvider([
        JSON.stringify({ events: [{ type: "new_idea", statement: "Authority needs explicit boundaries.", confidence: 0.9, source_event_id: "u1", evidence_quote: "explicit boundaries" }] }),
      ]),
      reasoning: new FakeProvider([]),
    });
    const ideaId = loadIdeas(db)[0]?.id as string;

    // A "newer export" containing the same u1 plus a genuinely new u2 in the same conversation.
    const secondBatch = [
      ...firstBatch,
      { id: "u2", conversationId: "c1", source: "fixture" as const, role: "user" as const, text: "Boundaries need to be executable.", createdAt: "2026-08-19T00:00:00.000Z", index: 1 },
    ];
    const second = await importIntoDb(db, secondBatch, {
      extraction: new FakeProvider([
        JSON.stringify({ events: [{ type: "refinement", statement: "Boundaries need to be executable.", confidence: 0.9, source_event_id: "u2", evidence_quote: "need to be executable" }] }),
      ]),
      reasoning: new FakeProvider([JSON.stringify({ matched_idea_id: ideaId, confidence: 0.9, reasoning: "x", also_related_idea_id: null })]),
    });

    expect(second.newCanonicalEvents).toBe(1); // only u2
    expect(loadIdeas(db)).toHaveLength(1); // merged, not duplicated
    expect(loadIdeas(db)[0]?.evolution).toHaveLength(2);
  });
});
