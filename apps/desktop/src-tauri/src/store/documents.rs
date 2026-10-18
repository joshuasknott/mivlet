//! Encrypted document and file-backed compatibility storage.
//!
//! This module owns scoped document keys, production document accessors, and
//! the isolated JSON fallback used by tests and legacy callers.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use sha2::{Digest, Sha256};

use super::{repos, timestamp, Store, StoreError, CURRENT_SCHEMA_VERSION, GLOBAL_STORE};

fn document_key(path: &Path) -> std::result::Result<String, String> {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(|name| format!("document:{name}"))
        .ok_or_else(|| "Mivlet could not identify the local document.".to_string())
}

pub(super) fn scoped_document_location(
    path: &Path,
    scope: &repos::scope::DataScope,
) -> std::result::Result<(repos::scope::DataScope, String), String> {
    let base = document_key(path)?;
    match scope.project_id() {
        None => Ok((scope.clone(), base)),
        Some(project_id) => {
            let digest = format!("{:x}", Sha256::digest(project_id.as_bytes()));
            let workspace = repos::scope::DataScope::workspace(scope.workspace_id().to_string())
                .map_err(|error| error.to_string())?;
            Ok((
                workspace,
                format!(
                    "document:project:{digest}:{}",
                    base.trim_start_matches("document:")
                ),
            ))
        }
    }
}

pub(crate) fn read_document_in_transaction<T: serde::de::DeserializeOwned>(
    tx: &rusqlite::Transaction<'_>,
    store: &Store,
    path: &Path,
    scope: &repos::scope::DataScope,
) -> std::result::Result<Option<T>, String> {
    let (storage_scope, key) = scoped_document_location(path, scope)?;
    repos::preferences::get_scoped(tx, store, &storage_scope, &key)
        .map_err(|error| error.to_string())?
        .map(serde_json::from_value)
        .transpose()
        .map_err(|_| "Mivlet could not decode an encrypted local document.".to_string())
}

pub(crate) fn write_document_in_transaction<T: serde::Serialize>(
    tx: &rusqlite::Transaction<'_>,
    store: &Store,
    path: &Path,
    scope: &repos::scope::DataScope,
    value: &T,
) -> std::result::Result<(), String> {
    let (storage_scope, key) = scoped_document_location(path, scope)?;
    let value = serde_json::to_value(value)
        .map_err(|_| "Mivlet could not encode an encrypted local document.".to_string())?;
    repos::preferences::upsert_scoped(tx, store, &storage_scope, &key, &value, &timestamp())
        .map_err(|error| error.to_string())
}

pub(crate) fn private_document_location(
    path: &Path,
    scope: &repos::scope::PrivateDataScope,
) -> std::result::Result<(repos::scope::DataScope, String), String> {
    let (_, scoped_key) = scoped_document_location(path, scope.data())?;
    let owner_digest = format!("{:x}", Sha256::digest(scope.owner_subject().as_bytes()));
    let workspace = repos::scope::DataScope::workspace(scope.workspace_id().to_string())
        .map_err(|error| error.to_string())?;
    Ok((
        workspace,
        format!(
            "document:owner:{owner_digest}:{}",
            scoped_key.trim_start_matches("document:")
        ),
    ))
}

/// Preference-key prefix shared by every private document of one owner. Scoped
/// search uses it to enumerate only this owner's derived-file receipts without
/// reading other members' documents.
pub(crate) fn private_document_key_prefix(
    scope: &repos::scope::PrivateDataScope,
) -> std::result::Result<String, String> {
    let owner_digest = format!("{:x}", Sha256::digest(scope.owner_subject().as_bytes()));
    Ok(format!("document:owner:{owner_digest}:"))
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
    if GLOBAL_STORE.get().is_none() {
        return Ok(None);
    }
    let scope = repos::scope::DataScope::workspace(repos::scope::DEFAULT_WORKSPACE_ID)
        .map_err(|error| error.to_string())?;
    read_workspace_document(path, &scope)
}

pub fn read_workspace_document<T: serde::de::DeserializeOwned>(
    path: &Path,
    scope: &repos::scope::DataScope,
) -> std::result::Result<Option<T>, String> {
    let Some(store) = GLOBAL_STORE.get() else {
        return Ok(None);
    };
    let (storage_scope, key) = scoped_document_location(path, scope)?;
    let value = store
        .with_conn(|conn| repos::preferences::get_scoped(conn, store, &storage_scope, &key))
        .map_err(|error| error.to_string())?;
    value
        .map(serde_json::from_value)
        .transpose()
        .map_err(|_| "Mivlet could not decode an encrypted local document.".to_string())
}

