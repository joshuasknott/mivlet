//! Knowledge sources. `connector_id`/`kind`/`trust`/`pinned`/fingerprint/size/
//! imported_at/origin are non-secret query columns; `title`, `provenance`,
//! `freshness`, `content_preview`, and provider metadata are encrypted.
//!
//! This is the stable surface the knowledge-retrieval branch (Goal 8) builds
//! its index against: it reads rows via [`list`] and replaces the *retrieval*
//! implementation without changing this trait.

use rusqlite::{Connection, OptionalExtension};
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
    let tombstoned: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM knowledge_tombstone WHERE workspace_id=?1 AND id=?2);",
        rusqlite::params![scope.workspace_id(), id],
        |row| row.get(0),
    )?;
    if tombstoned {
        return Err(StoreError::Invalid(
            "Deleted knowledge cannot be restored by routine import or synchronization.".into(),
        ));
    }
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
    let connector_account_id = value
        .get("account")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let external_id = value
        .get("externalId")
        .or_else(|| value.get("providerItemId"))
        .and_then(Value::as_str)
        .unwrap_or("")
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
    let disabled = value
        .get("disabled")
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
        "providerMetadata": safe_provider_metadata(value.get("providerMetadata")),
        "scope": value.get("scope").cloned().unwrap_or(Value::Null),
        "approvedAt": value.get("approvedAt").and_then(Value::as_str).unwrap_or(""),
    });
    let sealed = seal_json(store, &payload, &aad(scope.workspace_id(), &id))?;
    tx.execute(
        "INSERT INTO knowledge_source (workspace_id, id, project_id, connector_id,
              connector_account_id, external_id, kind, trust, pinned, disabled,
              content_fingerprint, size_bytes, imported_at, origin, payload, payload_nonce)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
         ON CONFLICT(workspace_id, id) DO UPDATE SET
           connector_id=excluded.connector_id,
           connector_account_id=excluded.connector_account_id,
           external_id=excluded.external_id,
           kind=excluded.kind, trust=excluded.trust,
           pinned=excluded.pinned, disabled=excluded.disabled,
           content_fingerprint=excluded.content_fingerprint,
           size_bytes=excluded.size_bytes, imported_at=excluded.imported_at,
           origin=excluded.origin,
           payload=excluded.payload, payload_nonce=excluded.payload_nonce;",
        rusqlite::params![
            scope.workspace_id(),
            id,
            scope.project_id(),
            connector_id,
            connector_account_id,
            external_id,
            kind,
            trust,
            pinned as i64,
            disabled as i64,
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
    pub connector_account_id: String,
    pub external_id: String,
    pub kind: String,
    pub trust: String,
    pub pinned: bool,
    pub disabled: bool,
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
        "SELECT id, workspace_id, project_id, connector_id, connector_account_id, external_id,
                kind, trust, pinned, disabled, content_fingerprint,
                size_bytes, imported_at, origin, payload, payload_nonce
         FROM knowledge_source
         WHERE workspace_id=?1 AND project_id IS ?2 AND disabled=0
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
                    connector_account_id: row.get(4)?,
                    external_id: row.get(5)?,
                    kind: row.get(6)?,
                    trust: row.get(7)?,
                    pinned: row.get::<_, i64>(8)? != 0,
                    disabled: row.get::<_, i64>(9)? != 0,
                    content_fingerprint: row.get(10)?,
                    size_bytes: row.get(11)?,
                    imported_at: row.get(12)?,
                    origin: row.get(13)?,
                    sealed: Sealed {
                        ciphertext: row.get(14)?,
                        nonce: row.get(15)?,
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
            connector_account_id: p.connector_account_id,
            external_id: p.external_id,
            kind: p.kind,
            trust: p.trust,
            pinned: p.pinned,
            disabled: p.disabled,
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
    let exists = tx
        .query_row(
            "SELECT 1 FROM knowledge_source WHERE workspace_id=?1 AND id=?2 AND project_id IS ?3;",
            rusqlite::params![scope.workspace_id(), id, scope.project_id()],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !exists {
        return Ok(());
    }
    tx.execute(
        "INSERT OR REPLACE INTO knowledge_tombstone (workspace_id, id, deleted_at) VALUES (?1, ?2, ?3);",
        rusqlite::params![scope.workspace_id(), id, unix_timestamp()],
    )?;
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
    connector_account_id: String,
    external_id: String,
    kind: String,
    trust: String,
    pinned: bool,
    disabled: bool,
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

fn unix_timestamp() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

fn safe_provider_metadata(value: Option<&Value>) -> Value {
    let Some(Value::Object(map)) = value else {
        return Value::Object(Default::default());
    };
    let mut safe = serde_json::Map::new();
    for (key, value) in map {
        let lower = key.to_ascii_lowercase();
        if [
            "token",
            "secret",
            "password",
            "authorization",
            "cookie",
            "credential",
            "apikey",
        ]
        .iter()
        .any(|marker| lower.contains(marker))
        {
            continue;
        }
        if matches!(
            value,
            Value::String(_) | Value::Number(_) | Value::Bool(_) | Value::Null
        ) {
            safe.insert(key.clone(), value.clone());
        }
    }
    Value::Object(safe)
}
