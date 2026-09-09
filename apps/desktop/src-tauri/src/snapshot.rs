//! Runtime snapshot recovery, imported-knowledge persistence, runtime status,
//! and the file-import Tauri command.
//!
//! Public Tauri commands (names must stay stable): `runtime_status`,
//! `list_imported_knowledge_sources`, `import_local_knowledge_source`,
//! `load_runtime_snapshot`, `save_runtime_snapshot`.

use std::{collections::HashSet, fs, path::Path};

use crate::approvals::{normalize_approval_audit_entry, normalize_approval_grant};
use crate::authorized_scope::{command_scope, ScopeAccess};
use crate::knowledge::import_local_text_file;
use crate::memory::normalize_memory_state;
use crate::models::MemoryControlState;
use crate::models::{
    ApprovalAuditEntry, ApprovalGrant, ContextRecordAuthorityScope, FableAgentProfile,
    LocalFileImport, LocalKnowledgeRefreshResponse, LocalTextFileCandidate,
    RefreshLocalKnowledgeSourceRequest, RuntimeSnapshot, RuntimeStatus, APPROVAL_MODES,
    MAX_APPROVAL_AUDIT_ENTRIES, MAX_IMPORTED_KNOWLEDGE_SOURCES, MAX_LOCAL_FILE_BYTES,
    MAX_LOCAL_FILE_PREVIEW_CHARACTERS, MAX_MEMORY_TITLE_CHARACTERS,
    MAX_RUNTIME_SNAPSHOT_DRAFT_CHARACTERS, MAX_RUNTIME_SNAPSHOT_IDS,
    MAX_RUNTIME_SNAPSHOT_ID_CHARACTERS, RUNTIME_SNAPSHOT_VERSION,
};
use crate::paths::{
    imported_knowledge_path, normalize_spaces, runtime_snapshot_path, truncate_characters,
};
use crate::store::repos::scope::{DataScope, PrivateDataScope};

pub(crate) fn canonicalize_private_source(
    mut source: LocalFileImport,
    scope: &PrivateDataScope,
) -> Result<LocalFileImport, String> {
    source = normalize_imported_knowledge_source(source)?;
    source.workspace_id = Some(scope.workspace_id().to_string());
    source.authority_scope = Some(ContextRecordAuthorityScope {
        authority: "local".into(),
        visibility: "member-private".into(),
        owner_member_id: scope.owner_member_id().map(str::to_string),
        owner_internal_user_id: scope.owner_internal_user_id().map(str::to_string),
    });
    source.scope = Some(match scope.project_id() {
        Some(project_id) => serde_json::json!({"level":"project","projectId":project_id}),
        None => serde_json::json!({"level":"global"}),
    });
    Ok(source)
}

