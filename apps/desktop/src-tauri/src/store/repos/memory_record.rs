//! Memory records. `kind`/`pinned`/`approved` are non-secret query columns;
//! `title`, `value`, `source`, `freshness` are encrypted in the payload.

use rusqlite::Connection;
use serde_json::Value;

use crate::models::MEMORY_KINDS;
use crate::store::repos::{open_json, seal_json};
use crate::store::{Result, Store, StoreError};

/// Upsert from a legacy `MemoryRecord` JSON value.
pub fn upsert_from_value(tx: &Connection, store: &Store, value: Value, now: &str) -> Result<()> {
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| StoreError::Invalid("Memory record is missing an id.".into()))?
        .to_string();
    let kind = value
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("imported")
        .to_string();
    if !MEMORY_KINDS.contains(&kind.as_str()) {
        return Err(StoreError::Invalid(format!(
            "Memory kind '{kind}' is not recognized."
        )));
    }
    let pinned = value
        .get("pinned")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let approved = value
        .get("approved")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let created_at = value
        .get("createdAt")
        .and_then(Value::as_str)
        .unwrap_or(now)
        .to_string();
    let payload = serde_json::json!({
        "title": value.get("title").and_then(Value::as_str).unwrap_or(""),
        "value": value.get("value").and_then(Value::as_str).unwrap_or(""),
        "source": value.get("source").and_then(Value::as_str).unwrap_or(""),
        "freshness": value.get("freshness").and_then(Value::as_str).unwrap_or(""),
    });
    let sealed = seal_json(store, &payload, &aad(&id))?;
    tx.execute(
        "INSERT INTO memory_record (id, kind, pinned, approved, created_at, payload, payload_nonce)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET
           kind=excluded.kind, pinned=excluded.pinned, approved=excluded.approved,
           payload=excluded.payload, payload_nonce=excluded.payload_nonce;",
        rusqlite::params![
            id,
            kind,
            pinned as i64,
            approved as i64,
            created_at,
            sealed.ciphertext,
            sealed.nonce
        ],
    )?;
    Ok(())
}

pub struct MemoryRow {
    pub id: String,
    pub kind: String,
    pub pinned: bool,
    pub approved: bool,
    pub created_at: String,
    pub payload: Value,
}

pub fn list(tx: &Connection, store: &Store) -> Result<Vec<MemoryRow>> {
    let mut stmt = tx.prepare(
        "SELECT id, kind, pinned, approved, created_at, payload, payload_nonce
         FROM memory_record ORDER BY created_at;",
    )?;
    let partials: Vec<Partial> = stmt
        .query_map([], |row| {
            Ok(Partial {
                id: row.get(0)?,
                kind: row.get(1)?,
                pinned: row.get::<_, i64>(2)? != 0,
                approved: row.get::<_, i64>(3)? != 0,
                created_at: row.get(4)?,
                sealed: Sealed {
                    ciphertext: row.get(5)?,
                    nonce: row.get(6)?,
                },
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut out = Vec::with_capacity(partials.len());
    for p in partials {
        let payload = open_json(store, &p.sealed, &aad(&p.id))?;
        out.push(MemoryRow {
            id: p.id,
            kind: p.kind,
            pinned: p.pinned,
            approved: p.approved,
            created_at: p.created_at,
            payload,
        });
    }
    Ok(out)
}

/// Delete a memory record by id.
pub fn delete(tx: &Connection, id: &str) -> Result<()> {
    tx.execute(
        "DELETE FROM memory_record WHERE id = ?1;",
        rusqlite::params![id],
    )?;
    Ok(())
}

struct Partial {
    id: String,
    kind: String,
    pinned: bool,
    approved: bool,
    created_at: String,
    sealed: Sealed,
}

use crate::store::vault::Sealed;

fn aad(id: &str) -> String {
    format!("memory_record:{id}")
}
