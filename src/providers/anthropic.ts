import Anthropic from "@anthropic-ai/sdk";
import type { CompletionProvider } from "./types";

/**
 * Model IDs are read from env with fallbacks so a stale hardcoded ID doesn't silently break
 * everything -- these have NOT been verified against a live API call in this environment (no key
 * available). Check them against current Anthropic API docs before running for real.
 */
const FAST_MODEL = process.env.ANTHROPIC_FAST_MODEL ?? "claude-haiku-4-5-20251001";
const STRONG_MODEL = process.env.ANTHROPIC_STRONG_MODEL ?? "claude-sonnet-4-5";

export class AnthropicProvider implements CompletionProvider {
  constructor(
    private readonly model: string,
    private readonly client: Anthropic = new Anthropic(),
  ) {}

  async complete(system: string, user: string, maxTokens: number): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    });
    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("Anthropic response contained no text block");
    }
    return textBlock.text;
  }
}

/** Fast/cheap tier: continuous extraction over every conversation. Per THREAD.md §15. */
export function createExtractionProvider(client?: Anthropic): CompletionProvider {
  return new AnthropicProvider(FAST_MODEL, client);
}

/** Strong tier: ambiguous identity resolution and synthesis. Per THREAD.md §15. */
export function createReasoningProvider(client?: Anthropic): CompletionProvider {
  return new AnthropicProvider(STRONG_MODEL, client);
}
