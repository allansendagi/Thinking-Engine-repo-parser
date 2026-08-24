import Anthropic from "@anthropic-ai/sdk";
import type { CognitiveEvent, IdeaNode, IdentityResolution } from "../types";
import { IDENTITY_SYSTEM_PROMPT, buildIdentityPrompt } from "./prompt";
import { identityMatchSchema } from "./schema";

const MODEL = "claude-sonnet-4-5";

function parseJsonResponse(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? text;
  return JSON.parse(candidate.trim());
}

/**
 * Decides whether `event` extends an existing idea or should become a new one. Returns the raw
 * decision -- applying the merge threshold (see IDENTITY_RESOLUTION_MERGE_THRESHOLD) is the
 * state builder's job, not this function's, so eval can score identity resolution independent
 * of what the pipeline chose to do with a borderline call.
 */
export async function resolveIdentity(
  event: CognitiveEvent,
  candidates: IdeaNode[],
  client: Anthropic = new Anthropic(),
): Promise<IdentityResolution> {
  if (candidates.length === 0) {
    return {
      cognitiveEventId: event.id,
      matchedIdeaId: null,
      confidence: 1,
      reasoning: "No existing ideas to compare against.",
    };
  }

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    system: IDENTITY_SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildIdentityPrompt(event, candidates) }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Identity resolution response contained no text block");
  }

  const parsed = identityMatchSchema.parse(parseJsonResponse(textBlock.text));

  const matchedIdeaId = parsed.matched_idea_id;
  if (matchedIdeaId !== null && !candidates.some((c) => c.id === matchedIdeaId)) {
    throw new Error(`Identity resolution returned unknown idea id: ${matchedIdeaId}`);
  }

  return {
    cognitiveEventId: event.id,
    matchedIdeaId,
    confidence: parsed.confidence,
    reasoning: parsed.reasoning,
  };
}
