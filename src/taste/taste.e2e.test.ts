import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompletionProvider } from "../providers/types";
import { createRequestHandler } from "../api/handler";
import { openUserDb } from "../db/tenancy";

/**
 * "Keep" / "Not an idea" through the real server: what Thread learns about how a person thinks,
 * and that it obeys the same privacy rules as everything else they say about their data.
 */

const extraction: CompletionProvider = {
  async complete(_system, user) {
    const events = [...user.matchAll(/\[NEW\] \[([^\]]+)\] \(user, [^)]*\): (.+)/g)].map(([, id, text]) => ({
      type: "new_idea", statement: text!.trim(), title: text!.trim().split(/\s+/).slice(0, 4).join(" "),
      confidence: 0.9, persistence: "high", source_event_id: id, evidence_quote: text!.trim().slice(0, 24),
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
  dir = mkdtempSync(join(tmpdir(), "thread-taste-"));
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
  const call = (method: string, path: string, body?: unknown) => fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { userId: u.userId, call };
}
async function capture(call: ReturnType<typeof newUser> extends Promise<infer U> ? U extends { call: infer C } ? C : never : never, id: string, text: string) {
  const r = await (call as (m: string, p: string, b?: unknown) => Promise<Response>)("POST", "/v1/conversations", {
    conversationId: id, source: "chatgpt", sourceUrl: `https://chatgpt.com/c/${id}`, capture: { method: "browser_extension", fidelity: "high" },
    messages: [{ id: `${id}_u1`, role: "user", text, createdAt: "2026-10-01T10:00:00.000Z" }, { id: `${id}_a1`, role: "assistant", text: "Understood.", createdAt: "2026-10-01T10:00:05.000Z" }],
  });
  expect(r.status).toBe(200);
}
type Taste = { ready: boolean; keeps: number; notIdeas: number; acceptanceRate: number | null; ideas: { ideaId: string; tier: string }[] };

describe("keep and not-an-idea", () => {
  test("full lifecycle: suggested -> confirmed, acceptance rate, export, and privacy cleanup", async () => {
    const u = await newUser();
    await capture(u.call as never, "conv_a", "Pricing should follow active members, not seats");
    await capture(u.call as never, "conv_b", "Newsletter goes biweekly from November onward");
    const ids = (openUserDb(u.userId).query("SELECT n.id, e.conversation_id AS conv FROM idea_nodes n JOIN evolution_steps s ON s.idea_id = n.id JOIN canonical_events e ON e.id = s.source_event_id").all() as { id: string; conv: string }[]);
    const ideaA = ids.find((r) => r.conv === "conv_a")!.id, ideaB = ids.find((r) => r.conv === "conv_b")!.id;

    // Nothing confirmed yet: every idea is merely a suggestion, and taste has no opinion.
    let t = (await (await u.call("GET", "/v1/taste")).json()) as Taste;
    expect(t.ready).toBe(false);
    expect(t.acceptanceRate).toBeNull();
    expect(t.ideas.every((i) => i.tier === "suggested")).toBe(true);

    // Bad requests are rejected clearly.
    expect((await u.call("PATCH", `/v1/ideas/${ideaA}`, { verdict: "bogus" })).status).toBe(400);
    expect((await u.call("PATCH", `/v1/ideas/nope`, { verdict: "keep" })).status).toBe(404);

    // Keep A (twice: idempotent). Not-an-idea B (the existing DELETE).
    expect((await u.call("PATCH", `/v1/ideas/${ideaA}`, { verdict: "keep" })).status).toBe(200);
    expect((await u.call("PATCH", `/v1/ideas/${ideaA}`, { verdict: "keep" })).status).toBe(200);
    expect((await u.call("DELETE", `/v1/ideas/${ideaB}`)).status).toBe(200);

    t = (await (await u.call("GET", "/v1/taste")).json()) as Taste;
    expect(t.keeps).toBe(1);
    expect(t.notIdeas).toBe(1);
    expect(t.acceptanceRate).toBeCloseTo(0.5);
    expect(t.ideas.find((i) => i.ideaId === ideaA)?.tier).toBe("confirmed");
    expect(t.ideas.find((i) => i.ideaId === ideaB)).toBeUndefined(); // deleted

    // The verdict is part of the person's data: it is in the export...
    const exported = (await (await u.call("GET", "/v1/account/export")).json()) as { idea_verdicts: unknown[] };
    expect(exported.idea_verdicts.length).toBe(1);

    // ...and it goes with the conversation it was about.
    expect((await u.call("DELETE", "/v1/conversations/conv_a")).status).toBe(200);
    const after = (await (await u.call("GET", "/v1/account/export")).json()) as { idea_verdicts: unknown[] };
    expect(after.idea_verdicts.length).toBe(0);
    t = (await (await u.call("GET", "/v1/taste")).json()) as Taste;
    expect(t.keeps).toBe(0);
  });

  test("one person's verdicts never appear in another's taste", async () => {
    const a = await newUser(), b = await newUser();
    await capture(a.call as never, "conv_x", "Annual plans only for teams");
    const idea = (openUserDb(a.userId).query("SELECT id FROM idea_nodes").get() as { id: string }).id;
    expect((await a.call("PATCH", `/v1/ideas/${idea}`, { verdict: "keep" })).status).toBe(200);
    const tb = (await (await b.call("GET", "/v1/taste")).json()) as Taste;
    expect(tb.keeps).toBe(0);
    expect(tb.ideas).toHaveLength(0);
  });
});
