//! Explicit, approval-gated publication of generated workspace files. Receipts
//! live in the encrypted store; immutable copies are outside the guest mount.

use super::LocalComputerState;
use crate::authorized_scope::{command_scope, ScopeAccess};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    panic::{catch_unwind, AssertUnwindSafe},
    path::{Path, PathBuf},
    sync::Arc,
};

const MAX_BYTES: u64 = 25 * 1024 * 1024;
const MAX_PUBLICATIONS: usize = 256;
const MAX_OFFICE_EXPANDED_BYTES: u64 = 200 * 1024 * 1024;
const MAX_PDF_OBJECTS: usize = 100_000;
const MAX_PDF_PAGES: usize = 10_000;
const MAX_PDF_NODES: usize = 1_000_000;
const MAX_PDF_DEPTH: usize = 64;
const MAX_PDF_DECOMPRESSED_STREAM_BYTES: usize = 16 * 1024 * 1024;

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

pub(crate) struct VerifiedImageArtifact {
    pub(crate) bytes: Vec<u8>,
    pub(crate) file_name: String,
    pub(crate) mime_type: String,
}

pub(crate) struct VerifiedProjectArtifact {
    pub(crate) bytes: Vec<u8>,
    pub(crate) artifact_id: String,
    pub(crate) agent_id: String,
    pub(crate) export_name: String,
    pub(crate) title: String,
    pub(crate) mime_type: String,
    pub(crate) sha256: String,
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
        "pptx" => Ok("application/vnd.openxmlformats-officedocument.presentationml.presentation"),
        "pdf" => Ok("application/pdf"),
        "csv" => Ok("text/csv"),
        "txt" => Ok("text/plain"),
        "md" => Ok("text/markdown"),
        "png" => Ok("image/png"),
        "jpg" | "jpeg" => Ok("image/jpeg"),
        "gif" => Ok("image/gif"),
        "webp" => Ok("image/webp"),
        _ => Err(
            "Publish a PDF, DOCX, XLSX, PPTX, CSV, text, Markdown, or raster image file.".into(),
        ),
    }
}

fn contains_ascii_case_insensitive(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window.eq_ignore_ascii_case(needle))
}

fn check_office_metadata_xml(xml: &[u8], description: &str) -> Result<(), String> {
    if std::str::from_utf8(xml).is_err()
        || contains_ascii_case_insensitive(xml, b"<!")
        || xml.contains(&b'&')
    {
        return Err(format!("The Office {description} metadata is invalid."));
    }
    Ok(())
}

fn check_office_relationships(
    xml: &[u8],
    is_root: bool,
    expected_main_part: &str,
) -> Result<bool, String> {
    use quick_xml::{events::Event, Reader, XmlVersion};

    let mut reader = Reader::from_reader(xml);
    reader.config_mut().trim_text(true);
    let mut root_main_relationship = false;
    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) | Ok(Event::Empty(element))
                if element.local_name().as_ref() == "Relationship" =>
            {
                let mut target = None;
                let mut target_mode = None;
                let mut relationship_type = None;
                for attribute in element.attributes().with_checks(true) {
                    let attribute =
                        attribute.map_err(|_| "The Office relationship metadata is invalid.")?;
                    let value = attribute
                        .normalized_value(XmlVersion::Implicit1_0)
                        .map_err(|_| "The Office relationship metadata is invalid.")?
                        .into_owned();
                    match attribute.key.local_name().as_ref() {
                        "Target" => target = Some(value),
                        "TargetMode" => target_mode = Some(value),
                        "Type" => relationship_type = Some(value),
                        _ => {}
                    }
                }
                if target_mode.is_some() {
                    return Err(
                        "Office documents with external relationships cannot be published.".into(),
                    );
                }
                if let Some(target) = target.as_deref() {
                    let lower = target.to_ascii_lowercase();
                    if lower.starts_with("http:")
                        || lower.starts_with("https:")
                        || lower.starts_with("file:")
                        || lower.starts_with("mailto:")
                        || lower.starts_with("//")
                        || lower.contains('\\')
                    {
                        return Err(
                            "Office documents with external relationships cannot be published."
                                .into(),
                        );
                    }
                }
                root_main_relationship |= is_root
                    && relationship_type
                        .as_deref()
                        .is_some_and(|value| value.ends_with("/officeDocument"))
                    && target.as_deref() == Some(expected_main_part);
            }
            Ok(Event::DocType(_)) => {
                return Err("The Office relationship metadata is invalid.".into())
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(_) => return Err("The Office relationship metadata is invalid.".into()),
        }
    }
    Ok(root_main_relationship)
}

