import Anthropic from "@anthropic-ai/sdk";
import type { CompleteOptions, CompletionProvider } from "./types";

/**
 * Model IDs are read from env with fallbacks so a stale hardcoded ID doesn't silently break
 * everything -- these have NOT been verified against a live API call in this environment (no key
 * available). Check them against current Anthropic API docs before running for real.
 */
const FAST_MODEL = process.env.ANTHROPIC_FAST_MODEL ?? "claude-haiku-4-5-20251001";
const STRONG_MODEL = process.env.ANTHROPIC_STRONG_MODEL ?? "claude-sonnet-4-5";

/** Token counts for one call -- the fields of the API's `usage` we pay attention to. */
interface Usage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** Running totals since this process started, per model. Read via `aiUsageTotals()`. */
const totals = new Map<string, { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number }>();

/**
 * One log line per model call, plus running totals. Cost can't be managed if it can't be seen:
 * without this, nobody could say what a message, a conversation or an import actually costs.
 * Never throws -- accounting must not be able to break extraction.
 */
export function recordUsage(model: string, usage: Usage | undefined): void {
  try {
    if (!usage) return;
    const input = usage.input_tokens ?? 0;
    const output = usage.output_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    const t = totals.get(model) ?? { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    t.calls++; t.input += input; t.output += output; t.cacheRead += cacheRead; t.cacheWrite += cacheWrite;
    totals.set(model, t);
    console.log(`[Thread] ai-usage model=${model} in=${input} out=${output} cache_read=${cacheRead} cache_write=${cacheWrite}`);
  } catch {
    /* accounting is best-effort */
  }
}

export function aiUsageTotals(): Record<string, { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number }> {
  return Object.fromEntries(totals);
}

export class AnthropicProvider implements CompletionProvider {
  constructor(
    private readonly model: string,
    private readonly client: Anthropic = new Anthropic(),
  ) {}

  async complete(system: string, user: string, maxTokens: number, options?: CompleteOptions): Promise<string> {
    // A cached prefix covers everything before the breakpoint -- the system prompt AND the stable
    // start of the transcript -- so a growing conversation re-reads it at ~10% of the price
    // instead of re-paying for it on every turn.
    const n = options?.cachePrefixChars ?? 0;
    const content =
      n > 0 && n < user.length
        ? [
            { type: "text" as const, text: user.slice(0, n), cache_control: { type: "ephemeral" as const } },
            { type: "text" as const, text: user.slice(n) },
          ]
        : user;
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content }],
    });
    recordUsage(this.model, response.usage);
    options?.onUsage?.({ input: response.usage?.input_tokens ?? 0, output: response.usage?.output_tokens ?? 0 });
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
