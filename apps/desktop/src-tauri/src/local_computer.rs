//! Native Windows app control and bounded per-agent workspace files.
pub(crate) mod activity;
pub(crate) mod artifacts;
pub(crate) mod authority;
pub(crate) mod control;
mod cua;
pub(crate) mod desktop_tools;
pub(crate) mod office_authoring;
pub(crate) mod plugins;
pub(crate) mod repositories;
mod windows;
use authority::{ComputerAuthority, OperationTicket};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{AppHandle, Manager, State};
use url::Url;
const MAX_URL_CHARACTERS: usize = 2048;
const MAX_FILE_ENTRIES: usize = 200;
const MAX_FILE_DEPTH: usize = 8;
const MAX_FILE_PREVIEW_BYTES: usize = 256 * 1024;
const MAX_ATTACHMENT_BYTES: usize = 2 * 1024 * 1024;
const MAX_SAFE_UI_BYTES: u64 = 9_007_199_254_740_991;

pub struct LocalComputerState {
    native: control::NativeControl,
    driver_directory: PathBuf,
    activity_error: Mutex<Option<String>>,
    plugins: plugins::PluginAuthority,
    closing: AtomicBool,
    root: PathBuf,
    snapshot_path: PathBuf,
    authorities: Mutex<HashMap<String, Arc<ComputerAuthority>>>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalComputerSnapshot {
    plugins: plugins::BuiltinPlugins,
    computer_id: String,
    workspace_id: String,
    agent_id: String,
    locality: &'static str,
    backend: &'static str,
    isolation: &'static str,
    lifecycle: &'static str,
    controller: &'static str,
    generation: u64,
    capabilities: Vec<&'static str>,
    runtime_available: bool,
    control: control::ControlSnapshot,
    retired_computer: bool,
    message: Option<String>,
    updated_at: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalComputerFilesSnapshot {
    computer_id: String,
    entries: Vec<LocalComputerFileEntry>,
    truncated: bool,
    updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalComputerFileEntry {
    path: String,
    name: String,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    size_bytes: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalComputerFileRequest {
    workspace_id: String,
    agent_id: String,
    path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalComputerFilePreview {
    computer_id: String,
    path: String,
    content: String,
    size_bytes: u64,
    truncated: bool,
    updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalComputerAttachmentStageInput {
    attachment_id: String,
    name: String,
    mime_type: String,
    content_base64: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalComputerAttachmentStageRequest {
    workspace_id: String,
    agent_id: String,
    expected_generation: u64,
    attachments: Vec<LocalComputerAttachmentStageInput>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalComputerAttachmentReceipt {
    computer_id: String,
    batch_id: String,
    attachment_id: String,
    original_name: String,
    mime_type: String,
    relative_path: String,
    size_bytes: u64,
    sha256: String,
    staged_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalComputerAttachmentDiscardRequest {
    workspace_id: String,
    agent_id: String,
    computer_id: String,
    batch_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalComputerTarget {
    workspace_id: String,
    agent_id: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalComputerCancelRequest {
    workspace_id: String,
    agent_id: String,
    expected_generation: u64,
}

impl LocalComputerState {
    pub fn initialize(app: &AppHandle) -> Result<Self, String> {
        let root = crate::paths::app_data_dir(app)?.join("local-computers");
        std::fs::create_dir_all(&root)
            .map_err(|_| "Mivlet could not prepare workspace file storage.")?;
        let resources = app
            .path()
            .resource_dir()
            .map_err(|_| "Mivlet resources are unavailable.")?;
        Ok(Self {
            native: control::NativeControl::default(),
            driver_directory: if cfg!(debug_assertions) {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/cua-driver")
            } else {
                resources.join("resources/cua-driver")
            },
            activity_error: Mutex::new(Some("The computer Stop control has not started.".into())),
            plugins: plugins::PluginAuthority::load(&root.join("plugins.json"))?,
            closing: AtomicBool::new(false),
            root,
            snapshot_path: crate::paths::runtime_snapshot_path(app)?,
            authorities: Mutex::new(HashMap::new()),
        })
    }
    #[cfg(test)]
    pub(crate) fn for_test(root: PathBuf) -> Self {
        Self {
            native: control::NativeControl::default(),
            driver_directory: PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("resources/cua-driver"),
            activity_error: Mutex::new(None),
            plugins: plugins::PluginAuthority::for_test(),
            closing: AtomicBool::new(false),
            snapshot_path: root.join("runtime-snapshot.json"),
            root,
            authorities: Mutex::new(HashMap::new()),
        }
    }
    pub(crate) fn start_activity(self: &Arc<Self>) {
        let error = activity::start(self.clone()).err();
        if let Ok(mut value) = self.activity_error.lock() {
            *value = error;
        }
    }
    pub(crate) fn scope(
        &self,
        workspace_id: &str,
        agent_id: &str,
    ) -> Result<ComputerScope, String> {
        self.ensure_open()?;
        validate_scope_id(workspace_id)?;
        validate_scope_id(agent_id)?;
        let mut digest = Sha256::new();
        digest.update(b"fable-local-computer-v1\0");
        digest.update(workspace_id.as_bytes());
        digest.update(b"\0");
        digest.update(agent_id.as_bytes());
        let key = hex::encode(digest.finalize());
        let directory = self.root.join(&key[..32]);
        if !directory.starts_with(&self.root) {
            return Err("The local computer scope is invalid.".into());
        }
        Ok(ComputerScope {
            key: key[..32].to_string(),
            computer_id: format!("local-{}", &key[..24]),
            directory,
        })
    }

    pub(crate) fn validate_target(&self, workspace_id: &str, agent_id: &str) -> Result<(), String> {
        self.ensure_open()?;
        validate_scope_id(agent_id)?;
        let scope = crate::authorized_scope::command_scope(
            Some(workspace_id.into()),
            None,
            crate::authorized_scope::ScopeAccess::Write,
        )?;
        let snapshot: Option<crate::models::RuntimeSnapshot> =
            crate::store::read_workspace_document(&self.snapshot_path, &scope.data)?;
        if !snapshot
            .is_some_and(|snapshot| snapshot.agents.iter().any(|agent| agent.id == agent_id))
        {
            return Err(
                "Choose a saved agent in this workspace before accessing its computer.".into(),
            );
        }
        Ok(())
    }

    pub(crate) fn validate_viewer_generation(
        &self,
        workspace_id: &str,
        agent_id: &str,
        generation: u64,
    ) -> Result<(), String> {
        self.authority_for(workspace_id, agent_id)?
            .check_generation(generation)
            .map(|_| ())
    }

    pub(crate) fn authority_for(
        &self,
        workspace_id: &str,
        agent_id: &str,
    ) -> Result<Arc<ComputerAuthority>, String> {
        self.authority(&self.scope(workspace_id, agent_id)?)
    }
    fn authority(&self, scope: &ComputerScope) -> Result<Arc<ComputerAuthority>, String> {
        let mut authorities = self
            .authorities
            .lock()
            .map_err(|_| "Computer authority is unavailable.")?;
        self.ensure_open()?;
        if let Some(authority) = authorities.get(&scope.key) {
            return Ok(authority.clone());
        }
        let authority =
            ComputerAuthority::load_with_plugins(&scope.directory, self.plugins.bits.clone())?;
        authorities.insert(scope.key.clone(), authority.clone());
        Ok(authority)
    }
    fn ensure_open(&self) -> Result<(), String> {
        if self.closing.load(Ordering::Acquire) {
            Err("Mivlet is closing. Computer control is off.".into())
        } else {
            Ok(())
        }
    }
    pub(crate) fn with_agent_files<T>(
        &self,
        workspace_id: &str,
        agent_id: &str,
        expected_generation: u64,
        operation: impl FnOnce(&Path) -> Result<T, String>,
    ) -> Result<T, String> {
        self.with_scoped_files(
            workspace_id,
            agent_id,
            expected_generation,
            false,
            operation,
        )
    }

    /// Admit an asynchronous agent operation while preserving the same plugin,
    /// lease, generation, cancellation, and drain semantics as file/browser work.
    pub(crate) fn begin_agent_operation(
        &self,
        workspace_id: &str,
        agent_id: &str,
        expected_generation: u64,
    ) -> Result<authority::OperationTicket, String> {
        self.validate_target(workspace_id, agent_id)?;
        self.authority_for(workspace_id, agent_id)?
            .begin_agent(expected_generation)
    }

    pub(crate) fn with_artifact_files<T>(
        &self,
        workspace_id: &str,
        agent_id: &str,
        expected_generation: u64,
        operation: impl FnOnce(&Path) -> Result<T, String>,
    ) -> Result<T, String> {
        self.with_scoped_files(workspace_id, agent_id, expected_generation, true, operation)
    }

    fn with_scoped_files<T>(
        &self,
        workspace_id: &str,
        agent_id: &str,
        expected_generation: u64,
        artifact: bool,
        operation: impl FnOnce(&Path) -> Result<T, String>,
    ) -> Result<T, String> {
        let root = self.tool_workspace_root(workspace_id, agent_id)?;
        let authority = self.authority_for(workspace_id, agent_id)?;
        let ticket = if artifact {
            authority.begin_artifact(expected_generation)?
        } else {
            authority.begin_agent(expected_generation)?
        };
        ticket.check()?;
        // Revocation drains this admitted operation before human input is enabled.
        let result = operation(&root);
        ticket.finish(result)
    }

    pub(crate) fn tool_workspace_root(
        &self,
        workspace_id: &str,
        agent_id: &str,
    ) -> Result<PathBuf, String> {
        let scope = self.scope(workspace_id, agent_id)?;
        let workspace = scope.directory.join("workspace");
        if !workspace.is_dir() {
            return Err("Set up this agent's local computer before using its files.".into());
        }
        if !workspace.starts_with(&self.root) {
            return Err("The agent computer workspace is invalid.".into());
        }
        crate::paths::strict_canonicalize(&workspace)
            .map_err(|_| "The agent computer workspace failed its security check.".to_string())?;
        Ok(workspace)
    }
}
#[derive(Clone)]
pub(crate) struct ComputerScope {
    key: String,
    computer_id: String,
    directory: PathBuf,
}

fn validate_scope_id(value: &str) -> Result<(), String> {
    if !(3..=160).contains(&value.len())
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':'))
    {
        return Err("The local computer scope is invalid.".into());
    }
    Ok(())
}

pub(crate) fn normalize_user_navigation(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > MAX_URL_CHARACTERS {
        return Err("Enter a valid page address.".into());
    }
    let mut url = Url::parse(value).map_err(|_| "Enter a valid page address.".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
    {
        return Err("The local browser accepts credential-free HTTP or HTTPS addresses.".into());
    }
    url.set_fragment(None);
    Ok(url.to_string())
}

fn ensure_scope_directories(scope: &ComputerScope) -> Result<(), String> {
    std::fs::create_dir_all(&scope.directory)
        .map_err(|_| "Mivlet could not create the agent computer workspace.".to_string())?;
    crate::paths::strict_canonicalize(&scope.directory)
        .map_err(|_| "The agent computer directory failed its security check.".to_string())?;
    let workspace = scope.directory.join("workspace");
    std::fs::create_dir_all(&workspace)
        .map_err(|_| "Mivlet could not create the agent computer workspace.".to_string())?;
    crate::paths::strict_canonicalize(&workspace)
        .map_err(|_| "A agent computer directory failed its security check.".to_string())?;
    Ok(())
}

fn workspace_files_snapshot(scope: &ComputerScope) -> Result<LocalComputerFilesSnapshot, String> {
    let workspace = scope.directory.join("workspace");
    let canonical_root = crate::paths::strict_canonicalize(&workspace)
        .map_err(|_| "The agent computer workspace failed its security check.".to_string())?;
    let mut pending = VecDeque::from([(canonical_root.clone(), 0_usize)]);
    let mut entries = Vec::new();
    let mut truncated = false;

    while let Some((directory, depth)) = pending.pop_front() {
        let canonical_directory = crate::paths::strict_canonicalize(&directory)
            .map_err(|_| "A agent folder failed its security check.".to_string())?;
        if !canonical_directory.starts_with(&canonical_root) {
            return Err("A agent folder escaped its private workspace.".into());
        }
        let mut children = std::fs::read_dir(&canonical_directory)
            .map_err(|_| "Mivlet could not list this agent's files.".to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "Mivlet could not list this agent's files.".to_string())?;
        children.sort_by_key(|entry| entry.file_name().to_string_lossy().to_lowercase());

        for child in children {
            if entries.len() >= MAX_FILE_ENTRIES {
                truncated = true;
                break;
            }
            let path = child.path();
            if crate::paths::contains_symlink(&path) {
                continue;
            }
            let Ok(metadata) = std::fs::symlink_metadata(&path) else {
                truncated = true;
                continue;
            };
            if !metadata.is_file() && !metadata.is_dir() {
                continue;
            }
            let relative = path
                .strip_prefix(&canonical_root)
                .map_err(|_| "A agent file escaped its private workspace.".to_string())?;
            let Some(relative_path) = relative.to_str() else {
                continue;
            };
            let relative_path = relative_path.replace('\\', "/");
            let Some(name) = child.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if relative_path.is_empty()
                || relative_path.chars().count() > 512
                || contains_unsafe_display_characters(&relative_path)
                || name.is_empty()
                || name.chars().count() > 160
                || contains_unsafe_display_characters(&name)
            {
                truncated = true;
                continue;
            }
            let is_directory = metadata.is_dir();
            entries.push(LocalComputerFileEntry {
                path: relative_path,
                name,
                kind: if is_directory { "directory" } else { "file" },
                size_bytes: metadata
                    .is_file()
                    .then_some(metadata.len().min(MAX_SAFE_UI_BYTES)),
            });
            if is_directory {
                if depth < MAX_FILE_DEPTH {
                    pending.push_back((path, depth + 1));
                } else {
                    truncated = true;
                }
            }
        }
        if entries.len() >= MAX_FILE_ENTRIES {
            truncated = true;
            break;
        }
    }
    entries.sort_by(|left, right| {
        left.path
            .to_lowercase()
            .cmp(&right.path.to_lowercase())
            .then_with(|| left.path.cmp(&right.path))
    });
    Ok(LocalComputerFilesSnapshot {
        computer_id: scope.computer_id.clone(),
        entries,
        truncated,
        updated_at: Utc::now().to_rfc3339(),
    })
}

fn contains_unsafe_display_characters(value: &str) -> bool {
    value.chars().any(|character| {
        character.is_control()
            || matches!(
                character,
                '\u{061c}'
                    | '\u{200e}'
                    | '\u{200f}'
                    | '\u{202a}'..='\u{202e}'
                    | '\u{2066}'..='\u{2069}'
            )
    })
}

fn attachment_type(name: &str) -> Result<(String, &'static str), String> {
    if name.is_empty()
        || name.chars().count() > 180
        || name.contains('/')
        || name.contains('\\')
        || contains_unsafe_display_characters(name)
    {
        return Err("Choose an attachment with a safe file name.".into());
    }
    let extension = name
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .ok_or_else(|| "Choose a supported text attachment.".to_string())?;
    let mime_type = match extension.as_str() {
        "txt" => "text/plain",
        "md" | "markdown" => "text/markdown",
        "json" => "application/json",
        "csv" => "text/csv",
        "yaml" | "yml" => "application/yaml",
        _ => {
            return Err("Mivlet can stage text, Markdown, JSON, CSV, and YAML attachments.".into())
        }
    };
    Ok((extension, mime_type))
}

fn attachment_stem(name: &str) -> String {
    let raw = name.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(name);
    let mut slug = String::new();
    let mut separator = false;
    for character in raw.chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character.to_ascii_lowercase());
            separator = false;
        } else if !separator && !slug.is_empty() {
            slug.push('-');
            separator = true;
        }
        if slug.len() >= 48 {
            break;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() {
        "attachment".into()
    } else {
        slug
    }
}

fn write_staged_attachment(
    directory: &Path,
    batch_id: &str,
    relative_directory: &str,
    computer_id: &str,
    request: &LocalComputerAttachmentStageInput,
) -> Result<LocalComputerAttachmentReceipt, String> {
    validate_scope_id(&request.attachment_id)?;
    let (extension, mime_type) = attachment_type(&request.name)?;
    if request.mime_type.chars().count() > 120
        || contains_unsafe_display_characters(&request.mime_type)
    {
        return Err("The attachment media type is invalid.".into());
    }
    let max_encoded = MAX_ATTACHMENT_BYTES.div_ceil(3) * 4;
    if request.content_base64.is_empty() || request.content_base64.len() > max_encoded {
        return Err("Choose a non-empty text attachment smaller than 2 MB.".into());
    }
    let bytes = STANDARD
        .decode(&request.content_base64)
        .map_err(|_| "The attachment bytes are malformed.".to_string())?;
    if bytes.is_empty() || bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err("Choose a non-empty text attachment smaller than 2 MB.".into());
    }
    std::str::from_utf8(&bytes)
        .map_err(|_| "The attachment must contain valid UTF-8 text.".to_string())?;
    let opaque = desktop_tools::opaque_id()?;
    let file_name = format!(
        "{}-{}.{}",
        attachment_stem(&request.name),
        &opaque[..12],
        extension
    );
    let path = directory.join(&file_name);
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|_| "Mivlet could not create a collision-safe attachment file.".to_string())?;
    if std::io::Write::write_all(&mut file, &bytes)
        .and_then(|_| file.sync_all())
        .is_err()
    {
        let _ = std::fs::remove_file(&path);
        return Err("Mivlet could not finish staging the attachment.".into());
    }
    let mut digest = Sha256::new();
    digest.update(&bytes);
    Ok(LocalComputerAttachmentReceipt {
        computer_id: computer_id.into(),
        batch_id: batch_id.into(),
        attachment_id: request.attachment_id.clone(),
        original_name: request.name.clone(),
        mime_type: mime_type.into(),
        relative_path: format!("{relative_directory}/{file_name}"),
        size_bytes: bytes.len() as u64,
        sha256: hex::encode(digest.finalize()),
        staged_at: Utc::now().to_rfc3339(),
    })
}

fn write_staged_attachments(
    workspace: &Path,
    computer_id: &str,
    attachments: &[LocalComputerAttachmentStageInput],
    ticket: &OperationTicket,
) -> Result<(PathBuf, Vec<LocalComputerAttachmentReceipt>), String> {
    if attachments.is_empty() || attachments.len() > 12 {
        return Err("Choose between 1 and 12 readable attachments.".into());
    }
    let mut attachment_ids = HashSet::with_capacity(attachments.len());
    for attachment in attachments {
        validate_scope_id(&attachment.attachment_id)?;
        if !attachment_ids.insert(&attachment.attachment_id) {
            return Err("Each readable attachment must have a unique identity.".into());
        }
    }
    let attachments_directory = workspace.join("Attachments");
    std::fs::create_dir_all(&attachments_directory)
        .map_err(|_| "Mivlet could not prepare attachment storage.".to_string())?;
    let canonical_workspace = crate::paths::strict_canonicalize(workspace)
        .map_err(|_| "The agent computer workspace failed its security check.".to_string())?;
    let canonical_attachments = crate::paths::strict_canonicalize(&attachments_directory)
        .map_err(|_| "Attachment storage failed its security check.".to_string())?;
    if !canonical_attachments.starts_with(&canonical_workspace) {
        return Err("Attachment storage escaped this agent's workspace.".into());
    }
    let opaque = desktop_tools::opaque_id()?;
    let batch_id = &opaque[..12];
    let batch_name = format!("upload-{batch_id}");
    let batch_directory = canonical_attachments.join(&batch_name);
    std::fs::create_dir(&batch_directory)
        .map_err(|_| "Mivlet could not reserve collision-safe attachment storage.".to_string())?;
    let canonical_batch = crate::paths::strict_canonicalize(&batch_directory)
        .map_err(|_| "Attachment storage failed its security check.".to_string())?;
    if !canonical_batch.starts_with(&canonical_attachments) {
        let _ = std::fs::remove_dir_all(&batch_directory);
        return Err("Attachment storage escaped this agent's workspace.".into());
    }
    let relative_directory = format!("Attachments/{batch_name}");
    let result = (|| {
        let mut receipts = Vec::with_capacity(attachments.len());
        for attachment in attachments {
            ticket.check()?;
            receipts.push(write_staged_attachment(
                &canonical_batch,
                batch_id,
                &relative_directory,
                computer_id,
                attachment,
            )?);
        }
        ticket.check()?;
        Ok(receipts)
    })();
    match result {
        Ok(receipts) => Ok((canonical_batch, receipts)),
        Err(error) => {
            let _ = std::fs::remove_dir_all(&canonical_batch);
            Err(error)
        }
    }
}

fn discard_attachment_batch(
    computers: &LocalComputerState,
    request: &LocalComputerAttachmentDiscardRequest,
) -> Result<(), String> {
    computers.validate_target(&request.workspace_id, &request.agent_id)?;
    validate_scope_id(&request.computer_id)?;
    validate_scope_id(&request.batch_id)?;
    let scope = computers.scope(&request.workspace_id, &request.agent_id)?;
    discard_scoped_attachment_batch(&scope, request)
}

fn discard_scoped_attachment_batch(
    scope: &ComputerScope,
    request: &LocalComputerAttachmentDiscardRequest,
) -> Result<(), String> {
    if scope.computer_id != request.computer_id {
        return Err("The attachment batch belongs to a different agent computer.".into());
    }
    let workspace = crate::paths::strict_canonicalize(&scope.directory.join("workspace"))
        .map_err(|_| "The agent computer workspace failed its security check.".to_string())?;
    let attachments = workspace.join("Attachments");
    let batch = attachments.join(format!("upload-{}", request.batch_id));
    if !batch.exists() {
        return Ok(());
    }
    let canonical_workspace = crate::paths::strict_canonicalize(&workspace)
        .map_err(|_| "The agent computer workspace failed its security check.".to_string())?;
    let canonical_batch = crate::paths::strict_canonicalize(&batch)
        .map_err(|_| "The attachment batch failed its security check.".to_string())?;
    if !canonical_batch.starts_with(canonical_workspace.join("Attachments")) {
        return Err("The attachment batch escaped this agent's workspace.".into());
    }
    std::fs::remove_dir_all(canonical_batch)
        .map_err(|_| "Mivlet could not discard the unused attachment batch.".to_string())
}

fn finish_staged_attachments(
    ticket: OperationTicket,
    batch_directory: PathBuf,
    receipts: Vec<LocalComputerAttachmentReceipt>,
) -> Result<Vec<LocalComputerAttachmentReceipt>, String> {
    match ticket.finish(Ok(receipts)) {
        Ok(receipts) => Ok(receipts),
        Err(error) => {
            let _ = std::fs::remove_dir_all(batch_directory);
            Err(error)
        }
    }
}

fn workspace_file_preview(
    scope: &ComputerScope,
    requested_path: &str,
) -> Result<LocalComputerFilePreview, String> {
    if requested_path.is_empty()
        || requested_path.chars().count() > 512
        || contains_unsafe_display_characters(requested_path)
    {
        return Err("Choose a valid relative file path.".into());
    }
    let workspace = scope.directory.join("workspace");
    let canonical_root = crate::paths::strict_canonicalize(&workspace)
        .map_err(|_| "The agent computer workspace failed its security check.".to_string())?;
    let confined = crate::tools::confine_path(requested_path, &workspace)
        .map_err(|_| "That file is outside this agent's private workspace.".to_string())?;
    let canonical_file = crate::paths::strict_canonicalize(&confined)
        .map_err(|_| "Choose an existing private file.".to_string())?;
    if !canonical_file.starts_with(&canonical_root) {
        return Err("That file is outside this agent's private workspace.".into());
    }
    let metadata = std::fs::metadata(&canonical_file)
        .map_err(|_| "Mivlet could not inspect that private file.".to_string())?;
    if !metadata.is_file() {
        return Err("Choose a regular text file to preview.".into());
    }
    let relative = canonical_file
        .strip_prefix(&canonical_root)
        .map_err(|_| "That file is outside this agent's private workspace.".to_string())?;
    let path = relative
        .to_str()
        .map(|value| value.replace('\\', "/"))
        .filter(|value| {
            !value.is_empty()
                && value.chars().count() <= 512
                && !contains_unsafe_display_characters(value)
        })
        .ok_or_else(|| "That private file name cannot be displayed safely.".to_string())?;
    let mut file = std::fs::File::open(&canonical_file)
        .map_err(|_| "Mivlet could not open that private file.".to_string())?;
    let mut bytes = Vec::with_capacity(MAX_FILE_PREVIEW_BYTES + 1);
    std::io::Read::read_to_end(
        &mut std::io::Read::take(&mut file, (MAX_FILE_PREVIEW_BYTES + 1) as u64),
        &mut bytes,
    )
    .map_err(|_| "Mivlet could not read that private file.".to_string())?;
    let truncated = bytes.len() > MAX_FILE_PREVIEW_BYTES;
    bytes.truncate(MAX_FILE_PREVIEW_BYTES);
    let content = match std::str::from_utf8(&bytes) {
        Ok(value) => value,
        Err(error) if error.error_len().is_none() => {
            std::str::from_utf8(&bytes[..error.valid_up_to()])
                .map_err(|_| "Only UTF-8 text files can be previewed.".to_string())?
        }
        Err(_) => return Err("Only UTF-8 text files can be previewed.".into()),
    };
    if content
        .chars()
        .any(|value| value.is_control() && !matches!(value, '\n' | '\r' | '\t'))
    {
        return Err("Only plain UTF-8 text files can be previewed.".into());
    }
    Ok(LocalComputerFilePreview {
        computer_id: scope.computer_id.clone(),
        path,
        content: content.to_string(),
        size_bytes: metadata.len().min(MAX_SAFE_UI_BYTES),
        truncated,
        updated_at: Utc::now().to_rfc3339(),
    })
}

fn computer_snapshot(
    state: &LocalComputerState,
    workspace_id: String,
    agent_id: String,
) -> Result<LocalComputerSnapshot, String> {
    let scope = state.scope(&workspace_id, &agent_id)?;
    ensure_scope_directories(&scope)?;
    let authority = state.authority(&scope)?.snapshot()?;
    let control = state.native.snapshot(&workspace_id, &agent_id)?;
    let error = state
        .activity_error
        .lock()
        .map_err(|_| "Computer activity is unavailable.")?
        .clone();
    let runtime_available = cfg!(all(windows, target_arch = "x86_64"))
        && state.driver_directory.join("cua-driver.exe").is_file()
        && error.is_none();
    Ok(LocalComputerSnapshot{plugins:state.plugins.snapshot(),computer_id:scope.computer_id,workspace_id,agent_id,locality:"local",backend:"cua-driver",isolation:"windows-session",lifecycle:"ready",controller:if authority.transitioning{"paused"}else{"agent"},generation:authority.generation,
        capabilities:vec!["persistent-files","app-observe","app-control"],runtime_available,control,retired_computer:authority.retired_docker,
        message:error.or_else(||(!runtime_available).then(||"The bundled Windows x64 computer runtime is unavailable. Repair the Mivlet installation.".into())),updated_at:Utc::now().to_rfc3339()})
}
#[tauri::command]
pub async fn local_computer_status(
    workspace_id: String,
    agent_id: String,
    state: State<'_, Arc<LocalComputerState>>,
) -> Result<LocalComputerSnapshot, String> {
    state.validate_target(&workspace_id, &agent_id)?;
    computer_snapshot(&state, workspace_id, agent_id)
}
#[tauri::command]
pub async fn local_computer_files(
    target: LocalComputerTarget,
    state: State<'_, Arc<LocalComputerState>>,
) -> Result<LocalComputerFilesSnapshot, String> {
    state.validate_target(&target.workspace_id, &target.agent_id)?;
    let scope = state.scope(&target.workspace_id, &target.agent_id)?;
    if !scope.directory.join("workspace").is_dir() {
        return Err("Set up this agent's local computer before viewing its files.".into());
    }
    tauri::async_runtime::spawn_blocking(move || workspace_files_snapshot(&scope))
        .await
        .map_err(|_| "The local file-list task stopped unexpectedly.".to_string())?
}

#[tauri::command]
pub async fn local_computer_file_preview(
    request: LocalComputerFileRequest,
    state: State<'_, Arc<LocalComputerState>>,
) -> Result<LocalComputerFilePreview, String> {
    state.validate_target(&request.workspace_id, &request.agent_id)?;
    let scope = state.scope(&request.workspace_id, &request.agent_id)?;
    if !scope.directory.join("workspace").is_dir() {
        return Err("Set up this agent's local computer before viewing its files.".into());
    }
    tauri::async_runtime::spawn_blocking(move || workspace_file_preview(&scope, &request.path))
        .await
        .map_err(|_| "The local file-preview task stopped unexpectedly.".to_string())?
}

#[tauri::command]
pub async fn local_computer_stage_attachment(
    request: LocalComputerAttachmentStageRequest,
    state: State<'_, Arc<LocalComputerState>>,
) -> Result<Vec<LocalComputerAttachmentReceipt>, String> {
    state.validate_target(&request.workspace_id, &request.agent_id)?;
    let computers = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let computer_id = computers
            .scope(&request.workspace_id, &request.agent_id)?
            .computer_id;
        let ticket = computers.begin_agent_operation(
            &request.workspace_id,
            &request.agent_id,
            request.expected_generation,
        )?;
        ticket.check()?;
        let workspace = computers.tool_workspace_root(&request.workspace_id, &request.agent_id)?;
        let (batch_directory, receipts) =
            match write_staged_attachments(&workspace, &computer_id, &request.attachments, &ticket)
            {
                Ok(value) => value,
                Err(error) => return ticket.finish(Err(error)),
            };
        finish_staged_attachments(ticket, batch_directory, receipts)
    })
    .await
    .map_err(|_| "The attachment staging task stopped unexpectedly.".to_string())?
}

#[tauri::command]
pub async fn local_computer_discard_attachment_batch(
    request: LocalComputerAttachmentDiscardRequest,
    state: State<'_, Arc<LocalComputerState>>,
) -> Result<(), String> {
    let computers = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || discard_attachment_batch(&computers, &request))
        .await
        .map_err(|_| "The attachment cleanup task stopped unexpectedly.".to_string())?
}

#[tauri::command]
pub async fn local_computer_cancel(
    request: LocalComputerCancelRequest,
    state: State<'_, Arc<LocalComputerState>>,
) -> Result<LocalComputerSnapshot, String> {
    state.validate_target(&request.workspace_id, &request.agent_id)?;
    state.native.stop_scope(
        &request.workspace_id,
        &request.agent_id,
        request.expected_generation,
        "Task cancelled. Queued computer input was stopped. Fresh permission is required.",
    );
    let authority = state.authority_for(&request.workspace_id, &request.agent_id)?;
    if authority.snapshot()?.generation == request.expected_generation {
        authority.revoke_and_drain_later();
    }
    computer_snapshot(&state, request.workspace_id, request.agent_id)
}
pub(crate) async fn shutdown_all(state: Arc<LocalComputerState>) {
    if state.closing.swap(true, Ordering::AcqRel) {
        return;
    }
    state
        .native
        .stop("Mivlet closed. Computer permission was revoked.");
    if let Ok(authorities) = state.authorities.lock() {
        for authority in authorities.values() {
            authority.revoke_and_drain_later();
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scope_directories_are_stable_and_agent_isolated() {
        let temp = tempfile::tempdir().unwrap();
        let state = LocalComputerState::for_test(temp.path().to_path_buf());
        let first = state.scope("workspace-one", "agent-one").unwrap();
        let replay = state.scope("workspace-one", "agent-one").unwrap();
        let second = state.scope("workspace-one", "agent-two").unwrap();
        assert_eq!(first.directory, replay.directory);
        assert_eq!(first.computer_id, replay.computer_id);
        assert_ne!(first.directory, second.directory);
        assert!(first.directory.starts_with(temp.path()));
    }

    #[test]
    fn scope_rejects_paths_and_ambiguous_identifiers() {
        let temp = tempfile::tempdir().unwrap();
        let state = LocalComputerState::for_test(temp.path().to_path_buf());
        for value in ["..", "C:/Users", "agent/name", " agent", "a"] {
            assert!(state.scope("workspace-one", value).is_err(), "{value}");
        }
    }

    #[test]
    fn user_navigation_is_credential_free_and_http_only() {
        assert_eq!(
            normalize_user_navigation("https://example.com/path#private").unwrap(),
            "https://example.com/path"
        );
        for value in [
            "file:///C:/Users/example",
            "javascript:alert(1)",
            "https://user:password@example.com",
            "not a url",
        ] {
            assert!(normalize_user_navigation(value).is_err(), "{value}");
        }
    }

    #[test]
    fn provisioned_directories_are_bounded_to_the_scope() {
        let temp = tempfile::tempdir().unwrap();
        let state = LocalComputerState::for_test(temp.path().to_path_buf());
        let scope = state.scope("workspace-one", "agent-one").unwrap();
        ensure_scope_directories(&scope).unwrap();
        assert!(scope.directory.join("workspace").is_dir());
        assert!(!scope.directory.join("browser-profile").exists());
        assert!(!scope.directory.join("downloads").exists());
        assert_eq!(
            state
                .tool_workspace_root("workspace-one", "agent-one")
                .unwrap(),
            scope.directory.join("workspace")
        );
        assert!(state
            .tool_workspace_root("workspace-one", "agent-two")
            .is_err());
    }

    #[test]
    fn workspace_file_projection_is_relative_bounded_and_content_free() {
        let temp = tempfile::tempdir().unwrap();
        let state = LocalComputerState::for_test(temp.path().to_path_buf());
        let scope = state.scope("workspace-files", "agent-files").unwrap();
        ensure_scope_directories(&scope).unwrap();
        let workspace = scope.directory.join("workspace");
        std::fs::create_dir_all(workspace.join("notes")).unwrap();
        std::fs::write(workspace.join("notes").join("plan.md"), "private plan").unwrap();
        std::fs::write(workspace.join("summary.txt"), "ready").unwrap();

        let snapshot = workspace_files_snapshot(&scope).unwrap();
        assert_eq!(snapshot.computer_id, scope.computer_id);
        assert!(!snapshot.truncated);
        assert!(snapshot.entries.iter().any(|entry| {
            entry.path == "notes" && entry.name == "notes" && entry.kind == "directory"
        }));
        assert!(snapshot.entries.iter().any(|entry| {
            entry.path == "notes/plan.md"
                && entry.name == "plan.md"
                && entry.kind == "file"
                && entry.size_bytes == Some(12)
        }));
        let encoded = serde_json::to_string(&snapshot).unwrap();
        assert!(!encoded.contains(temp.path().to_string_lossy().as_ref()));
        assert!(!encoded.contains("private plan"));
    }

    #[test]
    fn workspace_file_projection_reports_its_entry_limit() {
        let temp = tempfile::tempdir().unwrap();
        let state = LocalComputerState::for_test(temp.path().to_path_buf());
        let scope = state.scope("workspace-many", "agent-many").unwrap();
        ensure_scope_directories(&scope).unwrap();
        let workspace = scope.directory.join("workspace");
        for index in 0..=MAX_FILE_ENTRIES {
            std::fs::write(workspace.join(format!("file-{index:03}.txt")), "x").unwrap();
        }

        let snapshot = workspace_files_snapshot(&scope).unwrap();
        assert_eq!(snapshot.entries.len(), MAX_FILE_ENTRIES);
        assert!(snapshot.truncated);
    }

    #[test]
    fn workspace_file_preview_is_relative_utf8_and_content_bounded() {
        let temp = tempfile::tempdir().unwrap();
        let state = LocalComputerState::for_test(temp.path().to_path_buf());
        let scope = state.scope("workspace-preview", "agent-preview").unwrap();
        ensure_scope_directories(&scope).unwrap();
        let workspace = scope.directory.join("workspace");
        std::fs::create_dir_all(workspace.join("notes")).unwrap();
        std::fs::write(workspace.join("notes").join("plan.md"), "hello\nworld").unwrap();

        let preview = workspace_file_preview(&scope, "notes/./plan.md").unwrap();
        assert_eq!(preview.path, "notes/plan.md");
        assert_eq!(preview.content, "hello\nworld");
        assert_eq!(preview.size_bytes, 11);
        assert!(!preview.truncated);
        let encoded = serde_json::to_string(&preview).unwrap();
        assert!(!encoded.contains(temp.path().to_string_lossy().as_ref()));

        std::fs::write(
            workspace.join("large.txt"),
            vec![b'a'; MAX_FILE_PREVIEW_BYTES + 10],
        )
        .unwrap();
        let large = workspace_file_preview(&scope, "large.txt").unwrap();
        assert_eq!(large.content.len(), MAX_FILE_PREVIEW_BYTES);
        assert!(large.truncated);
    }

    #[test]
    fn workspace_file_preview_rejects_escape_binary_and_directory() {
        let temp = tempfile::tempdir().unwrap();
        let state = LocalComputerState::for_test(temp.path().to_path_buf());
        let scope = state.scope("workspace-reject", "agent-reject").unwrap();
        ensure_scope_directories(&scope).unwrap();
        let workspace = scope.directory.join("workspace");
        std::fs::create_dir_all(workspace.join("folder")).unwrap();
        std::fs::write(workspace.join("binary.bin"), [0_u8, 159, 146, 150]).unwrap();
        std::fs::write(workspace.join("spoof-\u{202e}txt.md"), "text").unwrap();

        assert!(workspace_file_preview(&scope, "../outside.txt").is_err());
        assert!(workspace_file_preview(&scope, "binary.bin").is_err());
        assert!(workspace_file_preview(&scope, "folder").is_err());
        assert!(workspace_file_preview(&scope, "spoof-\u{202e}txt.md").is_err());
    }

    fn attachment_request(name: &str, bytes: &[u8]) -> LocalComputerAttachmentStageInput {
        LocalComputerAttachmentStageInput {
            attachment_id: "attachment-123".into(),
            name: name.into(),
            mime_type: "text/plain".into(),
            content_base64: STANDARD.encode(bytes),
        }
    }

    #[test]
    fn staged_attachments_preserve_exact_bytes_and_never_overwrite() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        let batch = workspace.join("Attachments").join("upload-test");
        std::fs::create_dir_all(&batch).unwrap();
        let request = attachment_request("Quarterly totals.csv", b"name,value\r\nalpha,6\r\n");
        let first = write_staged_attachment(
            &batch,
            "test-batch",
            "Attachments/upload-test",
            "computer-one",
            &request,
        )
        .unwrap();
        let second = write_staged_attachment(
            &batch,
            "test-batch",
            "Attachments/upload-test",
            "computer-one",
            &request,
        )
        .unwrap();
        assert_ne!(first.relative_path, second.relative_path);
        assert!(first
            .relative_path
            .starts_with("Attachments/upload-test/quarterly-totals-"));
        assert_eq!(first.mime_type, "text/csv");
        assert_eq!(first.size_bytes, 21);
        assert_eq!(
            std::fs::read(workspace.join(first.relative_path.replace('/', "\\"))).unwrap(),
            b"name,value\r\nalpha,6\r\n"
        );
    }

    #[test]
    fn staged_attachments_reject_unsafe_names_types_and_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let batch = temp.path().join("upload-test");
        std::fs::create_dir(&batch).unwrap();
        for mut request in [
            attachment_request("../private.txt", b"safe"),
            attachment_request("payload.exe", b"safe"),
            attachment_request("invalid.txt", &[0xff, 0xfe]),
            attachment_request("empty.txt", b""),
        ] {
            request.attachment_id = "attachment-safe".into();
            assert!(write_staged_attachment(
                &batch,
                "test-batch",
                "Attachments/upload-test",
                "computer-one",
                &request,
            )
            .is_err());
        }
        assert!(std::fs::read_dir(&batch).unwrap().next().is_none());
    }

    #[test]
    fn cancelled_attachment_batch_removes_every_staged_file() {
        let temp = tempfile::tempdir().unwrap();
        let state = LocalComputerState::for_test(temp.path().to_path_buf());
        let scope = state.scope("workspace-files", "agent-files").unwrap();
        ensure_scope_directories(&scope).unwrap();
        let authority = state
            .authority_for("workspace-files", "agent-files")
            .unwrap();
        let ticket = authority.begin_agent(1).unwrap();
        let workspace = scope.directory.join("workspace");
        let mut second = attachment_request("two.md", b"two");
        second.attachment_id = "attachment-456".into();
        let (batch, receipts) = write_staged_attachments(
            &workspace,
            &scope.computer_id,
            &[attachment_request("one.txt", b"one"), second],
            &ticket,
        )
        .unwrap();
        assert!(batch.is_dir());
        authority.revoke(1).unwrap();
        assert!(finish_staged_attachments(ticket, batch.clone(), receipts).is_err());
        assert!(!batch.exists());
    }

    #[test]
    fn unadopted_attachment_batch_can_be_discarded_after_commit() {
        let temp = tempfile::tempdir().unwrap();
        let state = LocalComputerState::for_test(temp.path().to_path_buf());
        let scope = state.scope("workspace-files", "agent-files").unwrap();
        ensure_scope_directories(&scope).unwrap();
        let authority = state
            .authority_for("workspace-files", "agent-files")
            .unwrap();
        let ticket = authority.begin_agent(1).unwrap();
        let (batch, receipts) = write_staged_attachments(
            &scope.directory.join("workspace"),
            &scope.computer_id,
            &[attachment_request("one.txt", b"one")],
            &ticket,
        )
        .unwrap();
        let receipts = finish_staged_attachments(ticket, batch.clone(), receipts).unwrap();
        discard_scoped_attachment_batch(
            &scope,
            &LocalComputerAttachmentDiscardRequest {
                workspace_id: "workspace-files".into(),
                agent_id: "agent-files".into(),
                computer_id: scope.computer_id.clone(),
                batch_id: receipts[0].batch_id.clone(),
            },
        )
        .unwrap();
        assert!(!batch.exists());
    }
}
