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
            // Future: 1 => { step_v1_to_v2(conn)?; }
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
    use crate::store::schema::SCHEMA_V1;
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
}
