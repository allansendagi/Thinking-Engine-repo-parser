import type { ZodType, ZodTypeDef } from "zod";
import type { CompletionProvider } from "./types";

/**
 * Pull the JSON object out of a model reply: a fenced ```json block if there is one, else the
 * span from the first "{" to the last "}" -- so a stray sentence before or after the object
 * ("Here are the events:") doesn't fail the whole call.
 */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) return JSON.parse(fenced[1].trim());
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) return JSON.parse(text.slice(start, end + 1));
  return JSON.parse(text.trim());
}

/**
 * One completion parsed against `schema`, with a single corrective retry. A malformed reply used
 * to throw straight out of ingest -- failing the request, so the client re-sent the whole
 * conversation and paid for extraction again. Now the model gets one chance to fix its own
 * output; a second failure still throws (the caller's retry/queue path stays the backstop).
 */
export async function completeJson<T>(
  provider: CompletionProvider,
  system: string,
  user: string,
  maxTokens: number,
  schema: ZodType<T, ZodTypeDef, unknown>,
): Promise<T> {
  const first = await provider.complete(system, user, maxTokens);
  try {
    return schema.parse(extractJson(first));
  } catch (err) {
    const problem = err instanceof Error ? err.message.slice(0, 300) : String(err);
    const retry = await provider.complete(
      system,
      `${user}\n\nYour previous reply could not be used (${problem}). Reply again with ONLY the JSON object in the exact shape specified -- no prose, no code fence.`,
      maxTokens,
    );
    return schema.parse(extractJson(retry));
  }
}
