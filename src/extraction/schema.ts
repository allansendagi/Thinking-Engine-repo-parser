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
});

export const extractionResultSchema = z.object({
  events: z.array(extractedEventSchema),
});

export type ExtractedEvent = z.infer<typeof extractedEventSchema>;
export type ExtractionResult = z.infer<typeof extractionResultSchema>;
