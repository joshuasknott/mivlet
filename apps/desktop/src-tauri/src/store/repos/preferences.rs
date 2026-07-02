//! Shell preferences (key/value, encrypted). Each preference key is a stable,
//! non-secret enum-ish name (e.g. "shell", "memoryDisabled").

use rusqlite::Connection;
use serde_json::Value;

use crate::store::repos::scope::DataScope;
use crate::store::repos::{open_json, payload_of, seal_json};
use crate::store::{Result, Store};

/// Upsert a preference by key.
pub fn upsert(
    tx: &Connection,
    store: &Store,
    key: &str,
    value: &Value,
    updated_at: &str,
) -> Result<()> {
    upsert_scoped(
        tx,
        store,
        &DataScope::legacy_default(),
        key,
        value,
        updated_at,
    )
}

pub fn upsert_scoped(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    key: &str,
    value: &Value,
    updated_at: &str,
) -> Result<()> {
    scope.ensure_exists(tx)?;
    if scope.project_id().is_some() {
        return Err(crate::store::StoreError::Invalid(
            "Settings are workspace-scoped and cannot use a project scope.".into(),
        ));
    }
    let sealed = seal_json(store, value, &aad(scope.workspace_id(), key))?;
    tx.execute(
        "INSERT INTO preferences (workspace_id, key, updated_at, payload, payload_nonce)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(workspace_id, key) DO UPDATE SET
           updated_at=excluded.updated_at,
           payload=excluded.payload, payload_nonce=excluded.payload_nonce;",
        rusqlite::params![
            scope.workspace_id(),
            key,
            updated_at,
            sealed.ciphertext,
            sealed.nonce
        ],
    )?;
    Ok(())
}

/// Read a preference by key.
pub fn get(tx: &Connection, store: &Store, key: &str) -> Result<Option<Value>> {
    get_scoped(tx, store, &DataScope::legacy_default(), key)
}

pub fn get_scoped(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    key: &str,
) -> Result<Option<Value>> {
    scope.ensure_exists(tx)?;
    let sealed = tx
        .query_row(
            "SELECT payload, payload_nonce FROM preferences
             WHERE workspace_id = ?1 AND key = ?2;",
            rusqlite::params![scope.workspace_id(), key],
            payload_of,
        )
        .optional()?;
    match sealed {
        Some(s) => {
            let opened =
                open_json(store, &s, &aad(scope.workspace_id(), key)).or_else(|error| {
                    if scope.workspace_id() == crate::store::repos::scope::DEFAULT_WORKSPACE_ID {
                        // v3 payloads were sealed before workspace ownership was
                        // part of the AAD. Read-only fallback preserves them; the
                        // next write reseals with workspace-bound AAD.
                        open_json(store, &s, &legacy_aad(key))
                    } else {
                        Err(error)
                    }
                })?;
            Ok(Some(opened))
        }
        None => Ok(None),
    }
}

/// List all preference keys (non-secret).
pub fn keys(tx: &Connection) -> Result<Vec<String>> {
    keys_scoped(tx, &DataScope::legacy_default())
}

