//! Comprehensive tests for Batch 9.
//! Covers: Workspace isolation, Migration safety, Export/Import, and Data-loss prevention.

use crate::portable::{
    export_workspace, export_workspace_for, import_workspace, import_workspace_for, ImportOptions,
    PORTABLE_FORMAT_NAME, PORTABLE_FORMAT_VERSION,
};
use crate::store::repos::scope::DataScope;
use crate::store::repos::{
    connector_account, knowledge_source, memory_record, preferences, schedule, scheduled_job,
    scheduler_queue, workflow, workspace,
};
use crate::store::vault::{MasterKey, Vault};
use crate::store::{Store, StoreError};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::fs;
use tempfile::TempDir;

fn vault() -> Vault {
    Vault::new(&MasterKey::generate().unwrap()).unwrap()
}

fn test_store() -> Store {
    Store::open_in_memory(vault()).unwrap()
}

fn add_workspace(tx: &Connection, id: &str, name: &str) {
    workspace::upsert(tx, id, name, "2026-06-30T12:00:00Z").unwrap();
}

fn add_project(tx: &Connection, store: &Store, scope: &DataScope, id: &str) {
    let sealed = store.seal_payload(b"{}", &format!("project:{id}")).unwrap();
    workspace::upsert_project(
        tx,
        scope,
        id,
        "fp",
        "2026-06-30T12:00:00Z",
        &sealed.ciphertext,
        &sealed.nonce,
    )
    .unwrap();
}

// ---------------------------------------------------------------------------
// 1. Workspace Isolation Tests
// ---------------------------------------------------------------------------

