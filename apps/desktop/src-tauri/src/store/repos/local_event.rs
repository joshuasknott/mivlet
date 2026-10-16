//! Encrypted delivery outbox and replay tombstones. Only ordinary schedule
//! occurrences admit Work; these rows never convey execution or tool authority.
use super::{open_json, scope::PrivateDataScope, seal_json};
use crate::store::{vault::Sealed, Result, Store, StoreError};
use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;

#[derive(Clone)]
pub struct DeliveryRow {
    pub id: String,
    pub schedule_id: String,
    pub schedule_revision: i64,
    pub fingerprint: Option<String>,
    pub body_fingerprint: Option<String>,
    pub state: String,
    pub received_at: String,
    pub expires_at: String,
    pub dedup_until: String,
    pub occurrence_id: Option<String>,
    pub payload: Value,
}

fn aad(scope: &PrivateDataScope, id: &str) -> String {
    format!(
        "local_event_delivery:{}:{}:{id}",
        scope.workspace_id(),
        scope.owner_subject()
    )
}

pub fn insert(
    conn: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    row: &DeliveryRow,
) -> Result<()> {
    scope.ensure_exists(conn)?;
    let sealed = seal_json(store, &row.payload, &aad(scope, &row.id))?;
    conn.execute("INSERT INTO local_event_delivery(workspace_id,owner_subject,id,schedule_id,schedule_revision,fingerprint,body_fingerprint,state,received_at,expires_at,dedup_until,occurrence_id,payload,payload_nonce) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
      rusqlite::params![scope.workspace_id(),scope.owner_subject(),row.id,row.schedule_id,row.schedule_revision,row.fingerprint,row.body_fingerprint,row.state,row.received_at,row.expires_at,row.dedup_until,row.occurrence_id,sealed.ciphertext,sealed.nonce])?;
    Ok(())
}

pub fn get(
    conn: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    id: &str,
) -> Result<Option<DeliveryRow>> {
    let row = conn.query_row("SELECT id,schedule_id,schedule_revision,fingerprint,body_fingerprint,state,received_at,expires_at,dedup_until,occurrence_id,payload,payload_nonce FROM local_event_delivery WHERE workspace_id=?1 AND owner_subject=?2 AND id=?3",
      rusqlite::params![scope.workspace_id(),scope.owner_subject(),id], |row| Ok((DeliveryRow {
        id:row.get(0)?,schedule_id:row.get(1)?,schedule_revision:row.get(2)?,fingerprint:row.get(3)?,body_fingerprint:row.get(4)?,state:row.get(5)?,received_at:row.get(6)?,expires_at:row.get(7)?,dedup_until:row.get(8)?,occurrence_id:row.get(9)?,payload:Value::Null
      }, Sealed {ciphertext:row.get(10)?,nonce:row.get(11)?}))).optional()?;
    row.map(|(mut row, sealed)| {
        row.payload = open_json(store, &sealed, &aad(scope, &row.id))?;
        Ok(row)
    })
    .transpose()
}

pub fn duplicate(
    conn: &Connection,
    scope: &PrivateDataScope,
    schedule: &str,
    fingerprint: &str,
    body: &str,
) -> Result<Option<String>> {
    Ok(conn.query_row("SELECT id FROM local_event_delivery WHERE workspace_id=?1 AND owner_subject=?2 AND schedule_id=?3 AND (fingerprint=?4 OR body_fingerprint=?5) LIMIT 1", rusqlite::params![scope.workspace_id(),scope.owner_subject(),schedule,fingerprint,body], |row| row.get(0)).optional()?)
}

pub fn list(
    conn: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    schedule: &str,
    limit: usize,
) -> Result<Vec<DeliveryRow>> {
    let mut statement = conn.prepare("SELECT id FROM local_event_delivery WHERE workspace_id=?1 AND owner_subject=?2 AND schedule_id=?3 ORDER BY received_at DESC,rowid DESC LIMIT ?4")?;
    let ids = statement
        .query_map(
            rusqlite::params![
                scope.workspace_id(),
                scope.owner_subject(),
                schedule,
                limit.min(100) as i64
            ],
            |row| row.get::<_, String>(0),
        )?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    ids.into_iter()
        .map(|id| {
            get(conn, store, scope, &id)?
                .ok_or_else(|| StoreError::Invalid("Event delivery disappeared.".into()))
        })
        .collect()
}

pub fn first_pending(
    conn: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    schedule: &str,
) -> Result<Option<DeliveryRow>> {
    let id:Option<String>=conn.query_row("SELECT id FROM local_event_delivery WHERE workspace_id=?1 AND owner_subject=?2 AND schedule_id=?3 AND state='pending' ORDER BY received_at ASC,rowid ASC LIMIT 1",rusqlite::params![scope.workspace_id(),scope.owner_subject(),schedule],|row|row.get(0)).optional()?;
    id.map(|id| {
        get(conn, store, scope, &id)?
            .ok_or_else(|| StoreError::Invalid("Pending event disappeared.".into()))
    })
    .transpose()
}

