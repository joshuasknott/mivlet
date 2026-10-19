//! Encrypted SQLite backup, restore, export, and local-data deletion.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags, OptionalExtension};

use super::{
    read_schema_version, repos, timestamp, vault, Result, Store, StoreError, Vault, BACKUP_FORMAT,
    BACKUP_FORMAT_VERSION, BACKUP_MARKER_KEY, CURRENT_SCHEMA_VERSION, DB_FILENAME, GLOBAL_STORE,
    RESTORE_PENDING_FILENAME,
};

fn backup_manifest() -> serde_json::Value {
    serde_json::json!({
        "format": BACKUP_FORMAT,
        "formatVersion": BACKUP_FORMAT_VERSION,
        "schemaVersion": CURRENT_SCHEMA_VERSION,
        "createdAt": timestamp(),
        "requiresMatchingOsVaultKey": true,
        "credentialsIncluded": false
    })
}

pub(super) fn write_backup_marker(store: &Store) -> Result<serde_json::Value> {
    let manifest = backup_manifest();
    store.transaction(|tx| {
        repos::preferences::upsert(tx, store, BACKUP_MARKER_KEY, &manifest, &timestamp())
    })?;
    Ok(manifest)
}

pub(super) fn validate_backup_candidate(path: &Path, vault: &Vault) -> Result<serde_json::Value> {
    if !path.is_file() || crate::paths::contains_symlink(path) {
        return Err(StoreError::Invalid(
            "The selected backup must be a regular local file without links.".into(),
        ));
    }
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(StoreError::from)?;
    Store::verify_integrity(&conn)?;
    let version = read_schema_version(&conn)?;
    if version > CURRENT_SCHEMA_VERSION {
        return Err(StoreError::Invalid(
            "This backup was created by a newer version of Mivlet.".into(),
        ));
    }
    let sealed = conn
        .query_row(
            "SELECT payload, payload_nonce FROM preferences
             WHERE workspace_id=?1 AND key=?2",
            rusqlite::params![repos::scope::DEFAULT_WORKSPACE_ID, BACKUP_MARKER_KEY],
            repos::payload_of,
        )
        .optional()?
        .ok_or_else(|| {
            StoreError::Invalid("This database is not a verified Mivlet recovery backup.".into())
        })?;
    let opened = vault.open(
        &sealed,
        format!(
            "preferences:{}:{}",
            repos::scope::DEFAULT_WORKSPACE_ID,
            BACKUP_MARKER_KEY
        )
        .as_bytes(),
    )?;
    let manifest: serde_json::Value = serde_json::from_slice(&opened)
        .map_err(|_| StoreError::Invalid("The encrypted backup marker is malformed.".into()))?;
    if manifest.get("format").and_then(serde_json::Value::as_str) != Some(BACKUP_FORMAT)
        || manifest
            .get("formatVersion")
            .and_then(serde_json::Value::as_u64)
            != Some(BACKUP_FORMAT_VERSION as u64)
        || manifest
            .get("requiresMatchingOsVaultKey")
            .and_then(serde_json::Value::as_bool)
            != Some(true)
        || manifest
            .get("credentialsIncluded")
            .and_then(serde_json::Value::as_bool)
            != Some(false)
    {
        return Err(StoreError::Invalid(
            "The encrypted backup marker is invalid.".into(),
        ));
    }
    Ok(manifest)
}

fn unique_restore_path(app_data_dir: &Path, label: &str) -> PathBuf {
    let timestamp = chrono::Utc::now().timestamp_millis();
    for suffix in 0..1000 {
        let path = app_data_dir.join(format!("{DB_FILENAME}.{label}-{timestamp}-{suffix}.db"));
        if !path.exists() {
            return path;
        }
    }
    app_data_dir.join(format!("{DB_FILENAME}.{label}-{timestamp}.overflow.db"))
}

pub(super) fn rollback_applied_restore(
    app_data_dir: &Path,
    database: &Path,
    recovery: &Path,
    error: &str,
) -> String {
    let failed = unique_restore_path(app_data_dir, "failed-restore");
    let _ = std::fs::rename(database, &failed);
    if std::fs::rename(recovery, database).is_err() {
        return "The restored database could not open, and Mivlet could not put the prior database back. Both recovery files were preserved."
            .into();
    }
    format!(
        "The restored database could not open and the prior database was put back. Restart Mivlet to continue with the prior data. {error}"
    )
}

