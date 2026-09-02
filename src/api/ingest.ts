import type { Database } from "bun:sqlite";
import type { CanonicalEvent, Role } from "../types";
import { loadCanonicalEvents, loadIdeas } from "../db/queries";
import { runPipeline, persistPipelineResult, type PipelineProviders } from "../state/pipeline";
import { replayDiscardedEvents } from "../state/replayDiscarded";

export interface IncomingMessage {
  id: string;
  role: Role;
  text: string;
  createdAt: string;
}

export interface IngestConversationInput {
  conversationId: string;
  source: CanonicalEvent["source"];
  /** The full transcript known so far, not just what's new -- see module doc. */
  messages: IncomingMessage[];
  /**
   * Canonical URL of the conversation (origin + path). Optional -- the extension sends it, paste
   * has none. Applied to every canonical event of this conversation; a null here never clears a
   * URL a prior call already stored (COALESCE in persistPipelineResult).
   */
  sourceUrl?: string | null;
}

export interface IngestResult {
  newCanonicalEvents: number;
  /** Grounded events the signal gate PROMOTED to ideas this call. */
  newCognitiveEvents: number;
  /** Grounded events the signal gate declined to persist (stored for replay, not attached). */
  discardedEvents: number;
  /** Earlier discards this call promoted into ideas because the idea they belong to now exists. */
  promotedFromDiscard: number;
  rejectedExtractions: number;
  ideaCount: number;
}

/**
 * Incremental ingestion for one conversation. Safe to call repeatedly with a growing message list
 * -- e.g. every time a browser extension observes a new turn, it resends the full transcript it
 * has so far, not a diff. Already-seen messages (by id, checked against this user's DB) are sent
 * to extraction as context only, never re-extracted -- so calling this 50 times as a conversation
 * grows produces the same result as calling it once at the end, not 50x duplicated ideas.
 */
export async function ingestConversation(
  db: Database,
  input: IngestConversationInput,
  providers: PipelineProviders,
): Promise<IngestResult> {
  const existingIdeaCount = () => loadIdeas(db).length;

  if (input.messages.length === 0) {
    return {
      newCanonicalEvents: 0,
      newCognitiveEvents: 0,
      discardedEvents: 0,
      promotedFromDiscard: 0,
      rejectedExtractions: 0,
      ideaCount: existingIdeaCount(),
    };
  }

  const existingIds = new Set(
    loadCanonicalEvents(db)
      .filter((e) => e.conversationId === input.conversationId)
      .map((e) => e.id),
  );

  const allEvents: CanonicalEvent[] = input.messages.map((m, i) => ({
    id: m.id,
    conversationId: input.conversationId,
    source: input.source,
    role: m.role,
    text: m.text,
    createdAt: m.createdAt,
    index: i,
    sourceUrl: input.sourceUrl ?? null,
  }));

  const newEventIds = new Set(allEvents.filter((e) => !existingIds.has(e.id)).map((e) => e.id));

  if (newEventIds.size === 0) {
    return {
      newCanonicalEvents: 0,
      newCognitiveEvents: 0,
      discardedEvents: 0,
      promotedFromDiscard: 0,
      rejectedExtractions: 0,
      ideaCount: existingIdeaCount(),
    };
  }

  const existingIdeas = new Map(loadIdeas(db).map((i) => [i.id, i]));

  const result = await runPipeline(allEvents, providers, { existingIdeas, newEventIds });
  persistPipelineResult(db, allEvents, result);

  // Reconsider earlier medium-value discards now that this call may have created the idea they
  // belong to. Incremental-only -- see replayDiscardedEvents.
  const replay = await replayDiscardedEvents(db, providers);

  return {
    newCanonicalEvents: newEventIds.size,
    newCognitiveEvents: result.cognitiveEvents.length + replay.promoted,
    discardedEvents: result.discardedEvents.length,
    promotedFromDiscard: replay.promoted,
    rejectedExtractions: result.rejectedExtractions.length,
    ideaCount: loadIdeas(db).length,
  };
}
