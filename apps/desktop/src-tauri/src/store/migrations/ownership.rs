//! Foundational ownership, account, sync, and audit schema upgrades.

use rusqlite::Connection;

use super::super::{Result, StoreError};
use super::helpers::{
    add_ownership_columns, audit_event_has_column, table_exists, table_has_column,
    table_has_composite_primary_key,
};

pub(super) fn apply_v4_to_v5(conn: &Connection) -> Result<()> {
    // Some migration unit fixtures intentionally model only the table touched
    // by an earlier step. Production schemas always have both parents; leave
    // partial fixtures untouched instead of creating dangling foreign keys.
    if !table_exists(conn, "knowledge_source")? || !table_exists(conn, "memory_record")? {
        return Ok(());
    }
    let rebuild_knowledge = table_exists(conn, "knowledge_source")?
        && !table_has_composite_primary_key(conn, "knowledge_source", "workspace_id", "id")?;
    let rebuild_memory = table_exists(conn, "memory_record")?
        && !table_has_composite_primary_key(conn, "memory_record", "workspace_id", "id")?;
    // SCHEMA_V1 runs before migrations and may have created these empty tables
    // against a legacy parent shape. Recreate them after the parent rebuild.
    if rebuild_knowledge || rebuild_memory {
        conn.execute_batch(
            "DROP TABLE IF EXISTS pinned_context; DROP TABLE IF EXISTS knowledge_chunk;",
        )?;
    }

    if rebuild_knowledge {
        conn.execute_batch(
            r#"
            ALTER TABLE knowledge_source RENAME TO knowledge_source_v4;
            CREATE TABLE knowledge_source (
              workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
              id TEXT NOT NULL,
              project_id TEXT REFERENCES project(id) ON DELETE CASCADE,
              connector_id TEXT NOT NULL,
              connector_account_id TEXT NOT NULL DEFAULT '',
              external_id TEXT NOT NULL DEFAULT '',
              kind TEXT NOT NULL,
              trust TEXT NOT NULL,
              pinned INTEGER NOT NULL DEFAULT 0,
              disabled INTEGER NOT NULL DEFAULT 0,
              content_fingerprint TEXT NOT NULL,
              size_bytes INTEGER NOT NULL,
              imported_at TEXT NOT NULL,
              origin TEXT NOT NULL,
              payload BLOB NOT NULL,
              payload_nonce BLOB NOT NULL,
              PRIMARY KEY (workspace_id, id)
            );
            INSERT INTO knowledge_source (
              workspace_id, id, project_id, connector_id, kind, trust, pinned,
              content_fingerprint, size_bytes, imported_at, origin, payload, payload_nonce
            ) SELECT workspace_id, id, project_id, connector_id, kind, trust, pinned,
                     content_fingerprint, size_bytes, imported_at, origin, payload, payload_nonce
              FROM knowledge_source_v4;
            DROP TABLE knowledge_source_v4;
            "#,
        )?;
    }

    if rebuild_memory {
        conn.execute_batch(
            r#"
            ALTER TABLE memory_record RENAME TO memory_record_v4;
            CREATE TABLE memory_record (
              workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
              id TEXT NOT NULL,
              project_id TEXT REFERENCES project(id) ON DELETE CASCADE,
              kind TEXT NOT NULL,
              pinned INTEGER NOT NULL DEFAULT 0,
              approved INTEGER NOT NULL DEFAULT 0,
              disabled INTEGER NOT NULL DEFAULT 0,
              forgotten_at TEXT,
              created_at TEXT NOT NULL,
              payload BLOB NOT NULL,
              payload_nonce BLOB NOT NULL,
              PRIMARY KEY (workspace_id, id)
            );
            INSERT INTO memory_record (
              workspace_id, id, project_id, kind, pinned, approved, created_at, payload, payload_nonce
            ) SELECT workspace_id, id, project_id, kind, pinned, approved, created_at, payload, payload_nonce
              FROM memory_record_v4;
            DROP TABLE memory_record_v4;
            "#,
        )?;
    }

    conn.execute_batch(
        r#"
        CREATE INDEX IF NOT EXISTS idx_knowledge_connector ON knowledge_source(connector_id);
        CREATE INDEX IF NOT EXISTS idx_knowledge_pinned ON knowledge_source(pinned);
        CREATE INDEX IF NOT EXISTS idx_knowledge_workspace ON knowledge_source(workspace_id, project_id);
        CREATE INDEX IF NOT EXISTS idx_memory_kind ON memory_record(kind);
        CREATE INDEX IF NOT EXISTS idx_memory_pinned ON memory_record(pinned);
        CREATE INDEX IF NOT EXISTS idx_memory_workspace ON memory_record(workspace_id, project_id);
        CREATE TABLE IF NOT EXISTS knowledge_chunk (
          workspace_id TEXT NOT NULL, source_id TEXT NOT NULL, id TEXT NOT NULL,
          ordinal INTEGER NOT NULL, content_fingerprint TEXT NOT NULL,
          payload BLOB NOT NULL, payload_nonce BLOB NOT NULL,
          PRIMARY KEY (workspace_id, id),
          FOREIGN KEY (workspace_id, source_id)
            REFERENCES knowledge_source(workspace_id, id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_knowledge_chunk_source
          ON knowledge_chunk(workspace_id, source_id, ordinal);
        CREATE TABLE IF NOT EXISTS pinned_context (
          workspace_id TEXT NOT NULL, id TEXT NOT NULL, source_id TEXT, memory_id TEXT,
          scope_level TEXT NOT NULL, project_id TEXT, thread_id TEXT, pinned_at TEXT NOT NULL,
          PRIMARY KEY (workspace_id, id),
          CHECK ((source_id IS NOT NULL) != (memory_id IS NOT NULL)),
          FOREIGN KEY (workspace_id, source_id)
            REFERENCES knowledge_source(workspace_id, id) ON DELETE CASCADE,
          FOREIGN KEY (workspace_id, memory_id)
            REFERENCES memory_record(workspace_id, id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_pinned_context_scope
          ON pinned_context(workspace_id, scope_level, project_id, thread_id);
        CREATE TABLE IF NOT EXISTS knowledge_tombstone (
          workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
          id TEXT NOT NULL, deleted_at TEXT NOT NULL, PRIMARY KEY (workspace_id, id)
        );
        CREATE TABLE IF NOT EXISTS memory_tombstone (
          workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
          id TEXT NOT NULL, forgotten_at TEXT NOT NULL, PRIMARY KEY (workspace_id, id)
        );
        CREATE TABLE IF NOT EXISTS connector_cache_tombstone (
          workspace_id TEXT NOT NULL, connector_id TEXT NOT NULL,
          provider_item_id TEXT NOT NULL, deleted_at TEXT NOT NULL,
          PRIMARY KEY (workspace_id, connector_id, provider_item_id)
        );
        "#,
    )?;
    Ok(())
}

/// Apply the v5→v6 connector_cache `search_text` column, idempotently. The
/// presence of the `search_text` column is the probe: if it already exists
/// (fresh SCHEMA_V1 database, or a re-run after a partial apply) the step only
/// backfills the covering index. If the `connector_cache` table is absent
/// altogether (an artificial minimal schema in tests), the step is a no-op.
///
/// Existing rows are NOT backfilled here: the migration runs with only a
/// `&Connection` (no vault), so the payload-derived plaintext cannot be derived.
/// Backfill is performed lazily by the store on first read after upgrade (see
/// `repos::connector_cache::backfill_search_text`), which has the vault.
pub(super) fn apply_v5_to_v6(conn: &Connection) -> Result<()> {
    if table_exists(conn, "connector_cache")? {
        if !table_has_column(conn, "connector_cache", "search_text")? {
            conn.execute_batch(crate::store::schema::SCHEMA_V5_TO_V6)?;
        } else {
            conn.execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_connector_cache_search_text
                 ON connector_cache(workspace_id, disabled, search_text);",
            )?;
        }
    }
    // The additional v6 indexes are independent of connector_cache. Guard each
    // table because migration unit fixtures deliberately use partial schemas.
    if table_exists(conn, "approval")? {
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_approval_rules
             ON approval(service, action) WHERE decision='rule';",
        )?;
    }
    if table_exists(conn, "connector_account")? {
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_connector_account_credential
             ON connector_account(credential_ref) WHERE credential_ref <> '';",
        )?;
    }
    Ok(())
}

pub(super) fn apply_v7_to_v8(conn: &Connection) -> Result<()> {
    // Minimal historical-schema fixtures can reach this step without the v7
    // sync tables or workspace root. Production v7 databases always have both;
    // keep those narrow fixtures useful without manufacturing partial mirrors.
    if !table_exists(conn, "workspace")? || !table_exists(conn, "cloud_workspace_link")? {
        return Ok(());
    }
    if table_has_column(conn, "cloud_workspace_link", "fable_workspace_id")? {
        return Ok(());
    }
    ensure_v7_sync_rows_have_links(conn)?;
    conn.execute_batch(crate::store::schema::SCHEMA_V7_TO_V8)?;
    Ok(())
}

pub(super) fn apply_v8_to_v9(conn: &Connection) -> Result<()> {
    // Fresh databases already receive this table through SCHEMA_V1. The
    // explicit existence probe also makes a re-run after an interrupted
    // migration harmless.
    if !table_exists(conn, "active_workspace_selection")? {
        conn.execute_batch(crate::store::schema::SCHEMA_V8_TO_V9)?;
    }
    Ok(())
}

pub(super) fn apply_v9_to_v10(conn: &Connection) -> Result<()> {
    if table_exists(conn, "fable_device_mirror")? {
        let registered = table_has_column(conn, "fable_device_mirror", "registered_at")?;
        let last_seen = table_has_column(conn, "fable_device_mirror", "last_seen_at")?;
        let revoked = table_has_column(conn, "fable_device_mirror", "revoked_at")?;
        if !registered && !last_seen && !revoked {
            conn.execute_batch(crate::store::schema::SCHEMA_V9_TO_V10)?;
        } else {
            for (present, sql) in [
                (registered, "ALTER TABLE fable_device_mirror ADD COLUMN registered_at TEXT NOT NULL DEFAULT '';"),
                (last_seen, "ALTER TABLE fable_device_mirror ADD COLUMN last_seen_at TEXT;"),
                (revoked, "ALTER TABLE fable_device_mirror ADD COLUMN revoked_at TEXT;"),
            ] {
                if !present {
                    conn.execute_batch(sql)?;
                }
            }
        }
    }
    Ok(())
}

/// The v8 rebuild derives the Mivlet workspace and attribution for every sync
/// envelope from its v7 workspace link. Refuse the migration when an orphaned
/// cursor, outbox row, shadow, or conflict would otherwise be dropped by the
/// INNER JOINs in `SCHEMA_V7_TO_V8`.
fn ensure_v7_sync_rows_have_links(conn: &Connection) -> Result<()> {
    for table in [
        "cloud_sync_cursor",
        "cloud_mutation_outbox",
        "cloud_record_shadow",
        "cloud_conflict",
    ] {
        let sql = format!(
            "SELECT EXISTS(SELECT 1 FROM {table} AS legacy_row \
             LEFT JOIN cloud_workspace_link AS link \
               ON link.local_workspace_id = legacy_row.local_workspace_id \
             WHERE link.local_workspace_id IS NULL);"
        );
        let orphaned: bool = conn.query_row(&sql, [], |row| row.get(0))?;
        if orphaned {
            return Err(StoreError::Invalid(format!(
                "Cannot migrate v7 cloud sync state: {table} contains an orphaned workspace row."
            )));
        }
    }
    Ok(())
}

pub(super) fn apply_v6_to_v7(conn: &Connection) -> Result<()> {
    // Fresh databases receive the complete current (v8) DDL before migration
    // bookkeeping runs. Do not replay v7's Clerk-shaped index definitions over
    // the v8 table; an actual v6 database has no cloud link table yet.
    if table_exists(conn, "cloud_workspace_link")?
        && table_has_column(conn, "cloud_workspace_link", "fable_workspace_id")?
    {
        return Ok(());
    }
    conn.execute_batch(crate::store::schema::SCHEMA_V6_TO_V7)?;
    Ok(())
}

pub(super) fn apply_v3_to_v4(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS workspace (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL,
           created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL
         );",
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO workspace (id, name, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?3);",
        rusqlite::params![
            crate::store::repos::scope::DEFAULT_WORKSPACE_ID,
            "My Workspace",
            "1970-01-01T00:00:00Z"
        ],
    )?;

    // These two tables used their domain key as the primary key before v4.
    // Rebuild them so the same setting/connector can exist in two workspaces.
    if table_exists(conn, "preferences")? && !table_has_column(conn, "preferences", "workspace_id")?
    {
        conn.execute_batch(
            r#"
            ALTER TABLE preferences RENAME TO preferences_v3;
            CREATE TABLE preferences (
              workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
              key TEXT NOT NULL,
              payload BLOB NOT NULL,
              payload_nonce BLOB NOT NULL,
              updated_at TEXT NOT NULL,
              PRIMARY KEY (workspace_id, key)
            );
            INSERT INTO preferences (workspace_id, key, payload, payload_nonce, updated_at)
              SELECT 'default', key, payload, payload_nonce, updated_at FROM preferences_v3;
            DROP TABLE preferences_v3;
            "#,
        )?;
    }
    if table_exists(conn, "connector_account")?
        && !table_has_column(conn, "connector_account", "workspace_id")?
    {
        conn.execute_batch(
            r#"
            ALTER TABLE connector_account RENAME TO connector_account_v3;
            CREATE TABLE connector_account (
              workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
              project_id TEXT REFERENCES project(id) ON DELETE CASCADE,
              connector_id TEXT NOT NULL,
              account_id TEXT,
              status TEXT NOT NULL,
              expires_at INTEGER,
              credential_ref TEXT NOT NULL,
              connected_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              payload BLOB NOT NULL,
              payload_nonce BLOB NOT NULL,
              PRIMARY KEY (workspace_id, connector_id)
            );
            INSERT INTO connector_account (
              workspace_id, project_id, connector_id, account_id, status,
              expires_at, credential_ref, connected_at, updated_at, payload, payload_nonce
            )
              SELECT 'default', NULL, connector_id, account_id, status,
                     expires_at, credential_ref, connected_at, updated_at, payload, payload_nonce
              FROM connector_account_v3;
            DROP TABLE connector_account_v3;
            "#,
        )?;
    }

    add_ownership_columns(conn, "project", false)?;
    add_ownership_columns(conn, "knowledge_source", true)?;
    add_ownership_columns(conn, "memory_record", true)?;
    add_ownership_columns(conn, "schedule", true)?;
    if table_exists(conn, "connector_cache")?
        && !table_has_column(conn, "connector_cache", "project_id")?
    {
        conn.execute(
            "ALTER TABLE connector_cache ADD COLUMN project_id TEXT;",
            [],
        )?;
    }

    if table_exists(conn, "project")? {
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_project_workspace ON project(workspace_id);",
        )?;
    }
    if table_exists(conn, "connector_account")? {
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_connector_account_workspace
             ON connector_account(workspace_id);",
        )?;
    }
    if table_exists(conn, "knowledge_source")? {
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_knowledge_workspace
             ON knowledge_source(workspace_id, project_id);",
        )?;
    }
    if table_exists(conn, "memory_record")? {
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_memory_workspace
             ON memory_record(workspace_id, project_id);",
        )?;
    }
    if table_exists(conn, "schedule")? {
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_schedule_workspace
             ON schedule(workspace_id, project_id, enabled);",
        )?;
    }
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS workflow_definition (
          workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
          project_id TEXT REFERENCES project(id) ON DELETE CASCADE,
          id TEXT NOT NULL,
          version INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          payload BLOB NOT NULL,
          payload_nonce BLOB NOT NULL,
          PRIMARY KEY (workspace_id, id, version)
        );
        CREATE INDEX IF NOT EXISTS idx_workflow_definition_workspace
          ON workflow_definition(workspace_id, project_id, updated_at);
        CREATE TABLE IF NOT EXISTS workflow_run (
          workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
          project_id TEXT REFERENCES project(id) ON DELETE CASCADE,
          id TEXT NOT NULL,
          definition_id TEXT NOT NULL,
          definition_version INTEGER NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          payload BLOB NOT NULL,
          payload_nonce BLOB NOT NULL,
          PRIMARY KEY (workspace_id, id)
        );
        CREATE INDEX IF NOT EXISTS idx_workflow_run_workspace
          ON workflow_run(workspace_id, project_id, updated_at);
        CREATE INDEX IF NOT EXISTS idx_workflow_run_definition
          ON workflow_run(workspace_id, definition_id, definition_version);
        "#,
    )?;
    conn.execute_batch(crate::store::schema::SCHEMA_V3_TO_V4)?;
    Ok(())
}

/// Apply the v2→v3 audit_event extension, idempotently. The presence of the
/// `category` column is the probe: if it already exists (fresh SCHEMA_V1
/// database that was somehow marked v2, or a re-run after a partial apply), the
/// step only ensures the indices exist. If the `audit_event` table is absent
/// altogether (an artificial minimal schema in tests, never in production where
/// SCHEMA_V1 always creates it), the step is a no-op.
pub(super) fn apply_v2_to_v3(conn: &Connection) -> Result<()> {
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
