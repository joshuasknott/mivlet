//! Schema and data migrations for the durable store.
//!
//! See `docs/architecture/encrypted-storage.md`.
//!
//! - **Schema migrations** ([`apply`]) run forward-only step functions keyed by
//!   version, inside the migration transaction. v1 DDL is applied by
//!   [`crate::store::schema`]; this module owns v→v+1 steps for future versions.
//!
//! Pre-v37 JSON ingestion was retired after the schema-v37, recovery-backup,
//! portable-transfer, foreign-key, and restart fixtures passed. Forward SQLite
//! migrations remain data preserving and are the only startup migration path.

use rusqlite::{Connection, OptionalExtension};

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
            // 3 → 4: introduce the workspace ownership root, attach legacy
            // user-owned records to the compatibility workspace, and create
            // the workflow hand-off tables, then add the durable scheduler
            // tables from the schedule-SQLite integration.
            3 => apply_v3_to_v4(conn)?,
            // 4 → 5: make knowledge/memory identities workspace-composite,
            // add durable lifecycle columns and workspace-bound dependencies.
            4 => apply_v4_to_v5(conn)?,
            // 5 → 6: add a plaintext `search_text` column to connector_cache so
            // lexical search filters via SQL LIKE without decrypting payloads.
            // Existing rows are backfilled lazily by the store on first read.
            5 => apply_v5_to_v6(conn)?,
            // 6 -> 7: add local cloud-team sync cache/outbox tables.
            6 => apply_v6_to_v7(conn)?,
            // 7 -> 8: replace the Clerk-organization-shaped local sync cache
            // with Mivlet-owned identity, membership, workspace, and device
            // mirrors. The SQL rebuild is data-preserving and runs inside the
            // Store migration transaction.
            7 => apply_v7_to_v8(conn)?,
            // 8 -> 9: add the per-internal-user hosted workspace selection.
            // The historical local `default` workspace remains untouched.
            8 => apply_v8_to_v9(conn)?,
            // 9 -> 10: retain secret-free hosted account-device observations.
            9 => apply_v9_to_v10(conn)?,
            // 10 -> 11: conversations become explicitly workspace-owned and
            // receive immutable revision checkpoints. Existing project-bound
            // rows derive their owner through project; no synthetic project is
            // ever created.
            10 => apply_v10_to_v11(conn)?,
            // 11 -> 12: provider connections become account-owned. Legacy
            // provider-only rows cannot be safely attributed and are retained
            // in an inaccessible quarantine table instead of being guessed.
            11 => apply_v11_to_v12(conn)?,
            // 12 -> 13: projects gain explicit local authority, member-private
            // ownership, optimistic revisions, lifecycle, and durable delete
            // tombstones. Existing encrypted payloads and ids are retained.
            12 => apply_v12_to_v13(conn)?,
            // 13 -> 14: add canonical local/member-private goals. Legacy
            // snapshot goals are deliberately not guessed into authority.
            13 => apply_v13_to_v14(conn)?,
            // 14 -> 15: Knowledge and Memory become explicitly owned by the
            // authenticated member (or stable local internal-user subject).
            // Only project rows with a provable private owner are adopted;
            // ambiguous rows and opaque documents are quarantined.
            14 => apply_v14_to_v15(conn)?,
            // 15 -> 16: artifacts gain an authenticated private owner and
            // immutable owner-bound version history. Legacy ciphertext cannot
            // be safely rebound to an owner, so it remains quarantined.
            15 => apply_v15_to_v16(conn)?,
            // 16 -> 17: normalized, owner-qualified encrypted artifact review
            // history linked to exact immutable versions.
            16 => apply_v16_to_v17(conn)?,
            // 17 -> 18: exact-version, owner-qualified artifact handoffs.
            17 => apply_v17_to_v18(conn)?,
            // 18 -> 19: establish the canonical Connection storage boundary.
            // Legacy connector-account metadata remains the compatibility
            // source because it has no authenticated creator; only a stable,
            // secret-free proposed identity is recorded for later adoption.
            18 => apply_v18_to_v19(conn)?,
            // 19 -> 20: persist the exact active Connection per connector in
            // the authenticated canonical store. Legacy active flags are not
            // guessed into authority by the migration.
            19 => apply_v19_to_v20(conn)?,
            // 20 -> 21: persist secret-free semantic capability implementation
            // observations. Evidence never grants authority and is usable only
            // while its exact canonical Connection revision remains current.
            20 => apply_v20_to_v21(conn)?,
            // 21 -> 22: add encrypted, member-private launch configuration for
            // local STDIO MCP servers. Migration creates no launch authority.
            21 => apply_v21_to_v22(conn)?,
            // 22 -> 23: add explicit, owner-qualified capability grants. The
            // migration creates no implicit authority or inferred rows.
            22 => apply_v22_to_v23(conn)?,
            // 23 -> 24: persist member-private missions and immutable generated
            // plan revisions. No mission or execution authority is inferred.
            23 => apply_v23_to_v24(conn)?,
            // 24 -> 25: add the encrypted append-only mission run journal.
            // Migration creates no runs, checkpoints, or execution authority.
            24 => apply_v24_to_v25(conn)?,
            // 25 -> 26: persist redacted checkpoint state separately from the
            // immutable checkpoint event. No checkpoint is inferred.
            25 => apply_v25_to_v26(conn)?,
            // 26 -> 27: persist immutable encrypted mission-worker output
            // receipts linked to exact completion events. No output is inferred.
            26 => apply_v26_to_v27(conn)?,
            // 27 -> 28: persist immutable encrypted mission-worker tool-result
            // receipts linked to exact run events. No tool result is inferred.
            27 => apply_v27_to_v28(conn)?,
            // 28 -> 29: persist bounded encrypted provider-route observations.
            // Migration creates no inferred performance evidence.
            28 => apply_v28_to_v29(conn)?,
            // 29 -> 30: persist bounded encrypted route-quality observations
            // derived only from native policy evaluation. No quality is inferred.
            29 => apply_v29_to_v30(conn)?,
            // 30 -> 31: bind only policy-accepted mission output to its exact
            // canonical artifact/version. Migration infers no artifacts.
            30 => apply_v30_to_v31(conn)?,
            // 31 -> 32: establish unambiguous legacy thread ownership and bind
            // canonical draft artifacts materialized directly from exact local
            // mission events. Migration infers neither owners nor artifacts when
            // their source facts are ambiguous.
            31 => apply_v31_to_v32(conn)?,
            // 32 -> 33: add empty canonical Routine, migration-evidence, and
            // scheduler-authority stores. No owner or execution authority is
            // inferred from legacy records.
            32 => conn.execute_batch(crate::store::schema::SCHEMA_V32_TO_V33)?,
            // 33 -> 34: add the empty node-local Routine trigger cursor. The
            // selected writer initializes cursor evidence; migration does not
            // invent a last-evaluated instant.
            33 => conn.execute_batch(crate::store::schema::SCHEMA_V33_TO_V34)?,
            // 34 -> 35: add an empty encrypted Mission approval-consumption
            // ledger. Migration creates no approval or execution authority.
            34 => conn.execute_batch(crate::store::schema::SCHEMA_V34_TO_V35)?,
            // 35 -> 36: repair the historical v10 conversation migration's
            // renamed thread foreign key on agent runs. No rows or authority
            // are inferred; the run table is rebuilt only when the dangling
            // `thread_v10` reference is present.
            35 => apply_v35_to_v36(conn)?,
            // 36 -> 37: repair any run-dependent table names rewritten by the
            // original v35 -> v36 parent rebuild. Remaining rows and every
            // child relationship are copied exactly; no authority is inferred.
            36 => apply_v36_to_v37(conn)?,
            // 37 -> 38: retire the orchestration-era mission, routine,
            // scheduler, workflow, artifact, and unused run-state stores.
            37 => {
                conn.execute_batch(crate::store::schema::RETIRED_ORCHESTRATION_STORAGE_CLEANUP)?
            }
            // 38 -> 39: provider credentials are owned by the stable local
            // installation principal, so their metadata must not require an
            // optional hosted-account mirror row. Existing connections and
            // their observation children are copied exactly.
            38 => apply_v38_to_v39(conn)?,
            // 39 -> 40: add empty member-private local schedule and occurrence
            // stores. No retired orchestration data or execution authority is
            // inferred by this migration.
            39 => conn.execute_batch(crate::store::schema::SCHEMA_V39_TO_V40)?,
            // 40 -> 41: add empty member-private shared project rooms and their
            // run-author ledger. Legacy project rows are deliberately ignored.
            40 => conn.execute_batch(crate::store::schema::SCHEMA_V40_TO_V41)?,
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

fn foreign_key_target(
    conn: &Connection,
    table: &str,
    column: &str,
) -> super::Result<Option<String>> {
    conn.query_row(
        r#"SELECT "table"
             FROM pragma_foreign_key_list(?1)
            WHERE "from"=?2
            LIMIT 1"#,
        rusqlite::params![table, column],
        |row| row.get(0),
    )
    .optional()
    .map_err(super::StoreError::from)
}

fn require_foreign_keys_disabled(conn: &Connection, migration: &str) -> super::Result<()> {
    let enabled = conn.pragma_query_value(None, "foreign_keys", |row| row.get::<_, i64>(0))? != 0;
    if enabled {
        return Err(super::StoreError::Invalid(format!(
            "Schema migration {migration} requires foreign-key enforcement to be disabled before its transaction starts."
        )));
    }
    Ok(())
}

fn apply_v38_to_v39(conn: &Connection) -> super::Result<()> {
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
        .map_err(super::StoreError::from);
    match (rebuild.map_err(super::StoreError::from), reset) {
        (Err(error), _) => Err(error),
        (Ok(()), Err(error)) => Err(error),
        (Ok(()), Ok(())) => Ok(()),
    }
}

