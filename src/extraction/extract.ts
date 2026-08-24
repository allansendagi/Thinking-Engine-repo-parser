import Anthropic from "@anthropic-ai/sdk";
import type { CanonicalEvent, CognitiveEvent } from "../types";
import { EXTRACTION_SYSTEM_PROMPT, buildTranscriptPrompt } from "./prompt";
import { extractionResultSchema, type ExtractedEvent } from "./schema";

const MODEL = "claude-sonnet-4-5";

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
  client: Anthropic = new Anthropic(),
): Promise<ExtractionOutcome> {
  const eventsById = new Map(conversationEvents.map((e) => [e.id, e]));

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: EXTRACTION_SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildTranscriptPrompt(conversationEvents) }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Extraction response contained no text block");
  }

  const parsed = extractionResultSchema.parse(parseJsonResponse(textBlock.text));

  const events: CognitiveEvent[] = [];
  const rejected: ExtractionOutcome["rejected"] = [];

  for (const [i, raw] of parsed.events.entries()) {
    if (!isGrounded(raw, eventsById)) {
      rejected.push({ event: raw, reason: "evidence_quote not found verbatim in source_event_id" });
      continue;
    }
    events.push({
      id: `cog_${raw.source_event_id}_${i}`,
      type: raw.type,
      statement: raw.statement,
      confidence: raw.confidence,
      sourceEventId: raw.source_event_id,
      evidenceQuote: raw.evidence_quote,
    });
  }

  return { events, rejected };
}
