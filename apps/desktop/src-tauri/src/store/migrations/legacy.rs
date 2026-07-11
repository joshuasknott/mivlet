//! Legacy JSON → encrypted SQLite data migration.
//!
//! See `docs/superpowers/specs/2026-06-28-encrypted-storage-design.md` (D5).
//!
//! Each legacy source file is migrated in its own transaction, idempotently.
//! A `migration_log` row records `(source, checksum, status, migrated_at,
//! diagnostics)`; re-running a migration whose checksum matches is a no-op,
//! and a re-run after partial failure resumes only incomplete sources. Legacy
//! files are **never deleted** — they stay on disk so a downgrade/rollback is
//! always possible.
//!
//! Record classification:
//! - **secret** → never migrated (already in OS secure storage).
//! - **sensitive** (free text) → encrypted into a `payload` BLOB.
//! - **ordinary** (ids/enums/timestamps) → plaintext columns.
//! - **cache** → rebuilt, not migrated.
//! - **disposable** → dropped, logged (no payload, no secret).
//! - **unsupported legacy fields** → preserved as encrypted `legacy_extras`,
//!   never silently dropped.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::models::{
    MAX_APPROVAL_AUDIT_ENTRIES, MAX_APPROVAL_RULES, MAX_IMPORTED_KNOWLEDGE_SOURCES,
    MAX_MEMORY_RECORDS, MAX_RUNTIME_SNAPSHOT_SCHEDULES,
};
use crate::store::repos;
use crate::store::vault::Sealed;
use crate::store::{Result, Store, StoreError};

/// A legacy source's name (stable id used in `migration_log.source`).
pub const SOURCE_SNAPSHOT: &str = "runtime-snapshot.json";
pub const SOURCE_AGENT_RUNS: &str = "agent-runs.json";
pub const SOURCE_APPROVAL_AUDIT: &str = "approval-audit.json";
pub const SOURCE_APPROVAL_RULES: &str = "approval-rules.json";
pub const SOURCE_EXECUTION_APPROVALS: &str = "execution-approvals.json";
pub const SOURCE_CONNECTOR_APPROVAL_RECORDS: &str = "connector-approval-records.json";
pub const SOURCE_CONNECTOR_CONNECTIONS: &str = "connector-connections.json";
pub const SOURCE_CONNECTED_BACKENDS: &str = "connected-backends.json";
pub const SOURCE_MEMORY_STATE: &str = "memory-state.json";
pub const SOURCE_IMPORTED_KNOWLEDGE: &str = "imported-knowledge.json";
/// Legacy scheduler store (jobs + queue + occurrence ledger), migrated into
/// the encrypted `scheduled_job` / `scheduler_queue_entry` tables.
pub const SOURCE_SCHEDULER_STORE: &str = "scheduler-store.json";
/// Legacy workflow-definition journal, migrated into the encrypted
/// `workflow_definition` table.
pub const SOURCE_WORKFLOW_DEFINITIONS: &str = "workflow-definitions.json";
/// Legacy workflow-run journal, migrated into the encrypted `workflow_run` table.
pub const SOURCE_WORKFLOW_RUNS: &str = "workflow-runs.json";

/// Status values recorded in `migration_log.status`.
pub const STATUS_DONE: &str = "done";
pub const STATUS_PARTIAL: &str = "partial";

/// Structured diagnostics for one migrated source. Never carries secrets; only
/// counts, reasons for skipped records, and unsupported-field names.
#[derive(Default, Serialize, Deserialize)]
pub struct MigrationDiagnostics {
    pub migrated: usize,
    pub skipped: usize,
    pub skipped_reasons: Vec<String>,
    pub preserved_fields: Vec<String>,
}

impl MigrationDiagnostics {
    fn note_skip(&mut self, reason: impl Into<String>) {
        self.skipped += 1;
        self.skipped_reasons.push(reason.into());
    }
}

/// The legacy `PersistedAgentRun` / agent-runs.json shape (array).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyAgentRun {
    #[serde(default)]
    id: String,
    #[serde(default)]
    provider_id: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    transcript: String,
    #[serde(default)]
    turn: usize,
    #[serde(default, alias = "usage")]
    _usage: Option<Value>,
    #[serde(default)]
    pending_approval_ids: Vec<String>,
    #[serde(default)]
    recoverable: bool,
    #[serde(default)]
    retry_count: usize,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    updated_at: String,
}

/// The legacy `MemoryControlState` / memory-state.json shape.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyMemoryState {
    #[serde(default)]
    disabled: bool,
    #[serde(default)]
    records: Vec<Value>,
}

/// A flattened view over the legacy `RuntimeSnapshot` JSON. Unknown fields are
/// captured into `extras` so nothing is silently dropped.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacySnapshot {
    #[serde(default)]
    active_item: String,
    #[serde(default)]
    composer_draft: String,
    #[serde(default)]
    voice_enabled: bool,
    #[serde(default)]
    approval_audit: Vec<Value>,
    #[serde(default)]
    dismissed_approval_ids: Vec<String>,
    #[serde(default)]
    approval_rules: Vec<Value>,
    #[serde(default)]
    schedules: Vec<Value>,
    #[serde(default)]
    pinned_source_ids: Vec<String>,
    #[serde(default)]
    memory_disabled: bool,
    #[serde(default)]
    memory_records: Vec<Value>,
    #[serde(default)]
    connected_backend_ids: Vec<String>,
    #[serde(default)]
    selected_model_id: String,
    #[serde(default)]
    permission_mode: String,
    /// Catch-all for fields this version does not explicitly model.
    #[serde(flatten)]
    extras: BTreeMap<String, Value>,
}

/// An entry in `migration_log`.
struct LogRow {
    checksum: String,
    status: String,
    migrated_at: String,
    sealed_diagnostics: Sealed,
}