pub fn read_private_workspace_document<T: serde::de::DeserializeOwned>(
    path: &Path,
    scope: &repos::scope::PrivateDataScope,
) -> std::result::Result<Option<T>, String> {
    let Some(store) = GLOBAL_STORE.get() else {
        return Ok(None);
    };
    let (storage_scope, key) = private_document_location(path, scope)?;
    let value = store
        .with_conn(|conn| repos::preferences::get_scoped(conn, store, &storage_scope, &key))
        .map_err(|error| error.to_string())?;
    value
        .map(serde_json::from_value)
        .transpose()
        .map_err(|_| "Mivlet could not decode an encrypted private document.".to_string())
}

/// Write a production document to encrypted SQLite. Returns `false` only when
/// the global store is not initialized, allowing isolated path-based tests to
/// retain their temporary-file fixtures.
pub fn write_document<T: serde::Serialize>(
    path: &Path,
    value: &T,
) -> std::result::Result<bool, String> {
    if GLOBAL_STORE.get().is_none() {
        return Ok(false);
    }
    let scope = repos::scope::DataScope::workspace(repos::scope::DEFAULT_WORKSPACE_ID)
        .map_err(|error| error.to_string())?;
    write_workspace_document(path, &scope, value)
}

pub fn write_workspace_document<T: serde::Serialize>(
    path: &Path,
    scope: &repos::scope::DataScope,
    value: &T,
) -> std::result::Result<bool, String> {
    let Some(store) = GLOBAL_STORE.get() else {
        return Ok(false);
    };
    let (storage_scope, key) = scoped_document_location(path, scope)?;
    let value = serde_json::to_value(value)
        .map_err(|_| "Mivlet could not encode an encrypted local document.".to_string())?;
    store
        .transaction(|tx| {
            repos::preferences::upsert_scoped(tx, store, &storage_scope, &key, &value, &timestamp())
        })
        .map_err(|error| error.to_string())?;
    Ok(true)
}

/// Atomically read-modify-write a workspace document.
///
/// Production uses one SQLite transaction (serialized by the store connection
/// mutex). Isolated tests without a store use a path-keyed lock around the
/// JSON fixture so check-and-set cannot lose an update.
pub fn update_document<T, R>(
    path: &Path,
    update: impl FnOnce(Option<T>) -> std::result::Result<(Option<T>, R), String>,
) -> std::result::Result<R, String>
where
    T: serde::de::DeserializeOwned + serde::Serialize,
{
    if GLOBAL_STORE.get().is_some() {
        let scope = repos::scope::DataScope::workspace(repos::scope::DEFAULT_WORKSPACE_ID)
            .map_err(|error| error.to_string())?;
        return update_workspace_document(path, &scope, update);
    }
    update_json_file(path, update)
}

pub fn update_workspace_document<T, R>(
    path: &Path,
    scope: &repos::scope::DataScope,
    update: impl FnOnce(Option<T>) -> std::result::Result<(Option<T>, R), String>,
) -> std::result::Result<R, String>
where
    T: serde::de::DeserializeOwned + serde::Serialize,
{
    let store = GLOBAL_STORE
        .get()
        .ok_or_else(|| "Mivlet's encrypted store is not initialized.".to_string())?;
    let (storage_scope, key) = scoped_document_location(path, scope)?;
    store
        .transaction(|tx| {
            let current = repos::preferences::get_scoped(tx, store, &storage_scope, &key)?
                .map(serde_json::from_value)
                .transpose()
                .map_err(|_| {
                    StoreError::Invalid(
                        "Mivlet could not decode an encrypted local document.".into(),
                    )
                })?;
            let (replacement, result) = update(current).map_err(StoreError::Invalid)?;
            if let Some(replacement) = replacement {
                let value = serde_json::to_value(replacement).map_err(|_| {
                    StoreError::Invalid(
                        "Mivlet could not encode an encrypted local document.".into(),
                    )
                })?;
                repos::preferences::upsert_scoped(
                    tx,
                    store,
                    &storage_scope,
                    &key,
                    &value,
                    &timestamp(),
                )?;
            }
            Ok(result)
        })
        .map_err(|error| error.to_string())
}

fn document_file_lock(path: &Path) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .entry(path.to_path_buf())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