#[test]
fn test_workspace_isolation_crud_operations() {
    let store = test_store();

    // 1. Setup two workspaces
    store
        .transaction(|tx| {
            add_workspace(tx, "alpha", "Alpha Workspace");
            add_workspace(tx, "beta", "Beta Workspace");
            Ok(())
        })
        .unwrap();

    let alpha_scope = DataScope::workspace("alpha").unwrap();
    let beta_scope = DataScope::workspace("beta").unwrap();

    // 2. Preferences (Settings) Isolation
    store
        .transaction(|tx| {
            preferences::upsert_scoped(
                tx,
                &store,
                &alpha_scope,
                "theme",
                &json!({"color": "red"}),
                "now",
            )?;
            preferences::upsert_scoped(
                tx,
                &store,
                &beta_scope,
                "theme",
                &json!({"color": "blue"}),
                "now",
            )?;
            Ok(())
        })
        .unwrap();

    let alpha_pref = store
        .with_conn(|conn| preferences::get_scoped(conn, &store, &alpha_scope, "theme"))
        .unwrap()
        .unwrap();
    let beta_pref = store
        .with_conn(|conn| preferences::get_scoped(conn, &store, &beta_scope, "theme"))
        .unwrap()
        .unwrap();
    assert_eq!(alpha_pref["color"], "red");
    assert_eq!(beta_pref["color"], "blue");

    // Settings must reject project scope
    store
        .transaction(|tx| {
            add_project(tx, &store, &alpha_scope, "proj_a");
            Ok(())
        })
        .unwrap();
    let alpha_proj_scope = DataScope::new("alpha", Some("proj_a".to_string())).unwrap();
    assert!(store
        .transaction(|tx| {
            preferences::upsert_scoped(
                tx,
                &store,
                &alpha_proj_scope,
                "theme",
                &json!({"color": "green"}),
                "now",
            )
        })
        .is_err());

    // 3. Connector Isolation
    store
        .transaction(|tx| {
            connector_account::upsert_from_value_scoped(
                tx,
                &store,
                &alpha_scope,
                json!({
                    "connectorId": "slack",
                    "status": "connected",
                    "credentialRef": "oauth-token:slack:1"
                }),
                "now",
            )?;
            connector_account::upsert_from_value_scoped(
                tx,
                &store,
                &beta_scope,
                json!({
                    "connectorId": "slack",
                    "status": "disconnected",
                    "credentialRef": "oauth-token:slack:2"
                }),
                "now",
            )?;
            Ok(())
        })
        .unwrap();

    let alpha_connectors = store
        .with_conn(|conn| connector_account::list_scoped(conn, &store, &alpha_scope))
        .unwrap();
    let beta_connectors = store
        .with_conn(|conn| connector_account::list_scoped(conn, &store, &beta_scope))
        .unwrap();
    assert_eq!(alpha_connectors.len(), 1);
    assert_eq!(beta_connectors.len(), 1);
    assert_eq!(alpha_connectors[0].status, "connected");
    assert_eq!(beta_connectors[0].status, "disconnected");

    // 4. Same IDs/names in separate workspaces (Workspace-isolated and distinct-ID tables)
    store.transaction(|tx| {
        // Knowledge Source (distinct IDs required due to id TEXT PRIMARY KEY)
        knowledge_source::upsert_from_value_scoped(tx, &store, &alpha_scope, json!({
            "id": "k1_alpha", "connectorId": "local", "kind": "doc", "trust": "trusted", "pinned": 0, "sizeBytes": 10
        }), "now")?;
        knowledge_source::upsert_from_value_scoped(tx, &store, &beta_scope, json!({
            "id": "k1_beta", "connectorId": "local", "kind": "doc", "trust": "untrusted", "pinned": 1, "sizeBytes": 20
        }), "now")?;

        // Memory Record
        memory_record::upsert_from_value_scoped(tx, &store, &alpha_scope, json!({
            "id": "m1_alpha", "kind": "fact", "pinned": false, "approved": true
        }), "now")?;
        memory_record::upsert_from_value_scoped(tx, &store, &beta_scope, json!({
            "id": "m1_beta", "kind": "fact", "pinned": true, "approved": false
        }), "now")?;

        // Schedule
        schedule::upsert_from_value_scoped(tx, &store, &alpha_scope, json!({
            "id": "s1_alpha", "day": "Mon", "time": "10:00", "enabled": true
        }), "now")?;
        schedule::upsert_from_value_scoped(tx, &store, &beta_scope, json!({
            "id": "s1_beta", "day": "Tue", "time": "11:00", "enabled": false
        }), "now")?;

        // Workflow Definition (workspace-scoped primary key: supports same ID)
        workflow::upsert_definition(tx, &store, &alpha_scope, "wf1", 1u32, "now", "now", &json!({"step": 1}))?;
        workflow::upsert_definition(tx, &store, &beta_scope, "wf1", 1u32, "now", "now", &json!({"step": 2}))?;

        // Workflow Run
        workflow::upsert_run(tx, &store, &alpha_scope, "run1_alpha", "wf1", 1u32, "running", "now", "now", &json!({"progress": 10}))?;
        workflow::upsert_run(tx, &store, &beta_scope, "run1_beta", "wf1", 1u32, "completed", "now", "now", &json!({"progress": 100}))?;

        Ok(())
    }).unwrap();

    // Verify independent retrieves
    let alpha_k = store
        .with_conn(|conn| knowledge_source::list_scoped(conn, &store, &alpha_scope))
        .unwrap();
    let beta_k = store
        .with_conn(|conn| knowledge_source::list_scoped(conn, &store, &beta_scope))
        .unwrap();
    assert_eq!(alpha_k.len(), 1);
    assert_eq!(beta_k.len(), 1);
    assert_eq!(alpha_k[0].id, "k1_alpha");
    assert_eq!(beta_k[0].id, "k1_beta");

    let alpha_m = store
        .with_conn(|conn| memory_record::list_scoped(conn, &store, &alpha_scope))
        .unwrap();
    let beta_m = store
        .with_conn(|conn| memory_record::list_scoped(conn, &store, &beta_scope))
        .unwrap();
    assert!(alpha_m[0].approved);
    assert!(!beta_m[0].approved);

    let alpha_s = store
        .with_conn(|conn| schedule::list_scoped(conn, &store, &alpha_scope))
        .unwrap();
    let beta_s = store
        .with_conn(|conn| schedule::list_scoped(conn, &store, &beta_scope))
        .unwrap();
    assert_eq!(alpha_s[0].weekday, "Mon");
    assert_eq!(beta_s[0].weekday, "Tue");

    let alpha_wf = store
        .with_conn(|conn| workflow::list_definitions(conn, &store, &alpha_scope))
        .unwrap();
    let beta_wf = store
        .with_conn(|conn| workflow::list_definitions(conn, &store, &beta_scope))
        .unwrap();
    assert_eq!(alpha_wf[0]["step"], 1);
    assert_eq!(beta_wf[0]["step"], 2);

    let alpha_run = store
        .with_conn(|conn| workflow::list_runs(conn, &store, &alpha_scope, None))
        .unwrap();
    let beta_run = store
        .with_conn(|conn| workflow::list_runs(conn, &store, &beta_scope, None))
        .unwrap();
    assert_eq!(alpha_run[0]["progress"], 10);
    assert_eq!(beta_run[0]["progress"], 100);

    // Verify same ID ownership conflict is rejected across workspaces for global primary key tables
    let ownership_err = store.transaction(|tx| {
        knowledge_source::upsert_from_value_scoped(tx, &store, &beta_scope, json!({
            "id": "k1_alpha", "connectorId": "local", "kind": "doc", "trust": "untrusted", "pinned": 1, "sizeBytes": 20
        }), "now")
    }).unwrap_err();
    assert!(matches!(ownership_err, StoreError::Invalid(_)));

    // 5. Cross-workspace delete is isolated
    store
        .transaction(|tx| knowledge_source::delete_scoped(tx, &beta_scope, "k1_beta"))
        .unwrap();
    let alpha_k_post = store
        .with_conn(|conn| knowledge_source::list_scoped(conn, &store, &alpha_scope))
        .unwrap();
    let beta_k_post = store
        .with_conn(|conn| knowledge_source::list_scoped(conn, &store, &beta_scope))
        .unwrap_or_default();
    assert_eq!(alpha_k_post.len(), 1, "Alpha row should remain intact");
    assert_eq!(beta_k_post.len(), 0, "Beta row should be deleted");

    // 6. Context validation (missing, stale, invalid)
    // Non-existent workspace check
    let invalid_workspace_scope = DataScope::workspace("non_existent").unwrap();
    assert!(store
        .transaction(|tx| {
            preferences::upsert_scoped(
                tx,
                &store,
                &invalid_workspace_scope,
                "theme",
                &json!({"color": "red"}),
                "now",
            )
        })
        .is_err());

    // Switched active-workspace context (alpha_scope with beta's project)
    store
        .transaction(|tx| {
            add_project(tx, &store, &beta_scope, "proj_b");
            Ok(())
        })
        .unwrap();
    let switched_scope = DataScope::new("alpha", Some("proj_b".to_string())).unwrap();
    assert!(store
        .with_conn(|conn| switched_scope.ensure_exists(conn))
        .is_err());
}

