/**
 * The evidence store: raw sensor observations, one epistemic level below canonical events.
 * See state/canonicalize.ts and THREAD.md §7.
 *
 * Milestone 1 is write + a debug read. A row is recorded when an observation advanced the
 * conversation OR failed structure validation (a no-op resend that is now structurally broken is
 * itself a sensor-health signal worth keeping). Clean no-op resends are not recorded -- no signal.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { CanonicalizeResult, RawObservation } from "../state/canonicalize";

export interface EvidenceRow {
  id: string;
  conversationId: string;
  sensor: string;
  observedAt: string;
  observedCount: number;
  acceptedCount: number;
  integrityOk: boolean;
  integrityIssues: { code: string; detail: string }[];
  payload: {
    messages: { id: string; role: string; text: string; createdAt: string }[];
    sourceUrl: string | null;
    capture: { method: string; fidelity: string } | null;
  };
}

/** Record one observation. Returns the new row's id. */
export function recordEvidence(
  db: Database,
  obs: RawObservation,
  result: CanonicalizeResult,
): string {
  const id = randomUUID();
  const payload = JSON.stringify({
    messages: obs.messages,
    sourceUrl: obs.sourceUrl ?? null,
    capture: obs.capture ?? null,
  });
  db.prepare(
    `INSERT INTO evidence
       (id, conversation_id, sensor, observed_at, observed_count, accepted_count,
        integrity_ok, integrity_issues, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    obs.conversationId,
    obs.sensor,
    obs.observedAt ?? new Date().toISOString(),
    result.integrity.observed,
    result.integrity.accepted,
    result.integrity.ok ? 1 : 0,
    result.integrity.issues.length ? JSON.stringify(result.integrity.issues) : null,
    payload,
  );
  return id;
}

interface EvidenceDbRow {
  id: string;
  conversation_id: string;
  sensor: string;
  observed_at: string;
  observed_count: number;
  accepted_count: number;
  integrity_ok: number;
  integrity_issues: string | null;
  payload: string;
}

function mapRow(r: EvidenceDbRow): EvidenceRow {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    sensor: r.sensor,
    observedAt: r.observed_at,
    observedCount: r.observed_count,
    acceptedCount: r.accepted_count,
    integrityOk: r.integrity_ok === 1,
    integrityIssues: r.integrity_issues ? JSON.parse(r.integrity_issues) : [],
    payload: JSON.parse(r.payload),
  };
}

/** All observations for one conversation, oldest first. */
export function loadEvidenceForConversation(db: Database, conversationId: string): EvidenceRow[] {
  const rows = db
    .query("SELECT * FROM evidence WHERE conversation_id = ? ORDER BY observed_at ASC")
    .all(conversationId) as EvidenceDbRow[];
  return rows.map(mapRow);
}

/** Recent observations across all conversations, newest first -- for `bun src/cli.ts evidence`. */
export function loadRecentEvidence(db: Database, limit = 50): EvidenceRow[] {
  const rows = db
    .query("SELECT * FROM evidence ORDER BY observed_at DESC LIMIT ?")
    .all(limit) as EvidenceDbRow[];
  return rows.map(mapRow);
}
