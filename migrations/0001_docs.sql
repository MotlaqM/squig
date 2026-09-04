CREATE TABLE IF NOT EXISTS docs (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  owner TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS docs_owner_updated_at
  ON docs (owner, updated_at DESC);
