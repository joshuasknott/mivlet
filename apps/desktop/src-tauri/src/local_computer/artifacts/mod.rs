//! Explicit, approval-gated publication of generated workspace files. Receipts
//! live in the encrypted store; immutable copies are outside the guest mount.

use super::LocalComputerState;
use crate::authorized_scope::{command_scope, ScopeAccess};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    sync::Arc,
};

mod preview;
mod storage;
mod validation;

pub use preview::ArtifactPreview;
pub(crate) use preview::{commit_export, stage_export};
pub(super) use preview::{prepare_open, preview_bytes, verify_prepared_open};
pub(crate) use storage::read_bounded_limit;
pub(super) use storage::{canonical, digest, opened_path, read_bounded, title_for, write_copy};
pub(crate) use validation::{allowed_path, check_office};
pub(super) use validation::{check_content, checked_pdf};
pub(super) use validation::{mime_for, MAX_BYTES};
#[cfg(test)]
mod tests;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalComputerArtifact {
    pub(crate) kind: String,
    pub(crate) version: u32,
    pub(crate) id: String,
    pub(crate) computer_id: String,
    pub(crate) title: String,
    pub(crate) mime_type: String,
    pub(crate) size_bytes: u64,
    pub(crate) relative_path: String,
    pub(crate) created_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ArtifactReceipt {
    pub(crate) artifact: LocalComputerArtifact,
    pub(crate) workspace_id: String,
    pub(crate) agent_id: String,
    pub(crate) export_name: String,
    pub(crate) sha256: String,
}

pub(crate) struct VerifiedImageArtifact {
    pub(crate) bytes: Vec<u8>,
    pub(crate) file_name: String,
    pub(crate) mime_type: String,
}

/// Receipt-verified passive bytes for an exact, approved native connector upload.
/// No host path, bearer credential or byte payload is exposed to JavaScript.
pub(crate) struct VerifiedUploadArtifact {
    pub(crate) bytes: Vec<u8>,
    pub(crate) file_name: String,
    pub(crate) mime_type: String,
    pub(crate) sha256: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenArtifactRequest {
    pub(crate) workspace_id: String,
    pub(crate) agent_id: String,
    pub(crate) artifact_id: String,
    pub(crate) expected_generation: u64,
}

fn valid_id(id: &str) -> bool {
    id.strip_prefix("artifact-").is_some_and(|part| {
        part.len() == 64
            && part
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    })
}

fn random_id() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|_| "Mivlet could not create a private artifact identifier.")?;
    Ok(format!("artifact-{}", hex::encode(bytes)))
}

