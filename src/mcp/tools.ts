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
  /** Which tool this step was captured from -- "chatgpt" | "claude" | "gemini" | "cursor" | "paste". */
  source: string | null;
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
      source: source?.source ?? null,
    };
  });

  return { idea, provenance };
}

export function getThreadState(db: Database, topic?: string): ThinkingState {
  const sourceByEventId = new Map(
    loadCanonicalEvents(db).map((e) => [e.id, e.source] as const),
  );
  return buildThinkingState(loadIdeas(db), loadCognitiveEvents(db), { topic }, sourceByEventId);
}

export function getOpenLoops(db: Database, topic?: string): ThinkingState["openLoops"] {
  return getThreadState(db, topic).openLoops.filter((l) => !l.resolved);
}

export function getRecentChanges(db: Database, sinceDays = 14): ThinkingState["recentChanges"] {
  return buildThinkingState(loadIdeas(db), loadCognitiveEvents(db), { recentWindowDays: sinceDays }).recentChanges;
}

// --- Continuation packet -----------------------------------------------------------------------
//
// The product's sharpest capability: not "here's a summary" but a compact, tool-neutral handoff
// that puts you back inside a thought in seconds. It is assembled DETERMINISTICALLY from the
// idea's own provenance-backed fields; the model touches exactly one line ("Continue from here").
// The server renders the paste-ready `text` ONCE (renderPacket) -- clients show the structured
// fields for source affordances but copy `text` verbatim, so the two can never drift.

