import { describe, expect, test } from "bun:test";
import { parsePastedConversation } from "./pasteParser";

describe("parsePastedConversation", () => {
  test("splits a labeled back-and-forth into user/assistant turns", () => {
    const raw = `User: Authority needs explicit boundaries.
Assistant: Can you say more about what kind of boundaries you mean?
User: Per-agent, not global.`;
    expect(parsePastedConversation(raw)).toEqual([
      { role: "user", text: "Authority needs explicit boundaries." },
      { role: "assistant", text: "Can you say more about what kind of boundaries you mean?" },
      { role: "user", text: "Per-agent, not global." },
    ]);
  });

  test("recognizes common label variants case-insensitively", () => {
    const raw = `human: hello\nAI: hi there\nyou: thanks\nclaude: you're welcome`;
    const messages = parsePastedConversation(raw);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  test("joins multi-line turns until the next marker", () => {
    const raw = `User: Line one.
Line two of the same message.

Line three, still the same message.
Assistant: A reply.`;
    const messages = parsePastedConversation(raw);
    expect(messages[0]?.text).toBe("Line one.\nLine two of the same message.\n\nLine three, still the same message.");
  });

  test("does not misfire on a colon inside a sentence", () => {
    const raw = "Note: this is important, not a speaker label.";
    const messages = parsePastedConversation(raw);
    expect(messages).toEqual([{ role: "user", text: raw }]);
  });

  test("treats the entire paste as one user message when no markers are found at all", () => {
    const raw = "Just some raw pasted thoughts with no structure.";
    expect(parsePastedConversation(raw)).toEqual([{ role: "user", text: raw }]);
  });

  test("returns an empty array for empty or whitespace-only input", () => {
    expect(parsePastedConversation("")).toEqual([]);
    expect(parsePastedConversation("   \n\n  ")).toEqual([]);
  });

  test("ignores an empty turn produced by a trailing marker with nothing after it", () => {
    const raw = "User: real content\nAssistant:";
    expect(parsePastedConversation(raw)).toEqual([{ role: "user", text: "real content" }]);
  });
});