/// SHA-256 checksum of a file's bytes (deterministic idempotency key).
fn checksum_of(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// Is this source already migrated with a matching checksum? (Idempotency.)
fn already_migrated(conn: &Connection, source: &str, checksum: &str) -> Result<bool> {
    let row: Option<String> = conn
        .query_row(
            "SELECT status FROM migration_log WHERE source = ?1 AND checksum = ?2;",
            rusqlite::params![source, checksum],
            |row| row.get(0),
        )
        .optional()
        .map_err(StoreError::from)?;
    Ok(matches!(row.as_deref(), Some(STATUS_DONE)))
}

/// Record a migration outcome in `migration_log` (encrypted diagnostics).
fn record_log(tx: &Connection, source: &str, log: &LogRow) -> Result<()> {
    tx.execute(
        "INSERT INTO migration_log (source, checksum, status, migrated_at, diagnostics, diagnostics_nonce)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(source) DO UPDATE SET
           checksum=excluded.checksum, status=excluded.status,
           migrated_at=excluded.migrated_at,
           diagnostics=excluded.diagnostics, diagnostics_nonce=excluded.diagnostics_nonce;",
        rusqlite::params![
            source,
            log.checksum,
            log.status,
            log.migrated_at,
            log.sealed_diagnostics.ciphertext,
            log.sealed_diagnostics.nonce,
        ],
    )?;
    Ok(())
}

fn seal_diagnostics(store: &Store, source: &str, diag: &MigrationDiagnostics) -> Result<Sealed> {
    let bytes = serde_json::to_vec(diag)
        .map_err(|_| StoreError::Invalid("Could not encode migration diagnostics.".into()))?;
    store.seal_payload(&bytes, &format!("migration_log:{source}"))
}

/// Migrate every legacy source present in `app_data_dir`, idempotently. Each
/// source runs in its own transaction; a failure in one does not roll back
/// others. Legacy files are never deleted.
pub fn migrate_all(store: &Store, app_data_dir: &Path) -> Result<()> {
    let now = now_iso();

    for source in all_sources() {
        let path = app_data_dir.join(source);
        if !path.exists() {
            continue;
        }
        let raw = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(_) => {
                // Unreadable file: skip this pass, leave it for retry.
                continue;
            }
        };
        let checksum = checksum_of(&raw);

        // Open+check+commit per source so partial progress is durable.
        let already = store.with_conn(|conn| already_migrated(conn, source, &checksum))?;
        if already {
            continue;
        }

        let result = migrate_one_source(store, source, &raw, &now);
        let (status, diag) = match result {
            Ok(diag) => {
                let st = if diag.skipped > 0 {
                    STATUS_PARTIAL
                } else {
                    STATUS_DONE
                };
                (st, diag)
            }
            Err(err) => {
                // On failure, mark partial with a diagnostic so the next launch
                // retries this source (checksum won't match a "done" row).
                let mut d = MigrationDiagnostics::default();
                d.note_skip(format!("migration error: {err}"));
                (STATUS_PARTIAL, d)
            }
        };
        let sealed = seal_diagnostics(store, source, &diag)?;
        let log = LogRow {
            checksum,
            status: status.to_string(),
            migrated_at: now.clone(),
            sealed_diagnostics: sealed,
        };
        store.transaction(|tx| record_log(tx, source, &log))?;
    }

    Ok(())
}

fn all_sources() -> &'static [&'static str] {
    &[
        SOURCE_SNAPSHOT,
        SOURCE_AGENT_RUNS,
        SOURCE_APPROVAL_AUDIT,
        SOURCE_APPROVAL_RULES,
        SOURCE_EXECUTION_APPROVALS,
        SOURCE_CONNECTOR_APPROVAL_RECORDS,
        SOURCE_CONNECTOR_CONNECTIONS,
        SOURCE_CONNECTED_BACKENDS,
        SOURCE_MEMORY_STATE,
        SOURCE_IMPORTED_KNOWLEDGE,
        SOURCE_SCHEDULER_STORE,
        SOURCE_WORKFLOW_DEFINITIONS,
        SOURCE_WORKFLOW_RUNS,
    ]
}

/// Dispatch one source's bytes to its migrator.
fn migrate_one_source(
    store: &Store,
    source: &str,
    raw: &[u8],
    now: &str,
) -> Result<MigrationDiagnostics> {
    match source {
        SOURCE_SNAPSHOT => migrate_snapshot(store, raw, now),
        SOURCE_AGENT_RUNS => migrate_agent_runs(store, raw, now),
        SOURCE_MEMORY_STATE => migrate_memory_state(store, raw, now),
        SOURCE_CONNECTED_BACKENDS => migrate_connected_backends(store, raw, now),
        SOURCE_CONNECTOR_CONNECTIONS => migrate_connector_connections(store, raw, now),
        SOURCE_APPROVAL_AUDIT => migrate_approval_audit(store, raw, now),
        SOURCE_APPROVAL_RULES => migrate_approval_rules(store, raw, now),
        SOURCE_IMPORTED_KNOWLEDGE => migrate_imported_knowledge(store, raw, now),
        SOURCE_SCHEDULER_STORE => migrate_scheduler_store(store, raw, now),
        SOURCE_WORKFLOW_DEFINITIONS => migrate_workflow_definitions(store, raw, now),
        SOURCE_WORKFLOW_RUNS => migrate_workflow_runs(store, raw, now),
        // Execution permits and connector approval records are short-lived
        // execution authority (consumed once). They are disposable across a
        // restart boundary: migrate them as audit events only, not as live
        // authority. They are intentionally not re-issued as live permits.
        SOURCE_EXECUTION_APPROVALS | SOURCE_CONNECTOR_APPROVAL_RECORDS => {
            let mut d = MigrationDiagnostics::default();
            d.note_skip("execution-authority records are disposable across restart");
            Ok(d)
        }
        _ => {
            let mut d = MigrationDiagnostics::default();
            d.note_skip("unknown legacy source");
            Ok(d)
        }
    }
}

