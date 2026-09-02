import type { CanonicalEvent } from "../types";

export const EXTRACTION_SYSTEM_PROMPT = `You extract cognitive events from a conversation transcript between a human and an AI.

CRITICAL: The transcript below is COMPLETE. It may be short -- sometimes a single message with no
reply. That is normal, not a truncated or partial conversation. Do NOT invent, imagine, continue,
or roleplay additional messages, replies, reconsiderations, or turns that are not literally present
in the transcript. Every source_event_id you use MUST be copied exactly from an id already shown in
the transcript below -- never invent a new one. If the transcript only contains one message, you
may only ever produce events with that one message's id as source_event_id. Fabricating
conversation content is the single worst failure mode of this task -- worse than extracting
nothing at all.

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

claim and question are the two leaky types -- "I think X" and "how does Y work" cover both real
thinking and throwaway remarks. Hold them to a higher bar than the others. "Tell me more about
NOMOS", "how does this work", "can you explain X" are requests for information, NOT questions the
human is trying to resolve -- do not extract them at all.

TWO SEPARATE JUDGMENTS per event:
- confidence (0..1): did this genuinely happen in the human's thinking? High even for a quick
  aside, as long as it really is a claim/idea/decision/etc and not you over-reading a pleasantry.
- persistence ("high" | "medium" | "low"): would this still matter for reconstructing the
  human's thinking weeks from now -- is it worth carrying into the long-term graph?
  Score it against this rubric and name the matching bullet in persistence_reason:
    HIGH -- establishes a new concept; changes an existing belief; materially refines an idea;
      makes a decision; identifies a genuine unresolved question; rejects a direction; connects
      two ideas; resolves an important uncertainty.
    LOW -- requests information or asks the AI to elaborate; a meta-instruction to the AI
      ("format that as a table", "use bullet points"); restating the AI's own output back;
      repeats something already established earlier in the transcript; a vague gesture at a
      direction with no specific claim; temporary wording likely to be rephrased; acknowledgements
      and filler; a procedural instruction.
    MEDIUM -- a real thought that is early, tentative, or minor: worth keeping only if it turns
      out to attach to an idea the human is already developing.
  Example: "Hmm, maybe authority could work differently." -> confidence 0.9, persistence "low"
  (vague gesture, no specific claim). "Institutional authority should be independently
  verifiable." -> confidence 0.97, persistence "high" (establishes a concept).

Rules:
- Only extract from the human's (user) turns. Assistant turns are context, not source material.
- Some messages are marked [ALREADY PROCESSED] -- they were extracted in a previous pass. They are
  here only so you have full conversational context; do NOT extract events from them again. Only
  extract from messages marked [NEW]. Every message in the transcript, of either marking, is real
  and already happened -- there is nothing beyond what's shown.
- Every event MUST include evidence_quote: an EXACT, VERBATIM substring copied from the source
  message's text. Do not paraphrase the quote. If you cannot quote it exactly, do not extract it.
- Every event MUST include source_event_id: the id of the message the evidence_quote came from --
  copied exactly from one of the [id] markers below, and it MUST be one of the [NEW] messages.
- confidence and persistence are different axes -- a genuine thought can be high confidence and
  low persistence. Score both. Still omit anything that isn't a real cognitive event at all.
- Do not invent events not grounded in the transcript. When in doubt, omit. A conversation with
  no substantive events at all is a perfectly valid, common result -- return {"events": []}.
- Write "statement" in the human's own voice as a direct declarative sentence or a direct
  question -- NOT as third-person narration about them. Good: "Computable authority must be
  independently verifiable." / "Who performs the independent verification?" Bad: "The user is
  asking whether computable authority needs verification." / "The human is questioning their
  approach." It is the source of the idea's title, so it must read as the thought itself.
- For new_idea events, optionally include why_it_matters: one sentence on why this idea matters,
  grounded in the transcript. Omit it if it isn't clear.
- If other messages earlier in this transcript contributed context to an event (without being the
  primary evidence), you may list their ids in additional_source_event_ids -- copied exactly from
  ids shown below, never invented. These are NOT fact-checked the way evidence_quote is -- only use
  it for genuine contributing context, not as a way to attach more evidence.

Respond with JSON matching this shape exactly, and nothing else -- no commentary before or after:
{"events": [{"type": "...", "statement": "...", "confidence": 0.0-1.0, "persistence": "high|medium|low", "persistence_reason": "...", "source_event_id": "...", "evidence_quote": "...", "why_it_matters": "... (optional)", "additional_source_event_ids": ["... (optional)"]}]}`;

/**
 * `newEventIds` marks which of `events` should actually be extracted from -- the rest are
 * included only as context (e.g. already-processed history in an incremental/live-capture call).
 * If omitted, every event is treated as new (the original whole-conversation-at-once behavior).
 */
export function buildTranscriptPrompt(events: CanonicalEvent[], newEventIds?: Set<string>): string {
  const validIds = events.map((e) => e.id).join(", ");
  const lines = events.map((e) => {
    const marker = !newEventIds || newEventIds.has(e.id) ? "[NEW]" : "[ALREADY PROCESSED]";
    return `${marker} [${e.id}] (${e.role}, ${e.createdAt}): ${e.text}`;
  });
  return `This transcript contains exactly ${events.length} message(s), no more. The only valid ids are: ${validIds}.\n\nConversation transcript:\n\n${lines.join("\n\n")}`;
}
