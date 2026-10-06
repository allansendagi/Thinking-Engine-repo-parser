import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompletionProvider } from "../providers/types";
import { createRequestHandler } from "./handler";
import { dbPathForUser, openUserDb } from "../db/tenancy";

/**
 * "Keep my ideas, not my transcripts": the retention setting, proven against the real server and
 * the database file's bytes. Raw text goes; ideas (and the short quotes that ground them) stay;
 * a client re-sending the whole transcript never brings the text back; and text still waiting for
 * the AI is never removed before its ideas exist.
 */

let aiUp = true;
let extractionCalls = 0;
/** Like the real model: a short statement and a short verbatim quote -- never the whole message. */
const extraction: CompletionProvider = {
  async complete(_system, user) {
    if (!aiUp) throw Object.assign(new Error("Your credit balance is too low."), { status: 400 });
    extractionCalls++;
    const events = [...user.matchAll(/\[NEW\] \[([^\]]+)\] \(user, [^)]*\): (.+)/g)].map(([, id, text]) => ({
      type: "new_idea",
      statement: text!.trim().split(/\s+/).slice(0, 5).join(" "),
      title: text!.trim().split(/\s+/).slice(0, 3).join(" "),
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
    return JSON.stringify({ matched_idea_id: null, confidence: 0.1, reasoning: "unrelated", also_related_idea_id: null });
  },
};

let dir: string;
let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "thread-retention-"));
  process.env.THREAD_REGISTRY_PATH = join(dir, "registry.db");
  process.env.THREAD_DATA_DIR = join(dir, "users");
  process.env.THREAD_RATE_LIMIT = "off";
  server = Bun.serve({ port: 0, fetch: createRequestHandler({ extraction, reasoning }) });
  base = `http://localhost:${server.port}`;
});
afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
  delete process.env.THREAD_REGISTRY_PATH;
  delete process.env.THREAD_DATA_DIR;
  delete process.env.THREAD_RATE_LIMIT;
});

async function newUser() {
  const u = (await (await fetch(`${base}/v1/users`, { method: "POST" })).json()) as { userId: string; token: string };
  const headers = { authorization: `Bearer ${u.userId}:${u.token}`, "content-type": "application/json" };
  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = async <T>(r: Response) => (await r.json()) as T;
  return { userId: u.userId, call, json };
}
type TestUser = Awaited<ReturnType<typeof newUser>>;

const NOW = new Date().toISOString();
const msgs = (id: string, userText: string, at: string = NOW) => [
  { id: `${id}_u1`, role: "user", text: userText, createdAt: at },
  { id: `${id}_a1`, role: "assistant", text: "Understood, noted.", createdAt: at },
];
async function capture(u: TestUser, id: string, userText: string, at?: string) {
  const r = await u.call("POST", "/v1/conversations", {
    conversationId: id,
    source: "chatgpt",
    capture: { method: "browser_extension", fidelity: "high" },
    messages: msgs(id, userText, at),
  });
  expect(r.status).toBe(200);
  return r;
}
const bytes = (userId: string) => {
  const p = dbPathForUser(userId);
  return [p, `${p}-wal`].filter(existsSync).map((f) => readFileSync(f).toString("latin1")).join("\n");
};
const count = (userId: string, sql: string) => {
  const db = openUserDb(userId);
  try {
    return (db.query(sql).get() as { n: number }).n;
  } finally {
    db.close();
  }
};
// The secret sits AFTER the first 24 characters (the quote) and the first 5 words (the statement).
const BODY = "Pricing decision for the pilot program: ZEBRA-QUARTZ-7781 is the confidential figure";

