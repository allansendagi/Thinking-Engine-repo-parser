import type { Database } from "bun:sqlite";
import type { CognitiveEvent, IdentityResolution } from "../types";
import { loadCanonicalEvents, loadDiscardedEvents, loadIdeas } from "../db/queries";
import { deleteDiscardedEvents } from "../db/mutations";
import { rankCandidates, narrowCandidates } from "../identity/signals";
import { resolveIdentity } from "../identity/resolve";
import { applyCognitiveEvent, isConfidentExistingMatch } from "./buildIdeaNode";
import { quickGate, strongMatchScore } from "./signalGate";
import { persistPipelineResult, type PipelineProviders } from "./pipeline";

/** Substring of the gate reason for the one replayable discard branch (medium, no match yet). */
const REPLAYABLE_MARKER = "persist only if it extends an existing idea";

/**
 * Incremental-only reconsideration. A medium-persistence leaky-type event (claim / question /
 * refinement) can be discarded because no existing idea matched it *at the time* -- and then a
 * later turn creates the idea it actually belongs to. `newEventIds` guarantees extraction never
 * re-emits that message, so without this pass the discard is permanent and a real refinement is
 * silently lost -- exactly the failure direction the gate is meant to avoid.
 *
 * Batch / import mode does not need this: runPipeline processes events in chronological order,
 * so the founding idea is always seen before a later refinement of it.
 *
 * This re-checks each replayable discard against the CURRENT idea set, promotes the ones that
 * now clear the strong-match bar (identity resolution + applyCognitiveEvent), and deletes their
 * discarded_events rows. `persistence=low` discards are never replayed -- "low" is a permanent
 * editorial no, not a timing artifact.
 */
export async function replayDiscardedEvents(
  db: Database,
  providers: PipelineProviders,
): Promise<{ promoted: number }> {
  const pending = loadDiscardedEvents(db).filter((d) => d.gateReason.includes(REPLAYABLE_MARKER));
  if (pending.length === 0) return { promoted: 0 };

  const canonicalById = new Map(loadCanonicalEvents(db).map((e) => [e.id, e]));
  const ideas = new Map(loadIdeas(db).map((i) => [i.id, i]));

  // Oldest source first, so an event promoted in this pass can itself be the match for the next.
  pending.sort((a, b) => {
    const at = canonicalById.get(a.event.sourceEventId)?.createdAt ?? "";
    const bt = canonicalById.get(b.event.sourceEventId)?.createdAt ?? "";
    return at.localeCompare(bt);
  });

  const promotedEvents: CognitiveEvent[] = [];
  const resolutions: IdentityResolution[] = [];
  const promotedIds: string[] = [];

  for (const { event } of pending) {
    const sourceEvent = canonicalById.get(event.sourceEventId);
    if (!sourceEvent) continue;
    if (quickGate(event).decision !== "needs-match") continue; // rubric changed under it -- leave alone

    const ranked = await rankCandidates(event, sourceEvent, [...ideas.values()], {
      embeddingProvider: providers.embeddings,
    });
    if ((ranked[0]?.score ?? 0) < strongMatchScore()) continue; // still has no home

    const narrowed = narrowCandidates(ranked).map((c) => c.idea);
    const resolution = await resolveIdentity(event, narrowed, providers.reasoning);
    // The retrieval score got it re-examined; the idea model still has to confirm the match.
    // If it won't, leave the row in discarded_events untouched for a future pass.
    if (!isConfidentExistingMatch(resolution, ideas)) continue;

    resolutions.push(resolution);
    applyCognitiveEvent(ideas, event, resolution, sourceEvent.createdAt);
    promotedEvents.push(event);
    promotedIds.push(event.id);
  }

  if (promotedEvents.length === 0) return { promoted: 0 };

  // canonicalEvents already persisted -- pass [] and let INSERT OR REPLACE reconcile the ideas.
  persistPipelineResult(db, [], {
    ideas,
    cognitiveEvents: promotedEvents,
    discardedEvents: [],
    resolutions,
    rejectedExtractions: [],
  });
  deleteDiscardedEvents(db, promotedIds);
  return { promoted: promotedEvents.length };
}
