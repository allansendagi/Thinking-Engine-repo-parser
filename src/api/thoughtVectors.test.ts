import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequestHandler } from "./handler";
import { FakeProvider } from "../providers/fake";
import { openUserDb } from "../db/tenancy";
import { loadThoughtVectors, vectorModels } from "../db/thoughts";

let tmpDir: string;
const prev = { reg: process.env.THREAD_REGISTRY_PATH, data: process.env.THREAD_DATA_DIR, rl: process.env.THREAD_RATE_LIMIT };
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "thread-vectors-"));
  process.env.THREAD_REGISTRY_PATH = join(tmpDir, "registry.db");
  process.env.THREAD_DATA_DIR = join(tmpDir, "users");
  process.env.THREAD_RATE_LIMIT = "off";
});
afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  for (const [k, v] of [["THREAD_REGISTRY_PATH", prev.reg], ["THREAD_DATA_DIR", prev.data], ["THREAD_RATE_LIMIT", prev.rl]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("thought vectors: native-first embeddings", () => {
  test("the Mac fetches thoughts lacking vectors, uploads them, and they're stored per model", async () => {
    const extraction = new FakeProvider([
      JSON.stringify({ events: [{ type: "new_idea", statement: "Charge per seat.", confidence: 0.9, persistence: "high", source_event_id: "m1", evidence_quote: "per seat" }] }),
    ]);
    const handler = createRequestHandler({ extraction, reasoning: new FakeProvider([]) });
    const user = (await (await handler(new Request("http://x/v1/users", { method: "POST" }))).json()) as { userId: string; token: string };
    const auth = { authorization: `Bearer ${user.userId}:${user.token}`, "content-type": "application/json" };

    await handler(new Request("http://x/v1/conversations", {
      method: "POST", headers: auth,
      body: JSON.stringify({ conversationId: "c1", source: "chatgpt", messages: [{ id: "m1", role: "user", text: "Let's charge per seat.", createdAt: "2026-09-01T00:00:00Z" }] }),
    }));

    const model = "apple:nlcontextual.en.r1";
    const pending = (await (await handler(new Request(`http://x/v1/thoughts/unembedded?model=${model}`, { headers: auth }))).json()) as { thoughts: { id: string; text: string }[] };
    expect(pending.thoughts).toHaveLength(1);
    expect(pending.thoughts[0]!.text).toBe("Charge per seat.");

    const vector = Array.from({ length: 16 }, (_, i) => i / 16);
    const up = await handler(new Request("http://x/v1/thoughts/embeddings", {
      method: "POST", headers: auth, body: JSON.stringify({ model, items: [{ id: pending.thoughts[0]!.id, vector }] }),
    }));
    expect(up.status).toBe(200);

    const after = (await (await handler(new Request(`http://x/v1/thoughts/unembedded?model=${model}`, { headers: auth }))).json()) as { thoughts: unknown[] };
    expect(after.thoughts).toHaveLength(0);

    const db = openUserDb(user.userId);
    const stored = loadThoughtVectors(db, model);
    expect([...stored.values()][0]![3]).toBeCloseTo(3 / 16);
    expect(vectorModels(db)).toEqual([model]);
    db.close();
  });

  test("malformed uploads are rejected whole", async () => {
    const handler = createRequestHandler({ extraction: new FakeProvider([]), reasoning: new FakeProvider([]) });
    const user = (await (await handler(new Request("http://x/v1/users", { method: "POST" }))).json()) as { userId: string; token: string };
    const auth = { authorization: `Bearer ${user.userId}:${user.token}`, "content-type": "application/json" };
    const post = (body: unknown) => handler(new Request("http://x/v1/thoughts/embeddings", { method: "POST", headers: auth, body: JSON.stringify(body) }));
    expect((await post({ model: "apple:x", items: [{ id: "nope", vector: Array(16).fill(0) }] })).status).toBe(400);
    expect((await post({ model: "bad model!", items: [{ id: "x", vector: [1] }] })).status).toBe(400);
    expect((await post({ model: "apple:x", items: [] })).status).toBe(400);
  });
});
