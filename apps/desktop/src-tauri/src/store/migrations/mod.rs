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
            // 2 → 3: extend audit_event with non-secret query columns for the
            // inspectable action-history surface. Fresh databases already have
            // the columns through SCHEMA_V1; existing v2 databases receive them
            // through SCHEMA_V2_TO_V3. SQLite lacks `ADD COLUMN IF NOT EXISTS`,
            // so the step probes for the `category` column and only runs the
            // ALTER batch when it is absent (idempotent over a partial apply).
            2 => apply_v2_to_v3(conn)?,
            // 3 → 4: add the encrypted scheduler/workflow tables. Fresh
            // databases already have them through SCHEMA_V1; existing v3
            // databases receive them through the idempotent SCHEMA_V3_TO_V4
            // delta. All tables are new (`CREATE TABLE IF NOT EXISTS`), so no
            // column probe is required — re-running is a strict no-op.
            3 => conn.execute_batch(crate::store::schema::SCHEMA_V3_TO_V4)?,
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

/// Apply the v2→v3 audit_event extension, idempotently. The presence of the
/// `category` column is the probe: if it already exists (fresh SCHEMA_V1
/// database that was somehow marked v2, or a re-run after a partial apply), the
/// step only ensures the indices exist. If the `audit_event` table is absent
/// altogether (an artificial minimal schema in tests, never in production where
/// SCHEMA_V1 always creates it), the step is a no-op.
fn apply_v2_to_v3(conn: &Connection) -> super::Result<()> {
    let table_exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='audit_event';",
        [],
        |row| row.get(0),
    )?;
    if table_exists == 0 {
        return Ok(());
    }
    if !audit_event_has_column(conn, "category")? {
        conn.execute_batch(crate::store::schema::SCHEMA_V2_TO_V3)?;
        return Ok(());
    }
    // Columns already present; just backfill any missing indices.
    conn.execute_batch(
        r#"
        CREATE INDEX IF NOT EXISTS idx_audit_category ON audit_event(category);
        CREATE INDEX IF NOT EXISTS idx_audit_status ON audit_event(status);
        CREATE INDEX IF NOT EXISTS idx_audit_correlation ON audit_event(correlation_id);
        "#,
    )?;
    Ok(())
}

/// Probe whether `audit_event` currently has a column named `name`. Returns
/// `false` when the table itself is absent (the migration is a no-op in that
/// case — a fresh `audit_event` table will be created with the full column set
/// by `SCHEMA_V1` on a real database).
fn audit_event_has_column(conn: &Connection, name: &str) -> super::Result<bool> {
    use rusqlite::types::Value;
    let exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='audit_event';",
        [],
        |row| row.get(0),
    )?;
    if exists == 0 {
        return Ok(false);
    }
    let mut stmt = conn.prepare("PRAGMA table_info(audit_event);")?;
    let rows = stmt.query_map([], |row| {
        let value: Value = row.get(1)?;
        Ok(value)
    })?;
    for row in rows {
        let value = row?;
        if let Value::Text(text) = value {
            if text == name {
                return Ok(true);
            }
        }
    }
    Ok(false)
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

    /// A fresh database already has the v3 audit_event columns through SCHEMA_V1,
    /// so the v2→v3 step is a no-op (only index backfill) and must not error.
    #[test]
    fn fresh_database_already_has_audit_history_columns() {
        let conn = conn();
        apply(&conn, 2, CURRENT_SCHEMA_VERSION).unwrap();
        assert!(audit_event_has_column(&conn, "category").unwrap());
        assert!(audit_event_has_column(&conn, "correlation_id").unwrap());
        assert!(audit_event_has_column(&conn, "summary").unwrap());
    }

    /// An existing v2 database (audit_event without the query columns) is
    /// upgraded by the v2→v3 step, which adds exactly the new columns.
    #[test]
    fn v2_to_v3_step_adds_audit_history_columns_to_existing_database() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        // A pre-v3 audit_event table (legacy shape: only the original columns).
        conn.execute_batch(
            r#"
            CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE audit_event (
              id TEXT PRIMARY KEY, kind TEXT NOT NULL, actor TEXT NOT NULL,
              created_at TEXT NOT NULL, payload BLOB NOT NULL, payload_nonce BLOB NOT NULL
            );
            "#,
        )
        .unwrap();
        // Seed a legacy row so we can confirm its defaults are queryable.
        conn.execute(
            "INSERT INTO audit_event (id, kind, actor, created_at, payload, payload_nonce)
             VALUES ('legacy-1', 'approval', 'user', '2026-01-01T00:00:00Z', x'00', x'00');",
            [],
        )
        .unwrap();
        assert!(!audit_event_has_column(&conn, "category").unwrap());

        apply(&conn, 2, CURRENT_SCHEMA_VERSION).unwrap();

        assert!(audit_event_has_column(&conn, "category").unwrap());
        assert!(audit_event_has_column(&conn, "correlation_id").unwrap());
        // The legacy row receives the non-secret defaults.
        let (category, status, summary): (String, String, String) = conn
            .query_row(
                "SELECT category, status, summary FROM audit_event WHERE id = 'legacy-1';",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(category, "approval");
        assert_eq!(status, "");
        assert_eq!(summary, "");
    }

    /// The v2→v3 step is idempotent: running it twice must not error (the column
    /// probe short-circuits the ALTER batch on the second run).
    #[test]
    fn v2_to_v3_step_is_idempotent() {
        let conn = conn();
        apply(&conn, 2, CURRENT_SCHEMA_VERSION).unwrap();
        apply(&conn, 2, CURRENT_SCHEMA_VERSION).unwrap();
        assert!(audit_event_has_column(&conn, "category").unwrap());
    }
}
