//! Single installation-local authority boundary for local product data.
//!
//! Renderer workspace fields are assertions only. Optional Fable account state
//! never changes the owner, encryption audience, or workspace of conversations,
//! memory, provider connections, approvals, or execution attempts.

use rusqlite::Connection;

use crate::store::repos::scope::{DataScope, PrivateDataScope, DEFAULT_WORKSPACE_ID};
use crate::store::StoreError;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScopeAccess {
    Read,
    Write,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthorizedCommandScope {
    pub data: DataScope,
    pub private: PrivateDataScope,
    pub internal_user_id: String,
    pub member_id: Option<String>,
}

pub fn resolve(
    conn: &Connection,
    requested_workspace_id: Option<&str>,
    project_id: Option<&str>,
    _access: ScopeAccess,
) -> crate::store::Result<AuthorizedCommandScope> {
    let requested = requested_workspace_id.unwrap_or(DEFAULT_WORKSPACE_ID);
    if requested != DEFAULT_WORKSPACE_ID {
        return Err(StoreError::Invalid(
            "Local Fable data belongs to this installation workspace.".into(),
        ));
    }
    if project_id.is_some() {
        return Err(StoreError::Invalid(
            "Project-scoped data is no longer part of the Fable product.".into(),
        ));
    }

    let (internal_user_id, member_id) = crate::account_workspace::local_install_principals();
    let data = DataScope::new(DEFAULT_WORKSPACE_ID.to_string(), None)?;
    data.ensure_exists(conn)?;
    let private = PrivateDataScope::for_authenticated_user(
        data.clone(),
        &internal_user_id,
        Some(&member_id),
    )?;
    Ok(AuthorizedCommandScope {
        data,
        private,
        internal_user_id,
        member_id: Some(member_id),
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

pub fn active_command_scope(access: ScopeAccess) -> Result<AuthorizedCommandScope, String> {
    command_scope(Some(DEFAULT_WORKSPACE_ID.into()), None, access)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{
        vault::{MasterKey, Vault},
        Store,
    };

    fn store() -> Store {
        Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap()
    }

    #[test]
    fn account_state_cannot_change_installation_local_authority() {
        store()
            .with_conn(|conn| {
                let scope = resolve(conn, Some(DEFAULT_WORKSPACE_ID), None, ScopeAccess::Write)?;
                assert_eq!(scope.data.workspace_id(), DEFAULT_WORKSPACE_ID);
                assert!(scope.internal_user_id.starts_with("local-user-"));
                assert!(scope
                    .member_id
                    .as_deref()
                    .is_some_and(|id| id.starts_with("local-member-")));
                assert_eq!(scope.private.owner_member_id(), scope.member_id.as_deref());
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn alternate_workspaces_and_retired_project_scope_fail_closed() {
        store()
            .with_conn(|conn| {
                assert!(resolve(conn, Some("hosted-workspace"), None, ScopeAccess::Read).is_err());
                assert!(resolve(
                    conn,
                    Some(DEFAULT_WORKSPACE_ID),
                    Some("project"),
                    ScopeAccess::Read
                )
                .is_err());
                Ok(())
            })
            .unwrap();
    }
}
