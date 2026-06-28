//! Backend connections. Stores *which* provider backends are connected
//! (provider ids only). The actual API key secret stays in OS secure storage
//! under the `com.fable.workspace` keyring service; this table never holds a
//! secret.

use rusqlite::Connection;

use crate::models::SUPPORTED_BACKEND_PROVIDER_IDS;
use crate::store::{Result, StoreError};

/// Record that `provider_id` is connected (idempotent upsert).
pub fn upsert(tx: &Connection, provider_id: &str, now: &str) -> Result<()> {
    if !SUPPORTED_BACKEND_PROVIDER_IDS.contains(&provider_id) {
        return Err(StoreError::Invalid(format!(
            "Unsupported backend provider id '{provider_id}'."
        )));
    }
    tx.execute(
        "INSERT INTO backend_connection (provider_id, connected_at, updated_at)
         VALUES (?1, ?2, ?2)
         ON CONFLICT(provider_id) DO UPDATE SET updated_at=excluded.updated_at;",
        rusqlite::params![provider_id, now],
    )?;
    Ok(())
}

/// Remove a backend connection.
pub fn delete(tx: &Connection, provider_id: &str) -> Result<()> {
    tx.execute(
        "DELETE FROM backend_connection WHERE provider_id = ?1;",
        rusqlite::params![provider_id],
    )?;
    Ok(())
}

/// List connected provider ids.
pub fn list(tx: &Connection) -> Result<Vec<String>> {
    let mut stmt =
        tx.prepare("SELECT provider_id FROM backend_connection ORDER BY provider_id;")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}
