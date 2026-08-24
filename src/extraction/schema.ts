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

export const extractedEventSchema = z.object({
  type: cognitiveEventTypeSchema,
  statement: z.string().min(1),
  confidence: z.number().min(0).max(1),
  source_event_id: z.string().min(1),
  evidence_quote: z.string().min(1),
  /** Only meaningful for new_idea: why this idea matters, in the model's own words. Optional. */
  why_it_matters: z.string().min(1).nullable().optional(),
  /**
   * Other source events that contributed context to this event (e.g. earlier turns that framed
   * a connection) without being the primary evidence quote. NOT grounding-checked -- only
   * source_event_id + evidence_quote carry the hallucination guarantee. Optional.
   */
  additional_source_event_ids: z.array(z.string()).optional(),
});

export const extractionResultSchema = z.object({
  events: z.array(extractedEventSchema),
});

export type ExtractedEvent = z.infer<typeof extractedEventSchema>;
export type ExtractionResult = z.infer<typeof extractionResultSchema>;
