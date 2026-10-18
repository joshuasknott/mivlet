//! Shared SQLite schema probes and migration guards.

use rusqlite::{Connection, OptionalExtension};

use super::super::{Result, StoreError};

pub(super) fn foreign_key_target(
    conn: &Connection,
    table: &str,
    column: &str,
) -> Result<Option<String>> {
    conn.query_row(
        r#"SELECT "table"
             FROM pragma_foreign_key_list(?1)
            WHERE "from"=?2
            LIMIT 1"#,
        rusqlite::params![table, column],
        |row| row.get(0),
    )
    .optional()
    .map_err(StoreError::from)
}

pub(super) fn require_foreign_keys_disabled(conn: &Connection, migration: &str) -> Result<()> {
    let enabled = conn.pragma_query_value(None, "foreign_keys", |row| row.get::<_, i64>(0))? != 0;
    if enabled {
        return Err(StoreError::Invalid(format!(
            "Schema migration {migration} requires foreign-key enforcement to be disabled before its transaction starts."
        )));
    }
    Ok(())
}

pub(super) fn table_has_composite_primary_key(
    conn: &Connection,
    table: &str,
    first: &str,
    second: &str,
) -> Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table});"))?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(1)?, row.get::<_, i64>(5)?))
    })?;
    let mut keys = rows
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .filter(|(_, position)| *position > 0)
        .collect::<Vec<_>>();
    keys.sort_by_key(|(_, position)| *position);
    Ok(keys == [(first.to_string(), 1), (second.to_string(), 2)])
}

pub(super) fn add_ownership_columns(
    conn: &Connection,
    table: &str,
    include_project: bool,
) -> Result<()> {
    if !table_exists(conn, table)? {
        return Ok(());
    }
    if !table_has_column(conn, table, "workspace_id")? {
        // Table names are fixed internal constants, never user input.
        conn.execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';"
        ))?;
    }
    if include_project && !table_has_column(conn, table, "project_id")? {
        conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN project_id TEXT;"))?;
    }
    Ok(())
}

pub(super) fn table_exists(conn: &Connection, table: &str) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1);",
        [table],
        |row| row.get(0),
    )?)
}

pub(super) fn table_has_column(conn: &Connection, table: &str, name: &str) -> Result<bool> {
    use rusqlite::types::Value;
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table});"))?;
    let rows = stmt.query_map([], |row| row.get::<_, Value>(1))?;
    for row in rows {
        if matches!(row?, Value::Text(ref text) if text == name) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Apply the v2→v3 audit_event extension, idempotently. The presence of the
/// `category` column is the probe: if it already exists (fresh SCHEMA_V1
/// database that was somehow marked v2, or a re-run after a partial apply), the
/// step only ensures the indices exist. If the `audit_event` table is absent
/// altogether (an artificial minimal schema in tests, never in production where
/// SCHEMA_V1 always creates it), the step is a no-op.

pub(super) fn audit_event_has_column(conn: &Connection, name: &str) -> Result<bool> {
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
