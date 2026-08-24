/**
 * Core domain model. See README.md for the pipeline this feeds:
 * conversation -> canonical event -> cognitive event -> idea node -> thinking state.
 */

export type Role = "user" | "assistant";

/** One message, after branch resolution -- the export's tree flattened to the path the user kept. */
export interface CanonicalEvent {
  id: string;
  conversationId: string;
  source: "chatgpt" | "claude" | "fixture";
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
  sourceEventId: string;
  /** Verbatim quote from the source CanonicalEvent that grounds this extraction. */
  evidenceQuote: string;
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

export interface IdeaNode {
  id: string;
  title: string;
  state: IdeaState;
  currentFormulation: string;
  evolution: EvolutionStep[];
  openLoops: OpenLoop[];
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
}

export const IDENTITY_RESOLUTION_MERGE_THRESHOLD = 0.75;
