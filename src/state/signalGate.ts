import type { CognitiveEvent, CognitiveEventType } from "../types";
import { SIGNAL_GATE_STRONG_MATCH_SCORE } from "../types";

/**
 * The signal gate: a deterministic VALUE gate that runs after grounding and before identity
 * resolution. Grounding proves a thought was said; this decides whether it's worth carrying into
 * the long-term thinking graph. It never calls a model -- it routes on the two judgments
 * extraction already produced (`type`, `persistence`).
 *
 * Routing:
 *   - persistence "high"  -> persist
 *   - persistence "low"   -> discard
 *   - persistence "medium":
 *       state/fact types (decision / resolution / connection / contradiction / open_loop)
 *         -> persist -- structurally valuable even when minor
 *       new_idea, rejection + leaky types (claim / question / refinement) -> "needs-match": persist ONLY if
 *         the event attaches to an idea the user is already developing (the pipeline checks the
 *         top candidate-rank score against strongMatchScore()). A medium new_idea with no such
 *         match is stored, not persisted -- it's a tentative early thought, replayable later.
 *
 * Error asymmetry is deliberate and the OPPOSITE of a spam filter: a missed-persist is silent
 * and can't be fixed in place, a false-persist is a prunable list entry -- so the gate leans
 * permissive and every discard is stored (state/pipeline.ts), replayable via SIGNAL_GATE_VERSION.
 *
 * Kill switch: mode "off" makes every event persist (no-op gate), matching the repo pattern of a
 * feature being inert until deliberately turned on. "strict" additionally makes structural-type
 * medium events require a match too. Mode and the strong-match score default from env
 * (THREAD_SIGNAL_GATE_MODE, THREAD_SIGNAL_GATE_STRONG_MATCH) but are passable explicitly so tests
 * never mutate process-global state -- bun runs test files concurrently in one process.
 */

/**
 * Types that persist even at `medium` in lenient mode -- each changes an idea's state or records
 * a fact, so it's worth keeping even when minor. `new_idea` is deliberately NOT here (SIGNAL_GATE
 * v2): a medium new_idea is, by the rubric's own words, "a tentative early thought", and spawning
 * a fresh node for every one of those is what clutters a backfilled graph. It still gets its
 * chance -- it routes to needs-match, so it persists if it attaches to an idea already being
 * developed and is stored (replayable) if it doesn't.
 *
 * v4: `rejection` left this set. A rejection is ABOUT an idea (mining treats it as a satellite,
 * never an anchor), so a minor one only means something attached to an idea being developed.
 * Measured on one person's 50 labelled thoughts: both medium rejections were not ideas
 * ("I prefer the brevity of the previous version" -- feedback on the AI's draft), 0 kept lost.
 */
const STRUCTURAL_TYPES: ReadonlySet<CognitiveEventType> = new Set<CognitiveEventType>([
  "decision",
  "resolution",
  "connection",
  "contradiction",
  "open_loop",
]);

/**
 * v3 -- a plain information request phrased as a question ("What does Raycast do?", "Where is
 * Codex?", "Can you explain X"). The extraction prompt already says these are not questions the
 * person is trying to resolve, yet the model still emits them -- and rates them persistence
 * "high", so the persistence routing never saw them. Measured on 50 of one person's extracted
 * thoughts: questions were kept only 20% of the time, and this narrow pattern caught 3 thoughts,
 * all 3 not ideas, with no real idea lost. Deliberately NARROW: short, no first-person
 * ("What should we do about X?" and "What is the minimum viable authority?" stay), and only for
 * `question`. Blunter rules (all questions, all short statements) lost real ideas -- "Pricing
 * communicates positioning" -- so they are NOT here; "worth keeping" is personal and is learned
 * per person instead (see the personal-taste work).
 */
const LOOKUP_QUESTION =
  /^\s*(?:(?:what|where|who|when|which)\s+(?:is|are|was|were|does|do|did)\b|(?:can|could|would|will)\s+you\b|(?:tell|show|explain|give|list|write|make)\b)/i;
// "me"/"us" are not here: "Can you give me the clips" is exactly the request this rule is for.
const FIRST_PERSON = /\b(?:i|i'm|i've|i'll|my|we|we're|our)\b/i;

export function isLookupQuestion(event: Pick<CognitiveEvent, "type" | "statement">): boolean {
  if (event.type !== "question") return false;
  const s = event.statement.trim();
  return s.length <= 100 && LOOKUP_QUESTION.test(s) && !FIRST_PERSON.test(s);
}

export type GateMode = "off" | "lenient" | "strict";

export type QuickGate =
  | { decision: "persist" }
  | { decision: "discard"; reason: string }
  | { decision: "needs-match"; reason: string };

/** Explicit mode wins; otherwise THREAD_SIGNAL_GATE_MODE; otherwise "lenient". */
export function resolveMode(explicit?: GateMode): GateMode {
  if (explicit) return explicit;
  const m = process.env.THREAD_SIGNAL_GATE_MODE;
  return m === "off" || m === "strict" ? m : "lenient";
}

/** Score at/above which a ranked candidate counts as "an idea the user already developed". */
export function strongMatchScore(override?: number): number {
  if (override !== undefined && Number.isFinite(override) && override > 0) return override;
  const env = Number(process.env.THREAD_SIGNAL_GATE_STRONG_MATCH);
  return Number.isFinite(env) && env > 0 ? env : SIGNAL_GATE_STRONG_MATCH_SCORE;
}

/**
 * Phase-1 decision: needs only the event. "needs-match" defers to the pipeline, which has the
 * candidate ranking it must compute for identity resolution anyway -- so high/low events never
 * pay for ranking they don't need.
 */
export function quickGate(event: CognitiveEvent, mode: GateMode = resolveMode()): QuickGate {
  if (mode === "off") return { decision: "persist" };

  // Before the persistence routing: the model rates these "high", so routing on persistence alone
  // never catches them. The reason must NOT contain the replayable marker -- an information
  // request doesn't become an idea later; it is a permanent no, like persistence=low.
  if (isLookupQuestion(event)) {
    return { decision: "discard", reason: "information request, not a question the person is trying to resolve" };
  }

  const persistence = event.persistence ?? "high";
  if (persistence === "high") return { decision: "persist" };
  if (persistence === "low") {
    return {
      decision: "discard",
      reason: `persistence=low${event.persistenceReason ? ` (${event.persistenceReason})` : ""}`,
    };
  }

  // persistence === "medium"
  if (mode === "lenient" && STRUCTURAL_TYPES.has(event.type)) {
    return { decision: "persist" };
  }
  return {
    decision: "needs-match",
    reason: `persistence=medium, ${event.type} -- persist only if it extends an existing idea`,
  };
}
