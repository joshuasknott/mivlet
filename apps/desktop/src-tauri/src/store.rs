//! Core durable encrypted store: connection management, pragmas, transactions,
//! integrity checks, and row-bound encryption helpers.
//!
//! See `docs/superpowers/specs/2026-06-28-encrypted-storage-design.md`.
//!
//! A [`Store`] owns a single SQLite connection (guarded by a mutex; WAL allows
//! concurrent readers) and a [`Vault`] (the AEAD primitive). Repositories
//! ([`repos`]) borrow a `&Store` and execute parameterized, bounded queries.
//! All multi-record writes run inside a [`Store::transaction`].

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use rusqlite::{Connection, OptionalExtension};

use crate::store::schema::{CURRENT_SCHEMA_VERSION, SCHEMA_V1};
use crate::store::vault::{Sealed, Vault};

pub mod keys;
pub mod migrations;
#[allow(dead_code)]
pub mod repos;
pub mod schema;
pub mod vault;

/// Filename of the durable database inside the Tauri app-data dir.
pub const DB_FILENAME: &str = "fable-vault.db";
static GLOBAL_STORE: OnceLock<Store> = OnceLock::new();

/// Errors surfaced by store operations. Mapped to user-facing strings at the
/// command boundary; never carries secret material.
#[derive(Debug)]
pub enum StoreError {
    /// SQLite returned an error.
    Sqlite(String),
    /// Encryption/decryption failure (wrong key, corruption, tamper).
    Vault,
    /// The database failed its integrity check.
    Corrupt(String),
    /// A required table or row was not found.
    /// A record's plaintext failed domain validation (bounds, enums).
    Invalid(String),
}

impl From<rusqlite::Error> for StoreError {
    fn from(err: rusqlite::Error) -> Self {
        StoreError::Sqlite(err.to_string())
    }
}

impl From<vault::VaultError> for StoreError {
    fn from(err: vault::VaultError) -> Self {
        let _ = err;
        StoreError::Vault
    }
}

/// User-facing rendering of store errors. Never includes secret material —
/// `VaultError` is opaque and `Sqlite` carries only SQLite's own message.
impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Sqlite(msg) => {
                write!(f, "Fable's local database reported an error: {msg}.")
            }
            StoreError::Vault => {
                write!(
                    f,
                    "Fable could not decrypt local data: the encryption key may be missing, \
                     wrong, or the data is corrupted."
                )
            }
            StoreError::Corrupt(msg) => write!(f, "{msg}"),
            StoreError::Invalid(msg) => write!(f, "{msg}"),
        }
    }
}

/// Result alias for store operations.
pub type Result<T> = std::result::Result<T, StoreError>;

/// The durable encrypted store. Cheap to share behind an `Arc`.
pub struct Store {
    conn: Mutex<Connection>,
    vault: Vault,
}