fn read_json_file<T: serde::de::DeserializeOwned>(
    path: &Path,
) -> std::result::Result<Option<T>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let contents = std::fs::read_to_string(path)
        .map_err(|_| "Mivlet could not read a local document.".to_string())?;
    if contents.trim().is_empty() {
        return Ok(None);
    }
    serde_json::from_str(&contents)
        .map(Some)
        .map_err(|_| "Mivlet could not parse a local document.".to_string())
}

fn write_json_file<T: serde::Serialize>(path: &Path, value: &T) -> std::result::Result<(), String> {
    let encoded = serde_json::to_vec_pretty(value)
        .map_err(|_| "Mivlet could not encode a local document.".to_string())?;
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, encoded)
        .map_err(|_| "Mivlet could not save a local document.".to_string())?;
    std::fs::rename(&temporary, path)
        .map_err(|_| "Mivlet could not commit a local document.".to_string())
}

fn update_json_file<T, R>(
    path: &Path,
    update: impl FnOnce(Option<T>) -> std::result::Result<(Option<T>, R), String>,
) -> std::result::Result<R, String>
where
    T: serde::de::DeserializeOwned + serde::Serialize,
{
    let lock = document_file_lock(path);
    let _guard = lock.lock().unwrap_or_else(|error| error.into_inner());
    let current = read_json_file(path)?;
    let (replacement, result) = update(current)?;
    if let Some(replacement) = replacement {
        write_json_file(path, &replacement)?;
    }
    Ok(result)
}

pub fn write_private_workspace_document<T: serde::Serialize>(
    path: &Path,
    scope: &repos::scope::PrivateDataScope,
    value: &T,
) -> std::result::Result<bool, String> {
    let Some(store) = GLOBAL_STORE.get() else {
        return Ok(false);
    };
    let (storage_scope, key) = private_document_location(path, scope)?;
    let value = serde_json::to_value(value)
        .map_err(|_| "Mivlet could not encode an encrypted private document.".to_string())?;
    store
        .transaction(|tx| {
            repos::preferences::upsert_scoped(tx, store, &storage_scope, &key, &value, &timestamp())
        })
        .map_err(|error| error.to_string())?;
    Ok(true)
}

pub fn update_private_workspace_document<T, R>(
    path: &Path,
    scope: &repos::scope::PrivateDataScope,
    update: impl FnOnce(Option<T>) -> std::result::Result<(Option<T>, R), String>,
) -> std::result::Result<R, String>
where
    T: serde::de::DeserializeOwned + serde::Serialize,
{
    let store = GLOBAL_STORE
        .get()
        .ok_or_else(|| "Mivlet's encrypted store is not initialized.".to_string())?;
    let (storage_scope, key) = private_document_location(path, scope)?;
    store
        .transaction(|tx| {
            let current = repos::preferences::get_scoped(tx, store, &storage_scope, &key)?
                .map(serde_json::from_value)
                .transpose()
                .map_err(|_| {
                    StoreError::Invalid(
                        "Mivlet could not decode an encrypted private document.".into(),
                    )
                })?;
            let (replacement, result) = update(current).map_err(StoreError::Invalid)?;
            if let Some(replacement) = replacement {
                let value = serde_json::to_value(replacement).map_err(|_| {
                    StoreError::Invalid(
                        "Mivlet could not encode an encrypted private document.".into(),
                    )
                })?;
                repos::preferences::upsert_scoped(
                    tx,
                    store,
                    &storage_scope,
                    &key,
                    &value,
                    &timestamp(),
                )?;
            }
            Ok(result)
        })
        .map_err(|error| error.to_string())
}
/// Export encrypted-store documents as credential-free JSON. OAuth/API keys
/// never enter the database and therefore cannot enter this export.
pub(super) fn export_local_data(
    workspace_id: Option<String>,
) -> std::result::Result<String, String> {
    let store = GLOBAL_STORE
        .get()
        .ok_or_else(|| "Mivlet's encrypted store is not initialized.".to_string())?;
    let scope = crate::authorized_scope::command_scope(
        workspace_id,
        None,
        crate::authorized_scope::ScopeAccess::Read,
    )?
    .data;
    // Fetch every document for the scope in a single query + decryption pass,
    // rather than re-acquiring the store mutex and re-querying once per key.
    let documents = store
        .with_conn(|conn| repos::preferences::documents_for_export(conn, store, &scope))
        .map_err(|error| error.to_string())?;
    serde_json::to_string_pretty(&serde_json::json!({
        "version": CURRENT_SCHEMA_VERSION,
        "workspaceId": scope.workspace_id(),
        "credentialsIncluded": false,
        "documents": documents,
    }))
    .map_err(|_| "Mivlet could not encode the local-data export.".to_string())
}
