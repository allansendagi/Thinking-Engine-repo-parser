/**
 * Core domain model. See README.md for the pipeline this feeds:
 * conversation -> canonical event -> cognitive event -> idea node -> thinking state.
 */

export type Role = "user" | "assistant";

/** One message, after branch resolution -- the export's tree flattened to the path the user kept. */
export interface CanonicalEvent {
  id: string;
  conversationId: string;
  source: "chatgpt" | "claude" | "gemini" | "cursor" | "paste" | "fixture";
  role: Role;
  text: string;
  createdAt: string; // ISO 8601
  /** Position of this message within its conversation's kept path, 0-indexed. */
  index: number;
  /**
   * Canonical URL of the conversation this message was captured from (origin + path, no query
   * or hash) -- e.g. `https://claude.ai/chat/<id>`. One value per conversation; every event in
   * it carries the same URL. Null for pasted transcripts (no URL) and for data captured before
   * this field existed. A structured "view source" affordance only -- never rendered into the
   * paste-ready continuation text.
   */
  sourceUrl?: string | null;
}

export type CognitiveEventType =
  | "new_idea"
  | "claim"
  | "question"
  | "decision"
  | "refinement"
  | "contradiction"
  | "connection"
  | "rejection"
  | "open_loop"
  | "resolution";

/**
 * The extractor's second judgment, orthogonal to `confidence`. `confidence` = "did this
 * genuinely happen in the human's thinking" (extraction reliability). `persistence` = "is this
 * worth carrying into the long-term thinking graph" (editorial worth). A genuine but throwaway
 * "hmm, maybe X could work differently" is high-confidence, low-persistence. The signal gate
 * (state/signalGate.ts) routes on this.
 */
export type PersistenceLevel = "high" | "medium" | "low";

/**
 * What the extraction pass thinks happened in one canonical event. Not yet attached to an
 * IdeaNode -- that's identity resolution's job. `confidence` is the extractor's own estimate
 * that this is a substantive cognitive event at all, not extraction noise.
 */
export interface CognitiveEvent {
  id: string;
  type: CognitiveEventType;
  /** The candidate statement, in the extractor's words grounded in the source text. */
  statement: string;
  /** Only for new_idea: a short noun-phrase name for the idea, when the extractor supplied one. */
  title?: string;
  confidence: number; // 0..1
  /** Worth-remembering judgment. See PersistenceLevel. Treated as "high" for pre-gate data. */
  persistence: PersistenceLevel;
  /** Which rubric bullet drove `persistence` -- one short phrase, so a discard is auditable. */
  persistenceReason?: string;
  /** Primary source -- the ONLY one covered by the grounding/hallucination guarantee. */
  sourceEventId: string;
  /** Verbatim quote from the source CanonicalEvent that grounds this extraction. */
  evidenceQuote: string;
  /** Only meaningful for new_idea. Not fact-checked the way evidenceQuote is. */
  whyItMatters?: string;
  /** Other messages that contributed context. NOT covered by the grounding check. */
  additionalSourceEventIds: string[];
}

/**
 * A grounded cognitive event the signal gate chose NOT to promote. Stored (not dropped) so a
 * threshold or rubric change is replayable, so "why didn't my idea show up" is answerable, and
 * so eval can score the gate. `gateReason` is the deterministic rule that fired.
 */
export interface DiscardedEvent {
  event: CognitiveEvent;
  gateReason: string;
  gateVersion: number;
}

/**
 * `contested` is set when a `contradiction` event lands on an existing idea: the idea now holds
 * a statement that conflicts with its own current formulation, and that tension is recorded as
 * an unresolved open loop. A later `resolution` clears the loop and returns the idea to
 * `developing`. See state/buildIdeaNode.ts.
 */
export type IdeaState = "developing" | "established" | "rejected" | "dormant" | "contested";

export interface EvolutionStep {
  cognitiveEventId: string;
  formulation: string;
  createdAt: string;
  sourceEventId: string;
}

export interface OpenLoop {
  id: string;
  statement: string;
  createdAt: string;
  resolved: boolean;
}

export interface Decision {
  id: string;
  statement: string;
  decidedAt: string;
  sourceEventId: string;
}

export interface IdeaNode {
  id: string;
  title: string;
  state: IdeaState;
  currentFormulation: string;
  whyItMatters?: string;
  evolution: EvolutionStep[];
  openLoops: OpenLoop[];
  decisions: Decision[];
  relatedIdeaIds: string[];
  createdAt: string;
  updatedAt: string;
}

/** Result of comparing one CognitiveEvent against existing IdeaNodes. */
export interface IdentityResolution {
  cognitiveEventId: string;
  /** Existing idea this event refines/relates to, or null if it should become a new idea. */
  matchedIdeaId: string | null;
  confidence: number; // 0..1
  reasoning: string;
  /**
   * Only populated for type "connection": a second existing idea this event links to the
   * matched idea. Establishes a relation, not a merge -- both ideas keep separate identities.
   */
  alsoRelatedIdeaId?: string | null;
}

export const IDENTITY_RESOLUTION_MERGE_THRESHOLD = 0.75;

/**
 * Signal gate (state/signalGate.ts). Bumped whenever the gate's rubric or routing changes, so a
 * stored discard can be traced to the ruleset that produced it and a threshold change is
 * replayable. Not a probability -- a schema version.
 */
export const SIGNAL_GATE_VERSION = 1;

/**
 * A ranked candidate at or above this score counts as "this event attaches to an idea the user
 * already developed", which lets a medium-persistence event through the gate. Deliberately low:
 * a missed-persist is silent and unrecoverable-in-place, a false-persist is a prunable list
 * entry, so the gate leans permissive. Env-overridable (THREAD_SIGNAL_GATE_STRONG_MATCH) for
 * tuning against a real eval set without a redeploy.
 */
export const SIGNAL_GATE_STRONG_MATCH_SCORE = 0.18;

/**
 * The aggregation the spec calls the primary object handed to a human or an AI (THREAD.md §10).
 * Built fresh from IdeaNode[] + CognitiveEvent[] on every request -- it is a view, not a stored
 * object, so it can never drift out of sync with the underlying ideas.
 */
export interface ThinkingState {
  topic: string | null;
  currentIdeas: {
    id: string;
    title: string;
    state: IdeaState;
    currentFormulation: string;
    /** Tool the idea was most recently developed in ("chatgpt" | "claude" | ...), or null. */
    latestSource: string | null;
  }[];
  recentChanges: { ideaId: string; ideaTitle: string; formulation: string; createdAt: string }[];
  decisions: { ideaId: string; ideaTitle: string; statement: string; decidedAt: string }[];
  openLoops: {
    ideaId: string;
    ideaTitle: string;
    loopId: string;
    statement: string;
    resolved: boolean;
    createdAt: string;
    /** Tool the parent idea was most recently developed in, or null. Mirrors currentIdeas[].latestSource. */
    latestSource: string | null;
  }[];
  contradictions: { ideaId: string; ideaTitle: string; formulation: string; createdAt: string }[];
  relatedIdeas: { id: string; title: string }[];
}
