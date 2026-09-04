import type { Database } from "bun:sqlite";
import type { CompletionProvider } from "../providers/types";
import {
  loadIdeas,
  loadIdea as loadIdeaById,
  loadCognitiveEvents,
  loadCanonicalEvents,
} from "../db/queries";
import { buildThinkingState } from "../state/thinkingState";
import { lexicalOverlap, entityOverlap } from "../identity/signals";
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

export function searchIdeas(
  db: Database,
  query: string,
  limit = 10,
): IdeaSummary[] {
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
  /** Canonical URL of the conversation this step was captured from -- a "view source" link.
   *  Null for pastes and pre-URL data. Never rendered into the paste-ready continuation text. */
  sourceUrl: string | null;
  /** Id of the conversation this step came from. Lets a client open the captured transcript
   *  (`GET /v1/conversations/:id`) rather than only linking out to the live chat. */
  conversationId: string | null;
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
      sourceUrl: source?.sourceUrl ?? null,
      conversationId: source?.conversationId ?? null,
    };
  });

  return { idea, provenance };
}

export function getThreadState(db: Database, topic?: string): ThinkingState {
  const sourceByEventId = new Map(
    loadCanonicalEvents(db).map((e) => [e.id, e.source] as const),
  );
  return buildThinkingState(
    loadIdeas(db),
    loadCognitiveEvents(db),
    { topic },
    sourceByEventId,
  );
}

export function getOpenLoops(
  db: Database,
  topic?: string,
): ThinkingState["openLoops"] {
  return getThreadState(db, topic).openLoops.filter((l) => !l.resolved);
}

