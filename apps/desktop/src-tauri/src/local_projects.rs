//! Small member-private project rooms shared by every local named agent.
//!
//! A project owns one ordinary durable conversation thread. It widens neither
//! human visibility nor provider/tool authority; run attribution is captured
//! before work begins and is immutable for that run.

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};

use crate::authorized_scope::{self, AuthorizedCommandScope, ScopeAccess};
use crate::store::repos::local_project::{self as repo, LocalProjectRow, LocalProjectRunAuthorRow};
use crate::store::repos::{execution_attempt, thread};
use crate::store::{Store, StoreError};

const MAX_PROJECTS: i64 = 128;
const MAX_ID_CHARACTERS: usize = 128;
const MAX_NAME_CHARACTERS: usize = 120;
const MAX_INSTRUCTIONS_CHARACTERS: usize = 12_000;
const MAX_KNOWLEDGE_SOURCES: usize = 64;
const PROJECT_LIST_LIMIT: usize = 128;
const AUTHOR_LIST_LIMIT: usize = 500;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct LocalProjectPayload {
    name: String,
    instructions: String,
    knowledge_source_ids: Vec<String>,
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
    let payload = validate_payload_store(
        tx,
        scope,
        request.name,
        request.instructions,
        request.knowledge_source_ids,
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

fn validate_payload_store(
    tx: &rusqlite::Connection,
    scope: &AuthorizedCommandScope,
    name: String,
    instructions: String,
    knowledge_source_ids: Vec<String>,
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
}
