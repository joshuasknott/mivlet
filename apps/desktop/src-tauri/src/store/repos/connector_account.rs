//! Connector accounts — non-secret connection metadata only. The OAuth token
//! stays in OS secure storage under `com.fable.workspace.connectors`; this
//! table holds `credential_ref` (an opaque key into the keyring) and **never**
//! the token itself. Account identity, scopes, and health are encrypted in the
//! payload (they are user-data, not secrets, but kept confidential at rest).

use rusqlite::Connection;
use serde_json::Value;

use crate::store::repos::scope::DataScope;
use crate::store::repos::{open_json, seal_json};
use crate::store::{Result, Store, StoreError};

/// Upsert a connector account from a legacy `ConnectorConnection` JSON value.
pub fn upsert_from_value(tx: &Connection, store: &Store, value: Value, now: &str) -> Result<()> {
    upsert_from_value_scoped(tx, store, &DataScope::legacy_default(), value, now)
}

pub fn upsert_from_value_scoped(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    value: Value,
    now: &str,
) -> Result<()> {
    scope.ensure_exists(tx)?;
    if scope.project_id().is_some() {
        return Err(StoreError::Invalid(
            "Connector accounts are workspace-scoped and cannot use a project scope.".into(),
        ));
    }
    let connector_id = value
        .get("connectorId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            StoreError::Invalid("Connector connection is missing a connectorId.".into())
        })?
        .to_string();
    let account_id = value
        .get("accountId")
        .or_else(|| value.get("account").and_then(|a| a.get("id")))
        .and_then(Value::as_str)
        .map(str::to_string);
    let status = value
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("connected")
        .to_string();
    let expires_at = value
        .get("expiresAt")
        .and_then(Value::as_u64)
        .map(|v| v as i64);
    // credential_ref MUST point into the keyring, never contain a token.
    let credential_ref = value
        .get("credentialRef")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if credential_ref.len() > 256
        || (!credential_ref.is_empty() && !credential_ref.starts_with("oauth-token:"))
    {
        return Err(StoreError::Invalid(
            "Connector credential reference is not a valid keyring reference.".into(),
        ));
    }
    let ref_owned_elsewhere: bool = if credential_ref.is_empty() {
        false
    } else {
        tx.query_row(
            "SELECT EXISTS(
               SELECT 1 FROM connector_account
               WHERE credential_ref=?1 AND workspace_id<>?2
             );",
            rusqlite::params![credential_ref, scope.workspace_id()],
            |row| row.get(0),
        )?
    };
    if ref_owned_elsewhere {
        return Err(StoreError::Invalid(
            "Connector credential reference is already owned by another workspace.".into(),
        ));
    }
    let connected_at = value
        .get("connectedAt")
        .and_then(Value::as_str)
        .unwrap_or(now)
        .to_string();
    let updated_at = value
        .get("updatedAt")
        .and_then(Value::as_str)
        .unwrap_or(now)
        .to_string();
    let payload = serde_json::json!({
        "account": value.get("account").cloned().unwrap_or(Value::Null),
        "scopes": value.get("scopes").cloned().unwrap_or(Value::Array(vec![])),
        "health": value.get("health").cloned().unwrap_or(Value::Null),
    });
    let sealed = seal_json(store, &payload, &aad(scope.workspace_id(), &connector_id))?;
    tx.execute(
        "INSERT INTO connector_account (workspace_id, project_id, connector_id, account_id,
              status, expires_at, credential_ref, connected_at, updated_at, payload, payload_nonce)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(workspace_id, connector_id) DO UPDATE SET
           account_id=excluded.account_id, status=excluded.status,
           expires_at=excluded.expires_at, credential_ref=excluded.credential_ref,
           updated_at=excluded.updated_at,
           payload=excluded.payload, payload_nonce=excluded.payload_nonce;",
        rusqlite::params![
            scope.workspace_id(),
            scope.project_id(),
            connector_id,
            account_id,
            status,
            expires_at,
            credential_ref,
            connected_at,
            updated_at,
            sealed.ciphertext,
            sealed.nonce,
        ],
    )?;
    Ok(())
}

