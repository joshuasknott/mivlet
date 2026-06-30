//! Workspace-scoped workflow definitions and run journal.

use rusqlite::Connection;
use serde_json::Value;

use crate::store::repos::scope::DataScope;
use crate::store::repos::{open_json, seal_json};
use crate::store::vault::Sealed;
use crate::store::{Result, Store};

pub fn upsert_definition(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    id: &str,
    version: u32,
    created_at: &str,
    updated_at: &str,
    payload: &Value,
) -> Result<()> {
    scope.ensure_exists(tx)?;
    let sealed = seal_json(
        store,
        payload,
        &definition_aad(scope.workspace_id(), id, version),
    )?;
    let changed = tx.execute(
        "INSERT INTO workflow_definition (
           workspace_id, project_id, id, version, created_at, updated_at, payload, payload_nonce
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(workspace_id, id, version) DO UPDATE SET
           project_id=excluded.project_id, updated_at=excluded.updated_at,
           payload=excluded.payload, payload_nonce=excluded.payload_nonce
         WHERE workflow_definition.project_id IS excluded.project_id;",
        rusqlite::params![
            scope.workspace_id(),
            scope.project_id(),
            id,
            version,
            created_at,
            updated_at,
            sealed.ciphertext,
            sealed.nonce
        ],
    )?;
    if changed == 0 {
        return Err(crate::store::StoreError::Invalid(
            "Workflow definition is owned by another project.".into(),
        ));
    }
    Ok(())
}

pub fn list_definitions(tx: &Connection, store: &Store, scope: &DataScope) -> Result<Vec<Value>> {
    scope.ensure_exists(tx)?;
    let mut stmt = tx.prepare(
        "SELECT id, version, payload, payload_nonce FROM workflow_definition
         WHERE workspace_id=?1 AND project_id IS ?2
         ORDER BY updated_at DESC, version DESC;",
    )?;
    let rows = stmt
        .query_map(
            rusqlite::params![scope.workspace_id(), scope.project_id()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, u32>(1)?,
                    Sealed {
                        ciphertext: row.get(2)?,
                        nonce: row.get(3)?,
                    },
                ))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|(id, version, sealed)| {
            open_json(
                store,
                &sealed,
                &definition_aad(scope.workspace_id(), &id, version),
            )
        })
        .collect()
}

pub fn upsert_run(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    id: &str,
    definition_id: &str,
    definition_version: u32,
    status: &str,
    started_at: &str,
    updated_at: &str,
    payload: &Value,
) -> Result<()> {
    scope.ensure_exists(tx)?;
    let sealed = seal_json(store, payload, &run_aad(scope.workspace_id(), id))?;
    let changed = tx.execute(
        "INSERT INTO workflow_run (
           workspace_id, project_id, id, definition_id, definition_version,
           status, started_at, updated_at, payload, payload_nonce
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(workspace_id, id) DO UPDATE SET
           project_id=excluded.project_id, status=excluded.status,
           updated_at=excluded.updated_at, payload=excluded.payload,
           payload_nonce=excluded.payload_nonce
         WHERE workflow_run.project_id IS excluded.project_id;",
        rusqlite::params![
            scope.workspace_id(),
            scope.project_id(),
            id,
            definition_id,
            definition_version,
            status,
            started_at,
            updated_at,
            sealed.ciphertext,
            sealed.nonce
        ],
    )?;
    if changed == 0 {
        return Err(crate::store::StoreError::Invalid(
            "Workflow run is owned by another project.".into(),
        ));
    }
    Ok(())
}

pub fn list_runs(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    definition_id: Option<&str>,
) -> Result<Vec<Value>> {
    scope.ensure_exists(tx)?;
    let mut stmt = tx.prepare(
        "SELECT id, payload, payload_nonce FROM workflow_run
         WHERE workspace_id=?1 AND project_id IS ?2
           AND (?3 IS NULL OR definition_id=?3)
         ORDER BY updated_at DESC;",
    )?;
    let rows = stmt
        .query_map(
            rusqlite::params![scope.workspace_id(), scope.project_id(), definition_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    Sealed {
                        ciphertext: row.get(1)?,
                        nonce: row.get(2)?,
                    },
                ))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|(id, sealed)| open_json(store, &sealed, &run_aad(scope.workspace_id(), &id)))
        .collect()
}

fn definition_aad(workspace_id: &str, id: &str, version: u32) -> String {
    format!("workflow_definition:{workspace_id}:{id}:{version}")
}

fn run_aad(workspace_id: &str, id: &str) -> String {
    format!("workflow_run:{workspace_id}:{id}")
}
