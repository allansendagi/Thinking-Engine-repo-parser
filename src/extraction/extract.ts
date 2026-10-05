import type { CanonicalEvent, CognitiveEvent } from "../types";
import type { CompletionProvider } from "../providers/types";
import { EXTRACTION_SYSTEM_PROMPT, MAX_PROMPT_MESSAGE_CHARS, buildTranscriptPrompt } from "./prompt";
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
  const calls = planExtractionCalls(contextEvents, newEventIds);
  if (calls.length === 1 && calls[0]!.context === contextEvents) {
    return extractOnce(contextEvents, provider, newEventIds);
  }
  const merged: ExtractionOutcome = { events: [], rejected: [] };
  for (const call of calls) {
    const outcome = await extractOnce(call.context, provider, call.newIds);
    merged.events.push(...outcome.events);
    merged.rejected.push(...outcome.rejected);
  }
  return merged;
}

/**
 * Size budget for one extraction call. The live capture path re-sends the whole transcript on
 * every turn, so an unbounded prompt made cost grow with the square of conversation length, and
 * a long chat (pasted code, documents) eventually exceeded the model's context window -- after
 * which every later turn of that conversation failed to extract at all. Characters are a cheap,
 * conservative proxy for tokens (~4 chars/token).
 */
export const EXTRACTION_CHAR_BUDGET = 60_000;
/** Portion of the budget the NEW messages of one call may use; the rest is preceding context. */
const NEW_SHARE = 0.6;

/** What one message costs in the prompt -- matches the per-message cap in buildTranscriptPrompt. */
function promptChars(e: CanonicalEvent): number {
  return Math.min(e.text.length, MAX_PROMPT_MESSAGE_CHARS) + e.id.length + 64;
}

interface PlannedCall {
  context: CanonicalEvent[];
  newIds: Set<string> | undefined;
}

/**
 * Split extraction into calls that each fit EXTRACTION_CHAR_BUDGET. Small transcripts (the common
 * case) stay one call with the original arguments, so behavior there is unchanged. Otherwise the
 * new (eligible) messages are chunked in order, and each chunk is preceded by as much of the
 * transcript just before it as still fits -- the model always sees the recent context a
 * refinement depends on, never the whole history. Grounding still checks against the FULL
 * message text (eventsById is built per call from the original events), so prompt truncation
 * can't let a fabricated quote through.
 */
export function planExtractionCalls(events: CanonicalEvent[], newEventIds?: Set<string>): PlannedCall[] {
  const total = events.reduce((n, e) => n + promptChars(e), 0);
  if (total <= EXTRACTION_CHAR_BUDGET) return [{ context: events, newIds: newEventIds }];

  const isNew = (e: CanonicalEvent) => !newEventIds || newEventIds.has(e.id);
  const newBudget = EXTRACTION_CHAR_BUDGET * NEW_SHARE;
  const calls: PlannedCall[] = [];

  let i = 0;
  while (i < events.length) {
    if (!isNew(events[i]!)) { i++; continue; }
    // Gather a chunk of new messages (always at least one) within the new-message budget.
    const chunkStart = i;
    const chunk: CanonicalEvent[] = [];
    let used = 0;
    while (i < events.length) {
      const e = events[i]!;
      const cost = promptChars(e);
      if (isNew(e)) {
        if (chunk.length > 0 && used + cost > newBudget) break;
        chunk.push(e);
        used += cost;
      }
      i++;
    }
    // Fill the rest of the budget with the messages immediately before the chunk.
    const context: CanonicalEvent[] = [];
    for (let j = chunkStart - 1; j >= 0; j--) {
      const cost = promptChars(events[j]!);
      if (used + cost > EXTRACTION_CHAR_BUDGET) break;
      context.unshift(events[j]!);
      used += cost;
    }
    const chunkIds = new Set(chunk.map((e) => e.id));
    // Old messages interleaved inside the chunk's span stay in the transcript for coherence.
    const span = events.slice(chunkStart, i).filter((e) => chunkIds.has(e.id) || !isNew(e));
    calls.push({ context: [...context, ...span], newIds: chunkIds });
  }
  return calls.length > 0 ? calls : [{ context: events, newIds: newEventIds }];
}

async function extractOnce(
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
      title: candidate.title ?? undefined,
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