#[test]
fn test_project_scoped_versus_workspace_only_queries() {
    let store = test_store();
    store
        .transaction(|tx| {
            add_workspace(tx, "alpha", "Alpha");
            Ok(())
        })
        .unwrap();

    let alpha = DataScope::workspace("alpha").unwrap();
    store
        .transaction(|tx| {
            add_project(tx, &store, &alpha, "proj_a");
            Ok(())
        })
        .unwrap();

    let proj_a_scope = DataScope::new("alpha", Some("proj_a".to_string())).unwrap();

    store.transaction(|tx| {
        // Workspace-only knowledge source (no project id)
        knowledge_source::upsert_from_value_scoped(tx, &store, &alpha, json!({
            "id": "wk1", "connectorId": "local", "kind": "doc", "trust": "trusted", "pinned": 0, "sizeBytes": 10
        }), "now")?;
        // Project-scoped knowledge source (bound to proj_a)
        knowledge_source::upsert_from_value_scoped(tx, &store, &proj_a_scope, json!({
            "id": "pk1", "connectorId": "local", "kind": "doc", "trust": "trusted", "pinned": 0, "sizeBytes": 10
        }), "now")?;
        Ok(())
    }).unwrap();

    // Workspace-level query should NOT return project-scoped row
    let wk_list = store
        .with_conn(|conn| knowledge_source::list_scoped(conn, &store, &alpha))
        .unwrap();
    assert_eq!(wk_list.len(), 1);
    assert_eq!(wk_list[0].id, "wk1");

    // Project-level query should ONLY return project-scoped row
    let pk_list = store
        .with_conn(|conn| knowledge_source::list_scoped(conn, &store, &proj_a_scope))
        .unwrap();
    assert_eq!(pk_list.len(), 1);
    assert_eq!(pk_list[0].id, "pk1");
}

