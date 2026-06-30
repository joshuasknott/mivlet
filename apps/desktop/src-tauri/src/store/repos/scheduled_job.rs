//! Scheduled jobs — the durable automation-engine record, persisted encrypted
//! and scoped to a workspace.
//!
//! Non-secret query columns (`workspace_id`, `status`, the linked
//! `workflow_definition_id`, the `trigger_kind`, `missed_run_policy`, the run
//! timestamps) live in plaintext so the scheduler tick and the Schedules UI can
//! filter without decrypting. Sensitive free text (`name`, `description`), the
//! full trigger object, and the frozen execution route are sealed into the
//! `payload` BLOB bound to the row identity (`scheduled_job:{workspace}:{id}`).
//! The execution route carries only provider/model ids + permission mode —
//! never keys or tokens.

use rusqlite::Connection;
use serde_json::Value;

use crate::models::{
    MISSED_RUN_POLICIES, SCHEDULED_JOB_STATUSES, SCHEDULER_STORE_VERSION,
};
use crate::store::repos::{open_json, seal_json};
use crate::store::{Result, Store, StoreError};

/// The single-profile default workspace. The desktop shell is single-profile
/// today; the workspace-model branch (Batch 9 data model) will pass an explicit
/// `workspace_id` through the command surface once that contract lands. Until
/// then every schedule/workflow is scoped here so isolation is enforced from
/// day one and the workspace filter can be tightened without a data migration.
pub const DEFAULT_WORKSPACE_ID: &str = "default";

/// Normalize a workspace id, defaulting empty input to the single-profile
/// default so every read/write carries a non-empty scope.
pub fn normalize_workspace(workspace_id: &str) -> String {
    let trimmed = workspace_id.trim();
    if trimmed.is_empty() {
        DEFAULT_WORKSPACE_ID.to_string()
    } else {
        trimmed.to_string()
    }
}

/// Upsert a scheduled job from its wire `Value` (the camelCase `ScheduledJob`
/// shape). Validates enums + trigger kind; preserves unknown fields in the
/// encrypted payload so legacy/extras survive a round trip.
pub fn upsert_from_value(
    tx: &Connection,
    store: &Store,
    workspace_id: &str,
    value: Value,
    now: &str,
) -> Result<()> {
    let workspace_id = normalize_workspace(workspace_id);
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| StoreError::Invalid("Scheduled job is missing an id.".into()))?
        .to_string();
    let workflow_definition_id = value
        .get("workflowDefinitionId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if workflow_definition_id.is_empty() {
        return Err(StoreError::Invalid(
            "Scheduled job needs a workflow definition id.".into(),
        ));
    }
    let status = value
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("active")
        .to_string();
    if !SCHEDULED_JOB_STATUSES.contains(&status.as_str()) {
        return Err(StoreError::Invalid(
            "Scheduled job status is not recognized.".into(),
        ));
    }
    let missed_run_policy = value
        .get("missedRunPolicy")
        .and_then(Value::as_str)
        .unwrap_or("skip")
        .to_string();
    if !MISSED_RUN_POLICIES.contains(&missed_run_policy.as_str()) {
        return Err(StoreError::Invalid(
            "Missed-run policy is not recognized.".into(),
        ));
    }
    let schema_version = value
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .unwrap_or(SCHEDULER_STORE_VERSION as u64) as i64;
    if schema_version != SCHEDULER_STORE_VERSION as i64 {
        return Err(StoreError::Invalid(
            "Scheduled job schema version is not supported.".into(),
        ));
    }
    let trigger = value.get("trigger").cloned().unwrap_or(Value::Null);
    let trigger_kind = trigger
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if !matches!(trigger_kind.as_str(), "once" | "recurring") {
        return Err(StoreError::Invalid(
            "Schedule trigger kind must be \"once\" or \"recurring\".".into(),
        ));
    }
    let next_run_at = value
        .get("nextRunAt")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let last_run_at = value
        .get("lastRunAt")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let last_run_id = value
        .get("lastRunId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let created_at = value
        .get("createdAt")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or(now)
        .to_string();
    let updated_at = value
        .get("updatedAt")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or(now)
        .to_string();

    // Sensitive free text + the full trigger + the frozen execution route +
    // any unknown fields are sealed together. The execution route is non-secret
    // (ids + permission mode only) but rides in the payload alongside the
    // trigger it describes; nothing secret ever reaches this blob.
    let payload = value.clone();
    let sealed = seal_json(store, &payload, &aad(&workspace_id, &id))?;
    tx.execute(
        "INSERT INTO scheduled_job
           (id, workspace_id, status, workflow_definition_id, trigger_kind,
            missed_run_policy, schema_version, next_run_at, last_run_at, last_run_id,
            created_at, updated_at, payload, payload_nonce)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
         ON CONFLICT(id) DO UPDATE SET
           workspace_id=excluded.workspace_id, status=excluded.status,
           workflow_definition_id=excluded.workflow_definition_id,
           trigger_kind=excluded.trigger_kind,
           missed_run_policy=excluded.missed_run_policy,
           schema_version=excluded.schema_version, next_run_at=excluded.next_run_at,
           last_run_at=excluded.last_run_at, last_run_id=excluded.last_run_id,
           updated_at=excluded.updated_at, payload=excluded.payload,
           payload_nonce=excluded.payload_nonce;",
        rusqlite::params![
            id,
            workspace_id,
            status,
            workflow_definition_id,
            trigger_kind,
            missed_run_policy,
            schema_version,
            next_run_at,
            last_run_at,
            last_run_id,
            created_at,
            updated_at,
            sealed.ciphertext,
            sealed.nonce
        ],
    )?;
    Ok(())
}