const SOURCE_LABELS: Record<string, string> = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  gemini: "Gemini",
  cursor: "Cursor",
  paste: "pasted",
  fixture: "fixture",
};
function sourceLabel(s: string | null): string | null {
  return s ? (SOURCE_LABELS[s] ?? s) : null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** Loops from a contradiction are stored prefixed; drop it for display. */
function stripLoopPrefix(s: string): string {
  return s.replace(/^Unresolved contradiction:\s*/i, "");
}

function firstSentence(s: string): string {
  const m = s.match(/^.*?[.?!](\s|$)/);
  return (m ? m[0] : s).trim();
}

export interface ContinuationEvolutionStep {
  when: string; // ISO
  source: string | null; // display label ("ChatGPT" | "Claude" | ...)
  formulation: string;
  /** The full user message the step came from -- for the app's "view source" affordance. Not in `text`. */
  sourceText: string | null;
}

export interface ContinuationPacket {
  idea: { id: string; title: string; state: IdeaNode["state"] };
  /** = current formulation. "Where you left off." */
  whereYouLeftOff: string;
  contested: boolean;
  evolution: ContinuationEvolutionStep[];
  decisions: { statement: string; decidedAt: string }[];
  /** The most relevant unresolved loop (contradiction preferred when contested), or null. */
  unresolvedQuestion: string | null;
  /** One line to paste into a fresh chat. Model-generated, template fallback. Editable client-side. */
  suggestedNext: string;
}

const NEXT_STEP_PROMPT = `You are given a line of thinking a user developed with AI. Write ONE sentence they can paste into a new AI chat to pick it back up: an instruction in their own voice, grounded only in what's given, pointing at the unresolved question if there is one. No preamble, no "you should", one sentence.`;

function pickIdeaForTopic(db: Database, topic: string): IdeaNode | null {
  const matches = getThreadState(db, topic).currentIdeas;
  if (matches.length === 0) return null;
  // Best lexical match on title+formulation; tie-break toward the one most recently worked on.
  const best = matches
    .map((i) => ({ id: i.id, score: lexicalOverlap(topic, `${i.title} ${i.currentFormulation}`) }))
    .sort((a, b) => b.score - a.score)[0]!;
  return getIdea(db, best.id);
}

function mostRelevantOpenLoop(idea: IdeaNode): string | null {
  const open = idea.openLoops.filter((l) => !l.resolved);
  if (open.length === 0) return null;
  if (idea.state === "contested") {
    const contradiction = open.find((l) => /^Unresolved contradiction:/i.test(l.statement));
    if (contradiction) return contradiction.statement;
  }
  return [...open].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!.statement;
}

/**
 * Resolve an idea (by exact id, or the best match for a fuzzy topic), assemble the packet from
 * its fields, and render the paste-ready text. `provider` is optional -- without it, or if the
 * call fails, `suggestedNext` falls back to a template. Returns null when nothing matches.
 */
export async function buildContinuationPacket(
  db: Database,
  opts: { ideaId?: string; topic?: string },
  provider?: CompletionProvider,
): Promise<{ text: string; packet: ContinuationPacket } | null> {
  const idea = opts.ideaId
    ? getIdea(db, opts.ideaId)
    : opts.topic
      ? pickIdeaForTopic(db, opts.topic)
      : null;
  if (!idea) return null;

  const trace = traceIdea(db, idea.id)!;
  const evolution: ContinuationEvolutionStep[] = trace.provenance
    // Grounding now guarantees user-authored steps; pre-fix rows may be null -- never assistant.
    .filter((p) => p.sourceRole === "user" || p.sourceRole === null)
    .map((p) => ({
      when: p.createdAt,
      source: sourceLabel(p.source),
      formulation: p.formulation,
      sourceText: p.sourceText,
    }));

  const unresolvedQuestion = mostRelevantOpenLoop(idea);
  const decisions = idea.decisions.map((d) => ({ statement: d.statement, decidedAt: d.decidedAt }));

  let suggestedNext = unresolvedQuestion
    ? `Help me work through: ${stripLoopPrefix(unresolvedQuestion)}`
    : "Help me take the next step on this, keeping what I've already established.";
  if (provider) {
    try {
      const facts = JSON.stringify(
        {
          whereYouLeftOff: idea.currentFormulation,
          evolution: evolution.map((e) => e.formulation),
          unresolvedQuestion,
          contested: idea.state === "contested",
        },
        null,
        2,
      );
      const s = (await provider.complete(NEXT_STEP_PROMPT, facts, 200)).trim();
      if (s) suggestedNext = firstSentence(s);
    } catch {
      // keep the template
    }
  }

  const packet: ContinuationPacket = {
    idea: { id: idea.id, title: idea.title, state: idea.state },
    whereYouLeftOff: idea.currentFormulation,
    contested: idea.state === "contested",
    evolution,
    decisions,
    unresolvedQuestion,
    suggestedNext,
  };
  return { text: renderPacket(packet), packet };
}

/** The one place the paste-ready text is produced. Clients copy this verbatim. */
export function renderPacket(p: ContinuationPacket): string {
  const out: string[] = [`Resume: ${p.idea.title}`, "", "Where you left off", p.whereYouLeftOff];
  if (p.contested) out.push("(This idea is contested — a later point conflicts with the above.)");
  out.push("");

  // A question/open_loop event also appends an evolution step, so the unresolved question can
  // show up twice -- once here, once in its own block. Keep the paste clean: drop the echo.
  const q = p.unresolvedQuestion ? stripLoopPrefix(p.unresolvedQuestion).toLowerCase() : null;
  const steps = p.evolution.filter((e) => e.formulation.toLowerCase() !== q);
  if (steps.length > 0) {
    out.push("How this evolved");
    for (const e of steps) {
      const tag = e.source ? `${shortDate(e.when)}, ${e.source}` : shortDate(e.when);
      out.push(`• ${tag}: ${e.formulation}`);
    }
    out.push("");
  }

  if (p.decisions.length > 0) {
    out.push("Decided");
    for (const d of p.decisions) out.push(`• ${d.statement}`);
    out.push("");
  }

  if (p.unresolvedQuestion) {
    out.push("Unresolved question", stripLoopPrefix(p.unresolvedQuestion), "");
  }

  out.push("Continue from here", p.suggestedNext);
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/**
 * Back-compat string API used by the MCP `continue_thinking` tool -- an AI client wants prose,
 * not a JSON packet to re-serialize. Throws on no match (the handler maps that to a 404).
 */
export async function continueThinking(
  db: Database,
  topic: string,
  provider: CompletionProvider,
): Promise<string> {
  const result = await buildContinuationPacket(db, { topic }, provider);
  if (!result) throw new Error(`No ideas found matching topic "${topic}"`);
  return result.text;
}
