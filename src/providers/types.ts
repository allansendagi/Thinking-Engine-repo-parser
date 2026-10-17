/**
 * Every LLM call in the engine goes through this interface, never the SDK directly -- the spec
 * requires extraction to be provider-swappable, and this is what makes that true instead of
 * aspirational. It also means the whole pipeline is testable without a live API key: swap in a
 * FakeProvider (see providers/fake.ts) that returns canned JSON.
 */
export interface CompleteOptions {
  /**
   * The first N characters of `user` are an unchanging prefix (the same bytes on the next call):
   * ask the provider to cache it. Providers that can't, ignore it.
   */
  cachePrefixChars?: number;
}

export interface CompletionProvider {
  complete(system: string, user: string, maxTokens: number, options?: CompleteOptions): Promise<string>;
}

/**
 * Anthropic does not serve an embeddings endpoint, so this is intentionally a separate interface
 * from CompletionProvider rather than an assumption that one provider does both. No default
 * implementation ships until a provider is chosen (see providers/embeddings.ts).
 */
export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}