fn apply_v35_to_v36(conn: &Connection) -> super::Result<()> {
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

fn run_child_needs_repair(conn: &Connection, table: &str) -> super::Result<bool> {
    if !table_exists(conn, table)? {
        return Ok(false);
    }
    match foreign_key_target(conn, table, "run_id")?.as_deref() {
        Some("run") => Ok(false),
        Some("run_v35_broken") => Ok(true),
        Some(other) => Err(super::StoreError::Invalid(format!(
            "Schema v36 has an unexpected {table}.run_id parent ({other})."
        ))),
        None => Err(super::StoreError::Invalid(format!(
            "Schema v36 is missing the required {table}.run_id foreign key."
        ))),
    }
}

fn apply_v36_to_v37(conn: &Connection) -> super::Result<()> {
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
    let rebuild = (|| -> super::Result<()> {
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

fn apply_v31_to_v32(conn: &Connection) -> super::Result<()> {
    let has_thread: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='thread')",
        [],
        |row| row.get(0),
    )?;
    if has_thread {
        conn.execute_batch(
            r#"
        UPDATE thread
        SET owner_member_id=(
          SELECT membership.member_id
          FROM active_workspace_selection selection
          JOIN fable_membership_mirror membership
            ON membership.fable_workspace_id=selection.fable_workspace_id
           AND membership.internal_user_id=selection.internal_user_id
           AND membership.status='active'
          WHERE selection.local_workspace_id=thread.workspace_id
        )
        WHERE owner_member_id IS NULL
          AND 1=(
            SELECT COUNT(*)
            FROM active_workspace_selection selection
            JOIN fable_membership_mirror membership
              ON membership.fable_workspace_id=selection.fable_workspace_id
             AND membership.internal_user_id=selection.internal_user_id
             AND membership.status='active'
            WHERE selection.local_workspace_id=thread.workspace_id
          );
        "#,
        )?;
    }
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS mission_direct_artifact_source (
          workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
          owner_member_id TEXT NOT NULL, mission_run_id TEXT NOT NULL,
          output_key TEXT NOT NULL, owner_subject TEXT NOT NULL,
          artifact_id TEXT NOT NULL, artifact_version_id TEXT NOT NULL,
          source_event_id TEXT NOT NULL, result_event_id TEXT NOT NULL,
          content_hash TEXT NOT NULL, created_at TEXT NOT NULL,
          PRIMARY KEY(workspace_id,owner_member_id,mission_run_id,output_key),
          UNIQUE(workspace_id,owner_subject,artifact_id),
          UNIQUE(workspace_id,owner_subject,artifact_id,artifact_version_id),
          FOREIGN KEY(workspace_id,owner_member_id,mission_run_id)
            REFERENCES mission_run_record(workspace_id,owner_member_id,id) ON DELETE CASCADE,
          FOREIGN KEY(workspace_id,owner_member_id,source_event_id)
            REFERENCES mission_run_event(workspace_id,owner_member_id,id) ON DELETE CASCADE,
          FOREIGN KEY(workspace_id,owner_member_id,result_event_id)
            REFERENCES mission_run_event(workspace_id,owner_member_id,id) ON DELETE CASCADE,
          FOREIGN KEY(workspace_id,owner_subject,artifact_id)
            REFERENCES artifact(workspace_id,owner_subject,id) ON DELETE CASCADE,
          FOREIGN KEY(workspace_id,owner_subject,artifact_id,artifact_version_id)
            REFERENCES artifact_version(workspace_id,owner_subject,artifact_id,id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_mission_direct_artifact_artifact
          ON mission_direct_artifact_source(workspace_id,owner_subject,artifact_id);
        CREATE TABLE IF NOT EXISTS mission_structured_intake_binding (
          workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
          owner_member_id TEXT NOT NULL, run_id TEXT NOT NULL, mission_id TEXT NOT NULL,
          plan_id TEXT NOT NULL, plan_revision_id TEXT NOT NULL,
          source_thread_id TEXT NOT NULL, project_id TEXT, start_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(workspace_id,owner_member_id,run_id),
          UNIQUE(workspace_id,owner_member_id,mission_id),
          UNIQUE(workspace_id,owner_member_id,source_thread_id,start_hash),
          FOREIGN KEY(workspace_id,owner_member_id,run_id)
            REFERENCES mission_run_record(workspace_id,owner_member_id,id) ON DELETE CASCADE,
          FOREIGN KEY(workspace_id,owner_member_id,mission_id)
            REFERENCES mission_record(workspace_id,owner_member_id,id) ON DELETE CASCADE,
          FOREIGN KEY(workspace_id,owner_member_id,plan_id)
            REFERENCES mission_plan_record(workspace_id,owner_member_id,id) ON DELETE CASCADE,
          FOREIGN KEY(workspace_id,owner_member_id,plan_revision_id)
            REFERENCES mission_plan_revision(workspace_id,owner_member_id,id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_mission_structured_intake_thread
          ON mission_structured_intake_binding(workspace_id,owner_member_id,source_thread_id,created_at);
        "#,
    )?;
    Ok(())
}

fn apply_v30_to_v31(conn: &Connection) -> super::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS mission_artifact_source (
          workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
          owner_member_id TEXT NOT NULL, mission_run_id TEXT NOT NULL,
          output_key TEXT NOT NULL, owner_subject TEXT NOT NULL,
          artifact_id TEXT NOT NULL, artifact_version_id TEXT NOT NULL,
          completion_event_id TEXT NOT NULL, evaluation_event_id TEXT NOT NULL,
          result_event_id TEXT NOT NULL, value_reference TEXT NOT NULL,
          content_hash TEXT NOT NULL, created_at TEXT NOT NULL,
          PRIMARY KEY(workspace_id,owner_member_id,mission_run_id,output_key),
          UNIQUE(workspace_id,owner_subject,artifact_id),
          UNIQUE(workspace_id,owner_subject,artifact_id,artifact_version_id),
          FOREIGN KEY(workspace_id,owner_member_id,mission_run_id)
            REFERENCES mission_run_record(workspace_id,owner_member_id,id) ON DELETE CASCADE,
          FOREIGN KEY(workspace_id,owner_member_id,completion_event_id)
            REFERENCES mission_run_event(workspace_id,owner_member_id,id) ON DELETE CASCADE,
          FOREIGN KEY(workspace_id,owner_member_id,evaluation_event_id)
            REFERENCES mission_run_event(workspace_id,owner_member_id,id) ON DELETE CASCADE,
          FOREIGN KEY(workspace_id,owner_member_id,result_event_id)
            REFERENCES mission_run_event(workspace_id,owner_member_id,id) ON DELETE CASCADE,
          FOREIGN KEY(workspace_id,owner_subject,artifact_id)
            REFERENCES artifact(workspace_id,owner_subject,id) ON DELETE CASCADE,
          FOREIGN KEY(workspace_id,owner_subject,artifact_id,artifact_version_id)
            REFERENCES artifact_version(workspace_id,owner_subject,artifact_id,id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_mission_artifact_artifact
          ON mission_artifact_source(workspace_id,owner_subject,artifact_id);
        "#,
    )?;
    Ok(())
}

fn apply_v29_to_v30(conn: &Connection) -> super::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS provider_route_quality_observation (
          internal_user_id TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          provider_route_id TEXT NOT NULL,
          policy_revision_ref TEXT NOT NULL,
          observation_id TEXT NOT NULL,
          evaluated_at TEXT NOT NULL,
          payload BLOB NOT NULL,
          payload_nonce BLOB NOT NULL,
          PRIMARY KEY(internal_user_id,observation_id),
          FOREIGN KEY(internal_user_id,provider_id)
            REFERENCES backend_connection(internal_user_id,provider_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_provider_route_quality_observation_route
          ON provider_route_quality_observation(internal_user_id,provider_route_id,policy_revision_ref,evaluated_at,observation_id);
        "#,
    )?;
    Ok(())
}

fn apply_v28_to_v29(conn: &Connection) -> super::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS provider_route_observation (
          internal_user_id TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          provider_route_id TEXT NOT NULL,
          observation_id TEXT NOT NULL,
          observed_at TEXT NOT NULL,
          payload BLOB NOT NULL,
          payload_nonce BLOB NOT NULL,
          PRIMARY KEY(internal_user_id,observation_id),
          FOREIGN KEY(internal_user_id,provider_id)
            REFERENCES backend_connection(internal_user_id,provider_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_provider_route_observation_route
          ON provider_route_observation(internal_user_id,provider_route_id,observed_at,observation_id);
        "#,
    )?;
    Ok(())
}

fn apply_v27_to_v28(conn: &Connection) -> super::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS mission_worker_tool_receipt (
          workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
          owner_member_id TEXT NOT NULL, run_id TEXT NOT NULL, worker_id TEXT NOT NULL,
          tool_event_id TEXT NOT NULL, call_key TEXT NOT NULL,
          output_reference TEXT NOT NULL, output_hash TEXT NOT NULL,
          size_bytes INTEGER NOT NULL CHECK(size_bytes >= 1 AND size_bytes <= 131072),
          created_at TEXT NOT NULL, payload BLOB NOT NULL, payload_nonce BLOB NOT NULL,
          PRIMARY KEY(workspace_id,owner_member_id,tool_event_id),
          UNIQUE(workspace_id,owner_member_id,run_id,worker_id,call_key),
          UNIQUE(workspace_id,owner_member_id,output_reference),
          FOREIGN KEY(workspace_id,owner_member_id,tool_event_id)
            REFERENCES mission_run_event(workspace_id,owner_member_id,id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_mission_worker_tool_run
          ON mission_worker_tool_receipt(workspace_id,owner_member_id,run_id,worker_id);
        "#,
    )?;
    Ok(())
}

fn apply_v26_to_v27(conn: &Connection) -> super::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS mission_worker_output_receipt (
          workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
          owner_member_id TEXT NOT NULL, run_id TEXT NOT NULL, worker_id TEXT NOT NULL,
          completion_event_id TEXT NOT NULL, output_key TEXT NOT NULL,
          value_reference TEXT NOT NULL, content_hash TEXT NOT NULL,
          size_bytes INTEGER NOT NULL CHECK(size_bytes >= 1 AND size_bytes <= 65536),
          created_at TEXT NOT NULL, payload BLOB NOT NULL, payload_nonce BLOB NOT NULL,
          PRIMARY KEY(workspace_id,owner_member_id,completion_event_id,output_key),
          UNIQUE(workspace_id,owner_member_id,run_id,worker_id,output_key),
          UNIQUE(workspace_id,owner_member_id,value_reference),
          FOREIGN KEY(workspace_id,owner_member_id,completion_event_id)
            REFERENCES mission_run_event(workspace_id,owner_member_id,id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_mission_worker_output_run
          ON mission_worker_output_receipt(workspace_id,owner_member_id,run_id,worker_id);
        "#,
    )?;
    Ok(())
}

fn apply_v25_to_v26(conn: &Connection) -> super::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS mission_checkpoint_state (
          workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
          owner_member_id TEXT NOT NULL, run_id TEXT NOT NULL, checkpoint_event_id TEXT NOT NULL,
          attempt_number INTEGER NOT NULL CHECK(attempt_number >= 1),
          state_reference TEXT NOT NULL, state_hash TEXT NOT NULL, created_at TEXT NOT NULL,
          payload BLOB NOT NULL, payload_nonce BLOB NOT NULL,
          PRIMARY KEY(workspace_id,owner_member_id,checkpoint_event_id),
          UNIQUE(workspace_id,owner_member_id,run_id,state_reference),
          FOREIGN KEY(workspace_id,owner_member_id,checkpoint_event_id)
            REFERENCES mission_run_event(workspace_id,owner_member_id,id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_mission_checkpoint_run
          ON mission_checkpoint_state(workspace_id,owner_member_id,run_id,created_at);
        "#,
    )?;
    Ok(())
}

fn apply_v24_to_v25(conn: &Connection) -> super::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS mission_run_record (
          workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
          owner_member_id TEXT NOT NULL, id TEXT NOT NULL, status TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK(revision >= 1), last_sequence INTEGER NOT NULL CHECK(last_sequence >= 1),
          last_event_id TEXT NOT NULL, current_attempt_number INTEGER,
          terminal INTEGER NOT NULL CHECK(terminal IN (0,1)), created_by_internal_user_id TEXT NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload BLOB NOT NULL, payload_nonce BLOB NOT NULL,
          PRIMARY KEY(workspace_id,owner_member_id,id)
        );
        CREATE INDEX IF NOT EXISTS idx_mission_run_owner
          ON mission_run_record(workspace_id,owner_member_id,status,updated_at);
        CREATE TABLE IF NOT EXISTS mission_run_event (
          workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
          owner_member_id TEXT NOT NULL, run_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence >= 1),
          id TEXT NOT NULL, event_type TEXT NOT NULL, idempotency_key TEXT NOT NULL,
          previous_event_id TEXT, attempt_number INTEGER, occurred_at TEXT NOT NULL,
          payload BLOB NOT NULL, payload_nonce BLOB NOT NULL,
          PRIMARY KEY(workspace_id,owner_member_id,run_id,sequence),
          UNIQUE(workspace_id,owner_member_id,id),
          UNIQUE(workspace_id,owner_member_id,run_id,idempotency_key)
        );
        CREATE INDEX IF NOT EXISTS idx_mission_run_event_run
          ON mission_run_event(workspace_id,owner_member_id,run_id,sequence);
        "#,
    )?;
    Ok(())
}

fn apply_v23_to_v24(conn: &Connection) -> super::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS mission_record (
          workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
          owner_member_id TEXT NOT NULL, id TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('planning','ready','running','waiting','completed','partially-completed','failed','cancelled','archived')),
          execution_depth TEXT NOT NULL CHECK(execution_depth IN ('delegated','multi-worker')),
          revision INTEGER NOT NULL CHECK(revision >= 1),
          current_plan_id TEXT NOT NULL, current_plan_revision_id TEXT NOT NULL,
          created_by_internal_user_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          payload BLOB NOT NULL, payload_nonce BLOB NOT NULL,
          PRIMARY KEY(workspace_id,owner_member_id,id)
        );
        CREATE INDEX IF NOT EXISTS idx_mission_record_owner
          ON mission_record(workspace_id,owner_member_id,status,updated_at);
        CREATE TABLE IF NOT EXISTS mission_plan_record (
          workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
          owner_member_id TEXT NOT NULL, id TEXT NOT NULL, mission_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK(revision >= 1), current_revision_id TEXT NOT NULL,
          current_revision_number INTEGER NOT NULL CHECK(current_revision_number >= 1),
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          payload BLOB NOT NULL, payload_nonce BLOB NOT NULL,
          PRIMARY KEY(workspace_id,owner_member_id,id), UNIQUE(workspace_id,owner_member_id,mission_id)
        );
        CREATE TABLE IF NOT EXISTS mission_plan_revision (
          workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
          owner_member_id TEXT NOT NULL, id TEXT NOT NULL, plan_id TEXT NOT NULL, mission_id TEXT NOT NULL,
          revision_number INTEGER NOT NULL CHECK(revision_number >= 1), reason TEXT NOT NULL,
          created_at TEXT NOT NULL, payload BLOB NOT NULL, payload_nonce BLOB NOT NULL,
          PRIMARY KEY(workspace_id,owner_member_id,id),
          UNIQUE(workspace_id,owner_member_id,plan_id,revision_number)
        );
        CREATE INDEX IF NOT EXISTS idx_mission_plan_revision_plan
          ON mission_plan_revision(workspace_id,owner_member_id,plan_id,revision_number);
        "#,
    )?;
    Ok(())
}

fn apply_v22_to_v23(conn: &Connection) -> super::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS capability_grant (
          workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
          owner_subject TEXT NOT NULL,
          owner_member_id TEXT,
          id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK(revision >= 1),
          capability_key TEXT NOT NULL,
          connection_id TEXT NOT NULL,
          connection_revision_at_grant INTEGER NOT NULL CHECK(connection_revision_at_grant >= 1),
          consequence_class TEXT NOT NULL CHECK(consequence_class IN ('read','draft','write','publish','destructive','financial','identity-sensitive')),
          scope_kind TEXT NOT NULL CHECK(scope_kind IN ('workspace','project')),
          scope_key TEXT NOT NULL,
          project_id TEXT,
          state TEXT NOT NULL CHECK(state IN ('active','suspended','expired','revoked')),
          max_uses INTEGER CHECK(max_uses IS NULL OR max_uses > 0),
          uses_consumed INTEGER NOT NULL DEFAULT 0 CHECK(uses_consumed >= 0),
          expires_at TEXT,
          granted_by_internal_user_id TEXT NOT NULL,
          granted_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          revoked_at TEXT,
          payload BLOB NOT NULL,
          payload_nonce BLOB NOT NULL,
          PRIMARY KEY(workspace_id,owner_subject,id),
          FOREIGN KEY(workspace_id,connection_id)
            REFERENCES connection_record(workspace_id,id) ON DELETE CASCADE,
          CHECK((scope_kind='workspace' AND project_id IS NULL AND scope_key='workspace') OR
                (scope_kind='project' AND project_id IS NOT NULL AND scope_key='project:' || project_id)),
          CHECK(max_uses IS NULL OR uses_consumed <= max_uses)
        );
        CREATE INDEX IF NOT EXISTS idx_capability_grant_lookup
          ON capability_grant(workspace_id,owner_subject,capability_key,connection_id,consequence_class,scope_key,state);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_capability_grant_active_exact
          ON capability_grant(workspace_id,owner_subject,capability_key,connection_id,consequence_class,scope_key)
          WHERE state='active';
        "#,
    )?;
    Ok(())
}

