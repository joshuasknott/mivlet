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
pub(crate) fn redact_value(value: &Value) -> Value {
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
                        "token"
                            | "secret"
                            | "password"
                            | "accesstoken"
                            | "refreshtoken"
                            | "apikey"
                            | "api_key"
                            | "authorization"
                            | "cookie"
                            | "credential"
                            | "credentials"
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
    let workspace_id = normalize_workspace(workspace_id)?;
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
    let tombstoned: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM connector_cache_tombstone
         WHERE workspace_id=?1 AND connector_id=?2 AND provider_item_id=?3);",
        rusqlite::params![workspace_id, connector_id, provider_item_id],
        |row| row.get(0),
    )?;
    if tombstoned {
        return Err(StoreError::Invalid(
            "Deleted connector knowledge cannot be restored by synchronization.".into(),
        ));
    }

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
    // Derive a plaintext, non-secret search corpus from the *already-redacted*
    // payload so lexical search can filter via LIKE without decrypting the blob.
    // Only title/provenance/contentPreview participate — exactly the fields the
    // in-memory `search` filter matched — and only after redaction has scrubbed
    // any token-shaped value to the sentinel.
    let search_text = build_search_text(&payload);
    tx.execute(
        "INSERT INTO connector_cache
            (id, workspace_id, connector_id, provider_item_id, kind, trust, pinned,
             disabled, content_fingerprint, cached_at, origin, search_text,
             payload, payload_nonce)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
         ON CONFLICT(id) DO UPDATE SET
           kind=excluded.kind, trust=excluded.trust, pinned=excluded.pinned,
           content_fingerprint=excluded.content_fingerprint, cached_at=excluded.cached_at,
           origin=excluded.origin, search_text=excluded.search_text,
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
            search_text,
            sealed.ciphertext,
            sealed.nonce,
        ],
    )?;
    Ok(())
}

/// Build the lowercase, space-joined plaintext search corpus from a
/// *redacted* payload's title/provenance/contentPreview. The result is non-secret
/// (redaction has already replaced token-shaped values with the sentinel) and is
/// the exact text the `search` SQL filter matches against. The leading/trailing
/// space padding makes substring `LIKE` matches behave the same as the previous
/// `contains` semantics for field boundaries.
pub fn build_search_text(payload: &Value) -> String {
    let str_field = |key: &str| {
        payload
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase()
    };
    format!(
        " {} {} {} ",
        str_field("title"),
        str_field("provenance"),
        str_field("contentPreview")
    )
}

