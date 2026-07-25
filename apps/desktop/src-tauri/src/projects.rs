//! Native project commands. Workspace and private owner always come from the
//! authenticated account context, never from renderer input.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Deserializer, Serialize};

use crate::authorized_scope::{self, ScopeAccess};
use crate::store::repos::{
    connection_record::{self, SafeConnectionRecord},
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
    connection_ids: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectTransitionInput {
    project_id: String,
    base_revision: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectConnectionOption {
    connection_id: String,
    connector_id: String,
    display_name: String,
    health_state: String,
    selectable: bool,
}

fn connection_is_selectable(connection: &SafeConnectionRecord) -> bool {
    connection.lifecycle == "authorized"
        && matches!(
            connection.authorization_state.as_str(),
            "authorized" | "not-required"
        )
        && matches!(
            connection.credential_state.as_str(),
            "available" | "not-required"
        )
}

fn scoped_connection(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &crate::authorized_scope::AuthorizedCommandScope,
    connection_id: &str,
) -> crate::store::Result<Option<SafeConnectionRecord>> {
    connection_record::get_project_visible(tx, store, scope, connection_id)
}

fn validate_connection_selection(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    workspace_id: &str,
    old: &ProjectRow,
    requested: &[String],
) -> crate::store::Result<Vec<String>> {
    let normalized = project::normalize_connection_ids(requested)?;
    let scope = authorized_scope::resolve(tx, Some(workspace_id), None, ScopeAccess::Read)?;
    for connection_id in &normalized {
        if old.connection_ids.contains(connection_id) {
            continue;
        }
        let connection = scoped_connection(tx, store, &scope, connection_id)?.ok_or_else(|| {
            crate::store::StoreError::Invalid(
                "A selected Connection is unavailable to this Project.".into(),
            )
        })?;
        if !connection_is_selectable(&connection) {
            return Err(crate::store::StoreError::Invalid(
                "A selected Connection is not ready for Project use.".into(),
            ));
        }
    }
    Ok(normalized)
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
pub fn project_connection_options() -> Result<Vec<ProjectConnectionOption>, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .with_conn(|tx| {
            let context =
                workspace_directory::require_active_workspace_context_for_current_user(tx)?;
            let scope = authorized_scope::resolve(
                tx,
                Some(&context.active_workspace.local_workspace_id),
                None,
                ScopeAccess::Read,
            )?;
            connection_record::list_project_visible(tx, store, &scope).map(|connections| {
                connections
                    .into_iter()
                    .map(|connection| {
                        let selectable = connection_is_selectable(&connection);
                        ProjectConnectionOption {
                            connection_id: connection.id,
                            connector_id: connection.connector_definition_key,
                            display_name: connection.display_name,
                            health_state: connection.health_state,
                            selectable,
                        }
                    })
                    .collect()
            })
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
            let old = project::get(tx, store, &scope, &input.project_id, &owner_member_id)?
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid(
                        "Project is unavailable in this workspace.".into(),
                    )
                })?;
            let connection_ids = input
                .connection_ids
                .as_deref()
                .map(|requested| {
                    validate_connection_selection(tx, store, scope.workspace_id(), &old, requested)
                })
                .transpose()?;
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
                connection_ids.as_deref(),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::repos::{
        connection_record::NativeConnectorConnectionWrite,
        workspace_directory::{
            select_active_workspace, set_current_internal_user, upsert_authoritative_summary,
            WorkspaceDirectoryUpsert,
        },
    };
    use crate::store::vault::{MasterKey, Vault};

    fn store() -> crate::store::Store {
        crate::store::Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap())
            .unwrap()
    }

    #[test]
    fn project_connections_are_scoped_choices_without_new_authority() {
        let store = store();
        let (workspace_id, connection_id, foreign_connection_id) = store
            .transaction(|tx| {
                let workspace = upsert_authoritative_summary(
                    tx,
                    &WorkspaceDirectoryUpsert {
                        internal_user_id: "user-a".into(),
                        fable_workspace_id: "workspace-a".into(),
                        name: "Workspace".into(),
                        workspace_status: "active".into(),
                        workspace_revision: 1,
                        policy_revision: 1,
                        member_id: "member-a".into(),
                        role: "owner".into(),
                        membership_status: "active".into(),
                        membership_revision: 1,
                        updated_at: "t".into(),
                    },
                )?;
                set_current_internal_user(tx, "user-a", "t")?;
                select_active_workspace(tx, "user-a", "workspace-a", "t")?;
                let scope = authorized_scope::resolve(
                    tx,
                    Some(&workspace.local_workspace_id),
                    None,
                    ScopeAccess::Write,
                )?;
                project::create(
                    tx,
                    &store,
                    &scope.data,
                    "project-a",
                    "member-a",
                    "user-a",
                    "Project",
                    None,
                    None,
                    "t",
                )?;
                let connection = connection_record::upsert_native_connector(
                    tx,
                    &store,
                    &scope,
                    NativeConnectorConnectionWrite {
                        connector_definition_key: "github",
                        external_account_id: "opaque-provider-account",
                        display_name: "Work GitHub",
                        lifecycle: "authorized",
                        authorization_state: "authorized",
                        health_state: "healthy",
                        credential_state: "available",
                        expected_revision: None,
                        updated_at: "t",
                    },
                )?;
                upsert_authoritative_summary(
                    tx,
                    &WorkspaceDirectoryUpsert {
                        internal_user_id: "user-b".into(),
                        fable_workspace_id: "workspace-a".into(),
                        name: "Workspace".into(),
                        workspace_status: "active".into(),
                        workspace_revision: 1,
                        policy_revision: 1,
                        member_id: "member-b".into(),
                        role: "viewer".into(),
                        membership_status: "active".into(),
                        membership_revision: 1,
                        updated_at: "t".into(),
                    },
                )?;
                set_current_internal_user(tx, "user-b", "t")?;
                select_active_workspace(tx, "user-b", "workspace-a", "t")?;
                let foreign_scope = authorized_scope::resolve(
                    tx,
                    Some(&workspace.local_workspace_id),
                    None,
                    ScopeAccess::Write,
                )?;
                let foreign = connection_record::upsert_mcp_stdio(
                    tx,
                    &store,
                    &foreign_scope,
                    "foreign-launch",
                    "Other member's MCP",
                    "t",
                )?;
                set_current_internal_user(tx, "user-a", "t")?;
                select_active_workspace(tx, "user-a", "workspace-a", "t")?;
                Ok((workspace.local_workspace_id, connection.id, foreign.id))
            })
            .unwrap();

        store
            .transaction(|tx| {
                let scope = DataScope::workspace(workspace_id.clone())?;
                let old = project::get(tx, &store, &scope, "project-a", "member-a")?.unwrap();
                let selected = validate_connection_selection(
                    tx,
                    &store,
                    &workspace_id,
                    &old,
                    std::slice::from_ref(&connection_id),
                )?;
                let updated = project::update(
                    tx,
                    &store,
                    &scope,
                    "member-a",
                    "project-a",
                    old.revision,
                    None,
                    None,
                    None,
                    Some(&selected),
                    "t2",
                )?;
                assert_eq!(updated.connection_ids, vec![connection_id.clone()]);
                Ok(())
            })
            .unwrap();

        store
            .transaction(|tx| {
                tx.execute(
                    "UPDATE connection_record SET lifecycle='disconnected',
                       authorization_state='revoked',credential_state='revoked'
                     WHERE id=?1",
                    [&connection_id],
                )?;
                tx.execute(
                    "UPDATE connection_record SET payload=x'00' WHERE id=?1",
                    [&foreign_connection_id],
                )?;
                let command_scope =
                    authorized_scope::resolve(tx, Some(&workspace_id), None, ScopeAccess::Read)?;
                let visible = connection_record::list_project_visible(tx, &store, &command_scope)?;
                assert!(visible
                    .iter()
                    .all(|connection| connection.id != foreign_connection_id));
                let scope = DataScope::workspace(workspace_id.clone())?;
                let old = project::get(tx, &store, &scope, "project-a", "member-a")?.unwrap();
                assert_eq!(
                    validate_connection_selection(
                        tx,
                        &store,
                        &workspace_id,
                        &old,
                        std::slice::from_ref(&connection_id),
                    )?,
                    vec![connection_id.clone()]
                );
                assert!(validate_connection_selection(
                    tx,
                    &store,
                    &workspace_id,
                    &old,
                    &["connection-missing".into()],
                )
                .is_err());
                assert!(validate_connection_selection(
                    tx,
                    &store,
                    &workspace_id,
                    &old,
                    std::slice::from_ref(&foreign_connection_id),
                )
                .is_err());
                assert!(project::normalize_connection_ids(&[
                    connection_id.clone(),
                    connection_id.clone()
                ])
                .is_err());
                Ok(())
            })
            .unwrap();
    }
}
