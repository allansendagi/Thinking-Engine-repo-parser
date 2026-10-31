import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Starter taste: what taste does before a person has labelled anything. Personal taste needs
 * MIN_LABELS_PER_CLASS of each kind, so a new account saw every extracted thought as an idea --
 * and on one person's labels about half of what extraction produced was not an idea. Most of that
 * half is the same few shapes for everyone: instructions to the AI about a draft, feedback on its
 * output, reactions, requests for information, status checks. So a new account is compared with a
 * fixed set of generic examples of those shapes (and of real ideas), the same nearest-neighbour way
 * personal taste works, and an idea that looks only like the not-an-idea examples goes to the
 * Maybe tray. It never deletes and never marks anything "likely": everything else stays
 * "suggested", and personal taste replaces it as soon as the person has labelled enough.
 *
 * Measured on the owner's 50 labelled thoughts (2026-10-31, voyage-4-large), with the examples
 * that resembled any labelled thought removed: AUC 0.86; at the cut-off below, 6 of 20 not-ideas
 * went to Maybe and 1 of 27 real ideas did. One labeller, n=50.
 *
 * The examples are written generically and never taken from anyone's data. Their vectors are
 * computed once (src/taste/buildStarterVectors.ts) and shipped as starterVectors.json, keyed by
 * model: an account whose vectors come from a different model gets no starter taste.
 */
export const STARTER_EXAMPLES = {
  notIdea: [
    "Make the second paragraph shorter and drop the last sentence.",
    "Use the blue version of the logo in slide 4.",
    "Put that in a table with three columns.",
    "Rewrite this email so it sounds less formal.",
    "That's not what I asked for, go back to the earlier wording.",
    "Don't use bullet points in your answers.",
    "This answer is too long.",
    "Great, that looks good.",
    "This is really helpful, thanks.",
    "Wow, that's interesting.",
    "What does this error message mean?",
    "Can you summarize this article for me?",
    "Explain how OAuth works.",
    "Where do I find the settings page?",
    "Did the export finish?",
    "Is the build passing now?",
    "Fix the typo in the headline.",
    "Send me the final version as a PDF.",
    "Translate this into French.",
  ],
  idea: [
    "Our pricing should charge per outcome delivered, not per seat.",
    "The real bottleneck in onboarding is trust, not the number of steps.",
    "We should sell to research teams first because their pain is sharpest.",
    "Memory is not the product; continuity of reasoning is.",
    "I'm going to stop building features until retention is proven.",
    "Small clinics will never adopt this unless it works offline.",
    "What would make a regulator accept a machine-readable policy as binding?",
    "How do we know two notes written months apart are the same idea?",
    "I decided to keep the company bootstrapped for another year.",
    "The paper's argument is stronger if we lead with the failure cases.",
    "We are rejecting the marketplace model; it splits our attention.",
    "Authority in software should be verifiable by anyone, not just the issuer.",
    "Hiring a generalist first beats hiring two specialists at our stage.",
    "The workshop should open with a live problem, not a lecture.",
    "If agents act on our behalf, delegation needs to expire by default.",
    "My thesis chapter on replication should come before the methods chapter.",
    "Free tiers attract the wrong users for a tool like this.",
    "The open question is whether teams will share their reasoning at all.",
    "Local-first storage is a selling point for privacy-conscious founders.",
    "Our competitors store facts; we should store how decisions were reached.",
    "Writing the investor update weekly forces clarity about what changed.",
    "The sampling bias explains why the results don't replicate.",
    "Connecting the two projects might give both a clearer story.",
  ],
};

/** Nearest examples consulted per thought. */
export const STARTER_NEIGHBOURS = 5;
/** Share of those that were real ideas at/below which a thought looks like "not an idea". */
export const STARTER_UNLIKELY_AT = 0.2;

export interface StarterVectors {
  /** The thought-vector model these were made with, as stored on thoughts (e.g. "voyage:voyage-4-large"). */
  model: string;
  notIdea: number[][];
  idea: number[][];
}

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0, x = 0, y = 0;
  for (let i = 0; i < a.length; i++) {
    const p = a[i]!, q = b[i]!;
    s += p * q; x += p * p; y += q * q;
  }
  return x && y ? s / Math.sqrt(x * y) : 0;
}

/** Share of the thought's nearest starter examples that are real ideas, 0..1. */
export function starterScore(v: ArrayLike<number>, starter: StarterVectors, k = STARTER_NEIGHBOURS): number {
  const scored = [
    ...starter.notIdea.map((e) => ({ sim: cosine(v, e), idea: false })),
    ...starter.idea.map((e) => ({ sim: cosine(v, e), idea: true })),
  ].sort((a, b) => b.sim - a.sim);
  const top = scored.slice(0, k);
  return top.length ? top.filter((n) => n.idea).length / top.length : 1;
}

let cached: StarterVectors | null | undefined;
/** The shipped starter vectors, or null when the file is missing or unreadable. */
export function loadStarterVectors(): StarterVectors | null {
  if (cached !== undefined) return cached;
  const path = join(import.meta.dir, "starterVectors.json");
  try {
    cached = existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as StarterVectors) : null;
  } catch {
    cached = null;
  }
  return cached;
}
