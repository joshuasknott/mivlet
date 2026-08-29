//! SQL schema for the durable encrypted store.
//!
//! See `docs/architecture/encrypted-storage.md`.
//!
//! Sensitive free-text lives inside an encrypted `payload` BLOB with a companion
//! `payload_nonce` BLOB. Plaintext columns are non-secret only: ids, enums,
//! timestamps, booleans, integer counts, and content fingerprints used for
//! indexing and foreign-key joins.

/// The current schema version. Bumped on every breaking schema change; each
/// version has a forward migration registered in [`super::migrations`].
pub const CURRENT_SCHEMA_VERSION: u32 = 39;

/// Retired orchestration storage is removed from every opened database. The
/// historical migration steps remain readable only so pre-release databases
/// can upgrade without guessing ownership or decrypting discarded payloads.
pub const RETIRED_ORCHESTRATION_STORAGE_CLEANUP: &str = r#"
DROP TABLE IF EXISTS mission_approval_consumption;
DROP TABLE IF EXISTS mission_structured_intake_binding;
DROP TABLE IF EXISTS mission_direct_artifact_source;
DROP TABLE IF EXISTS mission_artifact_source;
DROP TABLE IF EXISTS mission_worker_tool_receipt;
DROP TABLE IF EXISTS mission_worker_output_receipt;
DROP TABLE IF EXISTS mission_checkpoint_state;
DROP TABLE IF EXISTS mission_run_event;
DROP TABLE IF EXISTS mission_run_record;
DROP TABLE IF EXISTS mission_plan_revision;
DROP TABLE IF EXISTS mission_plan_record;
DROP TABLE IF EXISTS mission_record;

DROP TABLE IF EXISTS routine_trigger_cursor;
DROP TABLE IF EXISTS routine_driver_occurrence;
DROP TABLE IF EXISTS routine_occurrence;
DROP TABLE IF EXISTS routine_trigger;
DROP TABLE IF EXISTS routine_version;
DROP TABLE IF EXISTS routine_migration_quarantine;
DROP TABLE IF EXISTS routine_migration_snapshot;
DROP TABLE IF EXISTS routine_migration_source;
DROP TABLE IF EXISTS routine_migration_batch;
DROP TABLE IF EXISTS routine_scheduler_authority;
DROP TABLE IF EXISTS routine_record;

DROP TABLE IF EXISTS scheduler_queue_entry;
DROP TABLE IF EXISTS scheduled_job;
DROP TABLE IF EXISTS workflow_run;
DROP TABLE IF EXISTS workflow_definition;
DROP TABLE IF EXISTS schedule;

DROP TABLE IF EXISTS artifact_handoff;
DROP TABLE IF EXISTS artifact_review;
DROP TABLE IF EXISTS artifact_version;
DROP TABLE IF EXISTS artifact_legacy_unowned;
DROP TABLE IF EXISTS artifact;
DROP TABLE IF EXISTS goal;
DROP TABLE IF EXISTS run_state;
"#;

