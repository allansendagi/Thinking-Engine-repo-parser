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

export class VoyageEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly apiKey: string = process.env.VOYAGE_API_KEY ?? "",
    private readonly model: string = VOYAGE_MODEL,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async embed(text: string): Promise<number[]> {
    return (await this.embedMany([text]))[0]!;
  }

  /** A search query, embedded as one (Voyage scores query-vs-document better than doc-vs-doc). */
  async embedQuery(text: string): Promise<number[]> {
    return (await this.embedMany([text], "query"))[0]!;
  }

  async embedMany(texts: string[], inputType: "document" | "query" = "document"): Promise<number[][]> {
    if (!this.apiKey) throw new Error("VOYAGE_API_KEY is not set");
    const res = await this.fetcher("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ input: texts, model: this.model, input_type: inputType }),
    });
    if (!res.ok) throw new Error(`Voyage embeddings failed: ${res.status}`);
    const body = (await res.json()) as { data: { embedding: number[]; index: number }[] };
    return body.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }

  /** The model id stored alongside vectors -- never compared with a native model's vectors. */
  get modelId(): string {
    return `voyage:${this.model}`;
  }
}