#[test]
fn test_prevention_of_cross_workspace_export() {
    let store = test_store();
    store
        .transaction(|tx| {
            // 'default' workspace (which portable module exports)
            add_workspace(tx, "default", "Default Workspace");
            // 'alpha' workspace
            add_workspace(tx, "alpha", "Alpha Workspace");
            Ok(())
        })
        .unwrap();

    let default_scope = DataScope::workspace("default").unwrap();
    let alpha_scope = DataScope::workspace("alpha").unwrap();

    store
        .transaction(|tx| {
            preferences::upsert_scoped(
                tx,
                &store,
                &default_scope,
                "key1",
                &json!("def-val"),
                "now",
            )?;
            preferences::upsert_scoped(
                tx,
                &store,
                &alpha_scope,
                "key1",
                &json!("alpha-val"),
                "now",
            )?;
            add_project(tx, &store, &default_scope, "default-project");
            add_project(tx, &store, &alpha_scope, "alpha-project");
            for (thread_id, project_id) in [
                ("default-thread", "default-project"),
                ("alpha-thread", "alpha-project"),
            ] {
                let sealed = store.seal_payload(b"{}", &format!("thread:{thread_id}"))?;
                tx.execute(
                    "INSERT INTO thread
                   (id, project_id, created_at, updated_at, payload, payload_nonce)
                 VALUES (?1, ?2, 'now', 'now', ?3, ?4);",
                    rusqlite::params![thread_id, project_id, sealed.ciphertext, sealed.nonce],
                )?;
            }
            Ok(())
        })
        .unwrap();

    // Export workspace (exports 'default')
    let manifest = export_workspace(&store).unwrap();
    let prefs = manifest.sections.preferences;
    assert_eq!(prefs.len(), 1);
    assert_eq!(prefs[0].key, "key1");
    assert_eq!(prefs[0].value, json!("def-val"));
    assert_eq!(manifest.sections.projects.len(), 1);
    assert_eq!(manifest.sections.projects[0].id, "default-project");
    assert_eq!(manifest.sections.threads.len(), 1);
    assert_eq!(manifest.sections.threads[0].id, "default-thread");

    let alpha_manifest = export_workspace_for(&store, "alpha").unwrap();
    assert_eq!(
        alpha_manifest.sections.preferences[0].value,
        json!("alpha-val")
    );
    assert_eq!(alpha_manifest.sections.projects[0].id, "alpha-project");
    assert_eq!(alpha_manifest.sections.threads[0].id, "alpha-thread");
}

#[test]
fn test_import_targets_workspace_and_preserves_project_scope() {
    let source = test_store();
    source
        .transaction(|tx| {
            add_workspace(tx, "alpha", "Alpha");
            let alpha = DataScope::workspace("alpha")?;
            add_project(tx, &source, &alpha, "portable-project");
            let project_scope = DataScope::new("alpha", Some("portable-project".to_string()))?;
            knowledge_source::upsert_from_value_scoped(
                tx,
                &source,
                &project_scope,
                json!({
                    "id": "portable-source",
                    "connectorId": "local",
                    "kind": "doc",
                    "trust": "trusted",
                    "sizeBytes": 1
                }),
                "now",
            )?;
            workflow::upsert_definition(
                tx,
                &source,
                &project_scope,
                "portable-workflow",
                1,
                "now",
                "now",
                &json!({"id": "portable-workflow", "version": 1, "steps": []}),
            )?;
            workflow::upsert_run(
                tx,
                &source,
                &project_scope,
                "portable-run",
                "portable-workflow",
                1,
                "complete",
                "now",
                "now",
                &json!({
                    "id": "portable-run",
                    "definitionId": "portable-workflow",
                    "definitionVersion": 1,
                    "status": "complete"
                }),
            )?;
            scheduled_job::upsert_from_value(
                tx,
                &source,
                "alpha",
                json!({
                    "id": "portable-job",
                    "workspaceId": "alpha",
                    "projectId": "portable-project",
                    "schemaVersion": 1,
                    "name": "Portable job",
                    "workflowDefinitionId": "portable-workflow",
                    "trigger": {"kind": "once"},
                    "missedRunPolicy": "skip",
                    "status": "active",
                    "createdAt": "now",
                    "updatedAt": "now"
                }),
                "now",
            )
        })
        .unwrap();
    let archive = serde_json::to_string(&export_workspace_for(&source, "alpha").unwrap()).unwrap();

    let destination = test_store();
    destination
        .transaction(|tx| {
            add_workspace(tx, "beta", "Beta");
            Ok(())
        })
        .unwrap();
    import_workspace_for(&destination, "beta", &archive, ImportOptions::default()).unwrap();

    let imported_scope = DataScope::new("beta", Some("portable-project".to_string())).unwrap();
    let imported = destination
        .with_conn(|conn| knowledge_source::list_scoped(conn, &destination, &imported_scope))
        .unwrap();
    assert_eq!(imported.len(), 1);
    assert_eq!(imported[0].id, "portable-source");
    let definitions = destination
        .with_conn(|conn| workflow::list_definitions(conn, &destination, &imported_scope))
        .unwrap();
    assert_eq!(definitions.len(), 1);
    let runs = destination
        .with_conn(|conn| workflow::list_runs(conn, &destination, &imported_scope, None))
        .unwrap();
    assert_eq!(runs.len(), 1);
    let jobs = destination
        .with_conn(|conn| scheduled_job::list(conn, &destination, "beta"))
        .unwrap();
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0].value["status"], "paused");
}

