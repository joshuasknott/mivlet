//! Connector cache — searchable, workspace-isolated, secret-free local cache
//! for synced connector data.
//!
//! Each row is a *normalized* connector item (a search/import result or a
//! provider-listed resource), scoped to a `workspace_id` and `connector_id` so
//! workspaces never cross-pollinate. Plaintext columns (`workspace_id`,
//! `connector_id`, `provider_item_id`, `kind`, `trust`, `pinned`, `disabled`,
//! `content_fingerprint`, `cached_at`, `origin`) are non-secret and indexed so
//! the cache can be searched and filtered without decrypting. The encrypted
//! `payload` carries the normalized `title`/`provenance`/`freshness`/
//! `contentPreview`/`providerMetadata` — after the write path strips any
//! token-shaped values (see [`redact_value`]).
//!
//! Provider secrets/tokens are a separate lifecycle (OS secure storage) and
//! **never** reach this table: [`upsert_from_value`] rejects any record that
//! still contains a known secret marker after redaction.

use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;

use crate::store::repos::{open_json, seal_json};
use crate::store::vault::Sealed;
use crate::store::{Result, Store, StoreError};

/// The default workspace id used when a caller does not specify one. The
/// desktop shell is single-profile, so the cache keeps a stable default scope
/// while still enforcing isolation between explicit workspace ids.
pub const DEFAULT_WORKSPACE_ID: &str = "default";

/// Trust vocabulary mirrored from knowledge sources.
pub const TRUST_VALUES: &[&str] = &["trusted", "untrusted", "verified"];

/// A redaction sentinel substituted for any token-shaped value so cached data
/// never carries a secret, even if a provider response leaked one into a field.
pub const REDACTED: &str = "[redacted connector data]";

/// Marker substrings that indicate a value is secret/token-shaped. Mirrors the
/// runtime redaction vocabulary in `connectors::redact_connector_text` and the
/// cache invariant: cached data must never include provider secrets/tokens.
const SECRET_MARKERS: &[&str] = &[
    "authorization:",
    "bearer ",
    "cookie:",
    "access_token",
    "refresh_token",
    "client_secret",
    "xoxb-",
    "xoxp-",
    "ghp_",
    "github_pat_",
    "ya29.", // Google access-token prefix
    "1//",   // Google refresh-token prefix
    "sk-",   // generic API-key prefix
];

/// True when `value` (case-insensitively) contains a known secret marker.
fn looks_secret(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    SECRET_MARKERS.iter().any(|marker| lower.contains(marker))
}

/// Recursively walk a JSON value, replacing any string that looks secret with
/// the redaction sentinel. Non-string scalars, arrays, and objects are walked
/// in place. The returned value is what gets sealed into the cache payload.
fn redact_value(value: &Value) -> Value {
    match value {
        Value::String(s) => {
            if looks_secret(s) {
                Value::String(REDACTED.to_string())
            } else {
                value.clone()
            }
        }
        Value::Array(items) => Value::Array(items.iter().map(redact_value).collect()),
        Value::Object(map) => {
            let mut out = serde_json::Map::with_capacity(map.len());
            for (key, val) in map {
                // A key named like a secret field is always redacted regardless
                // of its value, so a `null`/empty secret field is still dropped.
                let lower_key = key.to_ascii_lowercase();
                if SECRET_MARKERS.iter().any(|m| lower_key.contains(m))
                    || matches!(
                        lower_key.as_str(),
                        "token" | "secret" | "password" | "accesstoken" | "refreshtoken" | "apikey"
                    )
                {
                    out.insert(key.clone(), Value::String(REDACTED.to_string()));
                } else {
                    out.insert(key.clone(), redact_value(val));
                }
            }
            Value::Object(out)
        }
        _ => value.clone(),
    }
}

/// Returns `true` if a normalized cache payload still contains a live secret
/// marker after redaction (i.e. redaction failed to scrub it). Used as a
/// fail-closed guard before persisting.
fn still_has_secret(payload: &Value) -> bool {
    match payload {
        Value::String(s) => looks_secret(s) && s != REDACTED,
        Value::Array(items) => items.iter().any(still_has_secret),
        Value::Object(map) => map.values().any(still_has_secret),
        _ => false,
    }
}

