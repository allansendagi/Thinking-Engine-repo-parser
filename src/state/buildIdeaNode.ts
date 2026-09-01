import type { CognitiveEvent, IdeaNode, IdentityResolution } from "../types";
import { IDENTITY_RESOLUTION_MERGE_THRESHOLD } from "../types";

/** Third-person narration the extractor still sometimes emits; strip it so the title is the thought. */
const NARRATION_PREFIX =
  /^(the (user|human|person) (is )?(asking|questioning|seeking|proposing|claiming|wondering|considering|deciding)( (why|whether|what|how|if|for|about|to))?|the (user|human) (decides|wants|claims|believes|proposes|is)( to)?)\s+/i;

function deriveTitle(statement: string): string {
  let s = statement.trim().replace(NARRATION_PREFIX, "");
  if (s.length > 0) s = s[0]!.toUpperCase() + s.slice(1);
  const words = s.split(/\s+/).slice(0, 7).join(" ");
  return words.length < s.length ? `${words}…` : words;
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
 *
 * `sourceCreatedAt` is the ORIGINATING CONVERSATION's timestamp, not wall-clock processing time.
 * Using `new Date()` here was a real bug: identity resolution's temporal-proximity signal
 * (identity/signals.ts) compares an idea's last-touched time against a new event's time to judge
 * how close together they happened in the user's timeline. If "last touched" means "whenever this
 * batch happened to run" instead of "when the user actually said it," that comparison is
 * meaningless for any historical import -- which is the actual use case -- and gets worse the
 * longer the import happens after the fact. Confirmed against a live run: with evolution
 * timestamps on wall-clock "now" and fixture conversations dated over a year in the past, temporal
 * proximity collapsed to ~0 and pushed a genuine match below the candidate-narrowing floor,
 * producing a real missed merge (see git history / eval run for the diagnosis).
 */
export function applyCognitiveEvent(
  ideas: Map<string, IdeaNode>,
  event: CognitiveEvent,
  resolution: IdentityResolution,
  sourceCreatedAt: string,
): IdeaNode {
  const confidentMatch =
    resolution.matchedIdeaId !== null && resolution.confidence >= IDENTITY_RESOLUTION_MERGE_THRESHOLD
      ? ideas.get(resolution.matchedIdeaId)
      : undefined;

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
          createdAt: sourceCreatedAt,
          sourceEventId: event.sourceEventId,
        },
      ],
      openLoops:
        event.type === "question" || event.type === "open_loop"
          ? [{ id: `loop_${event.id}`, statement: event.statement, createdAt: sourceCreatedAt, resolved: false }]
          : [],
      decisions:
        event.type === "decision"
          ? [
              {
                id: `dec_${event.id}`,
                statement: event.statement,
                decidedAt: sourceCreatedAt,
                sourceEventId: event.sourceEventId,
              },
            ]
          : [],
      relatedIdeaIds: [],
      createdAt: sourceCreatedAt,
      updatedAt: sourceCreatedAt,
    };
    ideas.set(idea.id, idea);
    return idea;
  }

  const idea = confidentMatch;

  idea.evolution.push({
    cognitiveEventId: event.id,
    formulation: event.statement,
    createdAt: sourceCreatedAt,
    sourceEventId: event.sourceEventId,
  });
  idea.currentFormulation = event.statement;
  idea.updatedAt = sourceCreatedAt;
  if (event.whyItMatters && !idea.whyItMatters) idea.whyItMatters = event.whyItMatters;

  switch (event.type) {
    case "decision":
      idea.state = "established";
      idea.decisions.push({
        id: `dec_${event.id}`,
        statement: event.statement,
        decidedAt: sourceCreatedAt,
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
        createdAt: sourceCreatedAt,
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