describe("retention: keep ideas, not transcripts", () => {
  test("by default nothing is removed", async () => {
    const u = await newUser();
    await capture(u, "c1", BODY);
    const r = await u.json<{ days: number | null; messagesKept: number; messagesRemoved: number }>(await u.call("GET", "/v1/account/retention"));
    expect(r.days).toBeNull();
    expect(r.messagesRemoved).toBe(0);
    expect(bytes(u.userId)).toContain("ZEBRA-QUARTZ-7781");
  });

  test("0 days: the text goes at once -- from the tables, the raw capture record and the file -- the ideas stay", async () => {
    const u = await newUser();
    await capture(u, "c1", BODY);
    expect(bytes(u.userId)).toContain("ZEBRA-QUARTZ-7781");
    const ideasBefore = count(u.userId, "SELECT COUNT(*) AS n FROM idea_nodes");
    expect(ideasBefore).toBeGreaterThan(0);

    const res = await u.call("PUT", "/v1/account/retention", { days: 0 });
    expect(res.status).toBe(200);
    const out = await u.json<{ applied: { messages: number; evidenceRecords: number }; days: number; messagesRemoved: number; backups: string }>(res);
    expect(out.days).toBe(0);
    expect(out.applied.messages).toBe(2);
    expect(out.applied.evidenceRecords).toBeGreaterThan(0);
    expect(out.messagesRemoved).toBe(2);
    expect(out.backups).toContain("backups");

    expect(bytes(u.userId)).not.toContain("ZEBRA-QUARTZ-7781");
    expect(count(u.userId, "SELECT COUNT(*) AS n FROM canonical_events WHERE text <> ''")).toBe(0);
    expect(count(u.userId, "SELECT COUNT(*) AS n FROM canonical_events")).toBe(2); // the rows stay
    expect(count(u.userId, "SELECT COUNT(*) AS n FROM idea_nodes")).toBe(ideasBefore);

    // What a person sees: the idea is still there; the transcript says its text was removed.
    const conv = await u.json<{ messages: { text: string; removed?: boolean }[] }>(await u.call("GET", "/v1/conversations/c1"));
    expect(conv.messages.every((m) => m.removed === true && m.text === "")).toBe(true);
    const list = await u.json<{ conversations: { preview: string }[] }>(await u.call("GET", "/v1/conversations"));
    expect(list.conversations[0]!.preview).toContain("removed");
    const exported = await (await u.call("GET", "/v1/account/export")).text();
    expect(exported).not.toContain("ZEBRA-QUARTZ-7781");
  });

  test("a client re-sending the whole transcript never brings the text back, and nothing is re-processed", async () => {
    const u = await newUser();
    await capture(u, "c1", BODY);
    await u.call("PUT", "/v1/account/retention", { days: 0 });
    const callsBefore = extractionCalls;
    const ideasBefore = count(u.userId, "SELECT COUNT(*) AS n FROM idea_nodes");

    // The extension re-sends the full transcript on every page change.
    for (let i = 0; i < 3; i++) await capture(u, "c1", BODY);

    expect(extractionCalls).toBe(callsBefore);
    expect(count(u.userId, "SELECT COUNT(*) AS n FROM idea_nodes")).toBe(ideasBefore);
    expect(count(u.userId, "SELECT COUNT(*) AS n FROM canonical_events WHERE text <> ''")).toBe(0);
    expect(bytes(u.userId)).not.toContain("ZEBRA-QUARTZ-7781");
  });

  test("a new message in the same conversation is still understood; its text goes once its idea exists", async () => {
    const u = await newUser();
    await capture(u, "c1", BODY);
    await u.call("PUT", "/v1/account/retention", { days: 0 });
    const ideasBefore = count(u.userId, "SELECT COUNT(*) AS n FROM idea_nodes");

    // The same conversation grows: the old turns arrive again (as clients send them) plus one new one.
    const r = await u.call("POST", "/v1/conversations", {
      conversationId: "c1",
      source: "chatgpt",
      capture: { method: "browser_extension", fidelity: "high" },
      messages: [
        ...msgs("c1", BODY),
        { id: "c1_u2", role: "user", text: "Second thought about the onboarding flow today: OTTER-LANTERN-3320 changes the plan", createdAt: NOW },
      ],
    });
    expect(r.status).toBe(200);
    expect(count(u.userId, "SELECT COUNT(*) AS n FROM idea_nodes")).toBeGreaterThan(ideasBefore);
    expect(count(u.userId, "SELECT COUNT(*) AS n FROM canonical_events WHERE text <> ''")).toBe(0);
    expect(bytes(u.userId)).not.toContain("OTTER-LANTERN-3320");
  });

  test("text still waiting for the AI is never removed early -- only after its ideas exist", async () => {
    const u = await newUser();
    await u.call("PUT", "/v1/account/retention", { days: 0 });
    aiUp = false;
    try {
      await capture(u, "c1", BODY);
      // Applied explicitly, as a sweep would: the only copy of the text must survive.
      const r = await u.call("PUT", "/v1/account/retention", { days: 0 });
      expect(((await r.json()) as { applied: { messages: number } }).applied.messages).toBe(0);
      expect(count(u.userId, "SELECT COUNT(*) AS n FROM pending_extraction")).toBeGreaterThan(0);
      expect(bytes(u.userId)).toContain("ZEBRA-QUARTZ-7781");
    } finally {
      aiUp = true;
    }
    // The AI is back: a capture clears the backlog first, and the retention setting then applies.
    await capture(u, "c2", "Another thought entirely: onboarding should be email first");
    expect(count(u.userId, "SELECT COUNT(*) AS n FROM pending_extraction")).toBe(0);
    expect(count(u.userId, "SELECT COUNT(*) AS n FROM idea_nodes")).toBeGreaterThanOrEqual(2);
    expect(bytes(u.userId)).not.toContain("ZEBRA-QUARTZ-7781");
  });

  test("N days: only what is older than that goes", async () => {
    const u = await newUser();
    const old = new Date(Date.now() - 100 * 86_400_000).toISOString();
    await capture(u, "old", "Old thought about the hiring plan today: ZEBRA-QUARTZ-7781 was the plan", old);
    await capture(u, "new", "Recent thought about the pricing plan today: OTTER-LANTERN-3320 is the plan");
    const res = await u.call("PUT", "/v1/account/retention", { days: 30 });
    const out = await u.json<{ applied: { messages: number }; messagesKept: number; messagesRemoved: number }>(res);
    expect(out.applied.messages).toBe(2); // both messages of the old conversation
    expect(out.messagesKept).toBe(2);
    const b = bytes(u.userId);
    expect(b).not.toContain("ZEBRA-QUARTZ-7781");
    expect(b).toContain("OTTER-LANTERN-3320");
  });

  test("turning it off stops removing; what was removed stays removed; bad values are refused", async () => {
    const u = await newUser();
    await capture(u, "c1", BODY);
    await u.call("PUT", "/v1/account/retention", { days: 0 });
    expect((await u.call("PUT", "/v1/account/retention", { days: null })).status).toBe(200);
    await capture(u, "c2", "A later thought about the hiring plan today: OTTER-LANTERN-3320 matters");
    expect(bytes(u.userId)).toContain("OTTER-LANTERN-3320"); // kept again
    expect(bytes(u.userId)).not.toContain("ZEBRA-QUARTZ-7781"); // not brought back
    for (const bad of [-1, 1.5, "7", 99999, true]) {
      expect((await u.call("PUT", "/v1/account/retention", { days: bad })).status).toBe(400);
    }
  });

  test("the Your data summary says what is kept and what was removed", async () => {
    const u = await newUser();
    await capture(u, "c1", BODY);
    await u.call("PUT", "/v1/account/retention", { days: 0 });
    const s = await u.json<{ retention: { days: number; messagesRemoved: number; rawConversations: string } }>(await u.call("GET", "/v1/account/data-summary"));
    expect(s.retention.days).toBe(0);
    expect(s.retention.messagesRemoved).toBe(2);
    expect(s.retention.rawConversations).toContain("removed as soon as");
  });
});
