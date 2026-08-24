import type { CognitiveEvent, IdeaNode, IdentityResolution } from "../types";
import type { CompletionProvider } from "../providers/types";
import { IDENTITY_SYSTEM_PROMPT, buildIdentityPrompt } from "./prompt";
import { identityMatchSchema } from "./schema";

function parseJsonResponse(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? text;
  return JSON.parse(candidate.trim());
}

/**
 * Decides whether `event` extends one of `candidates` or should become a new idea. `candidates`
 * is expected to already be narrowed (see identity/signals.ts) -- this function doesn't know or
 * care how the candidate list was produced, which keeps the model call testable independent of
 * the retrieval heuristics.
 *
 * Returns the raw decision -- applying the merge threshold (IDENTITY_RESOLUTION_MERGE_THRESHOLD)
 * is the state builder's job, not this function's, so eval can score identity resolution
 * independent of what the pipeline chose to do with a borderline call.
 */
export async function resolveIdentity(
  event: CognitiveEvent,
  candidates: IdeaNode[],
  provider: CompletionProvider,
): Promise<IdentityResolution> {
  if (candidates.length === 0) {
    return {
      cognitiveEventId: event.id,
      matchedIdeaId: null,
      confidence: 1,
      reasoning: "No candidate ideas to compare against.",
      alsoRelatedIdeaId: null,
    };
  }

  const raw = await provider.complete(IDENTITY_SYSTEM_PROMPT, buildIdentityPrompt(event, candidates), 512);
  const parsed = identityMatchSchema.parse(parseJsonResponse(raw));

  const candidateIds = new Set(candidates.map((c) => c.id));
  if (parsed.matched_idea_id !== null && !candidateIds.has(parsed.matched_idea_id)) {
    throw new Error(`Identity resolution returned an idea id outside the candidate set: ${parsed.matched_idea_id}`);
  }
  if (
    parsed.also_related_idea_id != null &&
    (!candidateIds.has(parsed.also_related_idea_id) || parsed.also_related_idea_id === parsed.matched_idea_id)
  ) {
    throw new Error(`Identity resolution returned an invalid also_related_idea_id: ${parsed.also_related_idea_id}`);
  }

  return {
    cognitiveEventId: event.id,
    matchedIdeaId: parsed.matched_idea_id,
    confidence: parsed.confidence,
    reasoning: parsed.reasoning,
    alsoRelatedIdeaId: event.type === "connection" ? (parsed.also_related_idea_id ?? null) : null,
  };
}
