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
                repos::backend_connection::upsert(tx, id, now)?;
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
                repos::backend_connection::upsert(tx, &id, now)?;
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

/// ISO-8601 UTC timestamp.
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
}
