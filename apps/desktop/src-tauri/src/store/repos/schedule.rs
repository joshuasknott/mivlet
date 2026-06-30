//! Schedules — the stable surface the scheduler branch (Goal 8) integrates
//! against. `weekday`/`time`/`enabled` are non-secret query columns; `name` and
//! `description` are encrypted in the payload.

use rusqlite::Connection;
use serde_json::Value;

use crate::models::SCHEDULE_WEEKDAYS;
use crate::store::repos::scope::{ensure_record_owner, DataScope};
use crate::store::repos::{open_json, seal_json};
use crate::store::{Result, Store, StoreError};

/// Upsert from a legacy snapshot `Schedule` JSON value.
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
        .ok_or_else(|| StoreError::Invalid("Schedule is missing an id.".into()))?
        .to_string();
    ensure_record_owner(tx, "schedule", &id, scope)?;
    let weekday = value
        .get("day")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if !SCHEDULE_WEEKDAYS.contains(&weekday.as_str()) {
        return Err(StoreError::Invalid(format!(
            "Schedule day '{weekday}' is not recognized."
        )));
    }
    let time = value
        .get("time")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if !is_valid_time(&time) {
        return Err(StoreError::Invalid("Schedule time must be HH:MM.".into()));
    }
    let enabled = value
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let created_at = value
        .get("createdAt")
        .and_then(Value::as_str)
        .unwrap_or(now)
        .to_string();
    let payload = serde_json::json!({
        "name": value.get("name").and_then(Value::as_str).unwrap_or(""),
        "description": value.get("description").and_then(Value::as_str).unwrap_or(""),
    });
    let sealed = seal_json(store, &payload, &aad(scope.workspace_id(), &id))?;
    tx.execute(
        "INSERT INTO schedule (
           id, workspace_id, project_id, weekday, time, enabled, created_at, payload, payload_nonce
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET
           weekday=excluded.weekday, time=excluded.time, enabled=excluded.enabled,
           payload=excluded.payload, payload_nonce=excluded.payload_nonce;",
        rusqlite::params![
            id,
            scope.workspace_id(),
            scope.project_id(),
            weekday,
            time,
            enabled as i64,
            created_at,
            sealed.ciphertext,
            sealed.nonce
        ],
    )?;
    Ok(())
}

pub struct ScheduleRow {
    pub id: String,
    pub workspace_id: String,
    pub project_id: Option<String>,
    pub weekday: String,
    pub time: String,
    pub enabled: bool,
    pub created_at: String,
    pub payload: Value,
}

pub fn get(tx: &Connection, store: &Store, id: &str) -> Result<Option<ScheduleRow>> {
    get_scoped(tx, store, &DataScope::legacy_default(), id)
}

pub fn get_scoped(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    id: &str,
) -> Result<Option<ScheduleRow>> {
    scope.ensure_exists(tx)?;
    let row = tx
        .query_row(
            "SELECT id, workspace_id, project_id, weekday, time, enabled, created_at, payload, payload_nonce
             FROM schedule WHERE id = ?1 AND workspace_id=?2 AND project_id IS ?3;",
            rusqlite::params![id, scope.workspace_id(), scope.project_id()],
            |row| {
                Ok(SchedulePartial {
                    id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    project_id: row.get(2)?,
                    weekday: row.get(3)?,
                    time: row.get(4)?,
                    enabled: row.get::<_, i64>(5)? != 0,
                    created_at: row.get(6)?,
                    sealed: Sealed {
                        ciphertext: row.get(7)?,
                        nonce: row.get(8)?,
                    },
                })
            },
        )
        .optional()?;
    match row {
        None => Ok(None),
        Some(p) => {
            let payload = open_schedule_payload(store, &p)?;
            Ok(Some(ScheduleRow {
                id: p.id,
                workspace_id: p.workspace_id,
                project_id: p.project_id,
                weekday: p.weekday,
                time: p.time,
                enabled: p.enabled,
                created_at: p.created_at,
                payload,
            }))
        }
    }
}

/// List enabled schedules (the scheduler's main query in Goal 8).
pub fn list_enabled(tx: &Connection, store: &Store) -> Result<Vec<ScheduleRow>> {
    list_enabled_scoped(tx, store, &DataScope::legacy_default())
}

pub fn list_enabled_scoped(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
) -> Result<Vec<ScheduleRow>> {
    list_where(tx, store, scope, true)
}

/// List all schedules.
pub fn list(tx: &Connection, store: &Store) -> Result<Vec<ScheduleRow>> {
    list_scoped(tx, store, &DataScope::legacy_default())
}

