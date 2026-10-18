//! Forward migration regression tests.

use super::helpers::{audit_event_has_column, foreign_key_target, table_exists, table_has_column};
use super::*;
use crate::store::schema::{
    CURRENT_SCHEMA_VERSION, LEGACY_ORCHESTRATION_SCHEMA_V37, SCHEMA_V1, SCHEMA_V1_TO_V2,
};
use rusqlite::{Connection, OptionalExtension};

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
fn v43_to_v44_adds_encrypted_output_identity_and_revision_tables() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "PRAGMA foreign_keys=ON;
             CREATE TABLE workspace(id TEXT PRIMARY KEY);
             INSERT INTO workspace VALUES('default');
             CREATE TABLE thread(id TEXT PRIMARY KEY);",
    )
    .unwrap();
    apply(&conn, 43, 44).unwrap();
    assert!(table_exists(&conn, "output_record").unwrap());
    assert!(table_exists(&conn, "output_revision").unwrap());
    let title_column: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('output_record') WHERE name='title'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        title_column, 0,
        "titles stay inside the encrypted metadata payload"
    );
    let foreign_keys: i64 = conn.query_row(
            "SELECT COUNT(*) FROM pragma_foreign_key_list('output_revision') WHERE \"table\"='output_record'",
            [],
            |row| row.get(0),
        ).unwrap();
    assert!(foreign_keys > 0);
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
