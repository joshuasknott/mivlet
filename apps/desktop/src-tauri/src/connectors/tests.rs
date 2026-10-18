use super::*;

#[test]
fn model_writes_use_native_policy_and_unique_exact_approvals() {
    for entry in CATALOG {
        for action in entry.actions {
            let payload = BTreeMap::from([("targetId".into(), "selected-resource".into())]);
            let first =
                connector_tool_action_request(entry.id.into(), (*action).into(), payload.clone())
                    .unwrap();
            let second =
                connector_tool_action_request(entry.id.into(), (*action).into(), payload).unwrap();
            assert_ne!(first.id, second.id);
            let mut changed = first.clone();
            changed.approval.risk_level = "low".into();
            assert!(validate_connector_action(changed).is_err());
            assert!(
                validate_connector_execution_request(ConnectorActionExecutionRequest {
                    action: first.clone(),
                    approval: crate::models::ApprovalResolutionRequest {
                        request: first.approval.clone(),
                        decision: "session".into(),
                        decided_at: first.approval.requested_at.clone(),
                        confirmation_text: None,
                        modification: None,
                    }
                })
                .is_err()
            );
        }
    }
    assert!(connector_tool_action_request(
        "gmail".into(),
        "google-drive.delete-file".into(),
        BTreeMap::new()
    )
    .is_err());
}

