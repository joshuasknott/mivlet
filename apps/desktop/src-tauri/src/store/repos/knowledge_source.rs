//! Knowledge sources. `connector_id`/`kind`/`trust`/`pinned`/fingerprint/size/
//! imported_at/origin are non-secret query columns; `title`, `provenance`,
//! `freshness`, `content_preview`, and provider metadata are encrypted.
//!
//! This is the stable surface the knowledge-retrieval branch (Goal 8) builds
//! its index against: it reads rows via [`list`] and replaces the *retrieval*
//! implementation without changing this trait.

use rusqlite::Connection;
use serde_json::Value;

use crate::store::repos::{open_json, seal_json};
use crate::store::{Result, Store, StoreError};

/// Upsert a knowledge source from a legacy `LocalFileImport` /
/// `ConnectorKnowledgeSource` JSON value.
pub fn upsert_from_value(tx: &Connection, store: &Store, value: Value, now: &str) -> Result<()> {
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| StoreError::Invalid("Knowledge source is missing an id.".into()))?
        .to_string();
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
    let sealed = seal_json(store, &payload, &aad(&id))?;
    tx.execute(
        "INSERT INTO knowledge_source (id, connector_id, kind, trust, pinned,
              content_fingerprint, size_bytes, imported_at, origin, payload, payload_nonce)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(id) DO UPDATE SET
           pinned=excluded.pinned,
           payload=excluded.payload, payload_nonce=excluded.payload_nonce;",
        rusqlite::params![
            id,
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
    let mut stmt = tx.prepare(
        "SELECT id, connector_id, kind, trust, pinned, content_fingerprint,
                size_bytes, imported_at, origin, payload, payload_nonce
         FROM knowledge_source ORDER BY imported_at DESC;",
    )?;
    let partials: Vec<Partial> = stmt
        .query_map([], |row| {
            Ok(Partial {
                id: row.get(0)?,
                connector_id: row.get(1)?,
                kind: row.get(2)?,
                trust: row.get(3)?,
                pinned: row.get::<_, i64>(4)? != 0,
                content_fingerprint: row.get(5)?,
                size_bytes: row.get(6)?,
                imported_at: row.get(7)?,
                origin: row.get(8)?,
                sealed: Sealed {
                    ciphertext: row.get(9)?,
                    nonce: row.get(10)?,
                },
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut out = Vec::with_capacity(partials.len());
    for p in partials {
        let payload = open_json(store, &p.sealed, &aad(&p.id))?;
        out.push(KnowledgeRow {
            id: p.id,
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
    tx.execute(
        "DELETE FROM knowledge_source WHERE id = ?1;",
        rusqlite::params![id],
    )?;
    Ok(())
}

struct Partial {
    id: String,
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

fn aad(id: &str) -> String {
    format!("knowledge_source:{id}")
}
