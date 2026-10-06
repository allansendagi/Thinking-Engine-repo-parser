import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

/**
 * The thought layer: every grounded thought Thread has extracted -- promoted (cognitive_events)
 * or held aside by the signal gate (discarded_events). Thoughts are append-only facts; ideas are
 * derived from them (see state/consolidate.ts). This module also stores their meaning-vectors.
 */

export interface ThoughtRow {
  id: string;
  type: string;
  statement: string;
  persistence: string;
  sourceEventId: string;
  evidenceQuote: string;
  createdAt: string;
  conversationId: string;
  source: string;
  /** Promoted to an idea by the v1 gate, or held aside. */
  promoted: boolean;
  /** For claims: the person's position, an option being weighed, or a reason. */
  role: "position" | "option" | "reason" | null;
  /** Set when the thought adopts something the AI suggested (grounded at extraction). */
  adoptedSourceEventId: string | null;
}

export function listThoughts(db: Database): ThoughtRow[] {
  const rows = db
    .query(
      `SELECT t.id, t.type, t.statement, t.persistence, t.source_event_id, t.evidence_quote, t.promoted, t.role, t.adopted_source_event_id,
              c.created_at, c.conversation_id, c.source
         FROM (
           SELECT id, type, statement, persistence, source_event_id, evidence_quote, 1 AS promoted, role, adopted_source_event_id FROM cognitive_events
           UNION ALL
           SELECT id, type, statement, persistence, source_event_id, evidence_quote, 0 AS promoted, role, adopted_source_event_id FROM discarded_events
            WHERE id NOT IN (SELECT id FROM cognitive_events)
         ) t
         JOIN canonical_events c ON c.id = t.source_event_id
        ORDER BY c.created_at, t.id`,
    )
    .all() as {
    id: string; type: string; statement: string; persistence: string; source_event_id: string;
    evidence_quote: string; promoted: number; role: string | null; adopted_source_event_id: string | null; created_at: string; conversation_id: string; source: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    statement: r.statement,
    persistence: r.persistence,
    sourceEventId: r.source_event_id,
    evidenceQuote: r.evidence_quote,
    createdAt: r.created_at,
    conversationId: r.conversation_id,
    source: r.source,
    promoted: r.promoted === 1,
    role: r.role === "position" || r.role === "option" || r.role === "reason" ? r.role : null,
    adoptedSourceEventId: r.adopted_source_event_id,
  }));
}

export function textHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Thoughts with no vector (or a stale one) for `model`, oldest first. */
export function thoughtsNeedingVectors(db: Database, model: string, limit: number): { id: string; text: string }[] {
  const have = new Map(
    (db.query("SELECT thought_id, text_hash FROM thought_vectors WHERE model = ?").all(model) as {
      thought_id: string; text_hash: string;
    }[]).map((r) => [r.thought_id, r.text_hash]),
  );
  const out: { id: string; text: string }[] = [];
  for (const t of listThoughts(db)) {
    if (have.get(t.id) === textHash(t.statement)) continue;
    out.push({ id: t.id, text: t.statement });
    if (out.length >= limit) break;
  }
  return out;
}

export class VectorValidationError extends Error {}

/** Store vectors for known thoughts. Rejects malformed input wholesale (nothing half-written). */
export function storeThoughtVectors(
  db: Database,
  model: string,
  items: { id: string; vector: number[] }[],
): number {
  if (!/^[\w.:@/-]{1,100}$/.test(model)) throw new VectorValidationError("Invalid model id");
  const dims = items[0]?.vector.length ?? 0;
  if (dims < 8 || dims > 4096) throw new VectorValidationError("Vector dimension out of range");
  const known = new Map(listThoughts(db).map((t) => [t.id, t.statement]));
  for (const it of items) {
    if (!known.has(it.id)) throw new VectorValidationError(`Unknown thought ${it.id}`);
    if (it.vector.length !== dims || !it.vector.every((v) => Number.isFinite(v))) {
      throw new VectorValidationError(`Malformed vector for ${it.id}`);
    }
  }
  const put = db.prepare(
    `INSERT OR REPLACE INTO thought_vectors (thought_id, model, dims, vector, text_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const it of items) {
      put.run(it.id, model, dims, new Uint8Array(new Float32Array(it.vector).buffer), textHash(known.get(it.id)!), now);
    }
  })();
  return items.length;
}

/** Current (non-stale) vectors for `model`, keyed by thought id. */
export function loadThoughtVectors(db: Database, model: string): Map<string, Float32Array> {
  const statements = new Map(listThoughts(db).map((t) => [t.id, t.statement]));
  const rows = db.query("SELECT thought_id, vector, text_hash FROM thought_vectors WHERE model = ?").all(model) as {
    thought_id: string; vector: Uint8Array; text_hash: string;
  }[];
  const out = new Map<string, Float32Array>();
  for (const r of rows) {
    const s = statements.get(r.thought_id);
    if (s === undefined || textHash(s) !== r.text_hash) continue;
    const bytes = new Uint8Array(r.vector);
    out.set(r.thought_id, new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4));
  }
  return out;
}

/** Models with vectors in this database: native (`apple:`) models first, always -- a cloud
 *  model is only ever a fallback -- then by coverage. */
export function vectorModels(db: Database): string[] {
  const rows = db.query("SELECT model, COUNT(*) AS n FROM thought_vectors GROUP BY model").all() as { model: string; n: number }[];
  const native = (m: string) => (m.startsWith("apple:") ? 1 : 0);
  return rows.sort((a, b) => native(b.model) - native(a.model) || b.n - a.n).map((r) => r.model);
}
