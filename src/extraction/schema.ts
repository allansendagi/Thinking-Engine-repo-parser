import { z } from "zod";

export const cognitiveEventTypeSchema = z.enum([
  "new_idea",
  "claim",
  "question",
  "decision",
  "refinement",
  "contradiction",
  "connection",
  "rejection",
  "open_loop",
  "resolution",
]);

export const persistenceLevelSchema = z.enum(["high", "medium", "low"]);

export const extractedEventSchema = z.object({
  type: cognitiveEventTypeSchema,
  statement: z.string().min(1),
  /**
   * Only meaningful for new_idea: a 2-6 word NOUN PHRASE naming the idea (not a sentence, not
   * third-person narration). Used as the idea's title verbatim when present and clean;
   * buildIdeaNode derives one from `statement` otherwise. Optional -- older transcripts and
   * responses without it keep working.
   */
  // Enrichment fields degrade to "absent" when malformed -- they must never sink an extraction.
  title: z.string().min(1).max(80).nullable().optional().catch(null),
  confidence: z.number().min(0).max(1),
  /**
   * Worth-remembering judgment, separate from `confidence`. Defaulted to "high" so transcripts
   * scored before this field existed -- and any model response that omits it -- keep today's
   * behavior; the signal gate only bites on an explicit "medium"/"low".
   */
  persistence: persistenceLevelSchema.default("high"),
  /** One short phrase naming the rubric bullet behind `persistence`. */
  persistence_reason: z.string().min(1).nullable().optional().catch(null),
  source_event_id: z.string().min(1),
  evidence_quote: z.string().min(1),
  /** Only meaningful for new_idea: why this idea matters, in the model's own words. Optional. */
  why_it_matters: z.string().min(1).nullable().optional().catch(null),
  /**
   * Other source events that contributed context to this event (e.g. earlier turns that framed
   * a connection) without being the primary evidence quote. NOT grounding-checked -- only
   * source_event_id + evidence_quote carry the hallucination guarantee. Optional.
   */
  additional_source_event_ids: z.array(z.string()).optional().catch(undefined),
  /**
   * What a claim is DOING in the person's thinking: their position, an option they're weighing,
   * or a reason for/against something. Drives the thinking map and keeps an option from becoming
   * "where the idea stands". Optional; absent = position.
   */
  // A model naturally writes "question" or "decision" here for non-claims: that means "no role".
  role: z.enum(["position", "option", "reason"]).nullable().optional().catch(null),
  /**
   * Adoption: the person explicitly accepted a proposal the AI made in its immediately preceding
   * message ("yes, the second one"). evidence_quote is the person's acceptance; these two point at
   * the AI message and quote the accepted proposal verbatim. Both are grounding-checked.
   */
  adopted_from_event_id: z.string().nullable().optional().catch(null),
  adopted_quote: z.string().nullable().optional().catch(null),
});

/**
 * One malformed event is dropped, never the whole reply: the whole-reply version turned a single
 * odd field into a failed capture (500 -> the extension parks it, retries, eventually gives up).
 * Each kept event is still fully validated; grounding is checked afterwards as before.
 */
export const extractionResultSchema = z.object({
  events: z.array(z.unknown()).transform((items) =>
    items.flatMap((item) => {
      const r = extractedEventSchema.safeParse(item);
      if (!r.success) console.warn("[Thread] dropped a malformed extracted event:", r.error.issues[0]?.message);
      return r.success ? [r.data] : [];
    }),
  ),
});

export type ExtractedEvent = z.infer<typeof extractedEventSchema>;
export type ExtractionResult = z.infer<typeof extractionResultSchema>;
