//! Agent runs. The transcript and error text may carry sensitive content, so
//! they live in the encrypted `payload`; provider/model/status are non-secret
//! catalog enums stored as plaintext columns for indexing.

use rusqlite::Connection;
use serde_json::Value;

use crate::store::repos::{open_json, seal_json};
use crate::store::{Result, Store};

/// Upsert a run. `payload` carries transcript, pending approvals, and error.
#[allow(clippy::too_many_arguments)]
pub fn upsert(
    tx: &Connection,
    store: &Store,
    id: &str,
    thread_id: Option<&str>,
    provider_id: &str,
    model: &str,
    status: &str,
    turn: usize,
    recoverable: bool,
    retry_count: usize,
    created_at: &str,
    updated_at: &str,
    payload: &Value,
) -> Result<()> {
    let sealed = seal_json(store, payload, &aad(id))?;
    tx.execute(
        "INSERT INTO run (id, thread_id, provider_id, model, status, turn, recoverable,
                          retry_count, created_at, updated_at, payload, payload_nonce)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(id) DO UPDATE SET
           thread_id=excluded.thread_id, provider_id=excluded.provider_id,
           model=excluded.model, status=excluded.status, turn=excluded.turn,
           recoverable=excluded.recoverable, retry_count=excluded.retry_count,
           updated_at=excluded.updated_at,
           payload=excluded.payload, payload_nonce=excluded.payload_nonce;",
        rusqlite::params![
            id,
            thread_id,
            provider_id,
            model,
            status,
            turn as i64,
            recoverable as i64,
            retry_count as i64,
            created_at,
            updated_at,
            sealed.ciphertext,
            sealed.nonce,
        ],
    )?;
    Ok(())
}

/// Read a run's metadata + decrypted payload.
pub struct RunRow {
    pub id: String,
    pub thread_id: Option<String>,
    pub provider_id: String,
    pub model: String,
    pub status: String,
    pub turn: i64,
    pub recoverable: bool,
    pub retry_count: i64,
    pub created_at: String,
    pub updated_at: String,
    pub payload: Value,
}

pub fn get(tx: &Connection, store: &Store, id: &str) -> Result<Option<RunRow>> {
    let row = tx
        .query_row(
            "SELECT id, thread_id, provider_id, model, status, turn, recoverable,
                    retry_count, created_at, updated_at, payload, payload_nonce
             FROM run WHERE id = ?1;",
            rusqlite::params![id],
            |row| {
                Ok(RunPartial {
                    id: row.get(0)?,
                    thread_id: row.get(1)?,
                    provider_id: row.get(2)?,
                    model: row.get(3)?,
                    status: row.get(4)?,
                    turn: row.get(5)?,
                    recoverable: row.get::<_, i64>(6)? != 0,
                    retry_count: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                    sealed: Sealed {
                        ciphertext: row.get::<_, Vec<u8>>(10)?,
                        nonce: row.get::<_, Vec<u8>>(11)?,
                    },
                })
            },
        )
        .optional()?;
    match row {
        None => Ok(None),
        Some(p) => {
            let payload = open_json(store, &p.sealed, &aad(&p.id))?;
            Ok(Some(RunRow {
                id: p.id,
                thread_id: p.thread_id,
                provider_id: p.provider_id,
                model: p.model,
                status: p.status,
                turn: p.turn,
                recoverable: p.recoverable,
                retry_count: p.retry_count,
                created_at: p.created_at,
                updated_at: p.updated_at,
                payload,
            }))
        }
    }
}

/// Internal partial read carrying the still-sealed payload.
struct RunPartial {
    id: String,
    thread_id: Option<String>,
    provider_id: String,
    model: String,
    status: String,
    turn: i64,
    recoverable: bool,
    retry_count: i64,
    created_at: String,
    updated_at: String,
    sealed: Sealed,
}

use crate::store::vault::Sealed;

/// List runs by status (e.g. recover interrupted runs).
pub fn list_by_status(tx: &Connection, statuses: &[&str]) -> Result<Vec<String>> {
    if statuses.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = statuses.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!("SELECT id FROM run WHERE status IN ({placeholders}) ORDER BY created_at;");
    let mut stmt = tx.prepare(&sql)?;
    let params = rusqlite::params_from_iter(statuses.iter());
    let rows = stmt.query_map(params, |row| row.get::<_, String>(0))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Delete a run (cascades to tool_calls, approvals, artifacts).
pub fn delete(tx: &Connection, id: &str) -> Result<()> {
    tx.execute("DELETE FROM run WHERE id = ?1;", rusqlite::params![id])?;
    Ok(())
}

fn aad(id: &str) -> String {
    format!("run:{id}")
}

use rusqlite::OptionalExtension as _;
