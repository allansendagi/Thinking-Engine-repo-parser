import { describe, expect, test } from "bun:test";
import { senderAllowed } from "./senderPolicy";

const ID = "abcdefghijklmnopabcdefghijklmnop";
const page = { id: ID, url: `chrome-extension://${ID}/dist/popup.html` };
const aiTab = { id: ID, url: "https://claude.ai/chat/123", tab: {} };

describe("senderAllowed", () => {
  test("the extension's own pages can send anything we define", () => {
    for (const t of ["thread:pair-now", "thread:status", "thread:announce", "thread:history-start", "thread:capture", "thread:resume-check"]) {
      expect(senderAllowed(t, page, ID)).toBe(true);
    }
  });

  test("a content script in an AI tab can only report and ask for the resume suggestion", () => {
    for (const t of ["thread:capture", "thread:health", "thread:import-batch", "thread:history-progress", "thread:resume-check", "thread:resume-dismiss", "thread:continue-packet"]) {
      expect(senderAllowed(t, aiTab, ID)).toBe(true);
    }
    for (const t of ["thread:pair-now", "thread:status", "thread:announce", "thread:history-start"]) {
      expect(senderAllowed(t, aiTab, ID)).toBe(false);
    }
  });

  test("a tab on any other site is refused, even with a valid extension id", () => {
    expect(senderAllowed("thread:capture", { id: ID, url: "https://attacker.example/", tab: {} }, ID)).toBe(false);
    expect(senderAllowed("thread:capture", { id: ID, url: "https://claude.ai.attacker.example/", tab: {} }, ID)).toBe(false);
    expect(senderAllowed("thread:capture", { id: ID, url: "https://claude.ai/x" }, ID)).toBe(false); // no tab
  });

  test("another extension, unknown message types and malformed input are refused", () => {
    expect(senderAllowed("thread:status", { ...page, id: "someoneelse" }, ID)).toBe(false);
    expect(senderAllowed("thread:unknown", page, ID)).toBe(false);
    expect(senderAllowed(undefined, page, ID)).toBe(false);
    expect(senderAllowed("thread:status", { id: ID }, ID)).toBe(false);
  });
});
