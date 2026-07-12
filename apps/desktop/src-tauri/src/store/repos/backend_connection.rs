//! Backend connections. Stores *which* provider backends are connected
//! (provider ids only). The actual API key secret stays in OS secure storage
//! under the `com.fable.workspace` keyring service; this table never holds a
//! secret.

use rusqlite::Connection;

use crate::models::SUPPORTED_BACKEND_PROVIDER_IDS;
use crate::store::{Result, StoreError};

#[derive(Clone, Debug)]
pub struct BackendConnectionRow {
    pub provider_id: String,
    pub connected_at: String,
    pub updated_at: String,
}

/// Record an account-owned provider connection (idempotent upsert).
pub fn upsert(tx: &Connection, internal_user_id: &str, provider_id: &str, now: &str) -> Result<()> {
    if !SUPPORTED_BACKEND_PROVIDER_IDS.contains(&provider_id) {
        return Err(StoreError::Invalid(format!(
            "Unsupported backend provider id '{provider_id}'."
        )));
    }
    tx.execute(
        "INSERT INTO backend_connection
           (internal_user_id, provider_id, connected_at, updated_at)
         VALUES (?1, ?2, ?3, ?3)
         ON CONFLICT(internal_user_id, provider_id)
         DO UPDATE SET updated_at=excluded.updated_at;",
        rusqlite::params![internal_user_id, provider_id, now],
    )?;
    Ok(())
}

/// Remove a backend connection.
pub fn delete(tx: &Connection, internal_user_id: &str, provider_id: &str) -> Result<()> {
    tx.execute(
        "DELETE FROM backend_connection
         WHERE internal_user_id = ?1 AND provider_id = ?2;",
        rusqlite::params![internal_user_id, provider_id],
    )?;
    Ok(())
}

/// List connected provider ids.
pub fn list(tx: &Connection, internal_user_id: &str) -> Result<Vec<String>> {
    Ok(list_records(tx, internal_user_id)?
        .into_iter()
        .map(|row| row.provider_id)
        .collect())
}

pub fn list_records(tx: &Connection, internal_user_id: &str) -> Result<Vec<BackendConnectionRow>> {
    let mut stmt = tx.prepare(
        "SELECT provider_id,connected_at,updated_at FROM backend_connection
         WHERE internal_user_id = ?1 ORDER BY provider_id;",
    )?;
    let rows = stmt.query_map([internal_user_id], |row| {
        Ok(BackendConnectionRow {
            provider_id: row.get(0)?,
            connected_at: row.get(1)?,
            updated_at: row.get(2)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Preserve ownerless legacy metadata without granting it to any account.
pub fn quarantine_legacy(tx: &Connection, provider_id: &str, now: &str) -> Result<()> {
    if !SUPPORTED_BACKEND_PROVIDER_IDS.contains(&provider_id) {
        return Err(StoreError::Invalid(format!(
            "Unsupported backend provider id '{provider_id}'."
        )));
    }
    tx.execute(
        "INSERT INTO backend_connection_legacy_unowned
           (provider_id, connected_at, updated_at, quarantined_at)
         VALUES (?1, ?2, ?2, ?2)
         ON CONFLICT(provider_id) DO UPDATE SET
           updated_at=excluded.updated_at,
           quarantined_at=excluded.quarantined_at;",
        rusqlite::params![provider_id, now],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::vault::{MasterKey, Vault};
    use crate::store::Store;

    #[test]
    fn provider_connections_are_isolated_by_internal_user() {
        let vault = Vault::new(&MasterKey::generate().unwrap()).unwrap();
        let store = Store::open_in_memory(vault).unwrap();
        store
            .transaction(|tx| {
                for user in ["user-a", "user-b"] {
                    tx.execute(
                        "INSERT INTO fable_internal_user_mirror(internal_user_id,status,revision,updated_at) VALUES (?1,'active',0,'t')",
                        [user],
                    )?;
                }
                upsert(tx, "user-a", "openai", "t")?;
                upsert(tx, "user-b", "anthropic", "t")?;
                Ok(())
            })
            .unwrap();

        assert_eq!(
            store.with_conn(|tx| list(tx, "user-a")).unwrap(),
            vec!["openai"]
        );
        let rows = store.with_conn(|tx| list_records(tx, "user-a")).unwrap();
        assert_eq!(rows[0].connected_at, "t");
        assert_eq!(rows[0].updated_at, "t");
        assert_eq!(
            store.with_conn(|tx| list(tx, "user-b")).unwrap(),
            vec!["anthropic"]
        );
    }
}
