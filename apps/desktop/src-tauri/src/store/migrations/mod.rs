//! Schema and data migrations for the durable store.
//!
//! See `docs/superpowers/specs/2026-06-28-encrypted-storage-design.md`.
//!
//! - **Schema migrations** ([`apply`]) run forward-only step functions keyed by
//!   version, inside the migration transaction. v1 DDL is applied by
//!   [`crate::store::schema`]; this module owns v→v+1 steps for future versions.
//! - **Data migrations** ([`legacy`]) read the legacy JSON files + localStorage
//!   payload exactly once per source, classify each record, and write it into
//!   the new schema idempotently, recording diagnostics in `migration_log`.
//!   Legacy files are never deleted.

use rusqlite::Connection;

pub mod legacy;
pub use legacy::migrate_all;

/// Apply forward schema migrations from `from` → `to` (inclusive of `to`).
///
/// v1 DDL is created by [`crate::store::schema::SCHEMA_V1`] before this runs,
/// so for a fresh database `from == 0` and `to == 1` is a no-op here (the
/// tables already exist). Future versions register a step closure for each
/// `from → from+1` boundary.
pub fn apply(conn: &Connection, from: u32, to: u32) -> super::Result<()> {
    let mut current = from;
    while current < to {
        match current {
            // 0 → 1: tables already created by SCHEMA_V1; nothing more to do.
            0 => {}
            // 1 → 2: add the connector-cache tables. Fresh databases already
            // have them through SCHEMA_V1; existing v1 databases receive them
            // through the idempotent SCHEMA_V1_TO_V2 delta.
            1 => conn.execute_batch(crate::store::schema::SCHEMA_V1_TO_V2)?,
            other => {
                return Err(super::StoreError::Invalid(format!(
                    "No migration step registered from schema v{other}."
                )));
            }
        }
        current += 1;
    }
    let _ = (conn, to); // schema step closures land here in future versions
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::schema::{CURRENT_SCHEMA_VERSION, SCHEMA_V1, SCHEMA_V1_TO_V2};
    use rusqlite::Connection;

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA_V1).unwrap();
        conn
    }

    #[test]
    fn apply_from_0_to_1_is_noop_after_schema_v1() {
        let conn = conn();
        // Schema already at v1 tables; apply must succeed without re-creating.
        apply(&conn, 0, 1).unwrap();
    }

    #[test]
    fn apply_rejects_unregistered_step() {
        let conn = conn();
        let err = apply(&conn, 5, 6).unwrap_err();
        assert!(matches!(err, super::super::StoreError::Invalid(_)));
    }

    /// A fresh database applies SCHEMA_V1 directly and is already at the
    /// current version, so the v1→v2 step must not be required and must be a
    /// no-op (CREATE TABLE IF NOT EXISTS) if it runs anyway.
    #[test]
    fn fresh_database_already_has_connector_cache_tables() {
        let conn = conn();
        // The connector-cache tables exist without running the migration step.
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('connector_cache','connector_cache_settings');",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 2);
        // Running the step anyway is idempotent.
        apply(&conn, 1, CURRENT_SCHEMA_VERSION).unwrap();
    }

    /// An existing v1 database (no connector-cache tables) is upgraded by the
    /// v1→v2 step, which adds exactly the connector-cache tables and indices.
    #[test]
    fn v1_to_v2_step_adds_connector_cache_tables_to_existing_database() {
        // A pre-v2 schema: only the tables that existed before connector cache.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE preferences (
              key TEXT PRIMARY KEY, payload BLOB NOT NULL,
              payload_nonce BLOB NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE migration_log (
              source TEXT PRIMARY KEY, checksum TEXT NOT NULL, status TEXT NOT NULL,
              migrated_at TEXT NOT NULL, diagnostics BLOB NOT NULL,
              diagnostics_nonce BLOB NOT NULL
            );
            "#,
        )
        .unwrap();
        // Before: connector-cache tables absent.
        let before: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('connector_cache','connector_cache_settings');",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(before, 0);

        apply(&conn, 1, CURRENT_SCHEMA_VERSION).unwrap();

        // After: both tables and the three connector-cache indices exist.
        let tables: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('connector_cache','connector_cache_settings');",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tables, 2);
        let indices: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name LIKE 'idx_connector_cache%';",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(indices, 3);
    }

    /// The v1→v2 DDL is a strict subset of the current full schema: applying
    /// SCHEMA_V1 then SCHEMA_V1_TO_V2 must not error (idempotency invariant).
    #[test]
    fn v1_to_v2_delta_is_idempotent_over_full_schema() {
        let conn = conn();
        conn.execute_batch(SCHEMA_V1_TO_V2).unwrap();
    }
}
