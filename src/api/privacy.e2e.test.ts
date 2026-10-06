import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompletionProvider } from "../providers/types";
import { createRequestHandler } from "./handler";
import { attachEmail, registryPath, setPlan } from "./auth";
import { dbPathForUser, openUserDb } from "../db/tenancy";

/**
 * What a person is promised about their data, proven against the real server and the real
 * database file -- not just against the API's own say-so. Deleting must leave the text nowhere:
 * not in a table, not in a vector, not in a correction, and not in the bytes of the file.
 */

const extraction: CompletionProvider = {
  async complete(_system, user) {
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
    return JSON.stringify({ matched_idea_id: null, confidence: 0.1, reasoning: "unrelated", also_related_idea_id: null });
  },
};

const SECRET_A = "ZEBRA-QUARTZ-7781 pricing for the Dubai pilot";
const SECRET_B = "OTTER-LANTERN-3320 the newsletter goes biweekly";

let dir: string;
let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "thread-privacy-"));
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
async function capture(call: TestUser["call"], id: string, text: string) {
  const r = await call("POST", "/v1/conversations", {
    conversationId: id,
    source: "chatgpt",
    sourceUrl: `https://chatgpt.com/c/${id}`,
    capture: { method: "browser_extension", fidelity: "high" },
    messages: [
      { id: `${id}_u1`, role: "user", text, createdAt: "2026-10-01T10:00:00.000Z" },
      { id: `${id}_a1`, role: "assistant", text: "Understood.", createdAt: "2026-10-01T10:00:05.000Z" },
    ],
  });
  expect(r.status).toBe(200);
}

/** Every byte the account's database holds on disk, including the write-ahead log. */
function bytesOnDisk(userId: string): string {
  const p = dbPathForUser(userId);
  return [p, `${p}-wal`].filter(existsSync).map((f) => readFileSync(f).toString("latin1")).join("\n");
}

describe("what Thread holds is visible", () => {
  test("the data summary counts what is stored and names who else receives it", async () => {
    const u = await newUser();
    await capture(u.call, "conv_a", SECRET_A);
    await capture(u.call, "conv_b", SECRET_B);
    const s = await u.json<{
      stored: { conversations: number; messages: number; ideas: number; sources: Record<string, number>; bytes: number };
      processors: { name: string }[];
      retention: { backups: string };
    }>(await u.call("GET", "/v1/account/data-summary"));
    expect(s.stored.conversations).toBe(2);
    expect(s.stored.messages).toBe(4);
    expect(s.stored.ideas).toBeGreaterThanOrEqual(2);
    expect(s.stored.sources.chatgpt).toBe(2);
    expect(s.stored.bytes).toBeGreaterThan(0);
    expect(s.processors.map((p) => p.name)).toContain("Anthropic");
    expect(s.retention.backups).toContain("backups");
  });

  test("the export is a complete copy of the person's data", async () => {
    const u = await newUser();
    await capture(u.call, "conv_a", SECRET_A);
    const r = await u.call("GET", "/v1/account/export");
    expect(r.headers.get("content-disposition")).toContain("thread-export.json");
    const text = await r.text();
    expect(text).toContain("ZEBRA-QUARTZ-7781");
    const parsed = JSON.parse(text) as { canonical_events: unknown[]; idea_nodes: unknown[] };
    expect(parsed.canonical_events.length).toBe(2);
    expect(parsed.idea_nodes.length).toBeGreaterThanOrEqual(1);
    // No credentials in an export.
    expect(text).not.toMatch(/token_hash|authorization/i);
  });
});

describe("secrets are stripped on the server too (older clients)", () => {
  test("a key pasted in a capture, a paste or an import is stored redacted -- file bytes included", async () => {
    const u = await newUser();
    const key = "sk-ant-api03-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz9876";
    await capture(u.call, "conv_k", `my key is ${key} please keep the pricing idea`);
    expect((await u.call("POST", "/v1/paste", { text: `User: remember ${key}\nAssistant: ok` })).status).toBe(200);
    const exported = await (await u.call("GET", "/v1/account/export")).text();
    expect(exported).not.toContain("zzzzzzzzzzzzzzzzzzzz");
    expect(exported).toContain("[redacted api key]");
    expect(bytesOnDisk(u.userId)).not.toContain("zzzzzzzzzzzzzzzzzzzz");
  });
});

