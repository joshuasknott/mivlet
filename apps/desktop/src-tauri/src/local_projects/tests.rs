use super::*;
use crate::store::repos::knowledge_source;
use crate::store::repos::scope::{DataScope, PrivateDataScope};
use crate::store::vault::{MasterKey, Vault};

fn store_and_scope() -> (Store, AuthorizedCommandScope) {
    let store =
        Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap();
    let data = DataScope::workspace("workspace-1").unwrap();
    store
        .with_conn(|tx| {
            tx.execute(
                "INSERT INTO workspace(id,name,created_at,updated_at)
                     VALUES('workspace-1','Workspace','now','now')",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    let private =
        PrivateDataScope::for_authenticated_user(data.clone(), "user-1", Some("member-1")).unwrap();
    (
        store,
        AuthorizedCommandScope {
            data,
            private,
            internal_user_id: "user-1".into(),
            member_id: Some("member-1".into()),
        },
    )
}

fn source(store: &Store, scope: &AuthorizedCommandScope, id: &str) {
    store
        .transaction(|tx| {
            knowledge_source::upsert_private(
                tx,
                store,
                &scope.private,
                serde_json::json!({
                    "id": id,
                    "title": "Source",
                    "kind": "document",
                    "trust": "untrusted",
                    "contentFingerprint": "fingerprint",
                    "sizeBytes": 10,
                    "origin": "local-import"
                }),
                "now",
            )
        })
        .unwrap();
}

fn create_request() -> CreateLocalProjectRequest {
    CreateLocalProjectRequest {
        workspace_id: "workspace-1".into(),
        id: "project-1".into(),
        thread_id: "project-thread-1".into(),
        name: "Launch room".into(),
        instructions: "Keep claims sourced.".into(),
        knowledge_source_ids: vec!["source-1".into()],
    }
}

#[test]
fn creates_encrypted_private_project_with_an_owned_source_and_thread() {
    let (store, scope) = store_and_scope();
    source(&store, &scope, "source-1");
    let project = store
        .transaction(|tx| create_at(tx, &store, &scope, create_request(), "2026-09-07T12:00:00Z"))
        .unwrap();
    assert_eq!(project.name, "Launch room");
    assert_eq!(project.knowledge_source_ids, vec!["source-1"]);
    store
        .with_conn(|tx| {
            let (owner, payload): (String, Vec<u8>) = tx.query_row(
                "SELECT owner_subject,payload FROM local_project WHERE id='project-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(owner, "member:member-1");
            assert!(!String::from_utf8_lossy(&payload).contains("Keep claims sourced"));
            assert!(thread_is_owned(tx, &scope, "project-thread-1")?);
            Ok(())
        })
        .unwrap();
}

#[test]
fn rejects_foreign_or_stale_sources_and_exact_revision_conflicts() {
    let (store, scope) = store_and_scope();
    source(&store, &scope, "source-1");
    store
        .transaction(|tx| create_at(tx, &store, &scope, create_request(), "2026-09-07T12:00:00Z"))
        .unwrap();
    let updated = store
        .transaction(|tx| {
            update_at(
                tx,
                &store,
                &scope,
                UpdateLocalProjectRequest {
                    workspace_id: "workspace-1".into(),
                    id: "project-1".into(),
                    expected_revision: 1,
                    name: "Launch room revised".into(),
                    instructions: "Use primary sources.".into(),
                    knowledge_source_ids: vec!["source-1".into()],
                },
                "2026-09-07T12:01:00Z",
            )
        })
        .unwrap();
    assert_eq!(updated.revision, 2);
    assert!(store
        .transaction(|tx| {
            update_at(
                tx,
                &store,
                &scope,
                UpdateLocalProjectRequest {
                    workspace_id: "workspace-1".into(),
                    id: "project-1".into(),
                    expected_revision: 1,
                    name: "Stale".into(),
                    instructions: String::new(),
                    knowledge_source_ids: vec![],
                },
                "2026-09-07T12:02:00Z",
            )
        })
        .is_err());
    let mut foreign = create_request();
    foreign.id = "project-foreign-source".into();
    foreign.thread_id = "thread-foreign-source".into();
    foreign.knowledge_source_ids = vec!["missing-or-foreign".into()];
    assert!(store
        .transaction(|tx| create_at(tx, &store, &scope, foreign, "now"))
        .is_err());
}

#[test]
fn binds_exact_queued_run_author_once_and_archive_blocks_new_work() {
    let (store, scope) = store_and_scope();
    source(&store, &scope, "source-1");
    let project = store
        .transaction(|tx| create_at(tx, &store, &scope, create_request(), "2026-09-07T12:00:00Z"))
        .unwrap();
    store
        .transaction(|tx| {
            execution_attempt::upsert_scoped(
                tx,
                &store,
                &scope.data,
                "run-1",
                Some(&project.thread_id),
                "codex",
                "gpt",
                "queued",
                0,
                true,
                0,
                "2026-09-07T12:00:01Z",
                "2026-09-07T12:00:01Z",
                &serde_json::json!({"transcript":"","pendingApprovalIds":[]}),
            )
        })
        .unwrap();
    let request = BindLocalProjectRunAuthorRequest {
        workspace_id: "workspace-1".into(),
        project_id: project.id.clone(),
        expected_revision: project.revision,
        run_id: "run-1".into(),
        agent_id: "agent-research".into(),
        thread_id: project.thread_id.clone(),
    };
    let author = store
        .transaction(|tx| {
            bind_author_at(
                tx,
                &store,
                &scope,
                request,
                "Research agent",
                "2026-09-07T12:00:02Z",
            )
        })
        .unwrap();
    assert_eq!(author.agent_name, "Research agent");
    assert_eq!(
        store
            .with_conn(|tx| repo::list_run_authors(tx, &store, &scope.private, &project.id, 10))
            .unwrap()
            .len(),
        1
    );

    store
        .transaction(|tx| {
            execution_attempt::upsert_scoped(
                tx,
                &store,
                &scope.data,
                "run-stale-source",
                Some(&project.thread_id),
                "codex",
                "gpt",
                "queued",
                0,
                true,
                0,
                "2026-09-07T12:00:03Z",
                "2026-09-07T12:00:03Z",
                &serde_json::json!({"transcript":"","pendingApprovalIds":[]}),
            )?;
            knowledge_source::delete_private(tx, &scope.private, "source-1")
        })
        .unwrap();
    assert!(store
        .transaction(|tx| {
            bind_author_at(
                tx,
                &store,
                &scope,
                BindLocalProjectRunAuthorRequest {
                    workspace_id: "workspace-1".into(),
                    project_id: project.id.clone(),
                    expected_revision: project.revision,
                    run_id: "run-stale-source".into(),
                    agent_id: "agent-research".into(),
                    thread_id: project.thread_id.clone(),
                },
                "Research agent",
                "2026-09-07T12:00:04Z",
            )
        })
        .is_err());

    let archived = store
        .transaction(|tx| {
            archive_at(
                tx,
                &store,
                &scope,
                ArchiveLocalProjectRequest {
                    workspace_id: "workspace-1".into(),
                    id: project.id.clone(),
                    expected_revision: project.revision,
                },
                "2026-09-07T12:01:00Z",
            )
        })
        .unwrap();
    assert!(archived.archived_at.is_some());
    store
        .transaction(|tx| {
            execution_attempt::upsert_scoped(
                tx,
                &store,
                &scope.data,
                "run-2",
                Some(&project.thread_id),
                "codex",
                "gpt",
                "queued",
                0,
                true,
                0,
                "2026-09-07T12:01:01Z",
                "2026-09-07T12:01:01Z",
                &serde_json::json!({"transcript":"","pendingApprovalIds":[]}),
            )
        })
        .unwrap();
    assert!(store
        .transaction(|tx| {
            bind_author_at(
                tx,
                &store,
                &scope,
                BindLocalProjectRunAuthorRequest {
                    workspace_id: "workspace-1".into(),
                    project_id: archived.id.clone(),
                    expected_revision: archived.revision,
                    run_id: "run-2".into(),
                    agent_id: "agent-research".into(),
                    thread_id: archived.thread_id.clone(),
                },
                "Research agent",
                "2026-09-07T12:01:02Z",
            )
        })
        .is_err());
}

fn share_request(
    project_id: &str,
    expected_revision: i64,
    mode: &str,
    kind: &str,
    id: &str,
    recipient: ProjectShareRecipient,
    owner: ProjectShareOwner,
    snapshot_text: Option<&str>,
) -> AddProjectShareRequest {
    AddProjectShareRequest {
        workspace_id: "workspace-1".into(),
        project_id: project_id.into(),
        expected_revision,
        share: AddProjectShare {
            mode: mode.into(),
            source: ProjectShareSource {
                workspace_id: "workspace-1".into(),
                kind: kind.into(),
                id: id.into(),
            },
            source_revision: "rev-7".into(),
            recipient,
            owner,
            title: "Shared context".into(),
            snapshot_text: snapshot_text.map(str::to_string),
        },
    }
}

#[test]
fn shares_record_recipient_ownership_and_snapshot_or_reference_semantics() {
    let (store, scope) = store_and_scope();
    source(&store, &scope, "source-1");
    let project = store
        .transaction(|tx| create_at(tx, &store, &scope, create_request(), "2026-09-07T12:00:00Z"))
        .unwrap();
    store
        .transaction(|tx| {
            collab::put(
                tx,
                &store,
                &scope.private,
                Kind::Team,
                "project-1",
                None,
                Some("project-1"),
                &Team {
                    project_id: "project-1".into(),
                    lead_agent_id: None,
                    participant_ids: vec!["agent-research".into(), "agent-writer".into()],
                    revision: 1,
                },
            )
        })
        .unwrap();
    let snapshot = store
        .transaction(|tx| {
            add_share_at(
                tx,
                &store,
                &scope,
                share_request(
                    "project-1",
                    project.revision,
                    "snapshot",
                    "file",
                    "source-1",
                    ProjectShareRecipient {
                        kind: "agent".into(),
                        id: "agent-writer".into(),
                    },
                    ProjectShareOwner {
                        kind: "agent".into(),
                        id: Some("agent-research".into()),
                        name: "Research".into(),
                    },
                    Some("frozen bytes"),
                ),
                "2026-09-07T12:01:00Z",
            )
        })
        .unwrap();
    assert_eq!(snapshot.shares.len(), 1);
    assert_eq!(snapshot.shares[0].mode, "snapshot");
    assert_eq!(snapshot.shares[0].recipient.id, "agent-writer");
    assert_eq!(
        snapshot.shares[0].owner.id.as_deref(),
        Some("agent-research")
    );
    assert_eq!(
        snapshot.shares[0].snapshot_text.as_deref(),
        Some("frozen bytes")
    );

    let referenced = store
        .transaction(|tx| {
            add_share_at(
                tx,
                &store,
                &scope,
                share_request(
                    "project-1",
                    snapshot.revision,
                    "live-reference",
                    "conversation",
                    "project-thread-1",
                    ProjectShareRecipient {
                        kind: "project".into(),
                        id: "project-1".into(),
                    },
                    ProjectShareOwner {
                        kind: "user".into(),
                        id: None,
                        name: "You".into(),
                    },
                    None,
                ),
                "2026-09-07T12:02:00Z",
            )
        })
        .unwrap();
    assert_eq!(referenced.shares.len(), 2);
    assert!(referenced.shares[1].snapshot_text.is_none());

    // Repeating an identical explicit share is idempotent.
    let repeated = store
        .transaction(|tx| {
            add_share_at(
                tx,
                &store,
                &scope,
                share_request(
                    "project-1",
                    referenced.revision,
                    "snapshot",
                    "file",
                    "source-1",
                    ProjectShareRecipient {
                        kind: "agent".into(),
                        id: "agent-writer".into(),
                    },
                    ProjectShareOwner {
                        kind: "agent".into(),
                        id: Some("agent-research".into()),
                        name: "Research".into(),
                    },
                    Some("frozen bytes"),
                ),
                "2026-09-07T12:03:00Z",
            )
        })
        .unwrap();
    assert_eq!(repeated.revision, referenced.revision);
    assert_eq!(repeated.shares.len(), 2);

    // Foreign recipients, live-reference bytes and stale revisions fail closed.
    assert!(store
        .transaction(|tx| {
            add_share_at(
                tx,
                &store,
                &scope,
                share_request(
                    "project-1",
                    repeated.revision,
                    "snapshot",
                    "file",
                    "source-1",
                    ProjectShareRecipient {
                        kind: "agent".into(),
                        id: "agent-stranger".into(),
                    },
                    ProjectShareOwner {
                        kind: "user".into(),
                        id: None,
                        name: "You".into(),
                    },
                    Some("frozen"),
                ),
                "2026-09-07T12:04:00Z",
            )
        })
        .is_err());
    assert!(store
        .transaction(|tx| {
            add_share_at(
                tx,
                &store,
                &scope,
                share_request(
                    "project-1",
                    repeated.revision,
                    "live-reference",
                    "file",
                    "source-1",
                    ProjectShareRecipient {
                        kind: "project".into(),
                        id: "project-1".into(),
                    },
                    ProjectShareOwner {
                        kind: "user".into(),
                        id: None,
                        name: "You".into(),
                    },
                    Some("copied anyway"),
                ),
                "2026-09-07T12:04:00Z",
            )
        })
        .is_err());
    assert!(store
        .transaction(|tx| {
            add_share_at(
                tx,
                &store,
                &scope,
                share_request(
                    "project-1",
                    repeated.revision - 1,
                    "snapshot",
                    "file",
                    "source-1",
                    ProjectShareRecipient {
                        kind: "project".into(),
                        id: "project-1".into(),
                    },
                    ProjectShareOwner {
                        kind: "user".into(),
                        id: None,
                        name: "You".into(),
                    },
                    Some("stale"),
                ),
                "2026-09-07T12:04:00Z",
            )
        })
        .is_err());

    let removed = store
        .transaction(|tx| {
            remove_share_at(
                tx,
                &store,
                &scope,
                RemoveProjectShareRequest {
                    workspace_id: "workspace-1".into(),
                    project_id: "project-1".into(),
                    expected_revision: repeated.revision,
                    share_id: snapshot.shares[0].id.clone(),
                },
                "2026-09-07T12:05:00Z",
            )
        })
        .unwrap();
    assert_eq!(removed.shares.len(), 1);
    assert_eq!(removed.shares[0].mode, "live-reference");
}

#[test]
fn migrates_legacy_group_preserving_history_authorship_and_agent_identity() {
    let (store, scope) = store_and_scope();
    let profiles: Vec<MivletAgentProfile> = serde_json::from_value(serde_json::json!([
            {"id":"agent-a","name":"Alpha","instructions":"Keep alpha","modelId":"openai::alpha-model","icon":"sparkle","permissionLabel":"Ask Me"},
            {"id":"agent-b","name":"Beta","instructions":"Keep beta","modelId":"anthropic::beta-model","icon":"sparkle","permissionLabel":"Ask Me"}
        ]))
        .unwrap();
    let identities_before = serde_json::to_value(&profiles).unwrap();
    store
            .transaction(|tx| {
                thread::create(
                    tx,
                    &store,
                    &scope.data,
                    "legacy-thread",
                    None,
                    "Legacy group",
                    "now",
                    &serde_json::json!({"authorityScope":{"authority":"local","visibility":"member-private","ownerMemberId":scope.private.owner_member_id()}}),
                )?;
                tx.execute(
                    "UPDATE thread SET owner_member_id=?1
                      WHERE workspace_id=?2 AND id='legacy-thread' AND owner_member_id IS NULL",
                    rusqlite::params![scope.private.owner_member_id(), scope.data.workspace_id()],
                )?;
                tx.execute(
                    "INSERT INTO run(id,workspace_id,thread_id,provider_id,model,status,turn,
                                     recoverable,retry_count,created_at,updated_at,payload,payload_nonce)
                     VALUES('run-legacy','workspace-1','legacy-thread','anthropic','beta-model',
                            'completed',1,0,0,'now','now',X'',X'')",
                    [],
                )?;
                tx.execute(
                    "INSERT INTO run(id,workspace_id,thread_id,provider_id,model,status,turn,
                                     recoverable,retry_count,created_at,updated_at,payload,payload_nonce)
                     VALUES('run-unknown','workspace-1','legacy-thread','custom','mystery',
                            'completed',1,0,0,'now','now',X'',X'')",
                    [],
                )?;
                collab::put(
                    tx,
                    &store,
                    &scope.private,
                    Kind::Conversation,
                    "legacy-thread",
                    Some("legacy-thread"),
                    None,
                    &Conversation {
                        archived: false,
                        chat: None,
                        id: "legacy-thread".into(),
                        workspace_id: "workspace-1".into(),
                        kind: "group".into(),
                        title: "Legacy group".into(),
                        project_id: None,
                        facilitator_id: None,
                        participants: vec![
                            Participant {
                                agent_id: "agent-a".into(),
                                name: "Alpha".into(),
                            },
                            Participant {
                                agent_id: "agent-b".into(),
                                name: "Beta".into(),
                            },
                        ],
                        revision: 4,
                        generation: 2,
                        created_at: "now".into(),
                        updated_at: "now".into(),
                    },
                )
            })
            .unwrap();
    let project = store
        .transaction(|tx| {
            migrate_group_at(
                tx,
                &store,
                &scope,
                &profiles,
                MigrateLegacyGroupRequest {
                    workspace_id: "workspace-1".into(),
                    id: "project-legacy".into(),
                    conversation_id: "legacy-thread".into(),
                    expected_revision: 4,
                    name: "Legacy converted".into(),
                    instructions: "Keep the history".into(),
                    participant_ids: vec!["agent-a".into(), "agent-b".into()],
                    lead_agent_id: None,
                    share_history: true,
                },
                "2026-09-07T12:05:00Z",
            )
        })
        .unwrap();
    assert_eq!(project.thread_id, "legacy-thread");
    assert!(project.shares.is_empty());
    store
        .with_conn(|tx| {
            let room: Conversation = collab::get(
                tx,
                &store,
                &scope.private,
                Kind::Conversation,
                "legacy-thread",
            )?
            .unwrap();
            assert_eq!(room.project_id.as_deref(), Some("project-legacy"));
            assert_eq!(room.facilitator_id, None);
            assert_eq!(
                room.chat.as_ref().map(|chat| chat.owner_id.as_str()),
                Some("project-legacy")
            );
            let team: Team =
                collab::get(tx, &store, &scope.private, Kind::Team, "project-legacy")?.unwrap();
            assert_eq!(team.lead_agent_id, None);
            assert_eq!(
                team.participant_ids,
                vec!["agent-a".to_string(), "agent-b".to_string()]
            );
            let beta: Author =
                collab::get(tx, &store, &scope.private, Kind::Author, "run-legacy")?.unwrap();
            assert_eq!(beta.agent_id, "agent-b");
            assert_eq!(beta.name, "Beta");
            let unknown: Author =
                collab::get(tx, &store, &scope.private, Kind::Author, "run-unknown")?.unwrap();
            assert_eq!(unknown.agent_id, "historical");
            assert!(unknown.name.contains("attribution unavailable"));
            Ok(())
        })
        .unwrap();
    // Project activity never rewrites agent identity, instructions or model.
    assert_eq!(serde_json::to_value(&profiles).unwrap(), identities_before);
    // A thread can be migrated once.
    assert!(store
        .transaction(|tx| {
            migrate_group_at(
                tx,
                &store,
                &scope,
                &profiles,
                MigrateLegacyGroupRequest {
                    workspace_id: "workspace-1".into(),
                    id: "project-legacy-2".into(),
                    conversation_id: "legacy-thread".into(),
                    expected_revision: 5,
                    name: "Again".into(),
                    instructions: String::new(),
                    participant_ids: vec!["agent-a".into()],
                    lead_agent_id: None,
                    share_history: true,
                },
                "2026-09-07T12:06:00Z",
            )
        })
        .is_err());
}