fn apply_v21_to_v22(conn: &Connection) -> super::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS mcp_local_server_config (
          workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
          owner_subject TEXT NOT NULL,
          id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK(revision >= 1),
          disabled INTEGER NOT NULL CHECK(disabled IN (0,1)),
          created_by_internal_user_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          payload BLOB NOT NULL,
          payload_nonce BLOB NOT NULL,
          PRIMARY KEY(workspace_id,owner_subject,id)
        );
        CREATE INDEX IF NOT EXISTS idx_mcp_local_server_owner
          ON mcp_local_server_config(workspace_id,owner_subject,disabled,updated_at,id);
        "#,
    )?;
    Ok(())
}

fn apply_v20_to_v21(conn: &Connection) -> super::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS capability_implementation_evidence (
          workspace_id TEXT NOT NULL,
          capability_key TEXT NOT NULL,
          connection_id TEXT NOT NULL,
          availability TEXT NOT NULL CHECK(availability IN ('available','degraded')),
          consequence_class TEXT NOT NULL CHECK(consequence_class='read'),
          evidence_kind TEXT NOT NULL CHECK(evidence_kind='adapter-validated'),
          adapter_reference TEXT NOT NULL,
          connection_revision INTEGER NOT NULL CHECK(connection_revision >= 1),
          revision INTEGER NOT NULL CHECK(revision >= 1),
          observed_by_internal_user_id TEXT NOT NULL,
          observed_at TEXT NOT NULL,
          PRIMARY KEY(workspace_id,capability_key,connection_id),
          FOREIGN KEY(workspace_id,connection_id)
            REFERENCES connection_record(workspace_id,id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_capability_evidence_connection
          ON capability_implementation_evidence(workspace_id,connection_id,connection_revision);
        CREATE INDEX IF NOT EXISTS idx_capability_evidence_capability
          ON capability_implementation_evidence(workspace_id,capability_key,availability);
        "#,
    )?;
    Ok(())
}

fn apply_v19_to_v20(conn: &Connection) -> super::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS connection_selection (
          workspace_id TEXT NOT NULL,
          connector_definition_key TEXT NOT NULL,
          connection_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK(revision >= 1),
          selected_by_internal_user_id TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(workspace_id,connector_definition_key),
          FOREIGN KEY(workspace_id,connection_id)
            REFERENCES connection_record(workspace_id,id) ON DELETE CASCADE
        );
        "#,
    )?;
    Ok(())
}

