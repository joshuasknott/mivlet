//! Repairs for historical schema rebuilds whose foreign-key shape changed.

use rusqlite::Connection;

use super::super::{Result, StoreError};
use super::helpers::{
    foreign_key_target, require_foreign_keys_disabled, table_exists, table_has_column,
};

pub(super) fn apply_v42_to_v43(conn: &Connection) -> Result<()> {
    if !table_exists(conn, "thread")? || !table_exists(conn, "message")? {
        return Ok(());
    }
    if !table_has_column(conn, "thread", "selected_head_id")? {
        conn.execute_batch("ALTER TABLE thread ADD COLUMN selected_head_id TEXT;")?;
    }
    if !table_has_column(conn, "message", "parent_message_id")? {
        conn.execute_batch("ALTER TABLE message ADD COLUMN parent_message_id TEXT;")?;
    }
    conn.execute_batch(
        "UPDATE message SET parent_message_id=previous_message_id WHERE parent_message_id IS NULL;
         UPDATE thread SET selected_head_id=last_message_id WHERE selected_head_id IS NULL;
         CREATE INDEX IF NOT EXISTS idx_message_parent ON message(workspace_id,thread_id,parent_message_id,seq);",
    )?;
    Ok(())
}

pub(super) fn apply_v38_to_v39(conn: &Connection) -> Result<()> {
    if !table_exists(conn, "backend_connection")?
        || foreign_key_target(conn, "backend_connection", "internal_user_id")?.as_deref()
            != Some("fable_internal_user_mirror")
    {
        return Ok(());
    }
    require_foreign_keys_disabled(conn, "v38 -> v39")?;

    // Keep child tables pointed at the canonical name while the parent is
    // rebuilt. With legacy rename semantics, their exact rows and foreign keys
    // remain untouched and are validated by the migration runner before commit.
    conn.pragma_update(None, "legacy_alter_table", "ON")?;
    let rebuild = conn.execute_batch(
        r#"
        ALTER TABLE backend_connection RENAME TO backend_connection_v38_account_bound;
        CREATE TABLE backend_connection (
          internal_user_id TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          connected_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (internal_user_id, provider_id)
        );
        INSERT INTO backend_connection (
          internal_user_id,provider_id,connected_at,updated_at
        )
        SELECT internal_user_id,provider_id,connected_at,updated_at
        FROM backend_connection_v38_account_bound;
        DROP TABLE backend_connection_v38_account_bound;
        CREATE INDEX idx_backend_connection_user
          ON backend_connection(internal_user_id,updated_at);
        "#,
    );
    let reset = conn
        .pragma_update(None, "legacy_alter_table", "OFF")
        .map_err(StoreError::from);
    match (rebuild.map_err(StoreError::from), reset) {
        (Err(error), _) => Err(error),
        (Ok(()), Err(error)) => Err(error),
        (Ok(()), Ok(())) => Ok(()),
    }
}

pub(super) fn apply_v35_to_v36(conn: &Connection) -> Result<()> {
    if foreign_key_target(conn, "run", "thread_id")?.as_deref() != Some("thread_v10") {
        return Ok(());
    }
    require_foreign_keys_disabled(conn, "v35 -> v36")?;

    // Preserve every existing dependent reference to the canonical `run`
    // table while the broken parent is moved aside. Without legacy rename
    // semantics SQLite rewrites child foreign keys to the temporary name and
    // recreates the same dangling-reference bug.
    conn.pragma_update(None, "legacy_alter_table", "ON")?;
    let rebuild = conn.execute_batch(
        r#"
        ALTER TABLE run RENAME TO run_v35_broken;
        CREATE TABLE run (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL DEFAULT 'default' REFERENCES workspace(id) ON DELETE CASCADE,
          thread_id TEXT REFERENCES thread(id) ON DELETE CASCADE,
          provider_id TEXT NOT NULL,
          model TEXT NOT NULL,
          status TEXT NOT NULL,
          turn INTEGER NOT NULL DEFAULT 0,
          recoverable INTEGER NOT NULL DEFAULT 0,
          retry_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          payload BLOB NOT NULL,
          payload_nonce BLOB NOT NULL
        );
        INSERT INTO run (
          id,workspace_id,thread_id,provider_id,model,status,turn,recoverable,
          retry_count,created_at,updated_at,payload,payload_nonce
        )
        SELECT
          id,workspace_id,thread_id,provider_id,model,status,turn,recoverable,
          retry_count,created_at,updated_at,payload,payload_nonce
        FROM run_v35_broken;
        DROP TABLE run_v35_broken;
        CREATE INDEX idx_run_status ON run(workspace_id,status);
        CREATE INDEX idx_run_thread ON run(workspace_id,thread_id);
        "#,
    );
    let reset = conn.pragma_update(None, "legacy_alter_table", "OFF");
    rebuild?;
    reset?;
    Ok(())
}

fn run_child_needs_repair(conn: &Connection, table: &str) -> Result<bool> {
    if !table_exists(conn, table)? {
        return Ok(false);
    }
    match foreign_key_target(conn, table, "run_id")?.as_deref() {
        Some("run") => Ok(false),
        Some("run_v35_broken") => Ok(true),
        Some(other) => Err(StoreError::Invalid(format!(
            "Schema v36 has an unexpected {table}.run_id parent ({other})."
        ))),
        None => Err(StoreError::Invalid(format!(
            "Schema v36 is missing the required {table}.run_id foreign key."
        ))),
    }
}

