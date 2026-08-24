import type { EmbeddingProvider } from "./types";

/**
 * The semantic-similarity signal in identity resolution (THREAD.md §9, §14) needs an embeddings
 * call, and Anthropic doesn't serve one -- this is a provider decision that hasn't been made, not
 * an oversight. Passing this into the multi-signal ranker makes that explicit at the call site
 * instead of silently pretending the signal exists: it throws rather than returning a fake
 * vector, so a caller can't accidentally get a "similarity score" that means nothing.
 *
 * Until a provider is chosen (Voyage AI, OpenAI, etc.), omit the embeddingProvider argument to
 * identity/rankCandidates.ts and the semantic signal is skipped, not faked.
 */
export class UnconfiguredEmbeddingProvider implements EmbeddingProvider {
  async embed(): Promise<number[]> {
    throw new Error(
      "No embedding provider configured. Anthropic does not serve embeddings -- choose a provider " +
        "(e.g. Voyage AI, OpenAI) and implement EmbeddingProvider before enabling the semantic signal.",
    );
  }
}
