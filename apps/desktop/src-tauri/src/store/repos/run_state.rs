//! Resumable run state (a snapshot of in-flight run state for recovery).

use rusqlite::Connection;
use serde_json::Value;

use crate::store::repos::{open_json, payload_of, seal_json};
use crate::store::{Result, Store};

pub fn upsert(
    tx: &Connection,
    store: &Store,
    id: &str,
    value: &Value,
    updated_at: &str,
) -> Result<()> {
    let sealed = seal_json(store, value, &aad(id))?;
    tx.execute(
        "INSERT INTO run_state (id, payload, payload_nonce, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET
           payload=excluded.payload, payload_nonce=excluded.payload_nonce,
           updated_at=excluded.updated_at;",
        rusqlite::params![id, sealed.ciphertext, sealed.nonce, updated_at],
    )?;
    Ok(())
}

pub fn get(tx: &Connection, store: &Store, id: &str) -> Result<Option<Value>> {
    let sealed = tx
        .query_row(
            "SELECT payload, payload_nonce FROM run_state WHERE id = ?1;",
            rusqlite::params![id],
            payload_of,
        )
        .optional()?;
    match sealed {
        Some(s) => Ok(Some(open_json(store, &s, &aad(id))?)),
        None => Ok(None),
    }
}

pub fn delete(tx: &Connection, id: &str) -> Result<()> {
    tx.execute(
        "DELETE FROM run_state WHERE id = ?1;",
        rusqlite::params![id],
    )?;
    Ok(())
}

fn aad(id: &str) -> String {
    format!("run_state:{id}")
}

use rusqlite::OptionalExtension as _;
