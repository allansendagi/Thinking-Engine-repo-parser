import type { Database } from "bun:sqlite";
import type { CompletionProvider } from "../providers/types";
import { loadIdeas, loadIdea as loadIdeaById, loadCognitiveEvents, loadCanonicalEvents } from "../db/queries";
import { buildThinkingState } from "../state/thinkingState";
import { lexicalOverlap } from "../identity/signals";
import type { IdeaNode, ThinkingState } from "../types";

/**
 * The actual logic behind every MCP tool, deliberately separated from the MCP protocol wiring
 * (mcp/server.ts) so it's testable as plain functions with bun:sqlite -- no MCP client/transport
 * needed to verify these do the right thing. Five of the six tools below are pure reads over
 * structured data and need no model call at all; only continueThinking does.
 */

export interface IdeaSummary {
  id: string;
  title: string;
  state: IdeaNode["state"];
  currentFormulation: string;
  score: number;
}

export function searchIdeas(db: Database, query: string, limit = 10): IdeaSummary[] {
  const ideas = loadIdeas(db);
  return ideas
    .map((idea) => ({
      idea,
      score: lexicalOverlap(query, `${idea.title} ${idea.currentFormulation}`),
    }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => ({
      id: r.idea.id,
      title: r.idea.title,
      state: r.idea.state,
      currentFormulation: r.idea.currentFormulation,
      score: r.score,
    }));
}

export function getIdea(db: Database, id: string): IdeaNode | null {
  return loadIdeaById(db, id) ?? null;
}

export interface ProvenanceStep {
  formulation: string;
  createdAt: string;
  sourceText: string | null;
  sourceRole: string | null;
}

export interface IdeaTrace {
  idea: IdeaNode;
  provenance: ProvenanceStep[];
}

export function traceIdea(db: Database, id: string): IdeaTrace | null {
  const idea = getIdea(db, id);
  if (!idea) return null;

  const canonicalById = new Map(loadCanonicalEvents(db).map((e) => [e.id, e]));
  const provenance = idea.evolution.map((step) => {
    const source = canonicalById.get(step.sourceEventId);
    return {
      formulation: step.formulation,
      createdAt: step.createdAt,
      sourceText: source?.text ?? null,
      sourceRole: source?.role ?? null,
    };
  });

  return { idea, provenance };
}

export function getThreadState(db: Database, topic?: string): ThinkingState {
  return buildThinkingState(loadIdeas(db), loadCognitiveEvents(db), { topic });
}

export function getOpenLoops(db: Database, topic?: string): ThinkingState["openLoops"] {
  return getThreadState(db, topic).openLoops.filter((l) => !l.resolved);
}

export function getRecentChanges(db: Database, sinceDays = 14): ThinkingState["recentChanges"] {
  return buildThinkingState(loadIdeas(db), loadCognitiveEvents(db), { recentWindowDays: sinceDays }).recentChanges;
}

const CONTINUE_THINKING_SYSTEM_PROMPT = `You are helping a user continue a line of thinking they previously developed with AI. You will be given the current Thinking State for a topic -- current formulation, evolution, decisions, open loops, related ideas. Write a short, direct continuation prompt-style response: summarize where they left off in 2-3 sentences, name the open question if there is one, and suggest a concrete next step or question to move the thinking forward. Do not invent facts not present in the state.`;

/**
 * The one tool of the six that needs a live model call -- summarizing and moving a line of
 * thinking forward, not just retrieving it. Not verified against a live provider in this
 * environment (no API key available).
 */
export async function continueThinking(
  db: Database,
  topic: string,
  provider: CompletionProvider,
): Promise<string> {
  const state = getThreadState(db, topic);
  if (state.currentIdeas.length === 0) {
    throw new Error(`No ideas found matching topic "${topic}"`);
  }
  const prompt = `Thinking State for "${topic}":\n\n${JSON.stringify(state, null, 2)}`;
  return provider.complete(CONTINUE_THINKING_SYSTEM_PROMPT, prompt, 1024);
}