export function getRecentChanges(
  db: Database,
  sinceDays = 14,
): ThinkingState["recentChanges"] {
  return buildThinkingState(loadIdeas(db), loadCognitiveEvents(db), {
    recentWindowDays: sinceDays,
  }).recentChanges;
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

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** Loops from a contradiction are stored prefixed; drop it for display. */
function stripLoopPrefix(s: string): string {
  return s.replace(/^Unresolved contradiction:\s*/i, "");
}

function firstSentence(s: string): string {
  const m = s.match(/^.*?[.?!](\s|$)/);
  return (m ? m[0] : s).trim();
}

/**
 * Rendered `text` carries this token at the "Continue from here" position instead of the
 * suggested line itself. A client drops in the user's edited line with ONE literal replace --
 * no re-rendering the packet, no fragile natural-language anchor matching. Resolve it with
 * `resolveContinueToken` before the text is shown to anyone (the MCP prose path does; the Mac
 * app substitutes locally so the field stays editable offline).
 */
export const CONTINUE_TOKEN = "{{CONTINUE_FROM_HERE}}";
/** Marks where the one-sentence "how your thinking changed" line goes (human card path only). */
export const THINKING_SHIFT_TOKEN = "{{THINKING_SHIFT}}";
/** Marks where the distilled trajectory chain goes in the machine handoff — the Mac fills it
 *  from `packet.trajectory` (on-device-upgraded for Free) without re-rendering. */
export const THINKING_EVOLUTION_TOKEN = "{{THINKING_EVOLUTION}}";

export function resolveContinueToken(text: string, line: string): string {
  return text.replace(CONTINUE_TOKEN, line);
}

/** The distilled steps as a top-down chain: `phrase\n  ↓\n  phrase\n  ↓\n  phrase`. */
export function trajectoryChain(phrases: string[]): string {
  return phrases.filter(Boolean).join("\n  ↓\n  ");
}

/** Fill every model-written slot. The MCP prose path bakes them in; the Mac substitutes locally
 *  so each field stays editable / upgradable offline. Replacing a token that isn't present is a
 *  no-op, so this is safe against both the machine format and the older human render. */
export function resolvePacketText(
  text: string,
  opts: {
    nextStep: string;
    thinkingShift?: string | null;
    trajectory?: string[] | null;
  },
): string {
  return text
    .replace(CONTINUE_TOKEN, opts.nextStep)
    .replace(THINKING_SHIFT_TOKEN, (opts.thinkingShift ?? "").trim())
    .replace(THINKING_EVOLUTION_TOKEN, trajectoryChain(opts.trajectory ?? []));
}

/** Relative phrasing for the "Last explored" line — "today" / "9 days ago" / "3 weeks ago". */
export function relativeWhen(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const days = Math.round((now.getTime() - then) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
}

export interface ContinuationEvolutionStep {
  when: string; // ISO
  source: string | null; // display label ("ChatGPT" | "Claude" | ...)
  formulation: string;
  /** The full user message the step came from -- for the app's "view source" affordance. Not in `text`. */
  sourceText: string | null;
  /** Canonical URL of the conversation this step came from -- the app's "view source" link.
   *  Null for pastes / pre-URL data. Not in `text` (a link to another chat is noise there). */
  sourceUrl: string | null;
}

export interface ContinuationPacket {
  idea: { id: string; title: string; state: IdeaNode["state"] };
  /** = current formulation. "Where you left off." */
  whereYouLeftOff: string;
  contested: boolean;
  /** Verified user-authored steps only, full history (the paste text abridges; the app preview
   *  can show all). Empty when the idea predates source-role verification -- see `evolutionUnverified`. */
  evolution: ContinuationEvolutionStep[];
  /** True when the idea HAS provenance but none of it is a verified user message (legacy data).
   *  The packet then says so plainly instead of presenting unattributable steps as the user's. */
  evolutionUnverified: boolean;
  decisions: { statement: string; decidedAt: string }[];
  /** The most relevant unresolved loop (contradiction preferred when contested), or null.
   *  Kept for the human card + `suggestedNext`; the machine handoff uses `unresolvedQuestions`. */
  unresolvedQuestion: string | null;
  /** Every unresolved loop, newest first, capped — for the machine handoff's UNRESOLVED block. */
  unresolvedQuestions: string[];
  /** One line to paste into a fresh chat. Model-generated, template fallback. Editable client-side. */
  suggestedNext: string;
  /** The trajectory distilled to one <=6-word phrase per verified step, in order. Empty below 2
   *  verified steps. Model-written, first-words template fallback. Fills THINKING_EVOLUTION_TOKEN. */
  trajectory: string[];
  /** One synthesized sentence — "You moved from X toward Y" — naming how the thinking shifted.
   *  Null unless there are >= 2 verified steps. Model-written, literal template fallback. */
  thinkingShift: string | null;
  /** Where + when the idea was last worked on, for the "Last explored" line. */
  lastExploredSource: string | null;
  lastExploredAt: string | null;
  /** The Minto-style synthesis across this idea and any others it turned out to be part of one
   *  argument with. Null whenever no candidate cluster passed the coherence check (no provider,
   *  no candidates cleared the retrieval floor, or the model itself said they don't cohere) --
   *  the packet is then unchanged from before this field existed. See buildGoverningThought. */
  governingThought: GoverningThought | null;
}

export interface GoverningThought {
  /** One sentence: what the idea + its members collectively amount to. */
  statement: string;
  /** Plural noun naming what the members ARE relative to the statement -- "reasons",
   *  "objections", "consequences". Minto's rule-2 shortcut: a cluster that can't be named this
   *  way isn't one coherent argument, so the model is required to produce it, not offered it. */
  kind: string;
  members: { id: string; title: string; currentFormulation: string }[];
}

const NEXT_STEP_PROMPT = `You are given a line of thinking a person developed with AI. Write ONE sentence they can paste into a new AI chat to pick it back up — an instruction in their own voice, grounded only in what's given. If there is an unresolved question, point at it; if not, push the current formulation forward, or resolve the conflict if it's contested. Always produce a usable sentence — never refuse, never mention being an AI or a model. No preamble, no "you should", one sentence.`;

/** A model that deflected instead of answering — a canned refusal or meta-commentary. The
 *  caller keeps the deterministic template rather than show this. */
function looksLikeRefusal(s: string): boolean {
  const t = s.toLowerCase().trim();
  if (!t) return true;
  return (
    /^(i'm sorry|i am sorry|i cannot|i can't|i can not|i'm unable|i am unable|i'm not able|i apologize|as an ai|as a chatbot|as a language model|unfortunately, i|sorry, )/.test(
      t,
    ) ||
    /as a chatbot|as an ai language model|created by (apple|openai|anthropic)|i cannot provide|i'?m unable to provide|cannot fulfil|against my guidelines|when none exists/.test(
      t,
    )
  );
}

const THINKING_SHIFT_PROMPT = `You're given the first and current version of one line of a person's thinking. In ONE sentence beginning "You moved from", name the conceptual shift between them — the change in position, not a reword. No preamble, no hedging, one sentence.`;

const THINKING_EVOLUTION_PROMPT = `Distil each formulation to a headline of AT MOST 5 words — the core move, not a summary, never the sentence itself. Output ONLY the headlines, one per line, same count and order, nothing else. Example: "AI governance needs better oversight policies." becomes "governance by written policy".`;

/** Template fallback for a trajectory phrase: the formulation's leading clause, first ~6 words. */
function shortPhrase(s: string): string {
  const clause = s.split(/[—–:;.]/)[0]!.trim() || s.trim();
  const words = clause.split(/\s+/).slice(0, 6).join(" ");
  return words.replace(/[.,;:]+$/, "");
}

function pickIdeaForTopic(db: Database, topic: string): IdeaNode | null {
  const matches = getThreadState(db, topic).currentIdeas;
  if (matches.length === 0) return null;
  // Best lexical match on title+formulation; tie-break toward the one most recently worked on.
  const best = matches
    .map((i) => ({
      id: i.id,
      score: lexicalOverlap(topic, `${i.title} ${i.currentFormulation}`),
    }))
    .sort((a, b) => b.score - a.score)[0]!;
  return getIdea(db, best.id);
}

function mostRelevantOpenLoop(idea: IdeaNode): string | null {
  const open = idea.openLoops.filter((l) => !l.resolved);
  if (open.length === 0) return null;
  if (idea.state === "contested") {
    const contradiction = open.find((l) =>
      /^Unresolved contradiction:/i.test(l.statement),
    );
    if (contradiction) return contradiction.statement;
  }
  return [...open].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!
    .statement;
}

// --- Governing thought: the Minto-style synthesis across a small cluster of related ideas ---
//
// Retrieval is deliberately loose (lexical + entity overlap -- the same non-model signal
// identity resolution already ranks candidates with in identity/signals.ts; no embedding
// provider is configured server-side, see providers/embeddings.ts, so this doesn't wait on that
// decision). It only has to produce a plausible handful. The coherence check below, not
// retrieval precision, is what decides whether a governing thought ever renders.

const GOVERNING_THOUGHT_CANDIDATE_FLOOR = 0.2;
/** At/above this, a candidate is near-VERBATIM the same text as the seed -- not a "supporting
 *  idea", a duplicate (dedup's job, see state/dedup.ts). This is narrow by construction: it only
 *  catches near-identical strings (confirmed against the real account -- the 1.00 pairs there
 *  were exact-duplicate `current_formulation` text), not a paraphrased restatement of the same
 *  claim in different words (measured ~0.26 for a realistic paraphrase, comfortably inside the
 *  candidate window). Paraphrased duplicates are left to the model's coherence judgment below,
 *  not this floor -- the prompt is written to ask for it explicitly. */
const GOVERNING_THOUGHT_NEAR_DUPLICATE_CEILING = 0.85;
const GOVERNING_THOUGHT_MAX_CANDIDATES = 4;

/** Up to 4 other ideas whose current formulation reads close to this one's, near-duplicates
 *  excluded -- candidates only, not a claim that they form a real cluster. */
function relatedCandidates(seed: IdeaNode, allIdeas: IdeaNode[]): IdeaNode[] {
  return allIdeas
    .filter((i) => i.id !== seed.id)
    .map((idea) => ({
      idea,
      score:
        0.6 * lexicalOverlap(seed.currentFormulation, idea.currentFormulation) +
        0.4 * entityOverlap(seed.currentFormulation, idea.currentFormulation),
    }))
    .filter(
      (c) =>
        c.score >= GOVERNING_THOUGHT_CANDIDATE_FLOOR &&
        c.score < GOVERNING_THOUGHT_NEAR_DUPLICATE_CEILING,
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, GOVERNING_THOUGHT_MAX_CANDIDATES)
    .map((c) => c.idea);
}

const GOVERNING_THOUGHT_PROMPT = `You are given a person's current line of thinking, and up to 4 other ideas from their thinking graph (numbered 1-4) retrieved because they read similarly. Decide whether they genuinely form ONE coherent line of thinking -- not just shared vocabulary. Never invent a relationship the ideas themselves don't support. If one of the other ideas is really just a restatement of the current thought in different words -- not a distinct reason, consequence, or step -- drop it; it is not support.

Reply with ONLY a JSON object, no other text:
{"coherent": true or false,
 "governingThought": "one sentence stating what the current thought and the SUPPORTING ideas collectively mean -- the synthesis, never a list or a restatement of the current thought alone. Required when coherent is true.",
 "groupType": "a plural noun naming what the supporting ideas ARE in relation to the governing thought -- e.g. reasons, objections, consequences, examples, preconditions, constraints. At most a few words, no sentence. Required when coherent is true.",
 "supportingIdeaIds": "the numbers (1-4) of ONLY the other ideas that actually belong to this governing thought -- drop any that don't fit or merely restate the current thought. Required, non-empty, when coherent is true."}

Say coherent:false whenever none of the other ideas genuinely build one argument with the current thought -- a wrong synthesis is worse than none. Never mention being an AI or a model.`;

interface GoverningThoughtDecision {
  statement: string;
  kind: string;
  supportingIndexes: number[];
}

/** Parses + validates the governing-thought response. Rejects (returns null) on anything that
 *  isn't a clean coherent:true with every field present and well-formed -- an out-of-range
 *  index, an empty subset, a `kind` too long to plausibly be a plural noun rather than a
 *  sentence, or refusal-shaped text. The caller then shows nothing, exactly as if no candidates
 *  had cleared retrieval at all. */
function parseGoverningThoughtResponse(
  raw: string,
  candidateCount: number,
): GoverningThoughtDecision | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as {
    coherent?: unknown;
    governingThought?: unknown;
    groupType?: unknown;
    supportingIdeaIds?: unknown;
  };
  if (o.coherent !== true) return null;
  const statement =
    typeof o.governingThought === "string" ? o.governingThought.trim() : "";
  const kind =
    typeof o.groupType === "string" ? o.groupType.trim().toLowerCase() : "";
  if (!statement || !kind) return null;
  if (looksLikeRefusal(statement) || looksLikeRefusal(kind)) return null;
  if (statement.length > 240) return null;
  if (kind.split(/\s+/).length > 4 || kind.length > 40) return null;

  const rawIds = Array.isArray(o.supportingIdeaIds) ? o.supportingIdeaIds : [];
  const supportingIndexes = [...new Set(rawIds.map(Number))]
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= candidateCount)
    .sort((a, b) => a - b);
  if (supportingIndexes.length === 0) return null;

  return { statement: firstSentence(statement), kind, supportingIndexes };
}

