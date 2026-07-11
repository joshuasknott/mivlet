//! Encrypted, authenticated machine-local STDIO MCP launch configuration.
//!
//! The renderer and portable archives receive only safe metadata. Executable
//! paths and arguments are opened solely at the native process boundary.

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::authorized_scope::{AuthorizedCommandScope, ScopeAccess};
use crate::store::repos::{open_json, seal_json};
use crate::store::{Result, Store, StoreError};

const DISPLAY_NAME_MAX: usize = 200;
const COMMAND_MAX: usize = 2_048;
const ARG_MAX: usize = 2_048;
const MAX_ARGS: usize = 64;

#[derive(Clone, Debug)]
pub struct McpLocalServerWrite<'a> {
    pub id: &'a str,
    pub display_name: &'a str,
    pub command: &'a str,
    pub args: &'a [String],
    pub expected_revision: Option<i64>,
    pub updated_at: &'a str,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SafeMcpLocalServer {
    pub id: String,
    pub workspace_id: String,
    pub display_name: String,
    pub revision: i64,
    pub disabled: bool,
    pub created_by_internal_user_id: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct McpLocalLaunch {
    pub metadata: SafeMcpLocalServer,
    pub command: String,
    pub args: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Content {
    display_name: String,
    command: String,
    args: Vec<String>,
}

struct Partial {
    id: String,
    workspace_id: String,
    revision: i64,
    disabled: bool,
    created_by_internal_user_id: String,
    created_at: String,
    updated_at: String,
    sealed: crate::store::vault::Sealed,
}

pub fn upsert(
    tx: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    input: McpLocalServerWrite<'_>,
) -> Result<SafeMcpLocalServer> {
    require_scope(tx, scope, ScopeAccess::Write)?;
    let id = crate::store::repos::scope::normalize_id(input.id, "MCP launch reference")?;
    let content = Content {
        display_name: bounded(input.display_name, "MCP server name", DISPLAY_NAME_MAX)?,
        command: bounded(input.command, "MCP executable", COMMAND_MAX)?,
        args: validate_args(input.args)?,
    };
    let existing = tx
        .query_row(
            "SELECT revision FROM mcp_local_server_config
             WHERE workspace_id=?1 AND owner_subject=?2 AND id=?3;",
            rusqlite::params![scope.data.workspace_id(), scope.private.owner_subject(), id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    match (existing, input.expected_revision) {
        (None, None) => {}
        (None, Some(_)) => {
            return Err(StoreError::Invalid(
                "MCP server configuration no longer exists at the expected revision.".into(),
            ))
        }
        (Some(current), Some(expected)) if current == expected => {}
        (Some(_), None) => {
            return Err(StoreError::Invalid(
                "MCP server configuration already exists; its expected revision is required."
                    .into(),
            ))
        }
        _ => {
            return Err(StoreError::Invalid(
                "MCP server configuration changed before it was saved.".into(),
            ))
        }
    }
    if let Some(current) = existing {
        let prior = get_launch(tx, store, scope, &id)?.ok_or_else(|| {
            StoreError::Invalid("MCP server configuration disappeared before save.".into())
        })?;
        if prior.command == content.command
            && prior.args == content.args
            && prior.metadata.display_name == content.display_name
        {
            return Ok(prior.metadata);
        }
        let sealed = seal(store, scope, &id, &content)?;
        let changed = tx.execute(
            "UPDATE mcp_local_server_config
             SET revision=revision+1,updated_at=?1,payload=?2,payload_nonce=?3
             WHERE workspace_id=?4 AND owner_subject=?5 AND id=?6 AND revision=?7;",
            rusqlite::params![
                input.updated_at,
                sealed.ciphertext,
                sealed.nonce,
                scope.data.workspace_id(),
                scope.private.owner_subject(),
                id,
                current
            ],
        )?;
        if changed != 1 {
            return Err(StoreError::Invalid(
                "MCP server configuration changed before it was saved.".into(),
            ));
        }
    } else {
        let sealed = seal(store, scope, &id, &content)?;
        tx.execute(
            "INSERT INTO mcp_local_server_config(
               workspace_id,owner_subject,id,revision,disabled,created_by_internal_user_id,
               created_at,updated_at,payload,payload_nonce)
             VALUES(?1,?2,?3,1,0,?4,?5,?5,?6,?7);",
            rusqlite::params![
                scope.data.workspace_id(),
                scope.private.owner_subject(),
                id,
                scope.internal_user_id,
                input.updated_at,
                sealed.ciphertext,
                sealed.nonce
            ],
        )?;
    }
    get_launch(tx, store, scope, &id)?
        .map(|record| record.metadata)
        .ok_or_else(|| StoreError::Invalid("MCP server configuration could not be read.".into()))
}

pub fn list(
    tx: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
) -> Result<Vec<SafeMcpLocalServer>> {
    require_scope(tx, scope, ScopeAccess::Read)?;
    let mut stmt = tx.prepare(
        "SELECT id,workspace_id,revision,disabled,created_by_internal_user_id,
                created_at,updated_at,payload,payload_nonce
         FROM mcp_local_server_config
         WHERE workspace_id=?1 AND owner_subject=?2
         ORDER BY updated_at DESC,id;",
    )?;
    let rows = stmt
        .query_map(
            rusqlite::params![scope.data.workspace_id(), scope.private.owner_subject()],
            read_partial,
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|row| open(store, scope, row).map(|value| value.metadata))
        .collect()
}

pub(crate) fn get_launch(
    tx: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    id: &str,
) -> Result<Option<McpLocalLaunch>> {
    require_scope(tx, scope, ScopeAccess::Read)?;
    let id = crate::store::repos::scope::normalize_id(id, "MCP launch reference")?;
    tx.query_row(
        "SELECT id,workspace_id,revision,disabled,created_by_internal_user_id,
                created_at,updated_at,payload,payload_nonce
         FROM mcp_local_server_config
         WHERE workspace_id=?1 AND owner_subject=?2 AND id=?3;",
        rusqlite::params![scope.data.workspace_id(), scope.private.owner_subject(), id],
        read_partial,
    )
    .optional()?
    .map(|row| open(store, scope, row))
    .transpose()
}

pub fn set_disabled(
    tx: &Connection,
    scope: &AuthorizedCommandScope,
    id: &str,
    expected_revision: i64,
    disabled: bool,
    updated_at: &str,
) -> Result<()> {
    require_scope(tx, scope, ScopeAccess::Write)?;
    let id = crate::store::repos::scope::normalize_id(id, "MCP launch reference")?;
    let changed = tx.execute(
        "UPDATE mcp_local_server_config SET revision=revision+1,disabled=?1,updated_at=?2
         WHERE workspace_id=?3 AND owner_subject=?4 AND id=?5 AND revision=?6;",
        rusqlite::params![
            i64::from(disabled),
            updated_at,
            scope.data.workspace_id(),
            scope.private.owner_subject(),
            id,
            expected_revision
        ],
    )?;
    if changed != 1 {
        return Err(StoreError::Invalid(
            "MCP server configuration changed before its state was saved.".into(),
        ));
    }
    Ok(())
}

fn require_scope(
    tx: &Connection,
    scope: &AuthorizedCommandScope,
    access: ScopeAccess,
) -> Result<()> {
    crate::store::repos::connection_record::require_current_scope(tx, scope, access)
}

fn seal(
    store: &Store,
    scope: &AuthorizedCommandScope,
    id: &str,
    content: &Content,
) -> Result<crate::store::vault::Sealed> {
    seal_json(
        store,
        &serde_json::to_value(content)
            .map_err(|_| StoreError::Invalid("MCP launch configuration is invalid.".into()))?,
        &aad(scope.data.workspace_id(), scope.private.owner_subject(), id),
    )
}

fn open(store: &Store, scope: &AuthorizedCommandScope, row: Partial) -> Result<McpLocalLaunch> {
    let content: Content = serde_json::from_value(open_json(
        store,
        &row.sealed,
        &aad(&row.workspace_id, scope.private.owner_subject(), &row.id),
    )?)
    .map_err(|_| StoreError::Invalid("MCP launch configuration is invalid.".into()))?;
    Ok(McpLocalLaunch {
        command: content.command,
        args: content.args,
        metadata: SafeMcpLocalServer {
            id: row.id,
            workspace_id: row.workspace_id,
            display_name: content.display_name,
            revision: row.revision,
            disabled: row.disabled,
            created_by_internal_user_id: row.created_by_internal_user_id,
            created_at: row.created_at,
            updated_at: row.updated_at,
        },
    })
}

fn read_partial(row: &rusqlite::Row<'_>) -> rusqlite::Result<Partial> {
    Ok(Partial {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        revision: row.get(2)?,
        disabled: row.get(3)?,
        created_by_internal_user_id: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
        sealed: crate::store::vault::Sealed {
            ciphertext: row.get(7)?,
            nonce: row.get(8)?,
        },
    })
}

fn validate_args(args: &[String]) -> Result<Vec<String>> {
    if args.len() > MAX_ARGS {
        return Err(StoreError::Invalid(format!(
            "MCP launch arguments are limited to {MAX_ARGS} entries."
        )));
    }
    args.iter()
        .map(|value| {
            if value.chars().count() > ARG_MAX || value.chars().any(char::is_control) {
                Err(StoreError::Invalid(format!(
                    "MCP launch arguments are limited to {ARG_MAX} characters without control characters."
                )))
            } else {
                Ok(value.clone())
            }
        })
        .collect()
}

fn bounded(value: &str, label: &str, max: usize) -> Result<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max || value.chars().any(char::is_control) {
        return Err(StoreError::Invalid(format!(
            "{label} must be between 1 and {max} characters without control characters."
        )));
    }
    Ok(value.to_string())
}

fn aad(workspace_id: &str, owner_subject: &str, id: &str) -> String {
    format!("mcp_local_server_config:{workspace_id}:{owner_subject}:{id}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authorized_scope::{resolve, ScopeAccess};
    use crate::store::repos::workspace_directory::{
        select_active_workspace, set_current_internal_user, upsert_authoritative_summary,
        WorkspaceDirectoryUpsert,
    };
    use crate::store::vault::{MasterKey, Vault};

    fn summary(user: &str, workspace: &str, member: &str) -> WorkspaceDirectoryUpsert {
        WorkspaceDirectoryUpsert {
            internal_user_id: user.into(),
            fable_workspace_id: workspace.into(),
            name: workspace.into(),
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
    fn launch_config_is_encrypted_owner_bound_and_revision_checked() {
        let store =
            Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap();
        let scope = store
            .transaction(|tx| {
                let workspace = upsert_authoritative_summary(
                    tx,
                    &summary("user-a", "workspace-a", "member-a"),
                )?;
                set_current_internal_user(tx, "user-a", "t")?;
                select_active_workspace(tx, "user-a", "workspace-a", "t")?;
                resolve(
                    tx,
                    Some(&workspace.local_workspace_id),
                    None,
                    ScopeAccess::Write,
                )
            })
            .unwrap();
        let args = vec!["--stdio".to_string()];
        let created = store
            .transaction(|tx| {
                upsert(
                    tx,
                    &store,
                    &scope,
                    McpLocalServerWrite {
                        id: "filesystem",
                        display_name: "Local files",
                        command: "C:\\tools\\secret-mcp.exe",
                        args: &args,
                        expected_revision: None,
                        updated_at: "2026-07-11T18:00:00Z",
                    },
                )
            })
            .unwrap();
        assert_eq!(created.revision, 1);
        let ciphertext = store
            .with_conn(|tx| {
                tx.query_row("SELECT payload FROM mcp_local_server_config", [], |row| {
                    row.get::<_, Vec<u8>>(0)
                })
                .map_err(Into::into)
            })
            .unwrap();
        assert!(!String::from_utf8_lossy(&ciphertext).contains("secret-mcp"));
        let launch = store
            .with_conn(|tx| get_launch(tx, &store, &scope, "filesystem"))
            .unwrap()
            .unwrap();
        assert_eq!(launch.command, "C:\\tools\\secret-mcp.exe");
        assert!(store
            .transaction(|tx| {
                upsert(
                    tx,
                    &store,
                    &scope,
                    McpLocalServerWrite {
                        id: "filesystem",
                        display_name: "Changed",
                        command: "C:\\tools\\secret-mcp.exe",
                        args: &args,
                        expected_revision: None,
                        updated_at: "later",
                    },
                )
            })
            .is_err());
    }

    #[test]
    fn launch_config_rejects_control_arguments() {
        assert!(validate_args(&["ok\nnot-ok".into()]).is_err());
        assert_eq!(validate_args(&["  exact  ".into()]).unwrap(), ["  exact  "]);
    }
}
