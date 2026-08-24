import type { CognitiveEvent, IdeaNode, IdentityResolution } from "../types";
import { IDENTITY_RESOLUTION_MERGE_THRESHOLD } from "../types";

function deriveTitle(statement: string): string {
  const words = statement.split(/\s+/).slice(0, 6).join(" ");
  return words.length < statement.length ? `${words}…` : words;
}

function linkRelated(a: IdeaNode, b: IdeaNode): void {
  if (!a.relatedIdeaIds.includes(b.id)) a.relatedIdeaIds.push(b.id);
  if (!b.relatedIdeaIds.includes(a.id)) b.relatedIdeaIds.push(a.id);
}

/**
 * Applies one (cognitive event, identity resolution) pair to the idea-node collection, mutating
 * `ideas` in place and returning the idea that was created or updated.
 *
 * Below IDENTITY_RESOLUTION_MERGE_THRESHOLD, the event always becomes a new idea, regardless of
 * matchedIdeaId -- never silently merge on a low-confidence guess. A missed merge just leaves a
 * duplicate a human can correct later; a wrong merge corrupts that idea's history.
 */
export function applyCognitiveEvent(
  ideas: Map<string, IdeaNode>,
  event: CognitiveEvent,
  resolution: IdentityResolution,
): IdeaNode {
  const confidentMatch =
    resolution.matchedIdeaId !== null && resolution.confidence >= IDENTITY_RESOLUTION_MERGE_THRESHOLD
      ? ideas.get(resolution.matchedIdeaId)
      : undefined;

  const now = new Date().toISOString();

  if (!confidentMatch) {
    const idea: IdeaNode = {
      id: `idea_${event.id}`,
      title: deriveTitle(event.statement),
      state: "developing",
      currentFormulation: event.statement,
      whyItMatters: event.whyItMatters,
      evolution: [
        {
          cognitiveEventId: event.id,
          formulation: event.statement,
          createdAt: now,
          sourceEventId: event.sourceEventId,
        },
      ],
      openLoops:
        event.type === "question" || event.type === "open_loop"
          ? [{ id: `loop_${event.id}`, statement: event.statement, createdAt: now, resolved: false }]
          : [],
      decisions:
        event.type === "decision"
          ? [{ id: `dec_${event.id}`, statement: event.statement, decidedAt: now, sourceEventId: event.sourceEventId }]
          : [],
      relatedIdeaIds: [],
      createdAt: now,
      updatedAt: now,
    };
    ideas.set(idea.id, idea);
    return idea;
  }

  const idea = confidentMatch;

  idea.evolution.push({
    cognitiveEventId: event.id,
    formulation: event.statement,
    createdAt: now,
    sourceEventId: event.sourceEventId,
  });
  idea.currentFormulation = event.statement;
  idea.updatedAt = now;
  if (event.whyItMatters && !idea.whyItMatters) idea.whyItMatters = event.whyItMatters;

  switch (event.type) {
    case "decision":
      idea.state = "established";
      idea.decisions.push({
        id: `dec_${event.id}`,
        statement: event.statement,
        decidedAt: now,
        sourceEventId: event.sourceEventId,
      });
      break;
    case "rejection":
      idea.state = "rejected";
      break;
    case "open_loop":
    case "question":
      idea.openLoops.push({
        id: `loop_${event.id}`,
        statement: event.statement,
        createdAt: now,
        resolved: false,
      });
      break;
    case "resolution":
      for (const loop of idea.openLoops) loop.resolved = true;
      break;
    case "connection":
      if (resolution.alsoRelatedIdeaId) {
        const other = ideas.get(resolution.alsoRelatedIdeaId);
        if (other) linkRelated(idea, other);
      }
      break;
    default:
      break;
  }

  return idea;
}