pub fn list_scoped(tx: &Connection, store: &Store, scope: &DataScope) -> Result<Vec<ScheduleRow>> {
    list_where(tx, store, scope, false)
}

fn list_where(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    enabled_only: bool,
) -> Result<Vec<ScheduleRow>> {
    scope.ensure_exists(tx)?;
    let sql = "SELECT id, workspace_id, project_id, weekday, time, enabled, created_at, payload, payload_nonce
         FROM schedule
         WHERE workspace_id=?1 AND project_id IS ?2 AND (?3=0 OR enabled=1)
         ORDER BY created_at;";
    let mut stmt = tx.prepare(sql)?;
    let partials: Vec<SchedulePartial> = stmt
        .query_map(
            rusqlite::params![
                scope.workspace_id(),
                scope.project_id(),
                enabled_only as i64
            ],
            |row| {
                Ok(SchedulePartial {
                    id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    project_id: row.get(2)?,
                    weekday: row.get(3)?,
                    time: row.get(4)?,
                    enabled: row.get::<_, i64>(5)? != 0,
                    created_at: row.get(6)?,
                    sealed: Sealed {
                        ciphertext: row.get(7)?,
                        nonce: row.get(8)?,
                    },
                })
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut out = Vec::with_capacity(partials.len());
    for p in partials {
        let payload = open_schedule_payload(store, &p)?;
        out.push(ScheduleRow {
            id: p.id,
            workspace_id: p.workspace_id,
            project_id: p.project_id,
            weekday: p.weekday,
            time: p.time,
            enabled: p.enabled,
            created_at: p.created_at,
            payload,
        });
    }
    Ok(out)
}

/// Delete a schedule by id.
pub fn delete(tx: &Connection, id: &str) -> Result<()> {
    delete_scoped(tx, &DataScope::legacy_default(), id)
}

pub fn delete_scoped(tx: &Connection, scope: &DataScope, id: &str) -> Result<()> {
    scope.ensure_exists(tx)?;
    tx.execute(
        "DELETE FROM schedule WHERE id=?1 AND workspace_id=?2 AND project_id IS ?3;",
        rusqlite::params![id, scope.workspace_id(), scope.project_id()],
    )?;
    Ok(())
}

struct SchedulePartial {
    id: String,
    workspace_id: String,
    project_id: Option<String>,
    weekday: String,
    time: String,
    enabled: bool,
    created_at: String,
    sealed: Sealed,
}

use crate::store::vault::Sealed;

fn open_schedule_payload(store: &Store, partial: &SchedulePartial) -> Result<Value> {
    open_json(
        store,
        &partial.sealed,
        &aad(&partial.workspace_id, &partial.id),
    )
    .or_else(|error| {
        if partial.workspace_id == crate::store::repos::scope::DEFAULT_WORKSPACE_ID {
            open_json(store, &partial.sealed, &legacy_aad(&partial.id))
        } else {
            Err(error)
        }
    })
}

fn aad(workspace_id: &str, id: &str) -> String {
    format!("schedule:{workspace_id}:{id}")
}

fn legacy_aad(id: &str) -> String {
    format!("schedule:{id}")
}

fn is_valid_time(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 5 || bytes[2] != b':' {
        return false;
    }
    let hour = value[0..2].parse::<u32>().ok();
    let minute = value[3..5].parse::<u32>().ok();
    matches!((hour, minute), (Some(h), Some(m)) if h <= 23 && m <= 59)
}

use rusqlite::OptionalExtension as _;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::vault::{MasterKey, Vault};

    fn store() -> Store {
        Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap()
    }

    #[test]
    fn round_trips_schedule() {
        let store = store();
        let sch = serde_json::json!({
            "id": "s1", "name": "Weekly", "description": "digest",
            "day": "Fri", "time": "09:00", "enabled": true,
            "createdAt": "2026-06-01T00:00:00Z"
        });
        store
            .transaction(|tx| upsert_from_value(tx, &store, sch, "now"))
            .unwrap();
        let rows = store.with_conn(|conn| list_enabled(conn, &store)).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].weekday, "Fri");
        assert_eq!(rows[0].payload["name"], "Weekly");
    }

    #[test]
    fn rejects_bad_weekday_and_time() {
        let store = store();
        store
            .transaction(|tx| {
                let bad_day = serde_json::json!({"id":"x","day":"Funday","time":"09:00"});
                assert!(upsert_from_value(tx, &store, bad_day, "now").is_err());
                let bad_time = serde_json::json!({"id":"x","day":"Mon","time":"25:00"});
                assert!(upsert_from_value(tx, &store, bad_time, "now").is_err());
                Ok(())
            })
            .unwrap();
    }
}