// ---------------------------------------------------------------------------
// 2. Migration Safety Tests
// ---------------------------------------------------------------------------

#[test]
fn test_legacy_json_to_encrypted_sqlite_success_and_idempotency() {
    let store = test_store();
    let dir = TempDir::new().unwrap();

    // 1. Write legacy JSON files
    let snapshot_data = json!({
        "activeItem": "item1",
        "voiceEnabled": true,
        "selectedModelId": "gpt-4",
        "permissionMode": "restricted",
        "dismissedApprovalIds": ["id1", "id2"],
        "pinnedSourceIds": ["s1"],
        "schedules": [
            {"id": "sch1", "weekday": "Mon", "time": "09:00", "enabled": true}
        ]
    });
    fs::write(
        dir.path().join("runtime-snapshot.json"),
        serde_json::to_vec(&snapshot_data).unwrap(),
    )
    .unwrap();

    let scheduler_data = json!({
        "schemaVersion": 1,
        "jobs": [
            {
                "id": "job1",
                "status": "active",
                "workflowDefinitionId": "wf1",
                "triggerKind": "recurring",
                "missedRunPolicy": "skip",
                "nextRunAt": "2026-06-30T12:00:00Z",
                "lastRunAt": "",
                "lastRunId": "",
                "createdAt": "2026-06-30T10:00:00Z",
                "updatedAt": "2026-06-30T10:00:00Z",
                "name": "Cron Job",
                "description": "desc",
                "trigger": { "kind": "recurring" },
                "route": {}
            }
        ],
        "queue": [
            {
                "id": "q1",
                "jobId": "job1",
                "runId": "run1",
                "state": "queued",
                "leaseHolder": "",
                "leaseExpiresAt": "",
                "leaseToken": "",
                "deduplicationKey": "dedup1",
                "availableAt": "2026-06-30T12:00:00Z",
                "lastError": "",
                "scheduledAt": "2026-06-30T12:00:00Z",
                "updatedAt": "2026-06-30T12:00:00Z",
                "attemptHistory": [],
                "route": {}
            }
        ]
    });
    fs::write(
        dir.path().join("scheduler-store.json"),
        serde_json::to_vec(&scheduler_data).unwrap(),
    )
    .unwrap();

    // 2. Perform Migration
    crate::store::migrations::migrate_all(&store, dir.path()).unwrap();

    // 3. Assert rows exist in SQLite
    let (active_item, voice_enabled): (String, bool) = store
        .with_conn(|conn| {
            let prefs =
                preferences::get_scoped(conn, &store, &DataScope::legacy_default(), "shell")?
                    .unwrap();
            Ok((
                prefs["activeItem"].as_str().unwrap().to_string(),
                prefs["voiceEnabled"].as_bool().unwrap(),
            ))
        })
        .unwrap();
    assert_eq!(active_item, "item1");
    assert!(voice_enabled);

    let jobs = store
        .with_conn(|conn| scheduled_job::list(conn, &store, "default"))
        .unwrap();
    let queue = store
        .with_conn(|conn| scheduler_queue::list(conn, &store, "default"))
        .unwrap();
    assert_eq!(jobs.len(), 1);
    assert_eq!(queue.len(), 1);
    assert_eq!(jobs[0].id, "job1");
    assert_eq!(queue[0].id, "queue:default:run1");

    // 4. Repeated Migration (Idempotency check)
    crate::store::migrations::migrate_all(&store, dir.path()).unwrap();
    // Count remains 1, no duplicate rows added
    let jobs_post = store
        .with_conn(|conn| scheduled_job::list(conn, &store, "default"))
        .unwrap();
    assert_eq!(jobs_post.len(), 1);

    // 5. Original data retained (not deleted from disk)
    assert!(dir.path().join("runtime-snapshot.json").exists());
    assert!(dir.path().join("scheduler-store.json").exists());
}

