//! Workflow definitions + run journal — encrypted, workspace-scoped.
//!
//! Definitions are keyed `(workspace_id, id, version)` so versioned history is
//! retained without duplication; runs are keyed by their own id and scoped to a
//! workspace. The full step list (free-text prompts are sensitive), the run
//! inputs/steps, and the idempotency key live in the encrypted payload; query
//! columns are non-secret identity/status/trigger/timestamp fields.

use rusqlite::Connection;
use serde_json::Value;

use crate::models::{
    WORKFLOW_RUN_STATUSES, WORKFLOW_RUN_STORE_VERSION, MAX_WORKFLOW_RUNS,
};
use crate::store::repos::{open_json, seal_json, payload_of};
use crate::store::repos::scheduled_job::normalize_workspace;
use crate::store::{Result, Store, StoreError};

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

/// Upsert a workflow definition from its wire `Value` (the camelCase
/// `WorkflowDefinitionRecord` shape). Validates `schemaVersion`, id/name, and a
/// bounded step count. Versioned history is preserved (each version is its own
/// row), capped at `MAX_WORKFLOW_DEFINITION_VERSIONS` per definition.
pub fn upsert_definition_from_value(
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
        .ok_or_else(|| StoreError::Invalid("Workflow definition is missing an id.".into()))?
        .to_string();
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if name.is_empty() {
        return Err(StoreError::Invalid(
            "Workflow definition needs a name.".into(),
        ));
    }
    let version = value
        .get("version")
        .and_then(Value::as_u64)
        .unwrap_or(0) as i64;
    if version == 0 {
        return Err(StoreError::Invalid(
            "Workflow definition version must be positive.".into(),
        ));
    }
    let schema_version = value
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .unwrap_or(WORKFLOW_RUN_STORE_VERSION as u64) as i64;
    if schema_version != WORKFLOW_RUN_STORE_VERSION as i64 {
        return Err(StoreError::Invalid(
            "Workflow definition schema version is not supported.".into(),
        ));
    }
    let step_count = value
        .get("steps")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    if step_count == 0 || step_count > crate::models::MAX_WORKFLOW_STEPS {
        return Err(StoreError::Invalid(
            "Workflow definition has an unsupported number of steps.".into(),
        ));
    }
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
    let sealed = seal_json(store, &value, &aad_definition(&workspace_id, &id, version))?;
    tx.execute(
        "INSERT INTO workflow_definition
           (workspace_id, id, version, schema_version, created_at, updated_at,
            payload, payload_nonce)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(workspace_id, id, version) DO UPDATE SET
           schema_version=excluded.schema_version, updated_at=excluded.updated_at,
           payload=excluded.payload, payload_nonce=excluded.payload_nonce;",
        rusqlite::params![
            workspace_id,
            id,
            version,
            schema_version,
            created_at,
            updated_at,
            sealed.ciphertext,
            sealed.nonce
        ],
    )?;
    // Cap versioned history per definition (newest first).
    tx.execute(
        "DELETE FROM workflow_definition
         WHERE workspace_id=?1 AND id=?2 AND version NOT IN (
           SELECT version FROM workflow_definition
           WHERE workspace_id=?1 AND id=?2
           ORDER BY version DESC LIMIT ?3
         );",
        rusqlite::params![workspace_id, id, MAX_WORKFLOW_DEFINITION_VERSIONS],
    )?;
    Ok(())
}

/// Bound on retained versions per definition (matches the legacy 500 cap on the
/// flat JSON list, applied per-definition here).
const MAX_WORKFLOW_DEFINITION_VERSIONS: i64 = 50;

pub struct WorkflowDefinitionRow {
    pub workspace_id: String,
    pub id: String,
    pub version: i64,
    pub value: Value,
}