describe("deleting a conversation leaves nothing of it", () => {
  test("messages, thoughts, vectors, corrections, ideas and the file bytes are all clean; the rest is untouched", async () => {
    const u = await newUser();
    await capture(u.call, "conv_a", SECRET_A);
    await capture(u.call, "conv_b", SECRET_B);

    // Give both conversations' thoughts vectors, and make a "not an idea" correction on A's idea
    // (that keeps the idea's statement for learning -- it must go with the conversation).
    let db = openUserDb(u.userId);
    const thoughtsA = (db.query("SELECT c.id FROM cognitive_events c JOIN canonical_events e ON e.id = c.source_event_id WHERE e.conversation_id = 'conv_a'").all() as { id: string }[]).map((r) => r.id);
    const thoughtsB = (db.query("SELECT c.id FROM cognitive_events c JOIN canonical_events e ON e.id = c.source_event_id WHERE e.conversation_id = 'conv_b'").all() as { id: string }[]).map((r) => r.id);
    expect(thoughtsA.length).toBeGreaterThan(0);
    expect(thoughtsB.length).toBeGreaterThan(0);
    const vec = new Uint8Array(new Float32Array([0.1, 0.2, 0.3]).buffer);
    for (const id of [...thoughtsA, ...thoughtsB])
      db.prepare("INSERT INTO thought_vectors (thought_id, model, dims, vector, text_hash, created_at) VALUES (?, 'test', 3, ?, 'h', ?)").run(id, vec, "2026-10-01T00:00:00Z");
    const ideaA = db.query("SELECT i.id FROM idea_nodes i JOIN evolution_steps s ON s.idea_id = i.id JOIN canonical_events e ON e.id = s.source_event_id WHERE e.conversation_id = 'conv_a'").get() as { id: string };
    db.close();
    expect((await u.call("DELETE", `/v1/ideas/${encodeURIComponent(ideaA.id)}`)).status).toBe(200);
    db = openUserDb(u.userId);
    expect((db.query("SELECT COUNT(*) AS n FROM idea_corrections").get() as { n: number }).n).toBe(1);
    db.close();
    expect(bytesOnDisk(u.userId)).toContain("ZEBRA-QUARTZ-7781");

    const res = await u.call("DELETE", "/v1/conversations/conv_a");
    expect(res.status).toBe(200);
    const out = await u.json<{ removed: { messages: number; thoughts: number; vectors: number; corrections: number }; backups: string }>(res);
    expect(out.removed.messages).toBe(2);
    expect(out.removed.thoughts).toBe(thoughtsA.length);
    expect(out.removed.vectors).toBe(thoughtsA.length);
    expect(out.removed.corrections).toBe(1);
    expect(out.backups).toContain("backups");

    db = openUserDb(u.userId);
    const count = (sql: string, ...p: string[]) => (db.query(sql).get(...p) as { n: number }).n;
    expect(count("SELECT COUNT(*) AS n FROM canonical_events WHERE conversation_id = 'conv_a'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM idea_corrections")).toBe(0);
    for (const t of thoughtsA) expect(count("SELECT COUNT(*) AS n FROM thought_vectors WHERE thought_id = ?", t)).toBe(0);
    // Conversation B is exactly as it was.
    expect(count("SELECT COUNT(*) AS n FROM canonical_events WHERE conversation_id = 'conv_b'")).toBe(2);
    for (const t of thoughtsB) expect(count("SELECT COUNT(*) AS n FROM thought_vectors WHERE thought_id = ?", t)).toBe(1);
    db.close();

    // The proof that matters: the text is gone from the bytes of the file, not just from the tables.
    const disk = bytesOnDisk(u.userId);
    expect(disk).not.toContain("ZEBRA-QUARTZ-7781");
    expect(disk).toContain("OTTER-LANTERN-3320");

    // Gone from every API view too.
    expect((await u.call("GET", "/v1/conversations/conv_a")).status).toBe(404);
    expect((await u.call("DELETE", "/v1/conversations/conv_a")).status).toBe(404);
    const search = await (await u.call("GET", "/v1/search?q=ZEBRA-QUARTZ-7781")).text();
    expect(search).not.toContain("ZEBRA-QUARTZ-7781");
  });
});

