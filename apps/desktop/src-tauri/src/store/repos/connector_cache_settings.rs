//! Connector-cache settings — per-workspace and per-connector cache controls.
//!
//! Settings are keyed by `(workspace_id, connector_id)`:
//! - a **workspace** default row uses the connector id sentinel [`WORKSPACE_SCOPE_CONNECTOR`]
//!   and applies to every connector in that workspace unless overridden;
//! - a **connector** override row names a specific connector and takes
//!   precedence over the workspace default.
//!
//! `enabled` gates whether the cache is written to or read from for that scope;
//! `auto_sync` gates whether a background resync may run. Both are non-secret
//! booleans and live in plaintext columns. The encrypted payload carries only
//! an optional free-text note (never secrets).

use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;

use crate::store::repos::connector_cache::normalize_workspace;
use crate::store::repos::{open_json, seal_json};
use crate::store::vault::Sealed;
use crate::store::{Result, Store, StoreError};

/// Scope constant for a workspace-wide default row.
pub const SCOPE_WORKSPACE: &str = "workspace";
/// Scope constant for a per-connector override row.
pub const SCOPE_CONNECTOR: &str = "connector";
/// The connector-id sentinel used for a workspace-default settings row so the
/// `(workspace_id, connector_id)` primary key stays unique per scope.
pub const WORKSPACE_SCOPE_CONNECTOR: &str = "__workspace__";

/// A decrypted settings row.
pub struct CacheSettingsRow {
    pub workspace_id: String,
    pub connector_id: String,
    pub scope: String,
    pub enabled: bool,
    pub auto_sync: bool,
    pub updated_at: String,
    pub payload: Value,
}

pub struct CacheSettingsUpdate<'a> {
    pub enabled: bool,
    pub auto_sync: bool,
    pub note: &'a str,
    pub updated_at: &'a str,
}

/// Resolve the effective settings for `(workspace_id, connector_id)`: a
/// connector override wins over the workspace default, which wins over the
/// built-in default (`enabled = true, auto_sync = false`).
pub fn effective(
    tx: &Connection,
    store: &Store,
    workspace_id: &str,
    connector_id: &str,
) -> Result<CacheSettingsRow> {
    let workspace_id = normalize_workspace(workspace_id)?;
    if let Some(row) = get(tx, store, &workspace_id, connector_id)? {
        return Ok(row);
    }
    if let Some(row) = get(tx, store, &workspace_id, WORKSPACE_SCOPE_CONNECTOR)? {
        return Ok(row);
    }
    Ok(default_settings(&workspace_id, connector_id))
}

/// The effective `enabled` flag for a single `(workspace_id, connector_id)`,
/// resolved from **plaintext columns only** (no payload decryption). Same
/// precedence as [`effective`]: connector override wins over the workspace
/// default, which wins over the built-in default (`enabled = true`).
///
/// Use this on hot read paths (cache list/search authorization) where only the
/// boolean is needed and decrypting the settings `note` would be pure waste.
pub fn effective_enabled(tx: &Connection, workspace_id: &str, connector_id: &str) -> Result<bool> {
    let workspace_id = normalize_workspace(workspace_id)?;
    let enabled: Option<i64> = tx
        .query_row(
            "SELECT enabled FROM connector_cache_settings
             WHERE workspace_id = ?1 AND connector_id = ?2;",
            rusqlite::params![workspace_id, connector_id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(value) = enabled {
        return Ok(value != 0);
    }
    // Fall back to the workspace default row (plaintext enabled column only).
    let ws_enabled: Option<i64> = tx
        .query_row(
            "SELECT enabled FROM connector_cache_settings
             WHERE workspace_id = ?1 AND connector_id = ?2;",
            rusqlite::params![workspace_id, WORKSPACE_SCOPE_CONNECTOR],
            |row| row.get(0),
        )
        .optional()?;
    Ok(ws_enabled.map(|value| value != 0).unwrap_or(true))
}

/// Resolve the effective `enabled` flag for **every** connector that has cached
/// rows in a workspace, in a single plaintext query (no per-row lookups, no
/// payload decryption). Returns a map keyed by `connector_id`.
///
/// A connector's effective flag is its own override if present, else the
/// workspace-default row's flag, else the built-in default (`true`). Unknown
/// connectors (no settings row at all) resolve to the built-in default.
pub fn effective_enabled_for_workspace(
    tx: &Connection,
    workspace_id: &str,
) -> Result<std::collections::HashMap<String, bool>> {
    let workspace_id = normalize_workspace(workspace_id)?;
    // One plaintext scan of this workspace's settings rows: (connector_id, enabled).
    let mut stmt = tx.prepare(
        "SELECT connector_id, enabled FROM connector_cache_settings
         WHERE workspace_id = ?1;",
    )?;
    let rows = stmt.query_map(rusqlite::params![workspace_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? != 0))
    })?;
    let mut explicit = std::collections::HashMap::<String, bool>::new();
    let mut workspace_default = None;
    for row in rows {
        let (connector_id, enabled) = row?;
        if connector_id == WORKSPACE_SCOPE_CONNECTOR {
            workspace_default = Some(enabled);
        } else {
            explicit.insert(connector_id, enabled);
        }
    }
    // Resolve every connector that appears in the explicit map; connectors with
    // no row inherit the workspace default (or built-in true). Callers pass the
    // distinct connector ids from the cache rows so unknown ids resolve here.
    let fallback = workspace_default.unwrap_or(true);
    let mut out = std::collections::HashMap::new();
    for (connector_id, enabled) in explicit {
        out.insert(connector_id, enabled);
    }
    out.insert(WORKSPACE_SCOPE_CONNECTOR.to_string(), fallback);
    Ok(out)
}