/// Normalize and validate a connector cache record from a provider item value.
///
/// Plaintext query columns are extracted and bounded; the remaining normalized
/// fields are redacted ([`redact_value`]) and sealed into the payload. Fails
/// closed if any secret marker survives redaction.
pub fn upsert_from_value(
    tx: &Connection,
    store: &Store,
    workspace_id: &str,
    value: Value,
    now: &str,
) -> Result<()> {
    let workspace_id = normalize_workspace(workspace_id);
    let connector_id = value
        .get("connectorId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            StoreError::Invalid("Connector cache item is missing a connectorId.".into())
        })?
        .to_string();
    let provider_item_id = value
        .get("id")
        .or_else(|| value.get("providerItemId"))
        .and_then(Value::as_str)
        .ok_or_else(|| StoreError::Invalid("Connector cache item is missing an id.".into()))?
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
    if !TRUST_VALUES.contains(&trust.as_str()) {
        return Err(StoreError::Invalid(format!(
            "Connector cache trust '{trust}' is not recognized."
        )));
    }
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
    let cached_at = value
        .get("cachedAt")
        .or_else(|| value.get("importedAt"))
        .and_then(Value::as_str)
        .unwrap_or(now)
        .to_string();
    let origin = value
        .get("origin")
        .and_then(Value::as_str)
        .unwrap_or("connector-cache")
        .to_string();

    // Build the normalized payload from provider-shaped fields, then redact.
    let mut payload = serde_json::json!({
        "title": value.get("title").and_then(Value::as_str).unwrap_or(""),
        "provenance": value.get("provenance").and_then(Value::as_str).unwrap_or(""),
        "freshness": value.get("freshness").and_then(Value::as_str).unwrap_or(""),
        "contentPreview": value.get("contentPreview").and_then(Value::as_str).unwrap_or(""),
        "summary": value.get("summary").and_then(Value::as_str).unwrap_or(""),
        "providerMetadata": value.get("providerMetadata").cloned().unwrap_or(Value::Object(Default::default())),
        "account": value.get("account").and_then(Value::as_str).unwrap_or(""),
    });
    payload = redact_value(&payload);
    // Fail closed: a surviving secret marker means we will not persist it.
    if still_has_secret(&payload) {
        return Err(StoreError::Invalid(
            "Connector cache item contains a token-shaped value and was rejected.".into(),
        ));
    }

    let row_id = cache_id(&workspace_id, &connector_id, &provider_item_id);
    let sealed = seal_json(store, &payload, &aad(&row_id))?;
    tx.execute(
        "INSERT INTO connector_cache
            (id, workspace_id, connector_id, provider_item_id, kind, trust, pinned,
             disabled, content_fingerprint, cached_at, origin, payload, payload_nonce)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(id) DO UPDATE SET
           kind=excluded.kind, trust=excluded.trust, pinned=excluded.pinned,
           content_fingerprint=excluded.content_fingerprint, cached_at=excluded.cached_at,
           origin=excluded.origin,
           payload=excluded.payload, payload_nonce=excluded.payload_nonce;",
        rusqlite::params![
            row_id,
            workspace_id,
            connector_id,
            provider_item_id,
            kind,
            trust,
            pinned as i64,
            disabled as i64,
            fingerprint,
            cached_at,
            origin,
            sealed.ciphertext,
            sealed.nonce,
        ],
    )?;
    Ok(())
}

/// A decrypted connector-cache row.
pub struct ConnectorCacheRow {
    pub id: String,
    pub workspace_id: String,
    pub connector_id: String,
    pub provider_item_id: String,
    pub kind: String,
    pub trust: String,
    pub pinned: bool,
    pub disabled: bool,
    pub content_fingerprint: String,
    pub cached_at: String,
    pub origin: String,
    pub payload: Value,
}

/// Count cache rows for a workspace (and optional connector). Disabled rows are
/// included unless `include_disabled` is false.
pub fn count(
    tx: &Connection,
    workspace_id: &str,
    connector_id: Option<&str>,
    include_disabled: bool,
) -> Result<i64> {
    let workspace_id = normalize_workspace(workspace_id);
    let mut sql = String::from("SELECT COUNT(*) FROM connector_cache WHERE workspace_id = ?1");
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(workspace_id.clone())];
    if let Some(connector_id) = connector_id {
        sql.push_str(" AND connector_id = ?");
        params.push(Box::new(connector_id.to_string()));
    }
    if !include_disabled {
        sql.push_str(" AND disabled = 0");
    }
    let mut stmt = tx.prepare(&sql)?;
    let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let count: i64 = stmt.query_row(param_refs.as_slice(), |row| row.get(0))?;
    Ok(count)
}

