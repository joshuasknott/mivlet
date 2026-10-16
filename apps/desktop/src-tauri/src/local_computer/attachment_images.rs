//! Durable image uploads stay in the exact agent workspace. Only validated,
//! hash-matched bytes are hydrated for a new deliberate turn, never history.
use super::*;
use std::io::Read;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageAttachmentRequest {
    workspace_id: String,
    agent_id: String,
    expected_generation: u64,
    attachment_id: String,
    name: String,
    mime_type: String,
    relative_path: String,
    size_bytes: u64,
    sha256: String,
}

fn read_image(
    root: &Path,
    request: &ImageAttachmentRequest,
) -> Result<crate::user_images::UserImageInput, String> {
    validate_scope_id(&request.attachment_id)?;
    let (_, mime) = attachment_type(&request.name)?;
    if !mime.starts_with("image/")
        || mime != request.mime_type
        || request.size_bytes == 0
        || request.size_bytes > 1024 * 1024
        || request.sha256.len() != 64
        || !request.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        || !request.relative_path.starts_with("Attachments/")
        || request.relative_path.len() > 512
        || contains_unsafe_display_characters(&request.relative_path)
    {
        return Err("The saved image reference is invalid. Reattach the image.".into());
    }
    let root = crate::paths::strict_canonicalize(root)
        .map_err(|_| "The image workspace is unavailable.")?;
    let confined = crate::tools::confine_path(&request.relative_path, &root)?;
    let path = crate::paths::strict_canonicalize(&confined)
        .map_err(|_| "The saved image is unavailable. Reattach it before continuing.")?;
    if !path.starts_with(root.join("Attachments")) {
        return Err("The image is outside this agent's attachment storage.".into());
    }
    let file = std::fs::File::open(path).map_err(|_| "The saved image could not be read.")?;
    let metadata = file
        .metadata()
        .map_err(|_| "The saved image could not be inspected.")?;
    if !metadata.is_file() || metadata.len() != request.size_bytes {
        return Err("The saved image changed. Reattach it before continuing.".into());
    }
    let mut bytes = Vec::with_capacity(request.size_bytes as usize);
    file.take(request.size_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "The saved image could not be read.")?;
    if bytes.len() as u64 != request.size_bytes
        || hex::encode(Sha256::digest(&bytes)) != request.sha256
    {
        return Err("The saved image changed. Reattach it before continuing.".into());
    }
    crate::user_images::from_saved_bytes(&request.attachment_id, &request.name, mime, &bytes)
}

#[tauri::command]
pub async fn local_computer_restore_image_attachment(
    request: ImageAttachmentRequest,
    state: State<'_, Arc<LocalComputerState>>,
) -> Result<crate::user_images::UserImageInput, String> {
    state.validate_target(&request.workspace_id, &request.agent_id)?;
    let computers = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let ticket = computers.begin_agent_operation(
            &request.workspace_id,
            &request.agent_id,
            request.expected_generation,
        )?;
        ticket.check()?;
        let result = computers
            .tool_workspace_root(&request.workspace_id, &request.agent_id)
            .and_then(|root| read_image(&root, &request));
        ticket.finish(result)
    })
    .await
    .map_err(|_| "The image restore task stopped unexpectedly.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, ImageAttachmentRequest, Vec<u8>) {
        let root = tempfile::tempdir().unwrap();
        let bytes = STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=").unwrap();
        let relative_path = "Attachments/upload-test/photo.png";
        std::fs::create_dir_all(root.path().join("Attachments/upload-test")).unwrap();
        std::fs::write(root.path().join(relative_path), &bytes).unwrap();
        let request = ImageAttachmentRequest {
            workspace_id: "workspace".into(),
            agent_id: "agent".into(),
            expected_generation: 1,
            attachment_id: "image-1".into(),
            name: "photo.png".into(),
            mime_type: "image/png".into(),
            relative_path: relative_path.into(),
            size_bytes: bytes.len() as u64,
            sha256: hex::encode(Sha256::digest(&bytes)),
        };
        (root, request, bytes)
    }

    #[test]
    fn restores_exact_saved_image_without_receipt_or_historical_pixels() {
        let (root, request, bytes) = fixture();
        let image = read_image(root.path(), &request).unwrap();
        assert_eq!((image.width, image.height), (1, 1));
        assert_eq!(
            image.data_url,
            format!("data:image/png;base64,{}", STANDARD.encode(bytes))
        );
        let other = tempfile::tempdir().unwrap();
        assert!(read_image(other.path(), &request).is_err());
    }

    #[test]
    fn rejects_changed_bytes_wrong_media_and_escaping_paths() {
        let (root, mut request, mut bytes) = fixture();
        bytes[0] ^= 1;
        std::fs::write(root.path().join(&request.relative_path), bytes).unwrap();
        assert!(read_image(root.path(), &request)
            .unwrap_err()
            .contains("changed"));
        request.mime_type = "image/jpeg".into();
        assert!(read_image(root.path(), &request).is_err());
        request.mime_type = "image/png".into();
        request.relative_path = "Attachments/../../outside.png".into();
        assert!(read_image(root.path(), &request).is_err());
    }
}
