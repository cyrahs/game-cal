-- Event cache persisted in Cloudflare D1.
-- One row per game id; payload is serialized CalendarEvent[] JSON.
CREATE TABLE IF NOT EXISTS gc_events_cache (
  game TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gc_events_cache_updated_at ON gc_events_cache(updated_at);