/// Forward schema step `v34 -> v35`: adds an encrypted, owner-qualified
/// at-most-once consumption ledger for approved Mission effects.
///
/// Migration creates no permit or authority. A row is written only by the
/// authenticated native pre-egress boundary after it revalidates the exact
/// approval proposal and its freshness.
pub const SCHEMA_V34_TO_V35: &str = r#"
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS mission_approval_consumption (
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  owner_member_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  wait_key TEXT NOT NULL,
  resolution_event_id TEXT NOT NULL,
  proposal_hash TEXT NOT NULL,
  effect_key TEXT NOT NULL,
  consumed_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL,
  PRIMARY KEY(workspace_id,owner_member_id,wait_key),
  UNIQUE(workspace_id,owner_member_id,resolution_event_id),
  FOREIGN KEY(workspace_id,owner_member_id,run_id)
    REFERENCES mission_run_record(workspace_id,owner_member_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,owner_member_id,resolution_event_id)
    REFERENCES mission_run_event(workspace_id,owner_member_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_mission_approval_consumption_run
  ON mission_approval_consumption(workspace_id,owner_member_id,run_id,consumed_at);
"#;

/// Forward schema step `v32 -> v33`: adds the canonical encrypted Routine
/// repository, portable occurrence history, node-local driver state, reversible
/// legacy-migration evidence, and the one-writer scheduler authority marker.
///
/// The migration deliberately creates no Routine rows and does not change the
/// legacy scheduler. Ownership, execution authority, grants, approvals, and
/// provider placement can only arrive through authenticated native writes.
pub const SCHEMA_V32_TO_V33: &str = r#"
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS routine_record (
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  owner_subject TEXT NOT NULL,
  id TEXT NOT NULL,
  project_id TEXT REFERENCES project(id) ON DELETE SET NULL,
  visibility TEXT NOT NULL,
  owner_member_id TEXT,
  status TEXT NOT NULL,
  current_version INTEGER NOT NULL CHECK(current_version >= 1),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  created_by_internal_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL,
  PRIMARY KEY(workspace_id, owner_subject, id)
);
CREATE INDEX IF NOT EXISTS idx_routine_scope
  ON routine_record(workspace_id, owner_subject, project_id, status, updated_at);

CREATE TABLE IF NOT EXISTS routine_version (
  workspace_id TEXT NOT NULL,
  owner_subject TEXT NOT NULL,
  routine_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  created_by_internal_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL,
  PRIMARY KEY(workspace_id, owner_subject, routine_id, version),
  FOREIGN KEY(workspace_id, owner_subject, routine_id)
    REFERENCES routine_record(workspace_id, owner_subject, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS routine_trigger (
  workspace_id TEXT NOT NULL,
  owner_subject TEXT NOT NULL,
  id TEXT NOT NULL,
  routine_id TEXT NOT NULL,
  project_id TEXT,
  status TEXT NOT NULL,
  kind TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL,
  PRIMARY KEY(workspace_id, owner_subject, id),
  FOREIGN KEY(workspace_id, owner_subject, routine_id)
    REFERENCES routine_record(workspace_id, owner_subject, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_routine_trigger_due
  ON routine_trigger(workspace_id, owner_subject, status, kind, updated_at);

CREATE TABLE IF NOT EXISTS routine_occurrence (
  workspace_id TEXT NOT NULL,
  owner_subject TEXT NOT NULL,
  id TEXT NOT NULL,
  routine_id TEXT NOT NULL,
  trigger_id TEXT NOT NULL,
  routine_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  scheduled_for TEXT,
  observed_at TEXT NOT NULL,
  deduplication_key TEXT NOT NULL,
  run_id TEXT,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL,
  PRIMARY KEY(workspace_id, owner_subject, id),
  UNIQUE(workspace_id, owner_subject, deduplication_key),
  FOREIGN KEY(workspace_id, owner_subject, routine_id)
    REFERENCES routine_record(workspace_id, owner_subject, id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id, owner_subject, trigger_id)
    REFERENCES routine_trigger(workspace_id, owner_subject, id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id, owner_subject, routine_id, routine_version)
    REFERENCES routine_version(workspace_id, owner_subject, routine_id, version)
);
CREATE INDEX IF NOT EXISTS idx_routine_occurrence_history
  ON routine_occurrence(workspace_id, owner_subject, routine_id, observed_at);

-- Lease, fencing, retry, and queue state are node-local execution authority and
-- never enter the portable Routine occurrence contract.
CREATE TABLE IF NOT EXISTS routine_driver_occurrence (
  workspace_id TEXT NOT NULL,
  owner_subject TEXT NOT NULL,
  occurrence_id TEXT NOT NULL,
  writer_epoch INTEGER NOT NULL CHECK(writer_epoch >= 1),
  state TEXT NOT NULL,
  lease_holder TEXT NOT NULL DEFAULT '',
  lease_token TEXT NOT NULL DEFAULT '',
  lease_expires_at TEXT,
  available_at TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  updated_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL,
  PRIMARY KEY(workspace_id, owner_subject, occurrence_id),
  FOREIGN KEY(workspace_id, owner_subject, occurrence_id)
    REFERENCES routine_occurrence(workspace_id, owner_subject, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_routine_driver_due
  ON routine_driver_occurrence(workspace_id, writer_epoch, state, available_at);

CREATE TABLE IF NOT EXISTS routine_migration_batch (
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  owner_subject TEXT NOT NULL,
  id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  planned_at TEXT NOT NULL,
  status TEXT NOT NULL,
  applied_at TEXT,
  rolled_back_at TEXT,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL,
  PRIMARY KEY(workspace_id, owner_subject, id),
  UNIQUE(workspace_id, owner_subject, input_hash)
);

CREATE TABLE IF NOT EXISTS routine_migration_source (
  workspace_id TEXT NOT NULL,
  owner_subject TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  checksum TEXT NOT NULL,
  disposition TEXT NOT NULL,
  canonical_routine_id TEXT,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL,
  PRIMARY KEY(workspace_id, owner_subject, batch_id, source_key),
  FOREIGN KEY(workspace_id, owner_subject, batch_id)
    REFERENCES routine_migration_batch(workspace_id, owner_subject, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_routine_migration_source_identity
  ON routine_migration_source(workspace_id, owner_subject, source_key, checksum);

CREATE TABLE IF NOT EXISTS routine_migration_quarantine (
  workspace_id TEXT NOT NULL,
  owner_subject TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  resolution TEXT NOT NULL DEFAULT 'unresolved',
  resolved_at TEXT,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL,
  PRIMARY KEY(workspace_id, owner_subject, batch_id, source_key),
  FOREIGN KEY(workspace_id, owner_subject, batch_id)
    REFERENCES routine_migration_batch(workspace_id, owner_subject, id) ON DELETE CASCADE
);

-- A single row per workspace selects the only scheduler permitted to enqueue.
-- Epoch is monotonically increased on every transition so stale writers fail
-- closed even after a crash or rollback.
CREATE TABLE IF NOT EXISTS routine_scheduler_authority (
  workspace_id TEXT PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE,
  writer TEXT NOT NULL CHECK(writer IN ('legacy','routine')),
  phase TEXT NOT NULL CHECK(phase IN ('legacy','shadow','routine','rollback')),
  epoch INTEGER NOT NULL CHECK(epoch >= 1),
  fence_token TEXT NOT NULL,
  proof_hash TEXT,
  updated_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS routine_migration_snapshot (
  workspace_id TEXT NOT NULL,
  owner_subject TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL,
  PRIMARY KEY(workspace_id, owner_subject, batch_id, source_key),
  FOREIGN KEY(workspace_id, owner_subject, batch_id)
    REFERENCES routine_migration_batch(workspace_id, owner_subject, id) ON DELETE CASCADE
);
"#;

/// Forward schema step `v33 -> v34`: adds the node-local trigger evaluation
/// cursor used by the canonical Routine scheduler. No cursor is inferred; the
/// fenced writer initializes it transactionally from retained occurrence and
/// cutover evidence.
pub const SCHEMA_V33_TO_V34: &str = r#"
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS routine_trigger_cursor (
  workspace_id TEXT NOT NULL,
  owner_subject TEXT NOT NULL,
  trigger_id TEXT NOT NULL,
  writer_epoch INTEGER NOT NULL CHECK(writer_epoch >= 1),
  last_evaluated_at TEXT NOT NULL,
  next_run_at TEXT,
  updated_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL,
  PRIMARY KEY(workspace_id, owner_subject, trigger_id),
  FOREIGN KEY(workspace_id, owner_subject, trigger_id)
    REFERENCES routine_trigger(workspace_id, owner_subject, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_routine_trigger_cursor_epoch
  ON routine_trigger_cursor(workspace_id, writer_epoch, last_evaluated_at);
"#;

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

CREATE TABLE IF NOT EXISTS connector_cache_tombstone (
  workspace_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  provider_item_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, connector_id, provider_item_id)
);

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

/// Forward schema step `v5 → v6`: adds a plaintext, non-secret `search_text`
/// column to `connector_cache` so lexical search can filter rows via SQL `LIKE`
/// without decrypting every payload. Fresh databases already get the column
/// through [`SCHEMA_V1`]; existing v5 databases receive it here. SQLite lacks
/// `ADD COLUMN IF NOT EXISTS`, so the step is guarded by a column probe.
///
/// The column is added empty (default `''`). Existing rows are backfilled
/// lazily by the store (which holds the vault) on first read after upgrade —
/// see `repos::connector_cache::backfill_search_text`. A new covering index
/// `idx_connector_cache_search_text` supports the workspace + disabled + search
/// filter.
pub const SCHEMA_V5_TO_V6: &str = r#"
PRAGMA foreign_keys = ON;
-- Plaintext lowercased title/provenance/contentPreview concatenation for
-- lexical filtering without decryption. Non-secret: derived only from the
-- already-redacted payload.
ALTER TABLE connector_cache ADD COLUMN search_text TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_connector_cache_search_text
  ON connector_cache(workspace_id, disabled, search_text);
"#;

/// Forward schema step `v6 -> v7`: adds the local encrypted cloud-sync
/// skeleton for optional shared workspaces. These tables are local runtime
/// state only: they cache Convex authority, hold encrypted pending payloads,
/// and are deliberately excluded from portable solo exports.
pub const SCHEMA_V6_TO_V7: &str = r#"
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS cloud_workspace_link (
  local_workspace_id TEXT PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE,
  cloud_workspace_id TEXT NOT NULL,
  clerk_org_id TEXT NOT NULL,
  role TEXT NOT NULL,
  sync_state TEXT NOT NULL,
  linked_device_id TEXT NOT NULL,
  last_accepted_revision INTEGER NOT NULL DEFAULT 0,
  linked_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_workspace_link_cloud
  ON cloud_workspace_link(cloud_workspace_id);
CREATE INDEX IF NOT EXISTS idx_cloud_workspace_link_state
  ON cloud_workspace_link(sync_state);

CREATE TABLE IF NOT EXISTS cloud_sync_cursor (
  local_workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  last_pulled_revision INTEGER NOT NULL DEFAULT 0,
  last_realtime_sequence INTEGER NOT NULL DEFAULT 0,
  last_successful_sync_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (local_workspace_id, device_id)
);

CREATE TABLE IF NOT EXISTS cloud_mutation_outbox (
  local_mutation_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  local_workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  cloud_workspace_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  client_mutation_id TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  record_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cloud_outbox_workspace_status
  ON cloud_mutation_outbox(local_workspace_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_cloud_outbox_cloud_workspace
  ON cloud_mutation_outbox(cloud_workspace_id, status);

CREATE TABLE IF NOT EXISTS cloud_record_shadow (
  local_workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  cloud_workspace_id TEXT NOT NULL,
  record_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  server_revision INTEGER NOT NULL,
  content_fingerprint TEXT NOT NULL,
  deleted_at TEXT NOT NULL DEFAULT '',
  conflict_id TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (local_workspace_id, record_type, record_id)
);
CREATE INDEX IF NOT EXISTS idx_cloud_shadow_workspace_revision
  ON cloud_record_shadow(local_workspace_id, server_revision);

CREATE TABLE IF NOT EXISTS cloud_conflict (
  id TEXT PRIMARY KEY,
  local_workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  cloud_workspace_id TEXT NOT NULL,
  local_mutation_id TEXT NOT NULL,
  record_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cloud_conflict_workspace
  ON cloud_conflict(local_workspace_id, created_at);
"#;

/// Forward schema step `v7 -> v8`: makes the local shared-workspace cache a
/// Fable-owned control-plane mirror. Convex remains canonical: this database
/// caches only explicit attribution, authorization display state, and sync
/// envelopes. Clerk organization ids are copied to a quarantined compatibility
/// table and never participate in link lookup or authorization after upgrade.
pub const SCHEMA_V7_TO_V8: &str = r#"
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS fable_internal_user_mirror (
  internal_user_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  display_name TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  email_hint TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fable_workspace_mirror (
  fable_workspace_id TEXT PRIMARY KEY,
  local_workspace_id TEXT NOT NULL UNIQUE REFERENCES workspace(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  policy_revision INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fable_membership_mirror (
  fable_workspace_id TEXT NOT NULL REFERENCES fable_workspace_mirror(fable_workspace_id) ON DELETE CASCADE,
  member_id TEXT NOT NULL,
  internal_user_id TEXT NOT NULL REFERENCES fable_internal_user_mirror(internal_user_id),
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (fable_workspace_id, member_id),
  UNIQUE (fable_workspace_id, internal_user_id)
);
CREATE TABLE IF NOT EXISTS fable_device_mirror (
  device_id TEXT PRIMARY KEY,
  internal_user_id TEXT NOT NULL REFERENCES fable_internal_user_mirror(internal_user_id),
  status TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'desktop',
  label TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fable_workspace_device_mirror (
  fable_workspace_id TEXT NOT NULL REFERENCES fable_workspace_mirror(fable_workspace_id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES fable_device_mirror(device_id) ON DELETE CASCADE,
  member_id TEXT NOT NULL,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (fable_workspace_id, device_id)
);
CREATE TABLE IF NOT EXISTS cloud_workspace_link_legacy_clerk_org (
  local_workspace_id TEXT PRIMARY KEY,
  clerk_org_id TEXT NOT NULL,
  migrated_at TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT 'v7 compatibility only; not an authorization or tenancy key'
);

ALTER TABLE cloud_workspace_link RENAME TO cloud_workspace_link_v7;
CREATE TABLE cloud_workspace_link (
  local_workspace_id TEXT PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE,
  fable_workspace_id TEXT NOT NULL UNIQUE REFERENCES fable_workspace_mirror(fable_workspace_id) ON DELETE CASCADE,
  internal_user_id TEXT NOT NULL REFERENCES fable_internal_user_mirror(internal_user_id),
  member_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  role TEXT NOT NULL,
  sync_state TEXT NOT NULL,
  last_accepted_revision INTEGER NOT NULL DEFAULT 0,
  linked_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (fable_workspace_id, member_id) REFERENCES fable_membership_mirror(fable_workspace_id, member_id),
  FOREIGN KEY (fable_workspace_id, device_id) REFERENCES fable_workspace_device_mirror(fable_workspace_id, device_id)
);
INSERT INTO cloud_workspace_link_legacy_clerk_org (local_workspace_id, clerk_org_id, migrated_at)
  SELECT local_workspace_id, clerk_org_id, updated_at FROM cloud_workspace_link_v7;
INSERT OR IGNORE INTO fable_internal_user_mirror (internal_user_id, status, revision, updated_at)
  SELECT 'legacy-user:' || linked_device_id, 'active', last_accepted_revision, updated_at FROM cloud_workspace_link_v7;
INSERT OR IGNORE INTO fable_workspace_mirror (fable_workspace_id, local_workspace_id, status, revision, policy_revision, updated_at)
  SELECT cloud_workspace_id, local_workspace_id, 'active', last_accepted_revision, 0, updated_at FROM cloud_workspace_link_v7;
INSERT OR IGNORE INTO fable_membership_mirror (fable_workspace_id, member_id, internal_user_id, role, status, revision, updated_at)
  SELECT cloud_workspace_id, 'legacy-member:' || local_workspace_id, 'legacy-user:' || linked_device_id, role, 'active', last_accepted_revision, updated_at FROM cloud_workspace_link_v7;
INSERT OR IGNORE INTO fable_device_mirror (device_id, internal_user_id, status, revision, updated_at)
  SELECT linked_device_id, 'legacy-user:' || linked_device_id, 'active', last_accepted_revision, updated_at FROM cloud_workspace_link_v7;
INSERT OR IGNORE INTO fable_workspace_device_mirror (fable_workspace_id, device_id, member_id, status, revision, updated_at)
  SELECT cloud_workspace_id, linked_device_id, 'legacy-member:' || local_workspace_id, 'active', last_accepted_revision, updated_at FROM cloud_workspace_link_v7;
INSERT INTO cloud_workspace_link (local_workspace_id, fable_workspace_id, internal_user_id, member_id, device_id, role, sync_state, last_accepted_revision, linked_at, updated_at)
  SELECT local_workspace_id, cloud_workspace_id, 'legacy-user:' || linked_device_id, 'legacy-member:' || local_workspace_id, linked_device_id, role, sync_state, last_accepted_revision, linked_at, updated_at FROM cloud_workspace_link_v7;
DROP TABLE cloud_workspace_link_v7;
CREATE INDEX IF NOT EXISTS idx_cloud_workspace_link_state ON cloud_workspace_link(sync_state);
INSERT OR IGNORE INTO fable_workspace_mirror (fable_workspace_id, local_workspace_id, status, revision, policy_revision, updated_at)
  SELECT 'legacy-workspace:' || id, id, 'active', 0, 0, updated_at FROM workspace;

ALTER TABLE cloud_sync_cursor RENAME TO cloud_sync_cursor_v7;
CREATE TABLE cloud_sync_cursor (
  local_workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  fable_workspace_id TEXT NOT NULL REFERENCES fable_workspace_mirror(fable_workspace_id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  last_pulled_revision INTEGER NOT NULL DEFAULT 0,
  last_realtime_sequence INTEGER NOT NULL DEFAULT 0,
  last_successful_sync_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (local_workspace_id, device_id),
  UNIQUE (fable_workspace_id, device_id)
);
INSERT INTO cloud_sync_cursor SELECT c.local_workspace_id, l.fable_workspace_id, c.device_id, c.last_pulled_revision, c.last_realtime_sequence, c.last_successful_sync_at FROM cloud_sync_cursor_v7 c JOIN cloud_workspace_link l ON l.local_workspace_id=c.local_workspace_id;
DROP TABLE cloud_sync_cursor_v7;

ALTER TABLE cloud_mutation_outbox RENAME TO cloud_mutation_outbox_v7;
CREATE TABLE cloud_mutation_outbox (
  local_mutation_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  local_workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  fable_workspace_id TEXT NOT NULL REFERENCES fable_workspace_mirror(fable_workspace_id) ON DELETE CASCADE,
  internal_user_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  client_mutation_id TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  accepted_revision INTEGER NOT NULL DEFAULT 0,
  record_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  status TEXT NOT NULL,
  deleted_at TEXT NOT NULL DEFAULT '',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL,
  UNIQUE (fable_workspace_id, device_id, client_mutation_id)
);
INSERT INTO cloud_mutation_outbox (local_mutation_id, idempotency_key, local_workspace_id, fable_workspace_id, internal_user_id, member_id, device_id, client_mutation_id, base_revision, record_type, record_id, operation, status, attempt_count, created_at, updated_at, payload, payload_nonce)
  SELECT o.local_mutation_id, l.fable_workspace_id || ':' || l.device_id || ':' || o.client_mutation_id, o.local_workspace_id, l.fable_workspace_id, l.internal_user_id, l.member_id, l.device_id, o.client_mutation_id, o.base_revision, o.record_type, o.record_id, o.operation, CASE WHEN o.status IN ('queued', 'flushing') THEN 'pending' ELSE o.status END, o.attempt_count, o.created_at, o.updated_at, o.payload, o.payload_nonce FROM cloud_mutation_outbox_v7 o JOIN cloud_workspace_link l ON l.local_workspace_id=o.local_workspace_id;
DROP TABLE cloud_mutation_outbox_v7;
CREATE INDEX IF NOT EXISTS idx_cloud_outbox_workspace_status ON cloud_mutation_outbox(local_workspace_id, status, created_at);

ALTER TABLE cloud_record_shadow RENAME TO cloud_record_shadow_v7;
CREATE TABLE cloud_record_shadow (
  local_workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  fable_workspace_id TEXT NOT NULL REFERENCES fable_workspace_mirror(fable_workspace_id) ON DELETE CASCADE,
  record_type TEXT NOT NULL, record_id TEXT NOT NULL, server_revision INTEGER NOT NULL,
  sync_state TEXT NOT NULL DEFAULT 'accepted', content_fingerprint TEXT NOT NULL,
  deleted_at TEXT NOT NULL DEFAULT '', conflict_id TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
  PRIMARY KEY (local_workspace_id, record_type, record_id)
);
INSERT INTO cloud_record_shadow SELECT s.local_workspace_id, l.fable_workspace_id, s.record_type, s.record_id, s.server_revision, CASE WHEN s.conflict_id <> '' THEN 'conflict' ELSE 'accepted' END, s.content_fingerprint, s.deleted_at, s.conflict_id, s.updated_at FROM cloud_record_shadow_v7 s JOIN cloud_workspace_link l ON l.local_workspace_id=s.local_workspace_id;
DROP TABLE cloud_record_shadow_v7;
CREATE INDEX IF NOT EXISTS idx_cloud_shadow_workspace_revision ON cloud_record_shadow(local_workspace_id, server_revision);

ALTER TABLE cloud_conflict RENAME TO cloud_conflict_v7;
CREATE TABLE cloud_conflict (
  id TEXT PRIMARY KEY, local_workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  fable_workspace_id TEXT NOT NULL REFERENCES fable_workspace_mirror(fable_workspace_id) ON DELETE CASCADE,
  local_mutation_id TEXT NOT NULL, record_type TEXT NOT NULL, record_id TEXT NOT NULL,
  base_revision INTEGER NOT NULL DEFAULT 0, server_revision INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT NOT NULL DEFAULT '', reason_code TEXT NOT NULL, created_at TEXT NOT NULL,
  payload BLOB NOT NULL, payload_nonce BLOB NOT NULL
);
INSERT INTO cloud_conflict (id, local_workspace_id, fable_workspace_id, local_mutation_id, record_type, record_id, reason_code, created_at, payload, payload_nonce)
  SELECT c.id, c.local_workspace_id, l.fable_workspace_id, c.local_mutation_id, c.record_type, c.record_id, c.reason_code, c.created_at, c.payload, c.payload_nonce FROM cloud_conflict_v7 c JOIN cloud_workspace_link l ON l.local_workspace_id=c.local_workspace_id;
DROP TABLE cloud_conflict_v7;
CREATE INDEX IF NOT EXISTS idx_cloud_conflict_workspace ON cloud_conflict(local_workspace_id, created_at);
CREATE TABLE IF NOT EXISTS cloud_record_tombstone (
  local_workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  fable_workspace_id TEXT NOT NULL REFERENCES fable_workspace_mirror(fable_workspace_id) ON DELETE CASCADE,
  record_type TEXT NOT NULL, record_id TEXT NOT NULL, deleted_at TEXT NOT NULL,
  server_revision INTEGER NOT NULL, accepted_at TEXT NOT NULL,
  PRIMARY KEY (local_workspace_id, record_type, record_id)
);
CREATE INDEX IF NOT EXISTS idx_cloud_tombstone_workspace_revision ON cloud_record_tombstone(local_workspace_id, server_revision);
"#;

/// Forward schema step `v8 -> v9`: stores the one durable hosted-workspace
/// selection for each internal user. The selection is deliberately separate
/// from the legacy `default` workspace: local-first data keeps its existing
/// owner until a signed-in user has selected an active hosted workspace.
pub const SCHEMA_V8_TO_V9: &str = r#"
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS active_workspace_selection (
  internal_user_id TEXT PRIMARY KEY REFERENCES fable_internal_user_mirror(internal_user_id) ON DELETE CASCADE,
  local_workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  fable_workspace_id TEXT NOT NULL REFERENCES fable_workspace_mirror(fable_workspace_id) ON DELETE CASCADE,
  selected_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_active_workspace_selection_workspace
  ON active_workspace_selection(fable_workspace_id, local_workspace_id);

-- Written only by the native authenticated-account bootstrap/adapter. IPC
-- callers never supply this id, so it cannot become a tenancy boundary.
CREATE TABLE IF NOT EXISTS current_internal_user (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  internal_user_id TEXT NOT NULL REFERENCES fable_internal_user_mirror(internal_user_id) ON DELETE CASCADE,
  established_at TEXT NOT NULL
);
"#;

/// Forward schema step `v9 -> v10`: retains the secret-free account device
/// inventory returned by the hosted authority so offline status can report a
/// conservative snapshot without becoming a device-authorization grant.
pub const SCHEMA_V9_TO_V10: &str = r#"
ALTER TABLE fable_device_mirror ADD COLUMN registered_at TEXT NOT NULL DEFAULT '';
ALTER TABLE fable_device_mirror ADD COLUMN last_seen_at TEXT;
ALTER TABLE fable_device_mirror ADD COLUMN revoked_at TEXT;
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
  authority TEXT NOT NULL DEFAULT 'local',
  visibility TEXT NOT NULL DEFAULT 'member-private',
  owner_member_id TEXT,
  created_by_internal_user_id TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,
  lifecycle TEXT NOT NULL DEFAULT 'active',
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS project_tombstone (
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  deleted_by_internal_user_id TEXT NOT NULL,
  last_revision INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, project_id)
);

CREATE TABLE IF NOT EXISTS thread (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'default' REFERENCES workspace(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES project(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT '',
  lifecycle TEXT NOT NULL DEFAULT 'active',
  last_sequence INTEGER NOT NULL DEFAULT 0,
  last_message_id TEXT,
  authority TEXT NOT NULL DEFAULT 'local',
  visibility TEXT NOT NULL DEFAULT 'member-private',
  owner_member_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_thread_workspace ON thread(workspace_id, project_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_project_workspace ON project(workspace_id);
CREATE INDEX IF NOT EXISTS idx_project_owner ON project(workspace_id, owner_member_id, lifecycle, updated_at);

CREATE TABLE IF NOT EXISTS message (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'default' REFERENCES workspace(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
  role TEXT,
  kind TEXT NOT NULL DEFAULT 'user',
  detail_kind TEXT NOT NULL DEFAULT '',
  seq INTEGER NOT NULL,
  previous_message_id TEXT,
  idempotency_key TEXT NOT NULL DEFAULT '',
  correlation_key TEXT,
  current_revision_id TEXT NOT NULL DEFAULT '',
  current_revision_number INTEGER NOT NULL DEFAULT 1,
  current_revision_state TEXT NOT NULL DEFAULT 'terminal',
  run_id TEXT,
  run_event_id TEXT,
  authority TEXT NOT NULL DEFAULT 'local',
  visibility TEXT NOT NULL DEFAULT 'member-private',
  owner_member_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL,
  UNIQUE(thread_id, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_thread_idempotency ON message(thread_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_message_thread ON message(workspace_id, thread_id, seq);

CREATE TABLE IF NOT EXISTS message_revision (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'default' REFERENCES workspace(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  revision_number INTEGER NOT NULL,
  base_revision_number INTEGER NOT NULL,
  previous_revision_id TEXT,
  state TEXT NOT NULL,
  reason TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  correlation_key TEXT,
  checkpointed_at TEXT NOT NULL,
  run_id TEXT,
  run_event_id TEXT,
  authority TEXT NOT NULL DEFAULT 'local',
  visibility TEXT NOT NULL DEFAULT 'member-private',
  owner_member_id TEXT,
  created_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL,
  UNIQUE(message_id, revision_number),
  UNIQUE(message_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_message_revision_message ON message_revision(workspace_id, message_id, revision_number);

CREATE TABLE IF NOT EXISTS conversation_tombstone (
  workspace_id TEXT NOT NULL DEFAULT 'default' REFERENCES workspace(id) ON DELETE CASCADE,
  target TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  message_id TEXT,
  idempotency_key TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY(workspace_id, target, thread_id, message_id)
);

CREATE TABLE IF NOT EXISTS run (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'default' REFERENCES workspace(id) ON DELETE CASCADE,
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
CREATE INDEX IF NOT EXISTS idx_run_status ON run(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_run_thread ON run(workspace_id, thread_id);

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
-- Partial covering index for the rule-listing query (WHERE decision='rule'
-- ORDER BY service, action), which filters a small subset out of a growing
-- table. Partial so it only indexes the rows the query touches.
CREATE INDEX IF NOT EXISTS idx_approval_rules ON approval(service, action) WHERE decision='rule';

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
-- Supports the cross-workspace credential-ownership guard (EXISTS check on
-- credential_ref WHERE workspace_id <> ?), run on every account upsert. Partial
-- because empty credential refs are valid and never matched.
CREATE INDEX IF NOT EXISTS idx_connector_account_credential
  ON connector_account(credential_ref) WHERE credential_ref <> '';

-- Canonical, secret-free Connection control-plane records. Human-readable and
-- external-principal metadata belongs in the encrypted payload; credential_ref
-- is only an opaque local secure-store binding and never a credential value.
-- Legacy connector_account rows are not silently adopted because they lack the
-- authenticated creator/scope evidence required by the product-spine contract.
CREATE TABLE IF NOT EXISTS connection_record (
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  record_type TEXT NOT NULL CHECK(record_type='connection'),
  authority TEXT NOT NULL CHECK(authority IN ('local','convex')),
  visibility TEXT NOT NULL CHECK(visibility IN ('member-private','workspace-shared')),
  owner_member_id TEXT,
  schema_version INTEGER NOT NULL CHECK(schema_version >= 1),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  created_by_internal_user_id TEXT NOT NULL,
  created_by_device_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('native-connector','provider-runtime','local-service','mcp','router','custom-route')),
  ownership TEXT NOT NULL CHECK(ownership IN ('user-owned','workspace-shared')),
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('pending-authorization','authorizing','authorized','refresh-required','revoked','disconnected','removed')),
  authorization_state TEXT NOT NULL CHECK(authorization_state IN ('not-required','pending','authorized','expired','denied','revoked','unavailable')),
  health_state TEXT NOT NULL CHECK(health_state IN ('unknown','healthy','degraded','unhealthy','offline')),
  trust TEXT NOT NULL CHECK(trust IN ('first-party','fable-reviewed','verified-publisher','user-managed','untrusted')),
  credential_custody TEXT NOT NULL CHECK(credential_custody IN ('os-secure-store','managed-secret-store','provider-owned-session','external-runtime','none')),
  credential_state TEXT NOT NULL CHECK(credential_state IN ('not-required','available','refresh-required','unavailable','revoked','unknown')),
  credential_ref TEXT NOT NULL DEFAULT '',
  connector_definition_key TEXT,
  enabled_by_default INTEGER NOT NULL CHECK(enabled_by_default IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL,
  PRIMARY KEY(workspace_id,id),
  CHECK((visibility='member-private' AND owner_member_id IS NOT NULL) OR
        (visibility='workspace-shared' AND owner_member_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_connection_record_workspace
  ON connection_record(workspace_id,lifecycle,updated_at,id);
CREATE INDEX IF NOT EXISTS idx_connection_record_connector
  ON connection_record(workspace_id,connector_definition_key,lifecycle);
CREATE UNIQUE INDEX IF NOT EXISTS idx_connection_record_credential
  ON connection_record(credential_ref) WHERE credential_ref <> '';

CREATE TABLE IF NOT EXISTS connection_selection (
  workspace_id TEXT NOT NULL,
  connector_definition_key TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  selected_by_internal_user_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,connector_definition_key),
  FOREIGN KEY(workspace_id,connection_id)
    REFERENCES connection_record(workspace_id,id) ON DELETE CASCADE
);

-- Durable, secret-free observations that a canonical Connection can implement
-- a semantic capability. These rows are discovery evidence only: resolution
-- still re-checks current Connection authority, scopes, health, and approval.
CREATE TABLE IF NOT EXISTS capability_implementation_evidence (
  workspace_id TEXT NOT NULL,
  capability_key TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  availability TEXT NOT NULL CHECK(availability IN ('available','degraded')),
  consequence_class TEXT NOT NULL CHECK(consequence_class='read'),
  evidence_kind TEXT NOT NULL CHECK(evidence_kind='adapter-validated'),
  adapter_reference TEXT NOT NULL,
  connection_revision INTEGER NOT NULL CHECK(connection_revision >= 1),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  observed_by_internal_user_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,capability_key,connection_id),
  FOREIGN KEY(workspace_id,connection_id)
    REFERENCES connection_record(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_capability_evidence_connection
  ON capability_implementation_evidence(workspace_id,connection_id,connection_revision);
CREATE INDEX IF NOT EXISTS idx_capability_evidence_capability
  ON capability_implementation_evidence(workspace_id,capability_key,availability);

-- Explicit member-private standing capability authority. The encrypted payload
-- retains the portable grant policy; plaintext columns are only bounded ids,
-- enums, timestamps, and counters needed for fail-closed resolution.
CREATE TABLE IF NOT EXISTS capability_grant (
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  owner_subject TEXT NOT NULL,
  owner_member_id TEXT,
  id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  capability_key TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  connection_revision_at_grant INTEGER NOT NULL CHECK(connection_revision_at_grant >= 1),
  consequence_class TEXT NOT NULL CHECK(consequence_class IN ('read','draft','write','publish','destructive','financial','identity-sensitive')),
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('workspace','project')),
  scope_key TEXT NOT NULL,
  project_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('active','suspended','expired','revoked')),
  max_uses INTEGER CHECK(max_uses IS NULL OR max_uses > 0),
  uses_consumed INTEGER NOT NULL DEFAULT 0 CHECK(uses_consumed >= 0),
  expires_at TEXT,
  granted_by_internal_user_id TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL,
  PRIMARY KEY(workspace_id,owner_subject,id),
  FOREIGN KEY(workspace_id,connection_id)
    REFERENCES connection_record(workspace_id,id) ON DELETE CASCADE,
  CHECK((scope_kind='workspace' AND project_id IS NULL AND scope_key='workspace') OR
        (scope_kind='project' AND project_id IS NOT NULL AND scope_key='project:' || project_id)),
  CHECK(max_uses IS NULL OR uses_consumed <= max_uses)
);
CREATE INDEX IF NOT EXISTS idx_capability_grant_lookup
  ON capability_grant(workspace_id,owner_subject,capability_key,connection_id,consequence_class,scope_key,state);
CREATE UNIQUE INDEX IF NOT EXISTS idx_capability_grant_active_exact
  ON capability_grant(workspace_id,owner_subject,capability_key,connection_id,consequence_class,scope_key)
  WHERE state='active';

-- Machine-local launch configuration for user-managed STDIO MCP servers.
-- Executable paths and arguments are encrypted; plaintext columns contain only
-- authenticated ownership, lifecycle, and optimistic revision metadata.
CREATE TABLE IF NOT EXISTS mcp_local_server_config (
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  owner_subject TEXT NOT NULL,
  id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  disabled INTEGER NOT NULL CHECK(disabled IN (0,1)),
  created_by_internal_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL,
  PRIMARY KEY(workspace_id,owner_subject,id)
);
CREATE INDEX IF NOT EXISTS idx_mcp_local_server_owner
  ON mcp_local_server_config(workspace_id,owner_subject,disabled,updated_at,id);

-- Compatibility rows stay live in connector_account until an authenticated
-- writer can prove the canonical creator/scope. This ledger records the stable
-- proposed identity without copying raw external account ids or ciphertext.
CREATE TABLE IF NOT EXISTS connection_legacy_unattributed (
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  connector_id TEXT NOT NULL,
  proposed_connection_id TEXT,
  quarantined_at TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'legacy connector account had no authenticated creator',
  PRIMARY KEY(workspace_id,connector_id)
);

-- Provider connections belong to the stable local-install principal. They must
-- not depend on an optional hosted-account mirror being present.
CREATE TABLE IF NOT EXISTS backend_connection (
  internal_user_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  connected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (internal_user_id, provider_id)
);
CREATE INDEX IF NOT EXISTS idx_backend_connection_user
  ON backend_connection(internal_user_id, updated_at);

-- Bounded, encrypted execution observations for install-owned native provider
-- routes. These rows are evidence only and never grant route or credential
-- authority. Migration creates no observations.
CREATE TABLE IF NOT EXISTS provider_route_observation (
  internal_user_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  provider_route_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL,
  PRIMARY KEY(internal_user_id,observation_id),
  FOREIGN KEY(internal_user_id,provider_id)
    REFERENCES backend_connection(internal_user_id,provider_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_provider_route_observation_route
  ON provider_route_observation(internal_user_id,provider_route_id,observed_at,observation_id);

-- Bounded, encrypted policy-evaluation outcomes for exact provider routes.
-- These rows are evidence only; they cannot grant route or evaluator authority.
CREATE TABLE IF NOT EXISTS provider_route_quality_observation (
  internal_user_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  provider_route_id TEXT NOT NULL,
  policy_revision_ref TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  evaluated_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL,
  PRIMARY KEY(internal_user_id,observation_id),
  FOREIGN KEY(internal_user_id,provider_id)
    REFERENCES backend_connection(internal_user_id,provider_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_provider_route_quality_observation_route
  ON provider_route_quality_observation(internal_user_id,provider_route_id,policy_revision_ref,evaluated_at,observation_id);

-- Pre-v12 provider metadata had no account owner. It is retained for recovery
-- diagnostics only and is never consulted for authorization or credential use.
CREATE TABLE IF NOT EXISTS backend_connection_legacy_unowned (
  provider_id TEXT PRIMARY KEY,
  connected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  quarantined_at TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'legacy record had no authenticated account owner'
);

-- knowledge + memory
CREATE TABLE IF NOT EXISTS knowledge_source (
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  owner_subject TEXT NOT NULL,
  authority TEXT NOT NULL CHECK (authority='local'),
  visibility TEXT NOT NULL CHECK (visibility='member-private'),
  owner_member_id TEXT,
  id TEXT NOT NULL,
  project_id TEXT REFERENCES project(id) ON DELETE CASCADE,
  connector_id TEXT NOT NULL,
  connector_account_id TEXT NOT NULL DEFAULT '',
  external_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  trust TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  content_fingerprint TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  imported_at TEXT NOT NULL,
  origin TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL,
  PRIMARY KEY (workspace_id, owner_subject, id)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_connector ON knowledge_source(connector_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_pinned ON knowledge_source(pinned);
CREATE INDEX IF NOT EXISTS idx_knowledge_workspace ON knowledge_source(workspace_id, owner_subject, project_id);

CREATE TABLE IF NOT EXISTS memory_record (
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  owner_subject TEXT NOT NULL,
  authority TEXT NOT NULL CHECK (authority='local'),
  visibility TEXT NOT NULL CHECK (visibility='member-private'),
  owner_member_id TEXT,
  id TEXT NOT NULL,
  project_id TEXT REFERENCES project(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  approved INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  forgotten_at TEXT,
  created_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL,
  PRIMARY KEY (workspace_id, owner_subject, id)
);
CREATE INDEX IF NOT EXISTS idx_memory_kind ON memory_record(kind);
CREATE INDEX IF NOT EXISTS idx_memory_pinned ON memory_record(pinned);
CREATE INDEX IF NOT EXISTS idx_memory_workspace ON memory_record(workspace_id, owner_subject, project_id);

-- Durable retrieval dependencies. Composite foreign keys guarantee that a
-- source/memory id can never resolve through another workspace.
CREATE TABLE IF NOT EXISTS knowledge_chunk (
  workspace_id TEXT NOT NULL,
  owner_subject TEXT NOT NULL,
  source_id TEXT NOT NULL,
  id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  content_fingerprint TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL,
  PRIMARY KEY (workspace_id, owner_subject, id),
  FOREIGN KEY (workspace_id, owner_subject, source_id)
    REFERENCES knowledge_source(workspace_id, owner_subject, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunk_source
  ON knowledge_chunk(workspace_id, owner_subject, source_id, ordinal);

CREATE TABLE IF NOT EXISTS pinned_context (
  workspace_id TEXT NOT NULL,
  owner_subject TEXT NOT NULL,
  id TEXT NOT NULL,
  source_id TEXT,
  memory_id TEXT,
  scope_level TEXT NOT NULL,
  project_id TEXT,
  thread_id TEXT,
  pinned_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, owner_subject, id),
  CHECK ((source_id IS NOT NULL) != (memory_id IS NOT NULL)),
  FOREIGN KEY (workspace_id, owner_subject, source_id)
    REFERENCES knowledge_source(workspace_id, owner_subject, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, owner_subject, memory_id)
    REFERENCES memory_record(workspace_id, owner_subject, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pinned_context_scope
  ON pinned_context(workspace_id, owner_subject, scope_level, project_id, thread_id);

-- Minimal deletion/forget guards. They contain no user content and prevent a
-- later import or sync from silently resurrecting an explicitly removed record.
CREATE TABLE IF NOT EXISTS knowledge_tombstone (
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  owner_subject TEXT NOT NULL,
  id TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, owner_subject, id)
);
CREATE TABLE IF NOT EXISTS memory_tombstone (
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  owner_subject TEXT NOT NULL,
  id TEXT NOT NULL,
  forgotten_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, owner_subject, id)
);

-- v15 fail-closed recovery area. Rows/documents without a provable member
-- owner are retained byte-for-byte but never consulted by runtime reads.
CREATE TABLE IF NOT EXISTS private_context_legacy_unowned (
  record_type TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  project_id TEXT,
  payload BLOB,
  payload_nonce BLOB,
  quarantined_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (record_type, workspace_id, record_id)
);

-- model/provider config (no secrets)
CREATE TABLE IF NOT EXISTS model_config (
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  selected INTEGER NOT NULL DEFAULT 0,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL,
  PRIMARY KEY (provider_id, model_id)
);

-- drafts
CREATE TABLE IF NOT EXISTS draft (
  workspace_id TEXT NOT NULL DEFAULT 'default' REFERENCES workspace(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL DEFAULT '',
  id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL,
  PRIMARY KEY (workspace_id, thread_id, id)
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
  -- Lowercased, concatenated title/provenance/contentPreview drawn from the
  -- (already-redacted) payload. Plaintext, non-secret, so lexical search can
  -- filter rows via LIKE without decrypting the payload. Backfilled lazily by
  -- the store (which holds the vault) the first time it is read after upgrade.
  search_text TEXT NOT NULL DEFAULT '',
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_connector_cache_workspace ON connector_cache(workspace_id);
CREATE INDEX IF NOT EXISTS idx_connector_cache_connector ON connector_cache(connector_id);
CREATE INDEX IF NOT EXISTS idx_connector_cache_search ON connector_cache(workspace_id, connector_id, disabled);
-- Covering index for lexical search filtering: workspace + disabled gate +
-- the plaintext search column so a LIKE scan touches only plaintext rows.
CREATE INDEX IF NOT EXISTS idx_connector_cache_search_text ON connector_cache(workspace_id, disabled, search_text);

-- Records provider items removed from the local cache so a later sync cannot
-- silently resurrect them.
CREATE TABLE IF NOT EXISTS connector_cache_tombstone (
  workspace_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  provider_item_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, connector_id, provider_item_id)
);

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

-- Local Fable control-plane mirror. Convex remains canonical; these records
-- only support display, offline authorization facts, and replay-safe sync.
CREATE TABLE IF NOT EXISTS fable_internal_user_mirror (
  internal_user_id TEXT PRIMARY KEY, status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
  display_name TEXT NOT NULL DEFAULT '', avatar_url TEXT NOT NULL DEFAULT '',
  email_hint TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fable_workspace_mirror (
  fable_workspace_id TEXT PRIMARY KEY,
  local_workspace_id TEXT NOT NULL UNIQUE REFERENCES workspace(id) ON DELETE CASCADE,
  status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, policy_revision INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fable_membership_mirror (
  fable_workspace_id TEXT NOT NULL REFERENCES fable_workspace_mirror(fable_workspace_id) ON DELETE CASCADE,
  member_id TEXT NOT NULL, internal_user_id TEXT NOT NULL REFERENCES fable_internal_user_mirror(internal_user_id),
  role TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
  PRIMARY KEY (fable_workspace_id, member_id), UNIQUE (fable_workspace_id, internal_user_id)
);
CREATE TABLE IF NOT EXISTS fable_device_mirror (
  device_id TEXT PRIMARY KEY, internal_user_id TEXT NOT NULL REFERENCES fable_internal_user_mirror(internal_user_id),
  status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'desktop',
  label TEXT NOT NULL DEFAULT '', registered_at TEXT NOT NULL DEFAULT '',
  last_seen_at TEXT, revoked_at TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fable_workspace_device_mirror (
  fable_workspace_id TEXT NOT NULL REFERENCES fable_workspace_mirror(fable_workspace_id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES fable_device_mirror(device_id) ON DELETE CASCADE,
  member_id TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
  PRIMARY KEY (fable_workspace_id, device_id)
);
CREATE TABLE IF NOT EXISTS active_workspace_selection (
  internal_user_id TEXT PRIMARY KEY REFERENCES fable_internal_user_mirror(internal_user_id) ON DELETE CASCADE,
  local_workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  fable_workspace_id TEXT NOT NULL REFERENCES fable_workspace_mirror(fable_workspace_id) ON DELETE CASCADE,
  selected_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_active_workspace_selection_workspace
  ON active_workspace_selection(fable_workspace_id, local_workspace_id);
CREATE TABLE IF NOT EXISTS current_internal_user (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  internal_user_id TEXT NOT NULL REFERENCES fable_internal_user_mirror(internal_user_id) ON DELETE CASCADE,
  established_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cloud_workspace_link_legacy_clerk_org (
  local_workspace_id TEXT PRIMARY KEY, clerk_org_id TEXT NOT NULL, migrated_at TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT 'v7 compatibility only; not an authorization or tenancy key'
);
CREATE TABLE IF NOT EXISTS cloud_workspace_link (
  local_workspace_id TEXT PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE,
  fable_workspace_id TEXT NOT NULL UNIQUE REFERENCES fable_workspace_mirror(fable_workspace_id) ON DELETE CASCADE,
  internal_user_id TEXT NOT NULL REFERENCES fable_internal_user_mirror(internal_user_id),
  member_id TEXT NOT NULL, device_id TEXT NOT NULL, role TEXT NOT NULL, sync_state TEXT NOT NULL,
  last_accepted_revision INTEGER NOT NULL DEFAULT 0, linked_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY (fable_workspace_id, member_id) REFERENCES fable_membership_mirror(fable_workspace_id, member_id),
  FOREIGN KEY (fable_workspace_id, device_id) REFERENCES fable_workspace_device_mirror(fable_workspace_id, device_id)
);
CREATE INDEX IF NOT EXISTS idx_cloud_workspace_link_state ON cloud_workspace_link(sync_state);
CREATE TABLE IF NOT EXISTS cloud_sync_cursor (
  local_workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  fable_workspace_id TEXT NOT NULL REFERENCES fable_workspace_mirror(fable_workspace_id) ON DELETE CASCADE,
  device_id TEXT NOT NULL, last_pulled_revision INTEGER NOT NULL DEFAULT 0,
  last_realtime_sequence INTEGER NOT NULL DEFAULT 0, last_successful_sync_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (local_workspace_id, device_id), UNIQUE (fable_workspace_id, device_id)
);
CREATE TABLE IF NOT EXISTS cloud_mutation_outbox (
  local_mutation_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE,
  local_workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  fable_workspace_id TEXT NOT NULL REFERENCES fable_workspace_mirror(fable_workspace_id) ON DELETE CASCADE,
  internal_user_id TEXT NOT NULL, member_id TEXT NOT NULL, device_id TEXT NOT NULL,
  client_mutation_id TEXT NOT NULL, base_revision INTEGER NOT NULL, accepted_revision INTEGER NOT NULL DEFAULT 0,
  record_type TEXT NOT NULL, record_id TEXT NOT NULL, operation TEXT NOT NULL, status TEXT NOT NULL,
  deleted_at TEXT NOT NULL DEFAULT '', attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload BLOB NOT NULL, payload_nonce BLOB NOT NULL,
  UNIQUE (fable_workspace_id, device_id, client_mutation_id)
);
CREATE INDEX IF NOT EXISTS idx_cloud_outbox_workspace_status ON cloud_mutation_outbox(local_workspace_id, status, created_at);
CREATE TABLE IF NOT EXISTS cloud_record_shadow (
  local_workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  fable_workspace_id TEXT NOT NULL REFERENCES fable_workspace_mirror(fable_workspace_id) ON DELETE CASCADE,
  record_type TEXT NOT NULL, record_id TEXT NOT NULL, server_revision INTEGER NOT NULL,
  sync_state TEXT NOT NULL DEFAULT 'accepted', content_fingerprint TEXT NOT NULL,
  deleted_at TEXT NOT NULL DEFAULT '', conflict_id TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
  PRIMARY KEY (local_workspace_id, record_type, record_id)
);
CREATE INDEX IF NOT EXISTS idx_cloud_shadow_workspace_revision ON cloud_record_shadow(local_workspace_id, server_revision);
CREATE TABLE IF NOT EXISTS cloud_conflict (
  id TEXT PRIMARY KEY, local_workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  fable_workspace_id TEXT NOT NULL REFERENCES fable_workspace_mirror(fable_workspace_id) ON DELETE CASCADE,
  local_mutation_id TEXT NOT NULL, record_type TEXT NOT NULL, record_id TEXT NOT NULL,
  base_revision INTEGER NOT NULL DEFAULT 0, server_revision INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT NOT NULL DEFAULT '', reason_code TEXT NOT NULL, created_at TEXT NOT NULL,
  payload BLOB NOT NULL, payload_nonce BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cloud_conflict_workspace ON cloud_conflict(local_workspace_id, created_at);
CREATE TABLE IF NOT EXISTS cloud_record_tombstone (
  local_workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  fable_workspace_id TEXT NOT NULL REFERENCES fable_workspace_mirror(fable_workspace_id) ON DELETE CASCADE,
  record_type TEXT NOT NULL, record_id TEXT NOT NULL, deleted_at TEXT NOT NULL,
  server_revision INTEGER NOT NULL, accepted_at TEXT NOT NULL,
  PRIMARY KEY (local_workspace_id, record_type, record_id)
);
CREATE INDEX IF NOT EXISTS idx_cloud_tombstone_workspace_revision ON cloud_record_tombstone(local_workspace_id, server_revision);

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

/// Historical orchestration DDL retained only as a migration-cleanup fixture.
/// Production schema initialization never executes this batch.
#[cfg(test)]
pub const LEGACY_ORCHESTRATION_SCHEMA_V37: &str = r#"
-- Mission-generated plans are member-private, bounded snapshots. Mission and
-- plan rows point to one selected immutable revision; free-text objectives,
-- constraints, steps, and acceptance criteria remain encrypted.
CREATE TABLE IF NOT EXISTS mission_record (
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  owner_member_id TEXT NOT NULL,
  id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('planning','ready','running','waiting','completed','partially-completed','failed','cancelled','archived')),
  execution_depth TEXT NOT NULL CHECK(execution_depth IN ('delegated','multi-worker')),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  current_plan_id TEXT NOT NULL,
  current_plan_revision_id TEXT NOT NULL,
  created_by_internal_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL,
  PRIMARY KEY(workspace_id,owner_member_id,id)
);
CREATE INDEX IF NOT EXISTS idx_mission_record_owner
  ON mission_record(workspace_id,owner_member_id,status,updated_at);
CREATE TABLE IF NOT EXISTS mission_plan_record (
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  owner_member_id TEXT NOT NULL,
  id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  current_revision_id TEXT NOT NULL,
  current_revision_number INTEGER NOT NULL CHECK(current_revision_number >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL,
  PRIMARY KEY(workspace_id,owner_member_id,id),
  UNIQUE(workspace_id,owner_member_id,mission_id)
);
CREATE TABLE IF NOT EXISTS mission_plan_revision (
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  owner_member_id TEXT NOT NULL,
  id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK(revision_number >= 1),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL,
  PRIMARY KEY(workspace_id,owner_member_id,id),
  UNIQUE(workspace_id,owner_member_id,plan_id,revision_number)
);
CREATE INDEX IF NOT EXISTS idx_mission_plan_revision_plan
  ON mission_plan_revision(workspace_id,owner_member_id,plan_id,revision_number);

-- Append-only mission run journal. Query columns contain only bounded ids,
-- enums, sequence numbers, and timestamps; run/event bodies stay encrypted.
CREATE TABLE IF NOT EXISTS mission_run_record (
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  owner_member_id TEXT NOT NULL, id TEXT NOT NULL,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  last_sequence INTEGER NOT NULL CHECK(last_sequence >= 1),
  last_event_id TEXT NOT NULL,
  current_attempt_number INTEGER,
  terminal INTEGER NOT NULL CHECK(terminal IN (0,1)),
  created_by_internal_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  payload BLOB NOT NULL, payload_nonce BLOB NOT NULL,
  PRIMARY KEY(workspace_id,owner_member_id,id)
);
CREATE INDEX IF NOT EXISTS idx_mission_run_owner
  ON mission_run_record(workspace_id,owner_member_id,status,updated_at);
CREATE TABLE IF NOT EXISTS mission_run_event (
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  owner_member_id TEXT NOT NULL, run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence >= 1), id TEXT NOT NULL,
  event_type TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  previous_event_id TEXT, attempt_number INTEGER, occurred_at TEXT NOT NULL,
  payload BLOB NOT NULL, payload_nonce BLOB NOT NULL,
  PRIMARY KEY(workspace_id,owner_member_id,run_id,sequence),
  UNIQUE(workspace_id,owner_member_id,id),
  UNIQUE(workspace_id,owner_member_id,run_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_mission_run_event_run
  ON mission_run_event(workspace_id,owner_member_id,run_id,sequence);
CREATE TABLE IF NOT EXISTS mission_checkpoint_state (
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  owner_member_id TEXT NOT NULL, run_id TEXT NOT NULL, checkpoint_event_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK(attempt_number >= 1),
  state_reference TEXT NOT NULL, state_hash TEXT NOT NULL, created_at TEXT NOT NULL,
  payload BLOB NOT NULL, payload_nonce BLOB NOT NULL,
  PRIMARY KEY(workspace_id,owner_member_id,checkpoint_event_id),
  UNIQUE(workspace_id,owner_member_id,run_id,state_reference),
  FOREIGN KEY(workspace_id,owner_member_id,checkpoint_event_id)
    REFERENCES mission_run_event(workspace_id,owner_member_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_mission_checkpoint_run
  ON mission_checkpoint_state(workspace_id,owner_member_id,run_id,created_at);

CREATE TABLE IF NOT EXISTS mission_approval_consumption (
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  owner_member_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  wait_key TEXT NOT NULL,
  resolution_event_id TEXT NOT NULL,
  proposal_hash TEXT NOT NULL,
  effect_key TEXT NOT NULL,
  consumed_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_nonce BLOB NOT NULL,
  PRIMARY KEY(workspace_id,owner_member_id,wait_key),
  UNIQUE(workspace_id,owner_member_id,resolution_event_id),
  FOREIGN KEY(workspace_id,owner_member_id,run_id)
    REFERENCES mission_run_record(workspace_id,owner_member_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,owner_member_id,resolution_event_id)
    REFERENCES mission_run_event(workspace_id,owner_member_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_mission_approval_consumption_run
  ON mission_approval_consumption(workspace_id,owner_member_id,run_id,consumed_at);

CREATE TABLE IF NOT EXISTS mission_worker_output_receipt (
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  owner_member_id TEXT NOT NULL, run_id TEXT NOT NULL, worker_id TEXT NOT NULL,
  completion_event_id TEXT NOT NULL, output_key TEXT NOT NULL,
  value_reference TEXT NOT NULL, content_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 1 AND size_bytes <= 65536),
  created_at TEXT NOT NULL, payload BLOB NOT NULL, payload_nonce BLOB NOT NULL,
  PRIMARY KEY(workspace_id,owner_member_id,completion_event_id,output_key),
  UNIQUE(workspace_id,owner_member_id,run_id,worker_id,output_key),
  UNIQUE(workspace_id,owner_member_id,value_reference),
  FOREIGN KEY(workspace_id,owner_member_id,completion_event_id)
    REFERENCES mission_run_event(workspace_id,owner_member_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_mission_worker_output_run
  ON mission_worker_output_receipt(workspace_id,owner_member_id,run_id,worker_id);

-- Exact provenance for policy-accepted mission output materialized as a
-- canonical artifact/version. The artifact itself remains in the shared
-- artifact read model; this owner-qualified link proves its mission source.
CREATE TABLE IF NOT EXISTS mission_artifact_source (
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  owner_member_id TEXT NOT NULL, mission_run_id TEXT NOT NULL,
  output_key TEXT NOT NULL, owner_subject TEXT NOT NULL,
  artifact_id TEXT NOT NULL, artifact_version_id TEXT NOT NULL,
  completion_event_id TEXT NOT NULL, evaluation_event_id TEXT NOT NULL,
  result_event_id TEXT NOT NULL, value_reference TEXT NOT NULL,
  content_hash TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,owner_member_id,mission_run_id,output_key),
  UNIQUE(workspace_id,owner_subject,artifact_id),
  UNIQUE(workspace_id,owner_subject,artifact_id,artifact_version_id),
  FOREIGN KEY(workspace_id,owner_member_id,mission_run_id)
    REFERENCES mission_run_record(workspace_id,owner_member_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,owner_member_id,completion_event_id)
    REFERENCES mission_run_event(workspace_id,owner_member_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,owner_member_id,evaluation_event_id)
    REFERENCES mission_run_event(workspace_id,owner_member_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,owner_member_id,result_event_id)
    REFERENCES mission_run_event(workspace_id,owner_member_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,owner_subject,artifact_id)
    REFERENCES artifact(workspace_id,owner_subject,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,owner_subject,artifact_id,artifact_version_id)
    REFERENCES artifact_version(workspace_id,owner_subject,artifact_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_mission_artifact_artifact
  ON mission_artifact_source(workspace_id,owner_subject,artifact_id);

-- Exact provenance for a canonical draft materialized directly from a local
-- mission event. Unlike `mission_artifact_source`, this makes no worker,
-- provider, evaluation, or acceptance claim.
CREATE TABLE IF NOT EXISTS mission_direct_artifact_source (
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  owner_member_id TEXT NOT NULL, mission_run_id TEXT NOT NULL,
  output_key TEXT NOT NULL, owner_subject TEXT NOT NULL,
  artifact_id TEXT NOT NULL, artifact_version_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL, result_event_id TEXT NOT NULL,
  content_hash TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,owner_member_id,mission_run_id,output_key),
  UNIQUE(workspace_id,owner_subject,artifact_id),
  UNIQUE(workspace_id,owner_subject,artifact_id,artifact_version_id),
  FOREIGN KEY(workspace_id,owner_member_id,mission_run_id)
    REFERENCES mission_run_record(workspace_id,owner_member_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,owner_member_id,source_event_id)
    REFERENCES mission_run_event(workspace_id,owner_member_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,owner_member_id,result_event_id)
    REFERENCES mission_run_event(workspace_id,owner_member_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,owner_subject,artifact_id)
    REFERENCES artifact(workspace_id,owner_subject,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,owner_subject,artifact_id,artifact_version_id)
    REFERENCES artifact_version(workspace_id,owner_subject,artifact_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_mission_direct_artifact_artifact
  ON mission_direct_artifact_source(workspace_id,owner_subject,artifact_id);

-- Native-only producer binding for the fixed structured-intake mission. The
-- renderer cannot create this row through the generic mission-plan commands.
CREATE TABLE IF NOT EXISTS mission_structured_intake_binding (
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  owner_member_id TEXT NOT NULL, run_id TEXT NOT NULL, mission_id TEXT NOT NULL,
  plan_id TEXT NOT NULL, plan_revision_id TEXT NOT NULL,
  source_thread_id TEXT NOT NULL, project_id TEXT, start_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,owner_member_id,run_id),
  UNIQUE(workspace_id,owner_member_id,mission_id),
  UNIQUE(workspace_id,owner_member_id,source_thread_id,start_hash),
  FOREIGN KEY(workspace_id,owner_member_id,run_id)
    REFERENCES mission_run_record(workspace_id,owner_member_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,owner_member_id,mission_id)
    REFERENCES mission_record(workspace_id,owner_member_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,owner_member_id,plan_id)
    REFERENCES mission_plan_record(workspace_id,owner_member_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,owner_member_id,plan_revision_id)
    REFERENCES mission_plan_revision(workspace_id,owner_member_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_mission_structured_intake_thread
  ON mission_structured_intake_binding(workspace_id,owner_member_id,source_thread_id,created_at);

CREATE TABLE IF NOT EXISTS mission_worker_tool_receipt (
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  owner_member_id TEXT NOT NULL, run_id TEXT NOT NULL, worker_id TEXT NOT NULL,
  tool_event_id TEXT NOT NULL, call_key TEXT NOT NULL,
  output_reference TEXT NOT NULL, output_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 1 AND size_bytes <= 131072),
  created_at TEXT NOT NULL, payload BLOB NOT NULL, payload_nonce BLOB NOT NULL,
  PRIMARY KEY(workspace_id,owner_member_id,tool_event_id),
  UNIQUE(workspace_id,owner_member_id,run_id,worker_id,call_key),
  UNIQUE(workspace_id,owner_member_id,output_reference),
  FOREIGN KEY(workspace_id,owner_member_id,tool_event_id)
    REFERENCES mission_run_event(workspace_id,owner_member_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_mission_worker_tool_run
  ON mission_worker_tool_receipt(workspace_id,owner_member_id,run_id,worker_id);

-- Canonical encrypted Routines. Sensitive titles, instructions, policy
-- reasons, trigger details, history results, and migration evidence are sealed
-- in payloads bound to their owner-qualified row identities.
CREATE TABLE IF NOT EXISTS routine_record (
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  owner_subject TEXT NOT NULL, id TEXT NOT NULL,
  project_id TEXT REFERENCES project(id) ON DELETE SET NULL,
  visibility TEXT NOT NULL, owner_member_id TEXT, status TEXT NOT NULL,
  current_version INTEGER NOT NULL CHECK(current_version >= 1),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  created_by_internal_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
  payload BLOB NOT NULL, payload_nonce BLOB NOT NULL,
  PRIMARY KEY(workspace_id,owner_subject,id)
);
CREATE INDEX IF NOT EXISTS idx_routine_scope
  ON routine_record(workspace_id,owner_subject,project_id,status,updated_at);
CREATE TABLE IF NOT EXISTS routine_version (
  workspace_id TEXT NOT NULL, owner_subject TEXT NOT NULL,
  routine_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version >= 1),
  created_by_internal_user_id TEXT NOT NULL, created_at TEXT NOT NULL,
  payload BLOB NOT NULL, payload_nonce BLOB NOT NULL,
  PRIMARY KEY(workspace_id,owner_subject,routine_id,version),
  FOREIGN KEY(workspace_id,owner_subject,routine_id)
    REFERENCES routine_record(workspace_id,owner_subject,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS routine_trigger (
  workspace_id TEXT NOT NULL, owner_subject TEXT NOT NULL,
  id TEXT NOT NULL, routine_id TEXT NOT NULL, project_id TEXT,
  status TEXT NOT NULL, kind TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
  payload BLOB NOT NULL, payload_nonce BLOB NOT NULL,
  PRIMARY KEY(workspace_id,owner_subject,id),
  FOREIGN KEY(workspace_id,owner_subject,routine_id)
    REFERENCES routine_record(workspace_id,owner_subject,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_routine_trigger_due
  ON routine_trigger(workspace_id,owner_subject,status,kind,updated_at);
CREATE TABLE IF NOT EXISTS routine_trigger_cursor (
  workspace_id TEXT NOT NULL, owner_subject TEXT NOT NULL,
  trigger_id TEXT NOT NULL, writer_epoch INTEGER NOT NULL CHECK(writer_epoch >= 1),
  last_evaluated_at TEXT NOT NULL, next_run_at TEXT, updated_at TEXT NOT NULL,
  payload BLOB NOT NULL, payload_nonce BLOB NOT NULL,
  PRIMARY KEY(workspace_id,owner_subject,trigger_id),
  FOREIGN KEY(workspace_id,owner_subject,trigger_id)
    REFERENCES routine_trigger(workspace_id,owner_subject,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_routine_trigger_cursor_epoch
  ON routine_trigger_cursor(workspace_id,writer_epoch,last_evaluated_at);
CREATE TABLE IF NOT EXISTS routine_occurrence (
  workspace_id TEXT NOT NULL, owner_subject TEXT NOT NULL, id TEXT NOT NULL,
  routine_id TEXT NOT NULL, trigger_id TEXT NOT NULL,
  routine_version INTEGER NOT NULL, status TEXT NOT NULL,
  scheduled_for TEXT, observed_at TEXT NOT NULL,
  deduplication_key TEXT NOT NULL, run_id TEXT,
  payload BLOB NOT NULL, payload_nonce BLOB NOT NULL,
  PRIMARY KEY(workspace_id,owner_subject,id),
  UNIQUE(workspace_id,owner_subject,deduplication_key),
  FOREIGN KEY(workspace_id,owner_subject,routine_id)
    REFERENCES routine_record(workspace_id,owner_subject,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,owner_subject,trigger_id)
    REFERENCES routine_trigger(workspace_id,owner_subject,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,owner_subject,routine_id,routine_version)
    REFERENCES routine_version(workspace_id,owner_subject,routine_id,version)
);
CREATE INDEX IF NOT EXISTS idx_routine_occurrence_history
  ON routine_occurrence(workspace_id,owner_subject,routine_id,observed_at);
CREATE TABLE IF NOT EXISTS routine_driver_occurrence (
  workspace_id TEXT NOT NULL, owner_subject TEXT NOT NULL,
  occurrence_id TEXT NOT NULL, writer_epoch INTEGER NOT NULL CHECK(writer_epoch >= 1),
  state TEXT NOT NULL, lease_holder TEXT NOT NULL DEFAULT '',
  lease_token TEXT NOT NULL DEFAULT '', lease_expires_at TEXT,
  available_at TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  updated_at TEXT NOT NULL, payload BLOB NOT NULL, payload_nonce BLOB NOT NULL,
  PRIMARY KEY(workspace_id,owner_subject,occurrence_id),
  FOREIGN KEY(workspace_id,owner_subject,occurrence_id)
    REFERENCES routine_occurrence(workspace_id,owner_subject,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_routine_driver_due
  ON routine_driver_occurrence(workspace_id,writer_epoch,state,available_at);
CREATE TABLE IF NOT EXISTS routine_migration_batch (
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  owner_subject TEXT NOT NULL, id TEXT NOT NULL, input_hash TEXT NOT NULL,
  planned_at TEXT NOT NULL, status TEXT NOT NULL,
  applied_at TEXT, rolled_back_at TEXT,
  payload BLOB NOT NULL, payload_nonce BLOB NOT NULL,
  PRIMARY KEY(workspace_id,owner_subject,id),
  UNIQUE(workspace_id,owner_subject,input_hash)
);
CREATE TABLE IF NOT EXISTS routine_migration_source (
  workspace_id TEXT NOT NULL, owner_subject TEXT NOT NULL,
  batch_id TEXT NOT NULL, source_key TEXT NOT NULL, checksum TEXT NOT NULL,
  disposition TEXT NOT NULL, canonical_routine_id TEXT,
  payload BLOB NOT NULL, payload_nonce BLOB NOT NULL,
  PRIMARY KEY(workspace_id,owner_subject,batch_id,source_key),
  FOREIGN KEY(workspace_id,owner_subject,batch_id)
    REFERENCES routine_migration_batch(workspace_id,owner_subject,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_routine_migration_source_identity
  ON routine_migration_source(workspace_id,owner_subject,source_key,checksum);
CREATE TABLE IF NOT EXISTS routine_migration_quarantine (
  workspace_id TEXT NOT NULL, owner_subject TEXT NOT NULL,
  batch_id TEXT NOT NULL, source_key TEXT NOT NULL,
  reason TEXT NOT NULL, decided_at TEXT NOT NULL,
  resolution TEXT NOT NULL DEFAULT 'unresolved', resolved_at TEXT,
  payload BLOB NOT NULL, payload_nonce BLOB NOT NULL,
  PRIMARY KEY(workspace_id,owner_subject,batch_id,source_key),
  FOREIGN KEY(workspace_id,owner_subject,batch_id)
    REFERENCES routine_migration_batch(workspace_id,owner_subject,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS routine_scheduler_authority (
  workspace_id TEXT PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE,
  writer TEXT NOT NULL CHECK(writer IN ('legacy','routine')),
  phase TEXT NOT NULL CHECK(phase IN ('legacy','shadow','routine','rollback')),
  epoch INTEGER NOT NULL CHECK(epoch >= 1), fence_token TEXT NOT NULL,
  proof_hash TEXT, updated_at TEXT NOT NULL,
  payload BLOB NOT NULL, payload_nonce BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS routine_migration_snapshot (
  workspace_id TEXT NOT NULL, owner_subject TEXT NOT NULL,
  batch_id TEXT NOT NULL, source_key TEXT NOT NULL, captured_at TEXT NOT NULL,
  payload BLOB NOT NULL, payload_nonce BLOB NOT NULL,
  PRIMARY KEY(workspace_id,owner_subject,batch_id,source_key),
  FOREIGN KEY(workspace_id,owner_subject,batch_id)
    REFERENCES routine_migration_batch(workspace_id,owner_subject,id) ON DELETE CASCADE
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
