//! Historical capability, artifact, and execution schema upgrades.

use rusqlite::Connection;

use super::super::Result;
use super::helpers::{require_foreign_keys_disabled, table_exists, table_has_column};

pub(super) fn apply_v31_to_v32(conn: &Connection) -> Result<()> {
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

pub(super) fn apply_v30_to_v31(conn: &Connection) -> Result<()> {
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

pub(super) fn apply_v29_to_v30(conn: &Connection) -> Result<()> {
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

pub(super) fn apply_v28_to_v29(conn: &Connection) -> Result<()> {
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

pub(super) fn apply_v27_to_v28(conn: &Connection) -> Result<()> {
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

pub(super) fn apply_v26_to_v27(conn: &Connection) -> Result<()> {
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

pub(super) fn apply_v25_to_v26(conn: &Connection) -> Result<()> {
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

pub(super) fn apply_v24_to_v25(conn: &Connection) -> Result<()> {
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

pub(super) fn apply_v23_to_v24(conn: &Connection) -> Result<()> {
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

pub(super) fn apply_v22_to_v23(conn: &Connection) -> Result<()> {
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

pub(super) fn apply_v21_to_v22(conn: &Connection) -> Result<()> {
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

pub(super) fn apply_v20_to_v21(conn: &Connection) -> Result<()> {
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

pub(super) fn apply_v19_to_v20(conn: &Connection) -> Result<()> {
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

pub(super) fn apply_v18_to_v19(conn: &Connection) -> Result<()> {
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

pub(super) fn apply_v17_to_v18(conn: &Connection) -> Result<()> {
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

pub(super) fn apply_v16_to_v17(conn: &Connection) -> Result<()> {
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

pub(super) fn apply_v15_to_v16(conn: &Connection) -> Result<()> {
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

pub(super) fn apply_v14_to_v15(conn: &Connection) -> Result<()> {
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

pub(super) fn apply_v13_to_v14(conn: &Connection) -> Result<()> {
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

pub(super) fn apply_v12_to_v13(conn: &Connection) -> Result<()> {
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

pub(super) fn apply_v11_to_v12(conn: &Connection) -> Result<()> {
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

pub(super) fn apply_v10_to_v11(conn: &Connection) -> Result<()> {
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
