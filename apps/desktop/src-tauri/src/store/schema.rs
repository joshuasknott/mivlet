//! SQL schema for the durable encrypted store (version 1).
//!
//! See `docs/superpowers/specs/2026-06-28-encrypted-storage-design.md`.
//!
//! Sensitive free-text lives inside an encrypted `payload` BLOB with a companion
//! `payload_nonce` BLOB. Plaintext columns are non-secret only: ids, enums,
//! timestamps, booleans, integer counts, and content fingerprints used for
//! indexing and foreign-key joins.

/// The current schema version. Bumped on every breaking schema change; each
/// version has a forward migration registered in [`super::migrations`].
pub const CURRENT_SCHEMA_VERSION: u32 = 1;

/// The full v1 DDL. Idempotent (`CREATE TABLE IF NOT EXISTS`) so applying it
/// to a fresh database and re-running after a partial apply are both safe.
pub const SCHEMA_V1: &str = r#"
PRAGMA foreign_keys = ON;

-- metadata
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- profile + preferences
CREATE TABLE IF NOT EXISTS profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS preferences (
  key TEXT PRIMARY KEY,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL,
  updated_at TEXT NOT NULL
);

-- conversation / run graph
CREATE TABLE IF NOT EXISTS project (
  id TEXT PRIMARY KEY,
  title_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS thread (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_thread_project ON thread(project_id);

CREATE TABLE IF NOT EXISTS message (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  seq INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL,
  UNIQUE(thread_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_message_thread ON message(thread_id, seq);

CREATE TABLE IF NOT EXISTS run (
  id TEXT PRIMARY KEY,
  thread_id TEXT REFERENCES thread(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  turn INTEGER NOT NULL DEFAULT 0,
  recoverable INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_status ON run(status);
CREATE INDEX IF NOT EXISTS idx_run_thread ON run(thread_id);

CREATE TABLE IF NOT EXISTS tool_call (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  tool TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_call_run ON tool_call(run_id);

CREATE TABLE IF NOT EXISTS approval (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES run(id) ON DELETE CASCADE,
  service TEXT NOT NULL,
  action TEXT NOT NULL,
  mode TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  decision TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approval_run ON approval(run_id);

CREATE TABLE IF NOT EXISTS audit_event (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_event(created_at);

CREATE TABLE IF NOT EXISTS artifact (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES run(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  content_fingerprint TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifact_run ON artifact(run_id);

-- connectors (non-secret metadata only)
CREATE TABLE IF NOT EXISTS connector_account (
  connector_id TEXT PRIMARY KEY,
  account_id TEXT,
  status TEXT NOT NULL,
  expires_at INTEGER,
  credential_ref TEXT NOT NULL,
  connected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS backend_connection (
  provider_id TEXT PRIMARY KEY,
  connected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- knowledge + memory
CREATE TABLE IF NOT EXISTS knowledge_source (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  trust TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  content_fingerprint TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  imported_at TEXT NOT NULL,
  origin TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_connector ON knowledge_source(connector_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_pinned ON knowledge_source(pinned);

CREATE TABLE IF NOT EXISTS memory_record (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  approved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_kind ON memory_record(kind);
CREATE INDEX IF NOT EXISTS idx_memory_pinned ON memory_record(pinned);

-- scheduler (stable surface for Goal 8)
CREATE TABLE IF NOT EXISTS schedule (
  id TEXT PRIMARY KEY,
  weekday TEXT NOT NULL,
  time TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedule_enabled ON schedule(enabled);

-- model/provider config (no secrets)
CREATE TABLE IF NOT EXISTS model_config (
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  selected INTEGER NOT NULL DEFAULT 0,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL,
  PRIMARY KEY (provider_id, model_id)
);

-- drafts + resumable run state
CREATE TABLE IF NOT EXISTS draft (
  id TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS run_state (
  id TEXT PRIMARY KEY,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL,
  updated_at TEXT NOT NULL
);

-- migration bookkeeping (idempotency + diagnostics)
CREATE TABLE IF NOT EXISTS migration_log (
  source TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  status TEXT NOT NULL,
  migrated_at TEXT NOT NULL,
  diagnostics BLOB NOT NULL,
  diagnostics_nonce BLOB NOT NULL
);
"#;
