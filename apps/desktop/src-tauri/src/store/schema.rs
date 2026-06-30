//! SQL schema for the durable encrypted store.
//!
//! See `docs/superpowers/specs/2026-06-28-encrypted-storage-design.md`.
//!
//! Sensitive free-text lives inside an encrypted `payload` BLOB with a companion
//! `payload_nonce` BLOB. Plaintext columns are non-secret only: ids, enums,
//! timestamps, booleans, integer counts, and content fingerprints used for
//! indexing and foreign-key joins.

/// The current schema version. Bumped on every breaking schema change; each
/// version has a forward migration registered in [`super::migrations`].
pub const CURRENT_SCHEMA_VERSION: u32 = 4;

/// Forward schema step `v1 → v2`: adds the connector-cache tables to an
/// *existing* v1 database inside the migration transaction. Fresh databases
/// already receive these tables through [`SCHEMA_V1`] (the complete current
/// DDL, kept idempotent with `CREATE TABLE IF NOT EXISTS`), so this constant
/// only carries the `v→v+1` delta.
pub const SCHEMA_V1_TO_V2: &str = r#"
PRAGMA foreign_keys = ON;

-- Searchable, workspace-isolated cache of normalized connector data.
-- Provider secrets/tokens never reach this table; the write path redacts
-- token-shaped values before sealing the payload.
CREATE TABLE IF NOT EXISTS connector_cache (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  provider_item_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  trust TEXT NOT NULL DEFAULT 'untrusted',
  pinned INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  content_fingerprint TEXT NOT NULL DEFAULT '',
  cached_at TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'connector-cache',
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_connector_cache_workspace ON connector_cache(workspace_id);
CREATE INDEX IF NOT EXISTS idx_connector_cache_connector ON connector_cache(connector_id);
CREATE INDEX IF NOT EXISTS idx_connector_cache_search ON connector_cache(workspace_id, connector_id, disabled);

-- Per-workspace and per-connector cache settings. `scope` is either
-- "workspace" (a workspace-wide default) or "connector" (a per-connector
-- override). `enabled` gates cache writes/reads; `auto_sync` gates background
-- resync. Non-secret settings live in plaintext columns; the encrypted payload
-- holds only an optional free-text note (never secrets).
CREATE TABLE IF NOT EXISTS connector_cache_settings (
  workspace_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  auto_sync INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL,
  PRIMARY KEY (workspace_id, connector_id)
);
"#;

/// Forward schema step `v2 → v3`: extends `audit_event` with non-secret query
/// columns so inspectable action history can be filtered without decrypting
/// payloads. Existing databases receive these columns through this delta; fresh
/// databases already receive them through [`SCHEMA_V1`] (the complete current
/// DDL, kept idempotent). SQLite `ALTER TABLE ... ADD COLUMN` does not support
/// `IF NOT EXISTS`, so the step is guarded by a column-presence probe.
pub const SCHEMA_V2_TO_V3: &str = r#"
PRAGMA foreign_keys = ON;

-- Inspectable, non-secret query columns for action history. Every column here
-- is deliberately non-secret (category/service/action enums, status, risk/mode,
-- correlation id, normalized failure code, safe summary); the encrypted payload
-- still holds the richer detail. Defaults keep legacy rows queryable.
ALTER TABLE audit_event ADD COLUMN category TEXT NOT NULL DEFAULT 'approval';
ALTER TABLE audit_event ADD COLUMN service TEXT NOT NULL DEFAULT '';
ALTER TABLE audit_event ADD COLUMN action TEXT NOT NULL DEFAULT '';
ALTER TABLE audit_event ADD COLUMN status TEXT NOT NULL DEFAULT '';
ALTER TABLE audit_event ADD COLUMN risk_level TEXT NOT NULL DEFAULT '';
ALTER TABLE audit_event ADD COLUMN mode TEXT NOT NULL DEFAULT '';
ALTER TABLE audit_event ADD COLUMN correlation_id TEXT NOT NULL DEFAULT '';
ALTER TABLE audit_event ADD COLUMN error_code TEXT NOT NULL DEFAULT '';
ALTER TABLE audit_event ADD COLUMN summary TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_audit_category ON audit_event(category);
CREATE INDEX IF NOT EXISTS idx_audit_status ON audit_event(status);
CREATE INDEX IF NOT EXISTS idx_audit_correlation ON audit_event(correlation_id);
"#;

/// Forward schema step `v3 → v4`: moves schedules and workflows out of raw
/// JSON files into encrypted, workspace-isolated SQLite tables. Existing
/// databases receive these tables through this delta; fresh databases already
/// receive them through [`SCHEMA_V1`] (the complete current DDL, kept
/// idempotent with `CREATE TABLE IF NOT EXISTS`). `ALTER TABLE ... ADD COLUMN`
/// is unsupported with `IF NOT EXISTS`, so any column additions on existing
/// tables would be guarded by a column probe in `apply_v3_to_v4` (none are
/// needed here — every table is new).
pub const SCHEMA_V3_TO_V4: &str = r#"
PRAGMA foreign_keys = ON;

-- Encrypted, workspace-isolated scheduled jobs (the durable automation engine
-- record). Query columns are non-secret (workspace, status, timestamps, the
-- linked workflow-definition id, and the trigger kind); the encrypted payload
-- holds the sensitive free text + the full trigger + the frozen execution route
-- (which carries only provider/model ids + permission mode — never secrets).
CREATE TABLE IF NOT EXISTS scheduled_job (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active',
  workflow_definition_id TEXT NOT NULL DEFAULT '',
  trigger_kind TEXT NOT NULL DEFAULT '',
  missed_run_policy TEXT NOT NULL DEFAULT 'skip',
  schema_version INTEGER NOT NULL DEFAULT 1,
  next_run_at TEXT NOT NULL DEFAULT '',
  last_run_at TEXT NOT NULL DEFAULT '',
  last_run_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_job_workspace ON scheduled_job(workspace_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_job_status ON scheduled_job(status);
CREATE INDEX IF NOT EXISTS idx_scheduled_job_definition ON scheduled_job(workflow_definition_id);

-- Encrypted, workspace-isolated scheduler queue. Query columns are the
-- scheduler's runtime authority (state, lease holder + deadline, dedup key,
-- retry backoff); the encrypted payload holds the attempt history + the frozen
-- execution route snapshot. Queue-entry state is never accepted from the wire —
-- it is advanced by the tick and `report_job_attempt` — so the `state` column
-- is authoritative.
CREATE TABLE IF NOT EXISTS scheduler_queue_entry (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES scheduled_job(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'queued',
  lease_holder TEXT NOT NULL DEFAULT '',
  lease_expires_at TEXT NOT NULL DEFAULT '',
  lease_token TEXT NOT NULL DEFAULT '',
  deduplication_key TEXT NOT NULL,
  available_at TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  scheduled_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL,
  UNIQUE(workspace_id, deduplication_key)
);
CREATE INDEX IF NOT EXISTS idx_scheduler_queue_workspace ON scheduler_queue_entry(workspace_id);
CREATE INDEX IF NOT EXISTS idx_scheduler_queue_job ON scheduler_queue_entry(job_id);
CREATE INDEX IF NOT EXISTS idx_scheduler_queue_state ON scheduler_queue_entry(workspace_id, state);
CREATE INDEX IF NOT EXISTS idx_scheduler_queue_dedup ON scheduler_queue_entry(workspace_id, deduplication_key);

-- Encrypted workflow definitions, workspace + version scoped. The full step
-- list lives in the encrypted payload (free-text prompts are sensitive); query
-- columns are the non-secret identity/version/timestamps. `(workspace_id, id,
-- version)` is unique so versioned history is retained without duplication.
CREATE TABLE IF NOT EXISTS workflow_definition (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL,
  PRIMARY KEY (workspace_id, id, version)
);
CREATE INDEX IF NOT EXISTS idx_workflow_definition_workspace ON workflow_definition(workspace_id, id);

-- Encrypted workflow-run journal, workspace scoped. Query columns are
-- non-secret (definition id/version, status, trigger, timestamps); the
-- encrypted payload holds the step records, inputs, and idempotency key.
CREATE TABLE IF NOT EXISTS workflow_run (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  definition_id TEXT NOT NULL,
  definition_version INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  trigger TEXT NOT NULL,
  scheduled_job_id TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT NOT NULL DEFAULT '',
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflow_run_workspace ON workflow_run(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workflow_run_definition ON workflow_run(workspace_id, definition_id);
CREATE INDEX IF NOT EXISTS idx_workflow_run_status ON workflow_run(status);
"#;

/// The full current DDL. Idempotent (`CREATE TABLE IF NOT EXISTS`) so applying
/// it to a fresh database and re-running after a partial apply are both safe.
/// Kept as the complete schema so a fresh database reaches the current version
/// in one batch; existing databases reach it through the registered migration
/// steps in [`super::migrations`].
pub const SCHEMA_V1: &str = r#"
PRAGMA foreign_keys = ON;

-- metadata
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Durable local ownership root. `default` is created by the v4 migration and
-- is the compatibility owner for records written before workspaces existed.
CREATE TABLE IF NOT EXISTS workspace (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- profile + preferences
CREATE TABLE IF NOT EXISTS profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS preferences (
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, key)
);

-- conversation / run graph
CREATE TABLE IF NOT EXISTS project (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
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
CREATE INDEX IF NOT EXISTS idx_project_workspace ON project(workspace_id);

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

-- Inspectable action history. Query columns are non-secret only (category,
-- service, action, status, risk/mode, correlation id, normalized failure code,
-- safe summary); the encrypted payload holds richer detail (safe summaries,
-- redacted previews). See `repos::action_history`.
CREATE TABLE IF NOT EXISTS audit_event (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL,
  category TEXT NOT NULL DEFAULT 'approval',
  service TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  risk_level TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT '',
  correlation_id TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_event(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_category ON audit_event(category);
CREATE INDEX IF NOT EXISTS idx_audit_status ON audit_event(status);
CREATE INDEX IF NOT EXISTS idx_audit_correlation ON audit_event(correlation_id);

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
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES project(id) ON DELETE CASCADE,
  connector_id TEXT NOT NULL,
  account_id TEXT,
  status TEXT NOT NULL,
  expires_at INTEGER,
  credential_ref TEXT NOT NULL,
  connected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL,
  PRIMARY KEY (workspace_id, connector_id)
);
CREATE INDEX IF NOT EXISTS idx_connector_account_workspace ON connector_account(workspace_id);

CREATE TABLE IF NOT EXISTS backend_connection (
  provider_id TEXT PRIMARY KEY,
  connected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- knowledge + memory
CREATE TABLE IF NOT EXISTS knowledge_source (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES project(id) ON DELETE CASCADE,
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
CREATE INDEX IF NOT EXISTS idx_knowledge_workspace ON knowledge_source(workspace_id, project_id);

CREATE TABLE IF NOT EXISTS memory_record (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES project(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  approved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_kind ON memory_record(kind);
CREATE INDEX IF NOT EXISTS idx_memory_pinned ON memory_record(pinned);
CREATE INDEX IF NOT EXISTS idx_memory_workspace ON memory_record(workspace_id, project_id);

-- scheduler (stable surface for Goal 8)
CREATE TABLE IF NOT EXISTS schedule (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES project(id) ON DELETE CASCADE,
  weekday TEXT NOT NULL,
  time TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedule_enabled ON schedule(enabled);
CREATE INDEX IF NOT EXISTS idx_schedule_workspace ON schedule(workspace_id, project_id, enabled);

-- Versioned workflow definitions and run journal. Rich user-authored content is
-- encrypted; only ownership, stable ids, versions, status, and timestamps are
-- queryable. These tables are the hand-off surface for the schedule-SQLite
-- branch.
CREATE TABLE IF NOT EXISTS workflow_definition (
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES project(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL,
  PRIMARY KEY (workspace_id, id, version)
);
CREATE INDEX IF NOT EXISTS idx_workflow_definition_workspace
  ON workflow_definition(workspace_id, project_id, updated_at);

CREATE TABLE IF NOT EXISTS workflow_run (
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES project(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  definition_id TEXT NOT NULL,
  definition_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS idx_workflow_run_workspace
  ON workflow_run(workspace_id, project_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_workflow_run_definition
  ON workflow_run(workspace_id, definition_id, definition_version);

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

-- connector cache (searchable, workspace-isolated, secret-free)
CREATE TABLE IF NOT EXISTS connector_cache (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT,
  connector_id TEXT NOT NULL,
  provider_item_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  trust TEXT NOT NULL DEFAULT 'untrusted',
  pinned INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  content_fingerprint TEXT NOT NULL DEFAULT '',
  cached_at TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'connector-cache',
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_connector_cache_workspace ON connector_cache(workspace_id);
CREATE INDEX IF NOT EXISTS idx_connector_cache_connector ON connector_cache(connector_id);
CREATE INDEX IF NOT EXISTS idx_connector_cache_search ON connector_cache(workspace_id, connector_id, disabled);

-- connector cache settings (per-workspace + per-connector)
CREATE TABLE IF NOT EXISTS connector_cache_settings (
  workspace_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  auto_sync INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL,
  PRIMARY KEY (workspace_id, connector_id)
);

-- scheduler store: scheduled jobs (the durable automation engine record).
-- Encrypted, workspace-isolated; query columns are non-secret. See
-- `repos::scheduled_job`.
CREATE TABLE IF NOT EXISTS scheduled_job (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active',
  workflow_definition_id TEXT NOT NULL DEFAULT '',
  trigger_kind TEXT NOT NULL DEFAULT '',
  missed_run_policy TEXT NOT NULL DEFAULT 'skip',
  schema_version INTEGER NOT NULL DEFAULT 1,
  next_run_at TEXT NOT NULL DEFAULT '',
  last_run_at TEXT NOT NULL DEFAULT '',
  last_run_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_job_workspace ON scheduled_job(workspace_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_job_status ON scheduled_job(status);
CREATE INDEX IF NOT EXISTS idx_scheduled_job_definition ON scheduled_job(workflow_definition_id);

-- scheduler store: the durable queue (runtime authority for entry state).
-- Encrypted, workspace-isolated; the encrypted payload holds the attempt
-- history + frozen execution route snapshot. See `repos::scheduler_queue`.
CREATE TABLE IF NOT EXISTS scheduler_queue_entry (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES scheduled_job(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'queued',
  lease_holder TEXT NOT NULL DEFAULT '',
  lease_expires_at TEXT NOT NULL DEFAULT '',
  lease_token TEXT NOT NULL DEFAULT '',
  deduplication_key TEXT NOT NULL,
  available_at TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  scheduled_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL,
  UNIQUE(workspace_id, deduplication_key)
);
CREATE INDEX IF NOT EXISTS idx_scheduler_queue_workspace ON scheduler_queue_entry(workspace_id);
CREATE INDEX IF NOT EXISTS idx_scheduler_queue_job ON scheduler_queue_entry(job_id);
CREATE INDEX IF NOT EXISTS idx_scheduler_queue_state ON scheduler_queue_entry(workspace_id, state);
CREATE INDEX IF NOT EXISTS idx_scheduler_queue_dedup ON scheduler_queue_entry(workspace_id, deduplication_key);

-- workflow definitions (versioned, workspace + version scoped). The full step
-- list lives in the encrypted payload. See `repos::workflow`.
CREATE TABLE IF NOT EXISTS workflow_definition (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL,
  PRIMARY KEY (workspace_id, id, version)
);
CREATE INDEX IF NOT EXISTS idx_workflow_definition_workspace ON workflow_definition(workspace_id, id);

-- workflow-run journal (workspace scoped). Step records, inputs, and the
-- idempotency key live in the encrypted payload. See `repos::workflow`.
CREATE TABLE IF NOT EXISTS workflow_run (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  definition_id TEXT NOT NULL,
  definition_version INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  trigger TEXT NOT NULL,
  scheduled_job_id TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT NOT NULL DEFAULT '',
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflow_run_workspace ON workflow_run(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workflow_run_definition ON workflow_run(workspace_id, definition_id);
CREATE INDEX IF NOT EXISTS idx_workflow_run_status ON workflow_run(status);

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
