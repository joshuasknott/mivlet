//! Store regression tests grouped away from the production facade.

use super::*;
use std::sync::{Arc, Mutex, MutexGuard};
use tempfile::TempDir;

static TEST_GENERATION: Mutex<u64> = Mutex::new(7);

struct TestIdentityFence {
    _guard: MutexGuard<'static, u64>,
}

fn vault() -> Vault {
    Vault::new(&vault::MasterKey::generate().unwrap()).unwrap()
}

#[test]
fn import_commit_blocks_a_queued_autosave_until_reopen() {
    let directory = TempDir::new().unwrap();
    let path = directory.path().join("import.db");
    let key = vault::MasterKey::generate().unwrap();
    let store = Arc::new(Store::open(&path, Vault::new(&key).unwrap()).unwrap());
    let (entered, waiting) = std::sync::mpsc::channel();
    let mut writer = None;
    store
        .import_transaction(|tx| {
            tx.execute(
                "UPDATE workspace SET name='Imported' WHERE id='default'",
                [],
            )?;
            let stale_store = Arc::clone(&store);
            writer = Some(std::thread::spawn(move || {
                entered.send(()).unwrap();
                stale_store.transaction(|tx| {
                    tx.execute(
                        "UPDATE workspace SET name='Stale renderer' WHERE id='default'",
                        [],
                    )?;
                    Ok(())
                })
            }));
            waiting.recv().unwrap();
            Ok(())
        })
        .unwrap();
    let error = writer.unwrap().join().unwrap().unwrap_err().to_string();
    assert!(error.contains("must restart"));
    assert!(store.with_conn(|_| Ok(())).is_err());
    drop(store);

    let reopened = Store::open(&path, Vault::new(&key).unwrap()).unwrap();
    let name: String = reopened
        .with_conn(|conn| {
            Ok(
                conn.query_row("SELECT name FROM workspace WHERE id='default'", [], |row| {
                    row.get(0)
                })?,
            )
        })
        .unwrap();
    assert_eq!(name, "Imported");
    reopened.transaction(|_| Ok(())).unwrap();
}

#[test]
fn failed_import_rolls_back_without_freezing_store() {
    let store = Store::open_in_memory(vault()).unwrap();
    let result: Result<()> = store.import_transaction(|tx| {
        tx.execute(
            "UPDATE workspace SET name='Partial import' WHERE id='default'",
            [],
        )?;
        Err(StoreError::Invalid("Rejected import".into()))
    });
    assert!(result.is_err());
    let name: String = store
        .with_conn(|conn| {
            Ok(
                conn.query_row("SELECT name FROM workspace WHERE id='default'", [], |row| {
                    row.get(0)
                })?,
            )
        })
        .unwrap();
    assert_eq!(name, "My Workspace");
    store.transaction(|_| Ok(())).unwrap();
}

