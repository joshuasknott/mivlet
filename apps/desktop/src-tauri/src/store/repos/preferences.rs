//! Shell preferences (key/value, encrypted). Each preference key is a stable,
//! non-secret enum-ish name (e.g. "shell", "memoryDisabled").

use rusqlite::Connection;
use serde_json::Value;

use crate::store::repos::scope::DataScope;
use crate::store::repos::{open_json, payload_of, seal_json};
use crate::store::{Result, Store};

/// Upsert a preference by key.
pub fn upsert(
    tx: &Connection,
    store: &Store,
    key: &str,
    value: &Value,
    updated_at: &str,
) -> Result<()> {
    upsert_scoped(
        tx,
        store,
        &DataScope::legacy_default(),
        key,
        value,
        updated_at,
    )
}

pub fn upsert_scoped(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    key: &str,
    value: &Value,
    updated_at: &str,
) -> Result<()> {
    scope.ensure_exists(tx)?;
    if scope.project_id().is_some() {
        return Err(crate::store::StoreError::Invalid(
            "Settings are workspace-scoped and cannot use a project scope.".into(),
        ));
    }
    let sealed = seal_json(store, value, &aad(scope.workspace_id(), key))?;
    tx.execute(
        "INSERT INTO preferences (workspace_id, key, updated_at, payload, payload_nonce)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(workspace_id, key) DO UPDATE SET
           updated_at=excluded.updated_at,
           payload=excluded.payload, payload_nonce=excluded.payload_nonce;",
        rusqlite::params![
            scope.workspace_id(),
            key,
            updated_at,
            sealed.ciphertext,
            sealed.nonce
        ],
    )?;
    Ok(())
}

/// Read a preference by key.
pub fn get(tx: &Connection, store: &Store, key: &str) -> Result<Option<Value>> {
    get_scoped(tx, store, &DataScope::legacy_default(), key)
}

pub fn get_scoped(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    key: &str,
) -> Result<Option<Value>> {
    scope.ensure_exists(tx)?;
    let sealed = tx
        .query_row(
            "SELECT payload, payload_nonce FROM preferences
             WHERE workspace_id = ?1 AND key = ?2;",
            rusqlite::params![scope.workspace_id(), key],
            payload_of,
        )
        .optional()?;
    match sealed {
        Some(s) => {
            let opened =
                open_json(store, &s, &aad(scope.workspace_id(), key)).or_else(|error| {
                    if scope.workspace_id() == crate::store::repos::scope::DEFAULT_WORKSPACE_ID {
                        // v3 payloads were sealed before workspace ownership was
                        // part of the AAD. Read-only fallback preserves them; the
                        // next write reseals with workspace-bound AAD.
                        open_json(store, &s, &legacy_aad(key))
                    } else {
                        Err(error)
                    }
                })?;
            Ok(Some(opened))
        }
        None => Ok(None),
    }
}

/// List all preference keys (non-secret).
pub fn keys(tx: &Connection) -> Result<Vec<String>> {
    keys_scoped(tx, &DataScope::legacy_default())
}

pub fn keys_scoped(tx: &Connection, scope: &DataScope) -> Result<Vec<String>> {
    scope.ensure_exists(tx)?;
    let mut stmt = tx.prepare("SELECT key FROM preferences WHERE workspace_id=?1 ORDER BY key;")?;
    let rows = stmt.query_map([scope.workspace_id()], |row| row.get::<_, String>(0))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Delete a preference by key.
pub fn delete(tx: &Connection, key: &str) -> Result<()> {
    delete_scoped(tx, &DataScope::legacy_default(), key)
}

pub fn delete_scoped(tx: &Connection, scope: &DataScope, key: &str) -> Result<()> {
    scope.ensure_exists(tx)?;
    tx.execute(
        "DELETE FROM preferences WHERE workspace_id = ?1 AND key = ?2;",
        rusqlite::params![scope.workspace_id(), key],
    )?;
    Ok(())
}

fn aad(workspace_id: &str, key: &str) -> String {
    format!("preferences:{workspace_id}:{key}")
}

fn legacy_aad(key: &str) -> String {
    format!("preferences:{key}")
}

use rusqlite::OptionalExtension as _;