pub(super) fn apply_pending_restore(
    app_data_dir: &Path,
    key: &vault::MasterKey,
) -> std::result::Result<Option<PathBuf>, String> {
    let pending = app_data_dir.join(RESTORE_PENDING_FILENAME);
    if !pending.exists() {
        return Ok(None);
    }
    let validation_vault =
        Vault::new(key).map_err(|_| "Mivlet could not validate the pending restore.")?;
    validate_backup_candidate(&pending, &validation_vault).map_err(|error| error.to_string())?;
    let current = app_data_dir.join(DB_FILENAME);
    let recovery = if current.exists() {
        let checkpoint_vault =
            Vault::new(key).map_err(|_| "Mivlet could not prepare restore recovery.")?;
        let current_store =
            Store::open(&current, checkpoint_vault).map_err(|error| error.to_string())?;
        current_store
            .with_conn(|conn| {
                conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
                Ok(())
            })
            .map_err(|error| error.to_string())?;
        drop(current_store);
        let recovery = unique_restore_path(app_data_dir, "pre-restore");
        std::fs::rename(&current, &recovery)
            .map_err(|_| "Mivlet could not preserve the current database before restore.")?;
        Some(recovery)
    } else {
        None
    };
    if std::fs::rename(&pending, &current).is_err() {
        if let Some(recovery) = recovery.as_ref() {
            let _ = std::fs::rename(recovery, &current);
        }
        return Err(
            "Mivlet could not activate the pending restore; the prior data was retained.".into(),
        );
    }
    Ok(recovery)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBackupReceipt {
    path: String,
    created_at: String,
    schema_version: u32,
    requires_matching_os_vault_key: bool,
    credentials_included: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRestorePreparation {
    restart_required: bool,
    backup_created_at: String,
    schema_version: u32,
    credentials_included: bool,
}

/// Create and immediately verify a consistent encrypted SQLite backup. The
/// destination must not already exist. Its encrypted marker proves that the
/// current OS-held vault key can read it without exporting that key.
pub(super) fn backup_local_data(
    destination: String,
) -> std::result::Result<LocalBackupReceipt, String> {
    let target = PathBuf::from(destination);
    if target.exists() {
        return Err("Mivlet will not overwrite an existing backup.".to_string());
    }
    let parent = target
        .parent()
        .filter(|parent| parent.is_dir())
        .ok_or_else(|| "Choose an existing folder for the backup.".to_string())?;
    if crate::paths::contains_symlink(parent) {
        return Err("The backup folder cannot contain links.".into());
    }
    let store = GLOBAL_STORE
        .get()
        .ok_or_else(|| "Mivlet's encrypted store is not initialized.".to_string())?;
    let manifest = write_backup_marker(store).map_err(|error| error.to_string())?;
    let backup = store
        .with_conn(|conn| {
            conn.execute("VACUUM INTO ?1", [target.to_string_lossy().as_ref()])?;
            Ok(())
        })
        .map_err(|error| error.to_string());
    if let Err(error) = backup {
        let _ = std::fs::remove_file(&target);
        return Err(error);
    }
    validate_backup_candidate(&target, &store.vault).map_err(|error| {
        let _ = std::fs::remove_file(&target);
        error.to_string()
    })?;
    Ok(LocalBackupReceipt {
        path: target.to_string_lossy().to_string(),
        created_at: manifest
            .get("createdAt")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string(),
        schema_version: CURRENT_SCHEMA_VERSION,
        requires_matching_os_vault_key: true,
        credentials_included: false,
    })
}

/// Validate and stage a backup for activation on the next clean app start.
/// The live database is never replaced while its connection is open.
pub(super) fn prepare_local_data_restore(
    app: tauri::AppHandle,
    source: String,
    confirmation: String,
) -> std::result::Result<LocalRestorePreparation, String> {
    if confirmation != "restore local data" {
        return Err("Type \"restore local data\" to confirm the restore.".into());
    }
    let _background_guard = crate::background_worker::maintenance_guard()?;
    let source = PathBuf::from(source);
    let canonical = crate::paths::strict_canonicalize(&source)
        .map_err(|_| "The selected backup is unavailable.".to_string())?;
    if !canonical.is_file() || crate::paths::contains_symlink(&source) {
        return Err("The selected backup must be a regular local file without links.".into());
    }
    let app_data_dir = crate::paths::app_data_dir(&app)?;
    let current = app_data_dir.join(DB_FILENAME);
    if current
        .canonicalize()
        .ok()
        .is_some_and(|path| path == canonical)
    {
        return Err("Choose a backup file, not Mivlet's active database.".into());
    }
    let store = GLOBAL_STORE
        .get()
        .ok_or_else(|| "Mivlet's encrypted store is not initialized.".to_string())?;
    let manifest =
        validate_backup_candidate(&canonical, &store.vault).map_err(|error| error.to_string())?;
    let pending = app_data_dir.join(RESTORE_PENDING_FILENAME);
    if pending.exists() {
        return Err(
            "A verified restore is already waiting for restart. Restart Mivlet before choosing another backup."
                .into(),
        );
    }
    std::fs::copy(&canonical, &pending)
        .map_err(|_| "Mivlet could not stage the selected backup.".to_string())?;
    let staged = validate_backup_candidate(&pending, &store.vault);
    if let Err(error) = staged {
        let _ = std::fs::remove_file(&pending);
        return Err(error.to_string());
    }
    let finalized = std::fs::OpenOptions::new()
        .write(true)
        .open(&pending)
        .and_then(|file| file.sync_all());
    if finalized.is_err() {
        let _ = std::fs::remove_file(&pending);
        return Err("Mivlet could not finalize the staged restore.".into());
    }
    Ok(LocalRestorePreparation {
        restart_required: true,
        backup_created_at: manifest
            .get("createdAt")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string(),
        schema_version: manifest
            .get("schemaVersion")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or_default() as u32,
        credentials_included: false,
    })
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDataDeletionReceipt {
    restart_required: bool,
    hosted_data_deleted: bool,
    provider_credentials_revoked: bool,
}

pub(super) fn delete_local_store_content(store: &Store) -> Result<()> {
    store.transaction(|tx| {
        tx.execute_batch("PRAGMA defer_foreign_keys = ON;")?;
        let table_names = {
            let mut statement = tx.prepare("PRAGMA table_list;")?;
            let rows = statement.query_map([], |row| {
                Ok((row.get::<_, String>(1)?, row.get::<_, String>(2)?))
            })?;
            let mut names = Vec::new();
            for row in rows {
                let (name, table_type) = row?;
                if !name.starts_with("sqlite_")
                    && name != "schema_meta"
                    && matches!(table_type.as_str(), "table" | "virtual")
                {
                    names.push(name);
                }
            }
            names
        };
        for table_name in table_names {
            let quoted = table_name.replace('"', "\"\"");
            tx.execute_batch(&format!("DELETE FROM \"{quoted}\";"))?;
        }
        tx.execute(
            "INSERT INTO workspace (id, name, created_at, updated_at)
             VALUES ('default', 'My Workspace', '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z');",
            [],
        )?;
        Ok(())
    })
}

pub(super) fn delete_local_compatibility_files(app_data: &Path) -> std::result::Result<(), String> {
    let mut candidates = [
        "runtime-snapshot.json",
        "agent-runs.json",
        "approval-audit.json",
        "approval-rules.json",
        "connector-approval-records.json",
        "execution-approvals.json",
        "connector-connections.json",
        "connector-sync-state.json",
        "connected-backends.json",
        "memory-state.json",
        "imported-knowledge.json",
        "scheduler-store.json",
        "workflow-definitions.json",
        "workflow-runs.json",
        RESTORE_PENDING_FILENAME,
    ]
    .into_iter()
    .map(|name| app_data.join(name))
    .collect::<Vec<_>>();

    let entries = std::fs::read_dir(app_data).map_err(|_| {
        "Local database content was cleared, but Mivlet could not inspect legacy and recovery files. Restart Mivlet, then retry local deletion.".to_string()
    })?;
    for entry in entries {
        let entry = entry.map_err(|_| {
            "Local database content was cleared, but Mivlet could not inspect every legacy and recovery file. Restart Mivlet, then retry local deletion.".to_string()
        })?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if name.starts_with(&format!("{DB_FILENAME}.pre-restore-"))
            || name.starts_with(&format!("{DB_FILENAME}.failed-restore-"))
        {
            candidates.push(entry.path());
        }
    }

    let mut failures = 0_u32;
    for path in candidates {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => failures += 1,
        }
    }
    if failures > 0 {
        return Err(format!(
            "Local database content was cleared, but Mivlet could not remove {failures} legacy or recovery file(s). Restart Mivlet, then retry local deletion."
        ));
    }
    Ok(())
}

/// Delete this installation's local database content after an exact
/// destructive confirmation. The vault key, hosted account/workspace data,
/// and provider credentials are separate lifecycles and are retained.
pub(super) fn delete_local_data(
    app: tauri::AppHandle,
    confirmation: String,
) -> std::result::Result<LocalDataDeletionReceipt, String> {
    if confirmation != "delete local data" {
        return Err("Type \"delete local data\" to confirm local deletion.".to_string());
    }
    let _background_guard = crate::background_worker::maintenance_guard()?;
    let store = GLOBAL_STORE
        .get()
        .ok_or_else(|| "Mivlet's encrypted store is not initialized.".to_string())?;
    delete_local_store_content(store).map_err(|error| error.to_string())?;
    // Use hardened (portable-aware) resolution; do not bypass via direct tauri path().
    let app_data = crate::paths::app_data_dir(&app)?;
    delete_local_compatibility_files(&app_data)?;
    Ok(LocalDataDeletionReceipt {
        restart_required: true,
        hosted_data_deleted: false,
        provider_credentials_revoked: false,
    })
}