/** The full governing-thought pass for one idea: retrieve candidates, ask the model to
 *  synthesize + name the shared kind + pick which candidates actually belong, validate. Null
 *  whenever there's no provider, no candidates clear the retrieval floor, the call fails, or the
 *  model itself says they don't cohere. */
async function buildGoverningThought(
  seed: IdeaNode,
  allIdeas: IdeaNode[],
  provider?: CompletionProvider,
): Promise<GoverningThought | null> {
  if (!provider) return null;
  const candidates = relatedCandidates(seed, allIdeas);
  if (candidates.length === 0) return null;

  const facts = JSON.stringify(
    {
      currentThought: seed.currentFormulation,
      otherIdeas: candidates.map((c, i) => ({
        id: i + 1,
        formulation: c.currentFormulation,
      })),
    },
    null,
    2,
  );
  try {
    const raw = await provider.complete(GOVERNING_THOUGHT_PROMPT, facts, 260);
    const decision = parseGoverningThoughtResponse(raw, candidates.length);
    if (!decision) return null;
    const members = decision.supportingIndexes.map((n) => {
      const c = candidates[n - 1]!;
      return {
        id: c.id,
        title: c.title,
        currentFormulation: c.currentFormulation,
      };
    });
    return { statement: decision.statement, kind: decision.kind, members };
  } catch {
    return null;
  }
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
  // Strict: only steps we can prove the human wrote. `sourceRole === null` is UNKNOWN, not the
  // user -- including it would make an attribution claim the data can't back. Legacy ideas whose
  // steps are all unknown fall through to `evolutionUnverified` and an honest line in the text.
  const evolution: ContinuationEvolutionStep[] = trace.provenance
    .filter((p) => p.sourceRole === "user")
    .map((p) => ({
      when: p.createdAt,
      source: sourceLabel(p.source),
      formulation: p.formulation,
      sourceText: p.sourceText,
      sourceUrl: p.sourceUrl,
    }));
  const evolutionUnverified =
    evolution.length === 0 && trace.provenance.length > 0;

  const unresolvedQuestion = mostRelevantOpenLoop(idea);
  const decisions = idea.decisions.map((d) => ({
    statement: d.statement,
    decidedAt: d.decidedAt,
  }));

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
      if (s && !looksLikeRefusal(s)) suggestedNext = firstSentence(s);
    } catch {
      // keep the template
    }
  }

  // How the thinking shifted — only meaningful with at least a start and a current point.
  let thinkingShift: string | null = null;
  if (evolution.length >= 2) {
    const first = evolution[0]!.formulation;
    const last = evolution[evolution.length - 1]!.formulation;
    thinkingShift = `You moved from "${first}" toward "${last}".`;
    if (provider) {
      try {
        const s = (
          await provider.complete(
            THINKING_SHIFT_PROMPT,
            JSON.stringify({ from: first, to: last }, null, 2),
            160,
          )
        ).trim();
        if (/^you moved from\b/i.test(s) && !looksLikeRefusal(s))
          thinkingShift = firstSentence(s);
      } catch {
        // keep the literal template
      }
    }
  }

  // The trajectory, one <=6-word phrase per verified step.
  let trajectory: string[] = [];
  if (evolution.length >= 2) {
    trajectory = evolution.map((e) => shortPhrase(e.formulation));
    if (provider) {
      try {
        const raw = (
          await provider.complete(
            THINKING_EVOLUTION_PROMPT,
            JSON.stringify(
              evolution.map((e) => e.formulation),
              null,
              2,
            ),
            240,
          )
        ).trim();
        const lines = raw
          .split("\n")
          .map((l) =>
            l
              .replace(/^[\s\-•*\d.)]+/, "")
              .trim()
              .replace(/[.,;:]+$/, ""),
          )
          .filter(Boolean);
        // Take it only if it actually distilled — a weaker model sometimes echoes the input.
        const distilled =
          lines.length === evolution.length &&
          lines.every(
            (l) =>
              l.split(/\s+/).length <= 7 &&
              l.length <= 60 &&
              !looksLikeRefusal(l),
          );
        if (distilled) trajectory = lines;
      } catch {
        // keep the first-words template
      }
    }
  }

  // Every unresolved loop, newest first, capped — for the machine handoff's UNRESOLVED block.
  const unresolvedQuestions = [...idea.openLoops]
    .filter((l) => !l.resolved)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 3)
    .map((l) => stripLoopPrefix(l.statement));

  // Last explored: newest verified step, else newest provenance of any kind.
  const newestVerified = evolution.length
    ? evolution[evolution.length - 1]!
    : null;
  const newestAny = trace.provenance.length
    ? [...trace.provenance]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .at(-1)!
    : null;
  const lastExploredAt = newestVerified?.when ?? newestAny?.createdAt ?? null;
  const lastExploredSource =
    newestVerified?.source ?? sourceLabel(newestAny?.source ?? null);

  const governingThought = await buildGoverningThought(
    idea,
    loadIdeas(db),
    provider,
  );

  const packet: ContinuationPacket = {
    idea: { id: idea.id, title: idea.title, state: idea.state },
    whereYouLeftOff: idea.currentFormulation,
    contested: idea.state === "contested",
    evolution,
    evolutionUnverified,
    decisions,
    unresolvedQuestion,
    unresolvedQuestions,
    suggestedNext,
    trajectory,
    thinkingShift,
    lastExploredSource,
    lastExploredAt,
    governingThought,
  };
  return { text: renderPacket(packet), packet };
}

