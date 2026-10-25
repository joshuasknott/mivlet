//! Native file-dialog commands for portable transfer.

use super::data::PortableTransferPayload;
use super::data::{
    apply_payload, ensure_empty_destination, payload_from_store, validate_payload,
    PortableTransferImportReport, PortableTransferReceipt,
};
use super::envelope::{
    binding_digest, open, seal, MAX_TRANSFER_FILE_BYTES, TRANSFER_FORMAT_VERSION,
};
use crate::store::repos::scope::{DataScope, PrivateDataScope, DEFAULT_WORKSPACE_ID};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

static TRANSFER_ACTIVE: AtomicBool = AtomicBool::new(false);

struct TransferGuard;

impl TransferGuard {
    fn acquire() -> Result<Self, String> {
        TRANSFER_ACTIVE
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .map(|_| Self)
            .map_err(|_| "Another portable transfer is already in progress.".to_string())
    }
}

impl Drop for TransferGuard {
    fn drop(&mut self) {
        TRANSFER_ACTIVE.store(false, Ordering::Release);
    }
}

fn open_payload_from_file(
    path: &Path,
    passphrase: &str,
) -> Result<PortableTransferPayload, String> {
    if crate::paths::contains_symlink(path) {
        return Err("The portable transfer file cannot contain links.".into());
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| "Choose an existing portable transfer file.".to_string())?;
    let metadata = canonical
        .metadata()
        .map_err(|_| "Mivlet could not inspect the portable transfer file.".to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_TRANSFER_FILE_BYTES {
        return Err("The portable transfer file is unavailable or too large.".into());
    }
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::open(&canonical)
        .map_err(|_| "Mivlet could not read the portable transfer file.".to_string())?
        .take(MAX_TRANSFER_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Mivlet could not read the portable transfer file.".to_string())?;
    open(&bytes, passphrase).map_err(|error| error.to_string())
}

fn require_supported_workspace(workspace_id: Option<&str>) -> Result<(), String> {
    if workspace_id.is_some_and(|id| id != DEFAULT_WORKSPACE_ID) {
        return Err(
            "Portable transfer currently supports the default local workspace only.".into(),
        );
    }
    Ok(())
}

async fn native_transfer_confirmation(import: bool) -> Result<bool, String> {
    let (title, description) = if import {
        (
            "Import portable transfer?",
            "This imports private conversations outside projects, agents, memory, and knowledge metadata into this empty workspace, then restarts Mivlet. Project rooms, file contents, credentials, provider sessions, approvals, active runs, and local path metadata are excluded.",
        )
    } else {
        (
            "Export portable transfer?",
            "This encrypts private conversations outside projects, agents, memory, and knowledge metadata. Chat text may contain sensitive information. Project rooms, file contents, credentials, provider sessions, approvals, active runs, and local path metadata are excluded.",
        )
    };
    tauri::async_runtime::spawn_blocking(move || {
        Ok(matches!(
            rfd::MessageDialog::new()
                .set_level(rfd::MessageLevel::Warning)
                .set_title(title)
                .set_description(description)
                .set_buttons(rfd::MessageButtons::OkCancel)
                .show(),
            rfd::MessageDialogResult::Ok
        ))
    })
    .await
    .map_err(|_| "The native confirmation dialog was interrupted.".to_string())
    .and_then(|result| result)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if std::fs::symlink_metadata(path).is_ok() {
        return Err("Mivlet will not overwrite an existing portable transfer file.".into());
    }
    let parent = path
        .parent()
        .filter(|parent| parent.is_dir())
        .ok_or("Choose an existing folder for the portable transfer file.")?;
    if crate::paths::contains_symlink(parent) {
        return Err("The portable transfer folder cannot contain links.".into());
    }
    let mut staged = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| "Mivlet could not stage the portable transfer file.".to_string())?;
    use std::io::Write;
    staged
        .write_all(bytes)
        .map_err(|_| "Mivlet could not write the portable transfer file.".to_string())?;
    staged
        .as_file()
        .sync_all()
        .map_err(|_| "Mivlet could not finalize the portable transfer file.".to_string())?;
    staged
        .persist_noclobber(path)
        .map_err(|_| "Mivlet will not overwrite an existing portable transfer file.".to_string())?;
    Ok(())
}

/// Native command seam. The parent registers this command from `lib.rs` and
/// supplies a native masked passphrase through `capture_portable_passphrase`.
#[tauri::command]
pub async fn portable_transfer_export(
    app: tauri::AppHandle,
    workspace_id: Option<String>,
) -> Result<PortableTransferReceipt, String> {
    let _transfer_guard = TransferGuard::acquire()?;
    require_supported_workspace(workspace_id.as_deref())?;
    let Some(destination) = rfd::AsyncFileDialog::new()
        .set_title("Save Mivlet portable transfer")
        .set_file_name("mivlet-portable-transfer.json")
        .add_filter("Mivlet portable transfer", &["json"])
        .save_file()
        .await
    else {
        return Err("Portable transfer export was cancelled.".into());
    };
    if !native_transfer_confirmation(false).await? {
        return Err("Portable transfer export was cancelled.".into());
    }
    let store = crate::store::try_global().ok_or("Mivlet's encrypted store is not initialized.")?;
    let payload = payload_from_store(&app, store)?;
    let passphrase = crate::protected_secrets::capture_portable_passphrase(
        "Protect portable transfer",
        "Encrypt selected Mivlet history and configuration for another installation.",
    )?
    .ok_or("Portable transfer export was cancelled.")?;
    let bytes = seal(&payload, passphrase.as_str()).map_err(|error| error.to_string())?;
    let path = destination.path().to_path_buf();
    write_atomic(&path, &bytes)?;
    Ok(PortableTransferReceipt {
        file_name: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("mivlet-portable-transfer.json")
            .to_string(),
        bytes: bytes.len() as u64,
        format_version: TRANSFER_FORMAT_VERSION,
        schema_version: payload.schema_version,
        credentials_included: false,
        active_authority_included: false,
        account_binding_digest: payload.account_binding_digest,
    })
}

/// Import only into a fresh local destination. A staged transaction re-seals
/// every imported payload with the destination OS vault and rebinds private
/// documents to the currently authenticated member. No provider or execution
/// authority is recreated.
#[tauri::command]
pub async fn portable_transfer_import(
    app: tauri::AppHandle,
    workspace_id: Option<String>,
) -> Result<PortableTransferImportReport, String> {
    let _transfer_guard = TransferGuard::acquire()?;
    require_supported_workspace(workspace_id.as_deref())?;
    let Some(source) = rfd::AsyncFileDialog::new()
        .set_title("Open Mivlet portable transfer")
        .add_filter("Mivlet portable transfer", &["json"])
        .pick_file()
        .await
    else {
        return Err("Portable transfer import was cancelled.".into());
    };
    if !native_transfer_confirmation(true).await? {
        return Err("Portable transfer import was cancelled.".into());
    }
    let store = crate::store::try_global().ok_or("Mivlet's encrypted store is not initialized.")?;
    if crate::background_worker::is_worker() || crate::background_worker::owner_alive() {
        return Err("Stop the background worker before importing a portable transfer.".into());
    }
    // Exclude a concurrently requested Windows worker for the entire import
    // and restart, using the same native owner lease as backup maintenance.
    let _maintenance_guard = crate::background_worker::maintenance_guard()?;
    store
        .with_conn(|conn| {
            ensure_empty_destination(conn, store).map_err(crate::store::StoreError::Invalid)
        })
        .map_err(|error| error.to_string())?;
    let passphrase = crate::protected_secrets::capture_portable_passphrase(
        "Open portable transfer",
        "Decrypt selected Mivlet history and configuration. The destination must be empty.",
    )?
    .ok_or("Portable transfer import was cancelled.")?;
    let payload = open_payload_from_file(source.path(), passphrase.as_str())?;
    let binding = binding_digest(crate::account_session::binding()?);
    validate_payload(&payload, &binding).map_err(|error| error.to_string())?;
    let principals = crate::account_session::principals()?;
    let scope = DataScope::workspace(DEFAULT_WORKSPACE_ID.to_string())
        .map_err(|error| error.to_string())?;
    let private =
        PrivateDataScope::for_authenticated_user(scope.clone(), &principals.0, Some(&principals.1))
            .map_err(|error| error.to_string())?;
    let runtime_path = crate::paths::runtime_snapshot_path(&app)?;
    let memory_path = crate::paths::memory_state_path(&app)?;
    let knowledge_path = crate::paths::imported_knowledge_path(&app)?;
    let counts = store
        .import_transaction(|tx| {
            // Recheck under the same IMMEDIATE transaction that writes imported
            // rows. A concurrent first-run writer cannot race the empty-database
            // preflight and be silently merged or overwritten.
            ensure_empty_destination(tx, store).map_err(crate::store::StoreError::Invalid)?;
            apply_payload(
                tx,
                store,
                &payload,
                &scope,
                &private,
                &runtime_path,
                &memory_path,
                &knowledge_path,
            )
        })
        .map_err(|error| format!("Portable transfer import failed and was rolled back: {error}"))?;
    let report = PortableTransferImportReport {
        threads: payload.threads.len(),
        messages: payload.messages.len(),
        revisions: payload.revisions.len(),
        agents: counts.agents,
        memory_records: counts.memory_records,
        knowledge_sources: counts.knowledge_sources,
        credentials_reconnected: false,
        authority_recreated: false,
        requires_restart: true,
        omitted: payload.omitted,
    };
    // The store is frozen under its connection lock. Teardown revokes native
    // authority and destroys the stale renderer before relaunching.
    crate::account_session::restart(app).await;
    Ok(report)
}