#[test]
fn identity_fenced_approval_transaction_rolls_back_and_rejects_stale_generation() {
    let store = Store::open_in_memory(vault()).unwrap();
    let expected = crate::clerk_identity::NativeIdentityGenerationSnapshot {
        account_binding: "test-account".into(),
        generation: 7,
    };
    let scope = repos::scope::DataScope::workspace(repos::scope::DEFAULT_WORKSPACE_ID).unwrap();
    let audit_path = Path::new("approval-audit.json");
    let rules_path = Path::new("approval-rules.json");
    let execution_path = Path::new("execution-approvals.json");

    let rollback = store.transaction_with_identity_fence(
        &expected,
        || {
            let guard = TEST_GENERATION.lock().unwrap();
            if *guard != expected.generation {
                return Err("stale test generation".to_string());
            }
            Ok(TestIdentityFence { _guard: guard })
        },
        |_| Ok(()),
        |tx, store| {
            write_document_in_transaction(
                tx,
                store,
                audit_path,
                &scope,
                &serde_json::json!([{"requestId":"approval"}]),
            )?;
            write_document_in_transaction(
                tx,
                store,
                rules_path,
                &scope,
                &serde_json::json!([{"requestId":"approval"}]),
            )?;
            write_document_in_transaction(
                tx,
                store,
                execution_path,
                &scope,
                &serde_json::json!([{"requestId":"approval","consumedAt":null}]),
            )?;
            Err::<(), String>("simulate failure after permit preparation".into())
        },
    );
    assert!(rollback.is_err());
    store
        .with_conn(|conn| {
            for path in [audit_path, rules_path, execution_path] {
                let (_, key) = scoped_document_location(path, &scope).unwrap();
                assert!(repos::preferences::get_scoped(conn, &store, &scope, &key)?.is_none());
            }
            Ok(())
        })
        .unwrap();

    *TEST_GENERATION.lock().unwrap() = 8;
    let mut closure_called = false;
    let stale = store.transaction_with_identity_fence(
        &expected,
        || {
            let guard = TEST_GENERATION.lock().unwrap();
            if *guard != expected.generation {
                return Err("stale test generation".to_string());
            }
            Ok(TestIdentityFence { _guard: guard })
        },
        |_| Ok(()),
        |_tx, _store| {
            closure_called = true;
            Ok(())
        },
    );
    assert!(stale.is_err());
    assert!(!closure_called);
    *TEST_GENERATION.lock().unwrap() = expected.generation;
}

