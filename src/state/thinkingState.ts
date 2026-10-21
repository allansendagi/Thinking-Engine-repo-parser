import { ANCHOR_TYPES } from "../mining/consolidate";
import type { CognitiveEvent, IdeaNode, ThinkingState } from "../types";

export interface ThinkingStateOptions {
  /** Case-insensitive substring match against title/formulation/evolution. A real semantic topic
   *  match needs the embeddings signal (see identity/signals.ts) -- this is a placeholder. */
  topic?: string;
  recentWindowDays?: number;
  /** Injectable clock (tests). */
  now?: Date;
}

/** A question counts as unanswered-for-a-while after this many days open... */
export const REVISIT_AFTER_DAYS = 7;
/** ...and the person counts as "back on the topic" if it moved within this many days. */
export const BACK_ON_TOPIC_DAYS = 3;
const MAX_REVISIT = 5;

function matchesTopic(idea: IdeaNode, topic: string): boolean {
  const needle = topic.toLowerCase();
  if (idea.title.toLowerCase().includes(needle)) return true;
  if (idea.currentFormulation.toLowerCase().includes(needle)) return true;
  return idea.evolution.some((s) => s.formulation.toLowerCase().includes(needle));
}

/**
 * A group made only of questions (and other things ABOUT an idea) with nothing the person stated
 * is not an idea yet: it is questions waiting for one. Its questions still count (Open loops,
 * "Still unanswered", search); it just isn't listed among the ideas. Computed from the thoughts'
 * types, never stored, so the moment a position, decision or answer joins the group (the nightly
 * regrouping does that) it becomes a real idea with no migration. When the thoughts aren't loaded
 * the idea is treated as real: never hide on missing information.
 */
export function isQuestionsOnly(idea: IdeaNode, eventsById: Map<string, CognitiveEvent>): boolean {
  if (idea.evolution.length === 0 || idea.decisions.length > 0) return false;
  return idea.evolution.every((s) => {
    const type = eventsById.get(s.cognitiveEventId)?.type;
    return type !== undefined && !ANCHOR_TYPES.has(type);
  });
}

/**
 * Builds the object THREAD.md §10 calls the primary thing handed to a human or an AI. This is a
 * pure view over IdeaNode[] + CognitiveEvent[], computed fresh every call -- there is no stored
 * "thinking state" table, so it can never drift out of sync with the ideas it summarizes.
 */
