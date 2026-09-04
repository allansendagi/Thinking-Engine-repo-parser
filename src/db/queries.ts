import type { Database } from "bun:sqlite";
import type { CanonicalEvent, CognitiveEvent, DiscardedEvent, IdeaNode, IdeaState, Role } from "../types";

interface IdeaRow {
  id: string;
  title: string;
  state: string;
  current_formulation: string;
  why_it_matters: string | null;
  created_at: string;
  updated_at: string;
}
interface EvolutionRow {
  cognitive_event_id: string;
  formulation: string;
  created_at: string;
  source_event_id: string;
}
interface OpenLoopRow {
  id: string;
  statement: string;
  created_at: string;
  resolved: number;
}
interface DecisionRow {
  id: string;
  statement: string;
  decided_at: string;
  source_event_id: string;
}
interface RelatedRow {
  related_idea_id: string;
}
interface CognitiveEventRow {
  id: string;
  type: string;
  statement: string;
  confidence: number;
  persistence: string | null;
  persistence_reason: string | null;
  source_event_id: string;
  evidence_quote: string;
  why_it_matters: string | null;
}
interface CanonicalEventRow {
  id: string;
  conversation_id: string;
  source: string;
  role: string;
  text: string;
  created_at: string;
  idx: number;
  source_url: string | null;
}

/** Loads every idea, with its evolution/open loops/decisions/related ids, from SQLite. */
export function loadIdeas(db: Database): IdeaNode[] {
  const ideaRows = db.query("SELECT * FROM idea_nodes").all() as IdeaRow[];

  return ideaRows.map((row): IdeaNode => {
    const evolution = (
      db.query("SELECT * FROM evolution_steps WHERE idea_id = ? ORDER BY created_at ASC").all(row.id) as EvolutionRow[]
    ).map((e) => ({
      cognitiveEventId: e.cognitive_event_id,
      formulation: e.formulation,
      createdAt: e.created_at,
      sourceEventId: e.source_event_id,
    }));

    const openLoops = (
      db.query("SELECT * FROM open_loops WHERE idea_id = ? ORDER BY created_at ASC").all(row.id) as OpenLoopRow[]
    ).map((l) => ({ id: l.id, statement: l.statement, createdAt: l.created_at, resolved: l.resolved === 1 }));

    const decisions = (
      db.query("SELECT * FROM decisions WHERE idea_id = ? ORDER BY decided_at ASC").all(row.id) as DecisionRow[]
    ).map((d) => ({ id: d.id, statement: d.statement, decidedAt: d.decided_at, sourceEventId: d.source_event_id }));

    const relatedIdeaIds = (
      db.query("SELECT related_idea_id FROM related_ideas WHERE idea_id = ?").all(row.id) as RelatedRow[]
    ).map((r) => r.related_idea_id);

    return {
      id: row.id,
      title: row.title,
      state: row.state as IdeaState,
      currentFormulation: row.current_formulation,
      whyItMatters: row.why_it_matters ?? undefined,
      evolution,
      openLoops,
      decisions,
      relatedIdeaIds,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
}

export function loadIdea(db: Database, id: string): IdeaNode | undefined {
  return loadIdeas(db).find((i) => i.id === id);
}

export function loadCognitiveEvents(db: Database): CognitiveEvent[] {
  const rows = db.query("SELECT * FROM cognitive_events").all() as CognitiveEventRow[];
  return rows.map((r) => {
    const additional = (
      db.query("SELECT canonical_event_id FROM cognitive_event_sources WHERE cognitive_event_id = ?").all(r.id) as {
        canonical_event_id: string;
      }[]
    ).map((a) => a.canonical_event_id);

    return {
      id: r.id,
      type: r.type as CognitiveEvent["type"],
      statement: r.statement,
      confidence: r.confidence,
      persistence: (r.persistence as CognitiveEvent["persistence"]) ?? "high",
      persistenceReason: r.persistence_reason ?? undefined,
      sourceEventId: r.source_event_id,
      evidenceQuote: r.evidence_quote,
      whyItMatters: r.why_it_matters ?? undefined,
      additionalSourceEventIds: additional,
    };
  });
}

interface DiscardedEventRow {
  id: string;
  type: string;
  statement: string;
  confidence: number;
  persistence: string;
  persistence_reason: string | null;
  source_event_id: string;
  evidence_quote: string;
  gate_reason: string;
  gate_version: number;
}

/** The signal gate's audit trail: grounded events that were not promoted. See discarded_events. */
export function loadDiscardedEvents(db: Database): DiscardedEvent[] {
  const rows = db.query("SELECT * FROM discarded_events").all() as DiscardedEventRow[];
  return rows.map((r) => ({
    event: {
      id: r.id,
      type: r.type as CognitiveEvent["type"],
      statement: r.statement,
      confidence: r.confidence,
      persistence: (r.persistence as CognitiveEvent["persistence"]) ?? "high",
      persistenceReason: r.persistence_reason ?? undefined,
      sourceEventId: r.source_event_id,
      evidenceQuote: r.evidence_quote,
      additionalSourceEventIds: [],
    },
    gateReason: r.gate_reason,
    gateVersion: r.gate_version,
  }));
}

export function loadCanonicalEvents(db: Database): CanonicalEvent[] {
  const rows = db.query("SELECT * FROM canonical_events ORDER BY idx ASC").all() as CanonicalEventRow[];
  return rows.map((r) => ({
    id: r.id,
    conversationId: r.conversation_id,
    source: r.source as CanonicalEvent["source"],
    role: r.role as Role,
    text: r.text,
    createdAt: r.created_at,
    index: r.idx,
    sourceUrl: r.source_url ?? null,
  }));
}

export interface ConversationTranscript {
  conversationId: string;
  /** "chatgpt" | "claude" | "gemini" | "cursor" | "paste" */
  source: string;
  sourceUrl: string | null;
  messages: { role: Role; text: string; index: number; createdAt: string }[];
}

/** Every captured message of one conversation, in order -- the evidence behind an idea. Null if
 *  no rows exist for that id. */
export function getConversation(db: Database, conversationId: string): ConversationTranscript | null {
  const rows = db
    .query(
      "SELECT role, text, idx, created_at, source, source_url FROM canonical_events WHERE conversation_id = ? ORDER BY idx ASC",
    )
    .all(conversationId) as {
    role: string;
    text: string;
    idx: number;
    created_at: string;
    source: string;
    source_url: string | null;
  }[];
  if (rows.length === 0) return null;
  return {
    conversationId,
    source: rows[0]!.source,
    sourceUrl: rows.find((r) => r.source_url)?.source_url ?? null,
    messages: rows.map((r) => ({ role: r.role as Role, text: r.text, index: r.idx, createdAt: r.created_at })),
  };
}

export function loadCanonicalEvent(db: Database, id: string): CanonicalEvent | undefined {
  const row = db.query("SELECT * FROM canonical_events WHERE id = ?").get(id) as CanonicalEventRow | null;
  if (!row) return undefined;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    source: row.source as CanonicalEvent["source"],
    role: row.role as Role,
    text: row.text,
    createdAt: row.created_at,
    index: row.idx,
    sourceUrl: row.source_url ?? null,
  };
}
