-- Magic link tokens for export/delete (hashed only at rest)
-- Separate from confirm tokens for correct single-use semantics

CREATE TABLE IF NOT EXISTS magic_tokens (
  token_hash TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('export', 'delete', 'unsub')),
  subscriber_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(subscriber_id) REFERENCES subscribers(id)
);

CREATE INDEX IF NOT EXISTS idx_magic_sub ON magic_tokens(subscriber_id);
CREATE INDEX IF NOT EXISTS idx_magic_type ON magic_tokens(type);
