//! Explicit, approval-gated publication of generated workspace files. Receipts
//! live in the encrypted store; immutable copies are outside the guest mount.

use super::LocalComputerState;
use crate::authorized_scope::{command_scope, ScopeAccess};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

const MAX_BYTES: u64 = 25 * 1024 * 1024;
const MAX_PUBLICATIONS: usize = 256;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalComputerArtifact {
    kind: String,
    version: u32,
    id: String,
    computer_id: String,
    title: String,
    mime_type: String,
    size_bytes: u64,
    relative_path: String,
    created_at: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArtifactReceipt {
    artifact: LocalComputerArtifact,
    workspace_id: String,
    agent_id: String,
    export_name: String,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenArtifactRequest {
    workspace_id: String,
    agent_id: String,
    artifact_id: String,
    expected_generation: u64,
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
        .map_err(|_| "Fable could not create a private artifact identifier.")?;
    Ok(format!("artifact-{}", hex::encode(bytes)))
}

fn allowed_path(relative: &str) -> Result<&str, String> {
    if relative.is_empty()
        || relative.len() > 512
        || relative.contains(['\\', ':'])
        || relative.chars().any(|c| {
            c.is_control() || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
        || relative.split('/').any(|part| {
            part.is_empty()
                || part.starts_with('.')
                || part.ends_with([' ', '.'])
                || part.starts_with(' ')
        })
    {
        return Err("Choose a generated file inside the computer's Workspace folder.".into());
    }
    let extension = relative
        .rsplit_once('.')
        .map(|(_, extension)| extension)
        .unwrap_or("");
    mime_for(extension)?;
    Ok(extension)
}

fn mime_for(extension: &str) -> Result<&'static str, String> {
    match extension {
        "docx" => Ok("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
        "xlsx" => Ok("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
        "pdf" => Err("PDF publication is not available yet. Export this result as DOCX, text, or a PNG image instead.".into()),
        "csv" => Ok("text/csv"),
        "txt" => Ok("text/plain"),
        "md" => Ok("text/markdown"),
        "png" => Ok("image/png"),
        "jpg" | "jpeg" => Ok("image/jpeg"),
        "gif" => Ok("image/gif"),
        "webp" => Ok("image/webp"),
        _ => Err("Publish a DOCX, XLSX, CSV, text, Markdown, or raster image file.".into()),
    }
}

fn check_content(bytes: &[u8], extension: &str) -> Result<(), String> {
    mime_for(extension)?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("Artifacts must be at most 25 MB.".into());
    }
    let valid = match extension {
        "txt" | "md" | "csv" => !bytes.contains(&0) && std::str::from_utf8(bytes).is_ok(),
        "png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "jpg" | "jpeg" => bytes.starts_with(b"\xff\xd8\xff"),
        "gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
        "docx" | "xlsx" => {
            let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
                .map_err(|_| "The document is not a supported Office file.")?;
            if archive.len() > 2000 {
                return Err("The document contains too many archive entries.".into());
            }
            let mut size = 0u64;
            let mut content_types = false;
            let mut document = false;
            for index in 0..archive.len() {
                let mut entry = archive
                    .by_index(index)
                    .map_err(|_| "The Office document could not be checked.")?;
                size = size.saturating_add(entry.size());
                let name = entry.name().to_ascii_lowercase();
                if size > 200 * 1024 * 1024
                    || entry.enclosed_name().is_none()
                    || name.contains("vbaproject")
                    || name.contains("activex/")
                    || name.contains("embeddings/")
                {
                    return Err(
                        "Publish an Office document without macros or embedded programs.".into(),
                    );
                }
                if name == "[content_types].xml" {
                    if entry.size() > 128 * 1024 {
                        return Err("The Office document metadata is too large.".into());
                    }
                    let mut xml = String::new();
                    entry
                        .by_ref()
                        .take(128 * 1024 + 1)
                        .read_to_string(&mut xml)
                        .map_err(|_| "The Office document metadata is invalid.")?;
                    if xml.len() > 128 * 1024 || xml.to_ascii_lowercase().contains("macroenabled") {
                        return Err("Macro-enabled Office documents cannot be published.".into());
                    }
                    content_types = true;
                }
                document |= name
                    == if extension == "docx" {
                        "word/document.xml"
                    } else {
                        "xl/workbook.xml"
                    };
            }
            content_types && document
        }
        _ => false,
    };
    if !valid {
        return Err("The file contents do not match a supported artifact type.".into());
    }
    Ok(())
}

fn canonical(path: &Path) -> Result<PathBuf, String> {
    crate::paths::strict_canonicalize(path)
        .map_err(|_| "The artifact path is unavailable or contains a link.".into())
}

// Validate the actual opened handle before reading. Rechecking path names alone
// would allow a guest to swap a parent directory after canonicalization.
#[cfg(windows)]
fn opened_path(file: &File) -> Result<PathBuf, String> {
    use std::os::windows::{ffi::OsStringExt, io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;
    let mut buffer = vec![0u16; 32768];
    let length = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            0,
        )
    } as usize;
    if length == 0 || length >= buffer.len() {
        return Err("The artifact file handle could not be verified.".into());
    }
    Ok(PathBuf::from(std::ffi::OsString::from_wide(
        &buffer[..length],
    )))
}

#[cfg(target_os = "linux")]
fn opened_path(file: &File) -> Result<PathBuf, String> {
    use std::os::fd::AsRawFd;
    fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd()))
        .map_err(|_| "The artifact file handle could not be verified.".into())
}

#[cfg(not(any(windows, target_os = "linux")))]
fn opened_path(_file: &File) -> Result<PathBuf, String> {
    Err("Secure artifact delivery is not supported on this operating system yet.".into())
}

pub(super) fn read_bounded(root: &Path, path: &Path) -> Result<Vec<u8>, String> {
    let root = canonical(root)?;
    let source = canonical(path)?;
    if !source.starts_with(&root) {
        return Err("The artifact must remain inside its computer workspace.".into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options
            .share_mode(0)
            .custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let mut file = options.open(&source).map_err(|_| {
        "The artifact is unavailable or is still being written. Save it and try again."
    })?;
    if !opened_path(&file)?.starts_with(&root) || canonical(&source)? != source {
        return Err("The artifact path changed while opening it.".into());
    }
    let metadata = file
        .metadata()
        .map_err(|_| "The artifact metadata is unavailable.")?;
    if !metadata.is_file() || metadata.len() > MAX_BYTES {
        return Err("Choose a regular file of at most 25 MB.".into());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    std::io::Read::by_ref(&mut file)
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "The artifact could not be read.")?;
    if bytes.len() as u64 != metadata.len() || bytes.len() as u64 > MAX_BYTES {
        return Err("The file changed while publishing. Save it and try again.".into());
    }
    Ok(bytes)
}

fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn title_for(title: Option<&str>, relative: &str) -> Result<String, String> {
    let value = title
        .unwrap_or_else(|| relative.rsplit('/').next().unwrap_or(relative))
        .trim();
    if value.is_empty()
        || value.len() > 160
        || value.chars().any(|c| {
            c.is_control() || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
    {
        return Err("Use an artifact title of 1–160 characters without control characters.".into());
    }
    Ok(value.to_string())
}

fn write_copy(directory: &Path, id: &str, name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    fs::create_dir_all(directory).map_err(|_| "Fable could not create its artifact folder.")?;
    let directory = canonical(directory)?;
    if fs::read_dir(&directory)
        .map_err(|_| "The artifact folder is unavailable.")?
        .take(MAX_PUBLICATIONS + 1)
        .count()
        >= MAX_PUBLICATIONS
    {
        return Err("This computer's artifact folder is full. Remove old local artifacts before publishing more.".into());
    }
    let target = directory.join(id);
    fs::create_dir(&target).map_err(|_| "Fable could not reserve an artifact file.")?;
    let file_path = target.join(name);
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&file_path)
            .map_err(|_| "Fable could not create the artifact copy.")?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "Fable could not save the artifact copy.")?;
        Ok(file_path.clone())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&file_path);
        let _ = fs::remove_dir(&target);
    }
    result
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
    computers.with_agent_files(workspace_id, agent_id, expected_generation, |workspace| {
        let bytes = read_bounded(workspace, &workspace.join(relative_path))?;
        check_content(&bytes, extension)?;
        let id = random_id()?;
        let export_name = format!("fable-{}.{}", crate::paths::file_slug(&title), extension);
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
            return Err("Fable could not save the encrypted artifact receipt.".into());
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
                "fable-{}.{}",
                crate::paths::file_slug(&receipt.artifact.title),
                extension
            )
    {
        return Err("This artifact does not belong to the selected computer.".into());
    }
    Ok(())
}

fn prepare_open(
    computers: &LocalComputerState,
    request: &OpenArtifactRequest,
) -> Result<PathBuf, String> {
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
    // Editors can save their own copy without altering the published result.
    write_copy(
        &scope.directory.join("artifact-open"),
        &random_id()?,
        &receipt.export_name,
        &bytes,
    )
}

#[cfg(windows)]
fn open_with_system(path: &Path) -> Result<(), String> {
    let operation: Vec<u16> = "open\0".encode_utf16().collect();
    // Shell associations expect a normal DOS path; Rust's filesystem APIs
    // canonicalize to the Win32 verbatim form. The native path is already
    // receipt-selected and checked, and never comes from the renderer.
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
        return Err("Open the artifact from its Fable conversation.".into());
    }
    let computers = computers.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let path = prepare_open(&computers, &request)?;
        computers.validate_viewer_generation(
            &request.workspace_id,
            &request.agent_id,
            request.expected_generation,
        )?;
        open_with_system(&path)
    })
    .await
    .map_err(|_| "Fable could not open the artifact.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_reject_host_traversal_secrets_and_executable_types() {
        for path in [
            "../report.docx",
            "/report.docx",
            "C:/report.docx",
            "a\\report.docx",
            ".config/report.txt",
            "a/./report.docx",
            "a/../report.docx",
            "a//report.docx",
            "report.docx:stream",
            "report.html",
            "report.svg",
            "report.exe",
            "report.xlsm",
            "a /report.txt",
            "report.docx.",
        ] {
            assert!(allowed_path(path).is_err(), "accepted {path}");
        }
        for path in [
            "reports/report.docx",
            "report.docx",
            "result.xlsx",
            "data.csv",
            "notes.md",
            "image.png",
        ] {
            assert!(allowed_path(path).is_ok());
        }
    }

    #[test]
    fn content_must_match_allowlisted_type() {
        assert!(check_content(b"MZ executable", "pdf").is_err());
        assert!(check_content(b"text\0hidden", "txt").is_err());
        assert!(check_content(b"%PDF-1.7\nfixture", "pdf").is_err());
        assert!(check_content(b"hello,world\n1,2", "csv").is_ok());
        assert!(check_content(b"not a zip", "docx").is_err());
        assert!(check_content(b"<svg/>", "svg").is_err());
    }

    #[test]
    fn pdf_with_automatic_javascript_is_not_publishable_or_openable() {
        // The old signature-only check accepted this active PDF. No PDF is
        // dispatched to a host reader until a real sanitizer is available.
        let active_pdf = b"%PDF-1.7\n1 0 obj << /Type /Catalog /OpenAction 2 0 R >> endobj\n2 0 obj << /S /JavaScript /JS (app.alert('opened')) >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF";
        assert!(check_content(active_pdf, "pdf")
            .unwrap_err()
            .contains("Export this result as DOCX"));
        assert!(allowed_path("report.pdf").is_err());
        assert!(mime_for("pdf").is_err());
    }

    #[test]
    fn office_macros_and_embedded_programs_are_rejected() {
        fn office(extra: Option<&str>) -> Vec<u8> {
            let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
            for name in [
                Some("[Content_Types].xml"),
                Some("word/document.xml"),
                extra,
            ]
            .into_iter()
            .flatten()
            {
                writer
                    .start_file(name, zip::write::SimpleFileOptions::default())
                    .unwrap();
                writer.write_all(b"<fixture/>").unwrap();
            }
            writer.finish().unwrap().into_inner()
        }
        assert!(check_content(&office(None), "docx").is_ok());
        assert!(check_content(&office(None), "xlsx").is_err());
        assert!(check_content(&office(Some("word/vbaProject.bin")), "docx").is_err());
        assert!(check_content(&office(Some("word/embeddings/evil.bin")), "docx").is_err());
    }

    #[test]
    fn actual_files_stay_in_root_and_publication_is_immutable() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let source = workspace.join("report.txt");
        fs::write(&source, b"first").unwrap();
        let bytes = read_bounded(&workspace, &source).unwrap();
        let copy = write_copy(
            &temp.path().join("artifacts"),
            &random_id().unwrap(),
            "report.txt",
            &bytes,
        )
        .unwrap();
        fs::write(&source, b"second").unwrap();
        assert_eq!(
            read_bounded(&temp.path().join("artifacts"), &copy).unwrap(),
            b"first"
        );
        assert!(read_bounded(&workspace, &copy).is_err());
        assert_ne!(digest(b"first"), digest(b"second"));
    }

    #[test]
    fn opaque_ids_and_receipt_scope_are_checked() {
        let id = random_id().unwrap();
        assert!(valid_id(&id));
        assert!(!valid_id("artifact-../file"));
        let mut request = OpenArtifactRequest {
            workspace_id: "workspace".into(),
            agent_id: "agent-a".into(),
            artifact_id: id.clone(),
            expected_generation: 1,
        };
        let receipt = ArtifactReceipt {
            artifact: LocalComputerArtifact {
                kind: "computer-artifact".into(),
                version: 1,
                id,
                computer_id: "computer".into(),
                title: "Report".into(),
                mime_type: "text/plain".into(),
                size_bytes: 5,
                relative_path: "report.txt".into(),
                created_at: chrono::Utc::now().to_rfc3339(),
            },
            workspace_id: "workspace".into(),
            agent_id: "agent-a".into(),
            export_name: "fable-report.txt".into(),
            sha256: digest(b"first"),
        };
        assert!(validate_receipt(&receipt, &request, "computer").is_ok());
        request.agent_id = "agent-b".into();
        assert!(validate_receipt(&receipt, &request, "computer").is_err());
    }
}