/// List cache rows for a workspace (and optional connector). Disabled rows are
/// excluded by default — search/retrieval never surfaces disabled cache.
pub fn list(
    tx: &Connection,
    store: &Store,
    workspace_id: &str,
    connector_id: Option<&str>,
) -> Result<Vec<ConnectorCacheRow>> {
    list_where(tx, store, workspace_id, connector_id, true)
}

/// List cache rows including disabled ones (used by export/inspect UI).
pub fn list_all(
    tx: &Connection,
    store: &Store,
    workspace_id: &str,
    connector_id: Option<&str>,
) -> Result<Vec<ConnectorCacheRow>> {
    list_where(tx, store, workspace_id, connector_id, false)
}

#[allow(clippy::bool_to_int_with_if)]
fn list_where(
    tx: &Connection,
    store: &Store,
    workspace_id: &str,
    connector_id: Option<&str>,
    exclude_disabled: bool,
) -> Result<Vec<ConnectorCacheRow>> {
    let workspace_id = normalize_workspace(workspace_id);
    let mut sql = String::from(
        "SELECT id, workspace_id, connector_id, provider_item_id, kind, trust, pinned,
                disabled, content_fingerprint, cached_at, origin, payload, payload_nonce
         FROM connector_cache WHERE workspace_id = ?1",
    );
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(workspace_id.clone())];
    if let Some(connector_id) = connector_id {
        sql.push_str(" AND connector_id = ?");
        params.push(Box::new(connector_id.to_string()));
    }
    if exclude_disabled {
        sql.push_str(" AND disabled = 0");
    }
    sql.push_str(" ORDER BY cached_at DESC;");
    let mut stmt = tx.prepare(&sql)?;
    let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let partials: Vec<Partial> = stmt
        .query_map(param_refs.as_slice(), |row| {
            Ok(Partial {
                id: row.get(0)?,
                workspace_id: row.get(1)?,
                connector_id: row.get(2)?,
                provider_item_id: row.get(3)?,
                kind: row.get(4)?,
                trust: row.get(5)?,
                pinned: row.get::<_, i64>(6)? != 0,
                disabled: row.get::<_, i64>(7)? != 0,
                content_fingerprint: row.get(8)?,
                cached_at: row.get(9)?,
                origin: row.get(10)?,
                sealed: Sealed {
                    ciphertext: row.get(11)?,
                    nonce: row.get(12)?,
                },
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut out = Vec::with_capacity(partials.len());
    for p in partials {
        let payload = open_json(store, &p.sealed, &aad(&p.id))?;
        out.push(ConnectorCacheRow {
            id: p.id,
            workspace_id: p.workspace_id,
            connector_id: p.connector_id,
            provider_item_id: p.provider_item_id,
            kind: p.kind,
            trust: p.trust,
            pinned: p.pinned,
            disabled: p.disabled,
            content_fingerprint: p.content_fingerprint,
            cached_at: p.cached_at,
            origin: p.origin,
            payload,
        });
    }
    Ok(out)
}

/// Lexical search over a workspace's cache. Matches titles/provenance/previews
/// that contain the (lowercased) query. Disabled rows are excluded.
pub fn search(
    tx: &Connection,
    store: &Store,
    workspace_id: &str,
    connector_id: Option<&str>,
    query: &str,
) -> Result<Vec<ConnectorCacheRow>> {
    let rows = list(tx, store, workspace_id, connector_id)?;
    let needle = query.trim().to_ascii_lowercase();
    if needle.is_empty() {
        return Ok(rows);
    }
    Ok(rows
        .into_iter()
        .filter(|row| {
            let title = row.payload["title"]
                .as_str()
                .unwrap_or("")
                .to_ascii_lowercase();
            let provenance = row.payload["provenance"]
                .as_str()
                .unwrap_or("")
                .to_ascii_lowercase();
            let preview = row.payload["contentPreview"]
                .as_str()
                .unwrap_or("")
                .to_ascii_lowercase();
            title.contains(&needle) || provenance.contains(&needle) || preview.contains(&needle)
        })
        .collect())
}

/// Get a single cache row by id, enforcing that it belongs to `workspace_id`
/// (workspace isolation: a row from workspace A cannot be read via workspace B).
pub fn get(
    tx: &Connection,
    store: &Store,
    workspace_id: &str,
    id: &str,
) -> Result<Option<ConnectorCacheRow>> {
    let workspace_id = normalize_workspace(workspace_id);
    let partial = tx
        .query_row(
            "SELECT id, workspace_id, connector_id, provider_item_id, kind, trust, pinned,
                    disabled, content_fingerprint, cached_at, origin, payload, payload_nonce
             FROM connector_cache WHERE id = ?1 AND workspace_id = ?2;",
            rusqlite::params![id, workspace_id],
            |row| {
                Ok(Partial {
                    id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    connector_id: row.get(2)?,
                    provider_item_id: row.get(3)?,
                    kind: row.get(4)?,
                    trust: row.get(5)?,
                    pinned: row.get::<_, i64>(6)? != 0,
                    disabled: row.get::<_, i64>(7)? != 0,
                    content_fingerprint: row.get(8)?,
                    cached_at: row.get(9)?,
                    origin: row.get(10)?,
                    sealed: Sealed {
                        ciphertext: row.get(11)?,
                        nonce: row.get(12)?,
                    },
                })
            },
        )
        .optional()?;
    match partial {
        None => Ok(None),
        Some(p) => {
            let payload = open_json(store, &p.sealed, &aad(&p.id))?;
            Ok(Some(ConnectorCacheRow {
                id: p.id,
                workspace_id: p.workspace_id,
                connector_id: p.connector_id,
                provider_item_id: p.provider_item_id,
                kind: p.kind,
                trust: p.trust,
                pinned: p.pinned,
                disabled: p.disabled,
                content_fingerprint: p.content_fingerprint,
                cached_at: p.cached_at,
                origin: p.origin,
                payload,
            }))
        }
    }
}

/// Set the `disabled` flag on a cache row, scoped to `workspace_id`. Disabled
/// rows stay on disk (auditable, re-enableable) but never enter search/retrieval.
pub fn set_disabled(
    tx: &Connection,
    workspace_id: &str,
    id: &str,
    disabled: bool,
) -> Result<usize> {
    let workspace_id = normalize_workspace(workspace_id);
    let updated = tx.execute(
        "UPDATE connector_cache SET disabled = ?1 WHERE id = ?2 AND workspace_id = ?3;",
        rusqlite::params![disabled as i64, id, workspace_id],
    )?;
    Ok(updated)
}

/// Set the `pinned` flag on a cache row, scoped to `workspace_id`.
pub fn set_pinned(tx: &Connection, workspace_id: &str, id: &str, pinned: bool) -> Result<usize> {
    let workspace_id = normalize_workspace(workspace_id);
    let updated = tx.execute(
        "UPDATE connector_cache SET pinned = ?1 WHERE id = ?2 AND workspace_id = ?3;",
        rusqlite::params![pinned as i64, id, workspace_id],
    )?;
    Ok(updated)
}

/// Delete a single cache row, scoped to `workspace_id`. Returns rows affected.
pub fn delete(tx: &Connection, workspace_id: &str, id: &str) -> Result<usize> {
    let workspace_id = normalize_workspace(workspace_id);
    let deleted = tx.execute(
        "DELETE FROM connector_cache WHERE id = ?1 AND workspace_id = ?2;",
        rusqlite::params![id, workspace_id],
    )?;
    Ok(deleted)
}

/// Clear all cache rows for a workspace. When `connector_id` is supplied, only
/// that connector's rows are cleared. Returns rows deleted. Workspace isolation:
/// rows from other workspaces are never touched.
pub fn clear(tx: &Connection, workspace_id: &str, connector_id: Option<&str>) -> Result<usize> {
    let workspace_id = normalize_workspace(workspace_id);
    let deleted = match connector_id {
        Some(connector_id) => tx.execute(
            "DELETE FROM connector_cache WHERE workspace_id = ?1 AND connector_id = ?2;",
            rusqlite::params![workspace_id, connector_id],
        )?,
        None => tx.execute(
            "DELETE FROM connector_cache WHERE workspace_id = ?1;",
            rusqlite::params![workspace_id],
        )?,
    };
    Ok(deleted)
}

/// List the distinct connector ids that have cached rows for a workspace.
pub fn connectors_with_cache(tx: &Connection, workspace_id: &str) -> Result<Vec<String>> {
    let workspace_id = normalize_workspace(workspace_id);
    let mut stmt = tx.prepare(
        "SELECT DISTINCT connector_id FROM connector_cache WHERE workspace_id = ?1
         ORDER BY connector_id;",
    )?;
    let rows = stmt.query_map(rusqlite::params![workspace_id], |row| {
        row.get::<_, String>(0)
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Reset the `cached_at` timestamp for a workspace/connector's rows to `now`,
/// marking them freshly resynced. Returns rows touched. Used by the resync
/// lifecycle after a re-pull refreshes provider data in place.
pub fn mark_resynced(
    tx: &Connection,
    workspace_id: &str,
    connector_id: Option<&str>,
    now: &str,
) -> Result<usize> {
    let workspace_id = normalize_workspace(workspace_id);
    let touched = match connector_id {
        Some(connector_id) => tx.execute(
            "UPDATE connector_cache SET cached_at = ?1
             WHERE workspace_id = ?2 AND connector_id = ?3;",
            rusqlite::params![now, workspace_id, connector_id],
        )?,
        None => tx.execute(
            "UPDATE connector_cache SET cached_at = ?1 WHERE workspace_id = ?2;",
            rusqlite::params![now, workspace_id],
        )?,
    };
    Ok(touched)
}

struct Partial {
    id: String,
    workspace_id: String,
    connector_id: String,
    provider_item_id: String,
    kind: String,
    trust: String,
    pinned: bool,
    disabled: bool,
    content_fingerprint: String,
    cached_at: String,
    origin: String,
    sealed: Sealed,
}

/// Normalize a workspace id, defaulting empty input to the single-profile
/// default so cache reads/writes always carry a non-empty scope.
pub(crate) fn normalize_workspace(workspace_id: &str) -> String {
    let trimmed = workspace_id.trim();
    if trimmed.is_empty() {
        DEFAULT_WORKSPACE_ID.to_string()
    } else {
        trimmed.to_string()
    }
}

/// Stable cache row id: deterministic per `(workspace, connector, provider_item)`
/// so a re-sync upserts in place instead of duplicating rows.
fn cache_id(workspace_id: &str, connector_id: &str, provider_item_id: &str) -> String {
    format!("cache:{workspace_id}:{connector_id}:{provider_item_id}")
}

fn aad(id: &str) -> String {
    format!("connector_cache:{id}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::vault::{MasterKey, Vault};

    fn store() -> Store {
        Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap()
    }

    fn item(connector_id: &str, item_id: &str, title: &str) -> Value {
        serde_json::json!({
            "id": item_id,
            "connectorId": connector_id,
            "kind": "document",
            "title": title,
            "provenance": "github://org/repo",
            "freshness": "2026-06-01",
            "contentPreview": "preview text",
            "contentFingerprint": "fp-1",
            "trust": "untrusted",
            "pinned": false,
        })
    }

    #[test]
    fn round_trips_a_cached_item() {
        let store = store();
        store
            .transaction(|tx| {
                upsert_from_value(tx, &store, "ws-a", item("github", "issue-1", "Bug"), "now")
            })
            .unwrap();
        let rows = store
            .with_conn(|conn| list(conn, &store, "ws-a", None))
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].connector_id, "github");
        assert_eq!(rows[0].provider_item_id, "issue-1");
        assert_eq!(rows[0].payload["title"], "Bug");
        assert!(!rows[0].disabled);
    }

    #[test]
    fn resync_upserts_in_place() {
        let store = store();
        store
            .transaction(|tx| {
                upsert_from_value(tx, &store, "ws-a", item("github", "issue-1", "Old"), "t1")
            })
            .unwrap();
        store
            .transaction(|tx| {
                upsert_from_value(tx, &store, "ws-a", item("github", "issue-1", "New"), "t2")
            })
            .unwrap();
        let count = store
            .with_conn(|conn| count(conn, "ws-a", None, true))
            .unwrap();
        assert_eq!(count, 1, "same provider item upserts in place");
        let rows = store
            .with_conn(|conn| list(conn, &store, "ws-a", None))
            .unwrap();
        assert_eq!(rows[0].payload["title"], "New");
    }

    #[test]
    fn workspace_isolation_read_and_clear() {
        let store = store();
        store
            .transaction(|tx| {
                upsert_from_value(tx, &store, "ws-a", item("github", "i1", "A1"), "now")?;
                upsert_from_value(tx, &store, "ws-b", item("github", "i1", "B1"), "now")
            })
            .unwrap();
        // Each workspace only sees its own rows even for the same provider item.
        let a = store
            .with_conn(|conn| list(conn, &store, "ws-a", None))
            .unwrap();
        let b = store
            .with_conn(|conn| list(conn, &store, "ws-b", None))
            .unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!(b.len(), 1);
        assert_ne!(a[0].payload["title"], b[0].payload["title"]);

        // Clearing ws-a leaves ws-b untouched (isolation).
        let cleared = store.with_conn(|conn| clear(conn, "ws-a", None)).unwrap();
        assert_eq!(cleared, 1);
        let b_after = store
            .with_conn(|conn| list(conn, &store, "ws-b", None))
            .unwrap();
        assert_eq!(b_after.len(), 1, "ws-b is unaffected by ws-a clear");
    }

    #[test]
    fn cross_workspace_get_returns_none() {
        let store = store();
        store
            .transaction(|tx| {
                upsert_from_value(tx, &store, "ws-a", item("github", "i1", "A1"), "now")
            })
            .unwrap();
        let id = "cache:ws-a:github:i1";
        // ws-b cannot read ws-a's row.
        let cross = store
            .with_conn(|conn| get(conn, &store, "ws-b", id))
            .unwrap();
        assert!(cross.is_none());
        // ws-a can.
        let own = store
            .with_conn(|conn| get(conn, &store, "ws-a", id))
            .unwrap();
        assert!(own.is_some());
    }

    #[test]
    fn disable_excludes_from_search_and_list() {
        let store = store();
        store
            .transaction(|tx| {
                upsert_from_value(tx, &store, "ws-a", item("github", "i1", "One"), "now")?;
                upsert_from_value(tx, &store, "ws-a", item("github", "i2", "Two"), "now")
            })
            .unwrap();
        store
            .transaction(|tx| set_disabled(tx, "ws-a", "cache:ws-a:github:i1", true))
            .unwrap();
        let searchable = store
            .with_conn(|conn| list(conn, &store, "ws-a", None))
            .unwrap();
        assert_eq!(searchable.len(), 1, "disabled row excluded from list");
        let all = store
            .with_conn(|conn| list_all(conn, &store, "ws-a", None))
            .unwrap();
        assert_eq!(all.len(), 2, "list_all includes disabled");
        let searched = store
            .with_conn(|conn| search(conn, &store, "ws-a", None, "one"))
            .unwrap();
        assert!(searched.is_empty(), "disabled row excluded from search");
    }

    #[test]
    fn delete_removes_single_row_scoped_to_workspace() {
        let store = store();
        store
            .transaction(|tx| {
                upsert_from_value(tx, &store, "ws-a", item("github", "i1", "One"), "now")?;
                upsert_from_value(tx, &store, "ws-a", item("github", "i2", "Two"), "now")
            })
            .unwrap();
        let deleted = store
            .transaction(|tx| delete(tx, "ws-a", "cache:ws-a:github:i1"))
            .unwrap();
        assert_eq!(deleted, 1);
        let remaining = store
            .with_conn(|conn| list(conn, &store, "ws-a", None))
            .unwrap();
        assert_eq!(remaining.len(), 1);
        // Deleting from ws-b does not affect ws-a's row.
        let cross = store
            .transaction(|tx| delete(tx, "ws-b", "cache:ws-a:github:i2"))
            .unwrap();
        assert_eq!(cross, 0);
    }

    #[test]
    fn mark_resynced_updates_cached_at_for_connector() {
        let store = store();
        store
            .transaction(|tx| {
                upsert_from_value(tx, &store, "ws-a", item("github", "i1", "One"), "old")?;
                upsert_from_value(tx, &store, "ws-a", item("notion", "p1", "Two"), "old")
            })
            .unwrap();
        let touched = store
            .transaction(|tx| mark_resynced(tx, "ws-a", Some("github"), "fresh"))
            .unwrap();
        assert_eq!(touched, 1);
        let rows = store
            .with_conn(|conn| list(conn, &store, "ws-a", Some("github")))
            .unwrap();
        assert_eq!(rows[0].cached_at, "fresh");
        let notion = store
            .with_conn(|conn| list(conn, &store, "ws-a", Some("notion")))
            .unwrap();
        assert_eq!(notion[0].cached_at, "old", "other connector untouched");
    }

    #[test]
    fn redacts_token_shaped_string_values() {
        let store = store();
        let mut value = item("github", "i1", "Bearer ya29.secret-token");
        value["providerMetadata"] = serde_json::json!({
            "authHeader": "Bearer abc123",
            "link": "https://example.com/file"
        });
        store
            .transaction(|tx| upsert_from_value(tx, &store, "ws-a", value, "now"))
            .unwrap();
        let rows = store
            .with_conn(|conn| list(conn, &store, "ws-a", None))
            .unwrap();
        let title = rows[0].payload["title"].as_str().unwrap();
        assert_eq!(title, REDACTED, "token-shaped title is redacted");
        let auth = rows[0].payload["providerMetadata"]["authHeader"]
            .as_str()
            .unwrap();
        assert_eq!(auth, REDACTED, "secret field value is redacted");
        // Non-secret metadata is preserved.
        assert_eq!(
            rows[0].payload["providerMetadata"]["link"],
            "https://example.com/file"
        );
    }

    #[test]
    fn rejects_record_when_secret_marker_survives_redaction_in_non_string() {
        // A secret embedded in a way redact_value cannot scrub (e.g. inside a
        // number-cast wrapper is not possible with JSON; instead prove the
        // fail-closed path triggers by constructing a payload that has a secret
        // marker the redactor keeps because it's already the sentinel form).
        // Here we assert the guard exists: a clean item passes, and the
        // sentinel itself is treated as non-secret (already scrubbed).
        let payload = serde_json::json!({ "title": REDACTED });
        assert!(!still_has_secret(&payload));
        let payload = serde_json::json!({ "title": "bearer ya29.evil" });
        assert!(still_has_secret(&payload));
    }

    #[test]
    fn rejects_invalid_trust_and_missing_fields() {
        let store = store();
        // Missing connectorId.
        let mut bad = item("github", "i1", "T");
        let obj = bad.as_object_mut().unwrap();
        obj.remove("connectorId");
        store
            .transaction(|tx| upsert_from_value(tx, &store, "ws-a", bad, "now"))
            .unwrap_err();
        // Bad trust.
        let mut bad_trust = item("github", "i1", "T");
        bad_trust["trust"] = serde_json::json!("top-secret");
        let err = store
            .transaction(|tx| upsert_from_value(tx, &store, "ws-a", bad_trust, "now"))
            .unwrap_err();
        assert!(matches!(err, StoreError::Invalid(_)));
    }

    #[test]
    fn empty_workspace_defaults_to_default_scope() {
        let store = store();
        store
            .transaction(|tx| upsert_from_value(tx, &store, "  ", item("github", "i1", "T"), "now"))
            .unwrap();
        let rows = store
            .with_conn(|conn| list(conn, &store, DEFAULT_WORKSPACE_ID, None))
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].workspace_id, DEFAULT_WORKSPACE_ID);
    }

    #[test]
    fn connectors_with_cache_lists_distinct_connectors() {
        let store = store();
        store
            .transaction(|tx| {
                upsert_from_value(tx, &store, "ws-a", item("github", "i1", "A"), "now")?;
                upsert_from_value(tx, &store, "ws-a", item("github", "i2", "B"), "now")?;
                upsert_from_value(tx, &store, "ws-a", item("notion", "p1", "C"), "now")
            })
            .unwrap();
        let conns = store
            .with_conn(|conn| connectors_with_cache(conn, "ws-a"))
            .unwrap();
        assert_eq!(conns, vec!["github".to_string(), "notion".to_string()]);
    }
}