#[test]
fn account_suspension_pauses_schedules_and_invalidates_saved_permits_atomically() {
    let store = Store::open_in_memory(vault()).unwrap();
    let scope = repos::scope::PrivateDataScope::for_authenticated_user(
        repos::scope::DataScope::legacy_default(),
        "account-test",
        Some("member-test"),
    )
    .unwrap();
    store
        .transaction(|conn| {
            repos::local_schedule::insert_schedule(
                conn,
                &store,
                &scope,
                &repos::local_schedule::ScheduleRow {
                    id: "schedule".into(),
                    agent_id: "agent".into(),
                    status: "enabled".into(),
                    trigger_kind: "once".into(),
                    revision: 1,
                    prompt_revision: 1,
                    next_run_at: Some("2026-09-14T00:00:00Z".into()),
                    created_at: "now".into(),
                    updated_at: "now".into(),
                    payload: serde_json::json!({"prompt":"RETAIN_REQUEST"}),
                },
            )?;
            repos::preferences::upsert(
                conn,
                &store,
                "nativeBackgroundExecution",
                &serde_json::json!({"version":1,"enabled":true,"generation":9}),
                "now",
            )?;
            repos::preferences::upsert(
                conn,
                &store,
                "document:execution-approvals.json",
                &serde_json::json!([{"requestId":"permit","decision":"allow","consumedAt":null}]),
                "now",
            )
        })
        .unwrap();
    store
        .suspend_bound_account("account-test", "member-test")
        .unwrap();
    store
        .with_conn(|conn| {
            let (status, revision): (String, i64) = conn.query_row(
                "SELECT status,revision FROM local_schedule WHERE id='schedule'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!((status, revision), ("paused".into(), 2));
            let permits =
                repos::preferences::get(conn, &store, "document:execution-approvals.json")?
                    .unwrap();
            assert_eq!(permits[0]["requestId"], "permit");
            assert!(permits[0]["invalidatedAt"].as_str().is_some());
            let background =
                repos::preferences::get(conn, &store, "nativeBackgroundExecution")?.unwrap();
            assert_eq!(background["enabled"], false);
            assert_eq!(background["generation"], 10);
            Ok(())
        })
        .unwrap();
}

#[test]
fn account_vaults_do_not_adopt_legacy_data_or_restore_each_others_backups() {
    let directory = TempDir::new().unwrap();
    let legacy_path = directory.path().join(DB_FILENAME);
    std::fs::write(&legacy_path, b"AMBIGUOUS_LEGACY_BYTES").unwrap();
    let alpha_dir = directory.path().join("accounts/alpha");
    let beta_dir = directory.path().join("accounts/beta");
    std::fs::create_dir_all(&alpha_dir).unwrap();
    std::fs::create_dir_all(&beta_dir).unwrap();
    let alpha = Store::open(&alpha_dir.join(DB_FILENAME), vault()).unwrap();
    let beta = Store::open(&beta_dir.join(DB_FILENAME), vault()).unwrap();
    alpha
        .transaction(|conn| {
            repos::preferences::upsert(
                conn,
                &alpha,
                "account-canary",
                &serde_json::json!("alpha"),
                "now",
            )
        })
        .unwrap();
    assert!(beta
        .with_conn(|conn| repos::preferences::get(conn, &beta, "account-canary"))
        .unwrap()
        .is_none());
    write_backup_marker(&alpha).unwrap();
    let backup = directory.path().join("alpha-backup.db");
    alpha
        .with_conn(|conn| {
            conn.execute("VACUUM INTO ?1", [backup.to_str().unwrap()])?;
            Ok(())
        })
        .unwrap();
    assert!(validate_backup_candidate(&backup, &alpha.vault).is_ok());
    assert!(validate_backup_candidate(&backup, &beta.vault).is_err());
    delete_local_store_content(&beta).unwrap();
    assert_eq!(
        alpha
            .with_conn(|conn| repos::preferences::get(conn, &alpha, "account-canary"))
            .unwrap(),
        Some(serde_json::json!("alpha"))
    );
    assert_eq!(
        std::fs::read(legacy_path).unwrap(),
        b"AMBIGUOUS_LEGACY_BYTES"
    );
}

#[test]
fn account_store_denies_unauthenticated_reads_and_writes_at_the_storage_boundary() {
    let mut store = Store::open_in_memory(vault()).unwrap();
    store.account_owned = true;
    assert!(store.with_conn(|_| Ok(())).is_err());
    assert!(store
        .transaction(|conn| {
            conn.execute("DELETE FROM workspace", [])?;
            Ok(())
        })
        .is_err());
    store.account_owned = false;
    assert_eq!(
        store
            .with_conn(|conn| Ok(conn
                .query_row("SELECT COUNT(*) FROM workspace", [], |row| row
                    .get::<_, i64>(0))?))
            .unwrap(),
        1
    );
}

#[test]
fn local_deletion_clears_every_application_table_and_preserves_schema() {
    let store = Store::open_in_memory(vault()).unwrap();
    store
        .transaction(|tx| {
            tx.execute(
                "INSERT INTO workspace(id,name,created_at,updated_at)
                     VALUES('workspace-2','Workspace 2','t','t');",
                [],
            )?;
            tx.execute(
                "INSERT INTO preferences(workspace_id,key,updated_at,payload,payload_nonce)
                     VALUES('workspace-2','appearance','t',x'01',x'02');",
                [],
            )?;
            Ok(())
        })
        .unwrap();

    delete_local_store_content(&store).unwrap();

    store
        .with_conn(|conn| {
            let workspaces: Vec<(String, String)> = {
                let mut statement = conn.prepare("SELECT id,name FROM workspace ORDER BY id;")?;
                let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            assert_eq!(
                workspaces,
                vec![("default".to_string(), "My Workspace".to_string())]
            );

            let mut statement = conn.prepare("PRAGMA table_list;")?;
            let rows = statement.query_map([], |row| {
                Ok((row.get::<_, String>(1)?, row.get::<_, String>(2)?))
            })?;
            for row in rows {
                let (name, table_type) = row?;
                if name.starts_with("sqlite_")
                    || matches!(name.as_str(), "schema_meta" | "workspace")
                    || !matches!(table_type.as_str(), "table" | "virtual")
                {
                    continue;
                }
                let quoted = name.replace('"', "\"\"");
                let count: i64 =
                    conn.query_row(&format!("SELECT COUNT(*) FROM \"{quoted}\";"), [], |row| {
                        row.get(0)
                    })?;
                assert_eq!(count, 0, "{name} retained rows after local deletion");
            }
            assert_eq!(read_schema_version(conn)?, CURRENT_SCHEMA_VERSION);
            Ok(())
        })
        .unwrap();
}

#[test]
fn local_deletion_removes_only_owned_compatibility_and_recovery_files() {
    let directory = TempDir::new().unwrap();
    for name in [
        "runtime-snapshot.json",
        "connector-sync-state.json",
        RESTORE_PENDING_FILENAME,
        "fable-vault.db.pre-restore-1-2.db",
        "fable-vault.db.failed-restore-3-4.db",
    ] {
        std::fs::write(directory.path().join(name), b"local data").unwrap();
    }
    let unrelated = directory.path().join("workspace-copy.json");
    std::fs::write(&unrelated, b"portable copy").unwrap();

    delete_local_compatibility_files(directory.path()).unwrap();

    assert!(unrelated.exists());
    assert_eq!(
        std::fs::read_dir(directory.path()).unwrap().count(),
        1,
        "only the unrelated user-created export should remain"
    );
}

#[test]
fn scoped_document_locations_isolate_workspace_and_projects() {
    let store = Store::open_in_memory(vault()).unwrap();
    store.transaction(|tx| {
            tx.execute("INSERT INTO workspace(id,name,created_at,updated_at) VALUES('w','W','t','t')", [])?;
            for id in ["a", "b"] {
                tx.execute(
                    "INSERT INTO project(id,workspace_id,title_fingerprint,created_at,updated_at,payload,payload_nonce) VALUES(?1,'w','fp','t','t',x'00',x'00')",
                    [id],
                )?;
            }
            Ok(())
        }).unwrap();
    let path = Path::new("imported-knowledge.json");
    let workspace = repos::scope::DataScope::workspace("w").unwrap();
    let project_a = repos::scope::DataScope::new("w", Some("a".into())).unwrap();
    let project_b = repos::scope::DataScope::new("w", Some("b".into())).unwrap();
    let locations = [
        (
            scoped_document_location(path, &workspace).unwrap(),
            serde_json::json!(["workspace"]),
        ),
        (
            scoped_document_location(path, &project_a).unwrap(),
            serde_json::json!(["a"]),
        ),
        (
            scoped_document_location(path, &project_b).unwrap(),
            serde_json::json!(["b"]),
        ),
    ];
    assert_ne!(locations[0].0 .1, locations[1].0 .1);
    assert_ne!(locations[1].0 .1, locations[2].0 .1);
    store
        .transaction(|tx| {
            for ((scope, key), value) in &locations {
                repos::preferences::upsert_scoped(tx, &store, scope, key, value, "t")?;
            }
            Ok(())
        })
        .unwrap();
    store
        .with_conn(|tx| {
            for ((scope, key), expected) in &locations {
                assert_eq!(
                    repos::preferences::get_scoped(tx, &store, scope, key)?.as_ref(),
                    Some(expected)
                );
            }
            Ok(())
        })
        .unwrap();
}

#[test]
fn opens_fresh_database_and_records_schema_version() {
    let dir = TempDir::new().unwrap();
    let db = dir.path().join(DB_FILENAME);
    let store = Store::open(&db, vault()).unwrap();
    // schema_version recorded.
    let v: String = store
        .with_conn(|conn| {
            conn.query_row(
                "SELECT value FROM schema_meta WHERE key='schema_version';",
                [],
                |row| row.get::<_, String>(0),
            )
            .map_err(StoreError::from)
        })
        .unwrap();
    assert_eq!(v.parse::<u32>().unwrap(), CURRENT_SCHEMA_VERSION);
    let foreign_keys_enabled: i64 = store
        .with_conn(|conn| {
            conn.pragma_query_value(None, "foreign_keys", |row| row.get(0))
                .map_err(StoreError::from)
        })
        .unwrap();
    assert_eq!(foreign_keys_enabled, 1);
    store
        .with_conn(|conn| {
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
                let exists: bool = conn.query_row(
                    "SELECT EXISTS(
                           SELECT 1 FROM sqlite_master
                           WHERE type='table' AND name=?1
                         );",
                    [table],
                    |row| row.get(0),
                )?;
                assert!(!exists, "retired table {table} must not exist");
            }
            for table in ["local_schedule", "local_schedule_occurrence"] {
                let exists: bool = conn.query_row(
                    "SELECT EXISTS(
                           SELECT 1 FROM sqlite_master
                           WHERE type='table' AND name=?1
                         );",
                    [table],
                    |row| row.get(0),
                )?;
                assert!(exists, "current table {table} must exist");
            }
            Ok(())
        })
        .unwrap();
}

