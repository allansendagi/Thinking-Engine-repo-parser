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
  // This suite drives many synthetic clients from one (absent) IP; the per-IP limiter would
  // otherwise 429 them. One test below re-enables it deliberately.
  process.env.THREAD_RATE_LIMIT = "off";
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.THREAD_REGISTRY_PATH;
  delete process.env.THREAD_DATA_DIR;
  delete process.env.THREAD_RATE_LIMIT;
});

function extractionResponse(events: object[]): string {
  return JSON.stringify({ events });
}

async function createTestUser(handler: (req: Request) => Promise<Response>) {
  const res = await handler(
    new Request("http://x/v1/users", { method: "POST" }),
  );
  return (await res.json()) as { userId: string; token: string };
}

describe("HTTP handler (fetch against the pure handler, no network port)", () => {
  test("health check needs no auth", async () => {
    const handler = createRequestHandler({
      extraction: new FakeProvider([]),
      reasoning: new FakeProvider([]),
    });
    const res = await handler(new Request("http://x/v1/health"));
    expect(res.status).toBe(200);
    const health = (await res.json()) as { status: string; storage: string };
    expect(health.status).toBe("ok");
    // storage mode is reported so monitoring can catch an ephemeral deploy; the tests set
    // THREAD_REGISTRY_PATH, so it's "explicit" here.
    expect(health.storage).toBe("explicit");
  });

  test("protected routes reject missing or wrong credentials", async () => {
    const handler = createRequestHandler({
      extraction: new FakeProvider([]),
      reasoning: new FakeProvider([]),
    });
    const noAuth = await handler(new Request("http://x/v1/thinking-state"));
    expect(noAuth.status).toBe(401);

    const { userId } = await createTestUser(handler);
    const wrongToken = await handler(
      new Request("http://x/v1/thinking-state", {
        headers: { authorization: `Bearer ${userId}:${"0".repeat(64)}` },
      }),
    );
    expect(wrongToken.status).toBe(401);
  });

  test("create user -> ingest a conversation -> read it back via the API", async () => {
    const handler = createRequestHandler({
      extraction: new FakeProvider([
        extractionResponse([
          {
            type: "new_idea",
            statement: "Authority needs explicit boundaries.",
            confidence: 0.9,
            source_event_id: "m1",
            evidence_quote: "explicit boundaries",
          },
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
          messages: [
            {
              id: "m1",
              role: "user",
              text: "Authority needs explicit boundaries.",
              createdAt: "2026-08-17T00:00:00.000Z",
            },
          ],
        }),
      }),
    );
    expect(ingestRes.status).toBe(200);
    const ingestBody = (await ingestRes.json()) as { ideaCount: number };
    expect(ingestBody.ideaCount).toBe(1);

    const stateRes = await handler(
      new Request("http://x/v1/thinking-state", { headers: authHeader }),
    );
    const state = (await stateRes.json()) as {
      currentIdeas: { title: string }[];
    };
    expect(state.currentIdeas).toHaveLength(1);
    expect(state.currentIdeas[0]?.title).toContain("Authority");

    const searchRes = await handler(
      new Request("http://x/v1/ideas?q=authority%20boundaries", {
        headers: authHeader,
      }),
    );
    const results = (await searchRes.json()) as { id: string }[];
    expect(results.length).toBeGreaterThan(0);

    // The source-conversation bridge: an idea's trace carries the conversation id, and
    // GET /v1/conversations/:id returns the captured messages.
    const ideaId = results[0]!.id;
    const traceRes = await handler(
      new Request(`http://x/v1/ideas/${encodeURIComponent(ideaId)}/trace`, {
        headers: authHeader,
      }),
    );
    const trace = (await traceRes.json()) as {
      provenance: { conversationId: string | null }[];
    };
    expect(trace.provenance[0]?.conversationId).toBe("conv_1");

    const convRes = await handler(
      new Request("http://x/v1/conversations/conv_1", { headers: authHeader }),
    );
    expect(convRes.status).toBe(200);
    const conv = (await convRes.json()) as {
      conversationId: string;
      source: string;
      messages: { role: string; text: string; index: number }[];
    };
    expect(conv.conversationId).toBe("conv_1");
    expect(conv.source).toBe("fixture");
    expect(conv.messages[0]).toMatchObject({
      role: "user",
      text: "Authority needs explicit boundaries.",
      index: 0,
    });

    const missing = await handler(
      new Request("http://x/v1/conversations/nope", { headers: authHeader }),
    );
    expect(missing.status).toBe(404);

    const noAuthConv = await handler(
      new Request("http://x/v1/conversations/conv_1"),
    );
    expect(noAuthConv.status).toBe(401);

    // Activity feed: the conversation is listed, with the idea it moved.
    const listRes = await handler(
      new Request("http://x/v1/conversations", { headers: authHeader }),
    );
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as {
      conversations: {
        conversationId: string;
        source: string;
        messageCount: number;
        ideas: { id: string; title: string }[];
      }[];
    };
    const row = list.conversations.find((c) => c.conversationId === "conv_1");
    expect(row).toBeDefined();
    expect(row!.messageCount).toBe(1);
    expect(row!.ideas.map((i) => i.id)).toContain(ideaId);
  });

  test("POST /v1/import ingests a batch of an exported conversations.json", async () => {
    const handler = createRequestHandler({
      extraction: new FakeProvider([
        extractionResponse([
          {
            type: "new_idea",
            statement: "Authority must be independently verifiable.",
            confidence: 0.95,
            source_event_id: "backfill-n1",
            evidence_quote: "independently verifiable",
          },
        ]),
      ]),
      reasoning: new FakeProvider([]),
    });
    const { userId, token } = await createTestUser(handler);
    const authHeader = {
      authorization: `Bearer ${userId}:${token}`,
      "content-type": "application/json",
    };

    const chatgptBatch = [
      {
        id: "hist_conv_1",
        current_node: "backfill-n1",
        mapping: {
          "backfill-n1": {
            id: "backfill-n1",
            parent: null,
            children: [],
            message: {
              id: "backfill-n1",
              author: { role: "user" },
              content: {
                content_type: "text",
                parts: ["Authority must be independently verifiable."],
              },
              create_time: 1_723_000_000,
            },
          },
        },
      },
    ];

    const res = await handler(
      new Request("http://x/v1/import", {
        method: "POST",
        headers: authHeader,
        body: JSON.stringify({
          format: "chatgpt",
          conversations: chatgptBatch,
        }),
      }),
    );
    expect(res.status).toBe(200);
    const summary = (await res.json()) as {
      newCanonicalEvents: number;
      ideaCount: number;
    };
    expect(summary.newCanonicalEvents).toBe(1);
    expect(summary.ideaCount).toBe(1);

    // Re-sending the same batch is a no-op (idempotent).
    const again = await handler(
      new Request("http://x/v1/import", {
        method: "POST",
        headers: authHeader,
        body: JSON.stringify({
          format: "chatgpt",
          conversations: chatgptBatch,
        }),
      }),
    );
    expect(
      ((await again.json()) as { newCanonicalEvents: number })
        .newCanonicalEvents,
    ).toBe(0);

    // The imported idea is visible in the graph.
    const state = (await (
      await handler(
        new Request("http://x/v1/thinking-state", { headers: authHeader }),
      )
    ).json()) as { currentIdeas: { title: string }[] };
    expect(state.currentIdeas.some((i) => i.title.includes("Authority"))).toBe(
      true,
    );

    // Bad shape and bad format are rejected; no auth is 401.
    expect(
      (
        await handler(
          new Request("http://x/v1/import", {
            method: "POST",
            headers: authHeader,
            body: JSON.stringify({ format: "chatgpt", conversations: "nope" }),
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handler(
          new Request("http://x/v1/import", {
            method: "POST",
            headers: authHeader,
            body: JSON.stringify({ format: "aol", conversations: [] }),
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handler(
          new Request("http://x/v1/import", {
            method: "POST",
            body: JSON.stringify({ format: "chatgpt", conversations: [] }),
          }),
        )
      ).status,
    ).toBe(401);
  });

  test("one user cannot read another user's data even with a valid token for a different account", async () => {
    const handler = createRequestHandler({
      extraction: new FakeProvider([
        extractionResponse([
          {
            type: "new_idea",
            statement: "User A's private idea.",
            confidence: 0.9,
            source_event_id: "m1",
            evidence_quote: "private idea",
          },
        ]),
      ]),
      reasoning: new FakeProvider([]),
    });

    const userA = await createTestUser(handler);
    await handler(
      new Request("http://x/v1/conversations", {
        method: "POST",
        headers: {
          authorization: `Bearer ${userA.userId}:${userA.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          conversationId: "conv_a",
          source: "fixture",
          messages: [
            {
              id: "m1",
              role: "user",
              text: "User A's private idea.",
              createdAt: "2026-08-17T00:00:00.000Z",
            },
          ],
        }),
      }),
    );

    const userB = await createTestUser(handler);
    const bReadsState = await handler(
      new Request("http://x/v1/thinking-state", {
        headers: { authorization: `Bearer ${userB.userId}:${userB.token}` },
      }),
    );
    const bState = (await bReadsState.json()) as { currentIdeas: unknown[] };
    expect(bState.currentIdeas).toHaveLength(0); // B's DB is separate; A's idea never appears
  });

  test("correction endpoints: rename, change state, resolve an open loop, then delete", async () => {
    const handler = createRequestHandler({
      extraction: new FakeProvider([
        extractionResponse([
          {
            type: "new_idea",
            statement: "Authority needs explicit boundaries.",
            confidence: 0.9,
            source_event_id: "m1",
            evidence_quote: "explicit boundaries",
          },
        ]),
      ]),
      reasoning: new FakeProvider([]),
    });
    const { userId, token } = await createTestUser(handler);
    const authHeader = {
      authorization: `Bearer ${userId}:${token}`,
      "content-type": "application/json",
    };

    await handler(
      new Request("http://x/v1/conversations", {
        method: "POST",
        headers: authHeader,
        body: JSON.stringify({
          conversationId: "conv_1",
          source: "fixture",
          messages: [
            {
              id: "m1",
              role: "user",
              text: "Authority needs explicit boundaries.",
              createdAt: "2026-08-17T00:00:00.000Z",
            },
          ],
        }),
      }),
    );
    const state = (await (
      await handler(
        new Request("http://x/v1/thinking-state", { headers: authHeader }),
      )
    ).json()) as {
      currentIdeas: { id: string }[];
    };
    const ideaId = state.currentIdeas[0]?.id as string;

    const renameRes = await handler(
      new Request(`http://x/v1/ideas/${ideaId}`, {
        method: "PATCH",
        headers: authHeader,
        body: JSON.stringify({ title: "Computable Authority" }),
      }),
    );
    expect(renameRes.status).toBe(200);
    expect(((await renameRes.json()) as { title: string }).title).toBe(
      "Computable Authority",
    );

    const rejectRes = await handler(
      new Request(`http://x/v1/ideas/${ideaId}`, {
        method: "PATCH",
        headers: authHeader,
        body: JSON.stringify({ state: "rejected" }),
      }),
    );
    expect(((await rejectRes.json()) as { state: string }).state).toBe(
      "rejected",
    );

    const badStateRes = await handler(
      new Request(`http://x/v1/ideas/${ideaId}`, {
        method: "PATCH",
        headers: authHeader,
        body: JSON.stringify({ state: "not_a_state" }),
      }),
    );
    expect(badStateRes.status).toBe(400);

    const deleteRes = await handler(
      new Request(`http://x/v1/ideas/${ideaId}`, {
        method: "DELETE",
        headers: authHeader,
      }),
    );
    expect(deleteRes.status).toBe(200);

    const deleteAgainRes = await handler(
      new Request(`http://x/v1/ideas/${ideaId}`, {
        method: "DELETE",
        headers: authHeader,
      }),
    );
    expect(deleteAgainRes.status).toBe(404);

    const finalState = (await (
      await handler(
        new Request("http://x/v1/thinking-state", { headers: authHeader }),
      )
    ).json()) as {
      currentIdeas: unknown[];
    };
    expect(finalState.currentIdeas).toHaveLength(0);
  });

  test("POST /v1/paste parses a labeled conversation and ingests it", async () => {
    const handler = createRequestHandler({
      extraction: new FakeProvider([
        extractionResponse([
          {
            type: "new_idea",
            statement: "Authority needs explicit boundaries.",
            confidence: 0.9,
            source_event_id: "conv_paste::0",
            evidence_quote: "explicit boundaries",
          },
        ]),
      ]),
      reasoning: new FakeProvider([]),
    });
    const { userId, token } = await createTestUser(handler);
    const authHeader = {
      authorization: `Bearer ${userId}:${token}`,
      "content-type": "application/json",
    };

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
    const body = (await res.json()) as {
      ideaCount: number;
      conversationId: string;
    };
    expect(body.ideaCount).toBe(1);
    expect(body.conversationId).toBe("conv_paste");

    // The idea id derives from a paste source id (`conv_paste::0`), so it contains `::` -- a
    // strict HTTP client (the Mac app) can only send that percent-encoded. The handler must
    // decode the path segment back before the lookup.
    const state = (await (
      await handler(
        new Request("http://x/v1/thinking-state", { headers: authHeader }),
      )
    ).json()) as {
      currentIdeas: { id: string }[];
    };
    const ideaId = state.currentIdeas[0]!.id;
    expect(ideaId).toContain("::");
    const encoded = encodeURIComponent(ideaId);
    expect(encoded).not.toBe(ideaId); // proves the id actually needs encoding
    const trace = await handler(
      new Request(`http://x/v1/ideas/${encoded}/trace`, {
        headers: authHeader,
      }),
    );
    expect(trace.status).toBe(200);
  });

  test("POST /v1/paste rejects empty text", async () => {
    const handler = createRequestHandler({
      extraction: new FakeProvider([]),
      reasoning: new FakeProvider([]),
    });
    const { userId, token } = await createTestUser(handler);
    const res = await handler(
      new Request("http://x/v1/paste", {
        method: "POST",
        headers: {
          authorization: `Bearer ${userId}:${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ text: "   " }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("unknown route returns 404", async () => {
    const handler = createRequestHandler({
      extraction: new FakeProvider([]),
      reasoning: new FakeProvider([]),
    });
    const { userId, token } = await createTestUser(handler);
    const res = await handler(
      new Request("http://x/v1/nonexistent", {
        headers: { authorization: `Bearer ${userId}:${token}` },
      }),
    );
    expect(res.status).toBe(404);
  });

  test("GET /v1/account reports a fresh user as Free, capture allowed", async () => {
    const handler = createRequestHandler({
      extraction: new FakeProvider([]),
      reasoning: new FakeProvider([]),
    });
    const { userId, token } = await createTestUser(handler);
    const res = await handler(
      new Request("http://x/v1/account", {
        headers: { authorization: `Bearer ${userId}:${token}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      plan: string;
      isPro: boolean;
      canCapture: boolean;
      ideaCount: number;
      ideaCap: number;
      billingEnabled: boolean;
    };
    expect(body.plan).toBe("free");
    expect(body.isPro).toBe(false);
    expect(body.canCapture).toBe(true);
    expect(body.ideaCount).toBe(0);
    expect(body.ideaCap).toBe(25);
    expect(body.billingEnabled).toBe(false); // no PADDLE_* env in tests
  });

  test("email sign-in: start -> verify returns a working bearer; same email is idempotent (per-device token, others stay live)", async () => {
    const handler = createRequestHandler({
      extraction: new FakeProvider([]),
      reasoning: new FakeProvider([]),
    });
    const j = { "content-type": "application/json" };
    const email = `signin-${Date.now()}@example.com`;

    const codeFromLog = async () => {
      // The dev mailer logs the code; issue + read it back deterministically instead.
      const { issueCode } = await import("./authCodes");
      return issueCode(email);
    };

    // start (returns ok regardless of whether the account exists)
    const started = await handler(
      new Request("http://x/v1/auth/start", {
        method: "POST",
        headers: j,
        body: JSON.stringify({ email }),
      }),
    );
    expect(started.status).toBe(200);

    // wrong code
    const bad = await handler(
      new Request("http://x/v1/auth/verify", {
        method: "POST",
        headers: j,
        body: JSON.stringify({ email, code: "000000" }),
      }),
    );
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code: string }).code).toBe("bad_code");

    // real code -> new account
    const first = await handler(
      new Request("http://x/v1/auth/verify", {
        method: "POST",
        headers: j,
        body: JSON.stringify({ email, code: await codeFromLog() }),
      }),
    );
    const a = (await first.json()) as { userId: string; token: string };
    expect(a.userId).toMatch(/^user_[a-f0-9]{24}$/);

    const acct = await handler(
      new Request("http://x/v1/account", {
        headers: { authorization: `Bearer ${a.userId}:${a.token}` },
      }),
    );
    expect(((await acct.json()) as { email: string }).email).toBe(email);

    // same email again (a second device) -> same account, a distinct token...
    const second = await handler(
      new Request("http://x/v1/auth/verify", {
        method: "POST",
        headers: j,
        body: JSON.stringify({ email, code: await codeFromLog() }),
      }),
    );
    const b = (await second.json()) as { userId: string; token: string };
    expect(b.userId).toBe(a.userId);
    expect(b.token).not.toBe(a.token);

    // ...and the first device's token is STILL valid -- tokens are per-device.
    const firstStillWorks = await handler(
      new Request("http://x/v1/thinking-state", {
        headers: { authorization: `Bearer ${a.userId}:${a.token}` },
      }),
    );
    expect(firstStillWorks.status).toBe(200);
    const secondWorks = await handler(
      new Request("http://x/v1/thinking-state", {
        headers: { authorization: `Bearer ${b.userId}:${b.token}` },
      }),
    );
    expect(secondWorks.status).toBe(200);
  });

  test("claim: an anonymous account attaches an email and keeps its data", async () => {
    const handler = createRequestHandler({
      extraction: new FakeProvider([]),
      reasoning: new FakeProvider([]),
    });
    const { issueCode } = await import("./authCodes");

    const anon = await createTestUser(handler);
    const auth = {
      authorization: `Bearer ${anon.userId}:${anon.token}`,
      "content-type": "application/json",
    };
    const email = `claim-${Date.now()}@example.com`;

    await handler(
      new Request("http://x/v1/account/email", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ email }),
      }),
    );
    const claimed = await handler(
      new Request("http://x/v1/account/email/verify", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ email, code: await issueCode(email) }),
      }),
    );
    expect(claimed.status).toBe(200);
    expect(((await claimed.json()) as { email: string }).email).toBe(email);
  });

  test("claim: an email on an account that has ideas 409s; an email on an empty account is reclaimed", async () => {
    const handler = createRequestHandler({
      extraction: new FakeProvider([]),
      reasoning: new FakeProvider([]),
    });
    const { issueCode } = await import("./authCodes");
    const { openUserDb } = await import("../db/tenancy");
    const hdr = (u: { userId: string; token: string }) => ({
      authorization: `Bearer ${u.userId}:${u.token}`,
      "content-type": "application/json",
    });
    const claim = async (
      u: { userId: string; token: string },
      email: string,
    ) => {
      await handler(
        new Request("http://x/v1/account/email", {
          method: "POST",
          headers: hdr(u),
          body: JSON.stringify({ email }),
        }),
      );
      return handler(
        new Request("http://x/v1/account/email/verify", {
          method: "POST",
          headers: hdr(u),
          body: JSON.stringify({ email, code: await issueCode(email) }),
        }),
      );
    };

    // --- email held by an account WITH data -> 409 ---
    const withData = await createTestUser(handler);
    const emailA = `hasdata-${Date.now()}@example.com`;
    expect((await claim(withData, emailA)).status).toBe(200);
    const seed = openUserDb(withData.userId);
    seed
      .prepare(
        "INSERT INTO idea_nodes (id, title, state, current_formulation, created_at, updated_at) VALUES (?, 't', 'developing', 'f', ?, ?)",
      )
      .run("idea_x", new Date().toISOString(), new Date().toISOString());
    seed.close();

    const rival = await createTestUser(handler);
    const blocked = await claim(rival, emailA);
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { code: string }).code).toBe(
      "email_in_use",
    );

    // --- email held by an EMPTY account -> reclaimed, not blocked ---
    const strayWeb = await createTestUser(handler); // never captured anything
    const emailB = `stray-${Date.now()}@example.com`;
    expect((await claim(strayWeb, emailB)).status).toBe(200);

    const macWithIdeas = await createTestUser(handler);
    openUserDb(macWithIdeas.userId)
      .prepare(
        "INSERT INTO idea_nodes (id, title, state, current_formulation, created_at, updated_at) VALUES (?, 't', 'developing', 'f', ?, ?)",
      )
      .run("idea_y", new Date().toISOString(), new Date().toISOString());

    const reclaimed = await claim(macWithIdeas, emailB);
    expect(reclaimed.status).toBe(200);
    const body = (await reclaimed.json()) as {
      email: string;
      reclaimedFromEmptyAccount?: boolean;
    };
    expect(body.email).toBe(emailB);
    expect(body.reclaimedFromEmptyAccount).toBe(true);

    // the stray account no longer holds the email
    const strayAcct = await handler(
      new Request("http://x/v1/account", { headers: hdr(strayWeb) }),
    );
    expect(
      ((await strayAcct.json()) as { email: string | null }).email,
    ).toBeNull();
  });

  test("capture gate: Free plan 402s at the 25-idea cap (only when billing configured); reads still work", async () => {
    const { setPlan } = await import("./auth");
    const handler = createRequestHandler({
      extraction: new FakeProvider([]),
      reasoning: new FakeProvider([]),
    });
    const { userId, token } = await createTestUser(handler);
    const authHeader = {
      authorization: `Bearer ${userId}:${token}`,
      "content-type": "application/json",
    };

    // Seed 25 idea nodes directly in the user's DB.
    const { openUserDb } = await import("../db/tenancy");
    const seed = openUserDb(userId);
    const stmt = seed.prepare(
      "INSERT INTO idea_nodes (id, title, state, current_formulation, created_at, updated_at) VALUES (?, ?, 'developing', ?, ?, ?)",
    );
    const nowIso = new Date().toISOString();
    for (let i = 0; i < 25; i++)
      stmt.run(`idea_${i}`, `t${i}`, `f${i}`, nowIso, nowIso);
    seed.close();

    const capture = () =>
      handler(
        new Request("http://x/v1/conversations", {
          method: "POST",
          headers: authHeader,
          body: JSON.stringify({
            conversationId: "c1",
            source: "chatgpt",
            messages: [],
          }),
        }),
      );

    // Billing not configured -> gate is a no-op.
    expect((await capture()).status).not.toBe(402);

    process.env.PADDLE_API_KEY = "pdl_test";
    process.env.PADDLE_PRICE_ID = "pri_test";
    process.env.PADDLE_WEBHOOK_SECRET = "whsec_test";
    try {
      const gated = await capture();
      expect(gated.status).toBe(402);
      expect(((await gated.json()) as { code: string }).code).toBe(
        "upgrade_required",
      );

      const read = await handler(
        new Request("http://x/v1/thinking-state", { headers: authHeader }),
      );
      expect(read.status).toBe(200);

      // /v1/continue is NOT gated -- the continuation packet is free (deterministic from the
      // idea's own provenance). A Free account gets it back with tier:"free", meaning the
      // server used the template for the one model-written line and the client sharpens it
      // on-device. Only the frontier-model call for that line is Pro.
      const cont = await handler(
        new Request("http://x/v1/continue", {
          method: "POST",
          headers: authHeader,
          body: JSON.stringify({ topic: "t0" }),
        }),
      );
      expect(cont.status).toBe(200);
      expect(((await cont.json()) as { tier: string }).tier).toBe("free");

      // An active Pro account is not capture-gated, and its continuation is tier:"pro".
      setPlan(userId, { plan: "pro", status: "active" });
      expect((await capture()).status).not.toBe(402);
      const proCont = await handler(
        new Request("http://x/v1/continue", {
          method: "POST",
          headers: authHeader,
          body: JSON.stringify({ ideaId: "idea_0" }),
        }),
      );
      expect(proCont.status).toBe(200);
      expect(((await proCont.json()) as { tier: string }).tier).toBe("pro");

      // /v1/continue by exact ideaId returns { text, packet }; the reasoning provider is empty
      // here, so suggestedNext falls back to a template rather than erroring.
      const packetRes = await handler(
        new Request("http://x/v1/continue", {
          method: "POST",
          headers: authHeader,
          body: JSON.stringify({ ideaId: "idea_0" }),
        }),
      );
      expect(packetRes.status).toBe(200);
      const cp = (await packetRes.json()) as {
        text: string;
        packet: {
          idea: { id: string };
          whereYouLeftOff: string;
          suggestedNext: string;
        };
      };
      expect(cp.packet.idea.id).toBe("idea_0");
      expect(cp.packet.whereYouLeftOff).toBe("f0");
      expect(cp.text).toContain("CURRENT IDEA");
      expect(cp.text).toContain("TASK");
      expect(cp.packet.suggestedNext.length).toBeGreaterThan(0);
      // The endpoint hands back the render with the token still in place; the client fills it.
      expect(cp.text).toContain("{{CONTINUE_FROM_HERE}}");
      expect(cp.text).not.toContain(cp.packet.suggestedNext);

      const missing = await handler(
        new Request("http://x/v1/continue", {
          method: "POST",
          headers: authHeader,
          body: JSON.stringify({ ideaId: "idea_nope" }),
        }),
      );
      expect(missing.status).toBe(404);
    } finally {
      delete process.env.PADDLE_API_KEY;
      delete process.env.PADDLE_PRICE_ID;
      delete process.env.PADDLE_WEBHOOK_SECRET;
    }
  });

  test("download counter: public POST records; summary is admin-only", async () => {
    const handler = createRequestHandler({
      extraction: new FakeProvider([]),
      reasoning: new FakeProvider([]),
    });
    const { issueCode } = await import("./authCodes");

    // Public, no auth: three downloads.
    for (let i = 0; i < 3; i++) {
      const r = await handler(
        new Request("http://x/v1/events/download", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-vercel-ip-country": "QA",
          },
          body: JSON.stringify({
            platform: "mac",
            version: "0.2.0",
            referrer: "https://threadnow.app/",
          }),
        }),
      );
      expect(r.status).toBe(204);
    }
    // A malformed body still 204s (best-effort).
    expect(
      (
        await handler(
          new Request("http://x/v1/events/download", { method: "POST" }),
        )
      ).status,
    ).toBe(204);

    // Summary needs auth AND an admin email.
    const nonAdmin = await createTestUser(handler);
    const na = { authorization: `Bearer ${nonAdmin.userId}:${nonAdmin.token}` };
    expect(
      (await handler(new Request("http://x/v1/events/downloads"))).status,
    ).toBe(401);
    expect(
      (
        await handler(
          new Request("http://x/v1/events/downloads", { headers: na }),
        )
      ).status,
    ).toBe(403);

    const adminEmail = `admin-${Date.now()}@example.com`;
    process.env.THREAD_ADMIN_EMAILS = ` other@x.com , ${adminEmail} `;
    try {
      const start = await handler(
        new Request("http://x/v1/auth/verify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email: adminEmail,
            code: await issueCode(adminEmail),
          }),
        }),
      );
      const admin = (await start.json()) as { userId: string; token: string };
      const res = await handler(
        new Request("http://x/v1/events/downloads?days=7", {
          headers: { authorization: `Bearer ${admin.userId}:${admin.token}` },
        }),
      );
      expect(res.status).toBe(200);
      const s = (await res.json()) as {
        total: number;
        byVersion: { version: string; count: number }[];
        byCountry: { country: string; count: number }[];
      };
      expect(s.total).toBe(4); // 3 good + 1 empty-body (defaults to platform "mac")
      expect(s.byVersion.find((v) => v.version === "0.2.0")?.count).toBe(3);
      expect(s.byCountry.find((c) => c.country === "QA")?.count).toBe(3);
    } finally {
      delete process.env.THREAD_ADMIN_EMAILS;
    }
  });

  test("waitlist: public POST validates + dedupes; the actual list is admin-only", async () => {
    const handler = createRequestHandler({
      extraction: new FakeProvider([]),
      reasoning: new FakeProvider([]),
    });
    const { issueCode } = await import("./authCodes");
    const post = (body: unknown) =>
      handler(
        new Request("http://x/v1/waitlist", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-vercel-ip-country": "QA",
          },
          body: JSON.stringify(body),
        }),
      );

    // No auth needed. A bad email is rejected, not silently swallowed (unlike the download
    // beacon) -- this is a real submission a person is waiting on.
    expect((await post({ email: "not-an-email" })).status).toBe(400);
    expect((await post({})).status).toBe(400);

    const email = `waiter-${Date.now()}@example.com`;
    const first = await post({
      email,
      name: "A. Waiter",
      note: "Excited to try Continue.",
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, alreadyJoined: false });

    // Same email again (any case) -- idempotent, not an error, and says so.
    const again = await post({ email: email.toUpperCase() });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, alreadyJoined: true });

    // Reading the actual list needs auth AND an admin email -- same gate as downloads.
    const nonAdmin = await createTestUser(handler);
    const na = { authorization: `Bearer ${nonAdmin.userId}:${nonAdmin.token}` };
    expect((await handler(new Request("http://x/v1/waitlist"))).status).toBe(
      401,
    );
    expect(
      (await handler(new Request("http://x/v1/waitlist", { headers: na })))
        .status,
    ).toBe(403);

    const adminEmail = `admin-waitlist-${Date.now()}@example.com`;
    process.env.THREAD_ADMIN_EMAILS = adminEmail;
    try {
      const start = await handler(
        new Request("http://x/v1/auth/verify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email: adminEmail,
            code: await issueCode(adminEmail),
          }),
        }),
      );
      const admin = (await start.json()) as { userId: string; token: string };
      const res = await handler(
        new Request("http://x/v1/waitlist", {
          headers: { authorization: `Bearer ${admin.userId}:${admin.token}` },
        }),
      );
      expect(res.status).toBe(200);
      const s = (await res.json()) as {
        total: number;
        entries: { email: string; name: string | null; note: string | null }[];
      };
      const entry = s.entries.find((e) => e.email === email.toLowerCase());
      expect(entry).toBeDefined();
      expect(entry?.name).toBe("A. Waiter");
      expect(entry?.note).toBe("Excited to try Continue.");
      // Deduped: exactly one row for the two submissions of the same email above.
      expect(
        s.entries.filter((e) => e.email === email.toLowerCase()),
      ).toHaveLength(1);
    } finally {
      delete process.env.THREAD_ADMIN_EMAILS;
    }
  });

  test("per-IP rate limiter guards the unauthenticated routes", async () => {
    const handler = createRequestHandler({
      extraction: new FakeProvider([]),
      reasoning: new FakeProvider([]),
    });
    const { __resetRateLimiter } = await import("./rateLimit");
    delete process.env.THREAD_RATE_LIMIT; // re-enable for this test only
    __resetRateLimiter();
    try {
      const ip = "198.51.100.7";
      const mk = () =>
        handler(
          new Request("http://x/v1/users", {
            method: "POST",
            headers: { "x-forwarded-for": ip },
          }),
        );
      let sawCreated = 0;
      let saw429 = false;
      for (let i = 0; i < 20; i++) {
        const r = await mk();
        if (r.status === 201) sawCreated++;
        if (r.status === 429) saw429 = true;
      }
      expect(sawCreated).toBeGreaterThan(0);
      expect(sawCreated).toBeLessThanOrEqual(15);
      expect(saw429).toBe(true);

      // A different IP is unaffected.
      const other = await handler(
        new Request("http://x/v1/users", {
          method: "POST",
          headers: { "x-forwarded-for": "203.0.113.42" },
        }),
      );
      expect(other.status).toBe(201);
    } finally {
      process.env.THREAD_RATE_LIMIT = "off";
      __resetRateLimiter();
    }
  });
});
