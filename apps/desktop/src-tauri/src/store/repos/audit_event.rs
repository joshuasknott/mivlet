//! Audit events (approval decisions, connector actions, backend events). The
//! event detail (note, consequence, data used) is encrypted; `kind`/`actor`/
//! `created_at` are non-secret query columns.

use rusqlite::Connection;
use serde_json::Value;

use crate::store::repos::{open_json, seal_json};
use crate::store::{Result, Store, StoreError};

/// Upsert an audit event from a legacy JSON value. `kind` defaults to "approval".
pub fn upsert_from_value(
    tx: &Connection,
    store: &Store,
    kind: &str,
    value: Value,
    now: &str,
) -> Result<()> {
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| StoreError::Invalid("Audit event is missing an id.".into()))?
        .to_string();
    let actor = value
        .get("actor")
        .and_then(Value::as_str)
        .unwrap_or("user")
        .to_string();
    let created_at = value
        .get("decidedAt")
        .or_else(|| value.get("createdAt"))
        .and_then(Value::as_str)
        .unwrap_or(now)
        .to_string();
    // The whole legacy entry (minus the id used for AAD) becomes the payload so
    // nothing is silently dropped. No secret-named fields exist in these shapes.
    let sealed = seal_json(store, &value, &aad(&id))?;
    tx.execute(
        "INSERT INTO audit_event (id, kind, actor, created_at, payload, payload_nonce)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET
           kind=excluded.kind, actor=excluded.actor,
           payload=excluded.payload, payload_nonce=excluded.payload_nonce;",
        rusqlite::params![id, kind, actor, created_at, sealed.ciphertext, sealed.nonce],
    )?;
    Ok(())
}

pub struct AuditRow {
    pub id: String,
    pub kind: String,
    pub actor: String,
    pub created_at: String,
    pub payload: Value,
}

pub fn list(tx: &Connection, store: &Store, limit: i64) -> Result<Vec<AuditRow>> {
    let mut stmt = tx.prepare(
        "SELECT id, kind, actor, created_at, payload, payload_nonce
         FROM audit_event ORDER BY created_at DESC LIMIT ?1;",
    )?;
    let partials: Vec<Partial> = stmt
        .query_map(rusqlite::params![limit], |row| {
            Ok(Partial {
                id: row.get(0)?,
                kind: row.get(1)?,
                actor: row.get(2)?,
                created_at: row.get(3)?,
                sealed: Sealed {
                    ciphertext: row.get(4)?,
                    nonce: row.get(5)?,
                },
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut out = Vec::with_capacity(partials.len());
    for p in partials {
        let payload = open_json(store, &p.sealed, &aad(&p.id))?;
        out.push(AuditRow {
            id: p.id,
            kind: p.kind,
            actor: p.actor,
            created_at: p.created_at,
            payload,
        });
    }
    Ok(out)
}

pub fn delete(tx: &Connection, id: &str) -> Result<()> {
    tx.execute(
        "DELETE FROM audit_event WHERE id = ?1;",
        rusqlite::params![id],
    )?;
    Ok(())
}

struct Partial {
    id: String,
    kind: String,
    actor: String,
    created_at: String,
    sealed: Sealed,
}

use crate::store::vault::Sealed;

fn aad(id: &str) -> String {
    format!("audit_event:{id}")
}
