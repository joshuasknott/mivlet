//! Receipt-bound launch copies and bounded artifact previews.

use serde::Serialize;
use std::{
    io::Write,
    path::{Path, PathBuf},
};

use super::{
    storage::{digest, read_bounded, write_copy},
    validation::allowed_path,
    ArtifactReceipt, LocalComputerArtifact, LocalComputerState, OpenArtifactRequest,
};

/// A launch copy prepared from a receipt-verified published artifact. The
/// receipt travels with the copy so the exact file can be re-verified at the
/// moment it is opened.
pub(crate) struct PreparedArtifactOpen {
    pub(crate) path: PathBuf,
    pub(crate) receipt: ArtifactReceipt,
}

/// Write the verified bytes to a fresh private launch copy. Editors can save
/// their own copy without altering the published result.
pub(crate) fn prepare_open_copy(
    open_root: &Path,
    receipt: &ArtifactReceipt,
    bytes: &[u8],
) -> Result<PathBuf, String> {
    write_copy(open_root, &super::random_id()?, &receipt.export_name, bytes)
}

pub(crate) fn prepare_open(
    computers: &LocalComputerState,
    request: &OpenArtifactRequest,
) -> Result<PreparedArtifactOpen, String> {
    let (receipt, bytes) = super::verified_artifact(computers, request)?;
    let scope = computers.scope(&request.workspace_id, &request.agent_id)?;
    let path = prepare_open_copy(&scope.directory.join("artifact-open"), &receipt, &bytes)?;
    Ok(PreparedArtifactOpen { path, receipt })
}

/// Re-verify the exact launch copy against its receipt immediately before the
/// system opens it. This detects replacement since preparation, but does not
/// eliminate the race between this read and the application's path-based open.
/// Reading through `read_bounded` keeps
/// the same containment, reparse-point and stale-handle checks used for every
/// artifact read.
pub(crate) fn verify_prepared_copy(
    open_root: &Path,
    path: &Path,
    receipt: &ArtifactReceipt,
) -> Result<(), String> {
    let bytes = read_bounded(open_root, path)?;
    if bytes.len() as u64 != receipt.artifact.size_bytes || digest(&bytes) != receipt.sha256 {
        return Err(
            "The prepared artifact changed and cannot be opened. Try opening it again.".into(),
        );
    }
    Ok(())
}

pub(crate) fn verify_prepared_open(
    computers: &LocalComputerState,
    request: &OpenArtifactRequest,
    prepared: &PreparedArtifactOpen,
) -> Result<(), String> {
    let scope = computers.scope(&request.workspace_id, &request.agent_id)?;
    verify_prepared_copy(
        &scope.directory.join("artifact-open"),
        &prepared.path,
        &prepared.receipt,
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactPreview {
    pub(crate) artifact_id: String,
    pub(crate) mime_type: String,
    pub(crate) text: Option<String>,
    pub(crate) image_data_url: Option<String>,
    pub(crate) pdf_base64: Option<String>,
    pub(super) office: Option<super::super::office_preview::OfficePreview>,
    pub(crate) truncated: bool,
}

pub(crate) fn preview_bytes(artifact: &LocalComputerArtifact, bytes: &[u8]) -> ArtifactPreview {
    use base64::Engine;
    let mut preview = ArtifactPreview {
        artifact_id: artifact.id.clone(),
        mime_type: artifact.mime_type.clone(),
        text: None,
        image_data_url: None,
        pdf_base64: None,
        office: None,
        truncated: false,
    };
    if artifact.mime_type.starts_with("text/") || artifact.mime_type == "application/json" {
        let text = String::from_utf8_lossy(bytes);
        let mut end = text.len().min(256 * 1024);
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        preview.truncated = end < text.len();
        preview.text = Some(text[..end].to_string());
    } else if artifact.mime_type.starts_with("image/") && bytes.len() <= 8 * 1024 * 1024 {
        preview.image_data_url = Some(format!(
            "data:{};base64,{}",
            artifact.mime_type,
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ));
    } else if artifact.mime_type == "application/pdf" && bytes.len() <= 8 * 1024 * 1024 {
        preview.pdf_base64 = Some(base64::engine::general_purpose::STANDARD.encode(bytes));
    } else if let Ok(extension @ ("docx" | "xlsx" | "pptx")) = allowed_path(&artifact.relative_path)
    {
        if let Some((office, truncated)) = super::super::office_preview::preview(bytes, extension) {
            preview.office = Some(office);
            preview.truncated = truncated;
        }
    }
    preview
}

pub(crate) fn stage_export(
    destination: &Path,
    extension: &str,
    bytes: &[u8],
) -> Result<tempfile::NamedTempFile, String> {
    if destination.extension().and_then(|value| value.to_str()) != Some(extension) {
        return Err(format!("Save this file with its .{extension} extension."));
    }
    if destination.exists() {
        return Err(
            "Choose a new file name. Saving an artifact keeps existing files intact.".into(),
        );
    }
    let mut staged =
        tempfile::NamedTempFile::new_in(destination.parent().ok_or("Choose a save folder.")?)
            .map_err(|_| "Mivlet could not prepare the file in that folder.")?;
    staged
        .write_all(bytes)
        .and_then(|_| staged.as_file().sync_all())
        .map_err(|_| "Mivlet could not save the file in that folder.")?;
    Ok(staged)
}

pub(crate) fn commit_export(
    staged: tempfile::NamedTempFile,
    destination: &Path,
) -> Result<bool, String> {
    staged
        .persist_noclobber(destination)
        .map_err(|_| "Mivlet could not finish saving. Choose a new file name and try again.")?;
    Ok(true)
}
