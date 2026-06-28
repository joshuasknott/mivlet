//! Connector accounts — non-secret connection metadata only. The OAuth token
//! stays in OS secure storage under `com.fable.workspace.connectors`; this
//! table holds `credential_ref` (an opaque key into the keyring) and **never**
//! the token itself. Account identity, scopes, and health are encrypted in the
//! payload (they are user-data, not secrets, but kept confidential at rest).

use rusqlite::Connection;
use serde_json::Value;

use crate::store::repos::{open_json, seal_json};
use crate::store::{Result, Store, StoreError};

/// Upsert a connector account from a legacy `ConnectorConnection` JSON value.
pub fn upsert_from_value(tx: &Connection, store: &Store, value: Value, now: &str) -> Result<()> {
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
    let sealed = seal_json(store, &payload, &aad(&connector_id))?;
    tx.execute(
        "INSERT INTO connector_account (connector_id, account_id, status, expires_at,
              credential_ref, connected_at, updated_at, payload, payload_nonce)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(connector_id) DO UPDATE SET
           account_id=excluded.account_id, status=excluded.status,
           expires_at=excluded.expires_at, credential_ref=excluded.credential_ref,
           updated_at=excluded.updated_at,
           payload=excluded.payload, payload_nonce=excluded.payload_nonce;",
        rusqlite::params![
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
    let mut stmt = tx.prepare(
        "SELECT connector_id, account_id, status, expires_at, credential_ref,
                connected_at, updated_at, payload, payload_nonce
         FROM connector_account ORDER BY connector_id;",
    )?;
    let partials: Vec<Partial> = stmt
        .query_map([], |row| {
            Ok(Partial {
                connector_id: row.get(0)?,
                account_id: row.get(1)?,
                status: row.get(2)?,
                expires_at: row.get(3)?,
                credential_ref: row.get(4)?,
                connected_at: row.get(5)?,
                updated_at: row.get(6)?,
                sealed: Sealed {
                    ciphertext: row.get(7)?,
                    nonce: row.get(8)?,
                },
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut out = Vec::with_capacity(partials.len());
    for p in partials {
        let payload = open_json(store, &p.sealed, &aad(&p.connector_id))?;
        out.push(ConnectorAccountRow {
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
    tx.execute(
        "DELETE FROM connector_account WHERE connector_id = ?1;",
        rusqlite::params![connector_id],
    )?;
    Ok(())
}

struct Partial {
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

fn aad(connector_id: &str) -> String {
    format!("connector_account:{connector_id}")
}