/// The caller verifies the exact, single-use tool approval before invoking this.
pub(crate) fn publish_artifact(
    computers: &LocalComputerState,
    workspace_id: &str,
    agent_id: &str,
    expected_generation: u64,
    relative_path: &str,
    title: Option<&str>,
) -> Result<LocalComputerArtifact, String> {
    computers.validate_target(workspace_id, agent_id)?;
    let authorization = command_scope(Some(workspace_id.to_string()), None, ScopeAccess::Write)?;
    let scope = computers.scope(workspace_id, agent_id)?;
    let extension = allowed_path(relative_path)?;
    let title = title_for(title, relative_path)?;
    computers.with_artifact_files(workspace_id, agent_id, expected_generation, |workspace| {
        let bytes = read_bounded(workspace, &workspace.join(relative_path))?;
        check_content(&bytes, extension)?;
        let id = random_id()?;
        let export_name = format!("mivlet-{}.{}", crate::paths::file_slug(&title), extension);
        let artifact = LocalComputerArtifact {
            kind: "computer-artifact".into(),
            version: 1,
            id: id.clone(),
            computer_id: scope.computer_id.clone(),
            title,
            mime_type: mime_for(extension)?.into(),
            size_bytes: bytes.len() as u64,
            relative_path: relative_path.into(),
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        let copy = write_copy(
            &scope.directory.join("artifacts"),
            &id,
            &export_name,
            &bytes,
        )?;
        let receipt = ArtifactReceipt {
            artifact: artifact.clone(),
            workspace_id: workspace_id.into(),
            agent_id: agent_id.into(),
            export_name,
            sha256: digest(&bytes),
        };
        let saved = crate::store::write_private_workspace_document(
            &scope.directory.join(format!("computer-{id}.json")),
            &authorization.private,
            &receipt,
        );
        if !matches!(saved, Ok(true)) {
            let _ = fs::remove_file(&copy);
            if let Some(parent) = copy.parent() {
                let _ = fs::remove_dir(parent);
            }
            return Err("Mivlet could not save the encrypted artifact receipt.".into());
        }
        Ok(artifact)
    })
}

/// Publish provider-generated PNG bytes directly into the same immutable,
/// encrypted-receipt artifact boundary used for computer-created files. The
/// active computer generation is checked before and after the write.
pub(crate) fn publish_generated_png(
    computers: &LocalComputerState,
    workspace_id: &str,
    agent_id: &str,
    expected_generation: u64,
    title: &str,
    bytes: &[u8],
) -> Result<LocalComputerArtifact, String> {
    computers.validate_target(workspace_id, agent_id)?;
    let authorization = command_scope(Some(workspace_id.to_string()), None, ScopeAccess::Write)?;
    let scope = computers.scope(workspace_id, agent_id)?;
    let title = title_for(Some(title), "generated.png")?;
    check_content(bytes, "png")?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("The generated image exceeds Mivlet's 25 MB artifact limit.".into());
    }
    computers.with_artifact_files(workspace_id, agent_id, expected_generation, |workspace| {
        let id = random_id()?;
        let workspace_directory_name = format!("generated-{id}");
        let workspace_directory = workspace.join(&workspace_directory_name);
        fs::create_dir(&workspace_directory)
            .map_err(|_| "Mivlet could not reserve a generated-image workspace folder.")?;
        let canonical_workspace = canonical(workspace)?;
        let canonical_workspace_directory = canonical(&workspace_directory)?;
        if !canonical_workspace_directory.starts_with(&canonical_workspace) {
            let _ = fs::remove_dir(&workspace_directory);
            return Err("The generated-image workspace path is unsafe.".into());
        }
        let export_name = format!("mivlet-{}.png", crate::paths::file_slug(&title));
        let workspace_file = canonical_workspace_directory.join(&export_name);
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.custom_flags(
                windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT,
            );
        }
        let mut file = options
            .open(&workspace_file)
            .map_err(|_| "Mivlet could not create the generated image in its workspace.")?;
        if !opened_path(&file)?.starts_with(&canonical_workspace) {
            let _ = fs::remove_file(&workspace_file);
            let _ = fs::remove_dir(&workspace_directory);
            return Err("The generated-image workspace path changed while writing.".into());
        }
        if file.write_all(bytes).and_then(|_| file.sync_all()).is_err() {
            let _ = fs::remove_file(&workspace_file);
            let _ = fs::remove_dir(&workspace_directory);
            return Err("Mivlet could not save the generated image in its workspace.".into());
        }
        drop(file);
        let relative_path = format!("{workspace_directory_name}/{export_name}");
        let artifact = LocalComputerArtifact {
            kind: "computer-artifact".into(),
            version: 1,
            id: id.clone(),
            computer_id: scope.computer_id.clone(),
            title,
            mime_type: "image/png".into(),
            size_bytes: bytes.len() as u64,
            relative_path,
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        let copy = match write_copy(&scope.directory.join("artifacts"), &id, &export_name, bytes) {
            Ok(copy) => copy,
            Err(error) => {
                let _ = fs::remove_file(&workspace_file);
                let _ = fs::remove_dir(&workspace_directory);
                return Err(error);
            }
        };
        let receipt = ArtifactReceipt {
            artifact: artifact.clone(),
            workspace_id: workspace_id.into(),
            agent_id: agent_id.into(),
            export_name,
            sha256: digest(bytes),
        };
        let saved = crate::store::write_private_workspace_document(
            &scope.directory.join(format!("computer-{id}.json")),
            &authorization.private,
            &receipt,
        );
        if !matches!(saved, Ok(true)) {
            let _ = fs::remove_file(&copy);
            if let Some(parent) = copy.parent() {
                let _ = fs::remove_dir(parent);
            }
            let _ = fs::remove_file(&workspace_file);
            let _ = fs::remove_dir(&workspace_directory);
            return Err("Mivlet could not save the encrypted image receipt.".into());
        }
        Ok(artifact)
    })
}

