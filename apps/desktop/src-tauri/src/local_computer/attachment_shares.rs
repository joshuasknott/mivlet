//! Copy inherited uploads using native Work ancestry and exact saved bytes.
use super::*;
use crate::collaboration::{attachment_sources, models::WorkAttachment};
use std::io::Read;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkAttachmentRequest {
    pub(crate) workspace_id: String,
    pub(crate) agent_id: String,
    pub(crate) work_id: String,
    pub(crate) expected_work_generation: u32,
    pub(crate) expected_generation: u64,
    pub(crate) attachment_ids: Vec<String>,
}

fn saved_input(
    root: &Path,
    attachment: &WorkAttachment,
) -> Result<LocalComputerAttachmentStageInput, String> {
    let changed = "The inherited upload changed or is unavailable. Reattach it before continuing.";
    let (_, mime) = attachment_type(&attachment.name)?;
    let relative = attachment.relative_path.as_deref().ok_or(changed)?;
    let digest = attachment.sha256.as_deref().ok_or(changed)?;
    if attachment.availability != "workspace-file"
        || mime != attachment.mime_type
        || attachment.size_bytes == 0
        || attachment.size_bytes > MAX_ATTACHMENT_BYTES as u64
        || digest.len() != 64
        || !digest.bytes().all(|b| b.is_ascii_hexdigit())
        || !relative.starts_with("Attachments/")
        || relative.len() > 512
        || contains_unsafe_display_characters(relative)
    {
        return Err(changed.into());
    }
    let root = crate::paths::strict_canonicalize(root).map_err(|_| changed)?;
    let path = crate::tools::confine_path(relative, &root)?;
    let path = crate::paths::strict_canonicalize(&path).map_err(|_| changed)?;
    if !path.starts_with(root.join("Attachments")) {
        return Err(changed.into());
    }
    let file = std::fs::File::open(path).map_err(|_| changed)?;
    let metadata = file.metadata().map_err(|_| changed)?;
    if !metadata.is_file() || metadata.len() != attachment.size_bytes {
        return Err(changed.into());
    }
    let mut bytes = Vec::with_capacity(attachment.size_bytes as usize);
    file.take(attachment.size_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| changed)?;
    if bytes.len() as u64 != attachment.size_bytes || hex::encode(Sha256::digest(&bytes)) != digest
    {
        return Err(changed.into());
    }
    Ok(LocalComputerAttachmentStageInput {
        attachment_id: attachment.id.clone(),
        name: attachment.name.clone(),
        mime_type: mime.into(),
        content_base64: STANDARD.encode(bytes),
    })
}

#[tauri::command]
pub async fn local_computer_stage_work_attachments(
    app: AppHandle,
    request: WorkAttachmentRequest,
    state: State<'_, Arc<LocalComputerState>>,
) -> Result<Vec<LocalComputerAttachmentReceipt>, String> {
    state.validate_target(&request.workspace_id, &request.agent_id)?;
    let computers = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let ticket = computers.begin_agent_operation(
            &request.workspace_id,
            &request.agent_id,
            request.expected_generation,
        )?;
        ticket.check()?;
        let plan = attachment_sources::resolve(&app, &request)?;
        let mut inputs = Vec::with_capacity(plan.sources.len());
        for source in &plan.sources {
            ticket.check()?;
            computers.validate_target(&request.workspace_id, &source.agent_id)?;
            let source_root =
                computers.tool_workspace_root(&request.workspace_id, &source.agent_id)?;
            inputs.push(saved_input(&source_root, &source.attachment)?);
        }
        ticket.check()?;
        let workspace = computers.tool_workspace_root(&request.workspace_id, &request.agent_id)?;
        let computer_id = computers
            .scope(&request.workspace_id, &request.agent_id)?
            .computer_id;
        let (batch_directory, receipts) =
            write_staged_attachments(&workspace, &computer_id, &inputs, &ticket)?;
        // File work never holds the Work store lock. Re-read the full canonical
        // chain after copying; Stop/edit/reassignment discards this private batch.
        match attachment_sources::resolve(&app, &request) {
            Ok(current) if current == plan => {
                finish_staged_attachments(ticket, batch_directory, receipts)
            }
            _ => {
                let _ = std::fs::remove_dir_all(batch_directory);
                ticket.finish(Err(
                    "The task changed while recovering uploads. Refresh before continuing.".into(),
                ))
            }
        }
    })
    .await
    .map_err(|_| "The upload recovery task stopped unexpectedly.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn copies_only_exact_passive_upload_bytes_from_attachment_storage() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("Attachments/upload-batch");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("notes.txt"), b"text").unwrap();
        let mut saved = WorkAttachment {
            id: "upload-one".into(),
            name: "notes.txt".into(),
            mime_type: "text/plain".into(),
            size_bytes: 4,
            availability: "workspace-file".into(),
            relative_path: Some("Attachments/upload-batch/notes.txt".into()),
            sha256: Some(hex::encode(Sha256::digest(b"text"))),
            source_id: None,
        };
        assert_eq!(
            saved_input(root.path(), &saved).unwrap().content_base64,
            STANDARD.encode(b"text")
        );
        std::fs::write(directory.join("notes.txt"), b"else").unwrap();
        assert!(saved_input(root.path(), &saved).is_err());
        std::fs::write(directory.join("notes.txt"), b"text").unwrap();
        saved.relative_path = Some("Attachments/../../host.txt".into());
        assert!(saved_input(root.path(), &saved).is_err());
        saved.relative_path = Some("Attachments/upload-batch/notes.txt".into());
        saved.mime_type = "image/png".into();
        assert!(saved_input(root.path(), &saved).is_err());
    }
}