export function buildThinkingState(
  ideas: IdeaNode[],
  cognitiveEvents: CognitiveEvent[],
  options: ThinkingStateOptions = {},
  /** Maps a canonical source_event_id -> tool ("chatgpt" | ...). Optional; enables latestSource. */
  sourceByEventId: Map<string, string> = new Map(),
): ThinkingState {
  const cognitiveEventsById = new Map(cognitiveEvents.map((e) => [e.id, e]));
  const ideasByIdAll = new Map(ideas.map((i) => [i.id, i]));

  const latestSourceOf = (idea: IdeaNode): string | null => {
    const last = idea.evolution[idea.evolution.length - 1];
    return last ? sourceByEventId.get(last.sourceEventId) ?? null : null;
  };
  const relevant = options.topic ? ideas.filter((i) => matchesTopic(i, options.topic as string)) : ideas;
  const relevantIds = new Set(relevant.map((i) => i.id));

  // Default covers the whole span the resume-nudge recency curve can still score against.
  // `resumeRecencyWeight` (extension/src/lib/resume.ts, mirrored in the Mac app) only clears the
  // confidence floor for ideas touched within ~32 days; a 30-day feed clipped the last ~2 days of
  // that, so a barely-eligible idea 30-32 days old could never become a candidate. 35 gives margin
  // without padding `recentChanges` with steps too old to ever nudge. Callers that want a tighter
  // window (MCP prose) still pass their own.
  const recentWindowDays = options.recentWindowDays ?? 35;
  const nowMs = (options.now ?? new Date()).getTime();
  const cutoff = nowMs - recentWindowDays * 24 * 60 * 60 * 1000;

  const recentChanges: ThinkingState["recentChanges"] = [];
  const contradictions: ThinkingState["contradictions"] = [];

  const contradictedIdeaIds = new Set<string>();
  for (const idea of relevant) {
    for (const step of idea.evolution) {
      const stepTime = new Date(step.createdAt).getTime();
      if (!Number.isNaN(stepTime) && stepTime >= cutoff) {
        recentChanges.push({
          ideaId: idea.id,
          ideaTitle: idea.title,
          formulation: step.formulation,
          createdAt: step.createdAt,
        });
      }
      const cognitiveEvent = cognitiveEventsById.get(step.cognitiveEventId);
      if (cognitiveEvent?.type === "contradiction") {
        contradictedIdeaIds.add(idea.id);
        contradictions.push({
          ideaId: idea.id,
          ideaTitle: idea.title,
          formulation: step.formulation,
          createdAt: step.createdAt,
        });
      }
    }
    // Primary signal is the idea's stored state: buildIdeaNode sets `contested` when a
    // contradiction lands on an idea, so the relationship survives even when the underlying
    // cognitive events aren't loaded. The evolution-step scan above stays as a fallback for
    // ideas persisted before `contested` existed.
    if (idea.state === "contested" && !contradictedIdeaIds.has(idea.id)) {
      contradictedIdeaIds.add(idea.id);
      contradictions.push({
        ideaId: idea.id,
        ideaTitle: idea.title,
        formulation: idea.currentFormulation,
        createdAt: idea.updatedAt,
      });
    }
  }

  const decisions: ThinkingState["decisions"] = relevant.flatMap((idea) =>
    idea.decisions.map((d) => ({
      ideaId: idea.id,
      ideaTitle: idea.title,
      statement: d.statement,
      decidedAt: d.decidedAt,
    })),
  );

  const openLoops: ThinkingState["openLoops"] = relevant.flatMap((idea) =>
    idea.openLoops.map((loop) => ({
      ideaId: idea.id,
      ideaTitle: idea.title,
      loopId: loop.id,
      statement: loop.statement,
      resolved: loop.resolved,
      createdAt: loop.createdAt,
      latestSource: latestSourceOf(idea),
    })),
  );

  const relatedIdeaIds = new Set<string>();
  for (const idea of relevant) {
    for (const id of idea.relatedIdeaIds) {
      if (!relevantIds.has(id)) relatedIdeaIds.add(id);
    }
  }
  const ideasById = new Map(ideas.map((i) => [i.id, i]));
  const relatedIdeas = [...relatedIdeaIds]
    .map((id) => ideasById.get(id))
    .filter((i): i is IdeaNode => i !== undefined)
    .map((i) => ({ id: i.id, title: i.title }));

  // "You never answered this": an open question older than REVISIT_AFTER_DAYS, on an idea that
  // -- itself or through its theme -- moved in the last BACK_ON_TOPIC_DAYS. Surfacing it the
  // moment the person is back on the subject is when answering it is cheapest. Deterministic.
  const DAY = 24 * 60 * 60 * 1000;
  const lastMoved = (idea: IdeaNode, exceptThought?: string): string | null => {
    const steps = idea.evolution.filter((s) => s.cognitiveEventId !== exceptThought);
    return steps.length ? steps.reduce((a, b) => (b.createdAt > a.createdAt ? b : a)).createdAt : null;
  };
  const revisit: ThinkingState["revisit"] = [];
  for (const idea of relevant) {
    for (const loop of idea.openLoops) {
      if (loop.resolved || nowMs - Date.parse(loop.createdAt) < REVISIT_AFTER_DAYS * DAY) continue;
      const loopThought = loop.id.startsWith("loop_") ? loop.id.slice("loop_".length) : undefined;
      let best: { at: string; via: string | null } | null = null;
      const consider = (at: string | null, via: string | null) => {
        if (!at || at <= loop.createdAt || nowMs - Date.parse(at) > BACK_ON_TOPIC_DAYS * DAY) return;
        if (!best || at > best.at) best = { at, via };
      };
      consider(lastMoved(idea, loopThought), null);
      for (const rid of idea.relatedIdeaIds) {
        const r = ideasByIdAll.get(rid);
        if (r) consider(lastMoved(r), r.title);
      }
      if (best) {
        const b = best as { at: string; via: string | null };
        revisit.push({ ideaId: idea.id, ideaTitle: idea.title, loopId: loop.id, statement: loop.statement, raisedAt: loop.createdAt, backOnTopicAt: b.at, via: b.via });
      }
    }
  }
  revisit.sort((a, b) => b.backOnTopicAt.localeCompare(a.backOnTopicAt) || a.raisedAt.localeCompare(b.raisedAt));

  return {
    topic: options.topic ?? null,
    currentIdeas: relevant.filter((i) => !isQuestionsOnly(i, cognitiveEventsById)).map((i) => ({
      id: i.id,
      title: i.title,
      state: i.state,
      currentFormulation: i.currentFormulation,
      latestSource: latestSourceOf(i),
    })),
    recentChanges: recentChanges.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    decisions,
    openLoops,
    contradictions,
    relatedIdeas,
    revisit: revisit.slice(0, MAX_REVISIT),
  };
}