fn validate_receipt(
    receipt: &ArtifactReceipt,
    request: &OpenArtifactRequest,
    computer_id: &str,
) -> Result<(), String> {
    let extension = allowed_path(&receipt.artifact.relative_path)?;
    if receipt.workspace_id != request.workspace_id
        || receipt.agent_id != request.agent_id
        || receipt.artifact.id != request.artifact_id
        || !valid_id(&receipt.artifact.id)
        || receipt.artifact.computer_id != computer_id
        || receipt.artifact.kind != "computer-artifact"
        || receipt.artifact.version != 1
        || receipt.artifact.mime_type != mime_for(extension)?
        || receipt.artifact.size_bytes > MAX_BYTES
        || receipt.export_name
            != format!(
                "mivlet-{}.{}",
                crate::paths::file_slug(&receipt.artifact.title),
                extension
            )
    {
        return Err("This artifact does not belong to the selected computer.".into());
    }
    Ok(())
}

pub(crate) fn verified_artifact(
    computers: &LocalComputerState,
    request: &OpenArtifactRequest,
) -> Result<(ArtifactReceipt, Vec<u8>), String> {
    computers.validate_target(&request.workspace_id, &request.agent_id)?;
    computers.validate_viewer_generation(
        &request.workspace_id,
        &request.agent_id,
        request.expected_generation,
    )?;
    if !valid_id(&request.artifact_id) {
        return Err("This artifact identifier is invalid.".into());
    }
    let authorization = command_scope(Some(request.workspace_id.clone()), None, ScopeAccess::Read)?;
    let scope = computers.scope(&request.workspace_id, &request.agent_id)?;
    let receipt: ArtifactReceipt = crate::store::read_private_workspace_document(
        &scope
            .directory
            .join(format!("computer-{}.json", request.artifact_id)),
        &authorization.private,
    )?
    .ok_or("This artifact is no longer available on this installation.")?;
    validate_receipt(&receipt, request, &scope.computer_id)?;
    let root = scope.directory.join("artifacts");
    let bytes = read_bounded(
        &root,
        &root.join(&request.artifact_id).join(&receipt.export_name),
    )?;
    if bytes.len() as u64 != receipt.artifact.size_bytes || digest(&bytes) != receipt.sha256 {
        return Err("The published artifact has changed and cannot be opened.".into());
    }
    check_content(&bytes, allowed_path(&receipt.artifact.relative_path)?)?;
    computers.validate_viewer_generation(
        &request.workspace_id,
        &request.agent_id,
        request.expected_generation,
    )?;
    Ok((receipt, bytes))
}

pub(crate) fn verified_upload_artifact(
    computers: &LocalComputerState,
    workspace_id: &str,
    agent_id: &str,
    expected_generation: u64,
    artifact_id: &str,
) -> Result<VerifiedUploadArtifact, String> {
    let (receipt, bytes) = verified_artifact(
        computers,
        &OpenArtifactRequest {
            workspace_id: workspace_id.into(),
            agent_id: agent_id.into(),
            expected_generation,
            artifact_id: artifact_id.into(),
        },
    )?;
    // Drive's one-request multipart contract is for small files. Larger files
    // require a separately audited resumable workflow, never implicit retries.
    if bytes.len() > 5 * 1024 * 1024 {
        return Err("Drive uploads support deliverables up to 5 MB. Save this larger file and upload it manually.".into());
    }
    Ok(VerifiedUploadArtifact {
        bytes,
        file_name: receipt.export_name,
        mime_type: receipt.artifact.mime_type,
        sha256: receipt.sha256,
    })
}

/// Load an immutable, scoped raster artifact for an approved provider edit.
/// Filesystem paths and raw bytes never cross into the renderer or transcript.
pub(crate) fn verified_image_artifact(
    computers: &LocalComputerState,
    workspace_id: &str,
    agent_id: &str,
    expected_generation: u64,
    artifact_id: &str,
) -> Result<VerifiedImageArtifact, String> {
    let request = OpenArtifactRequest {
        workspace_id: workspace_id.into(),
        agent_id: agent_id.into(),
        artifact_id: artifact_id.into(),
        expected_generation,
    };
    let (receipt, bytes) = verified_artifact(computers, &request)?;
    let extension = match receipt.artifact.mime_type.as_str() {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        _ => return Err("Choose a verified PNG, JPEG, or WebP artifact to edit.".into()),
    };
    Ok(VerifiedImageArtifact {
        bytes,
        file_name: format!("source.{extension}"),
        mime_type: receipt.artifact.mime_type,
    })
}

