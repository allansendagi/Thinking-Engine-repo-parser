import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompletionProvider } from "../providers/types";
import { createRequestHandler } from "./handler";

/**
 * End to end over real HTTP: the September outage, replayed. The model provider refuses every
 * call (an unpaid account), the clients keep capturing the way they really do, then the account
 * is paid and everything captured meanwhile must turn into ideas on its own -- nothing lost,
 * nothing processed twice, the status honest throughout.
 */

let aiUp = false;
let extractionCalls = 0;
const refuse = () => {
  throw Object.assign(new Error("Your credit balance is too low to access the Anthropic API."), { status: 400 });
};
/** Extracts one new idea per NEW user message, grounded in its text -- like the real model. */
const extraction: CompletionProvider = {
  async complete(_system, user) {
    if (!aiUp) refuse();
    extractionCalls++;
    const events = [...user.matchAll(/\[NEW\] \[([^\]]+)\] \(user, [^)]*\): (.+)/g)].map(([, id, text]) => ({
      type: "new_idea",
      statement: text!.trim(),
      title: text!.trim().split(/\s+/).slice(0, 4).join(" "),
      confidence: 0.9,
      persistence: "high",
      source_event_id: id,
      evidence_quote: text!.trim().slice(0, 24),
    }));
    return JSON.stringify({ events });
  },
};
const reasoning: CompletionProvider = {
  async complete() {
    if (!aiUp) refuse();
    return JSON.stringify({ matched_idea_id: null, confidence: 0.1, reasoning: "unrelated", also_related_idea_id: null });
  },
};

let dir: string;
let server: ReturnType<typeof Bun.serve>;
let base: string;
let auth: Record<string, string>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "thread-outage-"));
  process.env.THREAD_REGISTRY_PATH = join(dir, "registry.db");
  process.env.THREAD_DATA_DIR = join(dir, "users");
  process.env.THREAD_RATE_LIMIT = "off";
  server = Bun.serve({ port: 0, fetch: createRequestHandler({ extraction, reasoning }) });
  base = `http://localhost:${server.port}`;
  const u = (await (await fetch(`${base}/v1/users`, { method: "POST" })).json()) as { userId: string; token: string };
  auth = { authorization: `Bearer ${u.userId}:${u.token}`, "content-type": "application/json" };
});

afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
  delete process.env.THREAD_REGISTRY_PATH;
  delete process.env.THREAD_DATA_DIR;
  delete process.env.THREAD_RATE_LIMIT;
});

const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: auth, body: JSON.stringify(body) });
const get = async <T>(path: string) => (await (await fetch(`${base}${path}`, { headers: auth })).json()) as T;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the September outage, end to end", () => {
  test("while the AI refuses: every capture path succeeds and is stored, and the status says so", async () => {
    // The browser extension's live capture (its exact request shape).
    const live = await post("/v1/conversations", {
      conversationId: "claude_conv_1",
      source: "claude",
      sourceUrl: "https://claude.ai/chat/claude_conv_1",
      capture: { method: "browser_extension", fidelity: "high" },
      messages: [
        { id: "u1", role: "user", text: "We should charge per seat rather than a flat fee.", createdAt: "2026-09-10T10:00:00.000Z" },
        { id: "a1", role: "assistant", text: "Per-seat pricing scales with team size.", createdAt: "2026-09-10T10:00:05.000Z" },
      ],
    });
    expect(live.status).toBe(200);
    // Both turns wait: the reply is the context the person's message is extracted against.
    expect(((await live.json()) as { extractionPending: number }).extractionPending).toBe(2);

    // The extension re-sends the same transcript (it does, on every page change): a no-op.
    const resend = await post("/v1/conversations", {
      conversationId: "claude_conv_1",
      source: "claude",
      messages: [{ id: "u1", role: "user", text: "We should charge per seat rather than a flat fee.", createdAt: "2026-09-10T10:00:00.000Z" }],
    });
    expect(resend.status).toBe(200);

    // A paste and a history-import batch (the Mac app and "Bring in your history").
    expect((await post("/v1/paste", { text: "User: Ship the import before the redesign.\nAssistant: Makes sense." })).status).toBe(200);
    const imported = await post("/v1/import", {
      format: "chatgpt",
      conversations: [
        {
          id: "hist_1",
          current_node: "n1",
          mapping: {
            n1: {
              id: "n1", parent: null, children: [],
              message: { id: "n1", author: { role: "user" }, content: { content_type: "text", parts: ["Make the newsletter biweekly on Tuesdays."] }, create_time: 1_725_000_000 },
            },
          },
        },
      ],
    });
    expect(imported.status).toBe(200);
    expect(((await imported.json()) as { extractionPending: number }).extractionPending).toBe(1);

    // Everything is in the activity feed; no ideas yet; the app is told plainly.
    const convs = await get<{ conversations: { preview: string; pendingMessages: number }[] }>("/v1/conversations");
    expect(convs.conversations.length).toBe(3);
    // Each row says what it was about and that it's saved, waiting for the AI.
    expect(convs.conversations.every((c) => c.preview.length > 0 && c.pendingMessages > 0)).toBe(true);
    const health = await get<{ healthy: boolean; pendingExtraction: { count: number; lastError: string } }>("/v1/capture-health");
    expect(health.healthy).toBe(false);
    expect(health.pendingExtraction.count).toBe(5); // 2 live + 2 pasted + 1 imported
    expect(health.pendingExtraction.lastError).toContain("credit balance");
    expect(extractionCalls).toBe(0);
  });

  test("once the account is paid: the app's next sync turns it all into ideas, each message once", async () => {
    aiUp = true;
    // The throttle is per 2 minutes; this is the app's sync after that window. Simulate it by
    // capturing something new -- a capture always clears the backlog first.
    const next = await post("/v1/conversations", {
      conversationId: "claude_conv_2",
      source: "claude",
      messages: [{ id: "u9", role: "user", text: "Hire a senior generalist first.", createdAt: "2026-10-06T10:00:00.000Z" }],
    });
    expect(next.status).toBe(200);
    expect(((await next.json()) as { extractionPending?: number }).extractionPending ?? 0).toBe(0);
    await sleep(50);

    const health = await get<{ pendingExtraction: { count: number } }>("/v1/capture-health");
    expect(health.pendingExtraction.count).toBe(0);
    const state = await get<{ currentIdeas: { currentFormulation: string }[] }>("/v1/thinking-state");
    // Every captured thought -- live, re-sent, pasted, imported, and the new one -- is an idea.
    expect(state.currentIdeas.map((i) => i.currentFormulation).sort()).toEqual(
      [
        "Hire a senior generalist first.",
        "Make the newsletter biweekly on Tuesdays.",
        "Ship the import before the redesign.",
        "We should charge per seat rather than a flat fee.",
      ].sort(),
    );
    // One extraction call per conversation -- nothing processed twice.
    expect(extractionCalls).toBe(4);
  });

  test("the deep health check names the cause while the AI is down", async () => {
    aiUp = false;
    // A fresh server (the health result is cached for 5 minutes per server).
    const s = Bun.serve({ port: 0, fetch: createRequestHandler({ extraction, reasoning }) });
    try {
      const h = (await (await fetch(`http://localhost:${s.port}/v1/health?deep=1`)).json()) as {
        models: Record<string, string>;
        disk: { writable: boolean };
      };
      expect(h.models.extraction).toContain("credit balance is too low");
      expect(h.disk.writable).toBe(true);
    } finally {
      s.stop(true);
    }
  });
});