impl Store {
    /// Open (or create) the store at `path` with the given vault key.
    ///
    /// Applies connection pragmas, runs `PRAGMA integrity_check`, applies the
    /// schema, and runs pending migrations — all before the store is usable.
    /// On any failure (corruption, failed migration), returns an error and the
    /// caller must surface recovery guidance (see [`recovery`]).
    pub fn open(path: &Path, vault: Vault) -> Result<Self> {
        let conn = Connection::open(path).map_err(|e| StoreError::Sqlite(e.to_string()))?;
        Self::configure_pragmas(&conn)?;
        // Fail closed on structural corruption before any data access.
        Self::verify_integrity(&conn)?;
        Self::apply_schema(&conn)?;
        Self::run_migrations(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
            vault,
        })
    }

    /// Open an in-memory store (tests + repository unit tests). No file.
    #[cfg(test)]
    pub fn open_in_memory(vault: Vault) -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        Self::configure_pragmas(&conn)?;
        Self::apply_schema(&conn)?;
        Self::run_migrations(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
            vault,
        })
    }

    fn configure_pragmas(conn: &Connection) -> Result<()> {
        // foreign_keys: enforce referential integrity + cascade deletes.
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        // WAL: concurrent readers, no writer starvation, crash-safe journal.
        conn.execute_batch("PRAGMA journal_mode = WAL;")?;
        // NORMAL: safe under WAL, avoids the perf cost of FULL fsyncs.
        conn.execute_batch("PRAGMA synchronous = NORMAL;")?;
        // Bounded busy timeout so contended writes wait rather than error.
        conn.execute_batch("PRAGMA busy_timeout = 5000;")?;
        Ok(())
    }

    /// Run `PRAGMA integrity_check`; fail closed on anything other than "ok".
    pub fn verify_integrity(conn: &Connection) -> Result<()> {
        let ok: String = conn.query_row("PRAGMA integrity_check;", [], |row| row.get(0))?;
        if ok == "ok" {
            Ok(())
        } else {
            Err(StoreError::Corrupt(format!(
                "Fable's local database failed its integrity check: {ok}."
            )))
        }
    }

    fn apply_schema(conn: &Connection) -> Result<()> {
        conn.execute_batch(SCHEMA_V1)?;
        Ok(())
    }

    /// Run pending schema/data migrations inside a transaction.
    fn run_migrations(conn: &Connection) -> Result<()> {
        let tx = conn.unchecked_transaction()?;
        let current = read_schema_version(&tx)?;
        if current > CURRENT_SCHEMA_VERSION {
            // A newer schema than this binary understands. Fail closed rather
            // than downgrade-silently.
            return Err(StoreError::Invalid(format!(
                "The local database schema (v{current}) is newer than this version of Fable supports (v{CURRENT_SCHEMA_VERSION})."
            )));
        }
        migrations::apply(&tx, current, CURRENT_SCHEMA_VERSION)?;
        write_schema_version(&tx, CURRENT_SCHEMA_VERSION)?;
        tx.commit()?;
        Ok(())
    }

    /// Run `f` against the raw connection under the lock (for integrity checks,
    /// pragmas, and ad-hoc reads).
    pub fn with_conn<R>(&self, f: impl FnOnce(&Connection) -> Result<R>) -> Result<R> {
        let conn = self.conn.lock().expect("store connection mutex poisoned");
        f(&conn)
    }

    /// Run `f` inside a SQLite transaction. All multi-record writes use this.
    /// The transaction commits iff `f` returns `Ok`; a `Err` rolls back.
    pub fn transaction<R>(
        &self,
        f: impl FnOnce(&rusqlite::Transaction<'_>) -> Result<R>,
    ) -> Result<R> {
        let mut conn = self.conn.lock().expect("store connection mutex poisoned");
        let tx = conn.transaction().map_err(StoreError::from)?;
        let out = f(&tx)?;
        tx.commit().map_err(StoreError::from)?;
        Ok(out)
    }

    /// Borrow the vault for seal/open operations.
    /// Encrypt `plaintext` JSON bytes bound to a row identity `aad`
    /// (`table:id`). Used by repositories before INSERT/UPDATE.
    pub fn seal_payload(&self, plaintext: &[u8], aad: &str) -> Result<Sealed> {
        Ok(self.vault.seal(plaintext, aad.as_bytes())?)
    }

    /// Decrypt a sealed payload, re-checking its row-binding AAD. Any failure is
    /// a corruption/tamper/wrong-key signal — repositories propagate it and the
    /// command layer fails closed.
    pub fn open_payload(&self, sealed: &Sealed, aad: &str) -> Result<Vec<u8>> {
        Ok(self.vault.open(sealed, aad.as_bytes())?)
    }

    /// Whether a database file already exists at `path` (used to detect
    /// "missing key over an existing vault" before key resolution).
    pub fn database_exists(path: &Path) -> bool {
        path.exists()
    }
}

