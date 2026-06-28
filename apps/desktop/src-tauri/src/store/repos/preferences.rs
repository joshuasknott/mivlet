//! Shell preferences (key/value, encrypted). Each preference key is a stable,
//! non-secret enum-ish name (e.g. "shell", "memoryDisabled").

use rusqlite::Connection;
use serde_json::Value;

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
    let sealed = seal_json(store, value, &aad(key))?;
    tx.execute(
        "INSERT INTO preferences (key, updated_at, payload, payload_nonce)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(key) DO UPDATE SET
           updated_at=excluded.updated_at,
           payload=excluded.payload, payload_nonce=excluded.payload_nonce;",
        rusqlite::params![key, updated_at, sealed.ciphertext, sealed.nonce],
    )?;
    Ok(())
}

/// Read a preference by key.
pub fn get(tx: &Connection, store: &Store, key: &str) -> Result<Option<Value>> {
    let sealed = tx
        .query_row(
            "SELECT payload, payload_nonce FROM preferences WHERE key = ?1;",
            rusqlite::params![key],
            payload_of,
        )
        .optional()?;
    match sealed {
        Some(s) => Ok(Some(open_json(store, &s, &aad(key))?)),
        None => Ok(None),
    }
}

/// List all preference keys (non-secret).
pub fn keys(tx: &Connection) -> Result<Vec<String>> {
    let mut stmt = tx.prepare("SELECT key FROM preferences ORDER BY key;")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Delete a preference by key.
pub fn delete(tx: &Connection, key: &str) -> Result<()> {
    tx.execute(
        "DELETE FROM preferences WHERE key = ?1;",
        rusqlite::params![key],
    )?;
    Ok(())
}

fn aad(key: &str) -> String {
    format!("preferences:{key}")
}

use rusqlite::OptionalExtension as _;
