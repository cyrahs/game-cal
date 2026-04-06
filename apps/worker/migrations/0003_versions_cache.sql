-- Version cache persisted in Cloudflare D1.
-- One row per game id; payload is serialized GameVersionInfo | null JSON.
CREATE TABLE IF NOT EXISTS gc_versions_cache (
  game TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gc_versions_cache_updated_at ON gc_versions_cache(updated_at);
