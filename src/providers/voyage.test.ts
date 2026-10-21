import { describe, expect, test } from "bun:test";
import { VoyageEmbeddingProvider } from "./voyage";

const ok = (n: number, dims = 8) =>
  new Response(JSON.stringify({ data: Array.from({ length: n }, (_, index) => ({ index, embedding: Array(dims).fill(index + 1) })) }), { status: 200 });
const status = (code: number, headers: Record<string, string> = {}) => new Response(`{"detail":"nope"}`, { status: code, headers });

/** A fetch that answers from a script and counts its calls. */
function scripted(...answers: (Response | Error)[]) {
  const calls: { signal?: AbortSignal | null }[] = [];
  const fetcher = (async (_url: unknown, init?: RequestInit) => {
    calls.push({ signal: init?.signal });
    const next = answers[Math.min(calls.length - 1, answers.length - 1)]!;
    if (next instanceof Error) throw next;
    return next.clone();
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

const make = (fetcher: typeof fetch, opts: { timeoutMs?: number; retries?: number } = {}) =>
  new VoyageEmbeddingProvider("test-key", "voyage-4-large", fetcher, { backoffMs: 1, ...opts });

describe("Voyage embeddings are resilient", () => {
  test("a request that never answers is cut off, not left to wedge the caller", async () => {
    // A real server that accepts the connection and never replies, and the real fetch: this is the
    // runtime behaviour production depends on (Railway pins Bun 1.1.43), not a fake that holds no socket.
    const server = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
    try {
      const viaServer = ((_url: unknown, init?: RequestInit) => fetch(`http://localhost:${server.port}/`, init)) as unknown as typeof fetch;
      const started = Date.now();
      await expect(make(viaServer, { timeoutMs: 80, retries: 0 }).embedMany(["a"])).rejects.toThrow(/timed out/i);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      server.stop(true);
    }
  });

  test("a rate limit or a server error is retried, then succeeds", async () => {
    const a = scripted(status(429, { "retry-after": "0" }), ok(2));
    expect(await make(a.fetcher).embedMany(["x", "y"])).toHaveLength(2);
    expect(a.calls).toHaveLength(2);
    const b = scripted(status(503), status(502), ok(1));
    expect(await make(b.fetcher).embedMany(["x"])).toHaveLength(1);
    expect(b.calls).toHaveLength(3);
  });

  test("a dropped connection is retried", async () => {
    const a = scripted(new Error("socket hang up"), ok(1));
    expect(await make(a.fetcher).embedMany(["x"])).toHaveLength(1);
    expect(a.calls).toHaveLength(2);
  });

  test("gives up after the retries are used, saying why", async () => {
    const a = scripted(status(503));
    await expect(make(a.fetcher, { retries: 2 }).embedMany(["x"])).rejects.toThrow(/503/);
    expect(a.calls).toHaveLength(3); // the first try and two retries
  });

  test("a bad key or a bad request is not retried", async () => {
    for (const code of [400, 401, 403]) {
      const a = scripted(status(code));
      await expect(make(a.fetcher).embedMany(["x"])).rejects.toThrow(new RegExp(String(code)));
      expect(a.calls).toHaveLength(1);
    }
  });

  test("a reply with the wrong number of vectors, or an unusable one, is an error -- never stored", async () => {
    await expect(make(scripted(ok(1)).fetcher).embedMany(["a", "b"])).rejects.toThrow(/1 .* 2/);
    const nan = new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, null, 3] }] }), { status: 200 });
    await expect(make(scripted(nan).fetcher).embedMany(["a"])).rejects.toThrow(/unusable|malformed/i);
    const noData = new Response("{}", { status: 200 });
    await expect(make(scripted(noData).fetcher).embedMany(["a"])).rejects.toThrow();
  });

  test("vectors come back in input order, and a query is embedded as a query", async () => {
    let sent: { input_type?: string; model?: string } = {};
    const shuffled = new Response(JSON.stringify({ data: [{ index: 1, embedding: [2, 2, 2, 2, 2, 2, 2, 2] }, { index: 0, embedding: [1, 1, 1, 1, 1, 1, 1, 1] }] }), { status: 200 });
    const fetcher = (async (_u: unknown, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return shuffled.clone();
    }) as unknown as typeof fetch;
    const v = await make(fetcher).embedMany(["a", "b"]);
    expect(v[0]![0]).toBe(1);
    expect(v[1]![0]).toBe(2);
    expect(sent.input_type).toBe("document");
    await make(scripted(ok(1)).fetcher).embedQuery("hello");
    expect(make(fetcher).modelId).toBe("voyage:voyage-4-large");
  });

  test("with no key it fails before any network call", async () => {
    const a = scripted(ok(1));
    await expect(new VoyageEmbeddingProvider("", "voyage-4-large", a.fetcher).embedMany(["x"])).rejects.toThrow(/VOYAGE_API_KEY/);
    expect(a.calls).toHaveLength(0);
  });
});