pub struct ConnectorAccountRow {
    pub workspace_id: String,
    pub project_id: Option<String>,
    pub connector_id: String,
    pub account_id: Option<String>,
    pub status: String,
    pub expires_at: Option<i64>,
    pub credential_ref: String,
    pub connected_at: String,
    pub updated_at: String,
    pub payload: Value,
}

pub fn list(tx: &Connection, store: &Store) -> Result<Vec<ConnectorAccountRow>> {
    list_scoped(tx, store, &DataScope::legacy_default())
}

pub fn list_scoped(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
) -> Result<Vec<ConnectorAccountRow>> {
    scope.ensure_exists(tx)?;
    let mut stmt = tx.prepare(
        "SELECT workspace_id, project_id, connector_id, account_id, status, expires_at, credential_ref,
                connected_at, updated_at, payload, payload_nonce
         FROM connector_account
         WHERE workspace_id=?1 AND project_id IS ?2
         ORDER BY connector_id;",
    )?;
    let partials: Vec<Partial> = stmt
        .query_map(
            rusqlite::params![scope.workspace_id(), scope.project_id()],
            |row| {
                Ok(Partial {
                    workspace_id: row.get(0)?,
                    project_id: row.get(1)?,
                    connector_id: row.get(2)?,
                    account_id: row.get(3)?,
                    status: row.get(4)?,
                    expires_at: row.get(5)?,
                    credential_ref: row.get(6)?,
                    connected_at: row.get(7)?,
                    updated_at: row.get(8)?,
                    sealed: Sealed {
                        ciphertext: row.get(9)?,
                        nonce: row.get(10)?,
                    },
                })
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut out = Vec::with_capacity(partials.len());
    for p in partials {
        let payload = open_json(store, &p.sealed, &aad(&p.workspace_id, &p.connector_id)).or_else(
            |error| {
                if p.workspace_id == crate::store::repos::scope::DEFAULT_WORKSPACE_ID {
                    open_json(store, &p.sealed, &legacy_aad(&p.connector_id))
                } else {
                    Err(error)
                }
            },
        )?;
        out.push(ConnectorAccountRow {
            workspace_id: p.workspace_id,
            project_id: p.project_id,
            connector_id: p.connector_id,
            account_id: p.account_id,
            status: p.status,
            expires_at: p.expires_at,
            credential_ref: p.credential_ref,
            connected_at: p.connected_at,
            updated_at: p.updated_at,
            payload,
        });
    }
    Ok(out)
}

/// Delete a connector account by connector id. (The caller is responsible for
/// revoking/removing the keyring token separately.)
pub fn delete(tx: &Connection, connector_id: &str) -> Result<()> {
    delete_scoped(tx, &DataScope::legacy_default(), connector_id)
}

pub fn delete_scoped(tx: &Connection, scope: &DataScope, connector_id: &str) -> Result<()> {
    scope.ensure_exists(tx)?;
    tx.execute(
        "DELETE FROM connector_account
         WHERE workspace_id = ?1 AND project_id IS ?2 AND connector_id = ?3;",
        rusqlite::params![scope.workspace_id(), scope.project_id(), connector_id],
    )?;
    Ok(())
}

struct Partial {
    workspace_id: String,
    project_id: Option<String>,
    connector_id: String,
    account_id: Option<String>,
    status: String,
    expires_at: Option<i64>,
    credential_ref: String,
    connected_at: String,
    updated_at: String,
    sealed: Sealed,
}

use crate::store::vault::Sealed;

fn aad(workspace_id: &str, connector_id: &str) -> String {
    format!("connector_account:{workspace_id}:{connector_id}")
}

fn legacy_aad(connector_id: &str) -> String {
    format!("connector_account:{connector_id}")
}