pub fn replace(
    conn: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    row: &DeliveryRow,
) -> Result<()> {
    let sealed = seal_json(store, &row.payload, &aad(scope, &row.id))?;
    let changed=conn.execute("UPDATE local_event_delivery SET state=?1,occurrence_id=?2,payload=?3,payload_nonce=?4 WHERE workspace_id=?5 AND owner_subject=?6 AND id=?7",rusqlite::params![row.state,row.occurrence_id,sealed.ciphertext,sealed.nonce,scope.workspace_id(),scope.owner_subject(),row.id])?;
    if changed != 1 {
        return Err(StoreError::Invalid("Event delivery changed.".into()));
    }
    Ok(())
}

pub fn count(conn: &Connection, scope: &PrivateDataScope, schedule: &str) -> Result<i64> {
    Ok(conn.query_row("SELECT COUNT(*) FROM local_event_delivery WHERE workspace_id=?1 AND owner_subject=?2 AND schedule_id=?3",rusqlite::params![scope.workspace_id(),scope.owner_subject(),schedule],|row|row.get(0))?)
}

pub fn purge_expired_tombstones(
    conn: &Connection,
    scope: &PrivateDataScope,
    now: &str,
) -> Result<()> {
    conn.execute("DELETE FROM local_event_delivery WHERE workspace_id=?1 AND owner_subject=?2 AND dedup_until<?3 AND state!='pending'",rusqlite::params![scope.workspace_id(),scope.owner_subject(),now])?;
    Ok(())
}

pub fn pending_count(conn: &Connection, scope: &PrivateDataScope, schedule: &str) -> Result<i64> {
    Ok(conn.query_row("SELECT COUNT(*) FROM local_event_delivery WHERE workspace_id=?1 AND owner_subject=?2 AND schedule_id=?3 AND state='pending'",rusqlite::params![scope.workspace_id(),scope.owner_subject(),schedule],|row|row.get(0))?)
}

/// Keep at most 50 payload previews for 24 hours, while authenticated digests
/// survive for seven days. Overflow fails closed instead of evicting replay keys.
pub fn prune(
    conn: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    schedule: &str,
    now: &str,
    cutoff: &str,
) -> Result<()> {
    conn.execute("UPDATE local_event_delivery SET state='expired' WHERE workspace_id=?1 AND owner_subject=?2 AND schedule_id=?3 AND state='pending' AND expires_at<=?4",rusqlite::params![scope.workspace_id(),scope.owner_subject(),schedule,now])?;
    conn.execute("DELETE FROM local_event_delivery WHERE workspace_id=?1 AND owner_subject=?2 AND schedule_id=?3 AND fingerprint IS NULL AND rowid NOT IN (SELECT rowid FROM local_event_delivery WHERE workspace_id=?1 AND owner_subject=?2 AND schedule_id=?3 AND fingerprint IS NULL ORDER BY received_at DESC,rowid DESC LIMIT 50)",rusqlite::params![scope.workspace_id(),scope.owner_subject(),schedule])?;
    let mut statement=conn.prepare("SELECT id FROM local_event_delivery WHERE workspace_id=?1 AND owner_subject=?2 AND schedule_id=?3 AND state!='pending' AND redacted_at IS NULL AND (received_at<?4 OR rowid NOT IN (SELECT rowid FROM local_event_delivery WHERE workspace_id=?1 AND owner_subject=?2 AND schedule_id=?3 ORDER BY received_at DESC,rowid DESC LIMIT 50)) LIMIT 256")?;
    let ids = statement
        .query_map(
            rusqlite::params![
                scope.workspace_id(),
                scope.owner_subject(),
                schedule,
                cutoff
            ],
            |row| row.get::<_, String>(0),
        )?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(statement);
    for id in ids {
        if let Some(mut row) = get(conn, store, scope, &id)? {
            row.payload["selectedFields"] = serde_json::json!({});
            row.payload["prompt"] = Value::Null;
            replace(conn, store, scope, &row)?;
            conn.execute("UPDATE local_event_delivery SET redacted_at=?1 WHERE workspace_id=?2 AND owner_subject=?3 AND id=?4",rusqlite::params![now,scope.workspace_id(),scope.owner_subject(),id])?;
        }
    }
    purge_expired_tombstones(conn, scope, now)
}

pub fn retire_pending(
    conn: &Connection,
    scope: &PrivateDataScope,
    schedule: &str,
    state: &str,
) -> Result<()> {
    if !matches!(state, "paused" | "expired" | "removed") {
        return Err(StoreError::Invalid("Invalid event retirement.".into()));
    }
    conn.execute("UPDATE local_event_delivery SET state=?1 WHERE workspace_id=?2 AND owner_subject=?3 AND schedule_id=?4 AND state='pending'",rusqlite::params![state,scope.workspace_id(),scope.owner_subject(),schedule])?;
    Ok(())
}