fn check_office(bytes: &[u8], extension: &str) -> Result<bool, String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|_| "The document is not a supported Office file.")?;
    if archive.len() > 2000 {
        return Err("The document contains too many archive entries.".into());
    }
    let (main_part, main_content_type) = match extension {
        "docx" => (
            "word/document.xml",
            b"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
                .as_slice(),
        ),
        "xlsx" => (
            "xl/workbook.xml",
            b"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
                .as_slice(),
        ),
        "pptx" => (
            "ppt/presentation.xml",
            b"application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"
                .as_slice(),
        ),
        _ => return Ok(false),
    };
    let mut expanded_size = 0u64;
    let mut names = HashSet::new();
    let mut content_types = false;
    let mut root_relationships = false;
    let mut main_document = false;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|_| "The Office document could not be checked.")?;
        expanded_size = expanded_size.saturating_add(entry.size());
        let name = entry.name().to_ascii_lowercase();
        if expanded_size > MAX_OFFICE_EXPANDED_BYTES
            || entry.enclosed_name().is_none()
            || entry.encrypted()
            || name.contains('\\')
            || !names.insert(name.clone())
            || ((!entry.is_dir() || entry.size() != 0)
                && [
                    "vbaproject",
                    "activex/",
                    "embeddings/",
                    "externallinks/",
                    "customui/",
                    "webextensions/",
                    "ctrlprops/",
                    "attachedtoolbars",
                    "macrosheets/",
                ]
                .iter()
                .any(|blocked| name.contains(blocked)))
        {
            return Err(
                "Publish an Office document without macros, embedded programs, or external content."
                    .into(),
            );
        }
        if name == "[content_types].xml" {
            if entry.size() > 128 * 1024 {
                return Err("The Office document metadata is too large.".into());
            }
            let mut xml = Vec::new();
            entry
                .by_ref()
                .take(128 * 1024 + 1)
                .read_to_end(&mut xml)
                .map_err(|_| "The Office document metadata is invalid.")?;
            check_office_metadata_xml(&xml, "document")?;
            if xml.len() > 128 * 1024
                || !contains_ascii_case_insensitive(&xml, main_content_type)
                || [
                    b"macroenabled".as_slice(),
                    b"vba".as_slice(),
                    b"activex".as_slice(),
                    b"oleobject".as_slice(),
                    b"application/vnd.ms-package".as_slice(),
                ]
                .iter()
                .any(|blocked| contains_ascii_case_insensitive(&xml, blocked))
            {
                return Err("Macro-enabled or embedded Office content cannot be published.".into());
            }
            content_types = true;
        } else if name.ends_with(".rels") {
            if entry.size() > 1024 * 1024 {
                return Err("The Office relationship metadata is too large.".into());
            }
            let mut xml = Vec::new();
            entry
                .by_ref()
                .take(1024 * 1024 + 1)
                .read_to_end(&mut xml)
                .map_err(|_| "The Office relationship metadata is invalid.")?;
            check_office_metadata_xml(&xml, "relationship")?;
            root_relationships |=
                check_office_relationships(&xml, name == "_rels/.rels", main_part)?;
        }
        main_document |= name == main_part;
    }
    Ok(content_types && root_relationships && main_document)
}