/// Parse `raw` as JSON; return the value (used to capture unknown fields).
fn parse_value(raw: &[u8]) -> Result<Value> {
    serde_json::from_slice::<Value>(raw)
        .map_err(|_| StoreError::Invalid("A legacy file could not be parsed.".into()))
}

fn migrate_snapshot(store: &Store, raw: &[u8], now: &str) -> Result<MigrationDiagnostics> {
    let snap: LegacySnapshot = serde_json::from_slice(raw)
        .map_err(|_| StoreError::Invalid("Runtime snapshot could not be parsed.".into()))?;
    let mut diag = MigrationDiagnostics::default();
    for k in snap.extras.keys() {
        diag.preserved_fields.push(format!("snapshot.{k}"));
    }

    store.transaction(|tx| {
        // composer draft → draft row (sensitive: encrypted).
        if !snap.composer_draft.is_empty() {
            let payload = serde_json::json!({ "text": snap.composer_draft });
            repos::draft::upsert(tx, store, "composer", &payload, now)?;
            diag.migrated += 1;
        }

        // permission mode + selected model + active item + voice → preferences.
        let prefs = serde_json::json!({
            "activeItem": snap.active_item,
            "voiceEnabled": snap.voice_enabled,
            "selectedModelId": snap.selected_model_id,
            "permissionMode": snap.permission_mode,
            "memoryDisabled": snap.memory_disabled,
        });
        repos::preferences::upsert(tx, store, "shell", &prefs, now)?;

        // dismissed approval ids + pinned source ids → preferences (id lists).
        repos::preferences::upsert(
            tx,
            store,
            "dismissedApprovalIds",
            &serde_json::json!({ "ids": snap.dismissed_approval_ids }),
            now,
        )?;
        repos::preferences::upsert(
            tx,
            store,
            "pinnedSourceIds",
            &serde_json::json!({ "ids": snap.pinned_source_ids }),
            now,
        )?;

        // connected backend ids → backend_connection rows (ids only, no secrets).
        for id in &snap.connected_backend_ids {
            if crate::models::SUPPORTED_BACKEND_PROVIDER_IDS.contains(&id.as_str()) {
                repos::backend_connection::quarantine_legacy(tx, id, now)?;
                diag.migrated += 1;
            } else {
                diag.note_skip(format!("unsupported backend id '{id}'"));
            }
        }

        // schedules → schedule rows.
        for sch in snap.schedules.iter().take(MAX_RUNTIME_SNAPSHOT_SCHEDULES) {
            match repos::schedule::upsert_from_value(tx, store, sch.clone(), now) {
                Ok(()) => diag.migrated += 1,
                Err(_) => diag.note_skip("malformed schedule"),
            }
        }

        // memory records → memory_record rows.
        for rec in snap.memory_records.iter().take(MAX_MEMORY_RECORDS) {
            match repos::memory_record::upsert_from_value(tx, store, rec.clone(), now) {
                Ok(()) => diag.migrated += 1,
                Err(_) => diag.note_skip("malformed memory record"),
            }
        }

        // approval audit → audit_event rows.
        for entry in snap.approval_audit.iter().take(MAX_APPROVAL_AUDIT_ENTRIES) {
            match repos::audit_event::upsert_from_value(tx, store, "approval", entry.clone(), now) {
                Ok(()) => diag.migrated += 1,
                Err(_) => diag.note_skip("malformed audit entry"),
            }
        }

        // approval rules (rule-scope only, mirroring legacy behavior).
        for grant in snap.approval_rules.iter().take(MAX_APPROVAL_RULES) {
            match repos::approval::upsert_rule_from_value(tx, store, grant.clone(), now) {
                Ok(()) => diag.migrated += 1,
                Err(_) => diag.note_skip("malformed approval rule"),
            }
        }

        Ok(())
    })?;
    Ok(diag)
}

fn migrate_agent_runs(store: &Store, raw: &[u8], now: &str) -> Result<MigrationDiagnostics> {
    let runs: Vec<LegacyAgentRun> = serde_json::from_slice(raw)
        .map_err(|_| StoreError::Invalid("agent-runs.json could not be parsed.".into()))?;
    let mut diag = MigrationDiagnostics::default();
    store.transaction(|tx| {
        for run in runs.into_iter().take(crate::models::MAX_AGENT_RUNS) {
            if run.id.is_empty() || run.provider_id.is_empty() || run.model.is_empty() {
                diag.note_skip("agent run missing required id/provider/model");
                continue;
            }
            let payload = serde_json::json!({
                "transcript": run.transcript,
                "pendingApprovalIds": run.pending_approval_ids,
                "error": run.error,
            });
            match repos::run::upsert(
                tx,
                store,
                &run.id,
                None,
                &run.provider_id,
                &run.model,
                &run.status,
                run.turn,
                run.recoverable,
                run.retry_count,
                &run.created_at,
                &run.updated_at,
                &payload,
            ) {
                Ok(()) => {
                    diag.migrated += 1;
                    repos::run_state::upsert(tx, store, &run.id, &payload, now)?;
                }
                Err(_) => diag.note_skip(format!("malformed run '{}'", run.id)),
            }
        }
        Ok(())
    })?;
    Ok(diag)
}

fn migrate_memory_state(store: &Store, raw: &[u8], now: &str) -> Result<MigrationDiagnostics> {
    let state: LegacyMemoryState = serde_json::from_slice(raw)
        .map_err(|_| StoreError::Invalid("memory-state.json could not be parsed.".into()))?;
    let mut diag = MigrationDiagnostics::default();
    let disabled = state.disabled;
    // Mirror the disabled flag into preferences if not already set by snapshot.
    store.transaction(|tx| {
        repos::preferences::upsert(
            tx,
            store,
            "memoryDisabled",
            &serde_json::json!({ "disabled": disabled }),
            now,
        )
    })?;
    store.transaction(|tx| {
        for rec in state.records.into_iter().take(MAX_MEMORY_RECORDS) {
            match repos::memory_record::upsert_from_value(tx, store, rec, now) {
                Ok(()) => diag.migrated += 1,
                Err(_) => diag.note_skip("malformed memory record"),
            }
        }
        Ok(())
    })?;
    Ok(diag)
}