fn data_scope(
    workspace_id: Option<String>,
    project_id: Option<String>,
) -> Result<DataScope, String> {
    let workspace_id = workspace_id.ok_or_else(|| "Workspace id is required.".to_string())?;
    DataScope::new(workspace_id, project_id).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn runtime_status() -> RuntimeStatus {
    RuntimeStatus {
        permission_mode: "read-only",
        offline_ready: true,
        connector_boundaries: [
            "local-files",
            "github",
            "vercel",
            "google-drive",
            "notion",
            "gmail",
            "slack",
            "google-calendar",
            "linear",
        ],
    }
}

fn normalize_imported_knowledge_source(source: LocalFileImport) -> Result<LocalFileImport, String> {
    let id = truncate_characters(
        &normalize_spaces(&source.id),
        MAX_RUNTIME_SNAPSHOT_ID_CHARACTERS,
    );
    let title = truncate_characters(
        &normalize_spaces(&source.title),
        MAX_MEMORY_TITLE_CHARACTERS,
    );
    let provenance = truncate_characters(
        &normalize_spaces(&source.provenance),
        MAX_MEMORY_TITLE_CHARACTERS,
    );
    let freshness = truncate_characters(
        &normalize_spaces(&source.freshness),
        MAX_MEMORY_TITLE_CHARACTERS,
    );
    let content_fingerprint = normalize_spaces(&source.content_fingerprint);
    let imported_at = normalize_spaces(&source.imported_at);

    if id.is_empty() || title.is_empty() || content_fingerprint.is_empty() || imported_at.is_empty()
    {
        return Err("Imported knowledge sources need stable identifiers and metadata.".to_string());
    }

    if source.kind != "document"
        || source.connector_id != "local-files"
        || source.trust != "untrusted"
        || source.origin != "local-import"
    {
        return Err(
            "Imported knowledge sources must stay local, document-shaped, and untrusted."
                .to_string(),
        );
    }

    if source.size_bytes > MAX_LOCAL_FILE_BYTES {
        return Err("Imported knowledge source is too large for local recovery.".to_string());
    }

    Ok(LocalFileImport {
        workspace_id: source.workspace_id,
        authority_scope: source.authority_scope,
        id,
        title,
        kind: "document".to_string(),
        connector_id: "local-files".to_string(),
        provenance: if provenance.is_empty() {
            "Local file".to_string()
        } else {
            provenance
        },
        freshness: if freshness.is_empty() {
            "Imported now".to_string()
        } else {
            freshness
        },
        pinned: source.pinned,
        trust: "untrusted".to_string(),
        content_preview: truncate_characters(
            &normalize_spaces(&source.content_preview),
            MAX_LOCAL_FILE_PREVIEW_CHARACTERS,
        ),
        content_fingerprint,
        size_bytes: source.size_bytes,
        imported_at,
        origin: "local-import".to_string(),
        scope: source.scope,
        account: source.account,
        disabled: source.disabled,
        deleted_at: source.deleted_at,
        status: source.status,
        status_message: source.status_message,
    })
}

pub(crate) fn read_imported_knowledge_sources(path: &Path) -> Result<Vec<LocalFileImport>, String> {
    if let Some(sources) = crate::store::read_document(path)? {
        return Ok(sources);
    }
    if !path.exists() {
        return Ok(Vec::new());
    }

    let contents = fs::read_to_string(path)
        .map_err(|_| "Fable could not read imported knowledge sources.".to_string())?;

    if contents.trim().is_empty() {
        return Ok(Vec::new());
    }

    serde_json::from_str::<Vec<LocalFileImport>>(&contents)
        .map_err(|_| "Fable could not parse imported knowledge sources.".to_string())
}

pub(crate) fn read_imported_knowledge_sources_private(
    path: &Path,
    scope: &PrivateDataScope,
) -> Result<Vec<LocalFileImport>, String> {
    let sources: Vec<LocalFileImport> =
        crate::store::read_private_workspace_document(path, scope)?.unwrap_or_default();
    sources
        .into_iter()
        .map(|source| canonicalize_private_source(source, scope))
        .collect()
}

fn append_imported_knowledge_source(
    mut sources: Vec<LocalFileImport>,
    source: LocalFileImport,
) -> Result<Vec<LocalFileImport>, String> {
    if sources
        .iter()
        .any(|existing| existing.id == source.id && existing.deleted_at.is_some())
    {
        return Err("Deleted knowledge cannot be restored by an import.".to_string());
    }
    sources.retain(|existing| existing.id != source.id);
    sources.insert(0, source);
    sources.truncate(MAX_IMPORTED_KNOWLEDGE_SOURCES);
    Ok(sources)
}

fn apply_local_knowledge_refresh(
    existing: &LocalFileImport,
    request: RefreshLocalKnowledgeSourceRequest,
    scope: &DataScope,
) -> Result<LocalKnowledgeRefreshResponse, String> {
    if request.source_id.trim() != existing.id
        || request.expected_content_fingerprint.trim() != existing.content_fingerprint
    {
        return Err("This source changed elsewhere. Reload Knowledge and try again.".to_string());
    }
    if existing.deleted_at.is_some() {
        return Err("Deleted knowledge cannot be refreshed.".to_string());
    }
    if existing.kind != "document"
        || existing.connector_id != "local-files"
        || existing.origin != "local-import"
        || existing.trust != "untrusted"
    {
        return Err("Only local file imports can be refreshed.".to_string());
    }
    if let Some(source_scope) = existing.scope.as_ref() {
        let exact = match scope.project_id() {
            Some(project_id) => {
                source_scope
                    .get("level")
                    .and_then(serde_json::Value::as_str)
                    == Some("project")
                    && source_scope
                        .get("projectId")
                        .and_then(serde_json::Value::as_str)
                        == Some(project_id)
            }
            None => {
                source_scope
                    .get("level")
                    .and_then(serde_json::Value::as_str)
                    != Some("project")
            }
        };
        if !exact {
            return Err("Knowledge source does not belong to this scope.".to_string());
        }
    }

    let raw_name = request.file.name.trim();
    let basename = raw_name.rsplit(['/', '\\']).next().unwrap_or_default();
    if raw_name != basename || basename != existing.title {
        return Err(format!("Choose the current version of {}.", existing.title));
    }
    let selected_at = normalize_spaces(&request.file.selected_at);
    if selected_at.is_empty() {
        return Err("Refresh needs a selection time.".to_string());
    }
    if request
        .file
        .modified_at
        .as_deref()
        .is_some_and(|value| normalize_spaces(value).is_empty())
    {
        return Err("File modification time is invalid.".to_string());
    }
    let actual_size = request.file.content.len();
    if actual_size != request.file.size_bytes {
        return Err(
            "The selected file changed while Fable was reading it. Choose it again.".to_string(),
        );
    }
    if request.file.content.contains('\0')
        || request
            .file
            .content
            .chars()
            .take(8_192)
            .filter(|character| character.is_control() && !matches!(character, '\t' | '\n' | '\r'))
            .count()
            * 20
            > request.file.content.chars().take(8_192).count().max(1)
    {
        return Err("The selected file appears to be binary.".to_string());
    }
    if basename.to_ascii_lowercase().ends_with(".json")
        && serde_json::from_str::<serde_json::Value>(&request.file.content).is_err()
    {
        return Err("The selected JSON file is malformed.".to_string());
    }
    let content = request.file.content;
    let legacy_size = content.len();
    let imported = import_local_text_file(LocalTextFileCandidate {
        name: basename.to_string(),
        content,
        // import_local_text_file predates UTF-8 byte accounting. The exact byte
        // length was checked above; supply its legacy character unit here.
        size_bytes: legacy_size,
        imported_at: Some(selected_at),
    })?;
    if imported.content_fingerprint == existing.content_fingerprint {
        return Ok(LocalKnowledgeRefreshResponse {
            outcome: "unchanged",
            source: existing.clone(),
        });
    }
    let mut source = existing.clone();
    source.content_preview = imported.content_preview;
    source.content_fingerprint = imported.content_fingerprint;
    source.size_bytes = actual_size;
    source.imported_at = imported.imported_at;
    source.provenance = imported.provenance;
    source.freshness = "Refreshed now".to_string();
    source.status = Some("ok".to_string());
    source.status_message = None;
    Ok(LocalKnowledgeRefreshResponse {
        outcome: "updated",
        source,
    })
}

fn merge_deleted_imported_tombstones(
    mut sources: Vec<LocalFileImport>,
    existing: Vec<LocalFileImport>,
) -> Result<Vec<LocalFileImport>, String> {
    for tombstone in existing
        .into_iter()
        .filter(|source| source.deleted_at.is_some())
    {
        if let Some(incoming) = sources.iter().find(|source| source.id == tombstone.id) {
            if incoming.deleted_at.is_none() {
                return Err("Deleted knowledge cannot be restored by an import.".to_string());
            }
            continue;
        }
        sources.push(tombstone);
    }

    while sources.len() > MAX_IMPORTED_KNOWLEDGE_SOURCES {
        if let Some(index) = sources
            .iter()
            .rposition(|source| source.deleted_at.is_none())
        {
            sources.remove(index);
        } else {
            sources.truncate(MAX_IMPORTED_KNOWLEDGE_SOURCES);
        }
    }

    Ok(sources)
}

fn write_imported_knowledge_sources(
    path: &Path,
    sources: &[LocalFileImport],
) -> Result<(), String> {
    if crate::store::write_document(path, &sources)? {
        return Ok(());
    }
    let encoded = serde_json::to_string_pretty(sources)
        .map_err(|_| "Fable could not encode imported knowledge sources.".to_string())?;

    fs::write(path, encoded)
        .map_err(|_| "Fable could not save imported knowledge sources.".to_string())
}

#[tauri::command]
pub fn save_imported_knowledge_sources(
    app: tauri::AppHandle,
    sources: Vec<LocalFileImport>,
    workspace_id: Option<String>,
    project_id: Option<String>,
) -> Result<Vec<LocalFileImport>, String> {
    let mut normalized = Vec::new();
    for source in sources.into_iter().take(MAX_IMPORTED_KNOWLEDGE_SOURCES) {
        let source = normalize_imported_knowledge_source(source)?;
        if !normalized
            .iter()
            .any(|existing: &LocalFileImport| existing.id == source.id)
        {
            normalized.push(source);
        }
    }
    let path = imported_knowledge_path(&app)?;
    let authorized = command_scope(workspace_id, project_id, ScopeAccess::Write)?;
    let scope = &authorized.private;
    let normalized = normalized
        .into_iter()
        .map(|source| canonicalize_private_source(source, scope))
        .collect::<Result<Vec<_>, _>>()?;
    let existing: Vec<LocalFileImport> =
        crate::store::read_private_workspace_document(&path, scope)?.unwrap_or_default();
    let normalized = merge_deleted_imported_tombstones(normalized, existing)?;
    if !crate::store::write_private_workspace_document(&path, scope, &normalized)? {
        write_imported_knowledge_sources(&path, &normalized)?;
    }
    Ok(normalized)
}

pub(crate) fn persist_imported_knowledge_source(
    path: &Path,
    source: LocalFileImport,
) -> Result<LocalFileImport, String> {
    let source = normalize_imported_knowledge_source(source)?;
    let sources = read_imported_knowledge_sources(path)?;
    let sources = append_imported_knowledge_source(sources, source.clone())?;
    write_imported_knowledge_sources(path, &sources)?;

    Ok(source)
}

fn normalize_snapshot_id_list(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut normalized_values = Vec::new();

    for value in values {
        let normalized = truncate_characters(
            &normalize_spaces(&value),
            MAX_RUNTIME_SNAPSHOT_ID_CHARACTERS,
        );
        if normalized.is_empty() || !seen.insert(normalized.clone()) {
            continue;
        }

        normalized_values.push(normalized);
        if normalized_values.len() >= MAX_RUNTIME_SNAPSHOT_IDS {
            break;
        }
    }

    normalized_values
}

pub(crate) fn normalize_runtime_snapshot(
    snapshot: RuntimeSnapshot,
) -> Result<RuntimeSnapshot, String> {
    if snapshot.version != RUNTIME_SNAPSHOT_VERSION {
        return Err("Runtime snapshot version is not supported.".to_string());
    }

    let active_item = truncate_characters(
        &normalize_spaces(&snapshot.active_item),
        MAX_RUNTIME_SNAPSHOT_ID_CHARACTERS,
    );
    let composer_draft = truncate_characters(
        &snapshot.composer_draft,
        MAX_RUNTIME_SNAPSHOT_DRAFT_CHARACTERS,
    );
    let saved_at = normalize_spaces(&snapshot.saved_at);

    if active_item.is_empty() {
        return Err("Runtime snapshots need an active workspace item.".to_string());
    }

    if saved_at.is_empty() {
        return Err("Runtime snapshots need a saved time.".to_string());
    }

    let mut approval_audit = Vec::new();
    for entry in snapshot.approval_audit {
        let normalized = normalize_approval_audit_entry(entry)?;
        if !approval_audit
            .iter()
            .any(|existing: &ApprovalAuditEntry| existing.id == normalized.id)
        {
            approval_audit.push(normalized);
        }

        if approval_audit.len() >= MAX_APPROVAL_AUDIT_ENTRIES {
            break;
        }
    }

    let mut approval_rules = Vec::new();
    for grant in snapshot.approval_rules {
        let normalized = normalize_approval_grant(grant)?;
        if normalized.scope != "rule" {
            continue;
        }
        if !approval_rules.iter().any(|existing: &ApprovalGrant| {
            existing.service == normalized.service
                && existing.action == normalized.action
                && existing.mode == normalized.mode
        }) {
            approval_rules.push(normalized);
        }
        if approval_rules.len() >= 100 {
            break;
        }
    }

    let mut imported_knowledge_sources = Vec::new();
    for source in snapshot.imported_knowledge_sources {
        let normalized = normalize_imported_knowledge_source(source)?;
        if !imported_knowledge_sources
            .iter()
            .any(|existing: &LocalFileImport| existing.id == normalized.id)
        {
            imported_knowledge_sources.push(normalized);
        }

        if imported_knowledge_sources.len() >= MAX_IMPORTED_KNOWLEDGE_SOURCES {
            break;
        }
    }

    let memory_state = normalize_memory_state(MemoryControlState {
        disabled: snapshot.memory_disabled,
        records: snapshot.memory_records,
    })?;

    let agents = normalize_runtime_agents(snapshot.agents)?;
    let active_agent_id = snapshot
        .active_agent_id
        .map(|value| {
            truncate_characters(
                &normalize_spaces(&value),
                MAX_RUNTIME_SNAPSHOT_ID_CHARACTERS,
            )
        })
        .filter(|value| agents.iter().any(|agent| agent.id == *value));

    let permission_mode = if APPROVAL_MODES.contains(&snapshot.permission_mode.as_str()) {
        snapshot.permission_mode
    } else {
        "trusted-scope".to_string()
    };
    let permission_label = match snapshot.permission_label.as_deref() {
        Some("Read Only" | "Ask Me" | "Work Freely" | "Custom") => snapshot.permission_label,
        _ => Some(
            match permission_mode.as_str() {
                "read-only" => "Read Only",
                "full-access" => "Work Freely",
                _ => "Ask Me",
            }
            .to_string(),
        ),
    };

    Ok(RuntimeSnapshot {
        version: RUNTIME_SNAPSHOT_VERSION,
        active_item,
        composer_draft,
        voice_enabled: snapshot.voice_enabled,
        voice_provider: Some(
            if snapshot.voice_provider.as_deref() == Some("openai") {
                "openai"
            } else {
                "browser"
            }
            .to_string(),
        ),
        approval_audit,
        dismissed_approval_ids: normalize_snapshot_id_list(snapshot.dismissed_approval_ids),
        approval_rules,
        agents,
        active_agent_id,
        pinned_source_ids: normalize_snapshot_id_list(snapshot.pinned_source_ids),
        imported_knowledge_sources,
        memory_disabled: memory_state.disabled,
        memory_records: memory_state.records,
        // Provider ids only — secrets are never persisted into the snapshot.
        connected_backend_ids: normalize_snapshot_id_list(snapshot.connected_backend_ids),
        onboarding_complete: snapshot.onboarding_complete,
        onboarding_version: snapshot.onboarding_version,
        selected_model_id: truncate_characters(
            &normalize_spaces(&snapshot.selected_model_id),
            MAX_RUNTIME_SNAPSHOT_ID_CHARACTERS,
        ),
        permission_mode,
        hidden_model_ids: normalize_snapshot_id_list(snapshot.hidden_model_ids),
        permission_label,
        custom_approval_settings: snapshot.custom_approval_settings,
        saved_at,
    })
}

fn normalize_runtime_agents(
    agents: Vec<FableAgentProfile>,
) -> Result<Vec<FableAgentProfile>, String> {
    const ICON_COLORS: [&str; 10] = [
        "#6D5DF7", "#2672E8", "#13966F", "#D07A19", "#D6537D", "#A14FD1", "#0E8FA4", "#D2543D",
        "#626B78", "#202124",
    ];
    const PERMISSIONS: [&str; 4] = ["Read Only", "Ask Me", "Work Freely", "Custom"];
    let mut normalized = Vec::new();
    let mut seen_ids = HashSet::new();
    for (index, agent) in agents.into_iter().enumerate() {
        let id = truncate_characters(
            &normalize_spaces(&agent.id),
            MAX_RUNTIME_SNAPSHOT_ID_CHARACTERS,
        );
        let name = truncate_characters(&normalize_spaces(&agent.name), 80);
        if id.is_empty() || name.is_empty() || !seen_ids.insert(id.clone()) {
            continue;
        }
        let icon_color = if agent.icon_color.len() == 7
            && agent.icon_color.starts_with('#')
            && agent.icon_color[1..]
                .chars()
                .all(|character| character.is_ascii_hexdigit())
        {
            agent.icon_color.to_uppercase()
        } else {
            ICON_COLORS[index % ICON_COLORS.len()].to_string()
        };
        let icon_image_data_url = agent.icon_image_data_url.filter(|value| {
            value.len() <= 512_000
                && (value.starts_with("data:image/png;base64,")
                    || value.starts_with("data:image/jpeg;base64,")
                    || value.starts_with("data:image/webp;base64,"))
        });
        let permission_label = if PERMISSIONS.contains(&agent.permission_label.as_str()) {
            agent.permission_label
        } else {
            "Ask Me".to_string()
        };
        let avatar_seed = agent
            .avatar_seed
            .filter(|seed| seed.starts_with("blob-v1:") && seed.len() <= 160)
            .unwrap_or_else(|| format!("blob-v1:{id}"));
        normalized.push(FableAgentProfile {
            id,
            name,
            reasoning_effort: agent.reasoning_effort.filter(|value| {
                !value.is_empty()
                    && value.len() <= 32
                    && value
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
            }),
            thread_ids: normalize_snapshot_id_list(
                agent
                    .thread_ids
                    .into_iter()
                    .chain(agent.thread_id.clone())
                    .collect(),
            ),
            learned_tasks: agent
                .learned_tasks
                .into_iter()
                .take(24)
                .filter_map(|mut task| {
                    task.id = truncate_characters(task.id.trim(), 120);
                    task.title = truncate_characters(task.title.trim(), 120);
                    task.instruction = truncate_characters(task.instruction.trim(), 4_000);
                    task.created_at = truncate_characters(task.created_at.trim(), 40);
                    task.updated_at = truncate_characters(task.updated_at.trim(), 40);
                    if task.id.is_empty() || task.title.is_empty() || task.instruction.is_empty() {
                        None
                    } else {
                        Some(task)
                    }
                })
                .collect(),
            instructions: truncate_characters(&agent.instructions, 8_000),
            model_id: truncate_characters(
                &normalize_spaces(&agent.model_id),
                MAX_RUNTIME_SNAPSHOT_ID_CHARACTERS,
            ),
            icon: "agent".to_string(),
            icon_color,
            avatar_seed: Some(avatar_seed),
            icon_image_data_url,
            connector_ids: normalize_snapshot_id_list(agent.connector_ids),
            knowledge_source_ids: normalize_snapshot_id_list(agent.knowledge_source_ids),
            permission_label,
            thread_id: agent
                .thread_id
                .map(|value| {
                    truncate_characters(
                        &normalize_spaces(&value),
                        MAX_RUNTIME_SNAPSHOT_ID_CHARACTERS,
                    )
                })
                .filter(|value| !value.is_empty()),
        });
    }
    Ok(normalized)
}

pub(crate) fn write_runtime_snapshot(
    path: &Path,
    snapshot: RuntimeSnapshot,
) -> Result<RuntimeSnapshot, String> {
    let normalized = normalize_runtime_snapshot(snapshot)?;
    if crate::store::write_document(path, &normalized)? {
        return Ok(normalized);
    }
    let encoded = serde_json::to_string_pretty(&normalized)
        .map_err(|_| "Fable could not encode runtime snapshot.".to_string())?;

    fs::write(path, encoded).map_err(|_| "Fable could not save runtime snapshot.".to_string())?;

    Ok(normalized)
}

#[tauri::command]
pub fn list_imported_knowledge_sources(
    app: tauri::AppHandle,
    workspace_id: Option<String>,
    project_id: Option<String>,
) -> Result<Vec<LocalFileImport>, String> {
    let path = imported_knowledge_path(&app)?;
    let authorized = command_scope(workspace_id, project_id, ScopeAccess::Read)?;
    read_imported_knowledge_sources_private(&path, &authorized.private)
}

#[tauri::command]
pub fn import_local_knowledge_source(
    app: tauri::AppHandle,
    candidate: LocalTextFileCandidate,
    workspace_id: Option<String>,
    project_id: Option<String>,
) -> Result<LocalFileImport, String> {
    let authorized = command_scope(workspace_id, project_id, ScopeAccess::Write)?;
    let scope = &authorized.private;
    let imported = canonicalize_private_source(import_local_text_file(candidate)?, scope)?;
    let path = imported_knowledge_path(&app)?;
    if crate::store::try_global().is_some() {
        let mut sources: Vec<LocalFileImport> =
            crate::store::read_private_workspace_document(&path, scope)?.unwrap_or_default();
        sources = append_imported_knowledge_source(sources, imported.clone())?;
        crate::store::write_private_workspace_document(&path, scope, &sources)?;
        return Ok(imported);
    }
    persist_imported_knowledge_source(&path, imported)
}

#[tauri::command]
pub fn refresh_local_knowledge_source(
    app: tauri::AppHandle,
    request: RefreshLocalKnowledgeSourceRequest,
    workspace_id: Option<String>,
    project_id: Option<String>,
) -> Result<LocalKnowledgeRefreshResponse, String> {
    let authorized = command_scope(workspace_id, project_id, ScopeAccess::Write)?;
    let scope = authorized.private;
    let path = imported_knowledge_path(&app)?;
    let update_scope = scope.clone();
    crate::store::update_private_workspace_document(
        &path,
        &scope,
        move |current: Option<Vec<LocalFileImport>>| {
            let mut sources = current.unwrap_or_default();
            let index = sources
                .iter()
                .position(|source| source.id == request.source_id.trim())
                .ok_or_else(|| "That local knowledge source is no longer available.".to_string())?;
            let mut response =
                apply_local_knowledge_refresh(&sources[index], request, update_scope.data())?;
            response.source = canonicalize_private_source(response.source, &update_scope)?;
            if response.outcome == "unchanged" {
                return Ok((None, response));
            }
            sources[index] = response.source.clone();
            Ok((Some(sources), response))
        },
    )
}

#[tauri::command]
pub fn load_runtime_snapshot(
    app: tauri::AppHandle,
    workspace_id: Option<String>,
    project_id: Option<String>,
) -> Result<Option<RuntimeSnapshot>, String> {
    let path = runtime_snapshot_path(&app)?;
    let scope = data_scope(workspace_id, project_id)?;
    if let Some(snapshot) = crate::store::read_workspace_document(&path, &scope)? {
        return normalize_runtime_snapshot(snapshot).map(Some);
    }
    // A missing scoped snapshot is absence, not permission to read the legacy
    // default workspace. Compatibility import is explicitly performed only by
    // the validated default scope at migration time.
    Ok(None)
}

#[tauri::command]
pub fn save_runtime_snapshot(
    app: tauri::AppHandle,
    snapshot: RuntimeSnapshot,
    workspace_id: Option<String>,
    project_id: Option<String>,
) -> Result<RuntimeSnapshot, String> {
    let path = runtime_snapshot_path(&app)?;
    let scope = data_scope(workspace_id, project_id)?;
    let normalized = normalize_runtime_snapshot(snapshot)?;
    if crate::store::write_workspace_document(&path, &scope, &normalized)? {
        return Ok(normalized);
    }
    write_runtime_snapshot(&path, normalized)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn teammate_preferences_and_skills_survive_native_roundtrip() {
        let agent: FableAgentProfile = serde_json::from_value(serde_json::json!({
            "id": "ava", "name": "Ava", "instructions": "Keep things simple.",
            "modelId": "codex::model", "reasoningEffort": "high", "icon": "agent",
            "avatarSeed": "blob-v1:stable-ava",
            "permissionLabel": "Ask Me", "threadId": "new-chat", "threadIds": ["old-chat", "old-chat"],
            "learnedTasks": [{ "id": "weekly", "title": "Weekly plan", "instruction": "Ask about priorities.", "createdAt": "2026-09-04", "updatedAt": "2026-09-04" }]
        })).unwrap();
        let normalized = normalize_runtime_agents(vec![agent]).unwrap().remove(0);
        let encoded = serde_json::to_value(&normalized).unwrap();
        let restored: FableAgentProfile = serde_json::from_value(encoded).unwrap();
        assert_eq!(restored.reasoning_effort.as_deref(), Some("high"));
        assert_eq!(restored.avatar_seed.as_deref(), Some("blob-v1:stable-ava"));
        assert_eq!(restored.thread_ids, vec!["old-chat", "new-chat"]);
        assert_eq!(restored.learned_tasks.len(), 1);
        assert_eq!(
            restored.learned_tasks[0].instruction,
            "Ask about priorities."
        );
        assert_eq!(restored, normalized);
    }

    #[test]
    fn generated_portraits_and_teammates_do_not_stop_at_one_hundred() {
        let agents = (0..150)
            .map(|index| {
                serde_json::from_value(serde_json::json!({
                    "id": format!("agent-{index}"), "name": format!("Agent {index}"),
                    "instructions": "", "modelId": "", "icon": "agent", "permissionLabel": "Ask Me"
                }))
                .unwrap()
            })
            .collect();
        let normalized = normalize_runtime_agents(agents).unwrap();
        assert_eq!(normalized.len(), 150);
        let seeds: HashSet<_> = normalized
            .iter()
            .map(|agent| agent.avatar_seed.as_deref())
            .collect();
        assert_eq!(seeds.len(), 150);
        assert_eq!(
            normalized[149].avatar_seed.as_deref(),
            Some("blob-v1:agent-149")
        );
    }

    fn refresh_source(name: &str, content: &str) -> LocalFileImport {
        import_local_text_file(LocalTextFileCandidate {
            name: name.into(),
            content: content.into(),
            size_bytes: content.len(),
            imported_at: Some("before".into()),
        })
        .unwrap()
    }

    fn refresh_request(
        source: &LocalFileImport,
        content: &str,
    ) -> RefreshLocalKnowledgeSourceRequest {
        RefreshLocalKnowledgeSourceRequest {
            source_id: source.id.clone(),
            expected_content_fingerprint: source.content_fingerprint.clone(),
            file: crate::models::RefreshLocalKnowledgeSourceFile {
                name: source.title.clone(),
                content: content.into(),
                size_bytes: content.len(),
                selected_at: "now".into(),
                modified_at: Some("modified".into()),
            },
        }
    }

    #[test]
    fn local_refresh_updates_content_but_preserves_identity_and_controls() {
        let mut source = refresh_source("notes.md", "old notes");
        source.pinned = false;
        source.disabled = true;
        source.scope = Some(serde_json::json!({"level":"project","projectId":"p"}));
        let response = apply_local_knowledge_refresh(
            &source,
            refresh_request(&source, "new searchable notes"),
            &DataScope::new("w", Some("p".into())).unwrap(),
        )
        .unwrap();
        assert_eq!(response.outcome, "updated");
        assert_eq!(response.source.id, source.id);
        assert_eq!(response.source.scope, source.scope);
        assert!(!response.source.pinned);
        assert!(response.source.disabled);
        assert_eq!(response.source.content_preview, "new searchable notes");
        assert_ne!(
            response.source.content_fingerprint,
            source.content_fingerprint
        );
        assert_eq!(response.source.status.as_deref(), Some("ok"));
    }

    #[test]
    fn local_refresh_identical_and_stale_cas_do_not_replace_canonical_source() {
        let source = refresh_source("notes.md", "same");
        let response = apply_local_knowledge_refresh(
            &source,
            refresh_request(&source, "same"),
            &DataScope::legacy_default(),
        )
        .unwrap();
        assert_eq!(response.outcome, "unchanged");
        assert_eq!(response.source, source);
        let mut stale = refresh_request(&source, "different");
        stale.expected_content_fingerprint = "stale".into();
        assert!(
            apply_local_knowledge_refresh(&source, stale, &DataScope::legacy_default())
                .unwrap_err()
                .contains("changed elsewhere")
        );
    }

    #[test]
    fn local_refresh_rejects_invalid_file_tombstone_and_foreign_scope() {
        let source = refresh_source("data.json", "{}");
        let mut malformed = refresh_request(&source, "{");
        malformed.file.size_bytes = 1;
        assert!(
            apply_local_knowledge_refresh(&source, malformed, &DataScope::legacy_default())
                .unwrap_err()
                .contains("malformed")
        );
        let mut wrong_size = refresh_request(&source, "new");
        wrong_size.file.size_bytes = 99;
        assert!(
            apply_local_knowledge_refresh(&source, wrong_size, &DataScope::legacy_default())
                .unwrap_err()
                .contains("changed while")
        );
        let mut deleted = source.clone();
        deleted.deleted_at = Some("then".into());
        assert!(apply_local_knowledge_refresh(
            &deleted,
            refresh_request(&deleted, "new"),
            &DataScope::legacy_default()
        )
        .unwrap_err()
        .contains("Deleted"));
        let mut foreign = source.clone();
        foreign.scope = Some(serde_json::json!({"level":"project","projectId":"other"}));
        assert!(apply_local_knowledge_refresh(
            &foreign,
            refresh_request(&foreign, "new"),
            &DataScope::new("w", Some("p".into())).unwrap(),
        )
        .unwrap_err()
        .contains("does not belong"));
    }

    #[test]
    fn deleted_local_source_cannot_be_resurrected_by_reimport() {
        let candidate = LocalTextFileCandidate {
            name: "deleted.md".to_string(),
            content: "same content".to_string(),
            size_bytes: "same content".len(),
            imported_at: Some("2026-07-01T00:00:00Z".to_string()),
        };
        let incoming = import_local_text_file(candidate).unwrap();
        let mut tombstone = incoming.clone();
        tombstone.deleted_at = Some("2026-07-01T01:00:00Z".to_string());
        assert!(append_imported_knowledge_source(vec![tombstone], incoming).is_err());
    }

    #[test]
    fn save_merge_preserves_deleted_source_tombstones() {
        let deleted = import_local_text_file(LocalTextFileCandidate {
            name: "deleted.md".to_string(),
            content: "deleted content".to_string(),
            size_bytes: "deleted content".len(),
            imported_at: Some("2026-07-01T00:00:00Z".to_string()),
        })
        .unwrap();
        let active = import_local_text_file(LocalTextFileCandidate {
            name: "active.md".to_string(),
            content: "active content".to_string(),
            size_bytes: "active content".len(),
            imported_at: Some("2026-07-01T00:00:00Z".to_string()),
        })
        .unwrap();
        let mut tombstone = deleted.clone();
        tombstone.deleted_at = Some("2026-07-01T01:00:00Z".to_string());

        let merged =
            merge_deleted_imported_tombstones(vec![active], vec![tombstone.clone()]).unwrap();
        assert!(merged
            .iter()
            .any(|source| source.id == tombstone.id && source.deleted_at.is_some()));
        assert!(merge_deleted_imported_tombstones(vec![deleted], vec![tombstone]).is_err());
    }
}
