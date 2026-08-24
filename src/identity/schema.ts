import { z } from "zod";

export const identityMatchSchema = z.object({
  matched_idea_id: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().min(1),
});

export type IdentityMatch = z.infer<typeof identityMatchSchema>;
