import type { CognitiveEvent, IdeaNode, ThinkingState } from "../types";

export interface ThinkingStateOptions {
  /** Case-insensitive substring match against title/formulation/evolution. A real semantic topic
   *  match needs the embeddings signal (see identity/signals.ts) -- this is a placeholder. */
  topic?: string;
  recentWindowDays?: number;
}

function matchesTopic(idea: IdeaNode, topic: string): boolean {
  const needle = topic.toLowerCase();
  if (idea.title.toLowerCase().includes(needle)) return true;
  if (idea.currentFormulation.toLowerCase().includes(needle)) return true;
  return idea.evolution.some((s) => s.formulation.toLowerCase().includes(needle));
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

  const latestSourceOf = (idea: IdeaNode): string | null => {
    const last = idea.evolution[idea.evolution.length - 1];
    return last ? sourceByEventId.get(last.sourceEventId) ?? null : null;
  };
  const relevant = options.topic ? ideas.filter((i) => matchesTopic(i, options.topic as string)) : ideas;
  const relevantIds = new Set(relevant.map((i) => i.id));

  const recentWindowDays = options.recentWindowDays ?? 30;
  const cutoff = Date.now() - recentWindowDays * 24 * 60 * 60 * 1000;

  const recentChanges: ThinkingState["recentChanges"] = [];
  const contradictions: ThinkingState["contradictions"] = [];

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
        contradictions.push({
          ideaId: idea.id,
          ideaTitle: idea.title,
          formulation: step.formulation,
          createdAt: step.createdAt,
        });
      }
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

  return {
    topic: options.topic ?? null,
    currentIdeas: relevant.map((i) => ({
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
  };
}
