//! Receipt-verified passive file attachment. The browser retains native staging
//! until its Job exits; ordinary page reads keep refusing selected file fields.
use super::super::UploadRequest;
use super::{
    observations::{self, Frame},
    pipes::Command,
    BrowserProcess,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    io::Write,
    os::windows::fs::OpenOptionsExt,
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};
use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;
const STALE:&str="The upload field changed or is no longer empty. Request fresh upload choices; no file was attached.";
const UNKNOWN:&str="File attachment outcome is uncertain. No input was replayed; hand browser control to the user to inspect the selected file and confirmation.";
const MAX_BYTES: usize = 8 * 1024 * 1024;

pub(super) struct Choice {
    hwnd: u64,
    generation: u64,
    window: u64,
    created: Instant,
    target: String,
    session: String,
    frame: Frame,
    origin: String,
    name: String,
    backend: u64,
    metadata: Value,
}
impl Choice {
    fn check(
        &self,
        scope: (u64, u64, u64),
        input: &UploadRequest,
        frame: &Frame,
    ) -> Result<(), String> {
        if (self.hwnd, self.generation, self.window) != scope
            || self.created.elapsed() >= Duration::from_secs(30)
            || self.origin != input.origin
            || self.name != input.name
            || self.frame != *frame
        {
            return Err(STALE.into());
        }
        Ok(())
    }
    fn present(&self, fields: &[(u64, String, Value)]) -> bool {
        fields.iter().any(|(backend, name, metadata)| {
            *backend == self.backend && *name == self.name && *metadata == self.metadata
        })
    }
}
pub(super) struct Custody {
    job: Option<Arc<super::BrowserJob>>,
    _file: File,
    _pin: File,
    directory: tempfile::TempDir,
    file_name: String,
}
impl Drop for Custody {
    fn drop(&mut self) {
        if let Some(job) = self.job.as_ref() {
            let _ = job.stop_and_wait();
        }
    }
}
impl Custody {
    fn path(&self) -> std::path::PathBuf {
        self.directory.path().join(&self.file_name)
    }
}

fn metadata(node: &Value) -> Option<(String, Value)> {
    if node["nodeType"] != 1 || node["nodeName"] != "INPUT" {
        return None;
    }
    let attributes = node["attributes"].as_array()?;
    if attributes.len() > 128 || attributes.len() % 2 != 0 {
        return None;
    }
    let mut kind = false;
    let mut label = None;
    let mut bytes = 0;
    for pair in attributes.as_chunks::<2>().0 {
        let key = pair[0].as_str()?.to_ascii_lowercase();
        let value = pair[1].as_str()?;
        bytes += key.len() + value.len();
        if bytes > 2048
            || matches!(
                key.as_str(),
                "disabled"
                    | "readonly"
                    | "hidden"
                    | "multiple"
                    | "webkitdirectory"
                    | "capture"
                    | "contenteditable"
            )
            || key == "value" && !value.is_empty()
        {
            return None;
        }
        if key == "type" {
            if !value.eq_ignore_ascii_case("file") {
                return None;
            }
            kind = true;
        }
        if key == "aria-label" {
            label = Some(value);
        }
    }
    let name = label?.trim();
    if !kind
        || name.is_empty()
        || name.chars().count() > 160
        || name.chars().any(char::is_control)
        || crate::secret_redaction::looks_secret(name)
        || crate::secret_redaction::secret_marker_survives(name)
    {
        return None;
    }
    Some((name.into(), json!({"attributes":attributes})))
}
fn accepts(metadata: &Value, file_name: &str, mime: &str) -> bool {
    let Some(attributes) = metadata["attributes"].as_array() else {
        return false;
    };
    let accept = attributes.as_chunks::<2>().0.iter().find_map(|pair| {
        pair[0]
            .as_str()
            .filter(|key| key.eq_ignore_ascii_case("accept"))
            .and_then(|_| pair[1].as_str())
    });
    let Some(accept) = accept.filter(|value| !value.trim().is_empty()) else {
        return true;
    };
    if accept.len() > 512 || accept.split(',').count() > 32 {
        return false;
    }
    let extension = file_name
        .rsplit_once('.')
        .map(|(_, extension)| format!(".{}", extension.to_ascii_lowercase()));
    accept.split(',').any(|part| {
        let part = part.trim().to_ascii_lowercase();
        part == mime.to_ascii_lowercase()
            || extension.as_deref() == Some(part.as_str())
            || part
                .strip_suffix("/*")
                .is_some_and(|kind| mime.starts_with(&format!("{kind}/")))
    })
}
fn validate_staged(
    root: &Path,
    path: &Path,
    source: &super::super::super::artifacts::VerifiedUploadArtifact,
) -> Result<(), String> {
    let staged = super::super::super::artifacts::read_bounded_limit(root, path, MAX_BYTES as u64)?;
    if staged.len() != source.bytes.len() || hex::encode(Sha256::digest(&staged)) != source.sha256 {
        return Err("The staged upload no longer matches its immutable artifact receipt; no file was attached.".into());
    }
    Ok(())
}