/// Look up an already-resolved effective-enabled map (from
/// [`effective_enabled_for_workspace`]) for a single connector id, applying the
/// same precedence: connector override → workspace default → built-in `true`.
pub fn resolve_enabled(
    resolved: &std::collections::HashMap<String, bool>,
    connector_id: &str,
) -> bool {
    resolved
        .get(connector_id)
        .copied()
        .or_else(|| resolved.get(WORKSPACE_SCOPE_CONNECTOR).copied())
        .unwrap_or(true)
}

/// Built-in default settings (cache enabled, no background auto-sync).
pub fn default_settings(workspace_id: &str, connector_id: &str) -> CacheSettingsRow {
    CacheSettingsRow {
        workspace_id: workspace_id.to_string(),
        connector_id: connector_id.to_string(),
        scope: if connector_id == WORKSPACE_SCOPE_CONNECTOR {
            SCOPE_WORKSPACE.to_string()
        } else {
            SCOPE_CONNECTOR.to_string()
        },
        enabled: true,
        auto_sync: false,
        updated_at: String::new(),
        payload: serde_json::json!({ "note": "" }),
    }
}

/// Read a single settings row by exact key (`None` if absent).
pub fn get(
    tx: &Connection,
    store: &Store,
    workspace_id: &str,
    connector_id: &str,
) -> Result<Option<CacheSettingsRow>> {
    let workspace_id = normalize_workspace(workspace_id)?;
    let partial = tx
        .query_row(
            "SELECT workspace_id, connector_id, scope, enabled, auto_sync, updated_at,
                    payload, payload_nonce
             FROM connector_cache_settings
             WHERE workspace_id = ?1 AND connector_id = ?2;",
            rusqlite::params![workspace_id, connector_id],
            |row| {
                Ok(Partial {
                    workspace_id: row.get(0)?,
                    connector_id: row.get(1)?,
                    scope: row.get(2)?,
                    enabled: row.get::<_, i64>(3)? != 0,
                    auto_sync: row.get::<_, i64>(4)? != 0,
                    updated_at: row.get(5)?,
                    sealed: Sealed {
                        ciphertext: row.get(6)?,
                        nonce: row.get(7)?,
                    },
                })
            },
        )
        .optional()?;
    match partial {
        None => Ok(None),
        Some(p) => {
            let payload = open_json(store, &p.sealed, &aad(&p.workspace_id, &p.connector_id))?;
            Ok(Some(CacheSettingsRow {
                workspace_id: p.workspace_id,
                connector_id: p.connector_id,
                scope: p.scope,
                enabled: p.enabled,
                auto_sync: p.auto_sync,
                updated_at: p.updated_at,
                payload,
            }))
        }
    }
}

/// Upsert settings for `(workspace_id, connector_id)`. `scope` is derived from
/// whether `connector_id` is the workspace sentinel. The free-text note in the
/// payload is redacted through the same vocabulary so a note can never smuggle
/// a token into the cache settings table.
pub fn upsert(
    tx: &Connection,
    store: &Store,
    workspace_id: &str,
    connector_id: &str,
    update: CacheSettingsUpdate<'_>,
) -> Result<()> {
    let workspace_id = normalize_workspace(workspace_id)?;
    let scope = if connector_id == WORKSPACE_SCOPE_CONNECTOR {
        SCOPE_WORKSPACE
    } else {
        SCOPE_CONNECTOR
    };
    let payload = serde_json::json!({ "note": redact_note(update.note) });
    let sealed = seal_json(store, &payload, &aad(&workspace_id, connector_id))?;
    tx.execute(
        "INSERT INTO connector_cache_settings
            (workspace_id, connector_id, scope, enabled, auto_sync, updated_at,
             payload, payload_nonce)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(workspace_id, connector_id) DO UPDATE SET
           scope=excluded.scope, enabled=excluded.enabled, auto_sync=excluded.auto_sync,
           updated_at=excluded.updated_at,
           payload=excluded.payload, payload_nonce=excluded.payload_nonce;",
        rusqlite::params![
            workspace_id,
            connector_id,
            scope,
            update.enabled as i64,
            update.auto_sync as i64,
            update.updated_at,
            sealed.ciphertext,
            sealed.nonce,
        ],
    )?;
    Ok(())
}

