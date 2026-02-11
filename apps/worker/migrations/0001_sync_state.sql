-- Encrypted per-user preference state (client-side encrypted with password).
-- Each UUID identifies one sync "account".
CREATE TABLE IF NOT EXISTS gc_sync_state (
  uuid TEXT PRIMARY KEY,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  blob TEXT NOT NULL,
  client_updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gc_sync_state_updated_at ON gc_sync_state(updated_at);
CREATE INDEX IF NOT EXISTS idx_gc_sync_state_client_updated_at ON gc_sync_state(client_updated_at);

