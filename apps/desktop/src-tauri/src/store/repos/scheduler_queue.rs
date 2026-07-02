//! Scheduler queue — the durable, encrypted, workspace-scoped runtime authority
//! for queued/leased runs.
//!
//! The queue-entry `state` is never accepted from the wire: it is advanced by
//! the tick and `report_job_attempt`. Plaintext query columns are the
//! scheduler's runtime fields (`job_id`, `state`, lease holder + deadline, the
//! fencing `lease_token`, the retry `available_at`, `last_error`); the encrypted
//! `payload` holds the attempt history + the frozen execution-route snapshot.
//! The `deduplication_key` is unique per workspace so a duplicate enqueue
//! (in-queue or already-completed) is rejected at the storage layer.

use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;

use crate::store::repos::scheduled_job::normalize_workspace;
use crate::store::repos::scope::DataScope;
use crate::store::repos::{open_json, payload_of, seal_json};
use crate::store::{Result, Store, StoreError};

/// A durable scheduler-queue row. `value` is the full camelCase
/// `SchedulerQueueEntry` shape (including `runId`, `scheduledAt`, `attempts`,
/// and the execution route).
pub struct QueueRow {
    pub id: String,
    pub workspace_id: String,
    pub job_id: String,
    pub value: Value,
}

/// Insert (enqueue) a queue entry. The `deduplication_key` is enforced unique
/// per workspace, so re-enqueuing the same occurrence is rejected by the
/// storage layer rather than producing a duplicate. Returns the stored row on
/// success, or `None` when the occurrence is already queued.
pub fn upsert_entry(
    tx: &Connection,
    store: &Store,
    workspace_id: &str,
    value: &Value,
    now: &str,
) -> Result<Option<QueueRow>> {
    let workspace_id = normalize_workspace(workspace_id);
    let project_id = value
        .get("projectId")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .map(str::to_string);
    let scope = DataScope::new(workspace_id.clone(), project_id)?;
    scope.ensure_exists(tx)?;
    if let Some(payload_workspace) = value
        .get("workspaceId")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
    {
        if payload_workspace != workspace_id {
            return Err(StoreError::Invalid(
                "Queue entry workspace does not match the requested workspace.".into(),
            ));
        }
    }
    let job_id = value
        .get("jobId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let run_id = value
        .get("runId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let deduplication_key = value
        .get("deduplicationKey")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if job_id.is_empty() || run_id.is_empty() || deduplication_key.is_empty() {
        return Err(StoreError::Invalid(
            "Queue entry needs jobId, runId, and deduplicationKey.".into(),
        ));
    }
    let job_owner: Option<String> = tx
        .query_row(
            "SELECT workspace_id FROM scheduled_job WHERE id=?1;",
            [&job_id],
            |row| row.get(0),
        )
        .optional()?;
    if job_owner.as_deref() != Some(workspace_id.as_str()) {
        return Err(StoreError::Invalid(
            "Queue entry job was not found in the requested workspace.".into(),
        ));
    }
    let id = queue_id(&workspace_id, &run_id);
    let scheduled_at = value
        .get("scheduledAt")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let state = value
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or("queued")
        .to_string();
    let lease_holder = value
        .get("leaseHolder")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let lease_expires_at = value
        .get("leaseExpiresAt")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let lease_token = value
        .get("leaseToken")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let available_at = value
        .get("availableAt")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let last_error = if value
        .get("lastError")
        .and_then(Value::as_str)
        .unwrap_or("")
        .is_empty()
    {
        ""
    } else {
        "present"
    };
    let sealed = seal_json(store, value, &aad(&workspace_id, &id))?;
    // Let SQLite's unique indexes do the duplicate detection inside the write
    // statement. That keeps the common enqueue path to one indexed operation
    // instead of a COUNT probe followed by the insert/upsert.
    let touched = tx.execute(
        "INSERT INTO scheduler_queue_entry
           (id, workspace_id, job_id, state, lease_holder, lease_expires_at,
            lease_token, deduplication_key, available_at, last_error, scheduled_at,
            updated_at, payload, payload_nonce)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
         ON CONFLICT(workspace_id, deduplication_key) DO NOTHING
         ON CONFLICT(id) DO UPDATE SET
           state=excluded.state, lease_holder=excluded.lease_holder,
           lease_expires_at=excluded.lease_expires_at, lease_token=excluded.lease_token,
           available_at=excluded.available_at, last_error=excluded.last_error,
           updated_at=excluded.updated_at, payload=excluded.payload,
           payload_nonce=excluded.payload_nonce;",
        rusqlite::params![
            id,
            workspace_id,
            job_id,
            state,
            lease_holder,
            lease_expires_at,
            lease_token,
            deduplication_key,
            available_at,
            last_error,
            scheduled_at,
            now,
            sealed.ciphertext,
            sealed.nonce
        ],
    )?;
    if touched == 0 {
        return Ok(None);
    }
    Ok(Some(QueueRow {
        id,
        workspace_id,
        job_id,
        value: value.clone(),
    }))
}

/// Replace the full mutable state of an entry (state, lease fields, backoff,
/// last error) and re-seal its payload. Used by the tick + report/cancel flows
/// that already hold the authoritative entry.
pub fn apply_state(
    tx: &Connection,
    store: &Store,
    workspace_id: &str,
    id: &str,
    value: &Value,
    now: &str,
) -> Result<()> {
    let workspace_id = normalize_workspace(workspace_id);
    let state = value
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or("queued")
        .to_string();
    let lease_holder = value
        .get("leaseHolder")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let lease_expires_at = value
        .get("leaseExpiresAt")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let lease_token = value
        .get("leaseToken")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let available_at = value
        .get("availableAt")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let last_error = if value
        .get("lastError")
        .and_then(Value::as_str)
        .unwrap_or("")
        .is_empty()
    {
        ""
    } else {
        "present"
    };
    let sealed = seal_json(store, value, &aad(&workspace_id, id))?;
    let touched = tx.execute(
        "UPDATE scheduler_queue_entry SET
           state=?2, lease_holder=?3, lease_expires_at=?4, lease_token=?5,
           available_at=?6, last_error=?7, updated_at=?8, payload=?9,
           payload_nonce=?10
         WHERE workspace_id=?11 AND id=?12;",
        rusqlite::params![
            id,
            state,
            lease_holder,
            lease_expires_at,
            lease_token,
            available_at,
            last_error,
            now,
            sealed.ciphertext,
            sealed.nonce,
            workspace_id,
            id
        ],
    )?;
    if touched == 0 {
        return Err(StoreError::Invalid(
            "Queue entry was not found for state update.".into(),
        ));
    }
    Ok(())
}

/// Load every entry for a workspace (decoded). The full store snapshot the
/// tick + managed state operate on.
pub fn list(tx: &Connection, store: &Store, workspace_id: &str) -> Result<Vec<QueueRow>> {
    let workspace_id = normalize_workspace(workspace_id);
    let mut stmt = tx.prepare(
        "SELECT id, workspace_id, job_id, payload, payload_nonce FROM scheduler_queue_entry
         WHERE workspace_id = ?1 ORDER BY scheduled_at;",
    )?;
    let collected: Vec<(String, String, String, crate::store::vault::Sealed)> = stmt
        .query_map(rusqlite::params![workspace_id], |row| {
            Ok((
                row.get::<_, String>("id")?,
                row.get::<_, String>("workspace_id")?,
                row.get::<_, String>("job_id")?,
                payload_of(row)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut out = Vec::with_capacity(collected.len());
    for (id, workspace_id, job_id, sealed) in collected {
        let value = open_json(store, &sealed, &aad(&workspace_id, &id))?;
        out.push(QueueRow {
            id,
            workspace_id,
            job_id,
            value,
        });
    }
    Ok(out)
}

/// Delete every entry for a workspace (full-replace flush). Returns the count.
pub fn delete_all(tx: &Connection, workspace_id: &str) -> Result<usize> {
    let workspace_id = normalize_workspace(workspace_id);
    let removed = tx.execute(
        "DELETE FROM scheduler_queue_entry WHERE workspace_id = ?1;",
        rusqlite::params![workspace_id],
    )?;
    Ok(removed)
}

/// Drop queue entries for a job (used on job deletion/status change).
pub fn delete_for_job(tx: &Connection, workspace_id: &str, job_id: &str) -> Result<()> {
    let workspace_id = normalize_workspace(workspace_id);
    tx.execute(
        "DELETE FROM scheduler_queue_entry
         WHERE workspace_id = ?1 AND job_id = ?2;",
        rusqlite::params![workspace_id, job_id],
    )?;
    Ok(())
}

/// Stable, deterministic row id so a re-upsert replaces in place.
pub fn queue_id(workspace_id: &str, run_id: &str) -> String {
    format!("queue:{workspace_id}:{run_id}")
}

fn aad(workspace_id: &str, id: &str) -> String {
    format!("scheduler_queue:{workspace_id}:{id}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::vault::{MasterKey, Vault};
    use std::time::Instant;

    fn store() -> Store {
        Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap()
    }

    fn entry(job_id: &str, run_id: &str) -> Value {
        serde_json::json!({
            "jobId": job_id,
            "runId": run_id,
            "scheduledAt": "2026-07-01T09:00:00.000Z",
            "state": "queued",
            "leaseHolder": "",
            "leaseExpiresAt": "",
            "attempts": [],
            "deduplicationKey": format!("{job_id}:2026-07-01T09:00:00.000Z"),
            "leaseToken": "",
            "availableAt": "",
            "lastError": ""
        })
    }

    fn seed_job(store: &Store, workspace_id: &str, job_id: &str) {
        store
            .transaction(|tx| {
                crate::store::repos::workspace::upsert(tx, workspace_id, workspace_id, "now")?;
                crate::store::repos::scheduled_job::upsert_from_value(
                    tx,
                    store,
                    workspace_id,
                    serde_json::json!({
                        "id": job_id,
                        "schemaVersion": crate::models::SCHEDULER_STORE_VERSION,
                        "name": "Job",
                        "workflowDefinitionId": "wf",
                        "trigger": {"kind": "once"},
                        "missedRunPolicy": "skip",
                        "status": "active",
                        "workspaceId": workspace_id,
                        "createdAt": "now",
                        "updatedAt": "now"
                    }),
                    "now",
                )
            })
            .unwrap();
    }

    #[test]
    fn deduplication_rejects_duplicate_occurrence() {
        let store = store();
        seed_job(&store, "default", "j");
        store
            .transaction(|tx| {
                assert!(upsert_entry(tx, &store, "", &entry("j", "r1"), "now")?.is_some());
                // Same occurrence (same dedup key), different run id → rejected.
                assert!(upsert_entry(tx, &store, "", &entry("j", "r2"), "now")?.is_none());
                Ok(())
            })
            .unwrap();
        let rows = store.with_conn(|conn| list(conn, &store, "")).unwrap();
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn same_queue_id_reupserts_in_place() {
        let store = store();
        seed_job(&store, "default", "j");
        store
            .transaction(|tx| {
                assert!(upsert_entry(tx, &store, "", &entry("j", "r1"), "now")?.is_some());
                let mut replacement = entry("j", "r1");
                replacement["state"] = serde_json::json!("leased");
                replacement["leaseHolder"] = serde_json::json!("instance-a");
                replacement["scheduledAt"] = serde_json::json!("2026-07-01T10:00:00.000Z");
                replacement["deduplicationKey"] = serde_json::json!("j:2026-07-01T10:00:00.000Z");
                assert!(upsert_entry(tx, &store, "", &replacement, "later")?.is_some());
                Ok(())
            })
            .unwrap();
        let rows = store.with_conn(|conn| list(conn, &store, "")).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].value["state"], "leased");
        assert_eq!(rows[0].value["leaseHolder"], "instance-a");
        assert_eq!(
            rows[0].value["deduplicationKey"],
            "j:2026-07-01T10:00:00.000Z"
        );
    }

    #[test]
    fn workspace_isolation() {
        let store = store();
        seed_job(&store, "ws-a", "j-a");
        seed_job(&store, "ws-b", "j-b");
        store
            .transaction(|tx| {
                assert!(upsert_entry(tx, &store, "ws-a", &entry("j-a", "r1"), "now")?.is_some());
                assert!(upsert_entry(tx, &store, "ws-b", &entry("j-b", "r1"), "now")?.is_some());
                Ok(())
            })
            .unwrap();
        let a = store.with_conn(|conn| list(conn, &store, "ws-a")).unwrap();
        let b = store.with_conn(|conn| list(conn, &store, "ws-b")).unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!(b.len(), 1);
    }

    #[test]
    fn payload_is_encrypted_at_rest() {
        let store = store();
        seed_job(&store, "default", "j");
        store
            .transaction(|tx| {
                let mut e = entry("j", "r1");
                e["lastError"] = serde_json::json!("very-secret-error");
                upsert_entry(tx, &store, "", &e, "now")?;
                Ok(())
            })
            .unwrap();
        let raw_blob: Vec<u8> = store
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT payload FROM scheduler_queue_entry WHERE id='queue:default:r1';",
                    [],
                    |row| row.get::<_, Vec<u8>>(0),
                )
                .map_err(StoreError::from)
            })
            .unwrap();
        let plaintext_error: String = store
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT last_error FROM scheduler_queue_entry
                     WHERE id='queue:default:r1';",
                    [],
                    |row| row.get(0),
                )
                .map_err(StoreError::from)
            })
            .unwrap();
        assert!(
            !String::from_utf8_lossy(&raw_blob).contains("very-secret-error"),
            "queue payload leaked into plaintext"
        );
        assert_eq!(plaintext_error, "present");
    }

    #[test]
    fn perf_scheduler_queue_lists_workspace_entries_at_current_scale() {
        let store = store();
        seed_job(&store, "default", "j");
        store
            .transaction(|tx| {
                for index in 0..500 {
                    let mut value = entry("j", &format!("r{index}"));
                    value["deduplicationKey"] =
                        serde_json::json!(format!("j:2026-07-01T09:{index:04}.000Z"));
                    assert!(upsert_entry(tx, &store, "", &value, "now")?.is_some());
                }
                Ok(())
            })
            .unwrap();

        let started = Instant::now();
        let rows = store.with_conn(|conn| list(conn, &store, "")).unwrap();
        let elapsed = started.elapsed();

        eprintln!("perf_scheduler_queue_list_ms={}", elapsed.as_millis());
        assert_eq!(rows.len(), 500);
        assert!(
            elapsed.as_millis() < 1_500,
            "scheduler queue list took {} ms",
            elapsed.as_millis()
        );
    }
}
