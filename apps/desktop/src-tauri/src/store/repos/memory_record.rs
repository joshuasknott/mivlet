//! Memory records. `kind`/`pinned`/`approved` are non-secret query columns;
//! `title`, `value`, `source`, `freshness` are encrypted in the payload.

use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;

use crate::models::MEMORY_KINDS;
use crate::store::repos::scope::{ensure_record_owner, DataScope};
use crate::store::repos::{open_json, seal_json};
use crate::store::{Result, Store, StoreError};

/// Upsert from a legacy `MemoryRecord` JSON value.
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
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| StoreError::Invalid("Memory record is missing an id.".into()))?
        .to_string();
    ensure_record_owner(tx, "memory_record", &id, scope)?;
    let tombstoned: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM memory_tombstone WHERE workspace_id=?1 AND id=?2);",
        rusqlite::params![scope.workspace_id(), id],
        |row| row.get(0),
    )?;
    if tombstoned {
        return Err(StoreError::Invalid(
            "Forgotten memory cannot be restored by a routine write.".into(),
        ));
    }
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
    let disabled = value
        .get("disabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let forgotten_at = value.get("forgottenAt").and_then(Value::as_str);
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
        "provenance": value.get("provenance").cloned().unwrap_or(Value::Null),
        "scope": value.get("scope").cloned().unwrap_or(Value::Null),
        "approvalState": value.get("approvalState").and_then(Value::as_str).unwrap_or(""),
        "runId": value.get("runId").and_then(Value::as_str).unwrap_or(""),
        "updatedAt": value.get("updatedAt").and_then(Value::as_str).unwrap_or(now),
    });
    let sealed = seal_json(store, &payload, &aad(scope.workspace_id(), &id))?;
    tx.execute(
        "INSERT INTO memory_record (
           workspace_id, id, project_id, kind, pinned, approved, disabled, forgotten_at,
           created_at, payload, payload_nonce
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(workspace_id, id) DO UPDATE SET
           kind=excluded.kind, pinned=excluded.pinned, approved=excluded.approved,
           disabled=excluded.disabled,
           forgotten_at=COALESCE(memory_record.forgotten_at, excluded.forgotten_at),
           payload=excluded.payload, payload_nonce=excluded.payload_nonce;",
        rusqlite::params![
            scope.workspace_id(),
            id,
            scope.project_id(),
            kind,
            pinned as i64,
            approved as i64,
            disabled as i64,
            forgotten_at,
            created_at,
            sealed.ciphertext,
            sealed.nonce
        ],
    )?;
    Ok(())
}

pub struct MemoryRow {
    pub id: String,
    pub workspace_id: String,
    pub project_id: Option<String>,
    pub kind: String,
    pub pinned: bool,
    pub approved: bool,
    pub disabled: bool,
    pub forgotten_at: Option<String>,
    pub created_at: String,
    pub payload: Value,
}

pub fn list(tx: &Connection, store: &Store) -> Result<Vec<MemoryRow>> {
    list_scoped(tx, store, &DataScope::legacy_default())
}

pub fn list_scoped(tx: &Connection, store: &Store, scope: &DataScope) -> Result<Vec<MemoryRow>> {
    scope.ensure_exists(tx)?;
    let mut stmt = tx.prepare(
        "SELECT id, workspace_id, project_id, kind, pinned, approved, disabled, forgotten_at,
                created_at, payload, payload_nonce
         FROM memory_record
         WHERE workspace_id=?1 AND project_id IS ?2 AND disabled=0 AND forgotten_at IS NULL
         ORDER BY created_at;",
    )?;
    let partials: Vec<Partial> = stmt
        .query_map(
            rusqlite::params![scope.workspace_id(), scope.project_id()],
            |row| {
                Ok(Partial {
                    id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    project_id: row.get(2)?,
                    kind: row.get(3)?,
                    pinned: row.get::<_, i64>(4)? != 0,
                    approved: row.get::<_, i64>(5)? != 0,
                    disabled: row.get::<_, i64>(6)? != 0,
                    forgotten_at: row.get(7)?,
                    created_at: row.get(8)?,
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
        let payload =
            open_json(store, &p.sealed, &aad(&p.workspace_id, &p.id)).or_else(|error| {
                if p.workspace_id == crate::store::repos::scope::DEFAULT_WORKSPACE_ID {
                    open_json(store, &p.sealed, &legacy_aad(&p.id))
                } else {
                    Err(error)
                }
            })?;
        out.push(MemoryRow {
            id: p.id,
            workspace_id: p.workspace_id,
            project_id: p.project_id,
            kind: p.kind,
            pinned: p.pinned,
            approved: p.approved,
            disabled: p.disabled,
            forgotten_at: p.forgotten_at,
            created_at: p.created_at,
            payload,
        });
    }
    Ok(out)
}

/// Delete a memory record by id.
pub fn delete(tx: &Connection, id: &str) -> Result<()> {
    delete_scoped(tx, &DataScope::legacy_default(), id)
}

pub fn delete_scoped(tx: &Connection, scope: &DataScope, id: &str) -> Result<()> {
    scope.ensure_exists(tx)?;
    let exists = tx
        .query_row(
            "SELECT 1 FROM memory_record WHERE workspace_id=?1 AND id=?2 AND project_id IS ?3;",
            rusqlite::params![scope.workspace_id(), id, scope.project_id()],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !exists {
        return Ok(());
    }
    tx.execute(
        "INSERT OR REPLACE INTO memory_tombstone (workspace_id, id, forgotten_at) VALUES (?1, ?2, ?3);",
        rusqlite::params![scope.workspace_id(), id, unix_timestamp()],
    )?;
    tx.execute(
        "DELETE FROM memory_record
         WHERE id = ?1 AND workspace_id = ?2 AND project_id IS ?3;",
        rusqlite::params![id, scope.workspace_id(), scope.project_id()],
    )?;
    Ok(())
}

pub fn forget_scoped(
    tx: &Connection,
    scope: &DataScope,
    id: &str,
    forgotten_at: &str,
) -> Result<bool> {
    scope.ensure_exists(tx)?;
    let updated = tx.execute(
        "UPDATE memory_record SET forgotten_at=?1, pinned=0
         WHERE workspace_id=?2 AND id=?3 AND project_id IS ?4 AND forgotten_at IS NULL;",
        rusqlite::params![forgotten_at, scope.workspace_id(), id, scope.project_id()],
    )?;
    if updated > 0 {
        tx.execute(
            "DELETE FROM pinned_context WHERE workspace_id=?1 AND memory_id=?2;",
            rusqlite::params![scope.workspace_id(), id],
        )?;
        tx.execute(
            "INSERT OR REPLACE INTO memory_tombstone (workspace_id, id, forgotten_at) VALUES (?1, ?2, ?3);",
            rusqlite::params![scope.workspace_id(), id, forgotten_at],
        )?;
    }
    Ok(updated > 0)
}

struct Partial {
    id: String,
    workspace_id: String,
    project_id: Option<String>,
    kind: String,
    pinned: bool,
    approved: bool,
    disabled: bool,
    forgotten_at: Option<String>,
    created_at: String,
    sealed: Sealed,
}

use crate::store::vault::Sealed;

fn aad(workspace_id: &str, id: &str) -> String {
    format!("memory_record:{workspace_id}:{id}")
}

fn legacy_aad(id: &str) -> String {
    format!("memory_record:{id}")
}

fn unix_timestamp() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}
