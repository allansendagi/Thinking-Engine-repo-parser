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
import type { CanonicalizeResult, ObservedMessage, RawObservation } from "../state/canonicalize";
import type { ConversationIdentity } from "../state/resolveConversationIdentity";

export interface EvidenceRow {
  id: string;
  conversationId: string;
  sensor: string;
  observedAt: string;
  observedCount: number;
  acceptedCount: number;
  integrityOk: boolean;
  integrityIssues: { code: string; detail: string }[];
  /** The conversation-identity verdict for this observation (status, canonical id, competing
   *  claims, conflicts) -- makes every resolution auditable. Null for rows written before M3. */
  identity: ConversationIdentity | null;
  payload: {
    /**
     * "delta" -- only the turns new in this observation (the clean common case; the full
     * transcript is reconstructable from canonical_events). "full" -- the entire raw observation,
     * kept whenever structure validation failed, so a broken capture can be inspected whole.
     */
    form: "delta" | "full";
    messages: { id: string; role: string; text: string; createdAt: string }[];
    sourceUrl: string | null;
    capture: { method: string; fidelity: string } | null;
  };
}

/**
 * Record one observation. `newMessages` are the turns not already in canonical_events for this
 * conversation. A clean observation stores just those (bounded: O(total turns) across the life of
 * a conversation, not O(n^2)); a structurally broken one stores the whole raw transcript so it
 * can be inspected. Returns the new row's id.
 */
export function recordEvidence(
  db: Database,
  obs: RawObservation,
  result: CanonicalizeResult,
  newMessages: ObservedMessage[],
  identity?: ConversationIdentity,
): string {
  const id = randomUUID();
  const form: "delta" | "full" = result.integrity.ok ? "delta" : "full";
  const payload = JSON.stringify({
    form,
    messages: form === "delta" ? newMessages : obs.messages,
    sourceUrl: obs.sourceUrl ?? null,
    capture: obs.capture ?? null,
  });
  db.prepare(
    `INSERT INTO evidence
       (id, conversation_id, sensor, source, observed_at, observed_count, accepted_count,
        integrity_ok, integrity_issues, identity, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    obs.conversationId,
    obs.sensor,
    obs.source ?? null,
    obs.observedAt ?? new Date().toISOString(),
    result.integrity.observed,
    result.integrity.accepted,
    result.integrity.ok ? 1 : 0,
    result.integrity.issues.length ? JSON.stringify(result.integrity.issues) : null,
    identity ? JSON.stringify(identity) : null,
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
  identity: string | null;
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
    identity: r.identity ? JSON.parse(r.identity) : null,
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

export interface SensorHealth {
  sensor: string;
  /** Observations from this sensor in the window. */
  observations: number;
  /** How many failed structure validation (integrity_ok = 0). */
  failed: number;
  /** failed / observations, 0..1. */
  failureRate: number;
  /** Most recent failing observation, or null. */
  lastFailureAt: string | null;
  /** Issue codes from that most recent failure. */
  lastFailureIssues: string[];
  /**
   * `degraded` when the sensor has enough observations to judge AND is failing more than half
   * of them -- the "the extension broke and everything is parking provisional" case.
   */
  degraded: boolean;
}

export interface CaptureHealthSummary {
  windowDays: number;
  /** True when no sensor is degraded AND nothing recent is stuck identity-unresolved. */
  healthy: boolean;
  sensors: SensorHealth[];
  /**
   * Conversations observed in the window whose identity is still unresolved -- a strong
   * content match to a different conversation that no later observation has cleared. These
   * are the "couldn't be confidently connected" case: captured, held provisional, attached
   * to no idea. Distinct from a degraded sensor (that's a structural break).
   */
  unresolvedConversations: number;
}

const HEALTH_MIN_SAMPLES = 3;
const HEALTH_DEGRADED_RATE = 0.5;

/**
 * Per-sensor capture health over a recent window, derived from the evidence store. The signal
 * behind "some of your recent thinking couldn't be confidently connected" -- a broken sensor
 * otherwise fails silently (every observation parks provisional, no ideas appear, no error).
 */
export function captureHealthSummary(db: Database, windowDays = 7, now = new Date()): CaptureHealthSummary {
  const since = new Date(now.getTime() - windowDays * 86_400_000).toISOString();
  // The unit that can break on its own: the extension is one thing, but native AX capture is
  // per-app (the Cursor adapter can drift while Claude's works). So native rows key on their
  // source app, everything else on the sensor.
  const KEY = "CASE WHEN sensor = 'native_accessibility' THEN 'native_accessibility:' || COALESCE(source, '?') ELSE sensor END";
  const rows = db
    .query(
      `SELECT ${KEY} AS health_key,
              COUNT(*) AS observations,
              SUM(CASE WHEN integrity_ok = 0 THEN 1 ELSE 0 END) AS failed,
              MAX(CASE WHEN integrity_ok = 0 THEN observed_at END) AS last_failure_at
       FROM evidence WHERE observed_at >= ?
       GROUP BY health_key ORDER BY health_key ASC`,
    )
    .all(since) as {
    health_key: string;
    observations: number;
    failed: number;
    last_failure_at: string | null;
  }[];

  const sensors: SensorHealth[] = rows.map((r) => {
    let lastFailureIssues: string[] = [];
    if (r.last_failure_at) {
      const issueRow = db
        .query(
          `SELECT integrity_issues FROM evidence WHERE ${KEY} = ? AND observed_at = ? AND integrity_ok = 0 LIMIT 1`,
        )
        .get(r.health_key, r.last_failure_at) as { integrity_issues: string | null } | null;
      if (issueRow?.integrity_issues) {
        lastFailureIssues = (JSON.parse(issueRow.integrity_issues) as { code: string }[]).map((i) => i.code);
      }
    }
    const failureRate = r.observations ? r.failed / r.observations : 0;
    return {
      sensor: r.health_key,
      observations: r.observations,
      failed: r.failed,
      failureRate,
      lastFailureAt: r.last_failure_at,
      lastFailureIssues,
      degraded: r.observations >= HEALTH_MIN_SAMPLES && failureRate >= HEALTH_DEGRADED_RATE,
    };
  });

  // Conversations that are ACTIVELY stuck identity-unresolved: their most recent observation is
  // within the last two days and is unresolved. A live fork keeps flushing, so it stays counted;
  // one the user has abandoned stops flushing and drops out in two days rather than nagging for
  // the whole window. `json_extract` reads the M3 identity verdict; pre-M3 rows (NULL) are ignored.
  const unresolvedSince = new Date(now.getTime() - Math.min(windowDays, 2) * 86_400_000).toISOString();
  const unresolvedRow = db
    .query(
      `SELECT COUNT(*) AS n FROM (
         SELECT e.conversation_id,
                json_extract(e.identity, '$.status') AS latest_status
           FROM evidence e
          WHERE e.identity IS NOT NULL
            AND e.observed_at = (
              SELECT MAX(e2.observed_at) FROM evidence e2
               WHERE e2.conversation_id = e.conversation_id AND e2.identity IS NOT NULL
            )
            AND e.observed_at >= ?
          GROUP BY e.conversation_id
       ) WHERE latest_status = 'unresolved'`,
    )
    .get(unresolvedSince) as { n: number } | null;
  const unresolvedConversations = unresolvedRow?.n ?? 0;

  return {
    windowDays,
    healthy: !sensors.some((s) => s.degraded) && unresolvedConversations === 0,
    sensors,
    unresolvedConversations,
  };
}
