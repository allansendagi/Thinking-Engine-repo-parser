import type { CognitiveEventType, IdeaNode } from "../types";

/**
 * The thinking map: one idea as a Minto pyramid / IBIS structure, built from its thoughts.
 *
 *   governing thought            -- where the idea stands now (top of the pyramid)
 *   ├─ questions (open/answered) -- IBIS issues
 *   ├─ options (weighed/rejected)-- IBIS positions not (yet) taken
 *   ├─ reasons                   -- the supporting points under the governing thought
 *   ├─ decisions                 -- settled choices
 *   └─ history                   -- earlier positions, superseded (kept, never overwritten)
 *
 * plus GAPS: places the pyramid breaks Minto's rules -- a decision with nothing under it, a
 * question with no options weighed, a contradiction never settled, a group past the "magical
 * number seven". Surfaced quietly as unfinished thinking, which is how the pyramid moves
 * thinking forward instead of only presenting it.
 *
 * Built from thought TYPES the extractor already produces. A claim is treated as a reason when
 * it isn't the current position; telling an "option" claim from a "reason" claim needs the
 * extractor's role field (step 5) -- until then options come from what was rejected or decided.
 */

export interface ThinkingMap {
  ideaId: string;
  title: string;
  governingThought: string;
  questions: { statement: string; raisedAt: string; status: "open" | "answered"; answer?: string }[];
  options: { statement: string; status: "rejected" | "chosen" }[];
  reasons: string[];
  decisions: { statement: string; decidedAt: string }[];
  history: { statement: string; at: string; supersededAt: string | null }[];
  gaps: { kind: Gap; message: string }[];
}

export type Gap = "decision-without-reasons" | "question-without-options" | "unsettled-contradiction" | "too-many-threads";

const POSITIONAL: ReadonlySet<CognitiveEventType> = new Set(["new_idea", "claim", "refinement", "contradiction", "decision"]);
const MAGICAL_NUMBER = 7;
const STALE_QUESTION_DAYS = 14;

/**
 * @param typeOf thought id -> its type (cognitive_events / the consolidation input).
 * @param now    for "open for N days" -- injectable for tests.
 */
export function buildThinkingMap(idea: IdeaNode, typeOf: Map<string, CognitiveEventType>, now = new Date()): ThinkingMap {
  const steps = idea.evolution.map((s) => ({ ...s, type: typeOf.get(s.cognitiveEventId) }));
  const positional = steps.filter((s) => s.type && POSITIONAL.has(s.type));

  const history = positional.map((s, i) => ({
    statement: s.formulation,
    at: s.createdAt,
    supersededAt: positional[i + 1]?.createdAt ?? null,
  }));

  const questions: ThinkingMap["questions"] = idea.openLoops
    .filter((l) => !l.statement.startsWith("Unresolved contradiction:"))
    .map((l) => ({ statement: l.statement, raisedAt: l.createdAt, status: l.resolved ? "answered" : "open" }));
  // Attach answers: each resolution step to the earliest answered question raised before it.
  const answers = steps.filter((s) => s.type === "resolution");
  for (const a of answers) {
    const q = questions.find((x) => x.status === "answered" && !x.answer && x.raisedAt <= a.createdAt);
    if (q) q.answer = a.formulation;
  }

  const decisions = idea.decisions.map((d) => ({ statement: d.statement, decidedAt: d.decidedAt }));
  const options: ThinkingMap["options"] = [
    ...steps.filter((s) => s.type === "rejection").map((s) => ({ statement: s.formulation, status: "rejected" as const })),
    ...decisions.map((d) => ({ statement: d.statement, status: "chosen" as const })),
  ];
  const reasons = steps
    .filter((s) => (s.type === "claim" || s.type === "refinement") && s.formulation !== idea.currentFormulation)
    .map((s) => s.formulation);

  const gaps: ThinkingMap["gaps"] = [];
  if (decisions.length > 0 && reasons.length === 0) {
    gaps.push({ kind: "decision-without-reasons", message: `You decided "${decisions.at(-1)!.statement}", but the reasons behind it weren't captured.` });
  }
  for (const q of questions.filter((x) => x.status === "open")) {
    const days = (now.getTime() - new Date(q.raisedAt).getTime()) / 86_400_000;
    if (days >= STALE_QUESTION_DAYS && options.length === 0) {
      gaps.push({ kind: "question-without-options", message: `"${q.statement}" has been open for ${Math.floor(days)} days with no options weighed.` });
    }
  }
  if (idea.openLoops.some((l) => !l.resolved && l.statement.startsWith("Unresolved contradiction:"))) {
    gaps.push({ kind: "unsettled-contradiction", message: "Two positions on this idea conflict and haven't been reconciled." });
  }
  const threads = questions.filter((q) => q.status === "open").length + options.length + reasons.length;
  if (threads > MAGICAL_NUMBER) {
    gaps.push({ kind: "too-many-threads", message: `This idea now holds ${threads} threads -- more than a mind holds at once. It may be two ideas.` });
  }

  return {
    ideaId: idea.id,
    title: idea.title,
    governingThought: idea.currentFormulation,
    questions,
    options,
    reasons,
    decisions,
    history,
    gaps,
  };
}

/**
 * A Minto-style hand-off (Situation, Complication, Question, Answer) -- the structure a reader
 * (or a new AI chat) absorbs fastest: what this is, what changed, what's open, where it's going.
 * Every line comes from the map; nothing is invented. Lines with nothing to say are omitted.
 */
export function scqaHandoff(map: ThinkingMap): string {
  const lines: string[] = [];
  lines.push(`Situation: I've been developing "${map.title}". Where it stands: ${map.governingThought}`);

  const rejected = map.options.filter((o) => o.status === "rejected").at(-1);
  const contradiction = map.gaps.find((g) => g.kind === "unsettled-contradiction");
  const superseded = map.history.filter((h) => h.supersededAt).at(-1);
  if (contradiction) lines.push(`Complication: ${contradiction.message}`);
  else if (rejected) lines.push(`Complication: I ruled out an option -- ${rejected.statement}`);
  else if (superseded) lines.push(`Complication: my thinking moved on from "${superseded.statement}".`);

  const open = map.questions.filter((q) => q.status === "open");
  if (open.length > 0) lines.push(`Question: ${open.at(-1)!.statement}`);

  const decided = map.decisions.at(-1);
  if (decided) lines.push(`Answer so far: ${decided.statement}`);
  if (map.reasons.length > 0) lines.push(`Because: ${map.reasons.slice(-3).join(" · ")}`);
  return lines.join("\n");
}
