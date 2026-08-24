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
  source_event_id TEXT NOT NULL REFERENCES canonical_events(id),
  evidence_quote TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS idea_nodes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  state TEXT NOT NULL,
  current_formulation TEXT NOT NULL,
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