pub fn keys_scoped(tx: &Connection, scope: &DataScope) -> Result<Vec<String>> {
    scope.ensure_exists(tx)?;
    let mut stmt = tx.prepare("SELECT key FROM preferences WHERE workspace_id=?1 ORDER BY key;")?;
    let rows = stmt.query_map([scope.workspace_id()], |row| row.get::<_, String>(0))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Fetch every `document:*` preference for a scope as decrypted JSON, in a
/// single query + decryption pass. Used by the credential-free local-data
/// export so it does not re-acquire the store mutex and re-query once per key.
/// Each entry is keyed by the document id (the key with the `document:` prefix
/// stripped). A corrupt payload fails the export rather than silently producing
/// an incomplete backup.
pub fn documents_for_export(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
) -> Result<serde_json::Map<String, Value>> {
    scope.ensure_exists(tx)?;
    let mut stmt = tx.prepare(
        "SELECT key, payload, payload_nonce FROM preferences
         WHERE workspace_id = ?1 AND key LIKE 'document:%' ORDER BY key;",
    )?;
    let rows = stmt.query_map([scope.workspace_id()], |row| {
        Ok((row.get::<_, String>(0)?, payload_of(row)?))
    })?;
    let mut out = serde_json::Map::new();
    let default_ws = crate::store::repos::scope::DEFAULT_WORKSPACE_ID;
    for row in rows {
        let (key, sealed) = row?;
        let value =
            open_json(store, &sealed, &aad(scope.workspace_id(), &key)).or_else(|error| {
                if scope.workspace_id() == default_ws {
                    open_json(store, &sealed, &legacy_aad(&key))
                } else {
                    Err(error)
                }
            })?;
        out.insert(key.trim_start_matches("document:").to_string(), value);
    }
    Ok(out)
}

/// Delete a preference by key.
pub fn delete(tx: &Connection, key: &str) -> Result<()> {
    delete_scoped(tx, &DataScope::legacy_default(), key)
}

pub fn delete_scoped(tx: &Connection, scope: &DataScope, key: &str) -> Result<()> {
    scope.ensure_exists(tx)?;
    tx.execute(
        "DELETE FROM preferences WHERE workspace_id = ?1 AND key = ?2;",
        rusqlite::params![scope.workspace_id(), key],
    )?;
    Ok(())
}

fn aad(workspace_id: &str, key: &str) -> String {
    format!("preferences:{workspace_id}:{key}")
}

fn legacy_aad(key: &str) -> String {
    format!("preferences:{key}")
}

use rusqlite::OptionalExtension as _;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::repos::scope::DataScope;
    use crate::store::vault::{MasterKey, Vault};

    fn store() -> Store {
        Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap()
    }

    fn seed_document(store: &Store, ws: &str, id: &str, body: &str) {
        let scope = DataScope::workspace(ws.to_string()).unwrap();
        store
            .transaction(|tx| {
                upsert_scoped(
                    tx,
                    store,
                    &scope,
                    &format!("document:{id}"),
                    &serde_json::json!({ "text": body }),
                    "now",
                )
            })
            .unwrap();
    }

    #[test]
    fn documents_for_export_returns_all_documents_in_one_pass() {
        let store = store();
        seed_document(&store, "default", "a", "alpha");
        seed_document(&store, "default", "b", "beta");
        // A non-document preference should be excluded from the export.
        let scope = DataScope::workspace("default".to_string()).unwrap();
        store
            .transaction(|tx| {
                upsert_scoped(
                    tx,
                    &store,
                    &scope,
                    "shell",
                    &serde_json::json!("compact"),
                    "now",
                )
            })
            .unwrap();
        let docs = store
            .with_conn(|conn| documents_for_export(conn, &store, &scope))
            .unwrap();
        assert_eq!(docs.len(), 2, "only document:* keys are exported");
        assert_eq!(docs["a"]["text"], "alpha");
        assert_eq!(docs["b"]["text"], "beta");
        assert!(!docs.contains_key("shell"));
    }

    #[test]
    fn documents_for_export_is_workspace_scoped() {
        let store = store();
        // Create the secondary workspace row so the scope's FK check passes.
        store
            .transaction(|tx| {
                crate::store::repos::workspace::upsert(tx, "ws-other", "Other", "now")
            })
            .unwrap();
        seed_document(&store, "default", "shared", "from-default");
        seed_document(&store, "ws-other", "shared", "from-other");
        let scope = DataScope::workspace("ws-other".to_string()).unwrap();
        let docs = store
            .with_conn(|conn| documents_for_export(conn, &store, &scope))
            .unwrap();
        assert_eq!(
            docs.len(),
            1,
            "export is scoped to the requesting workspace"
        );
        assert_eq!(docs["shared"]["text"], "from-other");
    }
}