#[test]
fn test_migration_tolerates_malformed_json_and_rolls_back_partially_written_source() {
    let store = test_store();
    let dir = TempDir::new().unwrap();

    // Write a malformed file (invalid json)
    fs::write(dir.path().join("runtime-snapshot.json"), b"{malformed").unwrap();

    // Run migration
    crate::store::migrations::migrate_all(&store, dir.path()).unwrap();

    // Verify preferences remained empty (except for default inserts if any)
    let keys = store
        .with_conn(|conn| preferences::keys_scoped(conn, &DataScope::legacy_default()))
        .unwrap();
    assert!(keys.is_empty() || !keys.contains(&"shell".to_string()));

    // Write scheduler store with unsupported version to fail transaction midway
    let invalid_scheduler_data = json!({
        "schemaVersion": 999, // unsupported schema version
        "jobs": [
            { "id": "job_should_not_exist", "status": "active", "createdAt": "now", "updatedAt": "now" }
        ],
        "queue": []
    });
    fs::write(
        dir.path().join("scheduler-store.json"),
        serde_json::to_vec(&invalid_scheduler_data).unwrap(),
    )
    .unwrap();

    // Run migration
    crate::store::migrations::migrate_all(&store, dir.path()).unwrap();

    // Assert that the transaction rolled back and no jobs were saved
    let jobs = store
        .with_conn(|conn| scheduled_job::list(conn, &store, "default"))
        .unwrap();
    assert_eq!(jobs.len(), 0);
}

