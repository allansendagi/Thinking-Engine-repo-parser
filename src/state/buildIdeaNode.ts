import type { CognitiveEvent, IdeaNode, IdentityResolution } from "../types";
import { IDENTITY_RESOLUTION_MERGE_THRESHOLD } from "../types";

/**
 * Third-person narration the extractor still sometimes emits instead of the thought itself
 * ("The user is asking why...", "The human decides to..."). Strip the framing so the title
 * reads as the idea. Requires a "that / whether / why / their / ..." pivot after the verb so it
 * only fires on real narration, not a sentence that merely opens with "The user".
 */
const NARRATION_PREFIX =
  /^\s*(the\s+(user|human|person|author|speaker|reader)|they|he|she|we)\s+(is\s+|are\s+)?(asking|questioning|seeking|wondering|considering|pondering|exploring|proposing|suggesting|claiming|arguing|positing|believing|deciding|realizing|realising|noting|observing|stating|wants?|decides?|thinks?|feels?|explores?|questions?|proposes?|is|are)\b[^.?!]*?\b(that|whether|why|how|what|which|if|to|about|for)\s+(their\s+|his\s+|her\s+|our\s+|the\s+)?/i;

/** A title that talks *about the person* rather than naming an idea -- never acceptable. */
const PERSON_SUBJECT = /^\s*(the\s+)?(user|human|person|author|speaker|reader|they|he|she|we)\b/i;

function stripNarration(s: string): string {
  const cleaned = s.replace(NARRATION_PREFIX, "").trim();
  // Only accept the strip if it left a substantive phrase, not a stray word or two.
  return cleaned.split(/\s+/).length >= 3 ? cleaned : s.trim();
}

/**
 * A short, noun-phrase-ish title for an idea. Prefers the extractor's own `title` when it gave a
 * usable one; otherwise carves one out of `statement` -- narration stripped, ~8 words, no
 * trailing punctuation.
 */
export function deriveTitle(statement: string, modelTitle?: string): string {
  const cap = (x: string) => (x.length > 0 ? x[0]!.toUpperCase() + x.slice(1) : x);

  if (modelTitle) {
    const t = stripNarration(modelTitle.trim()).replace(/[\s.?!,;:]+$/, "");
    if (t.length >= 3 && t.length <= 80 && !PERSON_SUBJECT.test(t)) return cap(t);
  }

  const s = cap(stripNarration(statement.trim()));
  const words = s.split(/\s+/);
  if (words.length <= 8) return s.replace(/[.?!]+$/, "");
  return `${words.slice(0, 8).join(" ").replace(/[,;:]+$/, "")}…`;
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
/**
 * Did identity resolution land on an existing idea we can trust? Used both by applyCognitiveEvent
 * (merge vs. new) and by the signal gate (state/pipeline.ts, state/replayDiscarded.ts): a
 * medium-value leaky event is only allowed to persist when this is true -- a strong retrieval
 * score alone isn't enough, since the retrieval signal can be high while the idea model correctly
 * says "not the same idea".
 */
export function isConfidentExistingMatch(
  resolution: IdentityResolution,
  ideas: Map<string, IdeaNode>,
): boolean {
  return (
    resolution.matchedIdeaId !== null &&
    resolution.confidence >= IDENTITY_RESOLUTION_MERGE_THRESHOLD &&
    ideas.has(resolution.matchedIdeaId)
  );
}

export function applyCognitiveEvent(
  ideas: Map<string, IdeaNode>,
  event: CognitiveEvent,
  resolution: IdentityResolution,
  sourceCreatedAt: string,
): IdeaNode {
  const confidentMatch = isConfidentExistingMatch(resolution, ideas)
    ? ideas.get(resolution.matchedIdeaId as string)
    : undefined;

  if (!confidentMatch) {
    const idea: IdeaNode = {
      id: `idea_${event.id}`,
      title: deriveTitle(event.statement, event.title),
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
    case "contradiction":
      // First-class in the graph, not re-derived by the view layer: the idea now holds a
      // statement that conflicts with its own prior formulation. Mark it contested and file the
      // tension as an unresolved loop so recall surfaces it as unfinished thinking.
      idea.state = "contested";
      idea.openLoops.push({
        id: `loop_${event.id}`,
        statement: `Unresolved contradiction: ${event.statement}`,
        createdAt: sourceCreatedAt,
        resolved: false,
      });
      break;
    case "resolution":
      for (const loop of idea.openLoops) loop.resolved = true;
      // A resolution settles the contradiction that contested the idea.
      if (idea.state === "contested") idea.state = "developing";
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