pub struct ScheduledJobRow {
    pub id: String,
    pub workspace_id: String,
    pub value: Value,
}

/// List every scheduled job in a workspace, ordered by creation time.
pub fn list(tx: &Connection, store: &Store, workspace_id: &str) -> Result<Vec<ScheduledJobRow>> {
    let workspace_id = normalize_workspace(workspace_id);
    let mut stmt = tx.prepare(
        "SELECT id, workspace_id, payload, payload_nonce FROM scheduled_job
         WHERE workspace_id = ?1 ORDER BY created_at;",
    )?;
    let collected: Vec<(String, String, crate::store::vault::Sealed)> = stmt
        .query_map(rusqlite::params![workspace_id], |row| {
            Ok((
                row.get::<_, String>("id")?,
                row.get::<_, String>("workspace_id")?,
                crate::store::repos::payload_of(row)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut out = Vec::with_capacity(collected.len());
    for (id, workspace_id, sealed) in collected {
        let value = open_json(store, &sealed, &aad(&workspace_id, &id))?;
        out.push(ScheduledJobRow {
            id,
            workspace_id,
            value,
        });
    }
    Ok(out)
}

/// Delete a job by id within a workspace.
pub fn delete(tx: &Connection, workspace_id: &str, id: &str) -> Result<()> {
    let workspace_id = normalize_workspace(workspace_id);
    tx.execute(
        "DELETE FROM scheduled_job WHERE workspace_id = ?1 AND id = ?2;",
        rusqlite::params![workspace_id, id],
    )?;
    Ok(())
}

/// Delete every job in a workspace (used by the transactional full-replace
/// flush). Returns the number of rows removed.
pub fn delete_all(tx: &Connection, workspace_id: &str) -> Result<usize> {
    let workspace_id = normalize_workspace(workspace_id);
    let removed = tx.execute(
        "DELETE FROM scheduled_job WHERE workspace_id = ?1;",
        rusqlite::params![workspace_id],
    )?;
    Ok(removed)
}

fn aad(workspace_id: &str, id: &str) -> String {
    format!("scheduled_job:{workspace_id}:{id}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::vault::{MasterKey, Vault};

    fn store() -> Store {
        Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap()
    }

    fn sample_job(id: &str) -> Value {
        serde_json::json!({
            "id": id,
            "schemaVersion": SCHEDULER_STORE_VERSION,
            "name": "Weekly brief",
            "description": "A transparent summary",
            "workflowDefinitionId": "wf-1",
            "trigger": {"kind": "recurring", "rule": {"frequency": "weekly", "interval": 1, "hour": 9, "minute": 0}},
            "missedRunPolicy": "skip",
            "status": "active",
            "nextRunAt": "2026-07-01T09:00:00.000Z",
            "lastRunAt": "",
            "lastRunId": "",
            "createdAt": "2026-06-01T00:00:00.000Z",
            "updatedAt": "2026-06-01T00:00:00.000Z",
            "execution": {"policy": "pinned", "backendId": "openai", "modelId": "gpt-4o", "permissionMode": "trusted-scope", "permissionProfile": "trusted"}
        })
    }

    #[test]
    fn round_trips_a_job() {
        let store = store();
        store
            .transaction(|tx| upsert_from_value(tx, &store, "", sample_job("j1"), "now"))
            .unwrap();
        let rows = store
            .with_conn(|conn| list(conn, &store, ""))
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].value["name"], "Weekly brief");
        assert_eq!(rows[0].value["execution"]["backendId"], "openai");
    }

    #[test]
    fn payload_is_encrypted_at_rest() {
        let store = store();
        store
            .transaction(|tx| upsert_from_value(tx, &store, "", sample_job("j1"), "now"))
            .unwrap();
        let raw_blob: Vec<u8> = store
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT payload FROM scheduled_job WHERE id='j1';",
                    [],
                    |row| row.get::<_, Vec<u8>>(0),
                )
                .map_err(StoreError::from)
            })
            .unwrap();
        // The plaintext name must never appear in the ciphertext blob.
        assert!(
            !String::from_utf8_lossy(&raw_blob).contains("Weekly brief"),
            "schedule name leaked into plaintext column"
        );
    }

    #[test]
    fn rejects_bad_status_trigger_and_policy() {
        let store = store();
        store
            .transaction(|tx| {
                let mut bad_status = sample_job("a");
                bad_status["status"] = serde_json::json!("bogus");
                assert!(upsert_from_value(tx, &store, "", bad_status, "now").is_err());

                let mut bad_trigger = sample_job("b");
                bad_trigger["trigger"] = serde_json::json!({"kind": "hourly"});
                assert!(upsert_from_value(tx, &store, "", bad_trigger, "now").is_err());

                let mut bad_policy = sample_job("c");
                bad_policy["missedRunPolicy"] = serde_json::json!("always");
                assert!(upsert_from_value(tx, &store, "", bad_policy, "now").is_err());
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn workspace_isolation() {
        let store = store();
        store
            .transaction(|tx| upsert_from_value(tx, &store, "ws-a", sample_job("j1"), "now"))
            .unwrap();
        store
            .transaction(|tx| upsert_from_value(tx, &store, "ws-b", sample_job("j2"), "now"))
            .unwrap();
        let a = store
            .with_conn(|conn| list(conn, &store, "ws-a"))
            .unwrap();
        let b = store
            .with_conn(|conn| list(conn, &store, "ws-b"))
            .unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].id, "j1");
        assert_eq!(b.len(), 1);
        assert_eq!(b[0].id, "j2");
    }
}