#[test]
fn approved_connector_execution_binds_prepared_account_not_current_selection() {
    let path = std::env::temp_dir().join(format!(
        "mivlet-connector-prepared-account-bind-{}.json",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&path);
    let prepared = connector_tool_action_request(
        "gmail".into(),
        "gmail.send".into(),
        BTreeMap::from([
            ("to".into(), "person@example.com".into()),
            ("subject".into(), "Status update".into()),
        ]),
    )
    .unwrap();
    let record =
        record_pending_connector_action(&path, &prepared, "account-a", "Account A").unwrap();
    let workspace = "workspace-a";
    let bound =
        bound_prepared_connection_id(workspace, "gmail", &record, Some("account-a")).unwrap();
    assert_eq!(
        bound,
        crate::connector_auth::derive_native_connection_id(workspace, "gmail", "account-a")
    );
    assert_eq!(
        prepared_connection_id(workspace, "gmail", "account-a").as_deref(),
        Some(bound.as_str())
    );
    let switched =
        bound_prepared_connection_id(workspace, "gmail", &record, Some("account-b")).unwrap_err();
    assert_eq!(switched.code, "conflict");
    assert!(switched.retryable);
    assert_eq!(
        switched.message,
        "Connector account changed after its approval preview."
    );
    assert!(!switched.message.contains("account-a"));
    assert!(!switched.message.contains("account-b"));
    assert_ne!(
        bound,
        crate::connector_auth::derive_native_connection_id(workspace, "gmail", "account-b")
    );
    let disconnected = bound_prepared_connection_id(workspace, "gmail", &record, None).unwrap_err();
    assert_eq!(disconnected.code, "conflict");
    let _ = std::fs::remove_file(path);
}

#[test]
fn oauth_catalog_keeps_write_scopes_only_for_product_writes() {
    let github = CATALOG.iter().find(|entry| entry.id == "github").unwrap();
    assert!(github
        .scopes
        .iter()
        .all(|(id, _, access, _)| *id != "repo" && *access == "read"));
    assert!(github
        .scopes
        .iter()
        .any(|(id, _, _, required)| *id == "read:user" && *required));
    assert!(github
        .scopes
        .iter()
        .any(|(id, _, _, required)| *id == "read:org" && *required));
    assert!(!github.setup_message.contains("GitHub App with read-only"));
    assert!(github.setup_message.contains("classic GitHub OAuth App"));
    assert!(github.actions.is_empty());
    let drive = CATALOG
        .iter()
        .find(|entry| entry.id == "google-drive")
        .unwrap();
    assert!(drive.scopes.iter().any(|(id, _, access, required)| {
        *id == "https://www.googleapis.com/auth/drive.file" && *access == "write" && *required
    }));
    assert!(drive.actions.contains(&drive_artifacts::ACTION));
    assert_eq!(
        action_required_scopes(drive_artifacts::ACTION),
        DRIVE_FILE_ACTION_SCOPES
    );
    let upload_policy = action_policy(drive_artifacts::ACTION).unwrap();
    assert_eq!(
        (upload_policy.mode, upload_policy.risk_level),
        ("full-access", "high")
    );
    let vercel = CATALOG.iter().find(|entry| entry.id == "vercel").unwrap();
    assert!(vercel.scopes.iter().any(|(id, _, access, required)| {
        *id == "deployment:write" && *access == "write" && *required
    }));
    let linear = CATALOG.iter().find(|entry| entry.id == "linear").unwrap();
    assert!(linear
        .scopes
        .iter()
        .all(|(id, _, _, _)| *id != "issues:create" && *id != "comments:create"));
    assert!(linear
        .scopes
        .iter()
        .any(|(id, _, access, required)| *id == "write" && *access == "write" && *required));
    let slack = CATALOG.iter().find(|entry| entry.id == "slack").unwrap();
    assert!(slack.scopes.iter().any(|(id, _, access, required)| {
        *id == "chat:write" && *access == "write" && *required
    }));
    assert!(slack.scopes.iter().any(|(id, _, access, required)| {
        *id == "reactions:write" && *access == "write" && *required
    }));
    assert_eq!(
        action_required_scopes("vercel.promote"),
        &["deployment:write"]
    );
    assert_eq!(action_required_scopes("linear.update-issue"), &["write"]);
    assert_eq!(action_required_scopes("slack.post"), &["chat:write"]);
    assert_eq!(
        action_required_scopes("slack.react-add"),
        &["reactions:write"]
    );
    assert!(!slack.actions.contains(&"slack.create-draft"));
    let notion = CATALOG.iter().find(|entry| entry.id == "notion").unwrap();
    assert!(notion.scopes.is_empty());
    assert!(notion
        .setup_message
        .contains("does not take OAuth scope query parameters"));
}
use crate::authorized_scope::{resolve, ScopeAccess};
use crate::models::ConnectorAccountSummary;
use crate::store::repos::workspace_directory::clear_current_internal_user;
use crate::store::vault::{MasterKey, Vault};
use crate::store::Store;

#[test]
fn connector_commands_fail_closed_for_an_unconfigured_workspace() {
    let error = require_connector_workspace(Some("another-workspace".to_string())).unwrap_err();
    assert_eq!(error.code, "invalid-request");
}

#[test]
fn connector_statuses_remain_truthful_for_an_unconfigured_workspace() {
    let manifests = list_unconfigured_workspace_connector_statuses();

    assert_eq!(manifests.len(), SUPPORTED_CONNECTOR_IDS.len());
    assert!(manifests
        .iter()
        .all(|manifest| manifest.status == "unconfigured"));
    assert!(manifests.iter().all(|manifest| {
        manifest.setup_message.as_deref()
            == Some("Connector credentials are not configured for this Mivlet workspace.")
            && manifest.account.is_none()
            && !manifest.supports_search
            && !manifest.supports_import
            && manifest.supported_actions.is_empty()
            && manifest.scopes.iter().all(|scope| !scope.granted)
    }));
}

#[test]
fn google_requested_optional_scope_uses_complete_reconnect_scope_set() {
    let entry = require_connector("gmail").unwrap();
    let scopes = selected_auth_scopes(
        entry,
        Some(&["https://www.googleapis.com/auth/gmail.send".to_string()]),
    )
    .unwrap();

    assert_eq!(
        scopes,
        vec![
            "https://www.googleapis.com/auth/gmail.readonly".to_string(),
            "https://www.googleapis.com/auth/gmail.send".to_string()
        ]
    );
}

#[test]
fn requested_oauth_scope_set_must_not_be_empty() {
    let entry = require_connector("gmail").unwrap();
    let error = selected_auth_scopes(entry, Some(&[])).unwrap_err();

    assert_eq!(error.code, "invalid-request");
    assert_eq!(
        error.message,
        "Requested OAuth scope set requires at least one scope."
    );
}

#[test]
fn notion_connect_allows_empty_oauth_scope_set() {
    let entry = require_connector("notion").unwrap();
    let scopes = selected_auth_scopes(entry, Some(&[])).unwrap();
    assert!(scopes.is_empty());
    assert!(selected_auth_scopes(entry, None).unwrap().is_empty());
}

#[test]
fn connector_request_rejects_retired_project_scope_and_connection_substitution() {
    require_workspace_connection_target("github", None, None, "connection-1").unwrap();
    require_workspace_connection_target(
        "github",
        None,
        Some("connection-1".into()),
        "connection-1",
    )
    .unwrap();
    let retired = require_workspace_connection_target(
        "github",
        Some("project-1".into()),
        Some("connection-1".into()),
        "connection-1",
    )
    .unwrap_err();
    assert_eq!(retired.code, "invalid-request");
    let substituted = require_workspace_connection_target(
        "github",
        None,
        Some("connection-2".into()),
        "connection-1",
    )
    .unwrap_err();
    assert_eq!(substituted.code, "conflict");
}

#[test]
fn account_listing_reconciles_canonical_records_with_installation_local_authority() {
    let store =
        Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap();
    let scope_a = store
        .transaction(|tx| resolve(tx, None, None, ScopeAccess::Write))
        .unwrap();
    let connection = ConnectorConnection {
        connector_id: "gmail".into(),
        account: ConnectorAccountSummary {
            id: "provider-account-secret".into(),
            display_name: "Work Gmail".into(),
            handle: None,
            email: None,
            workspace: None,
            avatar_url: None,
        },
        status: "connected".into(),
        scopes: vec!["https://www.googleapis.com/auth/gmail.readonly".into()],
        expires_at: None,
        credential_ref: crate::connector_auth::native_connector_credential_ref(
            "gmail",
            "provider-account-secret",
        ),
        connected_at: "1".into(),
        updated_at: "2".into(),
        is_active: true,
    };

    reconcile_canonical_connector_accounts(
        &store,
        &scope_a,
        "gmail",
        std::slice::from_ref(&connection),
    )
    .unwrap();
    reconcile_canonical_connector_accounts(
        &store,
        &scope_a,
        "gmail",
        std::slice::from_ref(&connection),
    )
    .unwrap();
    let records = store
        .with_conn(|tx| crate::store::repos::connection_record::list(tx, &store, &scope_a))
        .unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].revision, 1);
    let evidence = store
        .with_conn(|tx| {
            crate::store::repos::capability_evidence::list_current_for_connection(
                tx,
                &scope_a,
                &records[0].id,
            )
        })
        .unwrap();
    assert_eq!(evidence.len(), 1);
    assert_eq!(evidence[0].capability_key, "communication.email.search");
    assert_eq!(evidence[0].availability, "degraded");
    assert_eq!(evidence[0].revision, 1);
    assert!(!serde_json::to_string(&evidence)
        .unwrap()
        .contains("provider-account-secret"));
    assert!(
        require_selectable_canonical_connection(&store, &scope_a, "gmail", &records[0].id,).is_ok()
    );
    let selected = selected_connection_evidence(&store, &scope_a, "gmail").unwrap();
    assert_eq!(selected.connection_id, records[0].id);
    let stamped = bind_search_result_to_connection(
        ConnectorSearchResult {
            connector_id: "gmail".into(),
            query: "launch".into(),
            items: vec![crate::models::ConnectorSearchItem {
                id: "message-1".into(),
                connector_id: "gmail".into(),
                connection_id: None,
                title: "Launch".into(),
                kind: "message".into(),
                summary: "Summary".into(),
                provenance: "Connector: gmail".into(),
                freshness: "Now".into(),
                trust: "untrusted".into(),
                url: None,
                content_preview: None,
                provider_metadata: BTreeMap::new(),
            }],
            next_cursor: None,
            source: "live".into(),
            searched_at: "t".into(),
        },
        &selected.connection_id,
    );
    assert_eq!(
        stamped.items[0].connection_id.as_deref(),
        Some(selected.connection_id.as_str())
    );
    let bound = bind_source_to_private_connection(
        ConnectorImportResult {
            source: ConnectorKnowledgeSource {
                workspace_id: None,
                authority_scope: None,
                scope: None,
                id: "connector-gmail-message-1".into(),
                title: "Launch".into(),
                kind: "document".into(),
                connector_id: "gmail".into(),
                connection_id: None,
                provenance: "Connector: gmail".into(),
                freshness: "Now".into(),
                pinned: false,
                trust: "untrusted".into(),
                content_preview: Some("Summary".into()),
                imported_at: "t".into(),
                origin: "connector-import".into(),
                provider_metadata: BTreeMap::new(),
                disabled: false,
                deleted_at: None,
                status: Some("ok".into()),
                status_message: None,
            },
            imported: true,
        },
        &scope_a,
        &selected.connection_id,
    );
    assert_eq!(
        bound.source.connection_id.as_deref(),
        Some(selected.connection_id.as_str())
    );
    assert_eq!(
        bound.source.workspace_id.as_deref(),
        Some(scope_a.data.workspace_id())
    );
    assert_eq!(
        bound
            .source
            .authority_scope
            .as_ref()
            .and_then(|authority| authority.owner_member_id.as_deref()),
        scope_a.member_id.as_deref()
    );
    let mut unsafe_source = bound.source.clone();
    unsafe_source.content_preview = Some("Bearer ghp_supersecretvalue".into());
    unsafe_source
        .provider_metadata
        .insert("access_token".into(), "provider-secret".into());
    let normalized = normalize_connector_knowledge_source(unsafe_source, &scope_a.private).unwrap();
    let encoded = serde_json::to_string(&normalized).unwrap();
    assert!(!encoded.contains("ghp_supersecretvalue"));
    assert!(!encoded.contains("provider-secret"));
    assert!(encoded.contains("[redacted connector data]"));
    let first = merge_connector_knowledge_source(Vec::new(), bound.source.clone()).unwrap();
    let mut replacement = bound.source.clone();
    replacement.title = "Updated launch".into();
    let replaced = merge_connector_knowledge_source(first, replacement).unwrap();
    assert_eq!(replaced.len(), 1);
    assert_eq!(replaced[0].title, "Updated launch");
    let mut tombstone = replaced[0].clone();
    tombstone.deleted_at = Some("later".into());
    assert!(merge_connector_knowledge_source(vec![tombstone], bound.source.clone()).is_err());
    assert!(!serde_json::to_string(&records)
        .unwrap()
        .contains("provider-account-secret"));
    persist_connector_health_state(
        &store,
        &scope_a,
        "gmail",
        "provider-account-secret",
        &ConnectorHealth {
            state: "healthy".into(),
            summary: "Provider identity verified.".into(),
            checked_at: "3".into(),
            retry_after: None,
        },
    )
    .unwrap();
    let canonical_health = store
        .with_conn(|tx| crate::store::repos::connection_record::list(tx, &store, &scope_a))
        .unwrap();
    assert_eq!(canonical_health[0].health_state, "healthy");
    assert_eq!(canonical_health[0].revision, 2);
    assert!(store
        .with_conn(|tx| {
            crate::store::repos::capability_evidence::list_current_for_connection(
                tx,
                &scope_a,
                &canonical_health[0].id,
            )
        })
        .unwrap()
        .is_empty());
    let projected = project_canonical_account_options(
        account_options_from_connections(
            std::slice::from_ref(&connection),
            "gmail",
            scope_a.data.workspace_id(),
        ),
        &canonical_health,
        "gmail",
        Some(&canonical_health[0].id),
    )
    .unwrap();
    assert_eq!(projected[0].health_state, "healthy");
    assert!(project_canonical_account_options(
        account_options_from_connections(
            std::slice::from_ref(&connection),
            "gmail",
            scope_a.data.workspace_id(),
        ),
        &[],
        "gmail",
        None,
    )
    .is_err());

    persist_connector_health_state(
        &store,
        &scope_a,
        "gmail",
        "provider-account-secret",
        &ConnectorHealth {
            state: "degraded".into(),
            summary: "Provider temporarily unavailable.".into(),
            checked_at: "4".into(),
            retry_after: Some("later".into()),
        },
    )
    .unwrap();
    let degraded = store
        .with_conn(|tx| crate::store::repos::connection_record::list(tx, &store, &scope_a))
        .unwrap();
    assert_eq!(degraded[0].health_state, "degraded");
    assert_eq!(degraded[0].revision, 3);
    assert!(
        require_selectable_canonical_connection(&store, &scope_a, "gmail", &degraded[0].id,)
            .is_ok()
    );
    store
        .transaction(|tx| {
            crate::store::repos::connection_record::transition_native_connector(
                tx,
                &store,
                &scope_a,
                &degraded[0].id,
                degraded[0].revision,
                "refresh-required",
                "expired",
                "unhealthy",
                "refresh-required",
                "5",
            )?;
            Ok(())
        })
        .unwrap();
    let unavailable =
        require_selectable_canonical_connection(&store, &scope_a, "gmail", &degraded[0].id)
            .unwrap_err();
    assert_eq!(unavailable.code, "needs-auth");

    let scope_after_account_change = store
        .transaction(|tx| {
            clear_current_internal_user(tx)?;
            resolve(tx, None, None, ScopeAccess::Write)
        })
        .unwrap();
    assert_eq!(scope_after_account_change, scope_a);
    reconcile_canonical_connector_accounts(&store, &scope_a, "gmail", &[connection]).unwrap();
    persist_connector_health_state(
        &store,
        &scope_a,
        "gmail",
        "provider-account-secret",
        &ConnectorHealth {
            state: "degraded".into(),
            summary: "Provider temporarily unavailable.".into(),
            checked_at: "4".into(),
            retry_after: Some("later".into()),
        },
    )
    .unwrap();
}