pub(super) fn apply_v36_to_v37(conn: &Connection) -> Result<()> {
    // A database can reach v36 only after the run parent itself was repaired,
    // but keeping this idempotent call makes partial/retried migrations safe.
    apply_v35_to_v36(conn)?;

    let rebuild_tool_call = run_child_needs_repair(conn, "tool_call")?;
    let rebuild_approval = run_child_needs_repair(conn, "approval")?;
    let rebuild_artifact = run_child_needs_repair(conn, "artifact")?;
    if !rebuild_tool_call && !rebuild_approval && !rebuild_artifact {
        return Ok(());
    }
    require_foreign_keys_disabled(conn, "v36 -> v37")?;

    // With foreign keys disabled before the migration transaction and legacy
    // rename behavior enabled, dependent tables keep pointing at the canonical
    // names while each affected child is rebuilt. The store runs
    // `foreign_key_check` before the transaction can commit.
    conn.pragma_update(None, "legacy_alter_table", "ON")?;
    let rebuild = (|| -> Result<()> {
        if rebuild_tool_call {
            conn.execute_batch(
                r#"
                ALTER TABLE tool_call RENAME TO tool_call_v36_broken;
                CREATE TABLE tool_call (
                  id TEXT PRIMARY KEY,
                  run_id TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
                  tool TEXT NOT NULL,
                  status TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  payload BLOB NOT NULL,
                  payload_nonce BLOB NOT NULL
                );
                INSERT INTO tool_call
                  (id,run_id,tool,status,created_at,payload,payload_nonce)
                SELECT id,run_id,tool,status,created_at,payload,payload_nonce
                  FROM tool_call_v36_broken;
                DROP TABLE tool_call_v36_broken;
                CREATE INDEX idx_tool_call_run ON tool_call(run_id);
                "#,
            )?;
        }
        if rebuild_approval {
            conn.execute_batch(
                r#"
                ALTER TABLE approval RENAME TO approval_v36_broken;
                CREATE TABLE approval (
                  id TEXT PRIMARY KEY,
                  run_id TEXT REFERENCES run(id) ON DELETE CASCADE,
                  service TEXT NOT NULL,
                  action TEXT NOT NULL,
                  mode TEXT NOT NULL,
                  risk_level TEXT NOT NULL,
                  decision TEXT NOT NULL,
                  request_fingerprint TEXT NOT NULL,
                  decided_at TEXT NOT NULL,
                  payload BLOB NOT NULL,
                  payload_nonce BLOB NOT NULL
                );
                INSERT INTO approval
                  (id,run_id,service,action,mode,risk_level,decision,
                   request_fingerprint,decided_at,payload,payload_nonce)
                SELECT id,run_id,service,action,mode,risk_level,decision,
                       request_fingerprint,decided_at,payload,payload_nonce
                  FROM approval_v36_broken;
                DROP TABLE approval_v36_broken;
                CREATE INDEX idx_approval_run ON approval(run_id);
                CREATE INDEX idx_approval_rules
                  ON approval(service,action) WHERE decision='rule';
                "#,
            )?;
        }
        if rebuild_artifact {
            conn.execute_batch(
                r#"
                ALTER TABLE artifact RENAME TO artifact_v36_broken;
                CREATE TABLE artifact (
                  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
                  owner_subject TEXT NOT NULL,
                  authority TEXT NOT NULL CHECK(authority='local'),
                  visibility TEXT NOT NULL CHECK(visibility='member-private'),
                  owner_member_id TEXT,
                  owner_internal_user_id TEXT,
                  id TEXT NOT NULL,
                  run_id TEXT REFERENCES run(id) ON DELETE CASCADE,
                  thread_id TEXT REFERENCES thread(id) ON DELETE CASCADE,
                  source_message_id TEXT,
                  kind TEXT NOT NULL,
                  status TEXT NOT NULL DEFAULT 'draft',
                  revision INTEGER NOT NULL DEFAULT 1,
                  current_version_id TEXT NOT NULL,
                  title_fingerprint TEXT NOT NULL,
                  content_fingerprint TEXT NOT NULL,
                  size_bytes INTEGER NOT NULL,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  payload BLOB NOT NULL,
                  payload_nonce BLOB NOT NULL,
                  PRIMARY KEY(workspace_id,owner_subject,id),
                  CHECK ((owner_member_id IS NOT NULL) != (owner_internal_user_id IS NOT NULL))
                );
                INSERT INTO artifact (
                  workspace_id,owner_subject,authority,visibility,owner_member_id,
                  owner_internal_user_id,id,run_id,thread_id,source_message_id,
                  kind,status,revision,current_version_id,title_fingerprint,
                  content_fingerprint,size_bytes,created_at,updated_at,payload,payload_nonce
                )
                SELECT
                  workspace_id,owner_subject,authority,visibility,owner_member_id,
                  owner_internal_user_id,id,run_id,thread_id,source_message_id,
                  kind,status,revision,current_version_id,title_fingerprint,
                  content_fingerprint,size_bytes,created_at,updated_at,payload,payload_nonce
                FROM artifact_v36_broken;
                DROP TABLE artifact_v36_broken;
                CREATE INDEX idx_artifact_run
                  ON artifact(workspace_id,owner_subject,run_id);
                CREATE INDEX idx_artifact_thread
                  ON artifact(workspace_id,owner_subject,thread_id,created_at);
                "#,
            )?;
        }
        Ok(())
    })();
    let reset = conn.pragma_update(None, "legacy_alter_table", "OFF");
    rebuild?;
    reset?;
    Ok(())
}