/// No page text is projected. Every field is checked before any chooser label
/// is returned; populated/unsupported files and other private fields stop reads.
fn empty_tree(
    process: &mut BrowserProcess,
    session: &str,
    frame: &Frame,
    origin: &str,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<Vec<(u64, String, Value)>, String> {
    let result = observations::call(
        process,
        Command::Accessibility,
        json!({"frameId":frame.id,"depth":8}),
        Some(session),
        check,
    )?;
    let nodes = result["nodes"].as_array().ok_or(STALE)?;
    let mut offered = Vec::new();
    for index in observations::privacy_fields(nodes, &frame.id)? {
        let backend = nodes[index]["backendDOMNodeId"]
            .as_u64()
            .filter(|id| *id > 0 && *id <= u32::MAX.into())
            .ok_or(STALE)?;
        let described = observations::call(
            process,
            Command::DescribeNode,
            json!({"backendNodeId":backend,"depth":0,"pierce":false}),
            Some(session),
            check,
        )?;
        if described["node"]["backendNodeId"].as_u64() != Some(backend) {
            return Err(STALE.into());
        }
        if let Some((name, metadata)) = metadata(&described["node"]) {
            if offered.len() >= 8 {
                return Err(
                    "This page has too many file inputs; complete the upload yourself.".into(),
                );
            }
            if !process
                ._pipe
                .as_mut()
                .ok_or(STALE)?
                .empty_file(&frame.id, session, backend, origin, &metadata, check)?
            {
                return Err("This page contains a selected or unavailable file input. Complete that file step yourself; no filename or value was read.".into());
            }
            offered.push((backend, name, metadata));
        } else if observations::private_attributes(&described["node"])? {
            return Err("This page contains a private or unsupported file field. Hand browser control to the user; no field values were read.".into());
        }
    }
    Ok(offered)
}
pub(super) fn choices(
    process: &mut BrowserProcess,
    scope: (u64, u64),
    reference: &str,
    origin: &str,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<String, String> {
    let (target, expected_window) = process
        .tabs
        .as_mut()
        .ok_or(STALE)?
        .consume(scope.0, scope.1, reference)?;
    process.upload_choices.clear();
    process.fields.clear();
    process.controls.clear();
    process.navigation.clear();
    process.activation.clear();
    process.downloads.clear();
    process.scroll = None;
    let (window, pages) = observations::targets(process, scope.0, check)?;
    if window != expected_window
        || !pages.iter().any(|page| {
            page["targetId"] == target
                && observations::url_origin(page["url"].as_str().unwrap_or_default()).as_deref()
                    == Some(origin)
        })
    {
        return Err(STALE.into());
    }
    let session = observations::session(process, &target, check)?;
    let frame = observations::frame(
        &observations::call(process, Command::Frames, json!({}), Some(&session), check)?,
        origin,
    )?;
    if !process
        ._pipe
        .as_mut()
        .ok_or(STALE)?
        .visible(&frame.id, &session, check)?
    {
        return Err(STALE.into());
    }
    let fields = empty_tree(process, &session, &frame, origin, check)?;
    let after = observations::frame(
        &observations::call(process, Command::Frames, json!({}), Some(&session), check)?,
        origin,
    )?;
    if after != frame {
        return Err(STALE.into());
    }
    let mut display = Vec::new();
    let mut choices = HashMap::new();
    for (backend, name, metadata) in fields {
        let reference = super::super::super::desktop_tools::opaque_id()?;
        display.push(json!({"uploadRef":reference,"name":name,"empty":true}));
        choices.insert(
            reference,
            Choice {
                hwnd: scope.0,
                generation: scope.1,
                window,
                created: Instant::now(),
                target: target.clone(),
                session: session.clone(),
                frame: frame.clone(),
                origin: origin.into(),
                name,
                backend,
                metadata,
            },
        );
    }
    check()?;
    process.upload_choices = choices;
    Ok(json!({"origin":origin,"uploads":display,"uploadsPartial":true,"expiresSeconds":30,"inputValues":"omitted","pageContent":"omitted","scope":"visible-top-frame-labelled-empty-single-file-only","trust":"external-untrusted","instructionAuthority":"none"}).to_string())
}
pub(super) fn upload(
    process: &mut BrowserProcess,
    scope: (u64, u64),
    input: &UploadRequest,
    source: &super::super::super::artifacts::VerifiedUploadArtifact,
    native_root: &Path,
    check: &dyn Fn() -> Result<(), String>,
    dispatch: &super::super::super::control::NativeDispatch<'_>,
) -> Result<String, String> {
    if source.bytes.len() > MAX_BYTES
        || process.upload_custody.len() >= 4
        || source.file_name.contains(['/', '\\', ':'])
    {
        return Err("Close and reopen this owned browser before another upload, or choose a passive artifact up to 8 MiB.".into());
    }
    super::super::super::artifacts::allowed_path(&source.file_name)?;
    let choice = process
        .upload_choices
        .remove(&input.upload_ref)
        .ok_or(STALE)?;
    process.upload_choices.clear();
    process.fields.clear();
    process.controls.clear();
    process.navigation.clear();
    process.activation.clear();
    process.downloads.clear();
    process.tabs = None;
    process.scroll = None;
    let (window, pages) = observations::targets(process, scope.0, check)?;
    if !pages.iter().any(|page| {
        page["targetId"] == choice.target && page["url"].as_str() == Some(&choice.frame.url)
    }) {
        return Err(STALE.into());
    }
    let frame = observations::frame(
        &observations::call(
            process,
            Command::Frames,
            json!({}),
            Some(&choice.session),
            check,
        )?,
        &input.origin,
    )?;
    choice.check((scope.0, scope.1, window), input, &frame)?;
    if !process
        ._pipe
        .as_mut()
        .ok_or(STALE)?
        .visible(&frame.id, &choice.session, check)?
    {
        return Err(STALE.into());
    }
    let fields = empty_tree(process, &choice.session, &frame, &input.origin, check)?;
    if !choice.present(&fields) || !accepts(&choice.metadata, &source.file_name, &source.mime_type)
    {
        return Err(STALE.into());
    }
    let quads = observations::call(
        process,
        Command::Quads,
        json!({"backendNodeId":choice.backend}),
        Some(&choice.session),
        check,
    )?;
    let metrics = observations::call(
        process,
        Command::Layout,
        json!({}),
        Some(&choice.session),
        check,
    )?;
    let point = super::controls::point(&quads, &metrics)?;
    let hit = observations::document_point(
        point,
        (
            metrics["cssVisualViewport"]["pageX"]
                .as_f64()
                .ok_or(STALE)?,
            metrics["cssVisualViewport"]["pageY"]
                .as_f64()
                .ok_or(STALE)?,
        ),
    )?;
    let hit = observations::call(
        process,
        Command::Hit,
        json!({"x":hit.0,"y":hit.1,"includeUserAgentShadowDOM":false,"ignorePointerEventsNone":false}),
        Some(&choice.session),
        check,
    )?;
    if hit["backendNodeId"].as_u64() != Some(choice.backend)
        || hit["frameId"].as_str() != Some(&frame.id)
    {
        return Err(STALE.into());
    }
    let directory = tempfile::Builder::new()
        .prefix("browser-upload-")
        .tempdir_in(native_root)
        .map_err(|_| "Private browser upload staging is unavailable.")?;
    let pin = super::pin_directory(directory.path())?;
    let path = directory.path().join(&source.file_name);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|_| "Cannot stage the approved artifact.")?;
    file.write_all(&source.bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Cannot stage the approved artifact.")?;
    drop(file);
    let file = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(&path)
        .map_err(|_| "Cannot retain immutable browser upload bytes.")?;
    if super::super::super::artifacts::opened_path(&file)?
        != crate::paths::strict_canonicalize(&path).map_err(|_| "Upload staging changed.")?
    {
        return Err("Upload staging changed; no file was attached.".into());
    }
    validate_staged(native_root, &path, source)?;
    let mut custody = Custody {
        job: None,
        _file: file,
        _pin: pin,
        directory,
        file_name: source.file_name.clone(),
    };
    let latest = observations::frame(
        &observations::call(
            process,
            Command::Frames,
            json!({}),
            Some(&choice.session),
            check,
        )?,
        &input.origin,
    )?;
    if latest != frame
        || !process._pipe.as_mut().ok_or(STALE)?.empty_file(
            &frame.id,
            &choice.session,
            choice.backend,
            &input.origin,
            &choice.metadata,
            check,
        )?
    {
        return Err(STALE.into());
    }
    custody.job = Some(process.job.clone());
    let path = custody.path();
    process.upload_custody.push(custody);
    check()?;
    process
        ._pipe
        .as_mut()
        .ok_or(UNKNOWN)?
        .attach_file(&choice.session, choice.backend, &path, check, dispatch)
        .map_err(|_| UNKNOWN.to_owned())?;
    check().map_err(|_| UNKNOWN)?;
    Ok(json!({"status":"file-attached","artifactId":input.artifact_id,"sizeBytes":source.bytes.len(),"sha256":source.sha256,"verifiedArtifact":true,"submitted":false,"pageHandlersMayUpload":true,"nextStep":"Hand browser control to the user to inspect or confirm this file step. Ordinary page reads refuse selected-file fields; no filename/value was extracted and no input will be replayed."}).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    fn field() -> Value {
        json!({"nodeType":1,"nodeName":"INPUT","attributes":["type","file","aria-label","Upload report","accept",".csv,text/plain"]})
    }
    #[test]
    fn only_labelled_empty_single_file_metadata_is_admitted_and_accept_matches_passive_type() {
        let (_, metadata) = metadata(&field()).unwrap();
        assert!(accepts(&metadata, "report.csv", "text/csv"));
        assert!(accepts(&metadata, "notes.txt", "text/plain"));
        assert!(!accepts(&metadata, "photo.png", "image/png"));
        for attributes in [
            json!(["type", "file"]),
            json!([
                "type",
                "file",
                "aria-label",
                "Upload report",
                "multiple",
                ""
            ]),
            json!([
                "type",
                "file",
                "aria-label",
                "Upload report",
                "webkitdirectory",
                ""
            ]),
            json!(["type", "password", "aria-label", "Upload report"]),
            json!([
                "type",
                "file",
                "aria-label",
                "Upload report",
                "value",
                "chosen.csv"
            ]),
        ] {
            let mut changed = field();
            changed["attributes"] = attributes;
            assert!(super::metadata(&changed).is_none());
        }
    }
    #[test]
    fn native_file_probe_never_reads_names_values_or_grants_script_input() {
        let source = include_str!("uploads_script.rs");
        assert!(source.contains("files.length === 0"));
        for forbidden in ["files[0]", "node.value", "file.name", "userGesture:true"] {
            assert!(!source.contains(forbidden), "{forbidden}");
        }
    }
    #[test]
    fn upload_choice_binds_exact_origin_name_window_generation_and_loader_before_input() {
        let frame = Frame {
            id: "frame".into(),
            loader: "loader".into(),
            url: "https://example.test/upload".into(),
        };
        let mut choice = Choice {
            hwnd: 1,
            generation: 2,
            window: 3,
            created: Instant::now(),
            target: "target".into(),
            session: "session".into(),
            frame: frame.clone(),
            origin: "https://example.test".into(),
            name: "Upload report".into(),
            backend: 42,
            metadata: metadata(&field()).unwrap().1,
        };
        let input = UploadRequest {
            upload_ref: "a".repeat(48),
            origin: "https://example.test".into(),
            name: "Upload report".into(),
            artifact_id: format!("artifact-{}", "a".repeat(64)),
        };
        choice.check((1, 2, 3), &input, &frame).unwrap();
        assert!(choice.present(&[(42, choice.name.clone(), choice.metadata.clone())]));
        assert!(!choice.present(&[(43, choice.name.clone(), choice.metadata.clone())]));
        assert!(!choice.present(&[(42, choice.name.clone(), json!({"attributes":[]}))]));
        for scope in [(9, 2, 3), (1, 9, 3), (1, 2, 9)] {
            assert!(choice.check(scope, &input, &frame).is_err());
        }
        let mut changed = UploadRequest {
            upload_ref: input.upload_ref.clone(),
            origin: "https://other.test".into(),
            name: input.name.clone(),
            artifact_id: input.artifact_id.clone(),
        };
        assert!(choice.check((1, 2, 3), &changed, &frame).is_err());
        changed.origin = input.origin.clone();
        changed.name = "Other upload".into();
        assert!(choice.check((1, 2, 3), &changed, &frame).is_err());
        let mut changed_frame = frame.clone();
        changed_frame.loader = "changed".into();
        assert!(choice.check((1, 2, 3), &input, &changed_frame).is_err());
        choice.created = Instant::now() - Duration::from_secs(31);
        assert!(choice.check((1, 2, 3), &input, &frame).is_err());
    }
    #[test]
    fn immutable_upload_staging_rejects_changed_receipt_bytes_and_outside_paths() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let bytes = b"report\n42\n".to_vec();
        let mut source = super::super::super::super::artifacts::VerifiedUploadArtifact {
            file_name: "report.csv".into(),
            mime_type: "text/csv".into(),
            sha256: hex::encode(Sha256::digest(&bytes)),
            bytes,
        };
        let path = root.path().join("report.csv");
        fs::write(&path, &source.bytes).unwrap();
        validate_staged(root.path(), &path, &source).unwrap();
        source.sha256 = "0".repeat(64);
        assert!(validate_staged(root.path(), &path, &source).is_err());
        source.sha256 = hex::encode(Sha256::digest(&source.bytes));
        fs::write(&path, b"different\n").unwrap();
        assert!(validate_staged(root.path(), &path, &source).is_err());
        let foreign = outside.path().join("report.csv");
        fs::write(&foreign, &source.bytes).unwrap();
        assert!(validate_staged(root.path(), &foreign, &source).is_err());
    }
}