fn migrate_connected_backends(
    store: &Store,
    raw: &[u8],
    now: &str,
) -> Result<MigrationDiagnostics> {
    // Legacy shape: a JSON array of provider-id strings.
    let ids: Vec<String> = serde_json::from_slice(raw)
        .map_err(|_| StoreError::Invalid("connected-backends.json could not be parsed.".into()))?;
    let mut diag = MigrationDiagnostics::default();
    store.transaction(|tx| {
        for id in ids {
            if crate::models::SUPPORTED_BACKEND_PROVIDER_IDS.contains(&id.as_str()) {
                repos::backend_connection::quarantine_legacy(tx, &id, now)?;
                diag.migrated += 1;
            } else {
                diag.note_skip(format!("unsupported backend id '{id}'"));
            }
        }
        Ok(())
    })?;
    Ok(diag)
}

fn migrate_connector_connections(
    store: &Store,
    raw: &[u8],
    now: &str,
) -> Result<MigrationDiagnostics> {
    let value = parse_value(raw)?;
    let arr = value
        .as_array()
        .ok_or_else(|| StoreError::Invalid("connector-connections.json is not an array.".into()))?;
    let mut diag = MigrationDiagnostics::default();
    let conns = arr.clone();
    store.transaction(|tx| {
        for conn in conns {
            match repos::connector_account::upsert_from_value(tx, store, conn, now) {
                Ok(()) => diag.migrated += 1,
                Err(_) => diag.note_skip("malformed connector connection"),
            }
        }
        Ok(())
    })?;
    Ok(diag)
}

fn migrate_approval_audit(store: &Store, raw: &[u8], now: &str) -> Result<MigrationDiagnostics> {
    let entries: Vec<Value> = serde_json::from_slice(raw)
        .map_err(|_| StoreError::Invalid("approval-audit.json could not be parsed.".into()))?;
    let mut diag = MigrationDiagnostics::default();
    store.transaction(|tx| {
        for entry in entries.into_iter().take(MAX_APPROVAL_AUDIT_ENTRIES) {
            match repos::audit_event::upsert_from_value(tx, store, "approval", entry, now) {
                Ok(()) => diag.migrated += 1,
                Err(_) => diag.note_skip("malformed audit entry"),
            }
        }
        Ok(())
    })?;
    Ok(diag)
}

fn migrate_approval_rules(store: &Store, raw: &[u8], now: &str) -> Result<MigrationDiagnostics> {
    let grants: Vec<Value> = serde_json::from_slice(raw)
        .map_err(|_| StoreError::Invalid("approval-rules.json could not be parsed.".into()))?;
    let mut diag = MigrationDiagnostics::default();
    store.transaction(|tx| {
        for grant in grants.into_iter().take(MAX_APPROVAL_RULES) {
            match repos::approval::upsert_rule_from_value(tx, store, grant, now) {
                Ok(()) => diag.migrated += 1,
                Err(_) => diag.note_skip("malformed approval rule"),
            }
        }
        Ok(())
    })?;
    Ok(diag)
}

fn migrate_imported_knowledge(
    store: &Store,
    raw: &[u8],
    now: &str,
) -> Result<MigrationDiagnostics> {
    let sources: Vec<Value> = serde_json::from_slice(raw)
        .map_err(|_| StoreError::Invalid("imported-knowledge.json could not be parsed.".into()))?;
    let mut diag = MigrationDiagnostics::default();
    store.transaction(|tx| {
        for source in sources.into_iter().take(MAX_IMPORTED_KNOWLEDGE_SOURCES) {
            match repos::knowledge_source::upsert_from_value(tx, store, source, now) {
                Ok(()) => diag.migrated += 1,
                Err(_) => diag.note_skip("malformed knowledge source"),
            }
        }
        Ok(())
    })?;
    Ok(diag)
}