fn apply_v18_to_v19(conn: &Connection) -> super::Result<()> {
    conn.execute_batch(r#"
      CREATE TABLE IF NOT EXISTS connection_record (
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        id TEXT NOT NULL, record_type TEXT NOT NULL CHECK(record_type='connection'),
        authority TEXT NOT NULL CHECK(authority IN ('local','convex')),
        visibility TEXT NOT NULL CHECK(visibility IN ('member-private','workspace-shared')),
        owner_member_id TEXT, schema_version INTEGER NOT NULL CHECK(schema_version >= 1),
        revision INTEGER NOT NULL CHECK(revision >= 1), created_by_internal_user_id TEXT NOT NULL,
        created_by_device_id TEXT,
        kind TEXT NOT NULL CHECK(kind IN ('native-connector','provider-runtime','local-service','mcp','router','custom-route')),
        ownership TEXT NOT NULL CHECK(ownership IN ('user-owned','workspace-shared')),
        lifecycle TEXT NOT NULL CHECK(lifecycle IN ('pending-authorization','authorizing','authorized','refresh-required','revoked','disconnected','removed')),
        authorization_state TEXT NOT NULL CHECK(authorization_state IN ('not-required','pending','authorized','expired','denied','revoked','unavailable')),
        health_state TEXT NOT NULL CHECK(health_state IN ('unknown','healthy','degraded','unhealthy','offline')),
        trust TEXT NOT NULL CHECK(trust IN ('first-party','fable-reviewed','verified-publisher','user-managed','untrusted')),
        credential_custody TEXT NOT NULL CHECK(credential_custody IN ('os-secure-store','managed-secret-store','provider-owned-session','external-runtime','none')),
        credential_state TEXT NOT NULL CHECK(credential_state IN ('not-required','available','refresh-required','unavailable','revoked','unknown')),
        credential_ref TEXT NOT NULL DEFAULT '', connector_definition_key TEXT,
        enabled_by_default INTEGER NOT NULL CHECK(enabled_by_default IN (0,1)),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
        payload BLOB NOT NULL, payload_nonce BLOB NOT NULL,
        PRIMARY KEY(workspace_id,id),
        CHECK((visibility='member-private' AND owner_member_id IS NOT NULL) OR
              (visibility='workspace-shared' AND owner_member_id IS NULL))
      );
      CREATE INDEX IF NOT EXISTS idx_connection_record_workspace
        ON connection_record(workspace_id,lifecycle,updated_at,id);
      CREATE INDEX IF NOT EXISTS idx_connection_record_connector
        ON connection_record(workspace_id,connector_definition_key,lifecycle);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_connection_record_credential
        ON connection_record(credential_ref) WHERE credential_ref <> '';
      CREATE TABLE IF NOT EXISTS connection_legacy_unattributed (
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        connector_id TEXT NOT NULL, proposed_connection_id TEXT, quarantined_at TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT 'legacy connector account had no authenticated creator',
        PRIMARY KEY(workspace_id,connector_id)
      );
    "#)?;

    if !table_exists(conn, "connector_account")? {
        return Ok(());
    }
    let mut stmt = conn.prepare(
        "SELECT workspace_id,connector_id,account_id FROM connector_account ORDER BY workspace_id,connector_id;",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    for (workspace_id, connector_id, account_id) in rows {
        let proposed_connection_id =
            account_id
                .as_deref()
                .filter(|value| !value.is_empty())
                .map(|account_id| {
                    crate::connector_auth::derive_native_connection_id(
                        &workspace_id,
                        &connector_id,
                        account_id,
                    )
                });
        conn.execute(
            "INSERT INTO connection_legacy_unattributed
               (workspace_id,connector_id,proposed_connection_id,quarantined_at)
             VALUES (?1,?2,?3,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
             ON CONFLICT(workspace_id,connector_id) DO UPDATE SET
               proposed_connection_id=excluded.proposed_connection_id;",
            rusqlite::params![workspace_id, connector_id, proposed_connection_id],
        )?;
    }
    Ok(())
}

fn apply_v17_to_v18(conn: &Connection) -> super::Result<()> {
    conn.execute_batch(r#"
      CREATE TABLE IF NOT EXISTS artifact_handoff (
        workspace_id TEXT NOT NULL, owner_subject TEXT NOT NULL, artifact_id TEXT NOT NULL,
        id TEXT NOT NULL, version_id TEXT NOT NULL,
        source_thread_id TEXT NOT NULL REFERENCES thread(id) ON DELETE RESTRICT,
        source_project_id TEXT REFERENCES project(id) ON DELETE RESTRICT,
        target_project_id TEXT NOT NULL REFERENCES project(id) ON DELETE RESTRICT,
        status TEXT NOT NULL CHECK(status IN ('proposed','accepted')),
        revision INTEGER NOT NULL CHECK(revision >= 1),
        proposed_by_internal_user_id TEXT NOT NULL, resolved_by_internal_user_id TEXT,
        proposed_at TEXT NOT NULL, resolved_at TEXT, payload BLOB NOT NULL, payload_nonce BLOB NOT NULL,
        PRIMARY KEY(workspace_id,owner_subject,id),
        FOREIGN KEY(workspace_id,owner_subject,artifact_id)
          REFERENCES artifact(workspace_id,owner_subject,id) ON DELETE CASCADE,
        FOREIGN KEY(workspace_id,owner_subject,artifact_id,version_id)
          REFERENCES artifact_version(workspace_id,owner_subject,artifact_id,id) ON DELETE RESTRICT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_artifact_handoff_exact
        ON artifact_handoff(workspace_id,owner_subject,artifact_id,version_id,target_project_id);
      CREATE INDEX IF NOT EXISTS idx_artifact_handoff_target
        ON artifact_handoff(workspace_id,owner_subject,target_project_id,status,resolved_at,id);
    "#)?;
    Ok(())
}

fn apply_v16_to_v17(conn: &Connection) -> super::Result<()> {
    conn.execute_batch(r#"
      CREATE UNIQUE INDEX IF NOT EXISTS idx_artifact_version_identity
        ON artifact_version(workspace_id,owner_subject,artifact_id,id);
      CREATE TABLE IF NOT EXISTS artifact_review (
        workspace_id TEXT NOT NULL, owner_subject TEXT NOT NULL, artifact_id TEXT NOT NULL,
        id TEXT NOT NULL, version_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('requested','changes-requested','approved')),
        requested_by_internal_user_id TEXT NOT NULL, reviewer_member_id TEXT,
        requested_at TEXT NOT NULL, resolved_at TEXT, payload BLOB NOT NULL, payload_nonce BLOB NOT NULL,
        PRIMARY KEY(workspace_id,owner_subject,id),
        FOREIGN KEY(workspace_id,owner_subject,artifact_id)
          REFERENCES artifact(workspace_id,owner_subject,id) ON DELETE CASCADE,
        FOREIGN KEY(workspace_id,owner_subject,artifact_id,version_id)
          REFERENCES artifact_version(workspace_id,owner_subject,artifact_id,id) ON DELETE RESTRICT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_artifact_review_open
        ON artifact_review(workspace_id,owner_subject,artifact_id) WHERE status='requested';
      CREATE INDEX IF NOT EXISTS idx_artifact_review_history
        ON artifact_review(workspace_id,owner_subject,artifact_id,requested_at,id);
    "#)?;
    Ok(())
}

fn apply_v15_to_v16(conn: &Connection) -> super::Result<()> {
    if !table_exists(conn, "artifact")? || table_has_column(conn, "artifact", "owner_subject")? {
        return Ok(());
    }
    conn.execute_batch(r#"
      CREATE TABLE artifact_legacy_unowned (
        id TEXT PRIMARY KEY, run_id TEXT, kind TEXT NOT NULL, content_fingerprint TEXT NOT NULL,
        size_bytes INTEGER NOT NULL, created_at TEXT NOT NULL, payload BLOB NOT NULL,
        payload_nonce BLOB NOT NULL, quarantined_at TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT 'legacy artifact had no authenticated owner'
      );
      INSERT INTO artifact_legacy_unowned
      SELECT id,run_id,kind,content_fingerprint,size_bytes,created_at,payload,payload_nonce,
             strftime('%Y-%m-%dT%H:%M:%fZ','now'),'legacy artifact had no authenticated owner'
      FROM artifact;
      DROP TABLE artifact;
      CREATE TABLE artifact (
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        owner_subject TEXT NOT NULL, authority TEXT NOT NULL CHECK(authority='local'),
        visibility TEXT NOT NULL CHECK(visibility='member-private'), owner_member_id TEXT,
        owner_internal_user_id TEXT, id TEXT NOT NULL, run_id TEXT REFERENCES run(id) ON DELETE CASCADE,
        thread_id TEXT REFERENCES thread(id) ON DELETE CASCADE, source_message_id TEXT,
        kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', revision INTEGER NOT NULL DEFAULT 1,
        current_version_id TEXT NOT NULL, title_fingerprint TEXT NOT NULL,
        content_fingerprint TEXT NOT NULL, size_bytes INTEGER NOT NULL, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, payload BLOB NOT NULL, payload_nonce BLOB NOT NULL,
        PRIMARY KEY(workspace_id,owner_subject,id),
        CHECK((owner_member_id IS NOT NULL)!=(owner_internal_user_id IS NOT NULL))
      );
      CREATE TABLE artifact_version (
        workspace_id TEXT NOT NULL, owner_subject TEXT NOT NULL, artifact_id TEXT NOT NULL,
        id TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'available',
        content_fingerprint TEXT NOT NULL, size_bytes INTEGER NOT NULL, created_at TEXT NOT NULL,
        payload BLOB NOT NULL, payload_nonce BLOB NOT NULL,
        PRIMARY KEY(workspace_id,owner_subject,id),
        UNIQUE(workspace_id,owner_subject,artifact_id,version),
        FOREIGN KEY(workspace_id,owner_subject,artifact_id)
          REFERENCES artifact(workspace_id,owner_subject,id) ON DELETE CASCADE
      );
      CREATE INDEX idx_artifact_run ON artifact(workspace_id,owner_subject,run_id);
      CREATE INDEX idx_artifact_thread ON artifact(workspace_id,owner_subject,thread_id,created_at);
      CREATE INDEX idx_artifact_version_history ON artifact_version(workspace_id,owner_subject,artifact_id,version);
    "#)?;
    Ok(())
}

fn apply_v14_to_v15(conn: &Connection) -> super::Result<()> {
    if !table_exists(conn, "knowledge_source")?
        || table_has_column(conn, "knowledge_source", "owner_subject")?
    {
        return Ok(());
    }
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS private_context_legacy_unowned (
          record_type TEXT NOT NULL, workspace_id TEXT NOT NULL, record_id TEXT NOT NULL,
          project_id TEXT, payload BLOB, payload_nonce BLOB, quarantined_at TEXT NOT NULL,
          reason TEXT NOT NULL, PRIMARY KEY(record_type, workspace_id, record_id)
        );

        INSERT OR REPLACE INTO private_context_legacy_unowned
          (record_type, workspace_id, record_id, project_id, payload, payload_nonce, quarantined_at, reason)
        SELECT 'knowledge', k.workspace_id, k.id, k.project_id, k.payload, k.payload_nonce,
               strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'legacy Knowledge record had no provable private project owner'
        FROM knowledge_source k;
        INSERT OR REPLACE INTO private_context_legacy_unowned
          (record_type, workspace_id, record_id, project_id, payload, payload_nonce, quarantined_at, reason)
        SELECT 'memory', m.workspace_id, m.id, m.project_id, m.payload, m.payload_nonce,
               strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'legacy Memory record had no provable private project owner'
        FROM memory_record m;
        INSERT OR REPLACE INTO private_context_legacy_unowned
          (record_type, workspace_id, record_id, project_id, payload, payload_nonce, quarantined_at, reason)
        SELECT 'document', workspace_id, key, NULL, payload, payload_nonce,
               strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'legacy private document had no authenticated owner envelope'
        FROM preferences
        WHERE key LIKE 'document:%imported-knowledge.json' OR key LIKE 'document:%memory-state.json';
        DELETE FROM preferences
        WHERE key LIKE 'document:%imported-knowledge.json' OR key LIKE 'document:%memory-state.json';

        ALTER TABLE pinned_context RENAME TO pinned_context_v14;
        ALTER TABLE knowledge_chunk RENAME TO knowledge_chunk_v14;
        ALTER TABLE knowledge_tombstone RENAME TO knowledge_tombstone_v14;
        ALTER TABLE memory_tombstone RENAME TO memory_tombstone_v14;
        ALTER TABLE knowledge_source RENAME TO knowledge_source_v14;
        ALTER TABLE memory_record RENAME TO memory_record_v14;

        CREATE TABLE knowledge_source (
          workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
          owner_subject TEXT NOT NULL, authority TEXT NOT NULL CHECK(authority='local'),
          visibility TEXT NOT NULL CHECK(visibility='member-private'), owner_member_id TEXT,
          id TEXT NOT NULL, project_id TEXT REFERENCES project(id) ON DELETE CASCADE,
          connector_id TEXT NOT NULL, connector_account_id TEXT NOT NULL DEFAULT '',
          external_id TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, trust TEXT NOT NULL,
          pinned INTEGER NOT NULL DEFAULT 0, disabled INTEGER NOT NULL DEFAULT 0,
          content_fingerprint TEXT NOT NULL, size_bytes INTEGER NOT NULL, imported_at TEXT NOT NULL,
          origin TEXT NOT NULL, payload BLOB NOT NULL, payload_nonce BLOB NOT NULL,
          PRIMARY KEY(workspace_id, owner_subject, id)
        );
        CREATE TABLE memory_record (
          workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
          owner_subject TEXT NOT NULL, authority TEXT NOT NULL CHECK(authority='local'),
          visibility TEXT NOT NULL CHECK(visibility='member-private'), owner_member_id TEXT,
          id TEXT NOT NULL, project_id TEXT REFERENCES project(id) ON DELETE CASCADE,
          kind TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, approved INTEGER NOT NULL DEFAULT 0,
          disabled INTEGER NOT NULL DEFAULT 0, forgotten_at TEXT, created_at TEXT NOT NULL,
          payload BLOB NOT NULL, payload_nonce BLOB NOT NULL,
          PRIMARY KEY(workspace_id, owner_subject, id)
        );

        CREATE TABLE knowledge_chunk (
          workspace_id TEXT NOT NULL, owner_subject TEXT NOT NULL, source_id TEXT NOT NULL, id TEXT NOT NULL,
          ordinal INTEGER NOT NULL, content_fingerprint TEXT NOT NULL, payload BLOB NOT NULL, payload_nonce BLOB NOT NULL,
          PRIMARY KEY(workspace_id, owner_subject, id),
          FOREIGN KEY(workspace_id, owner_subject, source_id) REFERENCES knowledge_source(workspace_id, owner_subject, id) ON DELETE CASCADE
        );
        CREATE TABLE pinned_context (
          workspace_id TEXT NOT NULL, owner_subject TEXT NOT NULL, id TEXT NOT NULL, source_id TEXT, memory_id TEXT,
          scope_level TEXT NOT NULL, project_id TEXT, thread_id TEXT, pinned_at TEXT NOT NULL,
          PRIMARY KEY(workspace_id, owner_subject, id), CHECK((source_id IS NOT NULL)!=(memory_id IS NOT NULL)),
          FOREIGN KEY(workspace_id, owner_subject, source_id) REFERENCES knowledge_source(workspace_id, owner_subject, id) ON DELETE CASCADE,
          FOREIGN KEY(workspace_id, owner_subject, memory_id) REFERENCES memory_record(workspace_id, owner_subject, id) ON DELETE CASCADE
        );
        CREATE TABLE knowledge_tombstone (
          workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE, owner_subject TEXT NOT NULL,
          id TEXT NOT NULL, deleted_at TEXT NOT NULL, PRIMARY KEY(workspace_id,owner_subject,id)
        );
        CREATE TABLE memory_tombstone (
          workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE, owner_subject TEXT NOT NULL,
          id TEXT NOT NULL, forgotten_at TEXT NOT NULL, PRIMARY KEY(workspace_id,owner_subject,id)
        );

        DROP TABLE pinned_context_v14; DROP TABLE knowledge_chunk_v14;
        DROP TABLE knowledge_tombstone_v14; DROP TABLE memory_tombstone_v14;
        DROP TABLE knowledge_source_v14; DROP TABLE memory_record_v14;
        CREATE INDEX idx_knowledge_connector ON knowledge_source(connector_id);
        CREATE INDEX idx_knowledge_pinned ON knowledge_source(pinned);
        CREATE INDEX idx_knowledge_workspace ON knowledge_source(workspace_id,owner_subject,project_id);
        CREATE INDEX idx_memory_kind ON memory_record(kind);
        CREATE INDEX idx_memory_pinned ON memory_record(pinned);
        CREATE INDEX idx_memory_workspace ON memory_record(workspace_id,owner_subject,project_id);
        CREATE INDEX idx_knowledge_chunk_source ON knowledge_chunk(workspace_id,owner_subject,source_id,ordinal);
        CREATE INDEX idx_pinned_context_scope ON pinned_context(workspace_id,owner_subject,scope_level,project_id,thread_id);
        "#,
    )?;
    Ok(())
}

fn apply_v13_to_v14(conn: &Connection) -> super::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS goal (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
          project_id TEXT REFERENCES project(id) ON DELETE SET NULL,
          authority TEXT NOT NULL DEFAULT 'local',
          visibility TEXT NOT NULL DEFAULT 'member-private',
          owner_member_id TEXT NOT NULL,
          created_by_internal_user_id TEXT NOT NULL,
          schema_version INTEGER NOT NULL DEFAULT 1,
          revision INTEGER NOT NULL DEFAULT 1,
          lifecycle TEXT NOT NULL DEFAULT 'active',
          title_fingerprint TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          payload BLOB NOT NULL,
          payload_nonce BLOB NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_goal_owner
          ON goal(workspace_id, owner_member_id, project_id, lifecycle, updated_at);
        "#,
    )?;
    Ok(())
}

fn apply_v12_to_v13(conn: &Connection) -> super::Result<()> {
    if !table_exists(conn, "project")? {
        return Ok(());
    }
    for (column, ddl) in [
        ("authority", "TEXT NOT NULL DEFAULT 'local'"),
        ("visibility", "TEXT NOT NULL DEFAULT 'member-private'"),
        ("owner_member_id", "TEXT"),
        ("created_by_internal_user_id", "TEXT"),
        ("schema_version", "INTEGER NOT NULL DEFAULT 1"),
        ("revision", "INTEGER NOT NULL DEFAULT 1"),
        ("lifecycle", "TEXT NOT NULL DEFAULT 'active'"),
        ("deleted_at", "TEXT"),
    ] {
        if !table_has_column(conn, "project", column)? {
            conn.execute_batch(&format!("ALTER TABLE project ADD COLUMN {column} {ddl};"))?;
        }
    }
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS project_tombstone (
          workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
          project_id TEXT NOT NULL,
          deleted_at TEXT NOT NULL,
          deleted_by_internal_user_id TEXT NOT NULL,
          last_revision INTEGER NOT NULL,
          PRIMARY KEY (workspace_id, project_id)
        );
        CREATE INDEX IF NOT EXISTS idx_project_owner
          ON project(workspace_id, owner_member_id, lifecycle, updated_at);

        -- Attribute a legacy local project only when the workspace has exactly
        -- one active member. Ambiguous rows remain preserved but inaccessible;
        -- migration must never guess a private owner.
        UPDATE project
           SET owner_member_id = (
                 SELECT MIN(m.member_id)
                   FROM fable_workspace_mirror AS w
                   JOIN fable_membership_mirror AS m
                     ON m.fable_workspace_id=w.fable_workspace_id
                  WHERE w.local_workspace_id=project.workspace_id
                    AND w.status='active' AND m.status='active'
                  GROUP BY w.local_workspace_id
                 HAVING COUNT(*)=1
               ),
               created_by_internal_user_id = (
                 SELECT MIN(m.internal_user_id)
                   FROM fable_workspace_mirror AS w
                   JOIN fable_membership_mirror AS m
                     ON m.fable_workspace_id=w.fable_workspace_id
                  WHERE w.local_workspace_id=project.workspace_id
                    AND w.status='active' AND m.status='active'
                  GROUP BY w.local_workspace_id
                 HAVING COUNT(*)=1
               )
         WHERE owner_member_id IS NULL;
        "#,
    )?;
    Ok(())
}

fn apply_v11_to_v12(conn: &Connection) -> super::Result<()> {
    if !table_exists(conn, "backend_connection")?
        || table_has_column(conn, "backend_connection", "internal_user_id")?
    {
        return Ok(());
    }
    conn.execute_batch(
        r#"
        ALTER TABLE backend_connection RENAME TO backend_connection_v11;
        CREATE TABLE backend_connection (
          internal_user_id TEXT NOT NULL REFERENCES fable_internal_user_mirror(internal_user_id) ON DELETE CASCADE,
          provider_id TEXT NOT NULL,
          connected_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (internal_user_id, provider_id)
        );
        CREATE INDEX idx_backend_connection_user
          ON backend_connection(internal_user_id, updated_at);
        CREATE TABLE IF NOT EXISTS backend_connection_legacy_unowned (
          provider_id TEXT PRIMARY KEY,
          connected_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          quarantined_at TEXT NOT NULL,
          reason TEXT NOT NULL DEFAULT 'legacy record had no authenticated account owner'
        );
        INSERT OR IGNORE INTO backend_connection_legacy_unowned
          (provider_id, connected_at, updated_at, quarantined_at)
        SELECT provider_id, connected_at, updated_at, datetime('now')
        FROM backend_connection_v11;
        DROP TABLE backend_connection_v11;
        "#,
    )?;
    Ok(())
}

fn apply_v10_to_v11(conn: &Connection) -> super::Result<()> {
    if !table_exists(conn, "thread")? {
        return Ok(());
    }
    // Fresh databases receive the complete v11 shape through SCHEMA_V1 before
    // the migration runner records the version. Do not reinterpret those rows
    // as legacy v10 merely because their schema_meta row is still zero.
    if table_has_column(conn, "message", "kind")? {
        return Ok(());
    }
    // `run` has dependents (tool calls, approvals, artifacts), so retain its
    // stable primary key and add its explicit owner in-place before rebuilding
    // the conversation parents it references.
    if !table_has_column(conn, "run", "workspace_id")? {
        conn.execute_batch(
            "ALTER TABLE run ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';",
        )?;
        conn.execute_batch("UPDATE run SET workspace_id=COALESCE((SELECT p.workspace_id FROM thread t JOIN project p ON p.id=t.project_id WHERE t.id=run.thread_id),'default');")?;
    }
    require_foreign_keys_disabled(conn, "v10 -> v11")?;
    // Keep existing dependent foreign keys pointed at the canonical names
    // while their legacy parents are moved aside. SQLite's modern rename
    // behavior otherwise rewrites `run.thread_id` to the temporary
    // `thread_v10` table, which is dropped later in this migration.
    conn.pragma_update(None, "legacy_alter_table", "ON")?;
    let rebuild = conn.execute_batch(r#"
      ALTER TABLE draft RENAME TO draft_v10;
      CREATE TABLE draft (workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,thread_id TEXT NOT NULL DEFAULT '',id TEXT NOT NULL,updated_at TEXT NOT NULL,payload BLOB NOT NULL,payload_nonce BLOB NOT NULL,PRIMARY KEY(workspace_id,thread_id,id));
      INSERT INTO draft (workspace_id,thread_id,id,updated_at,payload,payload_nonce) SELECT 'default','',id,updated_at,payload,payload_nonce FROM draft_v10;
      DROP TABLE draft_v10;
      ALTER TABLE thread RENAME TO thread_v10;
      CREATE TABLE thread (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        project_id TEXT REFERENCES project(id) ON DELETE SET NULL, title TEXT NOT NULL DEFAULT '', lifecycle TEXT NOT NULL DEFAULT 'active',
        last_sequence INTEGER NOT NULL DEFAULT 0, last_message_id TEXT, authority TEXT NOT NULL DEFAULT 'local', visibility TEXT NOT NULL DEFAULT 'member-private',
        owner_member_id TEXT, revision INTEGER NOT NULL DEFAULT 1, deleted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        payload BLOB NOT NULL, payload_nonce BLOB NOT NULL
      );
      INSERT INTO thread (id,workspace_id,project_id,created_at,updated_at,payload,payload_nonce)
      SELECT t.id,p.workspace_id,t.project_id,t.created_at,t.updated_at,t.payload,t.payload_nonce FROM thread_v10 t JOIN project p ON p.id=t.project_id;
      DROP TABLE thread_v10;
      CREATE INDEX idx_thread_workspace ON thread(workspace_id,project_id,updated_at);
      ALTER TABLE message RENAME TO message_v10;
      CREATE TABLE message (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE, thread_id TEXT NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, detail_kind TEXT NOT NULL DEFAULT '', seq INTEGER NOT NULL, previous_message_id TEXT,
        idempotency_key TEXT NOT NULL, correlation_key TEXT, current_revision_id TEXT NOT NULL, current_revision_number INTEGER NOT NULL DEFAULT 1,
        current_revision_state TEXT NOT NULL DEFAULT 'terminal', run_id TEXT, run_event_id TEXT, authority TEXT NOT NULL DEFAULT 'local', visibility TEXT NOT NULL DEFAULT 'member-private',
        owner_member_id TEXT, revision INTEGER NOT NULL DEFAULT 1, deleted_at TEXT, created_at TEXT NOT NULL, payload BLOB NOT NULL, payload_nonce BLOB NOT NULL, UNIQUE(thread_id,seq), UNIQUE(thread_id,idempotency_key)
      );
      INSERT INTO message (id,workspace_id,thread_id,kind,seq,idempotency_key,current_revision_id,created_at,payload,payload_nonce)
      SELECT m.id,t.workspace_id,m.thread_id,CASE m.role WHEN 'assistant' THEN 'assistant' ELSE 'user' END,m.seq,'legacy:'||m.id,'legacy:'||m.id,m.created_at,m.payload,m.payload_nonce FROM message_v10 m JOIN thread t ON t.id=m.thread_id;
      DROP TABLE message_v10;
      CREATE INDEX idx_message_thread ON message(workspace_id,thread_id,seq);
      CREATE TABLE IF NOT EXISTS message_revision (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE, thread_id TEXT NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE, revision_number INTEGER NOT NULL, base_revision_number INTEGER NOT NULL, previous_revision_id TEXT,
        state TEXT NOT NULL, reason TEXT NOT NULL, idempotency_key TEXT NOT NULL, correlation_key TEXT, checkpointed_at TEXT NOT NULL, run_id TEXT, run_event_id TEXT,
        authority TEXT NOT NULL DEFAULT 'local', visibility TEXT NOT NULL DEFAULT 'member-private', owner_member_id TEXT, created_at TEXT NOT NULL, payload BLOB NOT NULL, payload_nonce BLOB NOT NULL,
        UNIQUE(message_id,revision_number), UNIQUE(message_id,idempotency_key)
      );
      INSERT INTO message_revision (id,workspace_id,thread_id,message_id,revision_number,base_revision_number,state,reason,idempotency_key,checkpointed_at,created_at,payload,payload_nonce)
      SELECT current_revision_id,workspace_id,thread_id,id,1,0,'terminal','initial','legacy:'||id,created_at,created_at,payload,payload_nonce FROM message;
      CREATE TABLE IF NOT EXISTS conversation_tombstone (workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,target TEXT NOT NULL,thread_id TEXT NOT NULL,message_id TEXT,idempotency_key TEXT NOT NULL,deleted_at TEXT NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(workspace_id,target,thread_id,message_id));
    "#);
    let reset = conn.pragma_update(None, "legacy_alter_table", "OFF");
    rebuild?;
    reset?;
    Ok(())
}

fn apply_v4_to_v5(conn: &Connection) -> super::Result<()> {
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
fn apply_v5_to_v6(conn: &Connection) -> super::Result<()> {
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

fn apply_v7_to_v8(conn: &Connection) -> super::Result<()> {
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

fn apply_v8_to_v9(conn: &Connection) -> super::Result<()> {
    // Fresh databases already receive this table through SCHEMA_V1. The
    // explicit existence probe also makes a re-run after an interrupted
    // migration harmless.
    if !table_exists(conn, "active_workspace_selection")? {
        conn.execute_batch(crate::store::schema::SCHEMA_V8_TO_V9)?;
    }
    Ok(())
}

fn apply_v9_to_v10(conn: &Connection) -> super::Result<()> {
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
fn ensure_v7_sync_rows_have_links(conn: &Connection) -> super::Result<()> {
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
            return Err(super::StoreError::Invalid(format!(
                "Cannot migrate v7 cloud sync state: {table} contains an orphaned workspace row."
            )));
        }
    }
    Ok(())
}

fn apply_v6_to_v7(conn: &Connection) -> super::Result<()> {
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

fn table_has_composite_primary_key(
    conn: &Connection,
    table: &str,
    first: &str,
    second: &str,
) -> super::Result<bool> {
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

fn apply_v3_to_v4(conn: &Connection) -> super::Result<()> {
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

fn add_ownership_columns(
    conn: &Connection,
    table: &str,
    include_project: bool,
) -> super::Result<()> {
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

fn table_exists(conn: &Connection, table: &str) -> super::Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1);",
        [table],
        |row| row.get(0),
    )?)
}

fn table_has_column(conn: &Connection, table: &str, name: &str) -> super::Result<bool> {
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
    use crate::store::schema::{
        CURRENT_SCHEMA_VERSION, LEGACY_ORCHESTRATION_SCHEMA_V37, SCHEMA_V1, SCHEMA_V1_TO_V2,
    };
    use rusqlite::Connection;

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA_V1).unwrap();
        conn
    }

    fn v7_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE workspace (
               id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
             );
             INSERT INTO workspace VALUES ('default', 'Default', 'now', 'now');",
        )
        .unwrap();
        conn.execute_batch(crate::store::schema::SCHEMA_V6_TO_V7)
            .unwrap();
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
        let err = apply(&conn, CURRENT_SCHEMA_VERSION, CURRENT_SCHEMA_VERSION + 1).unwrap_err();
        assert!(matches!(err, super::super::StoreError::Invalid(_)));
    }

    #[test]
    fn v39_to_v40_adds_empty_local_schedules_without_retired_orchestration() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE workspace(id TEXT PRIMARY KEY);
             CREATE TABLE run(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL);",
        )
        .unwrap();
        apply(&conn, 39, 40).unwrap();
        assert!(table_exists(&conn, "local_schedule").unwrap());
        assert!(table_exists(&conn, "local_schedule_occurrence").unwrap());
        assert!(!table_exists(&conn, "routine_record").unwrap());
        assert!(!table_exists(&conn, "scheduled_job").unwrap());
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM local_schedule", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn v40_to_v41_adds_empty_local_projects_without_importing_legacy_rows() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE workspace(id TEXT PRIMARY KEY);
             INSERT INTO workspace VALUES('default');
             CREATE TABLE thread(id TEXT PRIMARY KEY);
             CREATE TABLE run(id TEXT PRIMARY KEY);
             CREATE TABLE project(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL);
             INSERT INTO project VALUES('legacy-project','default');",
        )
        .unwrap();
        apply(&conn, 40, 41).unwrap();
        assert!(table_exists(&conn, "local_project").unwrap());
        assert!(table_exists(&conn, "local_project_run_author").unwrap());
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM local_project", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM project", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn v37_to_v38_removes_retired_orchestration_storage() {
        let conn = conn();
        conn.execute_batch(LEGACY_ORCHESTRATION_SCHEMA_V37).unwrap();
        for table in [
            "scheduled_job",
            "scheduler_queue_entry",
            "workflow_definition",
            "workflow_run",
            "schedule",
            "artifact_handoff",
            "artifact_review",
            "artifact_version",
            "artifact_legacy_unowned",
            "artifact",
            "goal",
            "run_state",
        ] {
            conn.execute_batch(&format!(
                "CREATE TABLE IF NOT EXISTS \"{table}\" (id TEXT);"
            ))
            .unwrap();
        }

        apply(&conn, 37, 38).unwrap();

        for table in [
            "mission_record",
            "mission_run_record",
            "routine_record",
            "routine_trigger",
            "scheduled_job",
            "scheduler_queue_entry",
            "workflow_definition",
            "workflow_run",
            "artifact",
            "artifact_version",
            "goal",
            "run_state",
        ] {
            assert!(
                !table_exists(&conn, table).unwrap(),
                "retired table {table} must be removed"
            );
        }
        for table in [
            "workspace",
            "thread",
            "message",
            "run",
            "tool_call",
            "approval",
        ] {
            assert!(
                table_exists(&conn, table).unwrap(),
                "current table {table} must be preserved"
            );
        }
    }

    #[test]
    fn v38_to_v39_decouples_provider_connections_from_hosted_account_mirrors() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "OFF").unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE fable_internal_user_mirror (
              internal_user_id TEXT PRIMARY KEY,
              status TEXT NOT NULL,
              revision INTEGER NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE backend_connection (
              internal_user_id TEXT NOT NULL REFERENCES fable_internal_user_mirror(internal_user_id) ON DELETE CASCADE,
              provider_id TEXT NOT NULL,
              connected_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              PRIMARY KEY(internal_user_id,provider_id)
            );
            CREATE INDEX idx_backend_connection_user
              ON backend_connection(internal_user_id,updated_at);
            CREATE TABLE provider_route_observation (
              internal_user_id TEXT NOT NULL,
              provider_id TEXT NOT NULL,
              provider_route_id TEXT NOT NULL,
              observation_id TEXT NOT NULL,
              observed_at TEXT NOT NULL,
              payload BLOB NOT NULL,
              payload_nonce BLOB NOT NULL,
              PRIMARY KEY(internal_user_id,observation_id),
              FOREIGN KEY(internal_user_id,provider_id)
                REFERENCES backend_connection(internal_user_id,provider_id) ON DELETE CASCADE
            );
            INSERT INTO fable_internal_user_mirror VALUES ('old-user','active',1,'t');
            INSERT INTO backend_connection VALUES ('old-user','openai','t','t');
            INSERT INTO provider_route_observation VALUES (
              'old-user','openai','route-1','observation-1','t',x'01',x'02'
            );
            "#,
        )
        .unwrap();

        apply(&conn, 38, 39).unwrap();

        assert_eq!(
            foreign_key_target(&conn, "backend_connection", "internal_user_id").unwrap(),
            None
        );
        assert_eq!(
            foreign_key_target(&conn, "provider_route_observation", "provider_id").unwrap(),
            Some("backend_connection".into())
        );
        let preserved: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM provider_route_observation",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(preserved, 1);

        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        conn.execute(
            "INSERT INTO backend_connection VALUES ('local-install','custom','t','t')",
            [],
        )
        .unwrap();
        let violation: Option<String> = conn
            .query_row("PRAGMA foreign_key_check", [], |row| row.get(0))
            .optional()
            .unwrap();
        assert!(violation.is_none());
    }

    #[test]
    fn v34_to_v35_adds_an_empty_mission_approval_consumption_ledger() {
        let conn = conn();
        apply(&conn, 34, 35).unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM mission_approval_consumption",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn v32_to_v33_adds_empty_routine_stores_without_inferred_authority() {
        let conn = conn();
        apply(&conn, 32, 33).unwrap();
        for table in [
            "routine_record",
            "routine_version",
            "routine_trigger",
            "routine_occurrence",
            "routine_driver_occurrence",
            "routine_migration_batch",
            "routine_migration_quarantine",
            "routine_scheduler_authority",
        ] {
            let sql = format!("SELECT COUNT(*) FROM {table}");
            let count: i64 = conn.query_row(&sql, [], |row| row.get(0)).unwrap();
            assert_eq!(count, 0, "{table} must start empty");
        }
    }

    #[test]
    fn v33_to_v34_adds_an_empty_routine_trigger_cursor() {
        let conn = conn();
        apply(&conn, 33, 34).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM routine_trigger_cursor", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn v31_to_v32_adds_empty_direct_mission_artifact_provenance_without_inferred_rows() {
        let conn = conn();
        apply(&conn, 31, 32).unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM mission_direct_artifact_source",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
        let binding_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM mission_structured_intake_binding",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(binding_count, 0);
    }

    #[test]
    fn v30_to_v31_adds_empty_mission_artifact_provenance_without_inferred_rows() {
        let conn = conn();
        apply(&conn, 30, 31).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM mission_artifact_source", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn v23_to_v24_adds_empty_mission_plan_storage_without_inferred_rows() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE workspace(id TEXT PRIMARY KEY);")
            .unwrap();
        apply(&conn, 23, 24).unwrap();
        for table in [
            "mission_record",
            "mission_plan_record",
            "mission_plan_revision",
        ] {
            let exists: i64 = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1);",
                    [table],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(exists, 1);
            let count: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table};"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 0);
        }
    }

    #[test]
    fn v24_to_v25_adds_empty_mission_run_journal_without_inferred_rows() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE workspace(id TEXT PRIMARY KEY);")
            .unwrap();
        apply(&conn, 24, 25).unwrap();
        for table in ["mission_run_record", "mission_run_event"] {
            let exists: i64 = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1);",
                    [table],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(exists, 1);
            let count: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table};"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 0);
        }
    }

    #[test]
    fn v25_to_v26_adds_empty_checkpoint_state_without_inferred_rows() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE workspace(id TEXT PRIMARY KEY);")
            .unwrap();
        apply(&conn, 25, 26).unwrap();
        let exists:i64=conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='mission_checkpoint_state');",[],|row|row.get(0)).unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM mission_checkpoint_state;",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(exists, 1);
        assert_eq!(count, 0);
    }

    #[test]
    fn v26_to_v27_adds_empty_worker_output_receipts_without_inference() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE workspace(id TEXT PRIMARY KEY);
             CREATE TABLE mission_run_event(
               workspace_id TEXT NOT NULL,owner_member_id TEXT NOT NULL,run_id TEXT NOT NULL,
               sequence INTEGER NOT NULL,id TEXT NOT NULL,event_type TEXT NOT NULL,
               idempotency_key TEXT NOT NULL,occurred_at TEXT NOT NULL,
               payload BLOB NOT NULL,payload_nonce BLOB NOT NULL,
               UNIQUE(workspace_id,owner_member_id,id)
             );",
        )
        .unwrap();
        apply(&conn, 26, 27).unwrap();
        let exists: i64 = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='mission_worker_output_receipt');",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM mission_worker_output_receipt;",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(exists, 1);
        assert_eq!(count, 0);
    }

    #[test]
    fn v27_to_v28_adds_empty_worker_tool_receipts_without_inference() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE workspace(id TEXT PRIMARY KEY);
             CREATE TABLE mission_run_event(
               workspace_id TEXT NOT NULL,owner_member_id TEXT NOT NULL,run_id TEXT NOT NULL,
               sequence INTEGER NOT NULL,id TEXT NOT NULL,event_type TEXT NOT NULL,
               idempotency_key TEXT NOT NULL,occurred_at TEXT NOT NULL,
               payload BLOB NOT NULL,payload_nonce BLOB NOT NULL,
               UNIQUE(workspace_id,owner_member_id,id)
             );",
        )
        .unwrap();
        apply(&conn, 27, 28).unwrap();
        let exists: i64 = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='mission_worker_tool_receipt');",
            [], |row| row.get(0),
        ).unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM mission_worker_tool_receipt;",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(exists, 1);
        assert_eq!(count, 0);
    }

    #[test]
    fn v28_to_v29_adds_empty_provider_route_observations_without_inference() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE backend_connection(
               internal_user_id TEXT NOT NULL,
               provider_id TEXT NOT NULL,
               connected_at TEXT NOT NULL,
               updated_at TEXT NOT NULL,
               PRIMARY KEY(internal_user_id,provider_id)
             );",
        )
        .unwrap();
        apply(&conn, 28, 29).unwrap();
        let exists: i64 = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='provider_route_observation');",
            [], |row| row.get(0),
        ).unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM provider_route_observation;",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(exists, 1);
        assert_eq!(count, 0);
    }

    #[test]
    fn v29_to_v30_adds_empty_route_quality_observations_without_inference() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE backend_connection(
               internal_user_id TEXT NOT NULL,
               provider_id TEXT NOT NULL,
               connected_at TEXT NOT NULL,
               updated_at TEXT NOT NULL,
               PRIMARY KEY(internal_user_id,provider_id)
             );",
        )
        .unwrap();
        apply(&conn, 29, 30).unwrap();
        let exists: i64 = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='provider_route_quality_observation');",
            [], |row| row.get(0),
        ).unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM provider_route_quality_observation;",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(exists, 1);
        assert_eq!(count, 0);
    }

    #[test]
    fn v18_to_v19_quarantines_legacy_connector_identity_without_claiming_authority() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
          PRAGMA foreign_keys = ON;
          CREATE TABLE workspace(id TEXT PRIMARY KEY);
          INSERT INTO workspace VALUES('workspace-a');
          CREATE TABLE connector_account(
            workspace_id TEXT NOT NULL, connector_id TEXT NOT NULL, account_id TEXT,
            status TEXT NOT NULL, expires_at INTEGER, credential_ref TEXT NOT NULL,
            connected_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            payload BLOB NOT NULL, payload_nonce BLOB NOT NULL,
            PRIMARY KEY(workspace_id,connector_id)
          );
          INSERT INTO connector_account VALUES(
            'workspace-a','gmail','provider-account-secret','connected',NULL,
            'oauth-token:gmail:provider-account-secret','now','now',x'01',x'02'
          );
        "#,
        )
        .unwrap();

        apply(&conn, 18, 19).unwrap();
        apply(&conn, 18, 19).unwrap();

        assert!(table_exists(&conn, "connection_record").unwrap());
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM connection_record", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        let proposed: String = conn.query_row(
            "SELECT proposed_connection_id FROM connection_legacy_unattributed WHERE workspace_id='workspace-a' AND connector_id='gmail'",
            [], |row| row.get(0)
        ).unwrap();
        assert_eq!(
            proposed,
            crate::connector_auth::derive_native_connection_id(
                "workspace-a",
                "gmail",
                "provider-account-secret"
            )
        );
        assert!(!proposed.contains("provider-account-secret"));
        let copied_raw:i64=conn.query_row(
            "SELECT COUNT(*) FROM connection_legacy_unattributed WHERE proposed_connection_id LIKE '%provider-account-secret%'",
            [], |row| row.get(0)
        ).unwrap();
        assert_eq!(copied_raw, 0);
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM connector_account", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn v19_to_v20_adds_empty_canonical_connection_selection_without_guessing() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            PRAGMA foreign_keys = ON;
            CREATE TABLE connection_record(
              workspace_id TEXT NOT NULL,
              id TEXT NOT NULL,
              PRIMARY KEY(workspace_id,id)
            );
            "#,
        )
        .unwrap();

        apply(&conn, 19, 20).unwrap();
        apply(&conn, 19, 20).unwrap();

        assert!(table_exists(&conn, "connection_selection").unwrap());
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM connection_selection", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
            0
        );
    }

    #[test]
    fn v20_to_v21_adds_empty_capability_evidence_without_guessing() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            PRAGMA foreign_keys = ON;
            CREATE TABLE connection_record(
              workspace_id TEXT NOT NULL,
              id TEXT NOT NULL,
              PRIMARY KEY(workspace_id,id)
            );
            "#,
        )
        .unwrap();

        apply(&conn, 20, 21).unwrap();
        apply(&conn, 20, 21).unwrap();

        assert!(table_exists(&conn, "capability_implementation_evidence").unwrap());
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM capability_implementation_evidence",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            0
        );
    }

    #[test]
    fn v21_to_v22_adds_empty_private_mcp_launch_config_without_guessing() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            PRAGMA foreign_keys = ON;
            CREATE TABLE workspace(id TEXT PRIMARY KEY);
            "#,
        )
        .unwrap();

        apply(&conn, 21, 22).unwrap();
        apply(&conn, 21, 22).unwrap();

        assert!(table_exists(&conn, "mcp_local_server_config").unwrap());
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM mcp_local_server_config", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
            0
        );
    }

    #[test]
    fn v22_to_v23_adds_empty_capability_grants_without_guessing_authority() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            PRAGMA foreign_keys = ON;
            CREATE TABLE workspace(id TEXT PRIMARY KEY);
            CREATE TABLE connection_record(
              workspace_id TEXT NOT NULL,
              id TEXT NOT NULL,
              PRIMARY KEY(workspace_id,id)
            );
            "#,
        )
        .unwrap();

        apply(&conn, 22, 23).unwrap();
        apply(&conn, 22, 23).unwrap();

        assert!(table_exists(&conn, "capability_grant").unwrap());
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM capability_grant", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
            0
        );
    }

    #[test]
    fn v17_to_v18_adds_exact_owner_handoffs() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(r#"
          CREATE TABLE project(id TEXT PRIMARY KEY);
          CREATE TABLE thread(id TEXT PRIMARY KEY);
          CREATE TABLE artifact(workspace_id TEXT,owner_subject TEXT,id TEXT,
            PRIMARY KEY(workspace_id,owner_subject,id));
          CREATE TABLE artifact_version(workspace_id TEXT,owner_subject TEXT,artifact_id TEXT,id TEXT,
            PRIMARY KEY(workspace_id,owner_subject,id),
            UNIQUE(workspace_id,owner_subject,artifact_id,id));
        "#).unwrap();
        apply(&conn, 17, 18).unwrap();
        assert!(table_exists(&conn, "artifact_handoff").unwrap());
        assert!(table_has_column(&conn, "artifact_handoff", "target_project_id").unwrap());
        let indices:i64=conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name IN ('idx_artifact_handoff_exact','idx_artifact_handoff_target')",
            [],|row|row.get(0)).unwrap();
        assert_eq!(indices, 2);
    }

    #[test]
    fn v16_to_v17_adds_owner_qualified_review_history() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(r#"
          CREATE TABLE artifact(workspace_id TEXT,owner_subject TEXT,id TEXT,
            PRIMARY KEY(workspace_id,owner_subject,id));
          CREATE TABLE artifact_version(workspace_id TEXT,owner_subject TEXT,artifact_id TEXT,id TEXT,
            PRIMARY KEY(workspace_id,owner_subject,id));
        "#).unwrap();
        apply(&conn, 16, 17).unwrap();
        assert!(table_exists(&conn, "artifact_review").unwrap());
        assert!(table_has_column(&conn, "artifact_review", "version_id").unwrap());
        let indices:i64=conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name IN ('idx_artifact_review_open','idx_artifact_review_history')",
            [],|row|row.get(0)).unwrap();
        assert_eq!(indices, 2);
    }

    #[test]
    fn v15_to_v16_quarantines_unowned_artifacts_and_adds_versions() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
          CREATE TABLE workspace(id TEXT PRIMARY KEY); INSERT INTO workspace VALUES('w');
          CREATE TABLE run(id TEXT PRIMARY KEY);
          CREATE TABLE thread(id TEXT PRIMARY KEY);
          CREATE TABLE artifact(id TEXT PRIMARY KEY,run_id TEXT,kind TEXT NOT NULL,
            content_fingerprint TEXT NOT NULL,size_bytes INTEGER NOT NULL,created_at TEXT NOT NULL,
            payload BLOB NOT NULL,payload_nonce BLOB NOT NULL);
          INSERT INTO artifact VALUES('legacy',NULL,'document','fp',3,'t',x'01',x'02');
        "#,
        )
        .unwrap();
        apply(&conn, 15, 16).unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM artifact", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM artifact_legacy_unowned", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert!(table_has_column(&conn, "artifact", "owner_subject").unwrap());
        assert!(table_exists(&conn, "artifact_version").unwrap());
    }

    #[test]
    fn v14_to_v15_quarantines_unowned_private_context_and_owner_qualifies_schema() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(r#"
          CREATE TABLE workspace(id TEXT PRIMARY KEY);
          INSERT INTO workspace VALUES('w');
          CREATE TABLE project(id TEXT PRIMARY KEY,workspace_id TEXT,authority TEXT,visibility TEXT,owner_member_id TEXT);
          CREATE TABLE preferences(workspace_id TEXT,key TEXT,payload BLOB,payload_nonce BLOB,updated_at TEXT,PRIMARY KEY(workspace_id,key));
          INSERT INTO preferences VALUES('w','document:imported-knowledge.json',x'01',x'02','t');
          CREATE TABLE knowledge_source(workspace_id TEXT,id TEXT,project_id TEXT,connector_id TEXT,connector_account_id TEXT,external_id TEXT,kind TEXT,trust TEXT,pinned INTEGER,disabled INTEGER,content_fingerprint TEXT,size_bytes INTEGER,imported_at TEXT,origin TEXT,payload BLOB,payload_nonce BLOB,PRIMARY KEY(workspace_id,id));
          INSERT INTO knowledge_source VALUES('w','same',NULL,'local-files','','','document','untrusted',0,0,'fp',1,'t','local-import',x'03',x'04');
          CREATE TABLE memory_record(workspace_id TEXT,id TEXT,project_id TEXT,kind TEXT,pinned INTEGER,approved INTEGER,disabled INTEGER,forgotten_at TEXT,created_at TEXT,payload BLOB,payload_nonce BLOB,PRIMARY KEY(workspace_id,id));
          INSERT INTO memory_record VALUES('w','same',NULL,'fact',0,1,0,NULL,'t',x'05',x'06');
          CREATE TABLE knowledge_chunk(workspace_id TEXT,source_id TEXT,id TEXT,ordinal INTEGER,content_fingerprint TEXT,payload BLOB,payload_nonce BLOB,PRIMARY KEY(workspace_id,id));
          CREATE TABLE pinned_context(workspace_id TEXT,id TEXT,source_id TEXT,memory_id TEXT,scope_level TEXT,project_id TEXT,thread_id TEXT,pinned_at TEXT,PRIMARY KEY(workspace_id,id));
          CREATE TABLE knowledge_tombstone(workspace_id TEXT,id TEXT,deleted_at TEXT,PRIMARY KEY(workspace_id,id));
          CREATE TABLE memory_tombstone(workspace_id TEXT,id TEXT,forgotten_at TEXT,PRIMARY KEY(workspace_id,id));
        "#).unwrap();
        apply(&conn, 14, 15).unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM knowledge_source", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM memory_record", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM private_context_legacy_unowned",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            3
        );
        assert!(table_has_column(&conn, "knowledge_source", "owner_subject").unwrap());
        assert!(table_has_column(&conn, "memory_tombstone", "owner_subject").unwrap());
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM preferences", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn v13_to_v14_adds_goals_without_reinterpreting_existing_data() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE workspace (id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL); INSERT INTO workspace VALUES ('w1','One','t','t');").unwrap();
        apply(&conn, 13, 14).unwrap();
        assert!(table_exists(&conn, "goal").unwrap());
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM workspace", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM goal", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn v12_to_v13_preserves_projects_and_backfills_unambiguous_private_owner() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE workspace (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
            CREATE TABLE project (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, title_fingerprint TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload BLOB NOT NULL, payload_nonce BLOB NOT NULL);
            CREATE TABLE fable_workspace_mirror (fable_workspace_id TEXT PRIMARY KEY, local_workspace_id TEXT NOT NULL, status TEXT NOT NULL);
            CREATE TABLE fable_membership_mirror (fable_workspace_id TEXT NOT NULL, member_id TEXT NOT NULL, internal_user_id TEXT NOT NULL, status TEXT NOT NULL);
            INSERT INTO workspace VALUES ('w1','One','t','t');
            INSERT INTO fable_workspace_mirror VALUES ('fw1','w1','active');
            INSERT INTO fable_membership_mirror VALUES ('fw1','member-1','user-1','active');
            INSERT INTO project VALUES ('project-1','w1','fp','t','t',x'0102',x'0304');
            "#,
        ).unwrap();
        apply(&conn, 12, 13).unwrap();
        let row = conn.query_row(
            "SELECT owner_member_id,created_by_internal_user_id,revision,lifecycle,payload FROM project WHERE id='project-1';",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?, row.get::<_, String>(3)?, row.get::<_, Vec<u8>>(4)?)),
        ).unwrap();
        assert_eq!(
            (row.0.as_str(), row.1.as_str(), row.2, row.3.as_str()),
            ("member-1", "user-1", 1, "active")
        );
        assert_eq!(row.4, vec![1, 2]);
        assert!(table_exists(&conn, "project_tombstone").unwrap());
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
        apply(&conn, 1, 2).unwrap();
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

        apply(&conn, 1, 2).unwrap();

        // After: both tables and the connector-cache indices exist.
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
        apply(&conn, 2, 3).unwrap();
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

        apply(&conn, 2, 3).unwrap();

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
        apply(&conn, 2, 3).unwrap();
        apply(&conn, 2, 3).unwrap();
        assert!(audit_event_has_column(&conn, "category").unwrap());
    }

    #[test]
    fn v3_to_v4_preserves_legacy_rows_under_default_workspace() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            PRAGMA foreign_keys = ON;
            CREATE TABLE preferences (
              key TEXT PRIMARY KEY, payload BLOB NOT NULL,
              payload_nonce BLOB NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE connector_account (
              connector_id TEXT PRIMARY KEY, account_id TEXT, status TEXT NOT NULL,
              expires_at INTEGER, credential_ref TEXT NOT NULL, connected_at TEXT NOT NULL,
              updated_at TEXT NOT NULL, payload BLOB NOT NULL, payload_nonce BLOB NOT NULL
            );
            CREATE TABLE project (
              id TEXT PRIMARY KEY, title_fingerprint TEXT NOT NULL,
              created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
              payload BLOB NOT NULL, payload_nonce BLOB NOT NULL
            );
            CREATE TABLE knowledge_source (
              id TEXT PRIMARY KEY, connector_id TEXT NOT NULL, kind TEXT NOT NULL,
              trust TEXT NOT NULL, pinned INTEGER NOT NULL, content_fingerprint TEXT NOT NULL,
              size_bytes INTEGER NOT NULL, imported_at TEXT NOT NULL, origin TEXT NOT NULL,
              payload BLOB NOT NULL, payload_nonce BLOB NOT NULL
            );
            INSERT INTO preferences VALUES ('shell', x'01', x'02', 'now');
            INSERT INTO connector_account VALUES (
              'github', NULL, 'connected', NULL, 'oauth-token:github:1',
              'now', 'now', x'03', x'04'
            );
            INSERT INTO project VALUES ('p1', 'fp', 'now', 'now', x'05', x'06');
            INSERT INTO knowledge_source VALUES (
              'k1', 'local-files', 'document', 'untrusted', 0, 'fp', 1,
              'now', 'local-import', x'07', x'08'
            );
            "#,
        )
        .unwrap();

        apply(&conn, 3, 4).unwrap();
        apply(&conn, 3, 4).unwrap();

        let workspace_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM workspace WHERE id='default';",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let preference_owner: String = conn
            .query_row(
                "SELECT workspace_id FROM preferences WHERE key='shell';",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let project_owner: String = conn
            .query_row("SELECT workspace_id FROM project WHERE id='p1';", [], |r| {
                r.get(0)
            })
            .unwrap();
        let knowledge_owner: String = conn
            .query_row(
                "SELECT workspace_id FROM knowledge_source WHERE id='k1';",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(workspace_count, 1);
        assert_eq!(preference_owner, "default");
        assert_eq!(project_owner, "default");
        assert_eq!(knowledge_owner, "default");
    }

    #[test]
    fn v4_to_v5_preserves_rows_and_makes_ids_workspace_composite() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            PRAGMA foreign_keys = ON;
            CREATE TABLE workspace (
              id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            INSERT INTO workspace VALUES ('default','Default','now','now'), ('beta','Beta','now','now');
            CREATE TABLE project (
              id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, title_fingerprint TEXT NOT NULL,
              created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload BLOB NOT NULL, payload_nonce BLOB NOT NULL
            );
            CREATE TABLE knowledge_source (
              id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT,
              connector_id TEXT NOT NULL, kind TEXT NOT NULL, trust TEXT NOT NULL,
              pinned INTEGER NOT NULL, content_fingerprint TEXT NOT NULL, size_bytes INTEGER NOT NULL,
              imported_at TEXT NOT NULL, origin TEXT NOT NULL, payload BLOB NOT NULL, payload_nonce BLOB NOT NULL
            );
            CREATE TABLE memory_record (
              id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT,
              kind TEXT NOT NULL, pinned INTEGER NOT NULL, approved INTEGER NOT NULL,
              created_at TEXT NOT NULL, payload BLOB NOT NULL, payload_nonce BLOB NOT NULL
            );
            INSERT INTO knowledge_source VALUES
              ('shared','default',NULL,'local-files','document','untrusted',0,'fp',1,'now','local-import',x'01',x'02');
            INSERT INTO memory_record VALUES
              ('memory','default',NULL,'fact',0,1,'now',x'03',x'04');
            "#,
        )
        .unwrap();

        apply(&conn, 4, 5).unwrap();
        conn.execute(
            "INSERT INTO knowledge_source
               (workspace_id,id,project_id,connector_id,kind,trust,pinned,disabled,
                content_fingerprint,size_bytes,imported_at,origin,payload,payload_nonce)
             VALUES ('beta','shared',NULL,'local-files','document','untrusted',0,0,'fp2',2,'now','local-import',x'05',x'06');",
            [],
        )
        .unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM knowledge_source WHERE id='shared'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            2
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM memory_record WHERE id='memory' AND workspace_id='default'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );

        // Reapplying is non-destructive once the composite shape is present.
        apply(&conn, 4, 5).unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM knowledge_source", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
    }

    /// The v5→v6 step adds the plaintext `search_text` column to
    /// `connector_cache` and the covering search index. It is idempotent
    /// (re-applying to an already-upgraded database is a no-op) and a no-op when
    /// the table is absent (minimal test schemas).
    #[test]
    fn v5_to_v6_step_adds_search_text_column_and_index() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        // A pre-v6 connector_cache table without the search_text column.
        conn.execute_batch(
            r#"
            CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE connector_cache (
              id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
              connector_id TEXT NOT NULL, provider_item_id TEXT NOT NULL,
              kind TEXT NOT NULL, trust TEXT NOT NULL DEFAULT 'untrusted',
              pinned INTEGER NOT NULL DEFAULT 0, disabled INTEGER NOT NULL DEFAULT 0,
              content_fingerprint TEXT NOT NULL DEFAULT '', cached_at TEXT NOT NULL,
              origin TEXT NOT NULL DEFAULT 'connector-cache',
              payload BLOB NOT NULL, payload_nonce BLOB NOT NULL
            );
            "#,
        )
        .unwrap();
        assert!(!table_has_column(&conn, "connector_cache", "search_text").unwrap());

        apply(&conn, 5, 6).unwrap();

        assert!(table_has_column(&conn, "connector_cache", "search_text").unwrap());
        // Existing rows backfill to the default empty string (the store
        // backfills lazily with the vault; the migration itself does not).
        conn.execute(
            "INSERT INTO connector_cache
               (id, workspace_id, connector_id, provider_item_id, kind, cached_at,
                payload, payload_nonce)
             VALUES ('r1','ws','github','i1','document','t', x'00', x'00');",
            [],
        )
        .unwrap();
        let search_text: String = conn
            .query_row(
                "SELECT search_text FROM connector_cache WHERE id='r1';",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(search_text, "");
        // The covering index exists.
        let idx: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index'
                 AND name='idx_connector_cache_search_text';",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(idx, 1);

        // Idempotent: re-applying does not error or duplicate.
        apply(&conn, 5, 6).unwrap();
        let idx2: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index'
                 AND name='idx_connector_cache_search_text';",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(idx2, 1);
    }

    /// When the connector_cache table is absent, the v5→v6 step is a no-op
    /// (does not error on minimal test schemas).
    #[test]
    fn v5_to_v6_step_is_noop_without_connector_cache_table() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
            .unwrap();
        apply(&conn, 5, 6).unwrap();
        let tables: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='connector_cache';",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tables, 0);
    }

    #[test]
    fn v6_to_v7_adds_cloud_sync_tables() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            PRAGMA foreign_keys = ON;
            CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE workspace (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            INSERT INTO workspace VALUES ('default','Default','now','now');
            "#,
        )
        .unwrap();

        apply(&conn, 6, 7).unwrap();
        apply(&conn, 6, 7).unwrap();

        let tables: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type='table' AND name IN (
                   'cloud_workspace_link',
                   'cloud_sync_cursor',
                   'cloud_mutation_outbox',
                   'cloud_record_shadow',
                   'cloud_conflict'
                 );",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tables, 5);
        assert!(table_has_column(&conn, "cloud_workspace_link", "cloud_workspace_id").unwrap());
        assert!(table_has_column(&conn, "cloud_workspace_link", "clerk_org_id").unwrap());
    }

    #[test]
    fn v7_to_v8_preserves_sync_rows_and_quarantines_clerk_org_tenancy() {
        let conn = v7_conn();
        conn.execute_batch(
            r#"
            INSERT INTO cloud_workspace_link (
              local_workspace_id, cloud_workspace_id, clerk_org_id, role,
              sync_state, linked_device_id, last_accepted_revision, linked_at, updated_at
            ) VALUES ('default','fable-ws','org-legacy','editor','active','device-a',4,'then','now');
            INSERT INTO cloud_sync_cursor VALUES ('default','device-a',4,9,'now');
            INSERT INTO cloud_mutation_outbox (
              local_mutation_id,idempotency_key,local_workspace_id,cloud_workspace_id,device_id,
              client_mutation_id,base_revision,record_type,record_id,operation,status,attempt_count,
              created_at,updated_at,payload,payload_nonce
            ) VALUES ('m1','old-key','default','fable-ws','device-a','client-a',4,'project','p1','delete','queued',2,'then','now',x'01',x'02');
            INSERT INTO cloud_record_shadow VALUES ('default','fable-ws','project','p1',4,'fp','gone','c1','now');
            INSERT INTO cloud_conflict VALUES ('c1','default','fable-ws','m1','project','p1','revision-conflict','now',x'03',x'04');
            "#,
        )
        .unwrap();

        apply(&conn, 7, 8).unwrap();
        apply(&conn, 7, 8).unwrap();

        let link: (String, String, String, String) = conn
            .query_row(
                "SELECT fable_workspace_id, internal_user_id, member_id, device_id
                 FROM cloud_workspace_link WHERE local_workspace_id='default';",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(link.0, "fable-ws");
        assert_eq!(link.1, "legacy-user:device-a");
        assert_eq!(link.2, "legacy-member:default");
        assert_eq!(link.3, "device-a");
        let legacy_org: String = conn
            .query_row(
                "SELECT clerk_org_id FROM cloud_workspace_link_legacy_clerk_org
                 WHERE local_workspace_id='default';",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(legacy_org, "org-legacy");
        let (status, fingerprint, deleted_at): (String, String, String) = conn
            .query_row(
                "SELECT status, (SELECT content_fingerprint FROM cloud_record_shadow WHERE record_id='p1'),
                        (SELECT deleted_at FROM cloud_record_shadow WHERE record_id='p1')
                 FROM cloud_mutation_outbox WHERE local_mutation_id='m1';",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(status, "pending");
        assert_eq!(fingerprint, "fp");
        assert_eq!(deleted_at, "gone");
        let mirrors: i64 = conn
            .query_row("SELECT COUNT(*) FROM fable_workspace_mirror;", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(mirrors, 1);
    }

    #[test]
    fn v7_to_v8_rolls_back_completely_when_outer_migration_fails() {
        let mut conn = v7_conn();
        conn.execute(
            "INSERT INTO cloud_workspace_link VALUES
             ('default','fable-ws','org-legacy','owner','active','device-a',0,'now','now');",
            [],
        )
        .unwrap();
        let tx = conn.transaction().unwrap();
        apply(&tx, 7, 8).unwrap();
        let failure = tx.execute("INSERT INTO missing_table VALUES (1);", []);
        assert!(failure.is_err());
        tx.rollback().unwrap();

        assert!(table_has_column(&conn, "cloud_workspace_link", "clerk_org_id").unwrap());
        assert!(!table_exists(&conn, "fable_workspace_mirror").unwrap());
    }

    #[test]
    fn v7_to_v8_refuses_orphaned_sync_rows_without_mutating_the_v7_schema() {
        let conn = v7_conn();
        conn.execute(
            "INSERT INTO cloud_sync_cursor VALUES ('default','device-a',4,9,'now');",
            [],
        )
        .unwrap();

        let err = apply(&conn, 7, 8).unwrap_err();
        assert!(matches!(err, super::super::StoreError::Invalid(_)));
        assert!(table_has_column(&conn, "cloud_workspace_link", "clerk_org_id").unwrap());
        assert!(!table_exists(&conn, "fable_workspace_mirror").unwrap());
        let cursor_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM cloud_sync_cursor;", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(cursor_count, 1);
    }

    #[test]
    fn v8_to_v9_adds_an_idempotent_selection_table_without_touching_mirrors() {
        let conn = v7_conn();
        conn.execute(
            "INSERT INTO cloud_workspace_link VALUES
             ('default','fable-ws','org-legacy','owner','active','device-a',0,'now','now');",
            [],
        )
        .unwrap();
        apply(&conn, 7, 8).unwrap();
        let before: (String, String) = conn
            .query_row(
                "SELECT fable_workspace_id, internal_user_id
                 FROM cloud_workspace_link WHERE local_workspace_id='default';",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        apply(&conn, 8, 9).unwrap();
        apply(&conn, 8, 9).unwrap();

        assert!(table_exists(&conn, "active_workspace_selection").unwrap());
        assert!(table_exists(&conn, "current_internal_user").unwrap());
        let after: (String, String) = conn
            .query_row(
                "SELECT fable_workspace_id, internal_user_id
                 FROM cloud_workspace_link WHERE local_workspace_id='default';",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(after, before);
    }

    #[test]
    fn v9_to_v10_preserves_device_mirrors_with_safe_defaults_and_is_idempotent() {
        let conn = v7_conn();
        conn.execute(
            "INSERT INTO cloud_workspace_link VALUES
             ('default','fable-ws','org-legacy','owner','active','device-a',0,'now','now');",
            [],
        )
        .unwrap();
        apply(&conn, 7, 8).unwrap();
        apply(&conn, 8, 9).unwrap();
        conn.execute(
            "INSERT INTO fable_device_mirror
             (device_id, internal_user_id, status, revision, kind, label, updated_at)
             VALUES ('device-b', 'legacy-user:device-a', 'active', 7, 'desktop', 'Desk', 'now');",
            [],
        )
        .unwrap();

        apply(&conn, 9, 10).unwrap();
        apply(&conn, 9, 10).unwrap();

        let row: (String, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT registered_at, last_seen_at, revoked_at
                 FROM fable_device_mirror WHERE device_id='device-b';",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(row, ("".into(), None, None));
    }

    #[test]
    fn v10_to_v11_keeps_agent_runs_bound_to_the_canonical_thread_table() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            PRAGMA foreign_keys = OFF;
            CREATE TABLE workspace(id TEXT PRIMARY KEY);
            INSERT INTO workspace VALUES('workspace-1');
            CREATE TABLE project(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL);
            INSERT INTO project VALUES('project-1','workspace-1');
            CREATE TABLE draft(
              id TEXT PRIMARY KEY,updated_at TEXT NOT NULL,
              payload BLOB NOT NULL,payload_nonce BLOB NOT NULL
            );
            CREATE TABLE thread(
              id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES project(id),
              created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
              payload BLOB NOT NULL,payload_nonce BLOB NOT NULL
            );
            INSERT INTO thread VALUES(
              'thread-1','project-1','now','now',x'01',x'02'
            );
            CREATE TABLE message(
              id TEXT PRIMARY KEY,thread_id TEXT NOT NULL REFERENCES thread(id),
              role TEXT NOT NULL,seq INTEGER NOT NULL,created_at TEXT NOT NULL,
              payload BLOB NOT NULL,payload_nonce BLOB NOT NULL
            );
            INSERT INTO message VALUES(
              'message-1','thread-1','user',1,'now',x'03',x'04'
            );
            CREATE TABLE run(
              id TEXT PRIMARY KEY,
              thread_id TEXT REFERENCES thread(id) ON DELETE CASCADE,
              provider_id TEXT NOT NULL,model TEXT NOT NULL,status TEXT NOT NULL,
              turn INTEGER NOT NULL DEFAULT 0,recoverable INTEGER NOT NULL DEFAULT 0,
              retry_count INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,payload BLOB NOT NULL,payload_nonce BLOB NOT NULL
            );
            INSERT INTO run VALUES(
              'run-1','thread-1','codex','gpt','completed',0,0,0,
              'now','now',x'05',x'06'
            );
            "#,
        )
        .unwrap();

        apply(&conn, 10, 11).unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();

        assert_eq!(
            foreign_key_target(&conn, "run", "thread_id")
                .unwrap()
                .as_deref(),
            Some("thread")
        );
        assert_eq!(
            conn.query_row("SELECT workspace_id FROM run WHERE id='run-1'", [], |row| {
                row.get::<_, String>(0)
            })
            .unwrap(),
            "workspace-1"
        );
        assert_eq!(
            conn.query_row("PRAGMA foreign_key_check", [], |_| Ok(1_i64))
                .optional()
                .unwrap(),
            None
        );
    }

    #[test]
    fn v35_to_v36_repairs_dangling_run_thread_foreign_key_without_losing_rows() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            PRAGMA foreign_keys = OFF;
            CREATE TABLE workspace(id TEXT PRIMARY KEY);
            INSERT INTO workspace VALUES('workspace-1');
            CREATE TABLE thread(id TEXT PRIMARY KEY);
            INSERT INTO thread VALUES('thread-1');
            CREATE TABLE run(
              id TEXT PRIMARY KEY,
              workspace_id TEXT NOT NULL DEFAULT 'default'
                REFERENCES workspace(id) ON DELETE CASCADE,
              thread_id TEXT REFERENCES "thread_v10"(id) ON DELETE CASCADE,
              provider_id TEXT NOT NULL,model TEXT NOT NULL,status TEXT NOT NULL,
              turn INTEGER NOT NULL DEFAULT 0,recoverable INTEGER NOT NULL DEFAULT 0,
              retry_count INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,payload BLOB NOT NULL,payload_nonce BLOB NOT NULL
            );
            CREATE INDEX idx_run_status ON run(workspace_id,status);
            CREATE INDEX idx_run_thread ON run(workspace_id,thread_id);
            INSERT INTO run VALUES(
              'run-1','workspace-1','thread-1','codex','gpt','completed',
              0,0,0,'now','now',x'01',x'02'
            );
            CREATE TABLE tool_call(
              id TEXT PRIMARY KEY,
              run_id TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE
            );
            INSERT INTO tool_call VALUES('tool-1','run-1');
            "#,
        )
        .unwrap();

        apply(&conn, 35, 36).unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();

        assert_eq!(
            foreign_key_target(&conn, "run", "thread_id")
                .unwrap()
                .as_deref(),
            Some("thread")
        );
        assert_eq!(
            foreign_key_target(&conn, "tool_call", "run_id")
                .unwrap()
                .as_deref(),
            Some("run")
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM run", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM tool_call", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row("PRAGMA foreign_key_check", [], |_| Ok(1_i64))
                .optional()
                .unwrap(),
            None
        );

        conn.execute("DELETE FROM thread WHERE id='thread-1'", [])
            .unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM run", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM tool_call", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
            0
        );
    }

    #[test]
    fn v36_to_v37_repairs_run_dependents_without_losing_rows_or_child_links() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            PRAGMA foreign_keys = OFF;
            CREATE TABLE workspace(id TEXT PRIMARY KEY);
            INSERT INTO workspace VALUES('workspace-1');
            CREATE TABLE thread(id TEXT PRIMARY KEY);
            INSERT INTO thread VALUES('thread-1');
            CREATE TABLE run(
              id TEXT PRIMARY KEY,
              workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
              thread_id TEXT REFERENCES thread(id) ON DELETE CASCADE,
              provider_id TEXT NOT NULL,model TEXT NOT NULL,status TEXT NOT NULL,
              turn INTEGER NOT NULL DEFAULT 0,recoverable INTEGER NOT NULL DEFAULT 0,
              retry_count INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,payload BLOB NOT NULL,payload_nonce BLOB NOT NULL
            );
            INSERT INTO run VALUES(
              'run-1','workspace-1','thread-1','codex','gpt','completed',
              0,0,0,'now','now',x'01',x'02'
            );
            CREATE TABLE tool_call(
              id TEXT PRIMARY KEY,
              run_id TEXT NOT NULL REFERENCES "run_v35_broken"(id) ON DELETE CASCADE,
              tool TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,
              payload BLOB NOT NULL,payload_nonce BLOB NOT NULL
            );
            CREATE INDEX idx_tool_call_run ON tool_call(run_id);
            INSERT INTO tool_call VALUES(
              'tool-1','run-1','read','completed','now',x'03',x'04'
            );
            CREATE TABLE approval(
              id TEXT PRIMARY KEY,
              run_id TEXT REFERENCES "run_v35_broken"(id) ON DELETE CASCADE,
              service TEXT NOT NULL,action TEXT NOT NULL,mode TEXT NOT NULL,
              risk_level TEXT NOT NULL,decision TEXT NOT NULL,
              request_fingerprint TEXT NOT NULL,decided_at TEXT NOT NULL,
              payload BLOB NOT NULL,payload_nonce BLOB NOT NULL
            );
            CREATE INDEX idx_approval_run ON approval(run_id);
            CREATE INDEX idx_approval_rules
              ON approval(service,action) WHERE decision='rule';
            INSERT INTO approval VALUES(
              'approval-1','run-1','local','read','read-only','low','once',
              'fingerprint','now',x'05',x'06'
            );
            CREATE TABLE artifact(
              workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
              owner_subject TEXT NOT NULL,
              authority TEXT NOT NULL CHECK(authority='local'),
              visibility TEXT NOT NULL CHECK(visibility='member-private'),
              owner_member_id TEXT,owner_internal_user_id TEXT,id TEXT NOT NULL,
              run_id TEXT REFERENCES "run_v35_broken"(id) ON DELETE CASCADE,
              thread_id TEXT REFERENCES thread(id) ON DELETE CASCADE,
              source_message_id TEXT,kind TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'draft',
              revision INTEGER NOT NULL DEFAULT 1,current_version_id TEXT NOT NULL,
              title_fingerprint TEXT NOT NULL,content_fingerprint TEXT NOT NULL,
              size_bytes INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
              payload BLOB NOT NULL,payload_nonce BLOB NOT NULL,
              PRIMARY KEY(workspace_id,owner_subject,id),
              CHECK ((owner_member_id IS NOT NULL) != (owner_internal_user_id IS NOT NULL))
            );
            CREATE INDEX idx_artifact_run
              ON artifact(workspace_id,owner_subject,run_id);
            CREATE INDEX idx_artifact_thread
              ON artifact(workspace_id,owner_subject,thread_id,created_at);
            INSERT INTO artifact VALUES(
              'workspace-1','internal:user-1','local','member-private',NULL,'user-1',
              'artifact-1','run-1','thread-1',NULL,'document','draft',1,'version-1',
              'title','content',1,'now','now',x'07',x'08'
            );
            CREATE TABLE artifact_version(
              workspace_id TEXT NOT NULL,owner_subject TEXT NOT NULL,
              artifact_id TEXT NOT NULL,id TEXT NOT NULL,
              PRIMARY KEY(workspace_id,owner_subject,id),
              FOREIGN KEY(workspace_id,owner_subject,artifact_id)
                REFERENCES artifact(workspace_id,owner_subject,id) ON DELETE CASCADE
            );
            INSERT INTO artifact_version VALUES(
              'workspace-1','internal:user-1','artifact-1','version-1'
            );
            "#,
        )
        .unwrap();

        apply(&conn, 36, 37).unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();

        for table in ["tool_call", "approval", "artifact"] {
            assert_eq!(
                foreign_key_target(&conn, table, "run_id")
                    .unwrap()
                    .as_deref(),
                Some("run"),
                "{table} must reference the canonical run table"
            );
            assert_eq!(
                conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row
                    .get::<_, i64>(0))
                    .unwrap(),
                1,
                "{table} rows must survive the repair"
            );
        }
        assert_eq!(
            foreign_key_target(&conn, "artifact_version", "artifact_id")
                .unwrap()
                .as_deref(),
            Some("artifact")
        );
        assert_eq!(
            conn.query_row("PRAGMA foreign_key_check", [], |_| Ok(1_i64))
                .optional()
                .unwrap(),
            None
        );

        conn.execute("DELETE FROM run WHERE id='run-1'", [])
            .unwrap();
        for table in ["tool_call", "approval", "artifact", "artifact_version"] {
            assert_eq!(
                conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row
                    .get::<_, i64>(0))
                    .unwrap(),
                0,
                "{table} must retain its cascade relationship"
            );
        }
    }
}