/// List the newest version of each definition in a workspace, newest first.
pub fn list_definitions(
    tx: &Connection,
    store: &Store,
    workspace_id: &str,
) -> Result<Vec<WorkflowDefinitionRow>> {
    let workspace_id = normalize_workspace(workspace_id);
    let mut stmt = tx.prepare(
        "SELECT workspace_id, id, version, payload, payload_nonce FROM workflow_definition
         WHERE workspace_id = ?1
         ORDER BY updated_at DESC;",
    )?;
    let collected: Vec<(String, String, i64, crate::store::vault::Sealed)> = stmt
        .query_map(rusqlite::params![workspace_id], |row| {
            Ok((
                row.get::<_, String>("workspace_id")?,
                row.get::<_, String>("id")?,
                row.get::<_, i64>("version")?,
                payload_of(row)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    // Collapse to the newest version per id (versions are ordered newest-first
    // by updated_at, but keep the explicit dedup for determinism).
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::with_capacity(collected.len());
    for (ws, id, version, sealed) in collected {
        if !seen.insert(id.clone()) {
            continue;
        }
        let value = open_json(store, &sealed, &aad_definition(&ws, &id, version))?;
        out.push(WorkflowDefinitionRow {
            workspace_id: ws,
            id,
            version,
            value,
        });
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/// Upsert a workflow run from its wire `Value` (the camelCase
/// `WorkflowRunRecord` shape). Validates id, definition id, status, trigger.
/// Replaces an existing run with the same id; history is capped at
/// `MAX_WORKFLOW_RUNS` per workspace.
pub fn upsert_run_from_value(
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
        .ok_or_else(|| StoreError::Invalid("Workflow run is missing an id.".into()))?
        .to_string();
    let definition_id = value
        .get("definitionId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| StoreError::Invalid("Workflow run needs a definition id.".into()))?
        .to_string();
    let status = value
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if !WORKFLOW_RUN_STATUSES.contains(&status.as_str()) {
        return Err(StoreError::Invalid(
            "Workflow run status is not recognized.".into(),
        ));
    }
    let trigger = value
        .get("trigger")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if !matches!(trigger.as_str(), "schedule" | "manual" | "voice") {
        return Err(StoreError::Invalid(
            "Workflow run trigger is not recognized.".into(),
        ));
    }
    let definition_version = value
        .get("definitionVersion")
        .and_then(Value::as_u64)
        .unwrap_or(0) as i64;
    let scheduled_job_id = value
        .get("scheduledJobId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let started_at = value
        .get("startedAt")
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
    let finished_at = value
        .get("finishedAt")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let sealed = seal_json(store, &value, &aad_run(&workspace_id, &id))?;
    tx.execute(
        "INSERT INTO workflow_run
           (id, workspace_id, definition_id, definition_version, status, trigger,
            scheduled_job_id, started_at, updated_at, finished_at, payload,
            payload_nonce)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(id) DO UPDATE SET
           definition_id=excluded.definition_id,
           definition_version=excluded.definition_version, status=excluded.status,
           trigger=excluded.trigger, scheduled_job_id=excluded.scheduled_job_id,
           updated_at=excluded.updated_at, finished_at=excluded.finished_at,
           payload=excluded.payload, payload_nonce=excluded.payload_nonce;",
        rusqlite::params![
            id,
            workspace_id,
            definition_id,
            definition_version,
            status,
            trigger,
            scheduled_job_id,
            started_at,
            updated_at,
            finished_at,
            sealed.ciphertext,
            sealed.nonce
        ],
    )?;
    // Bound run history per workspace (drop oldest past the cap).
    tx.execute(
        "DELETE FROM workflow_run WHERE workspace_id=?1 AND id NOT IN (
           SELECT id FROM workflow_run WHERE workspace_id=?1
           ORDER BY started_at DESC LIMIT ?2
         );",
        rusqlite::params![workspace_id, MAX_WORKFLOW_RUNS],
    )?;
    Ok(())
}

pub struct WorkflowRunRow {
    pub id: String,
    pub workspace_id: String,
    pub definition_id: String,
    pub value: Value,
}

/// List workflow runs in a workspace, newest first.
pub fn list_runs(
    tx: &Connection,
    store: &Store,
    workspace_id: &str,
) -> Result<Vec<WorkflowRunRow>> {
    let workspace_id = normalize_workspace(workspace_id);
    let mut stmt = tx.prepare(
        "SELECT id, workspace_id, definition_id, payload, payload_nonce FROM workflow_run
         WHERE workspace_id = ?1 ORDER BY started_at DESC;",
    )?;
    let collected: Vec<(String, String, String, crate::store::vault::Sealed)> = stmt
        .query_map(rusqlite::params![workspace_id], |row| {
            Ok((
                row.get::<_, String>("id")?,
                row.get::<_, String>("workspace_id")?,
                row.get::<_, String>("definition_id")?,
                payload_of(row)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    decode_runs(store, collected)
}

/// List runs for a specific definition in a workspace.
pub fn list_runs_for_definition(
    tx: &Connection,
    store: &Store,
    workspace_id: &str,
    definition_id: &str,
) -> Result<Vec<WorkflowRunRow>> {
    let workspace_id = normalize_workspace(workspace_id);
    let mut stmt = tx.prepare(
        "SELECT id, workspace_id, definition_id, payload, payload_nonce FROM workflow_run
         WHERE workspace_id = ?1 AND definition_id = ?2 ORDER BY started_at DESC;",
    )?;
    let collected: Vec<(String, String, String, crate::store::vault::Sealed)> = stmt
        .query_map(rusqlite::params![workspace_id, definition_id], |row| {
            Ok((
                row.get::<_, String>("id")?,
                row.get::<_, String>("workspace_id")?,
                row.get::<_, String>("definition_id")?,
                payload_of(row)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    decode_runs(store, collected)
}

fn decode_runs(
    store: &Store,
    collected: Vec<(String, String, String, crate::store::vault::Sealed)>,
) -> Result<Vec<WorkflowRunRow>> {
    let mut out = Vec::with_capacity(collected.len());
    for (id, workspace_id, definition_id, sealed) in collected {
        let value = open_json(store, &sealed, &aad_run(&workspace_id, &id))?;
        out.push(WorkflowRunRow {
            id,
            workspace_id,
            definition_id,
            value,
        });
    }
    Ok(out)
}

fn aad_definition(workspace_id: &str, id: &str, version: i64) -> String {
    format!("workflow_definition:{workspace_id}:{id}:{version}")
}

fn aad_run(workspace_id: &str, id: &str) -> String {
    format!("workflow_run:{workspace_id}:{id}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::vault::{MasterKey, Vault};

    fn store() -> Store {
        Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap()
    }

    fn sample_definition(id: &str, version: i64) -> Value {
        serde_json::json!({
            "id": id,
            "version": version,
            "schemaVersion": WORKFLOW_RUN_STORE_VERSION,
            "name": "Daily brief",
            "description": "A transparent brief",
            "steps": [{"kind":"prompt","id":"prompt","prompt":"Summarize the day"}],
            "notificationPrefs": null,
            "createdAt": "2026-06-28T10:00:00Z",
            "updatedAt": "2026-06-28T10:00:00Z"
        })
    }

    fn sample_run(id: &str, status: &str) -> Value {
        serde_json::json!({
            "id": id,
            "definitionId": "wf",
            "definitionVersion": 1,
            "status": status,
            "trigger": "manual",
            "scheduledJobId": null,
            "input": {"prompt": "secret-prompt-text"},
            "steps": [],
            "failureReason": null,
            "idempotencyKey": "wf:".to_string() + id,
            "startedAt": "2026-06-28T10:00:00Z",
            "updatedAt": "2026-06-28T10:00:00Z",
            "finishedAt": null
        })
    }

    #[test]
    fn round_trips_definitions_and_runs() {
        let store = store();
        store
            .transaction(|tx| {
                upsert_definition_from_value(tx, &store, "", sample_definition("wf", 1), "now")?;
                upsert_run_from_value(tx, &store, "", sample_run("r1", "completed"), "now")?;
                Ok(())
            })
            .unwrap();
        let defs = store
            .with_conn(|conn| list_definitions(conn, &store, ""))
            .unwrap();
        assert_eq!(defs.len(), 1);
        assert_eq!(defs[0].value["name"], "Daily brief");
        let runs = store
            .with_conn(|conn| list_runs(conn, &store, ""))
            .unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].value["status"], "completed");
    }

    #[test]
    fn definition_versions_are_retained() {
        let store = store();
        store
            .transaction(|tx| {
                upsert_definition_from_value(tx, &store, "", sample_definition("wf", 1), "now")?;
                upsert_definition_from_value(tx, &store, "", sample_definition("wf", 2), "now")?;
                Ok(())
            })
            .unwrap();
        let stmt_count = |store: &Store| -> i64 {
            store
                .with_conn(|conn| {
                    conn.query_row(
                        "SELECT COUNT(*) FROM workflow_definition WHERE id='wf';",
                        [],
                        |row| row.get::<_, i64>(0),
                    )
                    .map_err(StoreError::from)
                })
                .unwrap()
        };
        assert_eq!(stmt_count(&store), 2);
    }

    #[test]
    fn payload_is_encrypted_at_rest() {
        let store = store();
        store
            .transaction(|tx| {
                upsert_run_from_value(tx, &store, "", sample_run("r1", "completed"), "now")?;
                Ok(())
            })
            .unwrap();
        let raw_blob: Vec<u8> = store
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT payload FROM workflow_run WHERE id='r1';",
                    [],
                    |row| row.get::<_, Vec<u8>>(0),
                )
                .map_err(StoreError::from)
            })
            .unwrap();
        assert!(
            !String::from_utf8_lossy(&raw_blob).contains("secret-prompt-text"),
            "run input leaked into plaintext"
        );
    }

    #[test]
    fn rejects_bad_status_and_trigger() {
        let store = store();
        store
            .transaction(|tx| {
                let mut bad_status = sample_run("r1", "completed");
                bad_status["status"] = serde_json::json!("bogus");
                assert!(upsert_run_from_value(tx, &store, "", bad_status, "now").is_err());

                let mut bad_trigger = sample_run("r2", "completed");
                bad_trigger["trigger"] = serde_json::json!("auto");
                assert!(upsert_run_from_value(tx, &store, "", bad_trigger, "now").is_err());
                Ok(())
            })
            .unwrap();
    }
}