fn unsafe_pdf_name(name: &[u8]) -> bool {
    [
        b"JavaScript".as_slice(),
        b"Action".as_slice(),
        b"Launch".as_slice(),
        b"EmbeddedFile".as_slice(),
        b"Filespec".as_slice(),
        b"RichMedia".as_slice(),
        b"Rendition".as_slice(),
        b"Movie".as_slice(),
        b"Sound".as_slice(),
        b"GoToR".as_slice(),
        b"GoToE".as_slice(),
        b"GoTo".as_slice(),
        b"Thread".as_slice(),
        b"Named".as_slice(),
        b"SetOCGState".as_slice(),
        b"Trans".as_slice(),
        b"GoTo3DView".as_slice(),
        b"Hide".as_slice(),
        b"ResetForm".as_slice(),
        b"URI".as_slice(),
        b"SubmitForm".as_slice(),
        b"ImportData".as_slice(),
        b"Crypt".as_slice(),
        b"PS".as_slice(),
    ]
    .contains(&name)
}

fn unsafe_pdf_key(key: &[u8]) -> bool {
    [
        b"OpenAction".as_slice(),
        b"AA".as_slice(),
        b"JS".as_slice(),
        b"JavaScript".as_slice(),
        b"EmbeddedFiles".as_slice(),
        b"EF".as_slice(),
        b"AF".as_slice(),
        b"Ref".as_slice(),
        b"URL".as_slice(),
        b"XFA".as_slice(),
        b"AcroForm".as_slice(),
        b"Collection".as_slice(),
        b"RichMediaContent".as_slice(),
        b"RichMediaSettings".as_slice(),
    ]
    .contains(&key)
}

fn safe_pdf_destination(object: &lopdf::Object) -> bool {
    let lopdf::Object::Array(items) = object else {
        return false;
    };
    if !matches!(
        items.first(),
        Some(lopdf::Object::Reference(_)) | Some(lopdf::Object::Integer(_))
    ) {
        return false;
    }
    let Some(lopdf::Object::Name(kind)) = items.get(1) else {
        return false;
    };
    let expected_len = match kind.as_slice() {
        b"Fit" | b"FitB" => 2,
        b"FitH" | b"FitV" | b"FitBH" | b"FitBV" => 3,
        b"XYZ" => 5,
        b"FitR" => 6,
        _ => return false,
    };
    items.len() == expected_len
        && items[2..].iter().all(|item| {
            matches!(
                item,
                lopdf::Object::Null | lopdf::Object::Integer(_) | lopdf::Object::Real(_)
            )
        })
}

fn check_pdf_object(object: &lopdf::Object, nodes: &mut usize, depth: usize) -> Result<(), String> {
    *nodes = nodes.saturating_add(1);
    if *nodes > MAX_PDF_NODES || depth > MAX_PDF_DEPTH {
        return Err("The PDF contains too many structural elements.".into());
    }
    match object {
        lopdf::Object::Name(name) if unsafe_pdf_name(name) => {
            Err("PDFs with actions, scripts, or embedded content cannot be published.".into())
        }
        lopdf::Object::Array(items) => {
            for item in items {
                check_pdf_object(item, nodes, depth + 1)?;
            }
            Ok(())
        }
        lopdf::Object::Dictionary(dictionary) => {
            for (key, value) in dictionary.iter() {
                if key == b"OpenAction" && safe_pdf_destination(value) {
                    check_pdf_object(value, nodes, depth + 1)?;
                    continue;
                }
                if unsafe_pdf_key(key) {
                    return Err(
                        "PDFs with actions, scripts, forms, or embedded content cannot be published."
                            .into(),
                    );
                }
                check_pdf_object(value, nodes, depth + 1)?;
            }
            Ok(())
        }
        lopdf::Object::Stream(stream) => {
            if stream.dict.has(b"F")
                || stream.dict.has(b"FFilter")
                || stream.dict.has(b"FDecodeParms")
            {
                return Err("PDFs with external streams cannot be published.".into());
            }
            check_pdf_object(
                &lopdf::Object::Dictionary(stream.dict.clone()),
                nodes,
                depth + 1,
            )
        }
        _ => Ok(()),
    }
}

