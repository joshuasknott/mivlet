//! Central authenticated scope boundary for legacy commands that still accept
//! renderer workspace/project fields. Workspace ids are assertions only; the
//! active account directory remains authority.

use rusqlite::{Connection, OptionalExtension};

use crate::store::repos::{scope::DataScope, workspace_directory};
use crate::store::StoreError;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScopeAccess {
    Read,
    Write,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthorizedCommandScope {
    pub data: DataScope,
    pub internal_user_id: String,
    pub member_id: Option<String>,
}

pub fn resolve(
    conn: &Connection,
    requested_workspace_id: Option<&str>,
    project_id: Option<&str>,
    access: ScopeAccess,
) -> crate::store::Result<AuthorizedCommandScope> {
    let context = workspace_directory::require_active_workspace_context_for_current_user(conn)?;
    let requested = requested_workspace_id
        .ok_or_else(|| StoreError::Invalid("Workspace id is required.".into()))?;
    if requested != context.active_workspace.local_workspace_id {
        return Err(StoreError::Invalid(
            "The requested workspace is not active for this account.".into(),
        ));
    }
    if let Some(project_id) = project_id {
        let member = context.member_id.as_deref().ok_or_else(|| {
            StoreError::Invalid(
                "An active workspace membership is required for project context.".into(),
            )
        })?;
        let lifecycle=conn.query_row(
            "SELECT lifecycle FROM project WHERE id=?1 AND workspace_id=?2 AND owner_member_id=?3 AND authority='local' AND visibility='member-private' AND deleted_at IS NULL;",
            rusqlite::params![project_id,requested,member],
            |row|row.get::<_,String>(0),
        ).optional()?;
        match lifecycle.as_deref() {
            Some("active") => {}
            Some("archived") if access == ScopeAccess::Read => {}
            Some("archived") => {
                return Err(StoreError::Invalid(
                    "Archived project context is read-only.".into(),
                ))
            }
            _ => {
                return Err(StoreError::Invalid(
                    "Project context is unavailable for this account.".into(),
                ))
            }
        }
    }
    let data = DataScope::new(requested.to_string(), project_id.map(str::to_string))?;
    data.ensure_exists(conn)?;
    Ok(AuthorizedCommandScope {
        data,
        internal_user_id: context.internal_user_id,
        member_id: context.member_id,
    })
}

pub fn command_scope(
    workspace_id: Option<String>,
    project_id: Option<String>,
    access: ScopeAccess,
) -> Result<AuthorizedCommandScope, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .with_conn(|conn| resolve(conn, workspace_id.as_deref(), project_id.as_deref(), access))
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{
        repos::{
            project,
            workspace_directory::{
                select_active_workspace, set_current_internal_user, upsert_authoritative_summary,
                WorkspaceDirectoryUpsert,
            },
        },
        vault::{MasterKey, Vault},
        Store,
    };

    fn summary(user: &str, workspace: &str, member: &str) -> WorkspaceDirectoryUpsert {
        WorkspaceDirectoryUpsert {
            internal_user_id: user.into(),
            fable_workspace_id: workspace.into(),
            name: "Workspace".into(),
            workspace_status: "active".into(),
            workspace_revision: 1,
            policy_revision: 1,
            member_id: member.into(),
            role: "owner".into(),
            membership_status: "active".into(),
            membership_revision: 1,
            updated_at: "t".into(),
        }
    }

    #[test]
    fn active_scope_rejects_other_workspace_member_and_non_active_projects() {
        let store =
            Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap();
        let local = store
            .transaction(|tx| {
                let one = upsert_authoritative_summary(
                    tx,
                    &summary("user-1", "workspace-1", "member-1"),
                )?;
                upsert_authoritative_summary(tx, &summary("user-2", "workspace-1", "member-2"))?;
                set_current_internal_user(tx, "user-1", "t")?;
                select_active_workspace(tx, "user-1", "workspace-1", "t")?;
                let scope = DataScope::workspace(one.local_workspace_id.clone())?;
                project::create(
                    tx,
                    &store,
                    &scope,
                    "active-project",
                    "member-1",
                    "user-1",
                    "Active",
                    None,
                    None,
                    "t",
                )?;
                project::create(
                    tx,
                    &store,
                    &scope,
                    "archived-project",
                    "member-1",
                    "user-1",
                    "Archived",
                    None,
                    None,
                    "t",
                )?;
                project::transition(
                    tx,
                    &store,
                    &scope,
                    "member-1",
                    "archived-project",
                    1,
                    "archived",
                    "t2",
                )?;
                project::create(
                    tx,
                    &store,
                    &scope,
                    "foreign-project",
                    "member-2",
                    "user-2",
                    "Foreign",
                    None,
                    None,
                    "t",
                )?;
                project::create(
                    tx,
                    &store,
                    &scope,
                    "deleted-project",
                    "member-1",
                    "user-1",
                    "Deleted",
                    None,
                    None,
                    "t",
                )?;
                project::delete(
                    tx,
                    &store,
                    &scope,
                    "member-1",
                    "user-1",
                    "deleted-project",
                    1,
                    "t2",
                )?;
                Ok(one.local_workspace_id)
            })
            .unwrap();
        store
            .with_conn(|tx| {
                assert!(resolve(tx, Some(&local), None, ScopeAccess::Write).is_ok());
                assert!(resolve(tx, Some("default"), None, ScopeAccess::Read).is_err());
                assert!(
                    resolve(tx, Some(&local), Some("active-project"), ScopeAccess::Write).is_ok()
                );
                assert!(
                    resolve(tx, Some(&local), Some("foreign-project"), ScopeAccess::Read).is_err()
                );
                assert!(resolve(
                    tx,
                    Some(&local),
                    Some("archived-project"),
                    ScopeAccess::Read
                )
                .is_ok());
                assert!(resolve(
                    tx,
                    Some(&local),
                    Some("archived-project"),
                    ScopeAccess::Write
                )
                .unwrap_err()
                .to_string()
                .contains("read-only"));
                assert!(
                    resolve(tx, Some(&local), Some("deleted-project"), ScopeAccess::Read).is_err()
                );
                Ok(())
            })
            .unwrap();
    }
}
