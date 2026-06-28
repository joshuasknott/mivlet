//! Composer drafts and resumable draft state. The draft text is user-typed and
//! may contain pasted secrets, so it is always encrypted.

use rusqlite::Connection;
use serde_json::Value;

use crate::store::repos::{open_json, payload_of, seal_json};
use crate::store::{Result, Store};

/// Upsert a draft by id (e.g. "composer" or a thread id).
pub fn upsert(
    tx: &Connection,
    store: &Store,
    id: &str,
    value: &Value,
    updated_at: &str,
) -> Result<()> {
    let sealed = seal_json(store, value, &aad(id))?;
    tx.execute(
        "INSERT INTO draft (id, updated_at, payload, payload_nonce)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET
           updated_at=excluded.updated_at,
           payload=excluded.payload, payload_nonce=excluded.payload_nonce;",
        rusqlite::params![id, updated_at, sealed.ciphertext, sealed.nonce],
    )?;
    Ok(())
}

/// Read a draft by id, returning its decrypted payload.
pub fn get(tx: &Connection, store: &Store, id: &str) -> Result<Option<Value>> {
    let sealed = tx
        .query_row(
            "SELECT payload, payload_nonce FROM draft WHERE id = ?1;",
            rusqlite::params![id],
            payload_of,
        )
        .optional()?;
    match sealed {
        Some(s) => Ok(Some(open_json(store, &s, &aad(id))?)),
        None => Ok(None),
    }
}

/// Delete a draft by id.
pub fn delete(tx: &Connection, id: &str) -> Result<()> {
    tx.execute("DELETE FROM draft WHERE id = ?1;", rusqlite::params![id])?;
    Ok(())
}

fn aad(id: &str) -> String {
    format!("draft:{id}")
}

use rusqlite::OptionalExtension as _;
