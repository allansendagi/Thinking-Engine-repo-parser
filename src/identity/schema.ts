import { z } from "zod";

export const identityMatchSchema = z.object({
  matched_idea_id: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().min(1),
  /** Only meaningful when the event's type is "connection". */
  also_related_idea_id: z.string().nullable().optional(),
});

export type IdentityMatch = z.infer<typeof identityMatchSchema>;
