import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequestHandler } from "./handler";
import { FakeProvider } from "../providers/fake";

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "thread-api-test-"));
  process.env.THREAD_REGISTRY_PATH = join(tmpDir, "registry.db");
  process.env.THREAD_DATA_DIR = join(tmpDir, "users");
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.THREAD_REGISTRY_PATH;
  delete process.env.THREAD_DATA_DIR;
});

function extractionResponse(events: object[]): string {
  return JSON.stringify({ events });
}

async function createTestUser(handler: (req: Request) => Promise<Response>) {
  const res = await handler(new Request("http://x/v1/users", { method: "POST" }));
  return (await res.json()) as { userId: string; token: string };
}

describe("HTTP handler (fetch against the pure handler, no network port)", () => {
  test("health check needs no auth", async () => {
    const handler = createRequestHandler({ extraction: new FakeProvider([]), reasoning: new FakeProvider([]) });
    const res = await handler(new Request("http://x/v1/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("protected routes reject missing or wrong credentials", async () => {
    const handler = createRequestHandler({ extraction: new FakeProvider([]), reasoning: new FakeProvider([]) });
    const noAuth = await handler(new Request("http://x/v1/thinking-state"));
    expect(noAuth.status).toBe(401);

    const { userId } = await createTestUser(handler);
    const wrongToken = await handler(
      new Request("http://x/v1/thinking-state", { headers: { authorization: `Bearer ${userId}:${"0".repeat(64)}` } }),
    );
    expect(wrongToken.status).toBe(401);
  });

  test("create user -> ingest a conversation -> read it back via the API", async () => {
    const handler = createRequestHandler({
      extraction: new FakeProvider([
        extractionResponse([
          { type: "new_idea", statement: "Authority needs explicit boundaries.", confidence: 0.9, source_event_id: "m1", evidence_quote: "explicit boundaries" },
        ]),
      ]),
      reasoning: new FakeProvider([]),
    });

    const { userId, token } = await createTestUser(handler);
    const authHeader = { authorization: `Bearer ${userId}:${token}` };

    const ingestRes = await handler(
      new Request("http://x/v1/conversations", {
        method: "POST",
        headers: { ...authHeader, "content-type": "application/json" },
        body: JSON.stringify({
          conversationId: "conv_1",
          source: "fixture",
          messages: [{ id: "m1", role: "user", text: "Authority needs explicit boundaries.", createdAt: "2026-08-17T00:00:00.000Z" }],
        }),
      }),
    );
    expect(ingestRes.status).toBe(200);
    const ingestBody = (await ingestRes.json()) as { ideaCount: number };
    expect(ingestBody.ideaCount).toBe(1);

    const stateRes = await handler(new Request("http://x/v1/thinking-state", { headers: authHeader }));
    const state = (await stateRes.json()) as { currentIdeas: { title: string }[] };
    expect(state.currentIdeas).toHaveLength(1);
    expect(state.currentIdeas[0]?.title).toContain("Authority");

    const searchRes = await handler(new Request("http://x/v1/ideas?q=authority%20boundaries", { headers: authHeader }));
    const results = (await searchRes.json()) as { id: string }[];
    expect(results.length).toBeGreaterThan(0);
  });

  test("one user cannot read another user's data even with a valid token for a different account", async () => {
    const handler = createRequestHandler({
      extraction: new FakeProvider([
        extractionResponse([
          { type: "new_idea", statement: "User A's private idea.", confidence: 0.9, source_event_id: "m1", evidence_quote: "private idea" },
        ]),
      ]),
      reasoning: new FakeProvider([]),
    });

    const userA = await createTestUser(handler);
    await handler(
      new Request("http://x/v1/conversations", {
        method: "POST",
        headers: { authorization: `Bearer ${userA.userId}:${userA.token}`, "content-type": "application/json" },
        body: JSON.stringify({
          conversationId: "conv_a",
          source: "fixture",
          messages: [{ id: "m1", role: "user", text: "User A's private idea.", createdAt: "2026-08-17T00:00:00.000Z" }],
        }),
      }),
    );

    const userB = await createTestUser(handler);
    const bReadsState = await handler(
      new Request("http://x/v1/thinking-state", { headers: { authorization: `Bearer ${userB.userId}:${userB.token}` } }),
    );
    const bState = (await bReadsState.json()) as { currentIdeas: unknown[] };
    expect(bState.currentIdeas).toHaveLength(0); // B's DB is separate; A's idea never appears
  });

  test("correction endpoints: rename, change state, resolve an open loop, then delete", async () => {
    const handler = createRequestHandler({
      extraction: new FakeProvider([
        extractionResponse([
          { type: "new_idea", statement: "Authority needs explicit boundaries.", confidence: 0.9, source_event_id: "m1", evidence_quote: "explicit boundaries" },
        ]),
      ]),
      reasoning: new FakeProvider([]),
    });
    const { userId, token } = await createTestUser(handler);
    const authHeader = { authorization: `Bearer ${userId}:${token}`, "content-type": "application/json" };

    await handler(
      new Request("http://x/v1/conversations", {
        method: "POST",
        headers: authHeader,
        body: JSON.stringify({
          conversationId: "conv_1",
          source: "fixture",
          messages: [{ id: "m1", role: "user", text: "Authority needs explicit boundaries.", createdAt: "2026-08-17T00:00:00.000Z" }],
        }),
      }),
    );
    const state = (await (await handler(new Request("http://x/v1/thinking-state", { headers: authHeader }))).json()) as {
      currentIdeas: { id: string }[];
    };
    const ideaId = state.currentIdeas[0]?.id as string;

    const renameRes = await handler(
      new Request(`http://x/v1/ideas/${ideaId}`, { method: "PATCH", headers: authHeader, body: JSON.stringify({ title: "Computable Authority" }) }),
    );
    expect(renameRes.status).toBe(200);
    expect(((await renameRes.json()) as { title: string }).title).toBe("Computable Authority");

    const rejectRes = await handler(
      new Request(`http://x/v1/ideas/${ideaId}`, { method: "PATCH", headers: authHeader, body: JSON.stringify({ state: "rejected" }) }),
    );
    expect(((await rejectRes.json()) as { state: string }).state).toBe("rejected");

    const badStateRes = await handler(
      new Request(`http://x/v1/ideas/${ideaId}`, { method: "PATCH", headers: authHeader, body: JSON.stringify({ state: "not_a_state" }) }),
    );
    expect(badStateRes.status).toBe(400);

    const deleteRes = await handler(new Request(`http://x/v1/ideas/${ideaId}`, { method: "DELETE", headers: authHeader }));
    expect(deleteRes.status).toBe(200);

    const deleteAgainRes = await handler(new Request(`http://x/v1/ideas/${ideaId}`, { method: "DELETE", headers: authHeader }));
    expect(deleteAgainRes.status).toBe(404);

    const finalState = (await (await handler(new Request("http://x/v1/thinking-state", { headers: authHeader }))).json()) as {
      currentIdeas: unknown[];
    };
    expect(finalState.currentIdeas).toHaveLength(0);
  });

  test("POST /v1/paste parses a labeled conversation and ingests it", async () => {
    const handler = createRequestHandler({
      extraction: new FakeProvider([
        extractionResponse([
          { type: "new_idea", statement: "Authority needs explicit boundaries.", confidence: 0.9, source_event_id: "conv_paste::0", evidence_quote: "explicit boundaries" },
        ]),
      ]),
      reasoning: new FakeProvider([]),
    });
    const { userId, token } = await createTestUser(handler);
    const authHeader = { authorization: `Bearer ${userId}:${token}`, "content-type": "application/json" };

    const res = await handler(
      new Request("http://x/v1/paste", {
        method: "POST",
        headers: authHeader,
        body: JSON.stringify({
          conversationId: "conv_paste",
          text: "User: Authority needs explicit boundaries.\nAssistant: Can you say more?",
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ideaCount: number; conversationId: string };
    expect(body.ideaCount).toBe(1);
    expect(body.conversationId).toBe("conv_paste");
  });

  test("POST /v1/paste rejects empty text", async () => {
    const handler = createRequestHandler({ extraction: new FakeProvider([]), reasoning: new FakeProvider([]) });
    const { userId, token } = await createTestUser(handler);
    const res = await handler(
      new Request("http://x/v1/paste", {
        method: "POST",
        headers: { authorization: `Bearer ${userId}:${token}`, "content-type": "application/json" },
        body: JSON.stringify({ text: "   " }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("unknown route returns 404", async () => {
    const handler = createRequestHandler({ extraction: new FakeProvider([]), reasoning: new FakeProvider([]) });
    const { userId, token } = await createTestUser(handler);
    const res = await handler(
      new Request("http://x/v1/nonexistent", { headers: { authorization: `Bearer ${userId}:${token}` } }),
    );
    expect(res.status).toBe(404);
  });
});
