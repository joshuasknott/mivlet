//! Knowledge sources. `connector_id`/`kind`/`trust`/`pinned`/fingerprint/size/
//! imported_at/origin are non-secret query columns; `title`, `provenance`,
//! `freshness`, `content_preview`, and provider metadata are encrypted.
//!
//! This is the stable surface the knowledge-retrieval branch (Goal 8) builds
//! its index against: it reads rows via [`list`] and replaces the *retrieval*
//! implementation without changing this trait.

use rusqlite::Connection;
use serde_json::Value;

use crate::store::repos::scope::{ensure_record_owner, DataScope};
use crate::store::repos::{open_json, seal_json};
use crate::store::{Result, Store, StoreError};

/// Upsert a knowledge source from a legacy `LocalFileImport` /
/// `ConnectorKnowledgeSource` JSON value.
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
        .ok_or_else(|| StoreError::Invalid("Knowledge source is missing an id.".into()))?
        .to_string();
    ensure_record_owner(tx, "knowledge_source", &id, scope)?;
    let connector_id = value
        .get("connectorId")
        .and_then(Value::as_str)
        .unwrap_or("local-files")
        .to_string();
    let kind = value
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("document")
        .to_string();
    let trust = value
        .get("trust")
        .and_then(Value::as_str)
        .unwrap_or("untrusted")
        .to_string();
    let pinned = value
        .get("pinned")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let fingerprint = value
        .get("contentFingerprint")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let size_bytes = value.get("sizeBytes").and_then(Value::as_u64).unwrap_or(0) as i64;
    let imported_at = value
        .get("importedAt")
        .and_then(Value::as_str)
        .unwrap_or(now)
        .to_string();
    let origin = value
        .get("origin")
        .and_then(Value::as_str)
        .unwrap_or("local-import")
        .to_string();
    let payload = serde_json::json!({
        "title": value.get("title").and_then(Value::as_str).unwrap_or(""),
        "provenance": value.get("provenance").and_then(Value::as_str).unwrap_or(""),
        "freshness": value.get("freshness").and_then(Value::as_str).unwrap_or(""),
        "contentPreview": value.get("contentPreview").and_then(Value::as_str).unwrap_or(""),
        "providerMetadata": value.get("providerMetadata").cloned().unwrap_or(Value::Object(Default::default())),
    });
    let sealed = seal_json(store, &payload, &aad(scope.workspace_id(), &id))?;
    tx.execute(
        "INSERT INTO knowledge_source (id, workspace_id, project_id, connector_id, kind, trust, pinned,
              content_fingerprint, size_bytes, imported_at, origin, payload, payload_nonce)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(id) DO UPDATE SET
           pinned=excluded.pinned,
           payload=excluded.payload, payload_nonce=excluded.payload_nonce;",
        rusqlite::params![
            id,
            scope.workspace_id(),
            scope.project_id(),
            connector_id,
            kind,
            trust,
            pinned as i64,
            fingerprint,
            size_bytes,
            imported_at,
            origin,
            sealed.ciphertext,
            sealed.nonce,
        ],
    )?;
    Ok(())
}

pub struct KnowledgeRow {
    pub id: String,
    pub workspace_id: String,
    pub project_id: Option<String>,
    pub connector_id: String,
    pub kind: String,
    pub trust: String,
    pub pinned: bool,
    pub content_fingerprint: String,
    pub size_bytes: i64,
    pub imported_at: String,
    pub origin: String,
    pub payload: Value,
}

pub fn list(tx: &Connection, store: &Store) -> Result<Vec<KnowledgeRow>> {
    list_scoped(tx, store, &DataScope::legacy_default())
}

pub fn list_scoped(tx: &Connection, store: &Store, scope: &DataScope) -> Result<Vec<KnowledgeRow>> {
    scope.ensure_exists(tx)?;
    let mut stmt = tx.prepare(
        "SELECT id, workspace_id, project_id, connector_id, kind, trust, pinned, content_fingerprint,
                size_bytes, imported_at, origin, payload, payload_nonce
         FROM knowledge_source
         WHERE workspace_id=?1 AND project_id IS ?2
         ORDER BY imported_at DESC;",
    )?;
    let partials: Vec<Partial> = stmt
        .query_map(
            rusqlite::params![scope.workspace_id(), scope.project_id()],
            |row| {
                Ok(Partial {
                    id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    project_id: row.get(2)?,
                    connector_id: row.get(3)?,
                    kind: row.get(4)?,
                    trust: row.get(5)?,
                    pinned: row.get::<_, i64>(6)? != 0,
                    content_fingerprint: row.get(7)?,
                    size_bytes: row.get(8)?,
                    imported_at: row.get(9)?,
                    origin: row.get(10)?,
                    sealed: Sealed {
                        ciphertext: row.get(11)?,
                        nonce: row.get(12)?,
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
        out.push(KnowledgeRow {
            id: p.id,
            workspace_id: p.workspace_id,
            project_id: p.project_id,
            connector_id: p.connector_id,
            kind: p.kind,
            trust: p.trust,
            pinned: p.pinned,
            content_fingerprint: p.content_fingerprint,
            size_bytes: p.size_bytes,
            imported_at: p.imported_at,
            origin: p.origin,
            payload,
        });
    }
    Ok(out)
}

/// Delete a knowledge source by id.
pub fn delete(tx: &Connection, id: &str) -> Result<()> {
    delete_scoped(tx, &DataScope::legacy_default(), id)
}

pub fn delete_scoped(tx: &Connection, scope: &DataScope, id: &str) -> Result<()> {
    scope.ensure_exists(tx)?;
    tx.execute(
        "DELETE FROM knowledge_source
         WHERE id = ?1 AND workspace_id = ?2 AND project_id IS ?3;",
        rusqlite::params![id, scope.workspace_id(), scope.project_id()],
    )?;
    Ok(())
}

struct Partial {
    id: String,
    workspace_id: String,
    project_id: Option<String>,
    connector_id: String,
    kind: String,
    trust: String,
    pinned: bool,
    content_fingerprint: String,
    size_bytes: i64,
    imported_at: String,
    origin: String,
    sealed: Sealed,
}

use crate::store::vault::Sealed;

fn aad(workspace_id: &str, id: &str) -> String {
    format!("knowledge_source:{workspace_id}:{id}")
}

fn legacy_aad(id: &str) -> String {
    format!("knowledge_source:{id}")
}
