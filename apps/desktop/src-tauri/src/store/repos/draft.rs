//! Composer drafts and resumable draft state. The draft text is user-typed and
//! may contain pasted secrets, so it is always encrypted.

use rusqlite::Connection;
use serde_json::Value;

use crate::store::repos::scope::DataScope;
use crate::store::repos::{open_json, payload_of, seal_json};
use crate::store::{Result, Store};

pub fn upsert_scoped(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    thread_id: Option<&str>,
    id: &str,
    value: &Value,
    updated_at: &str,
) -> Result<()> {
    scope.ensure_exists(tx)?;
    if let Some(thread) = thread_id {
        let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM thread WHERE workspace_id=?1 AND id=?2 AND deleted_at IS NULL)",rusqlite::params![scope.workspace_id(),thread],|r|r.get(0))?;
        if !exists {
            return Err(crate::store::StoreError::Invalid(
                "Thread does not belong to this workspace.".into(),
            ));
        }
    };
    let thread = thread_id.unwrap_or("");
    let sealed = seal_json(
        store,
        value,
        &format!("draft:{}:{}:{}", scope.workspace_id(), thread, id),
    )?;
    tx.execute("INSERT INTO draft (workspace_id,thread_id,id,updated_at,payload,payload_nonce) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(workspace_id,thread_id,id) DO UPDATE SET updated_at=excluded.updated_at,payload=excluded.payload,payload_nonce=excluded.payload_nonce",rusqlite::params![scope.workspace_id(),thread,id,updated_at,sealed.ciphertext,sealed.nonce])?;
    Ok(())
}
pub fn get_scoped(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    thread_id: Option<&str>,
    id: &str,
) -> Result<Option<Value>> {
    scope.ensure_exists(tx)?;
    let thread = thread_id.unwrap_or("");
    let sealed=tx.query_row("SELECT payload,payload_nonce FROM draft WHERE workspace_id=?1 AND thread_id=?2 AND id=?3",rusqlite::params![scope.workspace_id(),thread,id],payload_of).optional()?;
    sealed
        .map(|s| {
            open_json(
                store,
                &s,
                &format!("draft:{}:{}:{}", scope.workspace_id(), thread, id),
            )
        })
        .transpose()
}
pub fn delete_scoped(
    tx: &Connection,
    scope: &DataScope,
    thread_id: Option<&str>,
    id: &str,
) -> Result<()> {
    scope.ensure_exists(tx)?;
    tx.execute(
        "DELETE FROM draft WHERE workspace_id=?1 AND thread_id=?2 AND id=?3",
        rusqlite::params![scope.workspace_id(), thread_id.unwrap_or(""), id],
    )?;
    Ok(())
}

/// Upsert a draft by id (e.g. "composer" or a thread id).
pub fn upsert(
    tx: &Connection,
    store: &Store,
    id: &str,
    value: &Value,
    updated_at: &str,
) -> Result<()> {
    upsert_scoped(
        tx,
        store,
        &DataScope::legacy_default(),
        None,
        id,
        value,
        updated_at,
    )
}

/// Read a draft by id, returning its decrypted payload.
pub fn get(tx: &Connection, store: &Store, id: &str) -> Result<Option<Value>> {
    get_scoped(tx, store, &DataScope::legacy_default(), None, id)
}

/// Delete a draft by id.
pub fn delete(tx: &Connection, id: &str) -> Result<()> {
    delete_scoped(tx, &DataScope::legacy_default(), None, id)
}

use rusqlite::OptionalExtension as _;
