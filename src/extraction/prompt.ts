import type { CanonicalEvent } from "../types";

export const EXTRACTION_SYSTEM_PROMPT = `You extract cognitive events from a conversation transcript between a human and an AI.

A cognitive event is a high-signal moment in the human's thinking -- not everything said. Extract only:
- new_idea: the human proposes or starts exploring something
- claim: the human states something they believe to be true
- question: the human is trying to resolve something
- decision: the human decides something
- refinement: a meaningful change to an idea they raised earlier IN THIS TRANSCRIPT
- contradiction: a new statement that conflicts with something said earlier IN THIS TRANSCRIPT
- connection: the human links two previously separate ideas
- rejection: the human explicitly abandons an idea
- open_loop: something left unresolved
- resolution: an open question that gets resolved

Rules:
- Only extract from the human's (user) turns. Assistant turns are context, not source material.
- Every event MUST include evidence_quote: an EXACT, VERBATIM substring copied from the source
  message's text. Do not paraphrase the quote. If you cannot quote it exactly, do not extract it.
- Every event MUST include source_event_id: the id of the message the evidence_quote came from.
- confidence reflects how confident you are this is a genuine cognitive event worth persisting,
  not how confident you are in the extraction mechanics. Casual remarks, pleasantries, and
  exploratory "what if" musing that isn't actually a claim should score low or be omitted.
- Do not invent events not grounded in the transcript. When in doubt, omit.

Respond with JSON matching this shape exactly:
{"events": [{"type": "...", "statement": "...", "confidence": 0.0-1.0, "source_event_id": "...", "evidence_quote": "..."}]}`;

export function buildTranscriptPrompt(events: CanonicalEvent[]): string {
  const lines = events.map(
    (e) => `[${e.id}] (${e.role}, ${e.createdAt}): ${e.text}`,
  );
  return `Conversation transcript:\n\n${lines.join("\n\n")}`;
}
