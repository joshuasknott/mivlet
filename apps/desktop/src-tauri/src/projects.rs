//! Native project commands. Workspace and private owner always come from the
//! authenticated account context, never from renderer input.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Deserializer};

use crate::store::repos::{
    project::{self, ProjectRow},
    scope::DataScope,
    workspace_directory,
};

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn project_id() -> Result<String, String> {
    let mut bytes = [0_u8; 24];
    getrandom::fill(&mut bytes)
        .map_err(|_| "Fable could not create a secure project id.".to_string())?;
    Ok(format!("project_{}", URL_SAFE_NO_PAD.encode(bytes)))
}

fn present_optional<'de, D>(deserializer: D) -> Result<Option<Option<String>>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(Some)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectCreateInput {
    title: String,
    description: Option<String>,
    instructions: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectUpdateInput {
    project_id: String,
    base_revision: i64,
    title: Option<String>,
    #[serde(default, deserialize_with = "present_optional")]
    description: Option<Option<String>>,
    #[serde(default, deserialize_with = "present_optional")]
    instructions: Option<Option<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectTransitionInput {
    project_id: String,
    base_revision: i64,
}

fn authorized(
    tx: &rusqlite::Connection,
) -> crate::store::Result<(
    DataScope,
    workspace_directory::AuthorizedWorkspaceContext,
    String,
)> {
    let context = workspace_directory::require_active_workspace_context_for_current_user(tx)?;
    let owner_member_id = context.member_id.clone().ok_or_else(|| {
        crate::store::StoreError::Invalid(
            "An active Fable workspace membership is required for private projects.".into(),
        )
    })?;
    let scope = DataScope::workspace(context.active_workspace.local_workspace_id.clone())?;
    Ok((scope, context, owner_member_id))
}

#[tauri::command]
pub fn project_create(input: ProjectCreateInput) -> Result<ProjectRow, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let id = project_id()?;
    store
        .transaction(|tx| {
            let (scope, context, owner_member_id) = authorized(tx)?;
            project::create(
                tx,
                store,
                &scope,
                &id,
                &owner_member_id,
                &context.internal_user_id,
                &input.title,
                input.description.as_deref(),
                input.instructions.as_deref(),
                &now(),
            )
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn project_list() -> Result<Vec<ProjectRow>, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .with_conn(|tx| {
            let (scope, _, owner_member_id) = authorized(tx)?;
            project::list(tx, store, &scope, &owner_member_id)
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn project_get(project_id: String) -> Result<Option<ProjectRow>, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .with_conn(|tx| {
            let (scope, _, owner_member_id) = authorized(tx)?;
            project::get(tx, store, &scope, &project_id, &owner_member_id)
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn project_update(input: ProjectUpdateInput) -> Result<ProjectRow, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            let (scope, _, owner_member_id) = authorized(tx)?;
            project::update(
                tx,
                store,
                &scope,
                &owner_member_id,
                &input.project_id,
                input.base_revision,
                input.title.as_deref(),
                input.description.as_ref().map(|value| value.as_deref()),
                input.instructions.as_ref().map(|value| value.as_deref()),
                &now(),
            )
        })
        .map_err(|error| error.to_string())
}

fn transition(input: ProjectTransitionInput, lifecycle: &str) -> Result<ProjectRow, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            let (scope, _, owner_member_id) = authorized(tx)?;
            project::transition(
                tx,
                store,
                &scope,
                &owner_member_id,
                &input.project_id,
                input.base_revision,
                lifecycle,
                &now(),
            )
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn project_archive(input: ProjectTransitionInput) -> Result<ProjectRow, String> {
    transition(input, "archived")
}

#[tauri::command]
pub fn project_restore(input: ProjectTransitionInput) -> Result<ProjectRow, String> {
    transition(input, "active")
}

#[tauri::command]
pub fn project_delete(input: ProjectTransitionInput) -> Result<ProjectRow, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            let (scope, context, owner_member_id) = authorized(tx)?;
            project::delete(
                tx,
                store,
                &scope,
                &owner_member_id,
                &context.internal_user_id,
                &input.project_id,
                input.base_revision,
                &now(),
            )
        })
        .map_err(|error| error.to_string())
}
