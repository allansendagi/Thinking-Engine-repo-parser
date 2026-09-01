import { describe, expect, test } from "bun:test";
import { parseClaudeExport } from "./claude";

describe("parseClaudeExport", () => {
  test("parses a flat chat_messages list into canonical events", () => {
    const raw = [
      {
        uuid: "conv-1",
        name: "Test conversation",
        chat_messages: [
          { uuid: "m1", sender: "human", text: "Authority needs explicit boundaries.", created_at: "2026-08-17T00:00:00.000Z" },
          { uuid: "m2", sender: "assistant", text: "Can you say more?", created_at: "2026-08-17T00:00:30.000Z" },
        ],
      },
    ];

    const events = parseClaudeExport(raw);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      id: "m1",
      conversationId: "conv-1",
      source: "claude",
      role: "user",
      text: "Authority needs explicit boundaries.",
      createdAt: "2026-08-17T00:00:00.000Z",
      index: 0,
    });
    expect(events[1]?.role).toBe("assistant");
  });

  test("extracts text from content blocks when text field is absent", () => {
    const raw = [
      {
        uuid: "conv-1",
        chat_messages: [
          {
            uuid: "m1",
            sender: "human",
            content: [
              { type: "text", text: "First block." },
              { type: "text", text: "Second block." },
            ],
          },
        ],
      },
    ];
    const events = parseClaudeExport(raw);
    expect(events[0]?.text).toBe("First block.\nSecond block.");
  });

  test("skips messages with an unrecognized sender and empty-text messages", () => {
    const raw = [
      {
        uuid: "conv-1",
        chat_messages: [
          { uuid: "m1", sender: "system", text: "hidden" },
          { uuid: "m2", sender: "human", text: "" },
          { uuid: "m3", sender: "human", text: "Real message." },
        ],
      },
    ];
    const events = parseClaudeExport(raw);
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe("m3");
  });

  test("synthesizes an id from conversationId+index when uuid is missing", () => {
    const raw = [{ uuid: "conv-1", chat_messages: [{ sender: "human", text: "No uuid here." }] }];
    const events = parseClaudeExport(raw);
    expect(events[0]?.id).toBe("conv-1::0");
  });

  test("supports the messages field name variant alongside chat_messages", () => {
    const raw = [{ uuid: "conv-1", messages: [{ uuid: "m1", sender: "human", text: "Variant field name." }] }];
    const events = parseClaudeExport(raw);
    expect(events).toHaveLength(1);
  });

  test("throws a clear error when the top-level shape isn't an array", () => {
    expect(() => parseClaudeExport({ not: "an array" })).toThrow(/array/);
  });
});
