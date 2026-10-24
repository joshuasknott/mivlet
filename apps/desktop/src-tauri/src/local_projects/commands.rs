use super::{
    add_share_at, archive_at, author_from_row, authorized_scope, bind_author_at, create_at,
    global_store, migrate_group_at, project_from_row, remove_share_at, require_main_window,
    timestamp, update_at, validate_id, AddProjectShareRequest, ArchiveLocalProjectRequest,
    BindLocalProjectRunAuthorRequest, CreateLocalProjectRequest, GetLocalProjectRunAuthorRequest,
    ListLocalProjectRunAuthorsRequest, ListLocalProjectsRequest, LocalProject,
    LocalProjectRunAuthor, MigrateLegacyGroupRequest, RemoveProjectShareRequest, ScopeAccess,
    UpdateLocalProjectRequest, AUTHOR_LIST_LIMIT, PROJECT_LIST_LIMIT,
};
use crate::store::repos::local_project as repo;
use crate::store::StoreError;
pub(super) fn local_project_create(
    app: tauri::AppHandle,
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
            let profiles = if request.participant_ids.is_some() {
                Some(
                    crate::snapshot::load_runtime_snapshot_in_transaction(
                        &app,
                        tx,
                        &request.workspace_id,
                    )?
                    .ok_or_else(|| {
                        StoreError::Invalid(
                            "Mivlet's persisted agent profiles are not available.".into(),
                        )
                    })?
                    .agents,
                )
            } else {
                None
            };
            create_at(tx, store, &scope, request, &now, profiles.as_deref())
        })
        .map_err(|error| error.to_string())
}

pub(super) fn local_project_list(
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

pub(super) fn local_project_update(
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

pub(super) fn local_project_archive(
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

pub(super) fn local_project_share_add(
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

pub(super) fn local_project_share_remove(
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
pub(super) fn local_project_migrate_group(
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

pub(super) fn local_project_run_author_bind(
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

pub(super) fn local_project_run_author_list(
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

pub(super) fn local_project_run_author_get(
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
