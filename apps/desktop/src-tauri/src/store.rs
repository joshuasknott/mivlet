//! Core durable encrypted store: connection management, pragmas, transactions,
//! integrity checks, and row-bound encryption helpers.
//!
//! See `docs/architecture/encrypted-storage.md`.
//!
//! A [`Store`] owns a single SQLite connection (guarded by a mutex; WAL allows
//! concurrent readers) and a [`Vault`] (the AEAD primitive). Repositories
//! ([`repos`]) borrow a `&Store` and execute parameterized, bounded queries.
//! All multi-record writes run inside a [`Store::transaction`].

use std::path::Path;
use std::sync::{Mutex, OnceLock};

use rusqlite::{Connection, OptionalExtension};

use crate::store::schema::{CURRENT_SCHEMA_VERSION, SCHEMA_V1};
use crate::store::vault::{Sealed, Vault};

mod backup;
mod documents;
pub mod keys;
pub mod migrations;
#[allow(dead_code)]
pub mod repos;
pub mod schema;
pub mod vault;

#[cfg(test)]
mod tests;

use backup::{apply_pending_restore, rollback_applied_restore};
#[cfg(test)]
use backup::{
    delete_local_compatibility_files, delete_local_store_content, validate_backup_candidate,
    write_backup_marker,
};
pub use backup::{LocalBackupReceipt, LocalDataDeletionReceipt, LocalRestorePreparation};
use documents::scoped_document_location;
pub(crate) use documents::{
    private_document_key_prefix, private_document_location, read_document_in_transaction,
    write_document_in_transaction,
};
pub use documents::{
    read_document, read_private_workspace_document, read_workspace_document, try_global,
    update_document, update_private_workspace_document, with_store, write_document,
    write_private_workspace_document, write_workspace_document,
};

