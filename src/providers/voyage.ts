import type { EmbeddingProvider } from "./types";

/**
 * Cloud FALLBACK for meaning-vectors. Thread is native-first: thoughts are embedded on the Mac
 * with Apple's on-device model (see macos-app ThoughtVectorSync). This provider exists only for
 * thoughts no Mac has embedded yet, and only when VOYAGE_API_KEY is set -- unset (the default)
 * means it's never constructed and nothing leaves the server for embedding.
 *
 * Default voyage-4-large: the best on the held-out thinking bench (grouping F1 80.8% vs 75.1% for
 * voyage-4-lite and 65.4% for Apple's on-device model; wrong merges of look-alike ideas 1 vs 8).
 * Idea statements are a few dozen tokens, so cost is negligible: $0.12 per million tokens after
 * 200M free tokens per model (lite is $0.02; voyage-4 $0.06). Override with VOYAGE_MODEL.
 */
export const VOYAGE_MODEL = process.env.VOYAGE_MODEL ?? "voyage-4-large";

export function voyageConfigured(): boolean {
  return !!process.env.VOYAGE_API_KEY;
}

export interface VoyageOptions {
  /** Per attempt. A request that never answers must not hold up a user's mining pass or a search. */
  timeoutMs?: number;
  /** Retries after the first try, for a rate limit (429), a server error (5xx) or a dropped connection. */
  retries?: number;
  /** First retry delay; doubles each time (a `Retry-After` header wins, capped). */
  backoffMs?: number;
}

const RETRY_AFTER_CAP_MS = 5_000;
const retryable = (status: number) => status === 429 || status >= 500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class VoyageEmbeddingProvider implements EmbeddingProvider {
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly backoffMs: number;

  constructor(
    private readonly apiKey: string = process.env.VOYAGE_API_KEY ?? "",
    private readonly model: string = VOYAGE_MODEL,
    private readonly fetcher: typeof fetch = fetch,
    options: VoyageOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.retries = options.retries ?? 2;
    this.backoffMs = options.backoffMs ?? 400;
  }

  async embed(text: string): Promise<number[]> {
    return (await this.embedMany([text]))[0]!;
  }

  /** A search query, embedded as one (Voyage scores query-vs-document better than doc-vs-doc). */
  async embedQuery(text: string): Promise<number[]> {
    return (await this.embedMany([text], "query"))[0]!;
  }

  async embedMany(texts: string[], inputType: "document" | "query" = "document"): Promise<number[][]> {
    if (!this.apiKey) throw new Error("VOYAGE_API_KEY is not set");
    let lastError: Error = new Error("Voyage embeddings failed");
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      let retryAfterMs: number | null = null;
      let body: unknown;
      let failed = true;
      try {
        const res = await this.fetcher("https://api.voyageai.com/v1/embeddings", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({ input: texts, model: this.model, input_type: inputType }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.ok) {
          body = await res.json();
          failed = false;
        } else {
          lastError = new Error(`Voyage embeddings failed: ${res.status}`);
          if (!retryable(res.status)) throw lastError; // a bad key or request will not get better
          const header = Number(res.headers.get("retry-after"));
          retryAfterMs = Number.isFinite(header) && header >= 0 ? Math.min(header * 1000, RETRY_AFTER_CAP_MS) : null;
        }
      } catch (e) {
        if (e === lastError) throw e;
        const name = (e as Error)?.name;
        lastError =
          name === "TimeoutError" || name === "AbortError"
            ? new Error(`Voyage embeddings timed out after ${this.timeoutMs} ms`)
            : e instanceof Error
              ? e
              : new Error(String(e));
      }
      if (!failed) return this.parse(body, texts.length); // a malformed reply is an error, not something to retry
      if (attempt < this.retries) await sleep(retryAfterMs ?? this.backoffMs * 2 ** attempt);
    }
    throw lastError;
  }

  /** Vectors in input order -- and only a complete, usable reply: a short or malformed one is an error, never stored. */
  private parse(body: unknown, expected: number): number[][] {
    const data = (body as { data?: { embedding?: unknown; index?: unknown }[] } | null)?.data;
    if (!Array.isArray(data)) throw new Error("Voyage embeddings returned no data");
    if (data.length !== expected) throw new Error(`Voyage embeddings returned ${data.length} vectors for ${expected} inputs`);
    const ordered = [...data].sort((a, b) => Number(a.index) - Number(b.index));
    return ordered.map((d) => {
      const v = d.embedding;
      if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === "number" && Number.isFinite(x))) {
        throw new Error("Voyage embeddings returned an unusable vector");
      }
      return v as number[];
    });
  }

  /** The model id stored alongside vectors -- never compared with a native model's vectors. */
  get modelId(): string {
    return `voyage:${this.model}`;
  }
}
