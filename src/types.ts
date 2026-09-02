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
 * What the extraction pass thinks happened in one canonical event. Not yet attached to an
 * IdeaNode -- that's identity resolution's job. `confidence` is the extractor's own estimate
 * that this is a substantive cognitive event at all, not extraction noise.
 */
export interface CognitiveEvent {
  id: string;
  type: CognitiveEventType;
  /** The candidate statement, in the extractor's words grounded in the source text. */
  statement: string;
  confidence: number; // 0..1
  /** Primary source -- the ONLY one covered by the grounding/hallucination guarantee. */
  sourceEventId: string;
  /** Verbatim quote from the source CanonicalEvent that grounds this extraction. */
  evidenceQuote: string;
  /** Only meaningful for new_idea. Not fact-checked the way evidenceQuote is. */
  whyItMatters?: string;
  /** Other messages that contributed context. NOT covered by the grounding check. */
  additionalSourceEventIds: string[];
}

export type IdeaState = "developing" | "established" | "rejected" | "dormant";

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