#[test]
fn test_encryption_at_rest_safety() {
    let store = test_store();
    let scope = DataScope::legacy_default();

    // Insert preferences
    store
        .transaction(|tx| {
            preferences::upsert_scoped(
                tx,
                &store,
                &scope,
                "secret_key",
                &json!({"secret": "super_confidential"}),
                "now",
            )
        })
        .unwrap();

    // Open connection and inspect raw database (ciphertext check)
    let (ciphertext, nonce): (Vec<u8>, Vec<u8>) = store
        .with_conn(|conn| {
            conn.query_row(
                "SELECT payload, payload_nonce FROM preferences WHERE key = 'secret_key';",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(StoreError::from)
        })
        .unwrap();

    // Verify ciphertext is not plaintext
    let cipher_str = String::from_utf8_lossy(&ciphertext);
    assert!(!cipher_str.contains("super_confidential"));

    // Check successful decrypt
    let sealed = crate::store::vault::Sealed {
        ciphertext: ciphertext.clone(),
        nonce: nonce.clone(),
    };
    let opened = store
        .open_payload(&sealed, "preferences:default:secret_key")
        .unwrap();
    let opened_json: Value = serde_json::from_slice(&opened).unwrap();
    assert_eq!(opened_json["secret"], "super_confidential");

    // Check decrypt fails with wrong AAD
    assert!(store
        .open_payload(&sealed, "preferences:default:wrong_key")
        .is_err());
}

// ---------------------------------------------------------------------------
// 3. Export / Import Tests
// ---------------------------------------------------------------------------

#[test]
fn test_export_import_roundtrip_and_validation() {
    let store = test_store();
    store
        .transaction(|tx| {
            add_workspace(tx, "default", "Default");
            Ok(())
        })
        .unwrap();

    let scope = DataScope::workspace("default").unwrap();

    // 1. Populate some records in source DB
    store
        .transaction(|tx| {
            preferences::upsert_scoped(tx, &store, &scope, "pref1", &json!("val1"), "now")?;
            connector_account::upsert_from_value_scoped(
                tx,
                &store,
                &scope,
                json!({
                    "connectorId": "gmail",
                    "status": "connected",
                    "credentialRef": "oauth-token:gmail:ref"
                }),
                "now",
            )?;
            schedule::upsert_from_value_scoped(
                tx,
                &store,
                &scope,
                json!({
                    "id": "sch1", "day": "Mon", "time": "09:00", "enabled": true
                }),
                "now",
            )?;
            Ok(())
        })
        .unwrap();

    // 2. Export manifest
    let manifest = export_workspace(&store).unwrap();
    assert_eq!(
        manifest.sections.preferences.len(),
        1,
        "preferences must contain 1 exported row"
    );
    assert_eq!(
        manifest.sections.connector_accounts.len(),
        1,
        "connector accounts must contain 1 exported row"
    );
    assert_eq!(
        manifest.sections.schedules.len(),
        1,
        "schedules must contain 1 exported row"
    );

    // credentialRef field must not be present in the serialized JSON
    let manifest_json = serde_json::to_string(&manifest).unwrap();
    assert!(!manifest_json.contains("oauth-token:gmail:ref"));

    // 3. Import manifest into fresh DB
    let store2 = test_store();
    store2
        .transaction(|tx| {
            add_workspace(tx, "default", "Default");
            Ok(())
        })
        .unwrap();

    let report = import_workspace(&store2, &manifest_json, ImportOptions::default()).unwrap();
    assert_eq!(report.inserted.get("preferences"), Some(&1));
    assert_eq!(report.inserted.get("connectorAccounts"), Some(&1));
    assert_eq!(report.inserted.get("schedules"), Some(&1));

    // Verify imported values in store2
    let imported_pref = store2
        .with_conn(|conn| preferences::get_scoped(conn, &store2, &scope, "pref1"))
        .unwrap()
        .unwrap();
    assert_eq!(imported_pref, json!("val1"));

    // Imported connector is written 'disconnected' and lacks credential_ref
    let imported_connectors = store2
        .with_conn(|conn| connector_account::list_scoped(conn, &store2, &scope))
        .unwrap();
    assert_eq!(imported_connectors.len(), 1);
    assert_eq!(imported_connectors[0].status, "disconnected");
    assert!(imported_connectors[0].credential_ref.is_empty());

    // Imported schedules are disabled (enabled = false)
    let imported_schedules = store2
        .with_conn(|conn| schedule::list_scoped(conn, &store2, &scope))
        .unwrap();
    assert_eq!(imported_schedules.len(), 1);
    assert!(!imported_schedules[0].enabled);

    // 4. Manifest/Archive Validation Errors
    // Newer formatVersion rejected
    let mut bad_manifest = manifest.clone();
    bad_manifest.format_version = 999;
    let bad_json = serde_json::to_string(&bad_manifest).unwrap();
    assert!(import_workspace(&store2, &bad_json, ImportOptions::default()).is_err());

    // credentialsIncluded: true rejected
    let mut cred_manifest = manifest.clone();
    cred_manifest.credentials_included = true;
    let cred_json = serde_json::to_string(&cred_manifest).unwrap();
    assert!(import_workspace(&store2, &cred_json, ImportOptions::default()).is_err());

    // Credential-shaped data is rejected even if a hand-edited archive lies
    // by keeping credentialsIncluded=false.
    let mut secret_manifest = serde_json::to_value(&manifest).unwrap();
    secret_manifest["sections"]["preferences"][0]["value"] =
        json!({"apiKey": "sk-must-not-import"});
    let secret_json = serde_json::to_string(&secret_manifest).unwrap();
    assert!(import_workspace(&store2, &secret_json, ImportOptions::default()).is_err());
}

#[test]
fn test_import_failure_rolls_back_atomically() {
    let store = test_store();
    store
        .transaction(|tx| {
            add_workspace(tx, "default", "Default Workspace");
            Ok(())
        })
        .unwrap();

    // Create a manifest that violates referential integrity (message points to non-existent thread)
    let bad_manifest = json!({
        "format": PORTABLE_FORMAT_NAME,
        "formatVersion": PORTABLE_FORMAT_VERSION,
        "schemaVersion": 4,
        "exportedAt": "2026-06-30T12:00:00Z",
        "producedBy": "fable-test",
        "credentialsIncluded": false,
        "sections": {
            "preferences": [
                { "key": "pref1", "updatedAt": "now", "value": "val1" }
            ],
            "messages": [
                {
                    "id": "m1",
                    "threadId": "non_existent_thread",
                    "role": "user",
                    "seq": 1,
                    "createdAt": "now",
                    "payload": {}
                }
            ]
        },
        "omitted": {}
    });

    let manifest_json = serde_json::to_string(&bad_manifest).unwrap();
    let result = import_workspace(&store, &manifest_json, ImportOptions::default());
    assert!(result.is_err());

    // Verify preferences remained empty (the whole import was rolled back)
    let prefs = store
        .with_conn(|conn| preferences::keys_scoped(conn, &DataScope::workspace("default").unwrap()))
        .unwrap();
    assert!(prefs.is_empty());
}

// ---------------------------------------------------------------------------
// 4. Data-Loss Prevention Tests
// ---------------------------------------------------------------------------

#[test]
fn test_dlp_workspace_deletion_cascade_isolation() {
    let store = test_store();
    store
        .transaction(|tx| {
            add_workspace(tx, "alpha", "Alpha");
            add_workspace(tx, "beta", "Beta");
            Ok(())
        })
        .unwrap();

    let alpha = DataScope::workspace("alpha").unwrap();
    let beta = DataScope::workspace("beta").unwrap();

    store.transaction(|tx| {
        knowledge_source::upsert_from_value_scoped(tx, &store, &alpha, json!({
            "id": "k1", "connectorId": "local", "kind": "doc", "trust": "trusted", "pinned": 0, "sizeBytes": 10
        }), "now")?;
        knowledge_source::upsert_from_value_scoped(tx, &store, &beta, json!({
            "id": "k2", "connectorId": "local", "kind": "doc", "trust": "trusted", "pinned": 0, "sizeBytes": 10
        }), "now")?;
        Ok(())
    }).unwrap();

    // Delete workspace alpha via direct SQL cascade delete
    store
        .transaction(|tx| {
            tx.execute("DELETE FROM workspace WHERE id='alpha';", [])
                .map_err(StoreError::from)?;
            Ok(())
        })
        .unwrap();

    // Verify alpha knowledge source is deleted
    let alpha_list = store
        .with_conn(|conn| knowledge_source::list_scoped(conn, &store, &alpha))
        .unwrap_or_default();
    assert_eq!(alpha_list.len(), 0);

    // Verify beta knowledge source is untouched
    let beta_list = store
        .with_conn(|conn| knowledge_source::list_scoped(conn, &store, &beta))
        .unwrap();
    assert_eq!(beta_list.len(), 1);
    assert_eq!(beta_list[0].id, "k2");
}

#[test]
fn test_dlp_failed_import_preserves_existing_data() {
    let store = test_store();
    store
        .transaction(|tx| {
            add_workspace(tx, "default", "Default");
            Ok(())
        })
        .unwrap();

    let scope = DataScope::workspace("default").unwrap();

    // Seed existing preference
    store
        .transaction(|tx| {
            preferences::upsert_scoped(
                tx,
                &store,
                &scope,
                "existing_key",
                &json!("pre-import-val"),
                "now",
            )
        })
        .unwrap();

    // Attempt import that fails
    let bad_manifest = json!({
        "format": PORTABLE_FORMAT_NAME,
        "formatVersion": PORTABLE_FORMAT_VERSION,
        "schemaVersion": 4,
        "exportedAt": "now",
        "producedBy": "test",
        "credentialsIncluded": false,
        "sections": {
            "messages": [
                { "id": "m1", "threadId": "dangling", "role": "user", "seq": 1, "createdAt": "now", "payload": {} }
            ]
        },
        "omitted": {}
    });

    let bad_json = serde_json::to_string(&bad_manifest).unwrap();
    let result = import_workspace(&store, &bad_json, ImportOptions::default());
    assert!(result.is_err());

    // Verify existing key is preserved
    let val = store
        .with_conn(|conn| preferences::get_scoped(conn, &store, &scope, "existing_key"))
        .unwrap()
        .unwrap();
    assert_eq!(val, json!("pre-import-val"));
}

#[test]
fn test_dlp_backup_lifecycle_checks() {
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("active.db");

    // Open connection, populate data
    let conn = Connection::open(&db_path).unwrap();
    conn.execute_batch("CREATE TABLE test (id TEXT PRIMARY KEY); INSERT INTO test VALUES ('1');")
        .unwrap();

    // 1. Vacuum backup to new path
    let backup_path = dir.path().join("backup.db");
    conn.execute("VACUUM INTO ?1", [backup_path.to_string_lossy().as_ref()])
        .unwrap();
    assert!(backup_path.exists());

    // Verify backup contains the table and data
    let backup_conn = Connection::open(&backup_path).unwrap();
    let count: i64 = backup_conn
        .query_row("SELECT COUNT(*) FROM test;", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1);

    // 2. Vacuum backup to existing path should fail (standard sqlite behavior is overwrite block or error depending on mode)
    assert!(conn
        .execute("VACUUM INTO ?1", [backup_path.to_string_lossy().as_ref()])
        .is_err());
}