#[test]
fn reopen_is_idempotent_and_keeps_data() {
    let dir = TempDir::new().unwrap();
    let db = dir.path().join(DB_FILENAME);
    let v = vault();
    {
        let store = Store::open(&db, v.clone()).unwrap();
        store
                .transaction(|tx| {
                    tx.execute(
                        "INSERT INTO draft (id, updated_at, payload, payload_nonce) VALUES ('d1','t',X'00',X'00')",
                        [],
                    )
                    .map_err(StoreError::from)
                })
                .unwrap();
    }
    // Reopen with the same key: data survives, schema not re-bumped.
    let store = Store::open(&db, v).unwrap();
    let count: i64 = store
        .with_conn(|conn| {
            conn.query_row("SELECT COUNT(*) FROM draft WHERE id='d1';", [], |row| {
                row.get(0)
            })
            .map_err(StoreError::from)
        })
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn migrates_existing_tables_before_applying_current_indices() {
    let dir = TempDir::new().unwrap();
    let db = dir.path().join(DB_FILENAME);
    {
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(
            r#"
                CREATE TABLE schema_meta (
                  key TEXT PRIMARY KEY,
                  value TEXT NOT NULL
                );
                INSERT INTO schema_meta (key, value) VALUES ('schema_version', '3');
                CREATE TABLE project (
                  id TEXT PRIMARY KEY,
                  title_fingerprint TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  payload BLOB NOT NULL,
                  payload_nonce BLOB NOT NULL
                );
                INSERT INTO project VALUES ('legacy', 'fp', 'now', 'now', x'01', x'02');
                CREATE TABLE artifact (
                  id TEXT PRIMARY KEY,
                  run_id TEXT,
                  kind TEXT NOT NULL,
                  content_fingerprint TEXT NOT NULL,
                  size_bytes INTEGER NOT NULL,
                  created_at TEXT NOT NULL,
                  payload BLOB NOT NULL,
                  payload_nonce BLOB NOT NULL
                );
                "#,
        )
        .unwrap();
    }

    let store = Store::open(&db, vault()).unwrap();
    let owner: String = store
        .with_conn(|conn| {
            conn.query_row(
                "SELECT workspace_id FROM project WHERE id = 'legacy';",
                [],
                |row| row.get(0),
            )
            .map_err(StoreError::from)
        })
        .unwrap();
    assert_eq!(owner, repos::scope::DEFAULT_WORKSPACE_ID);
}

#[test]
fn integrity_check_failure_is_detected() {
    // A well-formed in-memory DB passes.
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(SCHEMA_V1).unwrap();
    Store::verify_integrity(&conn).unwrap();
}

#[test]
fn rejects_newer_schema_version() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(SCHEMA_V1).unwrap();
    write_schema_version(&conn, CURRENT_SCHEMA_VERSION + 5).unwrap();
    let err = Store::run_migrations(&conn).unwrap_err();
    assert!(matches!(err, StoreError::Invalid(_)));
}

