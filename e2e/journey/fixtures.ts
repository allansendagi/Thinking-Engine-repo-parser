/**
 * Fixtures for the end-to-end user-journey simulation (../journey.ts).
 *
 * One thought -- "computable authority" -- developed across four AI tools in sequence:
 *   ChatGPT (born + a decision)  ->  Claude (refined)  ->  Gemini (an open question)  ->  Cursor
 * Each conversation carries a unique MARKER string in its first user turn; the fake extraction
 * provider keys off that marker so responses don't depend on call order. Identity resolution is
 * scripted to merge every follow-up into the one idea born in the ChatGPT conversation.
 */

export interface JourneyMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}

export interface JourneyConversation {
  marker: string;
  source: "chatgpt" | "claude" | "gemini" | "cursor";
  conversationId: string;
  sourceUrl: string;
  messages: JourneyMessage[];
  /** What the (fake) extraction model returns for this conversation. */
  extraction: { events: unknown[] };
}

// Dates are relative to run time so the journey exercises the recency-sensitive parts (the
// 30-day Thinking-State window, the return-nudge rule). `d` = days before now.
const day = 86_400_000;
const t = (daysAgo: number, offsetMin = 0) => new Date(Date.now() - daysAgo * day + offsetMin * 60_000).toISOString();

// The idea id the pipeline derives: `idea_${cognitiveEventId}` and the cognitive id is
// `cog_${source_event_id}_${i}`. The first substantive turn below is `cg_u1`, so:
export const IDEA_ID = "idea_cog_cg_u1_0";

export const CONVERSATIONS: JourneyConversation[] = [
  {
    marker: "JOURNEY-CHATGPT-AUTHORITY",
    source: "chatgpt",
    conversationId: "chatgpt-authority",
    sourceUrl: "https://chatgpt.com/c/chatgpt-authority",
    messages: [
      {
        id: "cg_u1",
        role: "user",
        text: "JOURNEY-CHATGPT-AUTHORITY. I keep coming back to this: an AI agent's authority only means something if its boundaries are explicit and machine-checkable, not a paragraph in a system prompt.",
        createdAt: t(40),
      },
      {
        id: "cg_a1",
        role: "assistant",
        text: "That points toward a capability model rather than prose instructions -- authority as a set of signed, enumerable grants.",
        createdAt: t(40, 1),
      },
      {
        id: "cg_u2",
        role: "user",
        text: "Right. Decision: the boundary spec is the source of truth, and the runtime refuses anything not explicitly granted -- default deny.",
        createdAt: t(40, 2),
      },
    ],
    extraction: {
      events: [
        {
          type: "new_idea",
          statement: "An AI agent's authority is only meaningful if its boundaries are explicit and machine-checkable.",
          confidence: 0.95,
          persistence: "high",
          source_event_id: "cg_u1",
          evidence_quote: "explicit and machine-checkable",
        },
        {
          type: "decision",
          statement: "The boundary spec is the source of truth; the runtime is default-deny.",
          confidence: 0.9,
          persistence: "high",
          source_event_id: "cg_u2",
          evidence_quote: "default deny",
        },
      ],
    },
  },
  {
    marker: "JOURNEY-CLAUDE-AUTHORITY",
    source: "claude",
    conversationId: "claude-authority",
    sourceUrl: "https://claude.ai/chat/claude-authority",
    messages: [
      {
        id: "cl_u1",
        role: "user",
        text: "JOURNEY-CLAUDE-AUTHORITY. Continuing the authority thread: the grants shouldn't just be enumerable, they should be executable -- the spec compiles to the check the runtime actually runs, so there's no drift between policy and enforcement.",
        createdAt: t(24),
      },
      {
        id: "cl_a1",
        role: "assistant",
        text: "So the policy artifact and the enforcement artifact are the same artifact. That kills a whole class of authorization bugs.",
        createdAt: t(24, 1),
      },
    ],
    extraction: {
      events: [
        {
          type: "refinement",
          statement: "The boundary grants must be executable: the spec compiles to the runtime check, so policy and enforcement can't drift.",
          confidence: 0.92,
          persistence: "high",
          source_event_id: "cl_u1",
          evidence_quote: "the spec compiles to the check the runtime actually runs",
        },
      ],
    },
  },
  {
    marker: "JOURNEY-GEMINI-AUTHORITY",
    source: "gemini",
    conversationId: "gemini-authority",
    sourceUrl: "https://gemini.google.com/app/gemini-authority",
    messages: [
      {
        id: "gm_u1",
        role: "user",
        text: "JOURNEY-GEMINI-AUTHORITY. Open question on the computable-authority idea: who actually verifies that a running agent's behaviour matches its granted spec, and why should a relying party trust that verifier?",
        createdAt: t(15),
      },
      {
        id: "gm_a1",
        role: "assistant",
        text: "That's the hard part -- it's a trust-anchor problem, not a policy-language problem.",
        createdAt: t(15, 1),
      },
    ],
    extraction: {
      events: [
        {
          type: "open_loop",
          statement: "Who verifies that a running agent matches its granted spec, and why should a relying party trust that verifier?",
          confidence: 0.9,
          persistence: "high",
          source_event_id: "gm_u1",
          evidence_quote: "who actually verifies that a running agent's behaviour matches its granted spec",
        },
      ],
    },
  },
  {
    marker: "JOURNEY-CURSOR-AUTHORITY",
    source: "cursor",
    conversationId: "cursor-authority",
    sourceUrl: "https://cursor.com/chat/cursor-authority",
    messages: [
      {
        id: "cu_u1",
        role: "user",
        text: "JOURNEY-CURSOR-AUTHORITY. Prototyping the computable-authority runtime: the verifier can be a third party that re-runs the compiled check against an execution trace the agent signs -- portable proof, no trust in the agent itself.",
        createdAt: t(11),
      },
      {
        id: "cu_a1",
        role: "assistant",
        text: "So verification is reproducible from the signed trace alone. The relying party trusts the math, not the agent.",
        createdAt: t(11, 1),
      },
    ],
    extraction: {
      events: [
        {
          type: "refinement",
          statement: "The verifier re-runs the compiled check against a signed execution trace -- portable proof that needs no trust in the agent.",
          confidence: 0.9,
          persistence: "high",
          source_event_id: "cu_u1",
          evidence_quote: "portable proof, no trust in the agent itself",
        },
      ],
    },
  },
];

/** `{ matched_idea_id, confidence, reasoning, also_related_idea_id }` -- the identity-resolution reply shape. */
export function identityReply(matchedIdeaId: string | null): string {
  return JSON.stringify({
    matched_idea_id: matchedIdeaId,
    confidence: matchedIdeaId ? 0.95 : 0.2,
    reasoning: "scripted for the journey simulation",
    also_related_idea_id: null,
  });
}