describe("delete everything", () => {
  test("needs the typed confirmation, then removes the account, its files and its sign-ins", async () => {
    const u = await newUser();
    await capture(u.call, "conv_a", SECRET_A);
    const dbFile = dbPathForUser(u.userId);
    expect(existsSync(dbFile)).toBe(true);
    attachEmail(u.userId, "erase-me-4471@example.com");
    const registryBytes = () => [registryPath(), `${registryPath()}-wal`].filter(existsSync).map((f) => readFileSync(f).toString("latin1")).join("\n");
    expect(registryBytes()).toContain("erase-me-4471@example.com");

    expect((await u.call("DELETE", "/v1/account/data", {})).status).toBe(400);
    expect((await u.call("DELETE", "/v1/account/data", { confirm: "yes" })).status).toBe(400);
    expect(existsSync(dbFile)).toBe(true); // a stray request deleted nothing

    const res = await u.call("DELETE", "/v1/account/data", { confirm: "delete everything" });
    expect(res.status).toBe(200);
    const receipt = await u.json<{
      deleted: boolean;
      data: { conversations: number; messages: number; ideas: number; filesRemoved: number };
      account: { account: number; devices: number };
      backups: string;
    }>(res);
    expect(receipt.deleted).toBe(true);
    expect(receipt.data.conversations).toBe(1);
    expect(receipt.data.messages).toBe(2);
    expect(receipt.data.ideas).toBeGreaterThanOrEqual(1);
    expect(receipt.data.filesRemoved).toBeGreaterThanOrEqual(1);
    expect(receipt.account.account).toBe(1);
    expect(receipt.account.devices).toBeGreaterThanOrEqual(1);
    expect(receipt.backups).toContain("backups");

    // Nothing left on disk -- and nothing reappears (a background job must not recreate it).
    for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) expect(existsSync(f)).toBe(false);
    await new Promise((r) => setTimeout(r, 150));
    expect(existsSync(dbFile)).toBe(false);
    // The email is gone from the registry file's bytes too.
    expect(registryBytes()).not.toContain("erase-me-4471@example.com");
    // The old sign-in is dead.
    expect((await u.call("GET", "/v1/account")).status).toBe(401);
  });

  test("a background job that still holds the database open can't bring files back after deletion", async () => {
    const u = await newUser();
    await capture(u.call, "conv_a", SECRET_A);
    // What an in-flight mining pass or extraction retry looks like: a connection opened earlier.
    const straggler = openUserDb(u.userId);
    const dbFile = dbPathForUser(u.userId);
    expect((await u.call("DELETE", "/v1/account/data", { confirm: "delete everything" })).status).toBe(200);
    // It tries to write after the account is gone: that must fail, not recreate -wal/-shm.
    let wrote = true;
    try {
      straggler.prepare("INSERT INTO mining_runs (miner, thoughts, vectors, ideas, sparks, ms, ran_at) VALUES ('v2', 0, 0, 0, 0, 0, 'x')").run();
    } catch {
      wrote = false;
    }
    try {
      straggler.close();
    } catch {
      // already closed by the purge
    }
    expect(wrote).toBe(false);
    for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) expect(existsSync(f)).toBe(false);
  });

  test("an active subscription must be dealt with first -- deleting data doesn't cancel billing", async () => {
    const u = await newUser();
    setPlan(u.userId, { plan: "pro", status: "active", paddleCustomerId: "ctm_1" });
    const refused = await u.call("DELETE", "/v1/account/data", { confirm: "delete everything" });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe("subscription_active");
    const ok = await u.call("DELETE", "/v1/account/data", { confirm: "delete everything", acknowledgeSubscription: true });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { subscriptionStillActive: boolean }).subscriptionStillActive).toBe(true);
  });
});
