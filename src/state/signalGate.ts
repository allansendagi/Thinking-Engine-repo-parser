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
 *       state/fact types (decision / rejection / resolution / connection / contradiction /
 *         open_loop) -> persist -- structurally valuable even when minor
 *       new_idea + leaky types (claim / question / refinement) -> "needs-match": persist ONLY if
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
 */
const STRUCTURAL_TYPES: ReadonlySet<CognitiveEventType> = new Set<CognitiveEventType>([
  "decision",
  "rejection",
  "resolution",
  "connection",
  "contradiction",
  "open_loop",
]);

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