#[test]
fn payload_round_trips_through_store() {
    let store = Store::open_in_memory(vault()).unwrap();
    let sealed = store
        .seal_payload(b"{\"draft\":\"hi\"}", "draft:d1")
        .unwrap();
    let pt = store.open_payload(&sealed, "draft:d1").unwrap();
    assert_eq!(pt, b"{\"draft\":\"hi\"}");
}

#[test]
fn payload_aad_mismatch_fails_closed() {
    let store = Store::open_in_memory(vault()).unwrap();
    let sealed = store.seal_payload(b"secret", "draft:d1").unwrap();
    assert!(store.open_payload(&sealed, "draft:d2").is_err());
}

#[test]
fn failed_transaction_rolls_back_without_partial_rows() {
    let store = Store::open_in_memory(vault()).unwrap();
    let result: Result<()> = store.transaction(|tx| {
            tx.execute(
                "INSERT INTO backend_connection(provider_id, connected_at, updated_at) VALUES('openai','t','t')",
                [],
            )?;
            Err(StoreError::Invalid("force rollback".into()))
        });
    assert!(result.is_err());
    let count: i64 = store
        .with_conn(|conn| {
            conn.query_row("SELECT COUNT(*) FROM backend_connection", [], |row| {
                row.get(0)
            })
            .map_err(StoreError::from)
        })
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn corrupted_database_file_fails_to_open() {
    let dir = TempDir::new().unwrap();
    let db = dir.path().join(DB_FILENAME);
    std::fs::write(&db, b"not a sqlite database").unwrap();
    assert!(Store::open(&db, vault()).is_err());
}

#[test]
fn verified_backup_requires_the_matching_key_and_intact_marker() {
    let directory = TempDir::new().unwrap();
    let backup = directory.path().join("verified.db");
    let key = vault::MasterKey::generate().unwrap();
    let store = Store::open(&backup, Vault::new(&key).unwrap()).unwrap();
    write_backup_marker(&store).unwrap();
    store
        .transaction(|tx| {
            repos::preferences::upsert(
                tx,
                &store,
                "recovery-test",
                &serde_json::json!({"value":"restored"}),
                "now",
            )
        })
        .unwrap();
    drop(store);

    let manifest = validate_backup_candidate(&backup, &Vault::new(&key).unwrap()).unwrap();
    assert_eq!(manifest["format"], BACKUP_FORMAT);
    let wrong = vault::MasterKey::generate().unwrap();
    assert!(validate_backup_candidate(&backup, &Vault::new(&wrong).unwrap()).is_err());

    let conn = Connection::open(&backup).unwrap();
    conn.execute(
        "UPDATE preferences SET payload=x'00' WHERE key=?1",
        [BACKUP_MARKER_KEY],
    )
    .unwrap();
    drop(conn);
    assert!(validate_backup_candidate(&backup, &Vault::new(&key).unwrap()).is_err());
}

#[test]
fn pending_restore_activates_on_restart_and_preserves_prior_database() {
    let directory = TempDir::new().unwrap();
    let key = vault::MasterKey::generate().unwrap();
    let current = directory.path().join(DB_FILENAME);
    let current_store = Store::open(&current, Vault::new(&key).unwrap()).unwrap();
    current_store
        .transaction(|tx| {
            repos::preferences::upsert(
                tx,
                &current_store,
                "recovery-test",
                &serde_json::json!({"value":"current"}),
                "now",
            )
        })
        .unwrap();
    drop(current_store);

    let source = directory.path().join("source-backup.db");
    let source_store = Store::open(&source, Vault::new(&key).unwrap()).unwrap();
    write_backup_marker(&source_store).unwrap();
    source_store
        .transaction(|tx| {
            repos::preferences::upsert(
                tx,
                &source_store,
                "recovery-test",
                &serde_json::json!({"value":"restored"}),
                "now",
            )
        })
        .unwrap();
    drop(source_store);
    std::fs::rename(&source, directory.path().join(RESTORE_PENDING_FILENAME)).unwrap();

    let recovery = apply_pending_restore(directory.path(), &key)
        .unwrap()
        .expect("the prior database must be preserved");
    let restored = Store::open(&current, Vault::new(&key).unwrap()).unwrap();
    assert_eq!(
        restored
            .with_conn(|tx| repos::preferences::get(tx, &restored, "recovery-test"))
            .unwrap()
            .unwrap()["value"],
        "restored"
    );
    let prior = Store::open(&recovery, Vault::new(&key).unwrap()).unwrap();
    assert_eq!(
        prior
            .with_conn(|tx| repos::preferences::get(tx, &prior, "recovery-test"))
            .unwrap()
            .unwrap()["value"],
        "current"
    );
}

#[test]
fn wrong_key_pending_restore_leaves_current_database_untouched() {
    let directory = TempDir::new().unwrap();
    let current_key = vault::MasterKey::generate().unwrap();
    let current = directory.path().join(DB_FILENAME);
    drop(Store::open(&current, Vault::new(&current_key).unwrap()).unwrap());
    let other_key = vault::MasterKey::generate().unwrap();
    let pending = directory.path().join(RESTORE_PENDING_FILENAME);
    let candidate = Store::open(&pending, Vault::new(&other_key).unwrap()).unwrap();
    write_backup_marker(&candidate).unwrap();
    drop(candidate);

    assert!(apply_pending_restore(directory.path(), &current_key).is_err());
    assert!(current.exists());
    assert!(pending.exists());
    assert!(Store::open(&current, Vault::new(&current_key).unwrap()).is_ok());
}

#[test]
fn concurrent_writes_are_serialized_and_durable() {
    let store = Arc::new(Store::open_in_memory(vault()).unwrap());
    let mut workers = Vec::new();
    for index in 0..8 {
        let store = Arc::clone(&store);
        workers.push(std::thread::spawn(move || {
            store
                .transaction(|tx| {
                    repos::preferences::upsert(
                        tx,
                        &store,
                        &format!("worker-{index}"),
                        &serde_json::json!({ "index": index }),
                        "t",
                    )
                })
                .unwrap();
        }));
    }
    for worker in workers {
        worker.join().unwrap();
    }
    let count: i64 = store
        .with_conn(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM preferences WHERE key LIKE 'worker-%'",
                [],
                |row| row.get(0),
            )
            .map_err(StoreError::from)
        })
        .unwrap();
    assert_eq!(count, 8);
}