/**
 * The paste-ready handoff — a structured brief an AI picks up from, not prose it summarizes.
 * ALL-CAPS field labels, terse. Model-written slots (the trajectory chain, the next step) are
 * emitted as tokens, not baked in; `resolvePacketText` fills them (the MCP prose path, and the
 * Mac after any on-device upgrade). Every section is omitted when it has nothing to say.
 */
export function renderPacket(
  p: ContinuationPacket,
  now: Date = new Date(),
): string {
  const out: string[] = [];
  if (p.governingThought) {
    out.push("GOVERNING THOUGHT", p.governingThought.statement, "");
  }
  out.push(
    "CURRENT IDEA",
    p.idea.title,
    "",
    "CURRENT FORMULATION",
    p.whereYouLeftOff,
  );
  if (p.contested)
    out.push("(contested — a later point conflicts with the above)");

  if (p.governingThought) {
    out.push("", `RELATED THINKING (${p.governingThought.kind})`);
    for (const m of p.governingThought.members)
      out.push(`${m.title} — ${m.currentFormulation}`);
  }

  if (p.decisions.length > 0) {
    out.push("", "ESTABLISHED");
    for (const d of p.decisions) out.push(d.statement);
  }

  if (p.trajectory.length > 0) {
    out.push("", "THINKING EVOLUTION", `  ${THINKING_EVOLUTION_TOKEN}`);
  } else if (p.evolutionUnverified) {
    out.push(
      "",
      "THINKING EVOLUTION",
      "(captured before source-role verification — earlier wording unavailable)",
    );
  }

  if (p.unresolvedQuestions.length > 0) {
    out.push("", "UNRESOLVED");
    for (const q of p.unresolvedQuestions) out.push(q);
  }

  if (p.evolution.length > 0) {
    out.push("", "RECENT EVIDENCE");
    const seen = new Set<string>();
    for (const e of [...p.evolution].reverse()) {
      const row = `${e.source ?? "Unknown"} — ${shortDate(e.when)}`;
      if (seen.has(row)) continue;
      seen.add(row);
      out.push(row);
      if (seen.size >= 2) break;
    }
  }

  out.push(
    "",
    "TASK",
    "Continue the reasoning from this exact state. Do not restart the exploration.",
    "",
    CONTINUE_TOKEN,
  );
  return (
    out
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd() + "\n"
  );
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
  // Prose consumer: bake every model-written slot in where its token sits.
  return resolvePacketText(result.text, {
    nextStep: result.packet.suggestedNext,
    thinkingShift: result.packet.thinkingShift,
    trajectory: result.packet.trajectory,
  });
}
