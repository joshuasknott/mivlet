//! Exact observed-link downloads. Chromium retains its own authentication; only
//! completed passive bytes leave private native staging.
use super::super::DownloadRequest;
use super::{
    observations::{self, Frame},
    pipes::Command,
    BrowserProcess,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::Path,
    time::{Duration, Instant},
};

const MAX_BYTES: u64 = 8 * 1024 * 1024;
const STALE: &str =
    "The browser download choice changed. Observe the exact link again; no download was started.";
const FAILED:&str="The browser download did not complete safely. Its owned browser was closed to contain pending writes; no file was imported and no download was replayed. Open a fresh browser before continuing.";

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
    url: String,
    backend: u64,
    metadata: Value,
}
fn candidate(node: &Value) -> Option<(u64, String)> {
    let name = node["name"]["value"].as_str()?;
    if node["ignored"] != false
        || node["role"]["value"] != "link"
        || name.trim().is_empty()
        || name.chars().count() > 160
        || name.chars().any(char::is_control)
        || crate::secret_redaction::looks_secret(name)
    {
        return None;
    }
    Some((
        node["backendDOMNodeId"]
            .as_u64()
            .filter(|id| *id > 0 && *id <= u32::MAX.into())?,
        name.into(),
    ))
}
fn metadata(node: &Value, page: &str) -> Option<(Value, String)> {
    if node["nodeType"] != 1 || node["nodeName"] != "A" {
        return None;
    }
    let attrs = node["attributes"].as_array()?;
    if attrs.len() > 128 || attrs.len() % 2 != 0 {
        return None;
    }
    let mut href = None;
    let mut bytes = 0;
    for pair in attrs.as_chunks::<2>().0 {
        let key = pair[0].as_str()?;
        let value = pair[1].as_str()?;
        bytes += key.len() + value.len();
        if bytes > 8192
            || matches!(
                key.to_ascii_lowercase().as_str(),
                "hidden" | "disabled" | "contenteditable"
            )
        {
            return None;
        }
        if key.eq_ignore_ascii_case("href") {
            href = Some(value);
        }
    }
    let url = url::Url::parse(page).ok()?.join(href?).ok()?.to_string();
    if url.len() > 2048
        || observations::url_origin(&url).is_none()
        || crate::secret_redaction::looks_secret(&url)
    {
        return None;
    }
    Some((json!({"attributes":attrs}), url))
}
pub(super) fn capture(
    process: &mut BrowserProcess,
    scope: (u64, u64, u64),
    target: &str,
    session: &str,
    frame: &Frame,
    origin: &str,
    nodes: &[Value],
    check: &dyn Fn() -> Result<(), String>,
) -> Result<(Vec<Value>, HashMap<String, Choice>), String> {
    let mut display = Vec::new();
    let mut choices = HashMap::new();
    let mut inspected = 0;
    for index in observations::reachable(nodes, &frame.id, false)? {
        let Some((backend, name)) = candidate(&nodes[index]) else {
            continue;
        };
        if inspected >= 16 {
            break;
        }
        inspected += 1;
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
        let Some((metadata, url)) = metadata(&described["node"], &frame.url) else {
            continue;
        };
        let reference = super::super::super::desktop_tools::opaque_id()?;
        display.push(json!({"downloadRef":reference,"name":name,"url":url}));
        choices.insert(
            reference,
            Choice {
                hwnd: scope.0,
                generation: scope.1,
                window: scope.2,
                created: Instant::now(),
                target: target.into(),
                session: session.into(),
                frame: frame.clone(),
                origin: origin.into(),
                name,
                url,
                backend,
                metadata,
            },
        );
    }
    Ok((display, choices))
}
pub(super) fn validate(input: &DownloadRequest) -> Result<(), String> {
    if input.file_name.contains(['/', '\\'])
        || input.file_name.len() > 160
        || !(1..=10).contains(&input.timeout_seconds)
        || input.name.trim().is_empty()
        || input.name.chars().any(char::is_control)
        || input.name.chars().count() > 160
        || input.url.len() > 2048
        || observations::url_origin(&input.url).is_none()
        || crate::secret_redaction::looks_secret(&input.url)
        || crate::secret_redaction::looks_secret(&input.file_name)
    {
        return Err("Choose one passive download filename, its exact observed public URL and a 1–10 second timeout. No download was started.".into());
    }
    super::super::super::artifacts::allowed_path(&input.file_name)?;
    Ok(())
}
struct Progress {
    frame: String,
    url: String,
    guid: Option<String>,
    bytes: u64,
    complete: bool,
}
impl Progress {
    fn event(&mut self, event: &Value) -> Result<(), String> {
        if self.complete {
            return Err(FAILED.into());
        }
        let guid = event["guid"].as_str().ok_or(FAILED)?;
        if event["kind"] == "begin" {
            if self.guid.is_some() || event["frameId"] != self.frame || event["url"] != self.url {
                return Err(FAILED.into());
            }
            self.guid = Some(guid.into());
            return Ok(());
        }
        if self.guid.as_deref() != Some(guid) || event["kind"] != "progress" {
            return Err(FAILED.into());
        }
        let bytes = event["receivedBytes"]
            .as_f64()
            .filter(|n| {
                n.is_finite()
                    && n.fract() == 0.0
                    && *n >= self.bytes as f64
                    && *n <= MAX_BYTES as f64
            })
            .ok_or(FAILED)?;
        self.bytes = bytes as u64;
        match event["state"].as_str() {
            Some("inProgress") => {}
            Some("completed") => self.complete = true,
            _ => return Err(FAILED.into()),
        }
        Ok(())
    }
}
struct Containment {
    job: std::sync::Arc<super::BrowserJob>,
    armed: bool,
}
impl Drop for Containment {
    fn drop(&mut self) {
        if self.armed {
            let _ = self.job.stop_and_wait();
        }
    }
}
pub(crate) struct Transfer {
    contain: Containment,
    _pin: fs::File,
    staging: tempfile::TempDir,
    guid: String,
    bytes: u64,
}
impl Transfer {
    pub(crate) fn finish(
        mut self,
        input: &DownloadRequest,
        native_root: &Path,
        workspace: &Path,
        check: &dyn Fn() -> Result<(), String>,
        commit: &super::super::super::control::NativeDispatch<'_>,
    ) -> Result<String, String> {
        self.contain.job.stop_and_wait()?;
        self.contain.armed = false;
        check()?;
        storage_bound(self.staging.path())?;
        let files = fs::read_dir(self.staging.path())
            .map_err(|_| FAILED)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| FAILED)?;
        if files.len() != 1 || files[0].file_name() != std::ffi::OsStr::new(&self.guid) {
            return Err("The browser download contained additional or incomplete files; no file was imported.".into());
        }
        let bytes = super::super::super::artifacts::read_bounded_limit(
            self.staging.path(),
            &self.staging.path().join(&self.guid),
            MAX_BYTES,
        )?;
        if bytes.len() as u64 != self.bytes {
            return Err("The completed download size did not match its native receipt; no file was imported.".into());
        }
        let extension = super::super::super::artifacts::allowed_path(&input.file_name)?;
        super::super::super::artifacts::check_content(&bytes, extension)?;
        if std::str::from_utf8(&bytes).is_ok_and(|text| {
            crate::secret_redaction::looks_secret(text)
                || crate::secret_redaction::secret_marker_survives(text)
        }) {
            return Err(
                "The downloaded file contains a credential marker; no file was imported.".into(),
            );
        }
        let id = super::super::super::desktop_tools::opaque_id()?;
        let prepared = tempfile::Builder::new()
            .prefix("browser-result-")
            .tempdir_in(native_root)
            .map_err(|_| "Download import staging is unavailable.")?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(prepared.path().join(&input.file_name))
            .map_err(|_| "Cannot prepare the downloaded file.")?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "Cannot stage the downloaded file.")?;
        drop(file);
        let downloads = workspace.join("Downloads");
        fs::create_dir_all(&downloads).map_err(|_| "Download workspace is unavailable.")?;
        let canonical = crate::paths::strict_canonicalize(&downloads)
            .map_err(|_| "Download workspace failed validation.")?;
        if canonical.parent() != Some(workspace) {
            return Err("Download workspace changed; no file was imported.".into());
        }
        let _workspace_pin = super::pin_directory(&canonical)?;
        let destination = canonical.join(format!("download-{id}"));
        check()?;
        commit(&mut || {
            fs::rename(prepared.path(), &destination).map_err(|_| {
                "Downloaded file placement failed; existing files were preserved.".to_owned()
            })
        })?;
        Ok(json!({"status":"downloaded","path":format!("Downloads/download-{id}/{}",input.file_name),
            "sizeBytes":bytes.len(),"sha256":hex::encode(Sha256::digest(&bytes)),"verified":true,"published":false,"browserClosed":true,
            "message":"Completed passive bytes imported into this agent's workspace after the owned browser closed. Read or explicitly publish the file; no browser cookie or native path was exposed."}).to_string())
    }
}
fn storage_bound(root: &Path) -> Result<(), String> {
    let mut count = 0;
    let mut bytes = 0;
    for entry in fs::read_dir(root).map_err(|_| FAILED)? {
        count += 1;
        if count > 4 {
            return Err(FAILED.into());
        }
        let path = entry.map_err(|_| FAILED)?.path();
        if crate::paths::contains_symlink(&path) {
            return Err(FAILED.into());
        }
        let metadata = fs::symlink_metadata(path).map_err(|_| FAILED)?;
        if !metadata.is_file() {
            return Err(FAILED.into());
        }
        bytes += metadata.len();
        if bytes > MAX_BYTES {
            return Err(FAILED.into());
        }
    }
    Ok(())
}
pub(super) fn download(
    process: &mut BrowserProcess,
    scope: (u64, u64),
    input: &DownloadRequest,
    native_root: &Path,
    check: &dyn Fn() -> Result<(), String>,
    dispatch: &super::super::super::control::NativeDispatch<'_>,
) -> Result<Transfer, String> {
    validate(input)?;
    let choice = process.downloads.remove(&input.download_ref).ok_or(STALE)?;
    process.downloads.clear();
    process.fields.clear();
    process.controls.clear();
    process.navigation.clear();
    process.activation.clear();
    process.tabs = None;
    process.scroll = None;
    let (window, pages) = observations::targets(process, scope.0, check)?;
    if (choice.hwnd, choice.generation, choice.window) != (scope.0, scope.1, window)
        || choice.created.elapsed() >= Duration::from_secs(30)
        || choice.origin != input.origin
        || choice.name != input.name
        || choice.url != input.url
        || !pages.iter().any(|page| {
            page["targetId"] == choice.target && page["url"].as_str() == Some(&choice.frame.url)
        })
    {
        return Err(STALE.into());
    }
    let current = observations::frame(
        &observations::call(
            process,
            Command::Frames,
            json!({}),
            Some(&choice.session),
            check,
        )?,
        &input.origin,
    )?;
    if current != choice.frame
        || !process
            ._pipe
            .as_mut()
            .ok_or(STALE)?
            .visible(&current.id, &choice.session, check)?
    {
        return Err(STALE.into());
    }
    let (nodes, _) = observations::checked_tree(process, &choice.session, &current, check)?;
    if !observations::reachable(&nodes, &current.id, false)?
        .iter()
        .any(|i| candidate(&nodes[*i]) == Some((choice.backend, choice.name.clone())))
    {
        return Err(STALE.into());
    }
    let described = observations::call(
        process,
        Command::DescribeNode,
        json!({"backendNodeId":choice.backend,"depth":0,"pierce":false}),
        Some(&choice.session),
        check,
    )?;
    if described["node"]["backendNodeId"].as_u64() != Some(choice.backend)
        || metadata(&described["node"], &current.url) != Some((choice.metadata, choice.url.clone()))
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
        || hit["frameId"].as_str() != Some(&current.id)
    {
        return Err(STALE.into());
    }
    if !process
        ._pipe
        .as_mut()
        .ok_or(STALE)?
        .visible(&current.id, &choice.session, check)?
    {
        return Err(STALE.into());
    }
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
    if latest != current {
        return Err(STALE.into());
    }
    let staging = tempfile::Builder::new()
        .prefix("browser-download-")
        .tempdir_in(native_root)
        .map_err(|_| "Private download staging is unavailable.")?;
    let pin = super::pin_directory(staging.path())?;
    let contain = Containment {
        job: process.job.clone(),
        armed: true,
    };
    let result = (|| {
        let deadline = Instant::now() + Duration::from_secs(input.timeout_seconds);
        let transfer_check = || {
            check()?;
            if Instant::now() >= deadline {
                Err(FAILED.into())
            } else {
                Ok(())
            }
        };
        let pipe = process._pipe.as_mut().ok_or(FAILED)?;
        pipe.download_policy(Some(staging.path()), &transfer_check, dispatch)?;
        pipe.navigate(
            json!({"url":choice.url,"frameId":current.id,"referrerPolicy":"noReferrer"}),
            &choice.session,
            &transfer_check,
            dispatch,
        )?;
        let mut progress = Progress {
            frame: current.id,
            url: choice.url,
            guid: None,
            bytes: 0,
            complete: false,
        };
        while !progress.complete {
            transfer_check()?;
            for event in pipe.poll_downloads(&transfer_check)? {
                progress.event(&event)?;
            }
            storage_bound(staging.path())?;
            if !progress.complete {
                std::thread::sleep(Duration::from_millis(25));
            }
        }
        transfer_check()?;
        Ok((progress.guid.ok_or(FAILED)?, progress.bytes))
    })();
    let (guid, bytes) = result.map_err(|_: String| FAILED.to_owned())?;
    Ok(Transfer {
        staging,
        _pin: pin,
        contain,
        guid,
        bytes,
    })
}

#[cfg(test)]
#[path = "downloads_tests.rs"]
mod tests;