fn check_pdf_document(bytes: &[u8]) -> Result<bool, String> {
    if bytes.len() as u64 > MAX_BYTES {
        return Err("Artifacts must be at most 25 MB.".into());
    }
    if !bytes.starts_with(b"%PDF-")
        || bytes
            .windows(5)
            .filter(|window| *window == b"%PDF-")
            .count()
            != 1
        || bytes
            .windows(5)
            .filter(|window| *window == b"%%EOF")
            .count()
            != 1
        || bytes
            .windows(5)
            .rposition(|window| window == b"%%EOF")
            .is_none_or(|end| !bytes[end + 5..].iter().all(u8::is_ascii_whitespace))
    {
        return Err("The PDF structure is malformed or ambiguous.".into());
    }
    let document = lopdf::Document::load_mem_with_options(
        bytes,
        lopdf::LoadOptions {
            strict: true,
            max_decompressed_size: Some(MAX_PDF_DECOMPRESSED_STREAM_BYTES),
            ..Default::default()
        },
    )
    .map_err(|_| "The PDF structure is invalid or unsupported.")?;
    if document.is_encrypted() || document.encryption_state.is_some() {
        return Err("Encrypted PDFs cannot be published.".into());
    }
    if document.objects.len() > MAX_PDF_OBJECTS {
        return Err("The PDF contains too many objects.".into());
    }
    let pages = document.get_pages();
    if pages.is_empty() || pages.len() > MAX_PDF_PAGES {
        return Err("Publish a PDF with between 1 and 10,000 pages.".into());
    }
    let mut nodes = 0usize;
    check_pdf_object(
        &lopdf::Object::Dictionary(document.trailer.clone()),
        &mut nodes,
        0,
    )?;
    for object in document.objects.values() {
        check_pdf_object(object, &mut nodes, 0)?;
    }
    Ok(true)
}