/// Backfill the plaintext `search_text` column for any rows that still carry the
/// default empty value (legacy rows written before the v6 schema upgrade). The
/// store calls this lazily on first read after upgrade because the migration
/// itself runs without the vault and cannot decrypt payloads. Returns the number
/// of rows backfilled. Safe to call repeatedly: only empty-`search_text` rows are
/// touched, and each is recomputed from its (already-redacted) payload.
pub fn backfill_search_text(tx: &Connection, store: &Store, workspace_id: &str) -> Result<usize> {
    let workspace_id = normalize_workspace(workspace_id)?;
    let mut stmt = tx.prepare(
        "SELECT id, payload, payload_nonce FROM connector_cache
         WHERE workspace_id = ?1 AND search_text = '';",
    )?;
    let pending: Vec<(String, Sealed)> = stmt
        .query_map(rusqlite::params![workspace_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                Sealed {
                    ciphertext: row.get(1)?,
                    nonce: row.get(2)?,
                },
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut updated = 0;
    for (id, sealed) in pending {
        let payload = open_json(store, &sealed, &aad(&id))?;
        let search_text = build_search_text(&payload);
        tx.execute(
            "UPDATE connector_cache SET search_text = ?1 WHERE id = ?2;",
            rusqlite::params![search_text, id],
        )?;
        updated += 1;
    }
    Ok(updated)
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
    let workspace_id = normalize_workspace(workspace_id)?;
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
    let workspace_id = normalize_workspace(workspace_id)?;
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
    sql.push_str(" ORDER BY cached_at DESC, connector_id, provider_item_id;");
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
///
/// Two-stage filter for performance: a plaintext `LIKE` over the indexed
/// `search_text` column narrows to candidate rows (no payload decryption), then
/// the exact in-memory match check runs only on those candidates. This preserves
/// the precise substring semantics (per-field `contains`) while avoiding the
/// previous path of decrypting every cache row in the workspace.
pub fn search(
    tx: &Connection,
    store: &Store,
    workspace_id: &str,
    connector_id: Option<&str>,
    query: &str,
) -> Result<Vec<ConnectorCacheRow>> {
    let needle = query.trim().to_ascii_lowercase();
    if needle.is_empty() {
        return list(tx, store, workspace_id, connector_id);
    }
    let workspace_id = normalize_workspace(workspace_id)?;
    // Stage 1: plaintext candidate selection via LIKE on search_text. The
    // `disabled = 0` gate mirrors `list`'s default exclusion. Use ESCAPE so a
    // needle containing LIKE metacharacters is matched literally.
    let like_pattern = format!("%{}%", escape_like(&needle));
    let mut sql = String::from(
        "SELECT id, workspace_id, connector_id, provider_item_id, kind, trust, pinned,
                disabled, content_fingerprint, cached_at, origin, payload, payload_nonce
         FROM connector_cache
         WHERE workspace_id = ?1 AND disabled = 0 AND search_text LIKE ?2 ESCAPE '\\'",
    );
    let mut params: Vec<Box<dyn rusqlite::ToSql>> =
        vec![Box::new(workspace_id.clone()), Box::new(like_pattern)];
    if let Some(connector_id) = connector_id {
        sql.push_str(" AND connector_id = ?");
        params.push(Box::new(connector_id.to_string()));
    }
    sql.push_str(" ORDER BY cached_at DESC, connector_id, provider_item_id;");
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
    // Stage 2: decrypt only the candidates and keep exact per-field matches.
    let mut out = Vec::with_capacity(partials.len());
    for p in partials {
        let payload = open_json(store, &p.sealed, &aad(&p.id))?;
        if !row_matches(&payload, &needle) {
            continue;
        }
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

/// Exact per-field substring match against the (lowercased) needle, mirroring
/// the original `search` semantics. Used as stage 2 after the plaintext LIKE
/// prefilter so cross-field boundary matches introduced by the concatenation
/// never produce a false positive.
fn row_matches(payload: &Value, needle: &str) -> bool {
    let str_field = |key: &str| {
        payload
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase()
    };
    str_field("title").contains(needle)
        || str_field("provenance").contains(needle)
        || str_field("contentPreview").contains(needle)
}

/// Escape SQLite LIKE metacharacters (`%`, `_`) and the escape char itself so a
/// user query is matched literally.
fn escape_like(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '%' | '_' | '\\' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    out
}

/// Get a single cache row by id, enforcing that it belongs to `workspace_id`
/// (workspace isolation: a row from workspace A cannot be read via workspace B).
pub fn get(
    tx: &Connection,
    store: &Store,
    workspace_id: &str,
    id: &str,
) -> Result<Option<ConnectorCacheRow>> {
    let workspace_id = normalize_workspace(workspace_id)?;
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
    let workspace_id = normalize_workspace(workspace_id)?;
    let updated = tx.execute(
        "UPDATE connector_cache SET disabled = ?1 WHERE id = ?2 AND workspace_id = ?3;",
        rusqlite::params![disabled as i64, id, workspace_id],
    )?;
    Ok(updated)
}

/// Set the `pinned` flag on a cache row, scoped to `workspace_id`.
pub fn set_pinned(tx: &Connection, workspace_id: &str, id: &str, pinned: bool) -> Result<usize> {
    let workspace_id = normalize_workspace(workspace_id)?;
    let updated = tx.execute(
        "UPDATE connector_cache SET pinned = ?1 WHERE id = ?2 AND workspace_id = ?3;",
        rusqlite::params![pinned as i64, id, workspace_id],
    )?;
    Ok(updated)
}

/// Delete a single cache row, scoped to `workspace_id`. Returns rows affected.
pub fn delete(tx: &Connection, workspace_id: &str, id: &str) -> Result<usize> {
    let workspace_id = normalize_workspace(workspace_id)?;
    tx.execute(
        "INSERT OR REPLACE INTO connector_cache_tombstone
           (workspace_id, connector_id, provider_item_id, deleted_at)
         SELECT workspace_id, connector_id, provider_item_id, ?1
         FROM connector_cache WHERE id=?2 AND workspace_id=?3;",
        rusqlite::params![unix_timestamp(), id, workspace_id],
    )?;
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
    let workspace_id = normalize_workspace(workspace_id)?;
    match connector_id {
        Some(connector_id) => {
            tx.execute(
                "INSERT OR REPLACE INTO connector_cache_tombstone
                   (workspace_id, connector_id, provider_item_id, deleted_at)
                 SELECT workspace_id, connector_id, provider_item_id, ?1 FROM connector_cache
                 WHERE workspace_id=?2 AND connector_id=?3;",
                rusqlite::params![unix_timestamp(), workspace_id, connector_id],
            )?;
        }
        None => {
            tx.execute(
                "INSERT OR REPLACE INTO connector_cache_tombstone
                   (workspace_id, connector_id, provider_item_id, deleted_at)
                 SELECT workspace_id, connector_id, provider_item_id, ?1 FROM connector_cache
                 WHERE workspace_id=?2;",
                rusqlite::params![unix_timestamp(), workspace_id],
            )?;
        }
    }
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
    let workspace_id = normalize_workspace(workspace_id)?;
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
    let workspace_id = normalize_workspace(workspace_id)?;
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
pub(crate) fn normalize_workspace(workspace_id: &str) -> Result<String> {
    crate::store::repos::scope::normalize_id(workspace_id, "Workspace")
}

/// Stable cache row id: deterministic per `(workspace, connector, provider_item)`
/// so a re-sync upserts in place instead of duplicating rows.
fn cache_id(workspace_id: &str, connector_id: &str, provider_item_id: &str) -> String {
    format!("cache:{workspace_id}:{connector_id}:{provider_item_id}")
}

fn aad(id: &str) -> String {
    format!("connector_cache:{id}")
}

fn unix_timestamp() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::vault::{MasterKey, Vault};
    use std::time::Instant;

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
    fn empty_workspace_fails_closed() {
        let store = store();
        assert!(store
            .transaction(|tx| upsert_from_value(tx, &store, "  ", item("github", "i1", "T"), "now"))
            .is_err());
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

    #[test]
    fn search_text_is_populated_on_upsert_and_matches_title_provenance_preview() {
        let store = store();
        let mut value = item("github", "i1", "Deploy Script");
        value["provenance"] = serde_json::json!("github://fable/release");
        value["contentPreview"] = serde_json::json!("kubernetes rollout status");
        store
            .transaction(|tx| upsert_from_value(tx, &store, "ws-a", value, "now"))
            .unwrap();
        // Each searchable field should match independently.
        for q in ["deploy", "release", "kubernetes", "DEPLOY"] {
            let rows = store
                .with_conn(|conn| search(conn, &store, "ws-a", None, q))
                .unwrap();
            assert_eq!(rows.len(), 1, "query '{q}' should match the cached row");
        }
        // A query that does not appear in any field matches nothing.
        let none = store
            .with_conn(|conn| search(conn, &store, "ws-a", None, "nonexistent-term-xyz"))
            .unwrap();
        assert!(none.is_empty());
    }

    #[test]
    fn search_text_prefilter_rejects_cross_field_false_positives() {
        // The plaintext search_text concatenates fields with space padding. A
        // query spanning a field boundary (e.g. tail of title + head of
        // provenance) must NOT match, because stage 2 re-checks each field
        // individually on the decrypted payload.
        let store = store();
        let mut value = item("github", "i1", "Alpha");
        value["provenance"] = serde_json::json!("Beta");
        store
            .transaction(|tx| upsert_from_value(tx, &store, "ws-a", value, "now"))
            .unwrap();
        // "pha bet" spans the title->provenance boundary in the concatenated
        // search_text, but no single field contains it.
        let rows = store
            .with_conn(|conn| search(conn, &store, "ws-a", None, "pha bet"))
            .unwrap();
        assert!(
            rows.is_empty(),
            "cross-field boundary query must not produce a false positive"
        );
    }

    #[test]
    fn search_text_handles_like_metacharacters_literally() {
        let store = store();
        let mut value = item("github", "i1", "50%_off");
        value["contentPreview"] = serde_json::json!("sale");
        store
            .transaction(|tx| upsert_from_value(tx, &store, "ws-a", value, "now"))
            .unwrap();
        // A literal search for the metacharacter substring must match, and the
        // unescaped LIKE wildcards must not broaden the result unexpectedly.
        let rows = store
            .with_conn(|conn| search(conn, &store, "ws-a", None, "50%_off"))
            .unwrap();
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn backfill_search_text_populates_legacy_rows_and_is_idempotent() {
        let store = store();
        store
            .transaction(|tx| {
                upsert_from_value(tx, &store, "ws-a", item("github", "i1", "Legacy"), "old")
            })
            .unwrap();
        // Simulate a pre-v6 row by blanking its search_text.
        store
            .transaction(|tx| {
                tx.execute(
                    "UPDATE connector_cache SET search_text = '' WHERE workspace_id = 'ws-a';",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        // Before backfill, search returns nothing (LIKE prefilter finds no rows).
        let before = store
            .with_conn(|conn| search(conn, &store, "ws-a", None, "legacy"))
            .unwrap();
        assert!(before.is_empty());
        // Backfill (as Store::open would on upgrade).
        let n = store
            .transaction(|tx| backfill_search_text(tx, &store, "ws-a"))
            .unwrap();
        assert_eq!(n, 1);
        // After backfill, search finds the legacy row again.
        let after = store
            .with_conn(|conn| search(conn, &store, "ws-a", None, "legacy"))
            .unwrap();
        assert_eq!(after.len(), 1);
        // Idempotent: a second backfill touches zero rows.
        let again = store
            .transaction(|tx| backfill_search_text(tx, &store, "ws-a"))
            .unwrap();
        assert_eq!(again, 0);
    }

    #[test]
    fn search_excludes_disabled_rows_via_plaintext_filter() {
        let store = store();
        store
            .transaction(|tx| {
                upsert_from_value(tx, &store, "ws-a", item("github", "i1", "Visible"), "now")?;
                upsert_from_value(tx, &store, "ws-a", item("github", "i2", "Hidden"), "now")
            })
            .unwrap();
        store
            .transaction(|tx| set_disabled(tx, "ws-a", "cache:ws-a:github:i2", true))
            .unwrap();
        let rows = store
            .with_conn(|conn| search(conn, &store, "ws-a", None, "hidden"))
            .unwrap();
        assert!(rows.is_empty(), "disabled row excluded from search");
        let rows = store
            .with_conn(|conn| search(conn, &store, "ws-a", None, "visible"))
            .unwrap();
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn perf_connector_cache_search_uses_plaintext_prefilter_at_current_scale() {
        let store = store();
        store
            .transaction(|tx| {
                for index in 0..750 {
                    let title = if index % 25 == 0 {
                        format!("Release blocker {index}")
                    } else {
                        format!("General issue {index}")
                    };
                    let mut value = item("github", &format!("issue-{index}"), &title);
                    value["contentPreview"] = serde_json::json!(if index % 25 == 0 {
                        "Connector cache approval search target"
                    } else {
                        "Workspace reference note"
                    });
                    upsert_from_value(tx, &store, "ws-a", value, "now")?;
                }
                Ok(())
            })
            .unwrap();

        let started = Instant::now();
        let rows = store
            .with_conn(|conn| search(conn, &store, "ws-a", Some("github"), "approval search"))
            .unwrap();
        let elapsed = started.elapsed();

        eprintln!("perf_connector_cache_search_ms={}", elapsed.as_millis());
        assert_eq!(rows.len(), 30);
        assert!(
            elapsed.as_millis() < 1_500,
            "connector cache search took {} ms",
            elapsed.as_millis()
        );
    }
}