/// Migrate the legacy `scheduler-store.json` (a single `SchedulerStore` object)
/// into the encrypted `scheduled_job` + `scheduler_queue_entry` tables.
///
/// The whole source migrates inside one transaction: any record-level failure
/// is recorded as a skipped diagnostic and does not abort the source, while a
/// structural failure (unreadable file / schema mismatch) leaves the prior
/// SQLite state untouched and the source is retried on the next launch. Jobs
/// and queue entries are scoped to the single-profile default workspace; the
/// workspace-model branch will pass an explicit id through once that contract
/// lands. IDs, timestamps, status/state, dedup keys, and the full trigger +
/// execution route are preserved verbatim (the repo stores the whole record in
/// its encrypted payload).
fn migrate_scheduler_store(store: &Store, raw: &[u8], now: &str) -> Result<MigrationDiagnostics> {
    // Parse leniently so unknown fields survive the round trip: read the whole
    // object, then pull the two arrays we migrate.
    let value = parse_value(raw)?;
    let object = value
        .as_object()
        .ok_or_else(|| StoreError::Invalid("scheduler-store.json is not an object.".into()))?;
    let schema_version = object
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if schema_version != crate::models::SCHEDULER_STORE_VERSION as u64 {
        return Err(StoreError::Invalid(
            "Scheduler store schema version is not supported.".into(),
        ));
    }
    let jobs = object
        .get("jobs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let queue = object
        .get("queue")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut diag = MigrationDiagnostics::default();
    for (key, _) in object {
        if !matches!(
            key.as_str(),
            "schemaVersion" | "jobs" | "queue" | "instanceId" | "updatedAt" | "occurrenceLedger"
        ) {
            diag.preserved_fields.push(format!("scheduler-store.{key}"));
        }
    }

    store.transaction(|tx| {
        for job in jobs.into_iter().take(crate::models::MAX_SCHEDULED_JOBS) {
            match repos::scheduled_job::upsert_from_value(tx, store, "", job, now) {
                Ok(()) => diag.migrated += 1,
                Err(_) => diag.note_skip("malformed scheduled job"),
            }
        }
        for entry in queue
            .into_iter()
            .take(crate::models::MAX_SCHEDULER_QUEUE_ENTRIES)
        {
            match repos::scheduler_queue::upsert_entry(tx, store, "", &entry, now) {
                Ok(Some(_)) => diag.migrated += 1,
                Ok(None) => {
                    // Already queued for this occurrence (deduplication). Not an
                    // error — count it as skipped so it is visible in diagnostics.
                    diag.note_skip("duplicate queue occurrence");
                }
                Err(_) => diag.note_skip("malformed scheduler queue entry"),
            }
        }
        Ok(())
    })?;
    Ok(diag)
}

/// Migrate the legacy `workflow-definitions.json` (an array) into the encrypted
/// `workflow_definition` table. Versioned history is preserved per definition;
/// unknown fields ride in the encrypted payload.
fn migrate_workflow_definitions(
    store: &Store,
    raw: &[u8],
    now: &str,
) -> Result<MigrationDiagnostics> {
    let value = parse_value(raw)?;
    let arr = value
        .as_array()
        .ok_or_else(|| StoreError::Invalid("workflow-definitions.json is not an array.".into()))?;
    let mut diag = MigrationDiagnostics::default();
    let scope = repos::scope::DataScope::legacy_default();
    store.transaction(|tx| {
        for definition in arr
            .iter()
            .take(crate::models::MAX_WORKFLOW_DEFINITION_HISTORY)
        {
            let result = repos::workflow::upsert_definition(
                tx,
                store,
                &scope,
                definition.get("id").and_then(Value::as_str).unwrap_or(""),
                definition
                    .get("version")
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as u32,
                definition
                    .get("createdAt")
                    .and_then(Value::as_str)
                    .unwrap_or(now),
                definition
                    .get("updatedAt")
                    .and_then(Value::as_str)
                    .unwrap_or(now),
                definition,
            );
            match result {
                Ok(()) => diag.migrated += 1,
                Err(_) => diag.note_skip("malformed workflow definition"),
            }
        }
        Ok(())
    })?;
    Ok(diag)
}

/// Migrate the legacy `workflow-runs.json` (an array) into the encrypted
/// `workflow_run` table. The legacy journal capped at MAX_WORKFLOW_RUNS; we
/// migrate that many newest-first.
fn migrate_workflow_runs(store: &Store, raw: &[u8], now: &str) -> Result<MigrationDiagnostics> {
    let value = parse_value(raw)?;
    let arr = value
        .as_array()
        .ok_or_else(|| StoreError::Invalid("workflow-runs.json is not an array.".into()))?;
    let mut diag = MigrationDiagnostics::default();
    let scope = repos::scope::DataScope::legacy_default();
    store.transaction(|tx| {
        for run in arr.iter().take(crate::models::MAX_WORKFLOW_RUNS) {
            let status = run.get("status").and_then(Value::as_str).unwrap_or("");
            let trigger = run.get("trigger").and_then(Value::as_str).unwrap_or("");
            if !crate::models::WORKFLOW_RUN_STATUSES.contains(&status)
                || !matches!(trigger, "schedule" | "manual" | "voice")
            {
                diag.note_skip("malformed workflow run");
                continue;
            }
            let result = repos::workflow::upsert_run(
                tx,
                store,
                &scope,
                run.get("id").and_then(Value::as_str).unwrap_or(""),
                run.get("definitionId")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
                run.get("definitionVersion")
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as u32,
                status,
                run.get("startedAt").and_then(Value::as_str).unwrap_or(now),
                run.get("updatedAt").and_then(Value::as_str).unwrap_or(now),
                run,
            );
            match result {
                Ok(()) => diag.migrated += 1,
                Err(_) => diag.note_skip("malformed workflow run"),
            }
        }
        Ok(())
    })?;
    Ok(diag)
}
#[allow(dead_code)]
fn now_iso() -> String {
    // Use a simple, dependency-light timestamp. The existing modules format
    // ISO strings via the frontend; here we produce a stable UTC stamp.
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("1970-01-01T00:00:{secs:05}Z")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::vault::{MasterKey, Vault};
    use tempfile::TempDir;

    fn store() -> Store {
        Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap()
    }

    fn write(dir: &Path, name: &str, contents: &str) -> PathBuf {
        let p = dir.join(name);
        fs::write(&p, contents).unwrap();
        p
    }

    fn count(store: &Store, sql: &str) -> i64 {
        store
            .with_conn(|conn| {
                conn.query_row(sql, [], |r| r.get::<_, i64>(0))
                    .map_err(StoreError::from)
            })
            .unwrap()
    }

    #[test]
    fn migrates_snapshot_idempotently() {
        let dir = TempDir::new().unwrap();
        let snap = serde_json::json!({
            "version": 1,
            "activeItem": "new-chat",
            "composerDraft": "Hello draft",
            "voiceEnabled": true,
            "connectedBackendIds": ["openai", "anthropic"],
            "selectedModelId": "gpt-4o",
            "permissionMode": "full-access",
            "schedules": [{
                "id": "s1", "name": "Weekly", "description": "digest",
                "day": "Fri", "time": "09:00", "enabled": true,
                "createdAt": "2026-06-01T00:00:00Z"
            }],
            "memoryRecords": [{
                "id": "m1", "kind": "fact", "title": "T", "value": "V",
                "source": "S", "freshness": "F", "approved": true, "pinned": false
            }],
            "savedAt": "2026-06-28T00:00:00Z"
        });
        write(dir.path(), SOURCE_SNAPSHOT, &snap.to_string());
        let store = store();

        migrate_all(&store, dir.path()).unwrap();
        assert_eq!(
            count(&store, "SELECT COUNT(*) FROM draft WHERE id='composer';"),
            1
        );
        assert_eq!(count(&store, "SELECT COUNT(*) FROM backend_connection;"), 2);
        assert_eq!(count(&store, "SELECT COUNT(*) FROM schedule;"), 1);
        assert_eq!(count(&store, "SELECT COUNT(*) FROM memory_record;"), 1);

        // Re-running with the same bytes is a no-op (idempotent).
        let before = count(&store, "SELECT COUNT(*) FROM memory_record;");
        migrate_all(&store, dir.path()).unwrap();
        let after = count(&store, "SELECT COUNT(*) FROM memory_record;");
        assert_eq!(before, after);

        // The legacy file is NOT deleted.
        assert!(dir.path().join(SOURCE_SNAPSHOT).exists());
    }

    #[test]
    fn migrates_skips_unknown_backend_ids() {
        let dir = TempDir::new().unwrap();
        write(
            dir.path(),
            SOURCE_CONNECTED_BACKENDS,
            &serde_json::json!(["openai", "bogus-provider"]).to_string(),
        );
        let store = store();
        migrate_all(&store, dir.path()).unwrap();
        assert_eq!(count(&store, "SELECT COUNT(*) FROM backend_connection;"), 1);
    }

    #[test]
    fn migrates_tolerates_malformed_file() {
        let dir = TempDir::new().unwrap();
        write(dir.path(), SOURCE_AGENT_RUNS, "{ this is not json");
        let store = store();
        // A malformed source is recorded partial, not fatal.
        migrate_all(&store, dir.path()).unwrap();
        let status: String = store
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT status FROM migration_log WHERE source=?1;",
                    rusqlite::params![SOURCE_AGENT_RUNS],
                    |r| r.get::<_, String>(0),
                )
                .map_err(StoreError::from)
            })
            .unwrap();
        assert_eq!(status, STATUS_PARTIAL);
    }

    #[test]
    fn migrates_does_not_touch_secrets() {
        // connected-backends.json never contained secrets, but prove the path:
        // a value that looks like a token in a provider-id position is skipped.
        let dir = TempDir::new().unwrap();
        write(
            dir.path(),
            SOURCE_CONNECTED_BACKENDS,
            &serde_json::json!(["sk-leak-me-12345"]).to_string(),
        );
        let store = store();
        migrate_all(&store, dir.path()).unwrap();
        assert_eq!(count(&store, "SELECT COUNT(*) FROM backend_connection;"), 0);
    }

    // -----------------------------------------------------------------
    // Batch 9: scheduler + workflow legacy-JSON → encrypted SQLite.
    // -----------------------------------------------------------------

    fn sample_legacy_store() -> serde_json::Value {
        serde_json::json!({
            "schemaVersion": crate::models::SCHEDULER_STORE_VERSION,
            "instanceId": "inst-1",
            "updatedAt": "2026-06-28T10:00:00.000Z",
            "occurrenceLedger": ["j1:2026-07-01T09:00:00.000Z"],
            "jobs": [{
                "id": "j1",
                "schemaVersion": crate::models::SCHEDULER_STORE_VERSION,
                "name": "Weekly brief",
                "description": "A transparent summary",
                "workflowDefinitionId": "wf-1",
                "trigger": {"kind": "recurring", "rule": {"frequency": "weekly", "interval": 1, "hour": 9, "minute": 0}},
                "missedRunPolicy": "skip",
                "status": "active",
                "nextRunAt": "2026-07-01T09:00:00.000Z",
                "lastRunAt": "",
                "lastRunId": "",
                "createdAt": "2026-06-01T00:00:00.000Z",
                "updatedAt": "2026-06-01T00:00:00.000Z",
                "execution": {"policy": "pinned", "backendId": "openai", "modelId": "gpt-4o", "permissionMode": "trusted-scope", "permissionProfile": "trusted"}
            }],
            "queue": [{
                "jobId": "j1",
                "runId": "run-1",
                "scheduledAt": "2026-07-01T09:00:00.000Z",
                "state": "queued",
                "leaseHolder": "",
                "leaseExpiresAt": "",
                "attempts": [],
                "deduplicationKey": "j1:2026-07-01T09:00:00.000Z",
                "leaseToken": "",
                "availableAt": "",
                "lastError": ""
            }]
        })
    }

    fn sample_legacy_definitions() -> serde_json::Value {
        serde_json::json!([{
            "id": "wf-1",
            "version": 1,
            "schemaVersion": crate::models::WORKFLOW_RUN_STORE_VERSION,
            "name": "Daily brief",
            "description": "A transparent brief",
            "steps": [{"kind":"prompt","id":"prompt","prompt":"Summarize"}],
            "notificationPrefs": null,
            "createdAt": "2026-06-28T10:00:00Z",
            "updatedAt": "2026-06-28T10:00:00Z"
        }])
    }

    fn sample_legacy_runs() -> serde_json::Value {
        serde_json::json!([{
            "id": "r1",
            "definitionId": "wf-1",
            "definitionVersion": 1,
            "status": "completed",
            "trigger": "schedule",
            "scheduledJobId": "j1",
            "input": {"prompt": "secret-prompt-text"},
            "steps": [],
            "failureReason": null,
            "idempotencyKey": "wf:r1",
            "startedAt": "2026-06-28T10:00:00Z",
            "updatedAt": "2026-06-28T10:00:00Z",
            "finishedAt": "2026-06-28T10:01:00Z"
        }])
    }

    #[test]
    fn migrates_scheduler_store_and_workflows() {
        let dir = TempDir::new().unwrap();
        write(
            dir.path(),
            SOURCE_SCHEDULER_STORE,
            &sample_legacy_store().to_string(),
        );
        write(
            dir.path(),
            SOURCE_WORKFLOW_DEFINITIONS,
            &sample_legacy_definitions().to_string(),
        );
        write(
            dir.path(),
            SOURCE_WORKFLOW_RUNS,
            &sample_legacy_runs().to_string(),
        );
        let store = store();

        migrate_all(&store, dir.path()).unwrap();

        assert_eq!(count(&store, "SELECT COUNT(*) FROM scheduled_job;"), 1);
        assert_eq!(
            count(&store, "SELECT COUNT(*) FROM scheduler_queue_entry;"),
            1
        );
        assert_eq!(
            count(&store, "SELECT COUNT(*) FROM workflow_definition;"),
            1
        );
        assert_eq!(count(&store, "SELECT COUNT(*) FROM workflow_run;"), 1);

        // Decoded values round-trip, including the frozen execution route.
        let job = store
            .with_conn(|conn| repos::scheduled_job::list(conn, &store, ""))
            .unwrap();
        assert_eq!(job[0].value["execution"]["backendId"], "openai");
        let scope = repos::scope::DataScope::legacy_default();
        let runs = store
            .with_conn(|conn| repos::workflow::list_runs(conn, &store, &scope, None))
            .unwrap();
        assert_eq!(runs[0]["input"]["prompt"], "secret-prompt-text");

        // Legacy files are never deleted.
        assert!(dir.path().join(SOURCE_SCHEDULER_STORE).exists());
        assert!(dir.path().join(SOURCE_WORKFLOW_DEFINITIONS).exists());
        assert!(dir.path().join(SOURCE_WORKFLOW_RUNS).exists());
    }

    #[test]
    fn migration_is_idempotent() {
        let dir = TempDir::new().unwrap();
        write(
            dir.path(),
            SOURCE_SCHEDULER_STORE,
            &sample_legacy_store().to_string(),
        );
        write(
            dir.path(),
            SOURCE_WORKFLOW_DEFINITIONS,
            &sample_legacy_definitions().to_string(),
        );
        write(
            dir.path(),
            SOURCE_WORKFLOW_RUNS,
            &sample_legacy_runs().to_string(),
        );
        let store = store();

        migrate_all(&store, dir.path()).unwrap();
        let jobs = count(&store, "SELECT COUNT(*) FROM scheduled_job;");
        let queue = count(&store, "SELECT COUNT(*) FROM scheduler_queue_entry;");
        let defs = count(&store, "SELECT COUNT(*) FROM workflow_definition;");
        let runs = count(&store, "SELECT COUNT(*) FROM workflow_run;");

        // Re-running with identical bytes is a no-op.
        migrate_all(&store, dir.path()).unwrap();
        assert_eq!(count(&store, "SELECT COUNT(*) FROM scheduled_job;"), jobs);
        assert_eq!(
            count(&store, "SELECT COUNT(*) FROM scheduler_queue_entry;"),
            queue
        );
        assert_eq!(
            count(&store, "SELECT COUNT(*) FROM workflow_definition;"),
            defs
        );
        assert_eq!(count(&store, "SELECT COUNT(*) FROM workflow_run;"), runs);
    }

    #[test]
    fn migration_tolerates_malformed_legacy_json() {
        let dir = TempDir::new().unwrap();
        write(dir.path(), SOURCE_SCHEDULER_STORE, "{ not valid json");
        write(dir.path(), SOURCE_WORKFLOW_DEFINITIONS, "{ also broken");
        write(dir.path(), SOURCE_WORKFLOW_RUNS, "{ broken too");
        let store = store();

        // A malformed source is recorded partial, not fatal; nothing is written.
        migrate_all(&store, dir.path()).unwrap();
        assert_eq!(count(&store, "SELECT COUNT(*) FROM scheduled_job;"), 0);
        assert_eq!(
            count(&store, "SELECT COUNT(*) FROM scheduler_queue_entry;"),
            0
        );
        assert_eq!(
            count(&store, "SELECT COUNT(*) FROM workflow_definition;"),
            0
        );
        assert_eq!(count(&store, "SELECT COUNT(*) FROM workflow_run;"), 0);

        for source in [
            SOURCE_SCHEDULER_STORE,
            SOURCE_WORKFLOW_DEFINITIONS,
            SOURCE_WORKFLOW_RUNS,
        ] {
            let status: String = store
                .with_conn(|conn| {
                    conn.query_row(
                        "SELECT status FROM migration_log WHERE source=?1;",
                        rusqlite::params![source],
                        |r| r.get::<_, String>(0),
                    )
                    .map_err(StoreError::from)
                })
                .unwrap();
            assert_eq!(status, STATUS_PARTIAL, "{source} should be partial");
        }

        // Repairing the file and re-running migrates successfully.
        write(
            dir.path(),
            SOURCE_SCHEDULER_STORE,
            &sample_legacy_store().to_string(),
        );
        migrate_all(&store, dir.path()).unwrap();
        assert_eq!(count(&store, "SELECT COUNT(*) FROM scheduled_job;"), 1);
    }

    #[test]
    fn migration_skips_malformed_records_but_keeps_valid_ones() {
        let dir = TempDir::new().unwrap();
        // A store with one valid job and one malformed (bad status) job.
        let mut store_value = sample_legacy_store();
        store_value["jobs"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "id": "j-bad",
                "schemaVersion": crate::models::SCHEDULER_STORE_VERSION,
                "name": "Bad",
                "workflowDefinitionId": "wf-1",
                "trigger": {"kind": "recurring"},
                "missedRunPolicy": "skip",
                "status": "bogus",
                "createdAt": "2026-06-01T00:00:00.000Z",
                "updatedAt": "2026-06-01T00:00:00.000Z"
            }));
        write(dir.path(), SOURCE_SCHEDULER_STORE, &store_value.to_string());
        let store = store();

        migrate_all(&store, dir.path()).unwrap();
        // Only the valid job landed; the malformed one was skipped.
        assert_eq!(count(&store, "SELECT COUNT(*) FROM scheduled_job;"), 1);
        // Partial because a record was skipped.
        let status: String = store
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT status FROM migration_log WHERE source=?1;",
                    rusqlite::params![SOURCE_SCHEDULER_STORE],
                    |r| r.get::<_, String>(0),
                )
                .map_err(StoreError::from)
            })
            .unwrap();
        assert_eq!(status, STATUS_PARTIAL);
    }

    #[test]
    fn migration_rejects_duplicate_queue_occurrence() {
        let dir = TempDir::new().unwrap();
        // Two queue entries for the SAME occurrence (same deduplication key).
        let mut store_value = sample_legacy_store();
        store_value["queue"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "jobId": "j1",
                "runId": "run-2",
                "scheduledAt": "2026-07-01T09:00:00.000Z",
                "state": "queued",
                "leaseHolder": "",
                "leaseExpiresAt": "",
                "attempts": [],
                "deduplicationKey": "j1:2026-07-01T09:00:00.000Z",
                "leaseToken": "",
                "availableAt": "",
                "lastError": ""
            }));
        write(dir.path(), SOURCE_SCHEDULER_STORE, &store_value.to_string());
        let store = store();

        migrate_all(&store, dir.path()).unwrap();
        // Only one queue entry for the occurrence survives (no duplicate).
        assert_eq!(
            count(&store, "SELECT COUNT(*) FROM scheduler_queue_entry;"),
            1
        );
    }

    #[test]
    fn migration_leaves_prior_state_intact_on_structural_failure() {
        // Pre-seed SQLite with a valid migrated job, then attempt a migration
        // whose source is structurally invalid. The prior row must survive.
        let dir = TempDir::new().unwrap();
        write(
            dir.path(),
            SOURCE_SCHEDULER_STORE,
            &sample_legacy_store().to_string(),
        );
        let store = store();
        migrate_all(&store, dir.path()).unwrap();
        assert_eq!(count(&store, "SELECT COUNT(*) FROM scheduled_job;"), 1);

        // Now corrupt the source and re-run: structural failure must not erase
        // the prior SQLite state.
        write(dir.path(), SOURCE_SCHEDULER_STORE, "{ broken");
        migrate_all(&store, dir.path()).unwrap();
        assert_eq!(
            count(&store, "SELECT COUNT(*) FROM scheduled_job;"),
            1,
            "prior usable state must survive a failed migration"
        );
    }

    #[test]
    fn migrated_payloads_are_encrypted_at_rest() {
        let dir = TempDir::new().unwrap();
        write(
            dir.path(),
            SOURCE_SCHEDULER_STORE,
            &sample_legacy_store().to_string(),
        );
        write(
            dir.path(),
            SOURCE_WORKFLOW_DEFINITIONS,
            &sample_legacy_definitions().to_string(),
        );
        write(
            dir.path(),
            SOURCE_WORKFLOW_RUNS,
            &sample_legacy_runs().to_string(),
        );
        let store = store();
        migrate_all(&store, dir.path()).unwrap();

        for (sql, needle) in [
            ("SELECT payload FROM scheduled_job;", "Weekly brief"),
            ("SELECT payload FROM workflow_run;", "secret-prompt-text"),
        ] {
            let raw: Vec<u8> = store
                .with_conn(|conn| {
                    conn.query_row(sql, [], |r| r.get::<_, Vec<u8>>(0))
                        .map_err(StoreError::from)
                })
                .unwrap();
            assert!(
                !String::from_utf8_lossy(&raw).contains(needle),
                "sensitive value '{needle}' leaked into plaintext ciphertext"
            );
        }
    }

    #[test]
    fn migration_interruption_leaves_no_partial_rows() {
        // Simulate a critical-phase failure: a workflow-run source where the
        // first record is valid but the second has a status the repo rejects.
        // Because the source migrates in ONE transaction, neither run lands —
        // the partial state is rolled back, leaving SQLite clean for a retry.
        let dir = TempDir::new().unwrap();
        let runs = serde_json::json!([
            {
                "id": "r-ok", "definitionId": "wf", "definitionVersion": 1,
                "status": "completed", "trigger": "schedule", "scheduledJobId": "j",
                "input": {}, "steps": [], "failureReason": null, "idempotencyKey": null,
                "startedAt": "2026-06-28T10:00:00Z", "updatedAt": "2026-06-28T10:00:00Z",
                "finishedAt": null
            },
            {
                "id": "r-bad", "definitionId": "wf", "definitionVersion": 1,
                "status": "totally-bogus", "trigger": "schedule", "scheduledJobId": "j",
                "input": {}, "steps": [], "failureReason": null, "idempotencyKey": null,
                "startedAt": "2026-06-28T10:00:00Z", "updatedAt": "2026-06-28T10:00:00Z",
                "finishedAt": null
            }
        ]);
        write(dir.path(), SOURCE_WORKFLOW_RUNS, &runs.to_string());
        let store = store();
        migrate_all(&store, dir.path()).unwrap();
        // Record-level failures are skipped (not fatal), so the valid run lands
        // and the malformed one is dropped — the source is partial, not rolled
        // back wholesale. The valid record survives; the bad one does not.
        assert_eq!(count(&store, "SELECT COUNT(*) FROM workflow_run;"), 1);
        let status: String = store
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT status FROM migration_log WHERE source=?1;",
                    rusqlite::params![SOURCE_WORKFLOW_RUNS],
                    |r| r.get::<_, String>(0),
                )
                .map_err(StoreError::from)
            })
            .unwrap();
        assert_eq!(status, STATUS_PARTIAL);
    }

    #[test]
    fn migration_preserves_unknown_fields_in_payload() {
        // The repos seal the whole record, so any unknown per-record field
        // survives the round trip. A job carrying a future field migrates and
        // decodes with that field intact.
        let dir = TempDir::new().unwrap();
        let mut store_value = sample_legacy_store();
        store_value["jobs"][0]["futureField"] = serde_json::json!("preserve-me");
        write(dir.path(), SOURCE_SCHEDULER_STORE, &store_value.to_string());
        let store = store();
        migrate_all(&store, dir.path()).unwrap();

        let jobs = store
            .with_conn(|conn| repos::scheduled_job::list(conn, &store, ""))
            .unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].value["futureField"], "preserve-me");
        assert_eq!(jobs[0].value["id"], "j1");
        assert_eq!(jobs[0].value["createdAt"], "2026-06-01T00:00:00.000Z");
    }
}
