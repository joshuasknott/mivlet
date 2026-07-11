//! Authenticated native commands for local member-private goals.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Deserializer};

use crate::store::repos::{
    goal::{self, GoalListFilter, GoalRow},
    scope::DataScope,
    workspace_directory,
};

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn goal_id() -> Result<String, String> {
    let mut bytes = [0_u8; 24];
    getrandom::fill(&mut bytes)
        .map_err(|_| "Fable could not create a secure goal id.".to_string())?;
    Ok(format!("goal_{}", URL_SAFE_NO_PAD.encode(bytes)))
}

fn present_optional<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(deserializer).map(Some)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalCreateInput {
    project_id: Option<String>,
    title: String,
    statement: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalListInput {
    #[serde(default, deserialize_with = "present_optional")]
    project_id: Option<Option<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalUpdateInput {
    goal_id: String,
    base_revision: i64,
    #[serde(default, deserialize_with = "present_optional")]
    project_id: Option<Option<String>>,
    title: Option<String>,
    statement: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalTransitionInput {
    goal_id: String,
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
    let member = context.member_id.clone().ok_or_else(|| {
        crate::store::StoreError::Invalid(
            "An active Fable workspace membership is required for private goals.".into(),
        )
    })?;
    let scope = DataScope::workspace(context.active_workspace.local_workspace_id.clone())?;
    Ok((scope, context, member))
}

#[tauri::command]
pub fn goal_create(input: GoalCreateInput) -> Result<GoalRow, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let id = goal_id()?;
    store
        .transaction(|tx| {
            let (scope, context, member) = authorized(tx)?;
            goal::create(
                tx,
                store,
                &scope,
                &id,
                &member,
                &context.internal_user_id,
                input.project_id.as_deref(),
                &input.title,
                &input.statement,
                &now(),
            )
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn goal_list(input: GoalListInput) -> Result<Vec<GoalRow>, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .with_conn(|tx| {
            let (scope, _, member) = authorized(tx)?;
            let filter = match input.project_id.as_ref() {
                None => GoalListFilter::All,
                Some(None) => GoalListFilter::Workspace,
                Some(Some(project_id)) => GoalListFilter::Project(project_id),
            };
            goal::list(tx, store, &scope, &member, filter)
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn goal_get(goal_id: String) -> Result<Option<GoalRow>, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .with_conn(|tx| {
            let (scope, _, member) = authorized(tx)?;
            goal::get(tx, store, &scope, &goal_id, &member)
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn goal_update(input: GoalUpdateInput) -> Result<GoalRow, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            let (scope, _, member) = authorized(tx)?;
            goal::update(
                tx,
                store,
                &scope,
                &member,
                &input.goal_id,
                input.base_revision,
                input.project_id.as_ref().map(|v| v.as_deref()),
                input.title.as_deref(),
                input.statement.as_deref(),
                &now(),
            )
        })
        .map_err(|e| e.to_string())
}

fn transition(input: GoalTransitionInput, lifecycle: &str) -> Result<GoalRow, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            let (scope, _, member) = authorized(tx)?;
            goal::transition(
                tx,
                store,
                &scope,
                &member,
                &input.goal_id,
                input.base_revision,
                lifecycle,
                &now(),
            )
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn goal_achieve(input: GoalTransitionInput) -> Result<GoalRow, String> {
    transition(input, "achieved")
}
#[tauri::command]
pub fn goal_archive(input: GoalTransitionInput) -> Result<GoalRow, String> {
    transition(input, "archived")
}
#[tauri::command]
pub fn goal_restore(input: GoalTransitionInput) -> Result<GoalRow, String> {
    transition(input, "active")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_input_distinguishes_all_workspace_and_exact_project() {
        let all: GoalListInput = serde_json::from_value(serde_json::json!({})).unwrap();
        let workspace: GoalListInput =
            serde_json::from_value(serde_json::json!({"projectId":null})).unwrap();
        let project: GoalListInput =
            serde_json::from_value(serde_json::json!({"projectId":"project-1"})).unwrap();
        assert!(all.project_id.is_none());
        assert_eq!(workspace.project_id, Some(None));
        assert_eq!(project.project_id, Some(Some("project-1".into())));
    }
}