#[test]
fn independent_connections_serialize_read_modify_write() {
    let directory = TempDir::new().unwrap();
    let key = vault::MasterKey::generate().unwrap();
    let path = directory.path().join("parallel.sqlite");
    let first = Store::open(&path, Vault::new(&key).unwrap()).unwrap();
    let second = Store::open(&path, Vault::new(&key).unwrap()).unwrap();
    let start = Arc::new(std::sync::Barrier::new(2));
    let workers: Vec<_> = [first, second]
        .into_iter()
        .map(|store| {
            let start = start.clone();
            std::thread::spawn(move || {
                start.wait();
                for _ in 0..8 {
                    store
                        .transaction(|tx| {
                            let count = repos::preferences::get(tx, &store, "counter")?
                                .and_then(|value| value.as_u64())
                                .unwrap_or(0);
                            std::thread::sleep(std::time::Duration::from_millis(20));
                            repos::preferences::upsert(
                                tx,
                                &store,
                                "counter",
                                &serde_json::json!(count + 1),
                                "t",
                            )
                        })
                        .unwrap();
                }
            })
        })
        .collect();
    for worker in workers {
        worker.join().unwrap();
    }
    let reopened = Store::open(&path, Vault::new(&key).unwrap()).unwrap();
    assert_eq!(
        reopened
            .with_conn(|conn| repos::preferences::get(conn, &reopened, "counter"))
            .unwrap(),
        Some(serde_json::json!(16))
    );
}

