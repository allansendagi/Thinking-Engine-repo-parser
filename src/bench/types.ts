import type { CanonicalEvent, CognitiveEventType } from "../types";

/**
 * The thinking bench: synthetic thinkers whose ideas, and how those ideas evolve, are known in
 * advance -- so a miner's output can be scored exactly instead of eyeballed. See README.md in
 * this directory.
 */

/** IBIS-style role a thought plays in its idea (Kunz & Rittel; also the Minto question/answer
 *  dialogue): what the bench checks a "thinking map" against. */
export type ThoughtRole =
  | "position" // what the idea IS -- introduced, restated, refined
  | "question" // something the person is trying to resolve
  | "option" // a candidate answer they're weighing
  | "reason" // an argument for / against something
  | "decision" // a settled choice
  | "rejection" // an abandoned option or direction
  | "answer"; // resolves a question

export interface GoldThought {
  /** Message the thought is grounded in. */
  messageId: string;
  /** Key of the gold idea it belongs to. */
  idea: string;
  type: CognitiveEventType;
  role: ThoughtRole;
  /** The thought, decontextualized: readable on its own, in the person's voice. */
  statement: string;
  /** Verbatim substring of the message that grounds it. */
  quote: string;
  /** Opens (question) or closes (answer) an open loop -- the loop's key. */
  loop?: string;
  /** Adopted from the assistant's previous message: the person accepted a proposal they didn't
   *  phrase themselves ("yes, the second one"). Both sides are verbatim-grounded. */
  adopted?: { assistantMessageId: string; quote: string };
}

export interface GoldIdea {
  key: string;
  title: string;
  /** messageId of the thought that states where the idea stands at the end. */
  finalPositionMessageId: string;
  /** Loop keys still open at the end, and loop keys that were answered. */
  openLoops: string[];
  resolvedLoops: string[];
  /** messageIds of decision thoughts. */
  decisions: string[];
  /** Ideas this one is easily confused with by vocabulary -- merging them is a critical error. */
  confusableWith: string[];
}

export interface Scenario {
  name: string;
  persona: string;
  events: CanonicalEvent[];
  thoughts: GoldThought[];
  ideas: GoldIdea[];
  /** User messages with nothing idea-worthy in them (thanks, formatting asks, info requests). */
  noiseMessageIds: string[];
}

/** What any miner (v1 today, v2 tomorrow) hands back for scoring. */
export interface MinedIdea {
  id: string;
  title: string;
  /** Source message ids of the thoughts grouped into this idea. */
  messageIds: string[];
  /** Source message id the current formulation came from, if known. */
  currentFormulationMessageId?: string;
  currentFormulation: string;
  openLoops: { statement: string; resolved: boolean; messageId?: string }[];
  decisionMessageIds: string[];
  state: string;
}
