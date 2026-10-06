import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { importBatch, ingestConversation, pasteConversation } from "./api";

/**
 * The claim "secrets are stripped on your device before anything is sent" tested on the wire:
 * the actual request bodies the extension would POST to Thread, for every upload path.
 */

const SECRETS = [
  "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
  "AKIAABCDEFGHIJKLMNOP",
  "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
];
const text = `here are my keys: ${SECRETS.join(" and ")} -- please rotate them`;

const realFetch = globalThis.fetch;
const realChrome = (globalThis as { chrome?: unknown }).chrome;
let bodies: string[] = [];

beforeEach(() => {
  bodies = [];
  (globalThis as { chrome?: unknown }).chrome = {
    storage: { local: { get: async () => ({ apiBaseUrl: "https://thread.test", credentials: { userId: "u", token: "t" } }) } },
  };
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ""));
    return Response.json({ newCanonicalEvents: 0, newCognitiveEvents: 0, rejectedExtractions: 0, ideaCount: 0, conversationId: "x" });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  (globalThis as { chrome?: unknown }).chrome = realChrome;
});

function expectClean(body: string) {
  for (const s of SECRETS) expect(body).not.toContain(s.slice(0, 20));
  expect(body).toContain("[redacted");
  expect(body).toContain("please rotate them"); // the thinking around it is untouched
}

describe("secrets never leave the browser", () => {
  test("live capture", async () => {
    await ingestConversation("c1", "chatgpt", [{ id: "m1", role: "user", text, createdAt: "2026-10-01T00:00:00Z" }] as never);
    expectClean(bodies[0]!);
  });
  test("paste / right-click capture", async () => {
    await pasteConversation(text);
    expectClean(bodies[0]!);
  });
  test("history import", async () => {
    await importBatch("chatgpt", [{ mapping: { n: { message: { content: { parts: [text] } } } } }]);
    expectClean(bodies[0]!);
  });
});
