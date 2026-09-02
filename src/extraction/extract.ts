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
 * Deterministic hallucination guard: an extracted event is only trustworthy if (a) its
 * source_event_id refers to a message that actually exists in this conversation, (b) that message
 * is one the HUMAN wrote (never an assistant turn -- Thread must never file an AI suggestion as
 * the user's own idea), and (c) its evidence_quote is a substring of that message's real text.
 * This is what the <2% hallucinated-attribution gate is actually checking against, so it's
 * enforced here rather than left to the model following the prompt.
 *
 * Observed on a live run: given a single short message with no reply, the model sometimes
 * fabricates several additional turns of conversation wholesale -- invented user statements,
 * complete with invented message ids and timestamps -- and extracts events from its own
 * fabrication. Check (a) is what catches this: a fabricated source_event_id was never in
 * eventsById to begin with, so it fails before evidence_quote is even compared. This is a
 * distinct failure mode from a real message with a misquoted evidence_quote, so it's reported
 * with a different reason -- an operator debugging a spike in rejections needs to know which one
 * they're looking at.
 *
 * Case-insensitive on the quote comparison deliberately: the model sometimes capitalizes the
 * first letter of a quote pulled from mid-sentence (treating it as its own sentence). That's a
 * cosmetic normalization, not a fabrication -- the content wasn't changed. The guarantee this
 * check exists to enforce is "did the model make this up," not "did it preserve exact casing."
 */
function checkGrounding(
  event: ExtractedEvent,
  eventsById: Map<string, CanonicalEvent>,
): { grounded: true } | { grounded: false; reason: string } {
  const source = eventsById.get(event.source_event_id);
  if (!source) {
    return { grounded: false, reason: `source_event_id "${event.source_event_id}" does not exist in this conversation -- likely fabricated` };
  }
  if (source.role !== "user") {
    return { grounded: false, reason: "source_event_id points at an assistant message, not the human's -- would misattribute an AI suggestion" };
  }
  if (!source.text.toLowerCase().includes(event.evidence_quote.toLowerCase())) {
    return { grounded: false, reason: "evidence_quote not found verbatim in source_event_id" };
  }
  return { grounded: true };
}

export interface ExtractionOutcome {
  events: CognitiveEvent[];
  /** Events the model returned but that failed the grounding check -- kept for eval visibility. */
  rejected: { event: ExtractedEvent; reason: string }[];
}

/**
 * `contextEvents` is the full transcript (for coherence -- the model needs to see what came
 * before to correctly classify a refinement). `newEventIds`, if given, restricts which of those
 * are actually eligible to be extracted from -- the rest are marked [ALREADY PROCESSED] in the
 * prompt and, as a deterministic backstop (not just a prompt instruction the model could ignore),
 * any returned event whose source_event_id isn't in that set is rejected outright. This is what
 * makes incremental/live capture safe: re-sending prior messages for context can never produce a
 * duplicate cognitive event for something already processed.
 */
export async function extractCognitiveEvents(
  contextEvents: CanonicalEvent[],
  provider: CompletionProvider,
  newEventIds?: Set<string>,
): Promise<ExtractionOutcome> {
  const eventsById = new Map(contextEvents.map((e) => [e.id, e]));

  const raw = await provider.complete(
    EXTRACTION_SYSTEM_PROMPT,
    buildTranscriptPrompt(contextEvents, newEventIds),
    4096,
  );

  const parsed = extractionResultSchema.parse(parseJsonResponse(raw));

  const events: CognitiveEvent[] = [];
  const rejected: ExtractionOutcome["rejected"] = [];

  for (const [i, candidate] of parsed.events.entries()) {
    if (newEventIds && !newEventIds.has(candidate.source_event_id)) {
      rejected.push({ event: candidate, reason: "source_event_id was marked already-processed, not new" });
      continue;
    }
    const grounding = checkGrounding(candidate, eventsById);
    if (!grounding.grounded) {
      rejected.push({ event: candidate, reason: grounding.reason });
      continue;
    }
    events.push({
      id: `cog_${candidate.source_event_id}_${i}`,
      type: candidate.type,
      statement: candidate.statement,
      confidence: candidate.confidence,
      persistence: candidate.persistence,
      persistenceReason: candidate.persistence_reason ?? undefined,
      sourceEventId: candidate.source_event_id,
      evidenceQuote: candidate.evidence_quote,
      whyItMatters: candidate.why_it_matters ?? undefined,
      additionalSourceEventIds: candidate.additional_source_event_ids ?? [],
    });
  }

  return { events, rejected };
}