/// Initialize the production vault once during Tauri startup. Existing vaults
/// never receive a replacement key: a missing key over an existing database
/// fails closed with recovery guidance.
pub fn initialize(app_data_dir: &Path) -> std::result::Result<(), String> {
    std::fs::create_dir_all(app_data_dir)
        .map_err(|_| "Fable could not prepare the local data folder.".to_string())?;
    let db_path = app_data_dir.join(DB_FILENAME);
    let key_store = keys::NativeKeyStore::new()?;
    let key = match keys::resolve_for_database(&key_store, Store::database_exists(&db_path))? {
        keys::KeyResolution::Existing(key) | keys::KeyResolution::FreshlyCreated(key) => key,
    };
    let vault = Vault::new(&key).map_err(|_| "Fable could not initialize local encryption.")?;
    let store = Store::open(&db_path, vault).map_err(|error| error.to_string())?;
    migrations::migrate_all(&store, app_data_dir).map_err(|error| error.to_string())?;
    seed_legacy_documents(&store, app_data_dir)?;
    migrate_legacy_workflows(&store, app_data_dir)?;
    GLOBAL_STORE
        .set(store)
        .map_err(|_| "Fable's encrypted store was initialized twice.".to_string())
}

fn document_key(path: &Path) -> std::result::Result<String, String> {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(|name| format!("document:{name}"))
        .ok_or_else(|| "Fable could not identify the local document.".to_string())
}

fn timestamp() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

