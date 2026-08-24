import type { CanonicalEvent, CognitiveEvent } from "../types";
import type { CompletionProvider } from "../providers/types";
import { EXTRACTION_SYSTEM_PROMPT, buildTranscriptPrompt } from "./prompt";
import { extractionResultSchema, type ExtractedEvent } from "./schema";

function parseJsonResponse(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? text;
  return JSON.parse(candidate.trim());
}

/**
 * Deterministic hallucination guard: an extracted event is only trustworthy if its evidence_quote
 * is an exact substring of the canonical event it claims to be grounded in. This is what the
 * <2% hallucinated-attribution gate is actually checking against, so it's enforced here rather
 * than left to the model's self-reported confidence.
 */
function isGrounded(event: ExtractedEvent, eventsById: Map<string, CanonicalEvent>): boolean {
  const source = eventsById.get(event.source_event_id);
  if (!source) return false;
  return source.text.includes(event.evidence_quote);
}

export interface ExtractionOutcome {
  events: CognitiveEvent[];
  /** Events the model returned but that failed the grounding check -- kept for eval visibility. */
  rejected: { event: ExtractedEvent; reason: string }[];
}

export async function extractCognitiveEvents(
  conversationEvents: CanonicalEvent[],
  provider: CompletionProvider,
): Promise<ExtractionOutcome> {
  const eventsById = new Map(conversationEvents.map((e) => [e.id, e]));

  const raw = await provider.complete(
    EXTRACTION_SYSTEM_PROMPT,
    buildTranscriptPrompt(conversationEvents),
    4096,
  );

  const parsed = extractionResultSchema.parse(parseJsonResponse(raw));

  const events: CognitiveEvent[] = [];
  const rejected: ExtractionOutcome["rejected"] = [];

  for (const [i, candidate] of parsed.events.entries()) {
    if (!isGrounded(candidate, eventsById)) {
      rejected.push({ event: candidate, reason: "evidence_quote not found verbatim in source_event_id" });
      continue;
    }
    events.push({
      id: `cog_${candidate.source_event_id}_${i}`,
      type: candidate.type,
      statement: candidate.statement,
      confidence: candidate.confidence,
      sourceEventId: candidate.source_event_id,
      evidenceQuote: candidate.evidence_quote,
      whyItMatters: candidate.why_it_matters ?? undefined,
      additionalSourceEventIds: candidate.additional_source_event_ids ?? [],
    });
  }

  return { events, rejected };
}