/// Delete settings for `(workspace_id, connector_id)`. Deleting a connector
/// override makes the workspace default (or built-in default) take effect.
pub fn delete(tx: &Connection, workspace_id: &str, connector_id: &str) -> Result<usize> {
    let workspace_id = normalize_workspace(workspace_id)?;
    let deleted = tx.execute(
        "DELETE FROM connector_cache_settings
         WHERE workspace_id = ?1 AND connector_id = ?2;",
        rusqlite::params![workspace_id, connector_id],
    )?;
    Ok(deleted)
}

/// Delete all settings rows for a workspace (used on full cache clear).
pub fn clear_for_workspace(tx: &Connection, workspace_id: &str) -> Result<usize> {
    let workspace_id = normalize_workspace(workspace_id)?;
    let deleted = tx.execute(
        "DELETE FROM connector_cache_settings WHERE workspace_id = ?1;",
        rusqlite::params![workspace_id],
    )?;
    Ok(deleted)
}

/// List every settings row for a workspace (workspace default + overrides).
pub fn list_for_workspace(
    tx: &Connection,
    store: &Store,
    workspace_id: &str,
) -> Result<Vec<CacheSettingsRow>> {
    let workspace_id = normalize_workspace(workspace_id)?;
    let mut stmt = tx.prepare(
        "SELECT workspace_id, connector_id, scope, enabled, auto_sync, updated_at,
                payload, payload_nonce
         FROM connector_cache_settings WHERE workspace_id = ?1
         ORDER BY connector_id;",
    )?;
    let partials: Vec<Partial> = stmt
        .query_map(rusqlite::params![workspace_id], |row| {
            Ok(Partial {
                workspace_id: row.get(0)?,
                connector_id: row.get(1)?,
                scope: row.get(2)?,
                enabled: row.get::<_, i64>(3)? != 0,
                auto_sync: row.get::<_, i64>(4)? != 0,
                updated_at: row.get(5)?,
                sealed: Sealed {
                    ciphertext: row.get(6)?,
                    nonce: row.get(7)?,
                },
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut out = Vec::with_capacity(partials.len());
    for p in partials {
        let payload = open_json(store, &p.sealed, &aad(&p.workspace_id, &p.connector_id))?;
        out.push(CacheSettingsRow {
            workspace_id: p.workspace_id,
            connector_id: p.connector_id,
            scope: p.scope,
            enabled: p.enabled,
            auto_sync: p.auto_sync,
            updated_at: p.updated_at,
            payload,
        });
    }
    Ok(out)
}

/// Validate that `scope` is a known value.
pub fn validate_scope(scope: &str) -> Result<()> {
    if scope == SCOPE_WORKSPACE || scope == SCOPE_CONNECTOR {
        Ok(())
    } else {
        Err(StoreError::Invalid(format!(
            "Connector cache settings scope '{scope}' is not recognized."
        )))
    }
}

/// Redact a free-text note using the cache's secret vocabulary so a settings
/// note can never persist a token. A note that *is* a secret becomes the
/// sentinel rather than being rejected outright (notes are optional/free-form).
fn redact_note(note: &str) -> String {
    const NOTE_SECRET_EXTRAS: &[&str] = &["1//"];
    if crate::secret_redaction::looks_secret_with(note, NOTE_SECRET_EXTRAS) {
        crate::store::repos::connector_cache::REDACTED.to_string()
    } else {
        note.to_string()
    }
}

struct Partial {
    workspace_id: String,
    connector_id: String,
    scope: String,
    enabled: bool,
    auto_sync: bool,
    updated_at: String,
    sealed: Sealed,
}

fn aad(workspace_id: &str, connector_id: &str) -> String {
    format!("connector_cache_settings:{workspace_id}:{connector_id}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::repos::connector_cache::REDACTED;
    use crate::store::vault::{MasterKey, Vault};

    fn store() -> Store {
        Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap()
    }

    #[test]
    fn connector_override_beats_workspace_default() {
        let store = store();
        store
            .transaction(|tx| {
                upsert(
                    tx,
                    &store,
                    "ws-a",
                    WORKSPACE_SCOPE_CONNECTOR,
                    CacheSettingsUpdate {
                        enabled: false,
                        auto_sync: false,
                        note: "workspace off",
                        updated_at: "now",
                    },
                )
            })
            .unwrap();
        // Workspace default says disabled.
        let eff = store
            .with_conn(|conn| effective(conn, &store, "ws-a", "github"))
            .unwrap();
        assert!(!eff.enabled);

        // A connector override re-enables github specifically.
        store
            .transaction(|tx| {
                upsert(
                    tx,
                    &store,
                    "ws-a",
                    "github",
                    CacheSettingsUpdate {
                        enabled: true,
                        auto_sync: true,
                        note: "github on",
                        updated_at: "now",
                    },
                )
            })
            .unwrap();
        let eff = store
            .with_conn(|conn| effective(conn, &store, "ws-a", "github"))
            .unwrap();
        assert!(eff.enabled);
        assert!(eff.auto_sync);
        assert_eq!(eff.scope, SCOPE_CONNECTOR);

        // notion still inherits the workspace default (disabled).
        let eff = store
            .with_conn(|conn| effective(conn, &store, "ws-a", "notion"))
            .unwrap();
        assert!(!eff.enabled);
        assert_eq!(eff.scope, SCOPE_WORKSPACE);
    }

    #[test]
    fn falls_back_to_built_in_default_when_no_settings() {
        let store = store();
        let eff = store
            .with_conn(|conn| effective(conn, &store, "ws-a", "github"))
            .unwrap();
        assert!(eff.enabled);
        assert!(!eff.auto_sync);
    }

    #[test]
    fn delete_override_restores_workspace_default() {
        let store = store();
        store
            .transaction(|tx| {
                upsert(
                    tx,
                    &store,
                    "ws-a",
                    WORKSPACE_SCOPE_CONNECTOR,
                    CacheSettingsUpdate {
                        enabled: false,
                        auto_sync: false,
                        note: "",
                        updated_at: "now",
                    },
                )?;
                upsert(
                    tx,
                    &store,
                    "ws-a",
                    "github",
                    CacheSettingsUpdate {
                        enabled: true,
                        auto_sync: false,
                        note: "",
                        updated_at: "now",
                    },
                )
            })
            .unwrap();
        let eff = store
            .with_conn(|conn| effective(conn, &store, "ws-a", "github"))
            .unwrap();
        assert!(eff.enabled);
        store
            .transaction(|tx| delete(tx, "ws-a", "github"))
            .unwrap();
        let eff = store
            .with_conn(|conn| effective(conn, &store, "ws-a", "github"))
            .unwrap();
        assert!(!eff.enabled, "back to the disabled workspace default");
    }

    #[test]
    fn workspace_isolation_on_settings() {
        let store = store();
        store
            .transaction(|tx| {
                upsert(
                    tx,
                    &store,
                    "ws-a",
                    WORKSPACE_SCOPE_CONNECTOR,
                    CacheSettingsUpdate {
                        enabled: false,
                        auto_sync: false,
                        note: "",
                        updated_at: "now",
                    },
                )
            })
            .unwrap();
        // ws-b has no settings -> built-in default (enabled).
        let eff = store
            .with_conn(|conn| effective(conn, &store, "ws-b", "github"))
            .unwrap();
        assert!(eff.enabled);
        // Clearing ws-b's (empty) settings does not affect ws-a.
        let cleared = store
            .transaction(|tx| clear_for_workspace(tx, "ws-b"))
            .unwrap();
        assert_eq!(cleared, 0);
        let a = store
            .with_conn(|conn| list_for_workspace(conn, &store, "ws-a"))
            .unwrap();
        assert_eq!(a.len(), 1);
    }

    #[test]
    fn redacts_secret_in_note() {
        let store = store();
        store
            .transaction(|tx| {
                upsert(
                    tx,
                    &store,
                    "ws-a",
                    "github",
                    CacheSettingsUpdate {
                        enabled: true,
                        auto_sync: false,
                        note: "Bearer ya29.leaked-token",
                        updated_at: "now",
                    },
                )
            })
            .unwrap();
        let row = store
            .with_conn(|conn| get(conn, &store, "ws-a", "github"))
            .unwrap()
            .unwrap();
        assert_eq!(row.payload["note"], REDACTED);
    }

    #[test]
    fn validate_scope_rejects_unknown() {
        let err = validate_scope("galaxy").unwrap_err();
        assert!(matches!(err, StoreError::Invalid(_)));
        validate_scope(SCOPE_WORKSPACE).unwrap();
        validate_scope(SCOPE_CONNECTOR).unwrap();
    }
}
