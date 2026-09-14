//! Small member-private project rooms shared by every local named agent.
//!
//! A project owns one ordinary durable conversation thread. It widens neither
//! human visibility nor provider/tool authority; run attribution is captured
//! before work begins and is immutable for that run.

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::authorized_scope::{self, AuthorizedCommandScope, ScopeAccess};
use crate::collaboration::models::{Author, ChatBinding, Conversation, Participant, Team, Work};
use crate::models::FableAgentProfile;
use crate::store::repos::collaboration::{self as collab, Kind};
use crate::store::repos::local_project::{self as repo, LocalProjectRow, LocalProjectRunAuthorRow};
use crate::store::repos::{execution_attempt, thread};
use crate::store::{Store, StoreError};

const MAX_PROJECTS: i64 = 128;
const MAX_ID_CHARACTERS: usize = 128;
const MAX_NAME_CHARACTERS: usize = 120;
const MAX_INSTRUCTIONS_CHARACTERS: usize = 12_000;
const MAX_KNOWLEDGE_SOURCES: usize = 64;
const MAX_SHARES: usize = 64;
const MAX_SHARE_TEXT_CHARACTERS: usize = 32_000;
const MAX_SHARE_TITLE_CHARACTERS: usize = 200;
const MAX_REVISION_CHARACTERS: usize = 200;
const PROJECT_LIST_LIMIT: usize = 128;
const AUTHOR_LIST_LIMIT: usize = 500;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct LocalProjectPayload {
    name: String,
    instructions: String,
    knowledge_source_ids: Vec<String>,
    #[serde(default)]
    shares: Vec<ProjectShare>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectShareSource {
    pub workspace_id: String,
    pub kind: String,
    pub id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectShareRecipient {
    pub kind: String,
    pub id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectShareOwner {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub name: String,
}

/// Explicit sharing never conveys tool authority. Snapshots retain the selected
/// bytes; live references resolve again under the current account on each use.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectShare {
    pub id: String,
    pub mode: String,
    pub source: ProjectShareSource,
    pub source_revision: String,
    pub recipient: ProjectShareRecipient,
    pub owner: ProjectShareOwner,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot_text: Option<String>,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RunAuthorPayload {
    agent_name: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalProject {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub instructions: String,
    pub knowledge_source_ids: Vec<String>,
    pub shares: Vec<ProjectShare>,
    pub thread_id: String,
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalProjectRunAuthor {
    pub project_id: String,
    pub run_id: String,
    pub agent_id: String,
    pub agent_name: String,
    pub thread_id: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateLocalProjectRequest {
    pub workspace_id: String,
    pub id: String,
    pub thread_id: String,
    pub name: String,
    #[serde(default)]
    pub instructions: String,
    #[serde(default)]
    pub knowledge_source_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateLocalProjectRequest {
    pub workspace_id: String,
    pub id: String,
    pub expected_revision: i64,
    pub name: String,
    #[serde(default)]
    pub instructions: String,
    #[serde(default)]
    pub knowledge_source_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveLocalProjectRequest {
    pub workspace_id: String,
    pub id: String,
    pub expected_revision: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListLocalProjectsRequest {
    pub workspace_id: String,
    #[serde(default)]
    pub include_archived: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindLocalProjectRunAuthorRequest {
    pub workspace_id: String,
    pub project_id: String,
    pub expected_revision: i64,
    pub run_id: String,
    pub agent_id: String,
    pub thread_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListLocalProjectRunAuthorsRequest {
    pub workspace_id: String,
    pub project_id: String,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetLocalProjectRunAuthorRequest {
    pub workspace_id: String,
    pub project_id: String,
    pub run_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddProjectShare {
    pub mode: String,
    pub source: ProjectShareSource,
    pub source_revision: String,
    pub recipient: ProjectShareRecipient,
    pub owner: ProjectShareOwner,
    pub title: String,
    #[serde(default)]
    pub snapshot_text: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddProjectShareRequest {
    pub workspace_id: String,
    pub project_id: String,
    pub expected_revision: i64,
    pub share: AddProjectShare,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveProjectShareRequest {
    pub workspace_id: String,
    pub project_id: String,
    pub expected_revision: i64,
    pub share_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrateLegacyGroupRequest {
    pub workspace_id: String,
    /// New Project id.
    pub id: String,
    /// The legacy standalone group conversation id, which is also its thread.
    pub conversation_id: String,
    pub expected_revision: u32,
    pub name: String,
    #[serde(default)]
    pub instructions: String,
    pub participant_ids: Vec<String>,
    #[serde(default)]
    pub lead_agent_id: Option<String>,
    /// Existing history is shared with the new Project; migration never deletes it.
    pub share_history: bool,
}

#[tauri::command]
pub fn local_project_create(
    window: tauri::WebviewWindow,
    request: CreateLocalProjectRequest,
) -> Result<LocalProject, String> {
    require_main_window(&window)?;
    let now = timestamp();
    let store = global_store()?;
    store
        .transaction(|tx| {
            let scope = authorized_scope::resolve(
                tx,
                Some(&request.workspace_id),
                None,
                ScopeAccess::Write,
            )?;
            create_at(tx, store, &scope, request, &now)
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn local_project_list(
    window: tauri::WebviewWindow,
    request: ListLocalProjectsRequest,
) -> Result<Vec<LocalProject>, String> {
    require_main_window(&window)?;
    let store = global_store()?;
    store
        .with_conn(|tx| {
            let scope = authorized_scope::resolve(
                tx,
                Some(&request.workspace_id),
                None,
                ScopeAccess::Read,
            )?;
            repo::list_projects(
                tx,
                store,
                &scope.private,
                request.include_archived,
                PROJECT_LIST_LIMIT,
            )?
            .into_iter()
            .map(|row| project_from_row(&scope, row))
            .collect()
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn local_project_update(
    window: tauri::WebviewWindow,
    request: UpdateLocalProjectRequest,
) -> Result<LocalProject, String> {
    require_main_window(&window)?;
    let now = timestamp();
    let store = global_store()?;
    store
        .transaction(|tx| {
            let scope = authorized_scope::resolve(
                tx,
                Some(&request.workspace_id),
                None,
                ScopeAccess::Write,
            )?;
            update_at(tx, store, &scope, request, &now)
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn local_project_archive(
    window: tauri::WebviewWindow,
    request: ArchiveLocalProjectRequest,
) -> Result<LocalProject, String> {
    require_main_window(&window)?;
    let now = timestamp();
    let store = global_store()?;
    store
        .transaction(|tx| {
            let scope = authorized_scope::resolve(
                tx,
                Some(&request.workspace_id),
                None,
                ScopeAccess::Write,
            )?;
            archive_at(tx, store, &scope, request, &now)
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn local_project_share_add(
    window: tauri::WebviewWindow,
    request: AddProjectShareRequest,
) -> Result<LocalProject, String> {
    require_main_window(&window)?;
    let now = timestamp();
    let store = global_store()?;
    store
        .transaction(|tx| {
            let scope = authorized_scope::resolve(
                tx,
                Some(&request.workspace_id),
                None,
                ScopeAccess::Write,
            )?;
            add_share_at(tx, store, &scope, request, &now)
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn local_project_share_remove(
    window: tauri::WebviewWindow,
    request: RemoveProjectShareRequest,
) -> Result<LocalProject, String> {
    require_main_window(&window)?;
    let now = timestamp();
    let store = global_store()?;
    store
        .transaction(|tx| {
            let scope = authorized_scope::resolve(
                tx,
                Some(&request.workspace_id),
                None,
                ScopeAccess::Write,
            )?;
            remove_share_at(tx, store, &scope, request, &now)
        })
        .map_err(|error| error.to_string())
}

/// Converts a legacy standalone group into a project that owns its existing
/// thread. History, run attribution and participant identity are retained.
#[tauri::command]
pub fn local_project_migrate_group(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: MigrateLegacyGroupRequest,
) -> Result<LocalProject, String> {
    require_main_window(&window)?;
    let snapshot =
        crate::snapshot::load_runtime_snapshot(app, Some(request.workspace_id.clone()), None)?
            .ok_or_else(|| "Mivlet's persisted agent profiles are not available.".to_string())?;
    let now = timestamp();
    let store = global_store()?;
    store
        .transaction(|tx| {
            let scope = authorized_scope::resolve(
                tx,
                Some(&request.workspace_id),
                None,
                ScopeAccess::Write,
            )?;
            migrate_group_at(tx, store, &scope, &snapshot.agents, request, &now)
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn local_project_run_author_bind(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: BindLocalProjectRunAuthorRequest,
) -> Result<LocalProjectRunAuthor, String> {
    require_main_window(&window)?;
    let snapshot =
        crate::snapshot::load_runtime_snapshot(app, Some(request.workspace_id.clone()), None)?
            .ok_or_else(|| "Mivlet's persisted agent profiles are not available.".to_string())?;
    let agent = snapshot
        .agents
        .iter()
        .find(|agent| agent.id == request.agent_id)
        .ok_or_else(|| "The selected agent is not in Mivlet's persisted profiles.".to_string())?;
    let agent_name = agent.name.clone();
    let now = timestamp();
    let store = global_store()?;
    store
        .transaction(|tx| {
            let scope = authorized_scope::resolve(
                tx,
                Some(&request.workspace_id),
                None,
                ScopeAccess::Write,
            )?;
            bind_author_at(tx, store, &scope, request, &agent_name, &now)
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn local_project_run_author_list(
    window: tauri::WebviewWindow,
    request: ListLocalProjectRunAuthorsRequest,
) -> Result<Vec<LocalProjectRunAuthor>, String> {
    require_main_window(&window)?;
    validate_id(&request.project_id, "Project")?;
    let limit = request.limit.unwrap_or(100).clamp(1, AUTHOR_LIST_LIMIT);
    let store = global_store()?;
    store
        .with_conn(|tx| {
            let scope = authorized_scope::resolve(
                tx,
                Some(&request.workspace_id),
                None,
                ScopeAccess::Read,
            )?;
            if repo::get_project(tx, store, &scope.private, &request.project_id)?.is_none() {
                return Err(StoreError::Invalid(
                    "The local project was not found.".into(),
                ));
            }
            repo::list_run_authors(tx, store, &scope.private, &request.project_id, limit)?
                .into_iter()
                .map(author_from_row)
                .collect()
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn local_project_run_author_get(
    window: tauri::WebviewWindow,
    request: GetLocalProjectRunAuthorRequest,
) -> Result<Option<LocalProjectRunAuthor>, String> {
    require_main_window(&window)?;
    validate_id(&request.project_id, "Project")?;
    validate_id(&request.run_id, "Run")?;
    let store = global_store()?;
    store
        .with_conn(|tx| {
            let scope = authorized_scope::resolve(
                tx,
                Some(&request.workspace_id),
                None,
                ScopeAccess::Read,
            )?;
            if repo::get_project(tx, store, &scope.private, &request.project_id)?.is_none() {
                return Err(StoreError::Invalid(
                    "The local project was not found.".into(),
                ));
            }
            repo::get_run_author(tx, store, &scope.private, &request.run_id)?
                .filter(|author| author.project_id == request.project_id)
                .map(author_from_row)
                .transpose()
        })
        .map_err(|error| error.to_string())
}

fn create_at(
    tx: &rusqlite::Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    request: CreateLocalProjectRequest,
    now: &str,
) -> crate::store::Result<LocalProject> {
    validate_id_store(&request.id, "Project")?;
    validate_id_store(&request.thread_id, "Project thread")?;
    let payload = validate_payload_store(
        tx,
        scope,
        request.name,
        request.instructions,
        request.knowledge_source_ids,
        Vec::new(),
    )?;
    let count: i64 = tx.query_row(
        "SELECT COUNT(*) FROM local_project WHERE workspace_id=?1 AND owner_subject=?2",
        rusqlite::params![scope.private.workspace_id(), scope.private.owner_subject()],
        |row| row.get(0),
    )?;
    if count >= MAX_PROJECTS {
        return Err(StoreError::Invalid(
            "This workspace has reached its local project limit.".into(),
        ));
    }
    thread::create(
        tx,
        store,
        &scope.data,
        &request.thread_id,
        None,
        &payload.name,
        now,
        &serde_json::json!({
            "authorityScope": {
                "authority": "local",
                "visibility": "member-private",
                "ownerMemberId": scope.private.owner_member_id()
            }
        }),
    )?;
    let claimed = tx.execute(
        "UPDATE thread SET owner_member_id=?1
          WHERE workspace_id=?2 AND id=?3 AND owner_member_id IS NULL",
        rusqlite::params![
            scope.private.owner_member_id(),
            scope.data.workspace_id(),
            request.thread_id
        ],
    )?;
    if claimed != 1 {
        return Err(StoreError::Invalid(
            "Project conversation ownership could not be established.".into(),
        ));
    }
    let row = LocalProjectRow {
        id: request.id,
        lifecycle: "active".into(),
        revision: 1,
        thread_id: request.thread_id,
        created_at: now.into(),
        updated_at: now.into(),
        archived_at: None,
        payload: serde_json::to_value(payload)
            .map_err(|_| StoreError::Invalid("The project could not be encoded.".into()))?,
    };
    repo::insert_project(tx, store, &scope.private, &row)?;
    project_from_row(scope, row)
}

fn update_at(
    tx: &rusqlite::Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    request: UpdateLocalProjectRequest,
    now: &str,
) -> crate::store::Result<LocalProject> {
    validate_id_store(&request.id, "Project")?;
    let mut row = repo::get_project(tx, store, &scope.private, &request.id)?
        .ok_or_else(|| StoreError::Invalid("The local project was not found.".into()))?;
    if row.revision != request.expected_revision {
        return Err(StoreError::Invalid(
            "The local project changed. Refresh it before editing.".into(),
        ));
    }
    if row.lifecycle != "active" {
        return Err(StoreError::Invalid(
            "An archived project cannot be edited.".into(),
        ));
    }
    if !thread_is_owned(tx, scope, &row.thread_id)? {
        return Err(StoreError::Invalid(
            "The project conversation is not owned by this private workspace.".into(),
        ));
    }
    let payload: LocalProjectPayload = serde_json::from_value(row.payload.clone())
        .map_err(|_| StoreError::Invalid("The local project payload is invalid.".into()))?;
    let payload = validate_payload_store(
        tx,
        scope,
        request.name,
        request.instructions,
        request.knowledge_source_ids,
        payload.shares,
    )?;
    thread::update(
        tx,
        store,
        &scope.data,
        &row.thread_id,
        Some(&payload.name),
        None,
        None,
        now,
    )?;
    row.revision = next_revision(row.revision)?;
    row.updated_at = now.into();
    row.payload = serde_json::to_value(payload)
        .map_err(|_| StoreError::Invalid("The project could not be encoded.".into()))?;
    repo::replace_project(tx, store, &scope.private, request.expected_revision, &row)?;
    crate::collaboration::project_changed(tx, store, scope, &row.id, now, false)?;
    project_from_row(scope, row)
}

fn archive_at(
    tx: &rusqlite::Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    request: ArchiveLocalProjectRequest,
    now: &str,
) -> crate::store::Result<LocalProject> {
    validate_id_store(&request.id, "Project")?;
    let mut row = repo::get_project(tx, store, &scope.private, &request.id)?
        .ok_or_else(|| StoreError::Invalid("The local project was not found.".into()))?;
    if row.revision != request.expected_revision {
        return Err(StoreError::Invalid(
            "The local project changed. Refresh it before archiving.".into(),
        ));
    }
    if row.lifecycle == "archived" {
        return project_from_row(scope, row);
    }
    if !thread_is_owned(tx, scope, &row.thread_id)? {
        return Err(StoreError::Invalid(
            "The project conversation is not owned by this private workspace.".into(),
        ));
    }
    thread::update(
        tx,
        store,
        &scope.data,
        &row.thread_id,
        None,
        Some("archived"),
        None,
        now,
    )?;
    row.lifecycle = "archived".into();
    row.revision = next_revision(row.revision)?;
    row.updated_at = now.into();
    row.archived_at = Some(now.into());
    repo::replace_project(tx, store, &scope.private, request.expected_revision, &row)?;
    crate::collaboration::project_changed(tx, store, scope, &row.id, now, true)?;
    project_from_row(scope, row)
}

fn bind_author_at(
    tx: &rusqlite::Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    request: BindLocalProjectRunAuthorRequest,
    agent_name: &str,
    now: &str,
) -> crate::store::Result<LocalProjectRunAuthor> {
    validate_id_store(&request.project_id, "Project")?;
    validate_id_store(&request.run_id, "Run")?;
    validate_id_store(&request.agent_id, "Agent")?;
    validate_id_store(&request.thread_id, "Project thread")?;
    if agent_name.trim().is_empty() || agent_name.chars().count() > MAX_NAME_CHARACTERS {
        return Err(StoreError::Invalid(
            "The persisted agent name is invalid.".into(),
        ));
    }
    let project = repo::get_project(tx, store, &scope.private, &request.project_id)?
        .ok_or_else(|| StoreError::Invalid("The local project was not found.".into()))?;
    if project.revision != request.expected_revision || project.lifecycle != "active" {
        return Err(StoreError::Invalid(
            "The local project changed or was archived before work could start.".into(),
        ));
    }
    if project.thread_id != request.thread_id {
        return Err(StoreError::Invalid(
            "The run does not belong to this project's conversation.".into(),
        ));
    }
    let project_payload: LocalProjectPayload = serde_json::from_value(project.payload.clone())
        .map_err(|_| StoreError::Invalid("The local project payload is invalid.".into()))?;
    // Sources can be removed or disabled after the project was edited. Recheck
    // them at the pre-run bind so stale references cannot silently enter work.
    validate_payload_store(
        tx,
        scope,
        project_payload.name,
        project_payload.instructions,
        project_payload.knowledge_source_ids,
        project_payload.shares,
    )?;
    let payload = serde_json::to_value(RunAuthorPayload {
        agent_name: agent_name.trim().into(),
    })
    .map_err(|_| StoreError::Invalid("The project run author could not be encoded.".into()))?;
    let proposed = LocalProjectRunAuthorRow {
        project_id: request.project_id,
        run_id: request.run_id,
        agent_id: request.agent_id,
        thread_id: request.thread_id,
        created_at: now.into(),
        payload,
    };
    if let Some(existing) = repo::get_run_author(tx, store, &scope.private, &proposed.run_id)? {
        if existing.project_id == proposed.project_id
            && existing.agent_id == proposed.agent_id
            && existing.thread_id == proposed.thread_id
            && existing.payload == proposed.payload
        {
            return author_from_row(existing);
        }
        return Err(StoreError::Invalid(
            "This run already has a different immutable project author.".into(),
        ));
    }
    let attempt = execution_attempt::get_scoped(tx, store, &scope.data, &proposed.run_id)?
        .ok_or_else(|| StoreError::Invalid("The queued project run was not found.".into()))?;
    if attempt.status != "queued" || attempt.thread_id.as_deref() != Some(&proposed.thread_id) {
        return Err(StoreError::Invalid(
            "Project authorship requires the exact queued run in this conversation.".into(),
        ));
    }
    if !thread_is_owned(tx, scope, &proposed.thread_id)? {
        return Err(StoreError::Invalid(
            "The project conversation is not owned by this private workspace.".into(),
        ));
    }
    repo::insert_run_author(tx, store, &scope.private, &proposed)?;
    author_from_row(proposed)
}

fn add_share_at(
    tx: &rusqlite::Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    request: AddProjectShareRequest,
    now: &str,
) -> crate::store::Result<LocalProject> {
    validate_id_store(&request.project_id, "Project")?;
    let mut row = repo::get_project(tx, store, &scope.private, &request.project_id)?
        .ok_or_else(|| StoreError::Invalid("The local project was not found.".into()))?;
    if row.revision != request.expected_revision {
        return Err(StoreError::Invalid(
            "The local project changed. Refresh it before sharing.".into(),
        ));
    }
    if row.lifecycle != "active" {
        return Err(StoreError::Invalid(
            "An archived project cannot receive shares.".into(),
        ));
    }
    let mut payload: LocalProjectPayload = serde_json::from_value(row.payload.clone())
        .map_err(|_| StoreError::Invalid("The local project payload is invalid.".into()))?;
    let share = validate_share(tx, store, scope, &request.project_id, request.share, now)?;
    if let Some(existing) = payload.shares.iter().find(|item| item.id == share.id) {
        let same = existing.mode == share.mode
            && existing.source == share.source
            && existing.source_revision == share.source_revision
            && existing.recipient == share.recipient
            && existing.owner == share.owner
            && existing.title == share.title
            && existing.snapshot_text == share.snapshot_text;
        return if same {
            project_from_row(scope, row)
        } else {
            Err(StoreError::Invalid(
                "This share already exists with different content.".into(),
            ))
        };
    }
    if payload.shares.len() >= MAX_SHARES {
        return Err(StoreError::Invalid(
            "A project can hold at most 64 explicit shares.".into(),
        ));
    }
    payload.shares.push(share);
    row.revision = next_revision(row.revision)?;
    row.updated_at = now.into();
    row.payload = serde_json::to_value(payload)
        .map_err(|_| StoreError::Invalid("The project could not be encoded.".into()))?;
    repo::replace_project(tx, store, &scope.private, request.expected_revision, &row)?;
    project_from_row(scope, row)
}

#[allow(clippy::too_many_arguments)]
fn validate_share(
    tx: &rusqlite::Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    project_id: &str,
    share: AddProjectShare,
    now: &str,
) -> crate::store::Result<ProjectShare> {
    if !["snapshot", "live-reference"].contains(&share.mode.as_str()) {
        return Err(StoreError::Invalid(
            "Choose a snapshot or a live reference share.".into(),
        ));
    }
    if share.source.workspace_id != scope.data.workspace_id() {
        return Err(StoreError::Invalid(
            "A share source belongs to another workspace.".into(),
        ));
    }
    if ![
        "file",
        "work",
        "artifact",
        "conversation",
        "message",
        "memory",
    ]
    .contains(&share.source.kind.as_str())
    {
        return Err(StoreError::Invalid("Unsupported share source.".into()));
    }
    validate_id_store(&share.source.id, "Share source")?;
    let source_revision = share.source_revision.trim();
    if source_revision.is_empty() || source_revision.chars().count() > MAX_REVISION_CHARACTERS {
        return Err(StoreError::Invalid(
            "A share needs a source revision of 1-200 characters.".into(),
        ));
    }
    match share.recipient.kind.as_str() {
        "project" if share.recipient.id == project_id => {}
        "agent" => {
            validate_id_store(&share.recipient.id, "Share recipient")?;
            require_team_participant(tx, store, scope, project_id, &share.recipient.id)?;
        }
        _ => {
            return Err(StoreError::Invalid(
                "Choose this project or a current participant as the share recipient.".into(),
            ))
        }
    }
    if !["user", "agent"].contains(&share.owner.kind.as_str()) {
        return Err(StoreError::Invalid(
            "A share owner is the user or a participant agent.".into(),
        ));
    }
    let owner_name = share.owner.name.trim();
    if owner_name.is_empty() || owner_name.chars().count() > MAX_NAME_CHARACTERS {
        return Err(StoreError::Invalid(
            "The share owner needs a 1-120 character name.".into(),
        ));
    }
    if share.owner.kind == "agent" {
        let owner_id = share.owner.id.as_deref().ok_or_else(|| {
            StoreError::Invalid("An agent share owner needs its durable agent id.".into())
        })?;
        validate_id_store(owner_id, "Share owner agent")?;
        require_team_participant(tx, store, scope, project_id, owner_id)?;
    }
    let title = share.title.trim();
    if title.is_empty() || title.chars().count() > MAX_SHARE_TITLE_CHARACTERS {
        return Err(StoreError::Invalid(
            "A share needs a 1-200 character title.".into(),
        ));
    }
    let snapshot_text = match share.mode.as_str() {
        "snapshot" => {
            let text = share.snapshot_text.as_deref().map(str::trim).unwrap_or("");
            if text.is_empty() || text.chars().count() > MAX_SHARE_TEXT_CHARACTERS {
                return Err(StoreError::Invalid(
                    "A snapshot share needs 1-32000 characters of selected text.".into(),
                ));
            }
            Some(text.to_string())
        }
        _ => {
            if share
                .snapshot_text
                .as_deref()
                .is_some_and(|text| !text.trim().is_empty())
            {
                return Err(StoreError::Invalid(
                    "A live reference copies no source bytes; it resolves under the current account on each deliberate use.".into(),
                ));
            }
            None
        }
    };
    match share.source.kind.as_str() {
        "file" => require_owned_file(tx, scope, project_id, &share.source.id)?,
        "work" => {
            if collab::get::<Work>(tx, store, &scope.private, Kind::Work, &share.source.id)?
                .is_none()
            {
                return Err(StoreError::Invalid(
                    "The shared Work result is unavailable.".into(),
                ));
            }
        }
        "conversation" => {
            if !thread_is_owned(tx, scope, &share.source.id)? {
                return Err(StoreError::Invalid(
                    "The shared conversation is not owned by this private workspace.".into(),
                ));
            }
        }
        "message" => {
            let owned: bool = tx.query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM message m JOIN thread t ON t.id=m.thread_id
                     WHERE m.id=?1 AND m.workspace_id=?2 AND m.deleted_at IS NULL
                       AND t.owner_member_id IS ?3
                )",
                rusqlite::params![
                    share.source.id,
                    scope.private.workspace_id(),
                    scope.private.owner_member_id()
                ],
                |row| row.get(0),
            )?;
            if !owned {
                return Err(StoreError::Invalid(
                    "The shared message is not owned by this private workspace.".into(),
                ));
            }
        }
        _ => {}
    }
    let id = format!(
        "share-{:x}",
        Sha256::digest(
            format!(
                "{project_id}:{}:{}:{}:{}:{}",
                share.mode,
                share.source.kind,
                share.source.id,
                share.recipient.kind,
                share.recipient.id
            )
            .as_bytes()
        )
    );
    Ok(ProjectShare {
        id,
        mode: share.mode,
        source: share.source,
        source_revision: source_revision.into(),
        recipient: share.recipient,
        owner: ProjectShareOwner {
            kind: share.owner.kind,
            id: share.owner.id,
            name: owner_name.into(),
        },
        title: title.into(),
        snapshot_text,
        created_at: now.into(),
    })
}

fn require_team_participant(
    tx: &rusqlite::Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    project_id: &str,
    agent_id: &str,
) -> crate::store::Result<()> {
    let team = collab::get::<Team>(tx, store, &scope.private, Kind::Team, project_id)?;
    if team.is_some_and(|team| team.participant_ids.iter().any(|id| id == agent_id)) {
        return Ok(());
    }
    Err(StoreError::Invalid(
        "Choose a current project participant for this share.".into(),
    ))
}

fn require_owned_file(
    tx: &rusqlite::Connection,
    scope: &AuthorizedCommandScope,
    project_id: &str,
    source_id: &str,
) -> crate::store::Result<()> {
    let owned: bool = tx.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM knowledge_source
             WHERE workspace_id=?1 AND owner_subject=?2 AND id=?3
               AND disabled=0 AND (project_id IS NULL OR project_id=?4)
        )",
        rusqlite::params![
            scope.private.workspace_id(),
            scope.private.owner_subject(),
            source_id,
            project_id
        ],
        |row| row.get(0),
    )?;
    if owned {
        Ok(())
    } else {
        Err(StoreError::Invalid(
            "The shared file is unavailable or belongs to another owner.".into(),
        ))
    }
}

/// Resolve explicit shares at Work admission under the same transaction and
/// current membership. The returned bytes are evidence, never tool authority.
pub(crate) fn capture_shares(
    tx: &rusqlite::Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    project: &LocalProjectRow,
    agent_id: &str,
) -> crate::store::Result<Vec<serde_json::Value>> {
    use crate::store::repos::message;
    use serde_json::json;
    if project.lifecycle != "active"
        || require_team_participant(tx, store, scope, &project.id, agent_id).is_err()
    {
        return Ok(vec![]);
    }
    let payload: LocalProjectPayload = serde_json::from_value(project.payload.clone())
        .map_err(|_| StoreError::Invalid("Invalid Project context.".into()))?;
    let mut remaining = 32_000usize;
    let mut result = Vec::new();
    for share in payload.shares.iter().filter(|share| {
        share.source.workspace_id == scope.data.workspace_id()
            && ((share.recipient.kind == "project" && share.recipient.id == project.id)
                || (share.recipient.kind == "agent" && share.recipient.id == agent_id))
    }) {
        if remaining == 0 || result.len() == 12 {
            break;
        }
        let resolved = if share.mode == "snapshot" {
            share
                .snapshot_text
                .clone()
                .map(|text| (text, share.source_revision.clone()))
        } else {
            match share.source.kind.as_str() {
                "work" => {
                    collab::get::<Work>(tx, store, &scope.private, Kind::Work, &share.source.id)?
                        .and_then(|work| {
                            work.outputs
                                .last()
                                .map(|output| (output.text.clone(), output.run_id.clone()))
                        })
                }
                "conversation" if thread_is_owned(tx, scope, &share.source.id)? => {
                    let rows = message::list(tx, store, &scope.data, &share.source.id)?;
                    let revision = rows
                        .last()
                        .map(|row| row.sequence.to_string())
                        .unwrap_or_default();
                    let mut texts: Vec<_> = rows
                        .iter()
                        .rev()
                        .filter(|row| {
                            row.current_revision_state == "terminal"
                                && matches!(row.kind.as_str(), "user" | "assistant")
                        })
                        .take(24)
                        .map(|row| {
                            format!(
                                "{}: {}",
                                row.kind,
                                row.content["text"]
                                    .as_str()
                                    .unwrap_or("")
                                    .chars()
                                    .take(1_000)
                                    .collect::<String>()
                            )
                        })
                        .collect();
                    texts.reverse();
                    Some((texts.join("\n"), revision))
                }
                "file" if require_owned_file(tx, scope, &project.id, &share.source.id).is_ok() => {
                    crate::store::repos::knowledge_source::get_shared_source(
                        tx,
                        store,
                        &scope.private,
                        &project.id,
                        &share.source.id,
                    )?
                    .map(|source| {
                        (
                            source.payload["contentPreview"]
                                .as_str()
                                .unwrap_or("")
                                .to_string(),
                            source.content_fingerprint,
                        )
                    })
                }
                _ => None,
            }
        };
        let (text, revision, available) = match resolved {
            Some((text, revision)) if !text.is_empty() => (text, revision, true),
            _ => (
                "This shared source is unavailable.".into(),
                share.source_revision.clone(),
                false,
            ),
        };
        let truncated = text.chars().count() > remaining.min(8_000);
        let text: String = text.chars().take(remaining.min(8_000)).collect();
        remaining -= text.chars().count();
        result.push(json!({"id":share.id,"mode":share.mode,"source":share.source,"sourceRevision":revision,"recipient":share.recipient,"available":available,"truncated":truncated,"text":text,"instructionAuthority":"none"}));
    }
    Ok(result)
}

fn remove_share_at(
    tx: &rusqlite::Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    request: RemoveProjectShareRequest,
    now: &str,
) -> crate::store::Result<LocalProject> {
    validate_id_store(&request.project_id, "Project")?;
    validate_id_store(&request.share_id, "Share")?;
    let mut row = repo::get_project(tx, store, &scope.private, &request.project_id)?
        .ok_or_else(|| StoreError::Invalid("The local project was not found.".into()))?;
    if row.revision != request.expected_revision {
        return Err(StoreError::Invalid(
            "The local project changed. Refresh it before removing a share.".into(),
        ));
    }
    if row.lifecycle != "active" {
        return Err(StoreError::Invalid(
            "An archived project cannot change shares.".into(),
        ));
    }
    let mut payload: LocalProjectPayload = serde_json::from_value(row.payload.clone())
        .map_err(|_| StoreError::Invalid("The local project payload is invalid.".into()))?;
    let before = payload.shares.len();
    payload.shares.retain(|item| item.id != request.share_id);
    if payload.shares.len() == before {
        return project_from_row(scope, row);
    }
    row.revision = next_revision(row.revision)?;
    row.updated_at = now.into();
    row.payload = serde_json::to_value(payload)
        .map_err(|_| StoreError::Invalid("The project could not be encoded.".into()))?;
    repo::replace_project(tx, store, &scope.private, request.expected_revision, &row)?;
    project_from_row(scope, row)
}

fn migrate_group_at(
    tx: &rusqlite::Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    profiles: &[FableAgentProfile],
    request: MigrateLegacyGroupRequest,
    now: &str,
) -> crate::store::Result<LocalProject> {
    if !request.share_history {
        return Err(StoreError::Invalid(
            "Confirm sharing the existing history before converting this group.".into(),
        ));
    }
    validate_id_store(&request.id, "Project")?;
    validate_id_store(&request.conversation_id, "Conversation")?;
    let mut room: Conversation = collab::get(
        tx,
        store,
        &scope.private,
        Kind::Conversation,
        &request.conversation_id,
    )?
    .ok_or_else(|| StoreError::Invalid("This legacy group conversation is unavailable.".into()))?;
    if room.kind != "group" || room.project_id.is_some() {
        return Err(StoreError::Invalid(
            "Only a standalone group can be converted to a project.".into(),
        ));
    }
    if room.revision != request.expected_revision {
        return Err(StoreError::Invalid(
            "This conversation changed. Reload it before converting.".into(),
        ));
    }
    if !thread_is_owned(tx, scope, &request.conversation_id)? {
        return Err(StoreError::Invalid(
            "The legacy group is not owned by this private workspace.".into(),
        ));
    }
    let already: bool = tx.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM local_project
             WHERE workspace_id=?1 AND owner_subject=?2 AND (id=?3 OR thread_id=?4)
        )",
        rusqlite::params![
            scope.private.workspace_id(),
            scope.private.owner_subject(),
            request.id,
            request.conversation_id
        ],
        |row| row.get(0),
    )?;
    if already {
        return Err(StoreError::Invalid(
            "This group or project was already converted. Reload the workspace.".into(),
        ));
    }
    let members = validated_participants(
        profiles,
        &request.participant_ids,
        request.lead_agent_id.as_deref(),
    )?;
    let payload = validate_payload_store(
        tx,
        scope,
        request.name,
        request.instructions,
        Vec::new(),
        Vec::new(),
    )?;
    let row = LocalProjectRow {
        id: request.id.clone(),
        lifecycle: "active".into(),
        revision: 1,
        thread_id: request.conversation_id.clone(),
        created_at: now.into(),
        updated_at: now.into(),
        archived_at: None,
        payload: serde_json::to_value(&payload)
            .map_err(|_| StoreError::Invalid("The project could not be encoded.".into()))?,
    };
    repo::insert_project(tx, store, &scope.private, &row)?;
    let team = Team {
        project_id: request.id.clone(),
        lead_agent_id: request.lead_agent_id.clone(),
        participant_ids: request.participant_ids.clone(),
        revision: 1,
    };
    collab::put(
        tx,
        store,
        &scope.private,
        Kind::Team,
        &team.project_id,
        None,
        Some(&team.project_id),
        &team,
    )?;
    room.title = payload.name.clone();
    room.project_id = Some(request.id.clone());
    room.chat = Some(ChatBinding {
        role: "main".into(),
        owner_kind: "project".into(),
        owner_id: request.id.clone(),
    });
    room.kind = "group".into();
    room.participants = members;
    room.facilitator_id = request.lead_agent_id.clone();
    room.revision = room
        .revision
        .checked_add(1)
        .ok_or_else(|| StoreError::Invalid("The conversation revision overflowed.".into()))?;
    room.generation = room.generation.saturating_add(1);
    room.updated_at = now.into();
    collab::put(
        tx,
        store,
        &scope.private,
        Kind::Conversation,
        &room.id,
        Some(&room.id),
        Some(&request.id),
        &room,
    )?;
    thread::update(
        tx,
        store,
        &scope.data,
        &room.id,
        Some(&payload.name),
        None,
        None,
        now,
    )?;
    backfill_thread_authors(tx, store, scope, &request.id, &room.id, profiles)?;
    project_from_row(scope, row)
}

fn validated_participants(
    profiles: &[FableAgentProfile],
    ids: &[String],
    lead: Option<&str>,
) -> crate::store::Result<Vec<Participant>> {
    if ids.is_empty() || ids.len() > 8 || lead.is_some_and(|lead| !ids.iter().any(|id| id == lead))
    {
        return Err(StoreError::Invalid(
            "Choose one to eight participants. A coordinator, when designated, must be one of them."
                .into(),
        ));
    }
    let mut seen = std::collections::HashSet::new();
    ids.iter()
        .map(|agent_id| {
            if !seen.insert(agent_id) {
                return Err(StoreError::Invalid(
                    "Each participant can be included only once.".into(),
                ));
            }
            let profile = profiles
                .iter()
                .find(|profile| &profile.id == agent_id)
                .ok_or_else(|| {
                    StoreError::Invalid("Choose a current persisted agent as a participant.".into())
                })?;
            Ok(Participant {
                agent_id: profile.id.clone(),
                name: profile.name.clone(),
            })
        })
        .collect()
}

/// Attribution backfill uses recorded evidence only: an existing project author
/// ledger, a unique model-route match or a sole participant. Otherwise the run
/// stays explicitly unattributed rather than invented.
pub(crate) fn backfill_thread_authors(
    tx: &rusqlite::Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    project_id: &str,
    room_id: &str,
    profiles: &[FableAgentProfile],
) -> crate::store::Result<usize> {
    let runs: Vec<(String, String, String)> = {
        let mut statement = tx.prepare(
            "SELECT id,provider_id,model FROM run
              WHERE workspace_id=?1 AND thread_id=?2 ORDER BY created_at,id",
        )?;
        let rows = statement
            .query_map(
                rusqlite::params![scope.data.workspace_id(), room_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    };
    let mut created = 0;
    for (run_id, provider_id, model) in runs {
        if collab::get::<Author>(tx, store, &scope.private, Kind::Author, &run_id)?.is_some() {
            continue;
        }
        let attributed = repo::get_run_author(tx, store, &scope.private, &run_id)?
            .and_then(|row| {
                let name = row
                    .payload
                    .get("agentName")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                profiles
                    .iter()
                    .find(|profile| profile.id == row.agent_id)
                    .map(|profile| (profile.id.clone(), profile.name.clone()))
                    .or_else(|| {
                        Some((
                            row.agent_id,
                            if name.is_empty() {
                                "Historical teammate".into()
                            } else {
                                name.to_string()
                            },
                        ))
                    })
            })
            .or_else(|| {
                let route = format!("{provider_id}::{model}");
                let matches: Vec<_> = profiles
                    .iter()
                    .filter(|profile| profile.model_id == route || profile.model_id == model)
                    .collect();
                (matches.len() == 1).then(|| (matches[0].id.clone(), matches[0].name.clone()))
            })
            .or_else(|| {
                (profiles.len() == 1).then(|| (profiles[0].id.clone(), profiles[0].name.clone()))
            });
        let author = match attributed {
            Some((agent_id, name)) => Author {
                run_id: run_id.clone(),
                conversation_id: room_id.into(),
                agent_id,
                name,
                work_id: None,
                generation: 0,
            },
            None => Author {
                run_id: run_id.clone(),
                conversation_id: room_id.into(),
                agent_id: "historical".into(),
                name: "Historical teammate (attribution unavailable)".into(),
                work_id: None,
                generation: 0,
            },
        };
        collab::put(
            tx,
            store,
            &scope.private,
            Kind::Author,
            &run_id,
            Some(room_id),
            Some(project_id),
            &author,
        )?;
        created += 1;
    }
    Ok(created)
}

fn validate_payload_store(
    tx: &rusqlite::Connection,
    scope: &AuthorizedCommandScope,
    name: String,
    instructions: String,
    knowledge_source_ids: Vec<String>,
    shares: Vec<ProjectShare>,
) -> crate::store::Result<LocalProjectPayload> {
    let name = name.trim().to_string();
    let instructions = instructions.trim().to_string();
    if name.is_empty() || name.chars().count() > MAX_NAME_CHARACTERS {
        return Err(StoreError::Invalid(
            "Project name must be 1-120 characters.".into(),
        ));
    }
    if instructions.chars().count() > MAX_INSTRUCTIONS_CHARACTERS {
        return Err(StoreError::Invalid(
            "Project instructions must be at most 12000 characters.".into(),
        ));
    }
    if knowledge_source_ids.len() > MAX_KNOWLEDGE_SOURCES {
        return Err(StoreError::Invalid(
            "A project can reference at most 64 knowledge sources.".into(),
        ));
    }
    let mut source_ids = Vec::with_capacity(knowledge_source_ids.len());
    for id in knowledge_source_ids {
        validate_id_store(&id, "Knowledge source")?;
        if source_ids.contains(&id) {
            continue;
        }
        let owned: bool = tx.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM knowledge_source
                 WHERE workspace_id=?1 AND owner_subject=?2 AND id=?3
                   AND project_id IS NULL AND authority='local'
                   AND visibility='member-private' AND disabled=0
            )",
            rusqlite::params![
                scope.private.workspace_id(),
                scope.private.owner_subject(),
                id
            ],
            |row| row.get(0),
        )?;
        if !owned {
            return Err(StoreError::Invalid(
                "A referenced knowledge source is unavailable or belongs to another owner.".into(),
            ));
        }
        source_ids.push(id);
    }
    Ok(LocalProjectPayload {
        name,
        instructions,
        knowledge_source_ids: source_ids,
        shares,
    })
}

fn project_from_row(
    scope: &AuthorizedCommandScope,
    row: LocalProjectRow,
) -> crate::store::Result<LocalProject> {
    let payload: LocalProjectPayload = serde_json::from_value(row.payload)
        .map_err(|_| StoreError::Invalid("The local project payload is invalid.".into()))?;
    Ok(LocalProject {
        id: row.id,
        workspace_id: scope.data.workspace_id().into(),
        name: payload.name,
        instructions: payload.instructions,
        knowledge_source_ids: payload.knowledge_source_ids,
        shares: payload.shares,
        thread_id: row.thread_id,
        revision: row.revision,
        created_at: row.created_at,
        updated_at: row.updated_at,
        archived_at: row.archived_at,
    })
}

fn author_from_row(row: LocalProjectRunAuthorRow) -> crate::store::Result<LocalProjectRunAuthor> {
    let payload: RunAuthorPayload = serde_json::from_value(row.payload)
        .map_err(|_| StoreError::Invalid("The project run author payload is invalid.".into()))?;
    Ok(LocalProjectRunAuthor {
        project_id: row.project_id,
        run_id: row.run_id,
        agent_id: row.agent_id,
        agent_name: payload.agent_name,
        thread_id: row.thread_id,
        created_at: row.created_at,
    })
}

fn thread_is_owned(
    tx: &rusqlite::Connection,
    scope: &AuthorizedCommandScope,
    thread_id: &str,
) -> crate::store::Result<bool> {
    tx.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM thread
             WHERE workspace_id=?1 AND id=?2 AND deleted_at IS NULL
               AND authority='local' AND visibility='member-private'
               AND owner_member_id IS ?3
        )",
        rusqlite::params![
            scope.private.workspace_id(),
            thread_id,
            scope.private.owner_member_id()
        ],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

fn next_revision(revision: i64) -> crate::store::Result<i64> {
    revision
        .checked_add(1)
        .ok_or_else(|| StoreError::Invalid("The project revision overflowed.".into()))
}

fn validate_id(value: &str, label: &str) -> Result<(), String> {
    validate_id_store(value, label).map_err(|error| error.to_string())
}

fn validate_id_store(value: &str, label: &str) -> crate::store::Result<()> {
    let valid = !value.is_empty()
        && value.len() <= MAX_ID_CHARACTERS
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '-'));
    if valid {
        Ok(())
    } else {
        Err(StoreError::Invalid(format!(
            "{label} id must be 1-{MAX_ID_CHARACTERS} URL-safe characters."
        )))
    }
}

fn require_main_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Manage local projects from the Mivlet window.".into())
    }
}

fn global_store() -> Result<&'static Store, String> {
    crate::store::try_global()
        .ok_or_else(|| "Mivlet's encrypted store is not initialized.".to_string())
}

fn timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::repos::knowledge_source;
    use crate::store::repos::scope::{DataScope, PrivateDataScope};
    use crate::store::vault::{MasterKey, Vault};

    fn store_and_scope() -> (Store, AuthorizedCommandScope) {
        let store =
            Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap();
        let data = DataScope::workspace("workspace-1").unwrap();
        store
            .with_conn(|tx| {
                tx.execute(
                    "INSERT INTO workspace(id,name,created_at,updated_at)
                     VALUES('workspace-1','Workspace','now','now')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        let private =
            PrivateDataScope::for_authenticated_user(data.clone(), "user-1", Some("member-1"))
                .unwrap();
        (
            store,
            AuthorizedCommandScope {
                data,
                private,
                internal_user_id: "user-1".into(),
                member_id: Some("member-1".into()),
            },
        )
    }

    fn source(store: &Store, scope: &AuthorizedCommandScope, id: &str) {
        store
            .transaction(|tx| {
                knowledge_source::upsert_private(
                    tx,
                    store,
                    &scope.private,
                    serde_json::json!({
                        "id": id,
                        "title": "Source",
                        "kind": "document",
                        "trust": "untrusted",
                        "contentFingerprint": "fingerprint",
                        "sizeBytes": 10,
                        "origin": "local-import"
                    }),
                    "now",
                )
            })
            .unwrap();
    }

    fn create_request() -> CreateLocalProjectRequest {
        CreateLocalProjectRequest {
            workspace_id: "workspace-1".into(),
            id: "project-1".into(),
            thread_id: "project-thread-1".into(),
            name: "Launch room".into(),
            instructions: "Keep claims sourced.".into(),
            knowledge_source_ids: vec!["source-1".into()],
        }
    }

    #[test]
    fn creates_encrypted_private_project_with_an_owned_source_and_thread() {
        let (store, scope) = store_and_scope();
        source(&store, &scope, "source-1");
        let project = store
            .transaction(|tx| {
                create_at(tx, &store, &scope, create_request(), "2026-09-07T12:00:00Z")
            })
            .unwrap();
        assert_eq!(project.name, "Launch room");
        assert_eq!(project.knowledge_source_ids, vec!["source-1"]);
        store
            .with_conn(|tx| {
                let (owner, payload): (String, Vec<u8>) = tx.query_row(
                    "SELECT owner_subject,payload FROM local_project WHERE id='project-1'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                assert_eq!(owner, "member:member-1");
                assert!(!String::from_utf8_lossy(&payload).contains("Keep claims sourced"));
                assert!(thread_is_owned(tx, &scope, "project-thread-1")?);
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn rejects_foreign_or_stale_sources_and_exact_revision_conflicts() {
        let (store, scope) = store_and_scope();
        source(&store, &scope, "source-1");
        store
            .transaction(|tx| {
                create_at(tx, &store, &scope, create_request(), "2026-09-07T12:00:00Z")
            })
            .unwrap();
        let updated = store
            .transaction(|tx| {
                update_at(
                    tx,
                    &store,
                    &scope,
                    UpdateLocalProjectRequest {
                        workspace_id: "workspace-1".into(),
                        id: "project-1".into(),
                        expected_revision: 1,
                        name: "Launch room revised".into(),
                        instructions: "Use primary sources.".into(),
                        knowledge_source_ids: vec!["source-1".into()],
                    },
                    "2026-09-07T12:01:00Z",
                )
            })
            .unwrap();
        assert_eq!(updated.revision, 2);
        assert!(store
            .transaction(|tx| {
                update_at(
                    tx,
                    &store,
                    &scope,
                    UpdateLocalProjectRequest {
                        workspace_id: "workspace-1".into(),
                        id: "project-1".into(),
                        expected_revision: 1,
                        name: "Stale".into(),
                        instructions: String::new(),
                        knowledge_source_ids: vec![],
                    },
                    "2026-09-07T12:02:00Z",
                )
            })
            .is_err());
        let mut foreign = create_request();
        foreign.id = "project-foreign-source".into();
        foreign.thread_id = "thread-foreign-source".into();
        foreign.knowledge_source_ids = vec!["missing-or-foreign".into()];
        assert!(store
            .transaction(|tx| create_at(tx, &store, &scope, foreign, "now"))
            .is_err());
    }

    #[test]
    fn binds_exact_queued_run_author_once_and_archive_blocks_new_work() {
        let (store, scope) = store_and_scope();
        source(&store, &scope, "source-1");
        let project = store
            .transaction(|tx| {
                create_at(tx, &store, &scope, create_request(), "2026-09-07T12:00:00Z")
            })
            .unwrap();
        store
            .transaction(|tx| {
                execution_attempt::upsert_scoped(
                    tx,
                    &store,
                    &scope.data,
                    "run-1",
                    Some(&project.thread_id),
                    "codex",
                    "gpt",
                    "queued",
                    0,
                    true,
                    0,
                    "2026-09-07T12:00:01Z",
                    "2026-09-07T12:00:01Z",
                    &serde_json::json!({"transcript":"","pendingApprovalIds":[]}),
                )
            })
            .unwrap();
        let request = BindLocalProjectRunAuthorRequest {
            workspace_id: "workspace-1".into(),
            project_id: project.id.clone(),
            expected_revision: project.revision,
            run_id: "run-1".into(),
            agent_id: "agent-research".into(),
            thread_id: project.thread_id.clone(),
        };
        let author = store
            .transaction(|tx| {
                bind_author_at(
                    tx,
                    &store,
                    &scope,
                    request,
                    "Research agent",
                    "2026-09-07T12:00:02Z",
                )
            })
            .unwrap();
        assert_eq!(author.agent_name, "Research agent");
        assert_eq!(
            store
                .with_conn(|tx| repo::list_run_authors(tx, &store, &scope.private, &project.id, 10))
                .unwrap()
                .len(),
            1
        );

        store
            .transaction(|tx| {
                execution_attempt::upsert_scoped(
                    tx,
                    &store,
                    &scope.data,
                    "run-stale-source",
                    Some(&project.thread_id),
                    "codex",
                    "gpt",
                    "queued",
                    0,
                    true,
                    0,
                    "2026-09-07T12:00:03Z",
                    "2026-09-07T12:00:03Z",
                    &serde_json::json!({"transcript":"","pendingApprovalIds":[]}),
                )?;
                knowledge_source::delete_private(tx, &scope.private, "source-1")
            })
            .unwrap();
        assert!(store
            .transaction(|tx| {
                bind_author_at(
                    tx,
                    &store,
                    &scope,
                    BindLocalProjectRunAuthorRequest {
                        workspace_id: "workspace-1".into(),
                        project_id: project.id.clone(),
                        expected_revision: project.revision,
                        run_id: "run-stale-source".into(),
                        agent_id: "agent-research".into(),
                        thread_id: project.thread_id.clone(),
                    },
                    "Research agent",
                    "2026-09-07T12:00:04Z",
                )
            })
            .is_err());

        let archived = store
            .transaction(|tx| {
                archive_at(
                    tx,
                    &store,
                    &scope,
                    ArchiveLocalProjectRequest {
                        workspace_id: "workspace-1".into(),
                        id: project.id.clone(),
                        expected_revision: project.revision,
                    },
                    "2026-09-07T12:01:00Z",
                )
            })
            .unwrap();
        assert!(archived.archived_at.is_some());
        store
            .transaction(|tx| {
                execution_attempt::upsert_scoped(
                    tx,
                    &store,
                    &scope.data,
                    "run-2",
                    Some(&project.thread_id),
                    "codex",
                    "gpt",
                    "queued",
                    0,
                    true,
                    0,
                    "2026-09-07T12:01:01Z",
                    "2026-09-07T12:01:01Z",
                    &serde_json::json!({"transcript":"","pendingApprovalIds":[]}),
                )
            })
            .unwrap();
        assert!(store
            .transaction(|tx| {
                bind_author_at(
                    tx,
                    &store,
                    &scope,
                    BindLocalProjectRunAuthorRequest {
                        workspace_id: "workspace-1".into(),
                        project_id: archived.id.clone(),
                        expected_revision: archived.revision,
                        run_id: "run-2".into(),
                        agent_id: "agent-research".into(),
                        thread_id: archived.thread_id.clone(),
                    },
                    "Research agent",
                    "2026-09-07T12:01:02Z",
                )
            })
            .is_err());
    }

    fn share_request(
        project_id: &str,
        expected_revision: i64,
        mode: &str,
        kind: &str,
        id: &str,
        recipient: ProjectShareRecipient,
        owner: ProjectShareOwner,
        snapshot_text: Option<&str>,
    ) -> AddProjectShareRequest {
        AddProjectShareRequest {
            workspace_id: "workspace-1".into(),
            project_id: project_id.into(),
            expected_revision,
            share: AddProjectShare {
                mode: mode.into(),
                source: ProjectShareSource {
                    workspace_id: "workspace-1".into(),
                    kind: kind.into(),
                    id: id.into(),
                },
                source_revision: "rev-7".into(),
                recipient,
                owner,
                title: "Shared context".into(),
                snapshot_text: snapshot_text.map(str::to_string),
            },
        }
    }

    #[test]
    fn shares_record_recipient_ownership_and_snapshot_or_reference_semantics() {
        let (store, scope) = store_and_scope();
        source(&store, &scope, "source-1");
        let project = store
            .transaction(|tx| {
                create_at(tx, &store, &scope, create_request(), "2026-09-07T12:00:00Z")
            })
            .unwrap();
        store
            .transaction(|tx| {
                collab::put(
                    tx,
                    &store,
                    &scope.private,
                    Kind::Team,
                    "project-1",
                    None,
                    Some("project-1"),
                    &Team {
                        project_id: "project-1".into(),
                        lead_agent_id: None,
                        participant_ids: vec!["agent-research".into(), "agent-writer".into()],
                        revision: 1,
                    },
                )
            })
            .unwrap();
        let snapshot = store
            .transaction(|tx| {
                add_share_at(
                    tx,
                    &store,
                    &scope,
                    share_request(
                        "project-1",
                        project.revision,
                        "snapshot",
                        "file",
                        "source-1",
                        ProjectShareRecipient {
                            kind: "agent".into(),
                            id: "agent-writer".into(),
                        },
                        ProjectShareOwner {
                            kind: "agent".into(),
                            id: Some("agent-research".into()),
                            name: "Research".into(),
                        },
                        Some("frozen bytes"),
                    ),
                    "2026-09-07T12:01:00Z",
                )
            })
            .unwrap();
        assert_eq!(snapshot.shares.len(), 1);
        assert_eq!(snapshot.shares[0].mode, "snapshot");
        assert_eq!(snapshot.shares[0].recipient.id, "agent-writer");
        assert_eq!(
            snapshot.shares[0].owner.id.as_deref(),
            Some("agent-research")
        );
        assert_eq!(
            snapshot.shares[0].snapshot_text.as_deref(),
            Some("frozen bytes")
        );

        let referenced = store
            .transaction(|tx| {
                add_share_at(
                    tx,
                    &store,
                    &scope,
                    share_request(
                        "project-1",
                        snapshot.revision,
                        "live-reference",
                        "conversation",
                        "project-thread-1",
                        ProjectShareRecipient {
                            kind: "project".into(),
                            id: "project-1".into(),
                        },
                        ProjectShareOwner {
                            kind: "user".into(),
                            id: None,
                            name: "You".into(),
                        },
                        None,
                    ),
                    "2026-09-07T12:02:00Z",
                )
            })
            .unwrap();
        assert_eq!(referenced.shares.len(), 2);
        assert!(referenced.shares[1].snapshot_text.is_none());

        // Repeating an identical explicit share is idempotent.
        let repeated = store
            .transaction(|tx| {
                add_share_at(
                    tx,
                    &store,
                    &scope,
                    share_request(
                        "project-1",
                        referenced.revision,
                        "snapshot",
                        "file",
                        "source-1",
                        ProjectShareRecipient {
                            kind: "agent".into(),
                            id: "agent-writer".into(),
                        },
                        ProjectShareOwner {
                            kind: "agent".into(),
                            id: Some("agent-research".into()),
                            name: "Research".into(),
                        },
                        Some("frozen bytes"),
                    ),
                    "2026-09-07T12:03:00Z",
                )
            })
            .unwrap();
        assert_eq!(repeated.revision, referenced.revision);
        assert_eq!(repeated.shares.len(), 2);

        // Foreign recipients, live-reference bytes and stale revisions fail closed.
        assert!(store
            .transaction(|tx| {
                add_share_at(
                    tx,
                    &store,
                    &scope,
                    share_request(
                        "project-1",
                        repeated.revision,
                        "snapshot",
                        "file",
                        "source-1",
                        ProjectShareRecipient {
                            kind: "agent".into(),
                            id: "agent-stranger".into(),
                        },
                        ProjectShareOwner {
                            kind: "user".into(),
                            id: None,
                            name: "You".into(),
                        },
                        Some("frozen"),
                    ),
                    "2026-09-07T12:04:00Z",
                )
            })
            .is_err());
        assert!(store
            .transaction(|tx| {
                add_share_at(
                    tx,
                    &store,
                    &scope,
                    share_request(
                        "project-1",
                        repeated.revision,
                        "live-reference",
                        "file",
                        "source-1",
                        ProjectShareRecipient {
                            kind: "project".into(),
                            id: "project-1".into(),
                        },
                        ProjectShareOwner {
                            kind: "user".into(),
                            id: None,
                            name: "You".into(),
                        },
                        Some("copied anyway"),
                    ),
                    "2026-09-07T12:04:00Z",
                )
            })
            .is_err());
        assert!(store
            .transaction(|tx| {
                add_share_at(
                    tx,
                    &store,
                    &scope,
                    share_request(
                        "project-1",
                        repeated.revision - 1,
                        "snapshot",
                        "file",
                        "source-1",
                        ProjectShareRecipient {
                            kind: "project".into(),
                            id: "project-1".into(),
                        },
                        ProjectShareOwner {
                            kind: "user".into(),
                            id: None,
                            name: "You".into(),
                        },
                        Some("stale"),
                    ),
                    "2026-09-07T12:04:00Z",
                )
            })
            .is_err());

        let removed = store
            .transaction(|tx| {
                remove_share_at(
                    tx,
                    &store,
                    &scope,
                    RemoveProjectShareRequest {
                        workspace_id: "workspace-1".into(),
                        project_id: "project-1".into(),
                        expected_revision: repeated.revision,
                        share_id: snapshot.shares[0].id.clone(),
                    },
                    "2026-09-07T12:05:00Z",
                )
            })
            .unwrap();
        assert_eq!(removed.shares.len(), 1);
        assert_eq!(removed.shares[0].mode, "live-reference");
    }

    #[test]
    fn migrates_legacy_group_preserving_history_authorship_and_agent_identity() {
        let (store, scope) = store_and_scope();
        let profiles: Vec<FableAgentProfile> = serde_json::from_value(serde_json::json!([
            {"id":"agent-a","name":"Alpha","instructions":"Keep alpha","modelId":"openai::alpha-model","icon":"sparkle","permissionLabel":"Ask Me"},
            {"id":"agent-b","name":"Beta","instructions":"Keep beta","modelId":"anthropic::beta-model","icon":"sparkle","permissionLabel":"Ask Me"}
        ]))
        .unwrap();
        let identities_before = serde_json::to_value(&profiles).unwrap();
        store
            .transaction(|tx| {
                thread::create(
                    tx,
                    &store,
                    &scope.data,
                    "legacy-thread",
                    None,
                    "Legacy group",
                    "now",
                    &serde_json::json!({"authorityScope":{"authority":"local","visibility":"member-private","ownerMemberId":scope.private.owner_member_id()}}),
                )?;
                tx.execute(
                    "UPDATE thread SET owner_member_id=?1
                      WHERE workspace_id=?2 AND id='legacy-thread' AND owner_member_id IS NULL",
                    rusqlite::params![scope.private.owner_member_id(), scope.data.workspace_id()],
                )?;
                tx.execute(
                    "INSERT INTO run(id,workspace_id,thread_id,provider_id,model,status,turn,
                                     recoverable,retry_count,created_at,updated_at,payload,payload_nonce)
                     VALUES('run-legacy','workspace-1','legacy-thread','anthropic','beta-model',
                            'completed',1,0,0,'now','now',X'',X'')",
                    [],
                )?;
                tx.execute(
                    "INSERT INTO run(id,workspace_id,thread_id,provider_id,model,status,turn,
                                     recoverable,retry_count,created_at,updated_at,payload,payload_nonce)
                     VALUES('run-unknown','workspace-1','legacy-thread','custom','mystery',
                            'completed',1,0,0,'now','now',X'',X'')",
                    [],
                )?;
                collab::put(
                    tx,
                    &store,
                    &scope.private,
                    Kind::Conversation,
                    "legacy-thread",
                    Some("legacy-thread"),
                    None,
                    &Conversation {
                        archived: false,
                        chat: None,
                        id: "legacy-thread".into(),
                        workspace_id: "workspace-1".into(),
                        kind: "group".into(),
                        title: "Legacy group".into(),
                        project_id: None,
                        facilitator_id: None,
                        participants: vec![
                            Participant {
                                agent_id: "agent-a".into(),
                                name: "Alpha".into(),
                            },
                            Participant {
                                agent_id: "agent-b".into(),
                                name: "Beta".into(),
                            },
                        ],
                        revision: 4,
                        generation: 2,
                        created_at: "now".into(),
                        updated_at: "now".into(),
                    },
                )
            })
            .unwrap();
        let project = store
            .transaction(|tx| {
                migrate_group_at(
                    tx,
                    &store,
                    &scope,
                    &profiles,
                    MigrateLegacyGroupRequest {
                        workspace_id: "workspace-1".into(),
                        id: "project-legacy".into(),
                        conversation_id: "legacy-thread".into(),
                        expected_revision: 4,
                        name: "Legacy converted".into(),
                        instructions: "Keep the history".into(),
                        participant_ids: vec!["agent-a".into(), "agent-b".into()],
                        lead_agent_id: None,
                        share_history: true,
                    },
                    "2026-09-07T12:05:00Z",
                )
            })
            .unwrap();
        assert_eq!(project.thread_id, "legacy-thread");
        assert!(project.shares.is_empty());
        store
            .with_conn(|tx| {
                let room: Conversation = collab::get(
                    tx,
                    &store,
                    &scope.private,
                    Kind::Conversation,
                    "legacy-thread",
                )?
                .unwrap();
                assert_eq!(room.project_id.as_deref(), Some("project-legacy"));
                assert_eq!(room.facilitator_id, None);
                assert_eq!(
                    room.chat.as_ref().map(|chat| chat.owner_id.as_str()),
                    Some("project-legacy")
                );
                let team: Team =
                    collab::get(tx, &store, &scope.private, Kind::Team, "project-legacy")?.unwrap();
                assert_eq!(team.lead_agent_id, None);
                assert_eq!(
                    team.participant_ids,
                    vec!["agent-a".to_string(), "agent-b".to_string()]
                );
                let beta: Author =
                    collab::get(tx, &store, &scope.private, Kind::Author, "run-legacy")?.unwrap();
                assert_eq!(beta.agent_id, "agent-b");
                assert_eq!(beta.name, "Beta");
                let unknown: Author =
                    collab::get(tx, &store, &scope.private, Kind::Author, "run-unknown")?.unwrap();
                assert_eq!(unknown.agent_id, "historical");
                assert!(unknown.name.contains("attribution unavailable"));
                Ok(())
            })
            .unwrap();
        // Project activity never rewrites agent identity, instructions or model.
        assert_eq!(serde_json::to_value(&profiles).unwrap(), identities_before);
        // A thread can be migrated once.
        assert!(store
            .transaction(|tx| {
                migrate_group_at(
                    tx,
                    &store,
                    &scope,
                    &profiles,
                    MigrateLegacyGroupRequest {
                        workspace_id: "workspace-1".into(),
                        id: "project-legacy-2".into(),
                        conversation_id: "legacy-thread".into(),
                        expected_revision: 5,
                        name: "Again".into(),
                        instructions: String::new(),
                        participant_ids: vec!["agent-a".into()],
                        lead_agent_id: None,
                        share_history: true,
                    },
                    "2026-09-07T12:06:00Z",
                )
            })
            .is_err());
    }
}
