/**
 * Conversation identity resolution (THREAD.md §9, §17). Milestone 3.
 *
 * A wrong merge is worse than a missed merge: "I don't know if these are the same thought" is
 * recoverable; "these ARE the same thought" corrupts the user's mental history. So this follows
 * the same philosophy as provisional capture -- when Thread doesn't know, it preserves
 * uncertainty rather than manufacturing certainty.
 *
 * The rule:
 *   - Resolve identity by highest-authority evidence. The tier order below IS an authority
 *     ordering, not just a fallback search order.
 *   - Lower-tier evidence that agrees -> RESOLVED.
 *   - Lower-tier evidence that is weakly inconsistent -> RESOLVED, contradiction recorded.
 *   - Lower-tier evidence that is STRONGLY inconsistent -> UNRESOLVED: preserve every competing
 *     claim, do not attach cognitive events to any of them.
 *
 * A higher-tier identifier stays authoritative -- a lower-tier contradiction can invalidate
 * confidence in the observation, never overwrite the identity.
 */

import type { RawObservation } from "./canonicalize";
import { jaccard } from "../identity/signals";

export type { RawObservation } from "./canonicalize";

export type IdentityAuthority =
  | "platform_id" // tier 1 -- the id the sensor sent
  | "canonical_url" // tier 2 -- sourceUrl origin+path
  | "native_app" // tier 3 -- AX window / document identity (M4, not produced yet)
  | "local_db" // tier 4 -- a local store's row key (overlaps platform_id for the desktop agent)
  | "content_fingerprint" // tier 5 -- verbatim message overlap
  | "semantic"; // tier 6 -- embedding similarity (no provider configured server-side; dormant)

export type IdentityStatus = "resolved" | "unresolved";

export type IdentityConflictType =
  | "strong_content_mismatch" // fingerprint strongly matches a DIFFERENT conversation
  | "weak_content_mismatch" // partial overlap with a different conversation -- recorded, not blocking
  | "url_id_mismatch"; // a known conversation already owns this exact sourceUrl under another id

export interface IdentityClaim {
  authority: IdentityAuthority;
  conversationId: string;
  /** 0..1 -- how strongly this evidence points at conversationId. */
  strength: number;
}

export interface IdentityConflict {
  type: IdentityConflictType;
  detail: string;
  /** The competing conversation id. */
  conversationId: string;
}

export interface ConversationIdentity {
  status: IdentityStatus;
  /** The conversation these events belong to. Null only when UNRESOLVED. */
  canonicalId: string | null;
  /** Which tier's evidence decided it. Null when UNRESOLVED. */
  authority: IdentityAuthority | null;
  /** Every identity claim considered -- makes a resolution auditable ("why did Thread think X?"). */
  claims: IdentityClaim[];
  /** Contradictions found. A `strong_content_mismatch` forces UNRESOLVED; the rest are advisory. */
  conflicts: IdentityConflict[];
}

export interface KnownConversation {
  conversationId: string;
  /** Content fingerprint: the set of verbatim-normalized message texts. */
  fingerprint: Set<string>;
  sourceUrl: string | null;
}

/** Reuse the near-duplicate ceiling already established elsewhere in the codebase. */
export const IDENTITY_STRONG_MATCH = 0.85;
export const IDENTITY_WEAK_MATCH = 0.5;

function normalizeMessage(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 400);
}

/** The set of verbatim-normalized message texts. Two conversations that share most of this set
 *  are the same conversation (a fork shares the parent's turns, then diverges). Very short
 *  turns ("ok", "yes") are dropped -- they collide across unrelated conversations. */
export function contentFingerprint(messages: { text: string }[]): Set<string> {
  return new Set(messages.map((m) => normalizeMessage(m.text)).filter((s) => s.length >= 12));
}

export function resolveConversationIdentity(
  obs: RawObservation,
  known: KnownConversation[],
): ConversationIdentity {
  const tier1 = obs.conversationId;
  const url = obs.sourceUrl ?? null;
  const fp = contentFingerprint(obs.messages);

  const claims: IdentityClaim[] = [{ authority: "platform_id", conversationId: tier1, strength: 1 }];
  const conflicts: IdentityConflict[] = [];

  // Tier 2 -- canonical URL. The extension derives its conversationId from the URL, so for it
  // tiers 1 and 2 agree by construction; this claim is corroboration. A known conversation that
  // already owns this exact URL under a different id is an anomaly -- recorded, not blocking (a
  // URL-authoritative override is a later refinement, not M3).
  if (url) {
    const urlOwner = known.find((k) => k.sourceUrl === url);
    const urlId = urlOwner?.conversationId ?? tier1;
    claims.push({ authority: "canonical_url", conversationId: urlId, strength: 0.9 });
    if (urlOwner && urlOwner.conversationId !== tier1) {
      conflicts.push({
        type: "url_id_mismatch",
        detail: `URL ${url} already belongs to ${urlOwner.conversationId}, not ${tier1}`,
        conversationId: urlOwner.conversationId,
      });
    }
  }

  // Tier 5 -- content fingerprint against every OTHER known conversation.
  let best: { id: string; sim: number } | null = null;
  for (const k of known) {
    if (k.conversationId === tier1) continue;
    const sim = jaccard(fp, k.fingerprint);
    if (!best || sim > best.sim) best = { id: k.conversationId, sim };
  }
  if (best && best.sim >= IDENTITY_STRONG_MATCH) {
    claims.push({ authority: "content_fingerprint", conversationId: best.id, strength: best.sim });
    conflicts.push({
      type: "strong_content_mismatch",
      detail: `content ${(best.sim * 100).toFixed(0)}% matches ${best.id}, but the sensor's id is ${tier1}`,
      conversationId: best.id,
    });
  } else if (best && best.sim >= IDENTITY_WEAK_MATCH) {
    claims.push({ authority: "content_fingerprint", conversationId: best.id, strength: best.sim });
    conflicts.push({
      type: "weak_content_mismatch",
      detail: `content ${(best.sim * 100).toFixed(0)}% overlaps ${best.id}`,
      conversationId: best.id,
    });
  }

  // Decision. Higher-tier evidence is authoritative; a STRONG lower-tier contradiction
  // quarantines the observation rather than overriding identity.
  if (conflicts.some((c) => c.type === "strong_content_mismatch")) {
    return { status: "unresolved", canonicalId: null, authority: null, claims, conflicts };
  }
  return {
    status: "resolved",
    canonicalId: tier1,
    authority: url ? "canonical_url" : "platform_id",
    claims,
    conflicts, // may hold weak / url_id_mismatch contradictions -- recorded, not blocking
  };
}