fn check_pdf(bytes: &[u8]) -> Result<bool, String> {
    catch_unwind(AssertUnwindSafe(|| check_pdf_document(bytes)))
        .map_err(|_| "The PDF structure could not be checked.".to_string())?
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
        "docx" | "xlsx" | "pptx" => check_office(bytes, extension)?,
        "pdf" => check_pdf(bytes)?,
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
    computers.with_artifact_files(workspace_id, agent_id, expected_generation, |workspace| {
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
        return Err("The generated image exceeds Fable's 25 MB artifact limit.".into());
    }
    computers.with_artifact_files(workspace_id, agent_id, expected_generation, |workspace| {
        let id = random_id()?;
        let workspace_directory_name = format!("generated-{id}");
        let workspace_directory = workspace.join(&workspace_directory_name);
        fs::create_dir(&workspace_directory)
            .map_err(|_| "Fable could not reserve a generated-image workspace folder.")?;
        let canonical_workspace = canonical(workspace)?;
        let canonical_workspace_directory = canonical(&workspace_directory)?;
        if !canonical_workspace_directory.starts_with(&canonical_workspace) {
            let _ = fs::remove_dir(&workspace_directory);
            return Err("The generated-image workspace path is unsafe.".into());
        }
        let export_name = format!("fable-{}.png", crate::paths::file_slug(&title));
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
            .map_err(|_| "Fable could not create the generated image in its workspace.")?;
        if !opened_path(&file)?.starts_with(&canonical_workspace) {
            let _ = fs::remove_file(&workspace_file);
            let _ = fs::remove_dir(&workspace_directory);
            return Err("The generated-image workspace path changed while writing.".into());
        }
        if file.write_all(bytes).and_then(|_| file.sync_all()).is_err() {
            let _ = fs::remove_file(&workspace_file);
            let _ = fs::remove_dir(&workspace_directory);
            return Err("Fable could not save the generated image in its workspace.".into());
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
            return Err("Fable could not save the encrypted image receipt.".into());
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

fn verified_artifact(
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

/// Re-open an immutable published artifact for a project share. Project
/// authority is checked by the caller; this helper deliberately does not
/// require a viewer generation because the immutable copy is outside the
/// guest workspace and is validated again by receipt, size, digest and type.
pub(crate) fn verified_artifact_for_project(
    computers: &LocalComputerState,
    workspace_id: &str,
    agent_id: &str,
    artifact_id: &str,
) -> Result<VerifiedProjectArtifact, String> {
    computers.validate_target(workspace_id, agent_id)?;
    if !valid_id(artifact_id) {
        return Err("This artifact identifier is invalid.".into());
    }
    let authorization = command_scope(Some(workspace_id.into()), None, ScopeAccess::Read)?;
    let scope = computers.scope(workspace_id, agent_id)?;
    let request = OpenArtifactRequest {
        workspace_id: workspace_id.into(),
        agent_id: agent_id.into(),
        artifact_id: artifact_id.into(),
        expected_generation: 0,
    };
    let receipt: ArtifactReceipt = crate::store::read_private_workspace_document(
        &scope.directory.join(format!("computer-{artifact_id}.json")),
        &authorization.private,
    )?
    .ok_or("This artifact is no longer available on this installation.")?;
    validate_receipt(&receipt, &request, &scope.computer_id)?;
    let root = scope.directory.join("artifacts");
    let bytes = read_bounded(&root, &root.join(artifact_id).join(&receipt.export_name))?;
    if bytes.len() as u64 != receipt.artifact.size_bytes || digest(&bytes) != receipt.sha256 {
        return Err("The published artifact has changed and cannot be shared.".into());
    }
    check_content(&bytes, allowed_path(&receipt.artifact.relative_path)?)?;
    Ok(VerifiedProjectArtifact {
        bytes,
        artifact_id: receipt.artifact.id,
        agent_id: receipt.agent_id,
        export_name: receipt.export_name,
        title: receipt.artifact.title,
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

fn prepare_open(
    computers: &LocalComputerState,
    request: &OpenArtifactRequest,
) -> Result<PathBuf, String> {
    let (receipt, bytes) = verified_artifact(computers, request)?;
    let scope = computers.scope(&request.workspace_id, &request.agent_id)?;
    // Editors can save their own copy without altering the published result.
    write_copy(
        &scope.directory.join("artifact-open"),
        &random_id()?,
        &receipt.export_name,
        &bytes,
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactPreview {
    artifact_id: String,
    mime_type: String,
    text: Option<String>,
    image_data_url: Option<String>,
    truncated: bool,
}

fn preview_bytes(artifact: &LocalComputerArtifact, bytes: &[u8]) -> ArtifactPreview {
    use base64::Engine;
    let mut preview = ArtifactPreview {
        artifact_id: artifact.id.clone(),
        mime_type: artifact.mime_type.clone(),
        text: None,
        image_data_url: None,
        truncated: false,
    };
    if artifact.mime_type.starts_with("text/") {
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
    }
    preview
}

#[tauri::command]
pub async fn local_computer_preview_artifact(
    window: tauri::WebviewWindow,
    request: OpenArtifactRequest,
    computers: tauri::State<'_, Arc<LocalComputerState>>,
) -> Result<ArtifactPreview, String> {
    if window.label() != "main" {
        return Err("Preview the artifact from its Fable conversation.".into());
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
    .map_err(|_| "Fable could not preview the artifact.".to_string())?
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
    use lopdf::dictionary;

    #[test]
    fn previews_are_bounded_plain_text_or_raster_data() {
        let mut artifact = LocalComputerArtifact {
            kind: "computer-artifact".into(),
            version: 1,
            id: random_id().unwrap(),
            computer_id: "computer".into(),
            title: "Notes".into(),
            mime_type: "text/plain".into(),
            size_bytes: 0,
            relative_path: "notes.txt".into(),
            created_at: "now".into(),
        };
        let text = "é".repeat(150_000);
        let preview = preview_bytes(&artifact, text.as_bytes());
        assert!(preview.truncated);
        assert!(preview.text.unwrap().len() <= 256 * 1024);
        assert!(preview.image_data_url.is_none());
        artifact.mime_type = "image/png".into();
        let preview = preview_bytes(&artifact, b"\x89PNG\r\n\x1a\n");
        assert!(preview
            .image_data_url
            .unwrap()
            .starts_with("data:image/png;base64,"));
        assert!(preview.text.is_none());
        let oversized = preview_bytes(&artifact, &vec![0; 8 * 1024 * 1024 + 1]);
        assert!(oversized.image_data_url.is_none());
        artifact.mime_type =
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document".into();
        assert!(preview_bytes(&artifact, b"<script>not rendered</script>")
            .text
            .is_none());
    }

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
            "slides.pptx",
            "report.pdf",
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

    fn pdf_document(modify: impl FnOnce(&mut lopdf::Document, &mut lopdf::Dictionary)) -> Vec<u8> {
        let mut document = lopdf::Document::with_version("1.7");
        let pages_id = document.new_object_id();
        let page_id = document.add_object(lopdf::dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
        });
        document.objects.insert(
            pages_id,
            lopdf::Object::Dictionary(lopdf::dictionary! {
                "Type" => "Pages",
                "Kids" => vec![page_id.into()],
                "Count" => 1,
            }),
        );
        let mut catalog = lopdf::dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        };
        modify(&mut document, &mut catalog);
        let catalog_id = document.add_object(catalog);
        document.trailer.set("Root", catalog_id);
        let mut bytes = Vec::new();
        document.save_to(&mut bytes).unwrap();
        bytes
    }

    #[test]
    fn pdf_requires_one_strict_unencrypted_passive_document() {
        let valid = pdf_document(|_, _| {});
        assert!(check_content(&valid, "pdf").is_ok());

        let safe_open_destination = pdf_document(|_, catalog| {
            catalog.set(
                "OpenAction",
                lopdf::Object::Array(vec![0.into(), lopdf::Object::Name(b"Fit".to_vec())]),
            );
        });
        assert!(check_content(&safe_open_destination, "pdf").is_ok());

        let mut appended = valid.clone();
        appended.extend_from_slice(b"\n% second update\n%%EOF\n");
        assert!(check_content(&appended, "pdf").is_err());

        let mut encrypted_document = lopdf::Document::load_mem(&valid).unwrap();
        encrypted_document.trailer.set(
            "ID",
            lopdf::Object::Array(vec![
                lopdf::Object::string_literal("first-document-id"),
                lopdf::Object::string_literal("second-document-id"),
            ]),
        );
        let encryption = lopdf::EncryptionState::try_from(lopdf::EncryptionVersion::V2 {
            document: &encrypted_document,
            owner_password: "",
            user_password: "",
            key_length: 128,
            permissions: lopdf::Permissions::all(),
        })
        .unwrap();
        encrypted_document.encrypt(&encryption).unwrap();
        let mut encrypted = Vec::new();
        encrypted_document.save_to(&mut encrypted).unwrap();
        assert!(check_content(&encrypted, "pdf")
            .unwrap_err()
            .contains("Encrypted PDFs"));
    }

    #[test]
    fn pdf_actions_embeds_and_external_streams_are_rejected_after_parsing() {
        let scripted = pdf_document(|document, catalog| {
            let action = document.add_object(lopdf::dictionary! {
                "S" => "JavaScript",
                "JS" => lopdf::Object::string_literal("app.alert('opened')"),
            });
            catalog.set("OpenAction", action);
        });
        assert!(check_content(&scripted, "pdf").is_err());

        let embedded = pdf_document(|document, _| {
            document.add_object(lopdf::Stream::new(
                lopdf::dictionary! { "Type" => "EmbeddedFile" },
                b"payload".to_vec(),
            ));
        });
        assert!(check_content(&embedded, "pdf").is_err());

        let external_stream = pdf_document(|document, _| {
            document.add_object(lopdf::Stream::new(
                lopdf::dictionary! { "F" => lopdf::Object::string_literal("https://example.test/data") },
                Vec::new(),
            ));
        });
        assert!(check_content(&external_stream, "pdf").is_err());

        let mut object_stream_document =
            lopdf::Document::load_mem(&pdf_document(|_, _| {})).unwrap();
        object_stream_document.add_object(lopdf::dictionary! {
            "S" => "Launch",
            "F" => lopdf::Object::string_literal("payload.exe"),
        });
        let mut object_stream = Vec::new();
        object_stream_document
            .save_modern(&mut object_stream)
            .unwrap();
        assert!(contains_ascii_case_insensitive(&object_stream, b"/ObjStm"));
        assert!(check_content(&object_stream, "pdf").is_err());
    }

    #[test]
    fn office_documents_require_matching_parts_and_reject_active_content() {
        fn office(extension: &str, extra: Option<&str>, external: bool) -> Vec<u8> {
            let (main_part, main_content_type) = match extension {
                "docx" => (
                    "word/document.xml",
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
                ),
                "xlsx" => (
                    "xl/workbook.xml",
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
                ),
                "pptx" => (
                    "ppt/presentation.xml",
                    "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
                ),
                _ => unreachable!(),
            };
            let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
            for name in [
                Some("[Content_Types].xml"),
                Some("_rels/.rels"),
                Some(main_part),
                extra,
            ]
            .into_iter()
            .flatten()
            {
                if name.ends_with('/') {
                    writer
                        .add_directory(name, zip::write::SimpleFileOptions::default())
                        .unwrap();
                    continue;
                }
                writer
                    .start_file(name, zip::write::SimpleFileOptions::default())
                    .unwrap();
                let contents = if name == "[Content_Types].xml" {
                    format!("<Types><Override ContentType=\"{main_content_type}\"/></Types>")
                } else if name == "_rels/.rels" && external {
                    "<Relationships><Relationship TargetMode='External' Target='https://example.test'/></Relationships>".into()
                } else if name == "_rels/.rels" {
                    format!("<Relationships><Relationship Type='relationships/officeDocument' Target='{main_part}'/></Relationships>")
                } else {
                    "<fixture/>".into()
                };
                writer.write_all(contents.as_bytes()).unwrap();
            }
            writer.finish().unwrap().into_inner()
        }
        assert!(check_content(&office("docx", None, false), "docx").is_ok());
        assert!(check_content(&office("xlsx", None, false), "xlsx").is_ok());
        assert!(check_content(&office("pptx", None, false), "pptx").is_ok());
        assert!(check_content(&office("pptx", Some("ppt/embeddings/"), false), "pptx").is_ok());
        assert!(check_content(&office("docx", None, false), "xlsx").is_err());
        assert!(
            check_content(&office("docx", Some("word/vbaProject.bin"), false), "docx").is_err()
        );
        assert!(check_content(
            &office("pptx", Some("ppt/embeddings/evil.bin"), false),
            "pptx"
        )
        .is_err());
        assert!(check_content(&office("pptx", None, true), "pptx").is_err());
        assert!(check_office_metadata_xml(
            b"<Types><!-- misleading metadata --></Types>",
            "document"
        )
        .is_err());
        assert!(
            check_office_metadata_xml(b"<Types ContentType='macro&#69;nabled'/>", "document")
                .is_err()
        );
    }

    #[test]
    #[ignore = "requires fixtures produced by fable-verify-document-tools in the guest image"]
    fn guest_generated_documents_pass_the_native_validator() {
        let fixture_root = PathBuf::from(
            std::env::var("FABLE_ARTIFACT_FIXTURE_DIR")
                .expect("set FABLE_ARTIFACT_FIXTURE_DIR to the guest script output"),
        );
        for (relative, extension) in [
            ("source/document.docx", "docx"),
            ("source/workbook.xlsx", "xlsx"),
            ("source/presentation.pptx", "pptx"),
            ("source/report.pdf", "pdf"),
            ("rendered/document.pdf", "pdf"),
            ("rendered/presentation.pdf", "pdf"),
            ("recalculated/workbook.xlsx", "xlsx"),
        ] {
            let path = fixture_root.join(relative);
            let bytes = fs::read(&path).unwrap_or_else(|error| {
                panic!(
                    "could not read generated fixture {}: {error}",
                    path.display()
                )
            });
            check_content(&bytes, extension).unwrap_or_else(|error| {
                panic!("generated fixture {} was rejected: {error}", path.display())
            });
        }
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
