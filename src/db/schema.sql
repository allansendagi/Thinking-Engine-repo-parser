-- V0.1 schema. Shape mirrors the eventual Postgres schema (types.ts is the source of truth) so
-- migrating off SQLite later is a lift-and-shift, not a redesign.

CREATE TABLE IF NOT EXISTS canonical_events (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  source TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  idx INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cognitive_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  statement TEXT NOT NULL,
  confidence REAL NOT NULL,
  -- Worth-remembering judgment, a separate axis from confidence: 'high' | 'medium' | 'low'.
  -- Defaulted so rows written before the signal gate keep today's behavior.
  persistence TEXT NOT NULL DEFAULT 'high',
  persistence_reason TEXT,
  source_event_id TEXT NOT NULL REFERENCES canonical_events(id),
  evidence_quote TEXT NOT NULL,
  why_it_matters TEXT
);

-- Signal-gate audit trail: grounded cognitive events that were NOT promoted to ideas. Stored so
-- a gate threshold/rubric change (gate_version) can be replayed, and so "why isn't my idea here"
-- is answerable. Never joined into the idea graph.
CREATE TABLE IF NOT EXISTS discarded_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  statement TEXT NOT NULL,
  confidence REAL NOT NULL,
  persistence TEXT NOT NULL,
  persistence_reason TEXT,
  source_event_id TEXT NOT NULL REFERENCES canonical_events(id),
  evidence_quote TEXT NOT NULL,
  gate_reason TEXT NOT NULL,
  gate_version INTEGER NOT NULL,
  discarded_at TEXT NOT NULL
);

-- Contributing context beyond the primary (source_event_id, evidence_quote) pair. NOT covered
-- by the grounding/hallucination guarantee -- see CognitiveEvent.additionalSourceEventIds.
CREATE TABLE IF NOT EXISTS cognitive_event_sources (
  cognitive_event_id TEXT NOT NULL REFERENCES cognitive_events(id),
  canonical_event_id TEXT NOT NULL REFERENCES canonical_events(id),
  PRIMARY KEY (cognitive_event_id, canonical_event_id)
);

CREATE TABLE IF NOT EXISTS idea_nodes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  state TEXT NOT NULL,
  current_formulation TEXT NOT NULL,
  why_it_matters TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evolution_steps (
  idea_id TEXT NOT NULL REFERENCES idea_nodes(id),
  cognitive_event_id TEXT NOT NULL REFERENCES cognitive_events(id),
  formulation TEXT NOT NULL,
  created_at TEXT NOT NULL,
  source_event_id TEXT NOT NULL REFERENCES canonical_events(id),
  PRIMARY KEY (idea_id, cognitive_event_id)
);

CREATE TABLE IF NOT EXISTS open_loops (
  id TEXT PRIMARY KEY,
  idea_id TEXT NOT NULL REFERENCES idea_nodes(id),
  statement TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  idea_id TEXT NOT NULL REFERENCES idea_nodes(id),
  statement TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  source_event_id TEXT NOT NULL REFERENCES canonical_events(id)
);

-- Symmetric: a connection between idea A and idea B is stored as both (A,B) and (B,A) so either
-- side's relatedIdeaIds can be read with a single-direction query.
CREATE TABLE IF NOT EXISTS related_ideas (
  idea_id TEXT NOT NULL REFERENCES idea_nodes(id),
  related_idea_id TEXT NOT NULL REFERENCES idea_nodes(id),
  PRIMARY KEY (idea_id, related_idea_id)
);

-- Audit trail: every identity-resolution decision, including ones below the merge threshold
-- that became new ideas instead. Kept so eval can score identity resolution independently of
-- what the pipeline ended up doing with the decision.
CREATE TABLE IF NOT EXISTS identity_resolutions (
  cognitive_event_id TEXT PRIMARY KEY REFERENCES cognitive_events(id),
  matched_idea_id TEXT REFERENCES idea_nodes(id),
  confidence REAL NOT NULL,
  reasoning TEXT NOT NULL
);