/// Filename of the durable database inside the Tauri app-data dir.
/// On-disk name is unchanged so existing installs keep their encrypted vault.
pub const DB_FILENAME: &str = "fable-vault.db";
const BACKUP_FORMAT: &str = "fable.encrypted-sqlite-backup";
const BACKUP_FORMAT_VERSION: u32 = 1;
const BACKUP_MARKER_KEY: &str = "fable.backup.manifest";
const RESTORE_PENDING_FILENAME: &str = "fable-vault.restore-pending.db";
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
                write!(f, "Mivlet's local database reported an error: {msg}.")
            }
            StoreError::Vault => {
                write!(
                    f,
                    "Mivlet could not decrypt local data: the encryption key may be missing, \
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
    account_owned: bool,
    #[cfg(test)]
    account_check: Option<Box<dyn Fn() -> Result<()> + Send + Sync>>,
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
        if std::fs::symlink_metadata(path)
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(false)
        {
            return Err(StoreError::Sqlite(
                "Mivlet's local database cannot be a symbolic link".into(),
            ));
        }
        let conn = Connection::open(path).map_err(|e| StoreError::Sqlite(e.to_string()))?;
        Self::configure_pragmas(&conn)?;
        Self::protect_database_files(path)?;
        // Fail closed on structural corruption before any data access.
        Self::verify_integrity(&conn)?;
        Self::initialize_schema(&conn)?;
        let store = Self {
            account_owned: false,
            #[cfg(test)]
            account_check: None,
            conn: Mutex::new(conn),
            vault,
        };
        // The v6 connector-cache `search_text` column is backfilled lazily here
        // (the migration runs without the vault and cannot decrypt payloads).
        store.backfill_connector_cache_search_text()?;
        Ok(store)
    }

    fn protect_database_files(path: &Path) -> Result<()> {
        crate::paths::ensure_private_file(path).map_err(StoreError::Sqlite)?;
        for suffix in ["-wal", "-shm"] {
            let mut sidecar = path.as_os_str().to_os_string();
            sidecar.push(suffix);
            let sidecar = std::path::PathBuf::from(sidecar);
            if sidecar.exists() {
                crate::paths::ensure_private_file(&sidecar).map_err(StoreError::Sqlite)?;
            }
        }
        Ok(())
    }

    /// Open an in-memory store (tests + repository unit tests). No file.
    #[cfg(test)]
    pub fn open_in_memory(vault: Vault) -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        Self::configure_pragmas(&conn)?;
        Self::initialize_schema(&conn)?;
        let store = Self {
            account_owned: false,
            account_check: None,
            conn: Mutex::new(conn),
            vault,
        };
        store.backfill_connector_cache_search_text()?;
        Ok(store)
    }

    /// Backfill the plaintext `connector_cache.search_text` column for any rows
    /// written before the v6 schema upgrade. Runs once on open and is a no-op on
    /// fresh/already-backfilled databases (no rows with empty `search_text`).
    /// Failures are best-effort and logged-only: a row left with empty
    /// `search_text` is simply invisible to the SQL LIKE prefilter but is still
    /// listed/exported normally; its next upsert repopulates the column.
    fn backfill_connector_cache_search_text(&self) -> Result<()> {
        // Determine which workspaces have rows pending backfill, then backfill
        // each in its own short transaction so the global lock is held briefly.
        let workspaces: Vec<String> = {
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn.prepare(
                "SELECT DISTINCT workspace_id FROM connector_cache WHERE search_text = '';",
            )?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row?);
            }
            out
        };
        for workspace_id in workspaces {
            // Best-effort: never block store open on a backfill failure.
            let _ = self.transaction(|tx| {
                crate::store::repos::connector_cache::backfill_search_text(tx, self, &workspace_id)
            });
        }
        Ok(())
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
                "Mivlet's local database failed its integrity check: {ok}."
            )))
        }
    }

    fn initialize_schema(conn: &Connection) -> Result<()> {
        let has_existing_tables: bool = conn.query_row(
            "SELECT EXISTS(
               SELECT 1 FROM sqlite_master
               WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
             );",
            [],
            |row| row.get(0),
        )?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_meta (
               key TEXT PRIMARY KEY,
               value TEXT NOT NULL
             );",
        )?;

        if has_existing_tables {
            // Older tables must gain their migration columns before the full
            // current schema creates indices over those columns.
            Self::run_migrations(conn)?;
            Self::apply_schema(conn)?;
        } else {
            // Fresh databases use the complete current schema directly. The
            // historical migration chain is only for existing pre-release
            // databases and must not recreate retired product storage.
            Self::apply_schema(conn)?;
            write_schema_version(conn, CURRENT_SCHEMA_VERSION)?;
        }
        Ok(())
    }

    fn apply_schema(conn: &Connection) -> Result<()> {
        let foreign_keys_enabled =
            conn.pragma_query_value(None, "foreign_keys", |row| row.get::<_, i64>(0))? != 0;
        if foreign_keys_enabled {
            conn.pragma_update(None, "foreign_keys", "OFF")?;
        }
        let schema_result = (|| -> Result<()> {
            conn.execute_batch(SCHEMA_V1)?;
            conn.execute_batch(crate::store::schema::SCHEMA_V41_TO_V42)?;
            conn.execute_batch(crate::store::schema::SCHEMA_V43_TO_V44)?;
            conn.execute_batch(crate::store::schema::SCHEMA_V44_TO_V45)?;
            conn.execute_batch(crate::store::schema::RETIRED_ORCHESTRATION_STORAGE_CLEANUP)?;
            // Base DDL includes PRAGMA foreign_keys=ON. Re-establish the
            // maintenance fence before the event migration rebuilds a parent.
            conn.pragma_update(None, "foreign_keys", "OFF")?;
            migrations::local_events::apply(conn)?;
            conn.execute(
                "INSERT OR IGNORE INTO workspace(id,name,created_at,updated_at)
                 VALUES('default','My Workspace','1970-01-01T00:00:00Z','1970-01-01T00:00:00Z');",
                [],
            )?;
            let violation = conn
                .query_row("PRAGMA foreign_key_check;", [], |row| {
                    row.get::<_, String>(0)
                })
                .optional()?;
            if violation.is_some() {
                return Err(StoreError::Corrupt(
                    "Mivlet's local database schema could not preserve referential integrity."
                        .to_string(),
                ));
            }
            Ok(())
        })();
        let restore_result = if foreign_keys_enabled {
            conn.pragma_update(None, "foreign_keys", "ON")
                .map_err(StoreError::from)
        } else {
            Ok(())
        };
        match (schema_result, restore_result) {
            (Err(error), _) => Err(error),
            (Ok(()), Err(error)) => Err(error),
            (Ok(()), Ok(())) => Ok(()),
        }
    }

    /// Run pending schema/data migrations inside a transaction.
    fn run_migrations(conn: &Connection) -> Result<()> {
        // SQLite's documented table-rebuild procedure requires foreign-key
        // enforcement to be disabled before the migration transaction starts.
        // The completed schema is checked inside that same transaction before
        // it can commit, then enforcement is restored for normal operation.
        let foreign_keys_enabled =
            conn.pragma_query_value(None, "foreign_keys", |row| row.get::<_, i64>(0))? != 0;
        if foreign_keys_enabled {
            conn.pragma_update(None, "foreign_keys", "OFF")?;
        }

        let migration_result = (|| -> Result<()> {
            let tx = conn.unchecked_transaction()?;
            let current = read_schema_version(&tx)?;
            if current > CURRENT_SCHEMA_VERSION {
                // A newer schema than this binary understands. Fail closed rather
                // than downgrade-silently.
                return Err(StoreError::Invalid(format!(
                    "The local database schema (v{current}) is newer than this version of Mivlet supports (v{CURRENT_SCHEMA_VERSION})."
                )));
            }
            migrations::apply(&tx, current, CURRENT_SCHEMA_VERSION)?;
            write_schema_version(&tx, CURRENT_SCHEMA_VERSION)?;
            let violation = tx
                .query_row("PRAGMA foreign_key_check;", [], |row| {
                    row.get::<_, String>(0)
                })
                .optional()?;
            if violation.is_some() {
                return Err(StoreError::Corrupt(
                    "Mivlet's local database migration could not preserve referential integrity."
                        .to_string(),
                ));
            }
            tx.commit()?;
            Ok(())
        })();

        let restore_result = if foreign_keys_enabled {
            conn.pragma_update(None, "foreign_keys", "ON")
                .map_err(StoreError::from)
        } else {
            Ok(())
        };
        match (migration_result, restore_result) {
            (Err(error), _) => Err(error),
            (Ok(()), Err(error)) => Err(error),
            (Ok(()), Ok(())) => Ok(()),
        }
    }

    /// Run `f` against the raw connection under the lock (for integrity checks,
    /// pragmas, and ad-hoc reads).
    fn check_account(&self) -> Result<()> {
        if self.account_owned {
            #[cfg(test)]
            if let Some(check) = &self.account_check {
                return check();
            }
            crate::account_session::ensure_current().map_err(StoreError::Invalid)?;
        }
        Ok(())
    }

    pub fn with_conn<R>(&self, f: impl FnOnce(&Connection) -> Result<R>) -> Result<R> {
        let conn = self.conn.lock().expect("store connection mutex poisoned");
        self.check_account()?;
        let result = f(&conn)?;
        self.check_account()?;
        Ok(result)
    }

    /// Run `f` inside a SQLite transaction. All multi-record writes use this.
    /// The transaction commits iff `f` returns `Ok`; a `Err` rolls back.
    pub fn transaction<R>(
        &self,
        f: impl FnOnce(&rusqlite::Transaction<'_>) -> Result<R>,
    ) -> Result<R> {
        let mut conn = self.conn.lock().expect("store connection mutex poisoned");
        self.check_account()?;
        // The desktop and background owner have separate connections. Reserve
        // the writer before reading state: upgrading a deferred WAL snapshot
        // can fail immediately and bypass SQLite's busy timeout.
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(StoreError::from)?;
        let out = f(&tx)?;
        self.check_account()?;
        tx.commit().map_err(StoreError::from)?;
        Ok(out)
    }

    /// SQL-only account update with an exact native identity fence at commit.
    /// Scope and credential resolution must happen before this call. Holding
    /// the identity guard around ordinary transaction() would deadlock its
    /// account checks, which acquire that same identity mutex.
    pub(crate) fn transaction_with_account_fence<R>(
        &self,
        fence: &crate::account_session::AccountDispatchFence,
        f: impl FnOnce(&rusqlite::Transaction<'_>) -> Result<R>,
    ) -> Result<R> {
        fence.with_current(|| Ok(())).map_err(StoreError::Invalid)?;
        let mut conn = self.conn.lock().expect("store connection mutex poisoned");
        let tx = conn.transaction()?;
        let out = f(&tx)?;
        fence
            .with_current(|| Ok(tx.commit().map_err(StoreError::from)))
            .map_err(StoreError::Invalid)??;
        Ok(out)
    }

    /// Prepare SQL under the account-owned Store lock, then fence only COMMIT.
    /// The final callback must use cached authority checks and the supplied
    /// transaction only: Store access or credential I/O would re-enter locks.
    /// Any preparation, account-check or commit-fence error rolls back.
    pub(crate) fn transaction_with_commit_fence<R, E>(
        &self,
        f: impl FnOnce(&rusqlite::Transaction<'_>) -> std::result::Result<R, E>,
        commit: impl FnOnce(rusqlite::Transaction<'_>) -> std::result::Result<(), E>,
    ) -> std::result::Result<R, E>
    where
        E: From<StoreError>,
    {
        let mut conn = self.conn.lock().expect("store connection mutex poisoned");
        self.check_account()?;
        let tx = conn.transaction().map_err(StoreError::from)?;
        let out = f(&tx)?;
        self.check_account()?;
        commit(tx)?;
        Ok(out)
    }

    /// Exercise account-owned storage with isolated, synthetic identity state.
    #[cfg(test)]
    pub(crate) fn with_test_account_check(
        mut self,
        check: impl Fn() -> Result<()> + Send + Sync + 'static,
    ) -> Self {
        self.account_owned = true;
        self.account_check = Some(Box::new(check));
        self
    }

    /// Shared connection-first transaction primitive for account-bound writes.
    /// The injected fence is production-backed by native identity; the narrow
    /// seam also lets store tests exercise rollback and stale-generation
    /// rejection without reading credentials.
    fn transaction_with_identity_fence<R, G>(
        &self,
        expected: &crate::clerk_identity::NativeIdentityGenerationSnapshot,
        acquire_identity: impl FnOnce() -> std::result::Result<G, String>,
        ensure_current: impl Fn(
            &crate::clerk_identity::NativeIdentityGenerationSnapshot,
        ) -> std::result::Result<(), String>,
        f: impl FnOnce(&rusqlite::Transaction<'_>, &Store) -> std::result::Result<R, String>,
    ) -> std::result::Result<R, String> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| "Mivlet's local database is unavailable.".to_string())?;
        let _identity_guard = acquire_identity()?;
        ensure_current(expected)?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        let out = f(&tx, self)?;
        ensure_current(expected)?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(out)
    }

    /// Run one account-bound transaction with a consistent lock order:
    /// connection first, then native identity. Approval resolution uses this
    /// path so account generation cannot change between its durable writes and
    /// commit, while ordinary store account checks remain deadlock-free.
    pub(crate) fn transaction_with_native_identity<R>(
        &self,
        expected: &crate::clerk_identity::NativeIdentityGenerationSnapshot,
        f: impl FnOnce(&rusqlite::Transaction<'_>, &Store) -> std::result::Result<R, String>,
    ) -> std::result::Result<R, String> {
        let account_owned = self.account_owned;
        self.transaction_with_identity_fence(
            expected,
            || crate::clerk_identity::lock_native_identity_generation(expected),
            move |expected| {
                if account_owned {
                    crate::account_session::ensure_current_with_identity_guard(expected)
                } else {
                    Ok(())
                }
            },
            f,
        )
    }

    /// Privileged outgoing-account cleanup; never accepts a caller-selected owner.
    pub(crate) fn suspend_account(&self) -> Result<()> {
        let (user, member) = crate::account_session::principals().map_err(StoreError::Invalid)?;
        self.suspend_bound_account(&user, &member)
    }

    fn suspend_bound_account(&self, user: &str, member: &str) -> Result<()> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| StoreError::Invalid("Account store unavailable.".into()))?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        tx.execute(
            "UPDATE local_schedule SET status='paused',revision=revision+1 WHERE status='enabled'",
            [],
        )?;
        crate::collaboration::suspend_account(&tx, self, user, member)?;
        crate::background_worker::revoke_at(&tx, self)?;
        let data = repos::scope::DataScope::legacy_default();
        let path = Path::new("execution-approvals.json");
        let (_, key) = scoped_document_location(path, &data).map_err(StoreError::Invalid)?;
        if let Some(mut records) = repos::preferences::get_scoped(&tx, self, &data, &key)? {
            if let Some(records) = records.as_array_mut() {
                for record in records {
                    record["invalidatedAt"] = serde_json::json!(timestamp());
                }
            }
            repos::preferences::upsert_scoped(&tx, self, &data, &key, &records, &timestamp())?;
        }
        tx.commit()?;
        Ok(())
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
        .map_err(|_| "Mivlet could not prepare the local data folder.".to_string())?;
    let db_path = app_data_dir.join(DB_FILENAME);
    let key_store = keys::NativeKeyStore::new()?;
    let pending_restore = app_data_dir.join(RESTORE_PENDING_FILENAME);
    if pending_restore.exists()
        && (crate::background_worker::is_worker() || crate::background_worker::owner_alive())
    {
        return Err("Stop the background worker before activating a pending local restore.".into());
    }
    let key = match keys::resolve_for_database(
        &key_store,
        Store::database_exists(&db_path) || pending_restore.exists(),
    )? {
        keys::KeyResolution::Existing(key) | keys::KeyResolution::FreshlyCreated(key) => key,
    };
    let recovery = apply_pending_restore(app_data_dir, &key)?;
    let vault = Vault::new(&key).map_err(|_| "Mivlet could not initialize local encryption.")?;
    let mut store = match Store::open(&db_path, vault) {
        Ok(store) => store,
        Err(error) => {
            if let Some(recovery) = recovery.as_ref() {
                return Err(rollback_applied_restore(
                    app_data_dir,
                    &db_path,
                    recovery,
                    &error.to_string(),
                ));
            }
            return Err(error.to_string());
        }
    };
    store.account_owned = true;
    if recovery.is_some() {
        // A backup may contain old permits or enabled schedules. Restoration
        // preserves outcomes but cannot revive authority or replay dispatch.
        store.suspend_account().map_err(|error| error.to_string())?;
    }
    GLOBAL_STORE
        .set(store)
        .map_err(|_| "Mivlet's encrypted store was initialized twice.".to_string())
}

#[tauri::command]
pub fn export_local_data(workspace_id: Option<String>) -> std::result::Result<String, String> {
    documents::export_local_data(workspace_id)
}

#[tauri::command]
pub fn backup_local_data(destination: String) -> std::result::Result<LocalBackupReceipt, String> {
    backup::backup_local_data(destination)
}

#[tauri::command]
pub fn prepare_local_data_restore(
    app: tauri::AppHandle,
    source: String,
    confirmation: String,
) -> std::result::Result<LocalRestorePreparation, String> {
    backup::prepare_local_data_restore(app, source, confirmation)
}

#[tauri::command]
pub fn delete_local_data(
    app: tauri::AppHandle,
    confirmation: String,
) -> std::result::Result<LocalDataDeletionReceipt, String> {
    backup::delete_local_data(app, confirmation)
}

fn timestamp() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
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
        .ok_or_else(|| "Mivlet's encrypted store is not initialized.".to_string())?;
    let version = store
        .with_conn(read_schema_version)
        .map_err(|error| error.to_string())?;
    Ok(EncryptedStoreStatus {
        ready: true,
        schema_version: version,
        database_file: DB_FILENAME,
    })
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
