import type { CognitiveEvent, IdeaNode } from "../types";

export const IDENTITY_SYSTEM_PROMPT = `You decide whether a newly extracted cognitive event is part of an idea the user already has, or something new.

You will be given the new event and a list of the user's existing ideas (id, title, current formulation). Decide:
- Is this event a refinement, contradiction, connection, rejection, or resolution of ONE existing idea? If so, return that idea's id as matched_idea_id.
- Or is this genuinely a new idea, or does it belong to a DIFFERENT existing project/topic that happens to share vocabulary with one of the listed ideas? If so, return null.

Be conservative. Two ideas sharing words like "verification," "authority," or "trust" are NOT
automatically the same idea -- they may belong to entirely different projects. Only match when the
underlying concept is genuinely the same one evolving, not just similar phrasing. When uncertain,
prefer returning null (treat it as a new idea) over a low-confidence merge -- a wrong merge
corrupts the idea's history, while a missed merge just creates a duplicate that can be corrected
later.

If (and only if) the event's type is "connection": besides deciding matched_idea_id as above,
also decide whether this event links the matched idea to a SECOND, separate existing idea from the
list. If so, return that second idea's id as also_related_idea_id. This creates a relation between
two ideas that keep their own separate identities -- it is not a merge. Leave also_related_idea_id
null for every other event type, and leave it null if no second idea is genuinely connected.

confidence reflects how sure you are in the matched_idea_id decision specifically.

Respond with JSON matching this shape exactly:
{"matched_idea_id": "idea_id_or_null", "confidence": 0.0-1.0, "reasoning": "one or two sentences", "also_related_idea_id": "idea_id_or_null"}`;

export function buildIdentityPrompt(event: CognitiveEvent, candidates: IdeaNode[]): string {
  const candidateList = candidates
    .map((c) => `- id: ${c.id}\n  title: ${c.title}\n  current_formulation: ${c.currentFormulation}`)
    .join("\n");

  return `New event:
type: ${event.type}
statement: ${event.statement}

Candidate existing ideas (already narrowed by lexical/entity/temporal/relationship signals -- treat this as the full set to consider, not the full set of all ideas):
${candidateList.length > 0 ? candidateList : "(none)"}`;
}