#[tauri::command]
pub async fn local_computer_save_artifact(
    window: tauri::WebviewWindow,
    request: OpenArtifactRequest,
    computers: tauri::State<'_, Arc<LocalComputerState>>,
) -> Result<bool, String> {
    if window.label() != "main" {
        return Err("Save the artifact from its Mivlet conversation.".into());
    }
    let computers = computers.inner().clone();
    let ticket = computers
        .authority_for(&request.workspace_id, &request.agent_id)?
        .begin_viewer(request.expected_generation)?;
    let verification = computers.clone();
    let captured = request.clone();
    let receipt = tauri::async_runtime::spawn_blocking(move || {
        verified_artifact(&verification, &captured).map(|(receipt, _)| receipt)
    })
    .await
    .map_err(|_| "Mivlet could not prepare the artifact for saving.".to_string())??;
    ticket.check()?;
    let extension = allowed_path(&receipt.artifact.relative_path)?;
    // The native dialog exclusively owns the host destination. No model or
    // renderer argument can supply a path or authorize a silent host write.
    let selected = rfd::AsyncFileDialog::new()
        .set_title("Save generated file")
        .set_file_name(&receipt.export_name)
        .add_filter("Generated file", &[extension])
        .save_file()
        .await;
    let Some(selected) = selected else {
        return Ok(false);
    };
    ticket.check()?;
    tauri::async_runtime::spawn_blocking(move || {
        let (receipt, bytes) = verified_artifact(&computers, &request)?;
        let extension = allowed_path(&receipt.artifact.relative_path)?;
        let staged = stage_export(selected.path(), extension, &bytes)?;
        ticket.commit(|| commit_export(staged, selected.path()))
    })
    .await
    .map_err(|_| "Mivlet could not save the artifact.".to_string())?
}

#[tauri::command]
pub async fn local_computer_preview_artifact(
    window: tauri::WebviewWindow,
    request: OpenArtifactRequest,
    computers: tauri::State<'_, Arc<LocalComputerState>>,
) -> Result<ArtifactPreview, String> {
    if window.label() != "main" {
        return Err("Preview the artifact from its Mivlet conversation.".into());
    }
    let computers = computers.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (receipt, bytes) = verified_artifact(&computers, &request)?;
        let preview = preview_bytes(&receipt.artifact, &bytes);
        computers.validate_viewer_generation(
            &request.workspace_id,
            &request.agent_id,
            request.expected_generation,
        )?;
        Ok(preview)
    })
    .await
    .map_err(|_| "Mivlet could not preview the artifact.".to_string())?
}

#[cfg(windows)]
fn open_with_system(path: &Path) -> Result<(), String> {
    let operation: Vec<u16> = "open\0".encode_utf16().collect();
    // Shell associations expect a normal DOS path; Rust's filesystem APIs
    // canonicalize to the Win32 verbatim form. The native path is
    // receipt-selected, re-verified against the receipt right before this call,
    // and never comes from the renderer.
    let path = path
        .to_str()
        .ok_or("Windows cannot open this artifact path.")?;
    let path = path.strip_prefix(r"\\?\").unwrap_or(path);
    let path: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
    let result = unsafe {
        windows_sys::Win32::UI::Shell::ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            path.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
        )
    } as isize;
    if result <= 32 {
        return Err(
            "Windows could not open this file. Install an app for its file type and try again."
                .into(),
        );
    }
    Ok(())
}

#[cfg(not(windows))]
fn open_with_system(_path: &Path) -> Result<(), String> {
    Err("Artifact opening is currently supported by the Windows desktop app.".into())
}

#[tauri::command]
pub async fn local_computer_open_artifact(
    window: tauri::WebviewWindow,
    request: OpenArtifactRequest,
    computers: tauri::State<'_, Arc<LocalComputerState>>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Open the artifact from its Mivlet conversation.".into());
    }
    let computers = computers.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let prepared = prepare_open(&computers, &request)?;
        computers.validate_viewer_generation(
            &request.workspace_id,
            &request.agent_id,
            request.expected_generation,
        )?;
        verify_prepared_open(&computers, &request, &prepared)?;
        open_with_system(&prepared.path)
    })
    .await
    .map_err(|_| "Mivlet could not open the artifact.".to_string())?
}