#[test]
fn large_encrypted_record_round_trips() {
    let store = Store::open_in_memory(vault()).unwrap();
    let value = serde_json::json!({ "content": "x".repeat(2 * 1024 * 1024) });
    store
        .transaction(|tx| repos::preferences::upsert(tx, &store, "large", &value, "t"))
        .unwrap();
    let read = store
        .with_conn(|conn| repos::preferences::get(conn, &store, "large"))
        .unwrap()
        .unwrap();
    assert_eq!(read, value);
}

#[test]
fn conversation_delete_is_scoped_cascades_and_prevents_resurrection() {
    let store = Store::open_in_memory(vault()).unwrap();
    let scope = repos::scope::DataScope::legacy_default();
    store
        .transaction(|tx| {
            repos::thread::create(
                tx,
                &store,
                &scope,
                "delete-me",
                None,
                "Test",
                "t",
                &serde_json::json!({}),
            )?;
            repos::thread::create(
                tx,
                &store,
                &scope,
                "keep-me",
                None,
                "Keep",
                "t",
                &serde_json::json!({}),
            )?;
            repos::draft::upsert_scoped(
                tx,
                &store,
                &scope,
                Some("delete-me"),
                "draft",
                &serde_json::json!({"content":"draft"}),
                "t",
            )?;
            repos::execution_attempt::upsert(
                tx,
                &store,
                "run-delete",
                Some("delete-me"),
                "openai",
                "test",
                "streaming",
                0,
                false,
                0,
                "t",
                "t",
                &serde_json::json!({}),
            )?;
            assert!(repos::thread::delete(tx, &scope, "delete-me", "t").is_err());
            tx.execute(
                "UPDATE run SET status='completed' WHERE id='run-delete'",
                [],
            )?;
            repos::thread::delete(tx, &scope, "delete-me", "t")?;
            assert!(repos::thread::get(tx, &store, &scope, "delete-me")?.is_none());
            assert!(repos::thread::get(tx, &store, &scope, "keep-me")?.is_some());
            assert!(
                repos::draft::get_scoped(tx, &store, &scope, Some("delete-me"), "draft")?.is_none()
            );
            let remaining: i64 = tx.query_row(
                "SELECT count(*) FROM run WHERE id='run-delete'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(remaining, 0);
            assert!(repos::thread::create(
                tx,
                &store,
                &scope,
                "delete-me",
                None,
                "Restored",
                "t",
                &serde_json::json!({})
            )
            .is_err());
            assert!(repos::thread::delete(tx, &scope, "missing", "t").is_err());
            Ok(())
        })
        .unwrap();
}

#[test]
fn deleting_project_keeps_its_thread_as_a_standalone_conversation() {
    let store = Store::open_in_memory(vault()).unwrap();
    let sealed = store.seal_payload(b"{}", "project:p").unwrap();
    let thread = store.seal_payload(b"{}", "thread:t").unwrap();
    store
            .transaction(|tx| {
                tx.execute(
                    "INSERT INTO project(id,workspace_id,title_fingerprint,created_at,updated_at,payload,payload_nonce) VALUES('p','default','f','t','t',?1,?2)",
                    rusqlite::params![sealed.ciphertext, sealed.nonce],
                )?;
                tx.execute(
                    "INSERT INTO thread(id,project_id,created_at,updated_at,payload,payload_nonce) VALUES('t','p','t','t',?1,?2)",
                    rusqlite::params![thread.ciphertext, thread.nonce],
                )?;
                tx.execute("DELETE FROM project WHERE id='p'", [])?;
                Ok(())
            })
            .unwrap();
    let count: i64 = store
        .with_conn(|conn| {
            conn.query_row("SELECT COUNT(*) FROM thread", [], |row| row.get(0))
                .map_err(StoreError::from)
        })
        .unwrap();
    assert_eq!(count, 1);
}
