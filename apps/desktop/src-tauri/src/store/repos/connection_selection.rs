//! Authenticated canonical active-Connection selection.

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;

use crate::authorized_scope::{AuthorizedCommandScope, ScopeAccess};
use crate::store::{Result, Store, StoreError};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSelection {
    pub workspace_id: String,
    pub connector_definition_key: String,
    pub connection_id: String,
    pub revision: i64,
    pub updated_at: String,
}

pub fn get(
    tx: &Connection,
    scope: &AuthorizedCommandScope,
    connector_definition_key: &str,
) -> Result<Option<ConnectionSelection>> {
    crate::store::repos::connection_record::require_current_scope(tx, scope, ScopeAccess::Read)?;
    tx.query_row(
        "SELECT workspace_id,connector_definition_key,connection_id,revision,updated_at
         FROM connection_selection WHERE workspace_id=?1 AND connector_definition_key=?2;",
        rusqlite::params![scope.data.workspace_id(), connector_definition_key],
        |row| {
            Ok(ConnectionSelection {
                workspace_id: row.get(0)?,
                connector_definition_key: row.get(1)?,
                connection_id: row.get(2)?,
                revision: row.get(3)?,
                updated_at: row.get(4)?,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

pub fn select(
    tx: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    connector_definition_key: &str,
    connection_id: &str,
    expected_revision: Option<i64>,
    updated_at: &str,
) -> Result<ConnectionSelection> {
    crate::store::repos::connection_record::require_current_scope(tx, scope, ScopeAccess::Write)?;
    let record = crate::store::repos::connection_record::get(tx, store, scope, connection_id)?
        .ok_or_else(|| StoreError::Invalid("Selected Connection is unavailable.".into()))?;
    if record.connector_definition_key != connector_definition_key
        || record.lifecycle != "authorized"
        || record.authorization_state != "authorized"
        || record.credential_state != "available"
    {
        return Err(StoreError::Invalid(
            "Selected Connection is not authorized for use.".into(),
        ));
    }
    let existing = get(tx, scope, connector_definition_key)?;
    match (&existing, expected_revision) {
        (None, None) => {
            tx.execute(
                "INSERT INTO connection_selection
                   (workspace_id,connector_definition_key,connection_id,revision,
                    selected_by_internal_user_id,updated_at)
                 VALUES(?1,?2,?3,1,?4,?5);",
                rusqlite::params![
                    scope.data.workspace_id(),
                    connector_definition_key,
                    connection_id,
                    scope.internal_user_id,
                    updated_at,
                ],
            )?;
        }
        (Some(current), Some(expected)) if current.revision == expected => {
            if current.connection_id == connection_id {
                return Ok(current.clone());
            }
            let changed = tx.execute(
                "UPDATE connection_selection SET connection_id=?1,revision=revision+1,
                   selected_by_internal_user_id=?2,updated_at=?3
                 WHERE workspace_id=?4 AND connector_definition_key=?5 AND revision=?6;",
                rusqlite::params![
                    connection_id,
                    scope.internal_user_id,
                    updated_at,
                    scope.data.workspace_id(),
                    connector_definition_key,
                    expected,
                ],
            )?;
            if changed != 1 {
                return Err(StoreError::Invalid(
                    "Active Connection changed before selection was saved.".into(),
                ));
            }
        }
        (None, Some(_)) => {
            return Err(StoreError::Invalid(
                "Active Connection no longer exists at the expected revision.".into(),
            ));
        }
        (Some(_), None) => {
            return Err(StoreError::Invalid(
                "Active Connection already exists; its expected revision is required.".into(),
            ));
        }
        _ => {
            return Err(StoreError::Invalid(
                "Active Connection changed before selection was saved.".into(),
            ));
        }
    }
    get(tx, scope, connector_definition_key)?.ok_or_else(|| {
        StoreError::Invalid("Active Connection could not be read after it was saved.".into())
    })
}

pub fn clear(
    tx: &Connection,
    scope: &AuthorizedCommandScope,
    connector_definition_key: &str,
    expected_revision: i64,
) -> Result<()> {
    crate::store::repos::connection_record::require_current_scope(tx, scope, ScopeAccess::Write)?;
    let changed = tx.execute(
        "DELETE FROM connection_selection
         WHERE workspace_id=?1 AND connector_definition_key=?2 AND revision=?3;",
        rusqlite::params![
            scope.data.workspace_id(),
            connector_definition_key,
            expected_revision,
        ],
    )?;
    if changed != 1 {
        return Err(StoreError::Invalid(
            "Active Connection changed before it was cleared.".into(),
        ));
    }
    Ok(())
}