fn seed_legacy_documents(store: &Store, app_data_dir: &Path) -> std::result::Result<(), String> {
    let scope = repos::scope::DataScope::legacy_default();
    const DOCUMENTS: &[&str] = &[
        "runtime-snapshot.json",
        "agent-runs.json",
        "approval-audit.json",
        "approval-rules.json",
        "connector-connections.json",
        "connected-backends.json",
        "memory-state.json",
        "imported-knowledge.json",
        // The scheduler store, workflow definitions, and workflow runs are
        // migrated into dedicated encrypted tables by `migrations::legacy`; do
        // NOT seed them as opaque documents — their typed rows are the source of
        // truth once migration has run.
    ];
    for name in DOCUMENTS {
        let path = app_data_dir.join(name);
        if !path.exists() {
            continue;
        }
        let key = document_key(&path)?;
        let exists = store
            .with_conn(|conn| repos::preferences::get_scoped(conn, store, &scope, &key))
            .map_err(|error| error.to_string())?
            .is_some();
        if exists {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
            continue;
        };
        store
            .transaction(|tx| {
                repos::preferences::upsert_scoped(tx, store, &scope, &key, &value, &timestamp())
            })
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Borrow the process-global encrypted store when initialized, or `None`. This
/// is the production-path accessor used by execution boundaries that record
/// audit through an explicit `&Store` (via the testable recorder seam); it
/// returns `None` in the unit-test path that does not bring up Tauri.
pub fn try_global() -> Option<&'static Store> {
    GLOBAL_STORE.get()
}

/// Run `f` against the global encrypted store when it is initialized. Returns
/// `Ok(None)` only when the global store is not initialized (the unit-test path
/// that does not bring up Tauri); command layers translate `None` into an
/// explicit error. This is the typed-repo entrypoint used by domains that own
/// dedicated tables (e.g. the connector cache), complementing the document
/// helpers below.
pub fn with_store<R>(
    f: impl FnOnce(&Store) -> Result<R>,
) -> std::result::Result<Option<R>, String> {
    let Some(store) = GLOBAL_STORE.get() else {
        return Ok(None);
    };
    f(store).map(Some).map_err(|error| error.to_string())
}

/// Read a production document from encrypted SQLite. `None` means the global
/// store is not initialized (unit-test path) or the document is absent.
pub fn read_document<T: serde::de::DeserializeOwned>(
    path: &Path,
) -> std::result::Result<Option<T>, String> {
    read_workspace_document(path, &repos::scope::DataScope::legacy_default())
}

fn migrate_legacy_workflows(store: &Store, app_data_dir: &Path) -> std::result::Result<(), String> {
    let scope = repos::scope::DataScope::legacy_default();
    let definitions_path = app_data_dir.join("workflow-definitions.json");
    if let Ok(bytes) = std::fs::read(&definitions_path) {
        if let Ok(values) = serde_json::from_slice::<Vec<serde_json::Value>>(&bytes) {
            store
                .transaction(|tx| {
                    for value in values {
                        let Some(id) = value.get("id").and_then(serde_json::Value::as_str) else {
                            continue;
                        };
                        let Some(version) =
                            value.get("version").and_then(serde_json::Value::as_u64)
                        else {
                            continue;
                        };
                        let created_at = value
                            .get("createdAt")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("1970-01-01T00:00:00Z");
                        let updated_at = value
                            .get("updatedAt")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or(created_at);
                        repos::workflow::upsert_definition(
                            tx,
                            store,
                            &scope,
                            id,
                            version as u32,
                            created_at,
                            updated_at,
                            &value,
                        )?;
                    }
                    Ok(())
                })
                .map_err(|error| error.to_string())?;
        }
    }
    let runs_path = app_data_dir.join("workflow-runs.json");
    if let Ok(bytes) = std::fs::read(&runs_path) {
        if let Ok(values) = serde_json::from_slice::<Vec<serde_json::Value>>(&bytes) {
            store
                .transaction(|tx| {
                    for value in values {
                        let Some(id) = value.get("id").and_then(serde_json::Value::as_str) else {
                            continue;
                        };
                        let Some(definition_id) = value
                            .get("definitionId")
                            .and_then(serde_json::Value::as_str)
                        else {
                            continue;
                        };
                        let Some(definition_version) = value
                            .get("definitionVersion")
                            .and_then(serde_json::Value::as_u64)
                        else {
                            continue;
                        };
                        let status = value
                            .get("status")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("failed");
                        let started_at = value
                            .get("startedAt")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("1970-01-01T00:00:00Z");
                        let updated_at = value
                            .get("updatedAt")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or(started_at);
                        repos::workflow::upsert_run(
                            tx,
                            store,
                            &scope,
                            id,
                            definition_id,
                            definition_version as u32,
                            status,
                            started_at,
                            updated_at,
                            &value,
                        )?;
                    }
                    Ok(())
                })
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

pub fn read_workspace_document<T: serde::de::DeserializeOwned>(
    path: &Path,
    scope: &repos::scope::DataScope,
) -> std::result::Result<Option<T>, String> {
    let Some(store) = GLOBAL_STORE.get() else {
        return Ok(None);
    };
    let key = document_key(path)?;
    let value = store
        .with_conn(|conn| repos::preferences::get_scoped(conn, store, scope, &key))
        .map_err(|error| error.to_string())?;
    value
        .map(serde_json::from_value)
        .transpose()
        .map_err(|_| "Fable could not decode an encrypted local document.".to_string())
}

/// Write a production document to encrypted SQLite. Returns `false` only when
/// the global store is not initialized, allowing isolated path-based tests to
/// retain their temporary-file fixtures.
pub fn write_document<T: serde::Serialize>(
    path: &Path,
    value: &T,
) -> std::result::Result<bool, String> {
    write_workspace_document(path, &repos::scope::DataScope::legacy_default(), value)
}

pub fn write_workspace_document<T: serde::Serialize>(
    path: &Path,
    scope: &repos::scope::DataScope,
    value: &T,
) -> std::result::Result<bool, String> {
    let Some(store) = GLOBAL_STORE.get() else {
        return Ok(false);
    };
    let key = document_key(path)?;
    let value = serde_json::to_value(value)
        .map_err(|_| "Fable could not encode an encrypted local document.".to_string())?;
    store
        .transaction(|tx| {
            repos::preferences::upsert_scoped(tx, store, scope, &key, &value, &timestamp())
        })
        .map_err(|error| error.to_string())?;
    Ok(true)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedStoreStatus {
    ready: bool,
    schema_version: u32,
    database_file: &'static str,
}

#[tauri::command]
pub fn encrypted_store_status() -> std::result::Result<EncryptedStoreStatus, String> {
    let store = GLOBAL_STORE
        .get()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let version = store
        .with_conn(read_schema_version)
        .map_err(|error| error.to_string())?;
    Ok(EncryptedStoreStatus {
        ready: true,
        schema_version: version,
        database_file: DB_FILENAME,
    })
}

/// Export encrypted-store documents as credential-free JSON. OAuth/API keys
/// never enter the database and therefore cannot enter this export.
#[tauri::command]
pub fn export_local_data(workspace_id: Option<String>) -> std::result::Result<String, String> {
    let store = GLOBAL_STORE
        .get()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let scope = repos::scope::DataScope::workspace(
        workspace_id.unwrap_or_else(|| repos::scope::DEFAULT_WORKSPACE_ID.to_string()),
    )
    .map_err(|error| error.to_string())?;
    let keys = store
        .with_conn(|conn| repos::preferences::keys_scoped(conn, &scope))
        .map_err(|error| error.to_string())?;
    let mut documents = serde_json::Map::new();
    for key in keys.into_iter().filter(|key| key.starts_with("document:")) {
        if let Some(value) = store
            .with_conn(|conn| repos::preferences::get_scoped(conn, store, &scope, &key))
            .map_err(|error| error.to_string())?
        {
            documents.insert(key.trim_start_matches("document:").to_string(), value);
        }
    }
    serde_json::to_string_pretty(&serde_json::json!({
        "version": CURRENT_SCHEMA_VERSION,
        "workspaceId": scope.workspace_id(),
        "credentialsIncluded": false,
        "documents": documents,
    }))
    .map_err(|_| "Fable could not encode the local-data export.".to_string())
}

/// Create a consistent SQLite backup. The destination must not already exist,
/// preventing an accidental overwrite of the user's previous recovery point.
#[tauri::command]
pub fn backup_local_data(destination: String) -> std::result::Result<(), String> {
    let target = PathBuf::from(destination);
    if target.exists() {
        return Err("Fable will not overwrite an existing backup.".to_string());
    }
    let store = GLOBAL_STORE
        .get()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .with_conn(|conn| {
            conn.execute("VACUUM INTO ?1", [target.to_string_lossy().as_ref()])?;
            Ok(())
        })
        .map_err(|error| error.to_string())
}

/// Delete local database content after an exact destructive confirmation. The
/// vault key and provider credentials are separate lifecycles and are retained.
#[tauri::command]
pub fn delete_local_data(
    app: tauri::AppHandle,
    confirmation: String,
) -> std::result::Result<(), String> {
    if confirmation != "delete local data" {
        return Err("Type \"delete local data\" to confirm local deletion.".to_string());
    }
    let store = GLOBAL_STORE
        .get()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            tx.execute_batch(
                "DELETE FROM message;
                 DELETE FROM tool_call;
                 DELETE FROM approval;
                 DELETE FROM artifact;
                 DELETE FROM run_state;
                 DELETE FROM run;
                 DELETE FROM thread;
                 DELETE FROM project;
                 DELETE FROM audit_event;
                 DELETE FROM connector_account;
                 DELETE FROM backend_connection;
                 DELETE FROM knowledge_source;
                 DELETE FROM memory_record;
                 DELETE FROM schedule;
                  DELETE FROM scheduled_job;
                  DELETE FROM scheduler_queue_entry;
                  DELETE FROM workflow_definition;
                  DELETE FROM workflow_run;
                 DELETE FROM model_config;
                 DELETE FROM draft;
                 DELETE FROM connector_cache;
                 DELETE FROM connector_cache_settings;
                 DELETE FROM preferences;
                 DELETE FROM profile;
                 DELETE FROM migration_log;
                 DELETE FROM workspace;
                 INSERT INTO workspace (id, name, created_at, updated_at)
                   VALUES ('default', 'My Workspace', '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z');",
            )?;
            Ok(())
        })
        .map_err(|error| error.to_string())?;
    use tauri::Manager as _;
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|_| "Fable could not resolve the app data folder.".to_string())?;
    for name in [
        "runtime-snapshot.json",
        "agent-runs.json",
        "approval-audit.json",
        "approval-rules.json",
        "connector-approval-records.json",
        "execution-approvals.json",
        "connector-connections.json",
        "connected-backends.json",
        "memory-state.json",
        "imported-knowledge.json",
        "scheduler-store.json",
        "workflow-definitions.json",
        "workflow-runs.json",
    ] {
        let _ = std::fs::remove_file(app_data.join(name));
    }
    Ok(())
}

/// Read the persisted schema version, or 0 if the meta row is absent.
pub fn read_schema_version(conn: &Connection) -> Result<u32> {
    let row: Option<String> = conn
        .query_row(
            "SELECT value FROM schema_meta WHERE key = 'schema_version';",
            [],
            |row| row.get(0),
        )
        .optional()?;
    Ok(row.and_then(|v| v.parse().ok()).unwrap_or(0))
}

/// Write the schema version meta row.
pub fn write_schema_version(conn: &Connection, version: u32) -> Result<()> {
    conn.execute(
        "INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
        [version.to_string()],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tempfile::TempDir;

    fn vault() -> Vault {
        Vault::new(&vault::MasterKey::generate().unwrap()).unwrap()
    }

    #[test]
    fn opens_fresh_database_and_records_schema_version() {
        let dir = TempDir::new().unwrap();
        let db = dir.path().join(DB_FILENAME);
        let store = Store::open(&db, vault()).unwrap();
        // schema_version recorded.
        let v: String = store
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT value FROM schema_meta WHERE key='schema_version';",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .map_err(StoreError::from)
            })
            .unwrap();
        assert_eq!(v.parse::<u32>().unwrap(), CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn reopen_is_idempotent_and_keeps_data() {
        let dir = TempDir::new().unwrap();
        let db = dir.path().join(DB_FILENAME);
        let v = vault();
        {
            let store = Store::open(&db, v.clone()).unwrap();
            store
                .transaction(|tx| {
                    tx.execute(
                        "INSERT INTO draft (id, updated_at, payload, payload_nonce) VALUES ('d1','t',X'00',X'00')",
                        [],
                    )
                    .map_err(StoreError::from)
                })
                .unwrap();
        }
        // Reopen with the same key: data survives, schema not re-bumped.
        let store = Store::open(&db, v).unwrap();
        let count: i64 = store
            .with_conn(|conn| {
                conn.query_row("SELECT COUNT(*) FROM draft WHERE id='d1';", [], |row| {
                    row.get(0)
                })
                .map_err(StoreError::from)
            })
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn integrity_check_failure_is_detected() {
        // A well-formed in-memory DB passes.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA_V1).unwrap();
        Store::verify_integrity(&conn).unwrap();
    }

    #[test]
    fn rejects_newer_schema_version() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA_V1).unwrap();
        write_schema_version(&conn, CURRENT_SCHEMA_VERSION + 5).unwrap();
        let err = Store::run_migrations(&conn).unwrap_err();
        assert!(matches!(err, StoreError::Invalid(_)));
    }

    #[test]
    fn payload_round_trips_through_store() {
        let store = Store::open_in_memory(vault()).unwrap();
        let sealed = store
            .seal_payload(b"{\"draft\":\"hi\"}", "draft:d1")
            .unwrap();
        let pt = store.open_payload(&sealed, "draft:d1").unwrap();
        assert_eq!(pt, b"{\"draft\":\"hi\"}");
    }

    #[test]
    fn payload_aad_mismatch_fails_closed() {
        let store = Store::open_in_memory(vault()).unwrap();
        let sealed = store.seal_payload(b"secret", "draft:d1").unwrap();
        assert!(store.open_payload(&sealed, "draft:d2").is_err());
    }

    #[test]
    fn failed_transaction_rolls_back_without_partial_rows() {
        let store = Store::open_in_memory(vault()).unwrap();
        let result: Result<()> = store.transaction(|tx| {
            tx.execute(
                "INSERT INTO backend_connection(provider_id, connected_at, updated_at) VALUES('openai','t','t')",
                [],
            )?;
            Err(StoreError::Invalid("force rollback".into()))
        });
        assert!(result.is_err());
        let count: i64 = store
            .with_conn(|conn| {
                conn.query_row("SELECT COUNT(*) FROM backend_connection", [], |row| {
                    row.get(0)
                })
                .map_err(StoreError::from)
            })
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn corrupted_database_file_fails_to_open() {
        let dir = TempDir::new().unwrap();
        let db = dir.path().join(DB_FILENAME);
        std::fs::write(&db, b"not a sqlite database").unwrap();
        assert!(Store::open(&db, vault()).is_err());
    }

    #[test]
    fn concurrent_writes_are_serialized_and_durable() {
        let store = Arc::new(Store::open_in_memory(vault()).unwrap());
        let mut workers = Vec::new();
        for index in 0..8 {
            let store = Arc::clone(&store);
            workers.push(std::thread::spawn(move || {
                store
                    .transaction(|tx| {
                        repos::preferences::upsert(
                            tx,
                            &store,
                            &format!("worker-{index}"),
                            &serde_json::json!({ "index": index }),
                            "t",
                        )
                    })
                    .unwrap();
            }));
        }
        for worker in workers {
            worker.join().unwrap();
        }
        let count: i64 = store
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM preferences WHERE key LIKE 'worker-%'",
                    [],
                    |row| row.get(0),
                )
                .map_err(StoreError::from)
            })
            .unwrap();
        assert_eq!(count, 8);
    }

    #[test]
    fn large_encrypted_record_round_trips() {
        let store = Store::open_in_memory(vault()).unwrap();
        let value = serde_json::json!({ "content": "x".repeat(2 * 1024 * 1024) });
        store
            .transaction(|tx| repos::preferences::upsert(tx, &store, "large", &value, "t"))
            .unwrap();
        let read = store
            .with_conn(|conn| repos::preferences::get(conn, &store, "large"))
            .unwrap()
            .unwrap();
        assert_eq!(read, value);
    }

    #[test]
    fn deleting_parent_cascades_referential_children() {
        let store = Store::open_in_memory(vault()).unwrap();
        let sealed = store.seal_payload(b"{}", "project:p").unwrap();
        let thread = store.seal_payload(b"{}", "thread:t").unwrap();
        store
            .transaction(|tx| {
                tx.execute(
                    "INSERT INTO project(id,workspace_id,title_fingerprint,created_at,updated_at,payload,payload_nonce) VALUES('p','default','f','t','t',?1,?2)",
                    rusqlite::params![sealed.ciphertext, sealed.nonce],
                )?;
                tx.execute(
                    "INSERT INTO thread(id,project_id,created_at,updated_at,payload,payload_nonce) VALUES('t','p','t','t',?1,?2)",
                    rusqlite::params![thread.ciphertext, thread.nonce],
                )?;
                tx.execute("DELETE FROM project WHERE id='p'", [])?;
                Ok(())
            })
            .unwrap();
        let count: i64 = store
            .with_conn(|conn| {
                conn.query_row("SELECT COUNT(*) FROM thread", [], |row| row.get(0))
                    .map_err(StoreError::from)
            })
            .unwrap();
        assert_eq!(count, 0);
    }
}
