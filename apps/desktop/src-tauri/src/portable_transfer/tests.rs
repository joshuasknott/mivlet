//! Crypto and allow-list regression tests.
use super::data::{
    normalize_export_revisions, sanitize_knowledge_value, sanitize_memory_value,
    sanitize_snapshot_value, transfer_omissions, validate_payload, PortableMessage,
    PortableMessageRevision, PortableThread, PortableTransferPayload,
};
use super::envelope::{
    binding_digest, open, seal, TransferError, MAX_PLAINTEXT_BYTES, TRANSFER_FORMAT,
    TRANSFER_FORMAT_VERSION,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde_json::json;
use std::path::Path;

const PASSWORD: &str = "correct horse battery staple";

#[test]
fn round_trip_uses_a_new_salt_and_nonce() {
    let value = json!({"version": 1, "history": [{"id": "m1", "text": "hello"}]});
    let first = seal(&value, PASSWORD).unwrap();
    let second = seal(&value, PASSWORD).unwrap();
    assert_ne!(first, second);
    assert_eq!(open::<serde_json::Value>(&first, PASSWORD).unwrap(), value);
}

#[test]
fn wrong_passphrase_and_tampering_fail_closed() {
    let archive = seal(&json!({"safe": true}), PASSWORD).unwrap();
    assert_eq!(
        open::<serde_json::Value>(&archive, "wrong password").unwrap_err(),
        TransferError::AuthenticationFailed
    );
    let mut tampered = archive.clone();
    *tampered.last_mut().unwrap() ^= 1;
    assert!(matches!(
        open::<serde_json::Value>(&tampered, PASSWORD),
        Err(TransferError::AuthenticationFailed | TransferError::InvalidEnvelope)
    ));

    let mut envelope: serde_json::Value = serde_json::from_slice(&archive).unwrap();
    let encoded = envelope["ciphertext"].as_str().unwrap();
    let mut ciphertext = BASE64.decode(encoded).unwrap();
    ciphertext[0] ^= 1;
    envelope["ciphertext"] = json!(BASE64.encode(ciphertext));
    let ciphertext_tampered = serde_json::to_vec(&envelope).unwrap();
    assert_eq!(
        open::<serde_json::Value>(&ciphertext_tampered, PASSWORD).unwrap_err(),
        TransferError::AuthenticationFailed
    );

    envelope["plaintextBytes"] = json!(envelope["plaintextBytes"].as_u64().unwrap() + 1);
    let header_tampered = serde_json::to_vec(&envelope).unwrap();
    assert_eq!(
        open::<serde_json::Value>(&header_tampered, PASSWORD).unwrap_err(),
        TransferError::AuthenticationFailed
    );
}

#[test]
fn rejects_authority_flags_even_with_a_valid_passphrase() {
    let mut archive: serde_json::Value =
        serde_json::from_slice(&seal(&json!({"safe": true}), PASSWORD).unwrap()).unwrap();
    archive["activeAuthorityIncluded"] = json!(true);
    let encoded = serde_json::to_vec(&archive).unwrap();
    assert_eq!(
        open::<serde_json::Value>(&encoded, PASSWORD).unwrap_err(),
        TransferError::UnsupportedFormat
    );
}

#[test]
fn rejects_bad_passphrases_and_oversized_declarations() {
    assert_eq!(
        seal(&json!({}), "short").unwrap_err(),
        TransferError::InvalidPassphrase
    );
    assert_eq!(
        open::<serde_json::Value>(b"{}", PASSWORD).unwrap_err(),
        TransferError::InvalidEnvelope
    );
    let mut archive: serde_json::Value =
        serde_json::from_slice(&seal(&json!({}), PASSWORD).unwrap()).unwrap();
    archive["plaintextBytes"] = json!(MAX_PLAINTEXT_BYTES + 1);
    let encoded = serde_json::to_vec(&archive).unwrap();
    assert_eq!(
        open::<serde_json::Value>(&encoded, PASSWORD).unwrap_err(),
        TransferError::TooLarge
    );
}

#[test]
fn binding_digest_is_stable_without_exposing_binding() {
    assert_eq!(
        binding_digest("account-alpha"),
        binding_digest("account-alpha")
    );
    assert_ne!(
        binding_digest("account-alpha"),
        binding_digest("account-beta")
    );
    assert!(!binding_digest("account-alpha").contains("account-alpha"));
}

#[test]
fn payload_validation_rejects_project_rows_and_dangling_history() {
    let mut payload = PortableTransferPayload {
        format: TRANSFER_FORMAT.into(),
        format_version: TRANSFER_FORMAT_VERSION,
        schema_version: 45,
        exported_at: "now".into(),
        account_binding_digest: binding_digest("account-alpha"),
        workspace_name: "Default".into(),
        snapshot: json!({"agents": []}),
        memory: json!({"records": []}),
        knowledge: json!([]),
        threads: vec![PortableThread {
            id: "thread-1".into(),
            project_id: None,
            owner_member_id: None,
            title: "A thread".into(),
            lifecycle: "active".into(),
            last_sequence: 0,
            last_message_id: None,
            selected_head_id: None,
            created_at: "now".into(),
            updated_at: "now".into(),
            payload: json!({}),
        }],
        messages: vec![],
        revisions: vec![],
        omitted: transfer_omissions(),
    };
    assert!(validate_payload(&payload, &payload.account_binding_digest).is_ok());
    let mut newer_schema = payload.clone();
    newer_schema.schema_version += 1;
    assert_eq!(
        validate_payload(&newer_schema, &payload.account_binding_digest),
        Err(TransferError::UnsupportedFormat)
    );
    payload.messages.push(PortableMessage {
        id: "message-1".into(),
        thread_id: "missing-thread".into(),
        kind: "user".into(),
        detail_kind: "text".into(),
        seq: 1,
        previous_message_id: None,
        parent_message_id: None,
        idempotency_key: "idempotency-1".into(),
        current_revision_id: "revision-1".into(),
        current_revision_number: 1,
        current_revision_state: "terminal".into(),
        created_at: "now".into(),
        payload: json!({"text": "hello"}),
    });
    assert_eq!(
        validate_payload(&payload, &payload.account_binding_digest),
        Err(TransferError::InvalidEnvelope)
    );
    payload.messages[0].thread_id = "thread-1".into();
    payload.threads[0].project_id = Some("project-1".into());
    assert_eq!(
        validate_payload(&payload, &payload.account_binding_digest),
        Err(TransferError::UnsupportedFormat)
    );
}

#[test]
fn historical_streaming_revisions_become_inert_but_current_streaming_is_rejected() {
    let messages = vec![PortableMessage {
        id: "message-1".into(),
        thread_id: "thread-1".into(),
        kind: "assistant".into(),
        detail_kind: "{}".into(),
        seq: 1,
        previous_message_id: None,
        parent_message_id: None,
        idempotency_key: "message-1".into(),
        current_revision_id: "revision-2".into(),
        current_revision_number: 2,
        current_revision_state: "terminal".into(),
        created_at: "now".into(),
        payload: json!({"text": "complete"}),
    }];
    let revisions = vec![
        PortableMessageRevision {
            id: "revision-1".into(),
            thread_id: "thread-1".into(),
            message_id: "message-1".into(),
            revision_number: 1,
            base_revision_number: 0,
            previous_revision_id: None,
            state: "streaming".into(),
            reason: "partial".into(),
            idempotency_key: "revision-1".into(),
            checkpointed_at: "now".into(),
            run_id: None,
            payload: json!({"text": "partial"}),
        },
        PortableMessageRevision {
            id: "revision-2".into(),
            thread_id: "thread-1".into(),
            message_id: "message-1".into(),
            revision_number: 2,
            base_revision_number: 1,
            previous_revision_id: Some("revision-1".into()),
            state: "terminal".into(),
            reason: "complete".into(),
            idempotency_key: "revision-2".into(),
            checkpointed_at: "now".into(),
            run_id: None,
            payload: json!({"text": "complete"}),
        },
    ];
    let normalized = normalize_export_revisions(&messages, revisions).unwrap();
    assert_eq!(normalized[0].state, "terminal");
    assert_eq!(normalized[0].reason, "Portable transfer snapshot");

    let mut active_messages = messages;
    active_messages[0].current_revision_id = "revision-1".into();
    let mut active_revisions = normalized;
    active_revisions[0].state = "streaming".into();
    assert!(normalize_export_revisions(&active_messages, active_revisions).is_err());
}

#[test]
fn sanitization_clears_credentials_paths_and_authority() {
    let memory = sanitize_memory_value(&json!({
        "disabled": false,
        "records": [{
            "id": "m1", "kind": "preference", "title": "Preference", "value": "Keep this",
            "source": "user", "freshness": "current", "pinned": true,
            "runId": "run-secret", "provenance": {"path": "C:/private/file"},
            "approved": true, "nestedSecret": "must-drop"
        }]
    }));
    assert_eq!(memory["records"][0]["approved"], json!(false));
    assert!(memory["records"][0].get("runId").is_none());
    assert!(memory["records"][0].get("provenance").is_none());
    assert!(memory["records"][0].get("nestedSecret").is_none());

    let knowledge = sanitize_knowledge_value(&json!([{
        "id": "k1", "origin": "local-import", "connectorId": "mcp-secret",
        "account": "bearer-account", "provenance": "C:/private/source.md",
        "path": "C:/private/source.md", "nestedSecret": "must-drop"
    }]));
    assert_eq!(knowledge[0]["connectorId"], json!("local-files"));
    assert_eq!(knowledge[0]["origin"], json!("local-import"));
    assert!(knowledge[0].get("account").is_none());
    assert_eq!(knowledge[0]["provenance"], json!("Portable transfer"));
    assert!(knowledge[0].get("path").is_none());
    assert!(knowledge[0].get("nestedSecret").is_none());

    let snapshot = sanitize_snapshot_value(
        &json!({
            "approvalRules": [{"id": "authority"}],
            "connectedBackendIds": ["provider-secret"],
            "agents": [{
                "id": "agent-1", "name": "Imported", "instructions": "Keep user context",
                "modelId": "model", "icon": "agent", "iconColor": "blue",
                "iconImageDataUrl": "data:image/png;base64,aGVsbG8=",
                "connectorIds": ["credential-ref"], "knowledgeSourceIds": ["path-ref"],
                "permissionLabel": "Work Freely", "learnedTasks": [{
                    "id": "task", "title": "Task", "instruction": "Do it",
                    "createdAt": "now", "updatedAt": "now", "authority": "must-drop"
                }], "unknownSecret": "must-drop"
            }],
            "unknownSecret": "must-drop",
            "sidebarPreferences": {"projectOrder": ["project-secret"]}
        }),
        &memory,
        &knowledge,
    );
    assert_eq!(snapshot["approvalRules"], json!([]));
    assert_eq!(snapshot["connectedBackendIds"], json!([]));
    assert_eq!(snapshot["agents"][0]["connectorIds"], json!([]));
    assert_eq!(snapshot["agents"][0]["knowledgeSourceIds"], json!([]));
    assert_eq!(snapshot["agents"][0]["permissionLabel"], json!("Read Only"));
    assert_eq!(
        snapshot["agents"][0]["iconImageDataUrl"],
        json!("data:image/png;base64,aGVsbG8=")
    );
    assert!(snapshot["agents"][0].get("unknownSecret").is_none());
    assert!(snapshot["agents"][0]["learnedTasks"][0]
        .get("authority")
        .is_none());
    assert!(snapshot.get("unknownSecret").is_none());
    assert_eq!(snapshot["sidebarPreferences"]["projectOrder"], json!([]));
}

#[test]
fn current_store_vault_round_trip_and_nonempty_preflight() {
    let vault =
        crate::store::vault::Vault::new(&crate::store::vault::MasterKey::generate().unwrap())
            .unwrap();
    let store = crate::store::Store::open_in_memory(vault).unwrap();
    store
        .with_conn(|conn| {
            super::data::ensure_empty_destination(conn, &store)
                .map_err(crate::store::StoreError::Invalid)
        })
        .unwrap();

    store
        .transaction(|tx| {
            tx.execute(
                "INSERT INTO workspace(id,name,created_at,updated_at) VALUES('extra','Extra','now','now')",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    let extra_workspace = store
        .with_conn(|conn| {
            super::data::ensure_empty_destination(conn, &store)
                .map_err(crate::store::StoreError::Invalid)
        })
        .unwrap_err();
    assert!(extra_workspace.to_string().contains("empty destination"));
    store
        .transaction(|tx| {
            tx.execute("DELETE FROM workspace WHERE id='extra'", [])?;
            Ok(())
        })
        .unwrap();

    store
        .transaction(|tx| {
            let scope = crate::store::repos::scope::DataScope::workspace("default")?;
            crate::store::repos::preferences::upsert_scoped(
                tx,
                &store,
                &scope,
                "theme",
                &json!("light"),
                "now",
            )?;
            crate::store::repos::preferences::upsert_scoped(
                tx,
                &store,
                &scope,
                "document:runtime-snapshot.json",
                &json!({
                    "composerDraft": "", "agents": [{"id":"chief-of-staff","name":"Chief of Staff","instructions":"Coordinate my work, keep priorities clear, and help me move from decision to execution.","modelId":"","icon":"agent","iconColor":"#3659E3","avatarSeed":"ink-v1:0:chief-of-staff","connectorIds":[],"knowledgeSourceIds":[],"permissionLabel":"Ask Me","threadIds":[],"learnedTasks":[]}], "approvalAudit": [],
                    "approvalRules": [], "dismissedApprovalIds": [],
                    "connectedBackendIds": [], "memoryRecords": [],
                    "importedKnowledgeSources": []
                }),
                "now",
            )?;
            Ok(())
        })
        .unwrap();
    store
        .with_conn(|conn| {
            super::data::ensure_empty_destination(conn, &store)
                .map_err(crate::store::StoreError::Invalid)
        })
        .unwrap();
    store
        .transaction(|tx| {
            let scope = crate::store::repos::scope::DataScope::workspace("default")?;
            crate::store::repos::preferences::upsert_scoped(
                tx,
                &store,
                &scope,
                "document:runtime-snapshot.json",
                &json!({"composerDraft":"", "agents":[{"id":"existing"}], "approvalAudit":[], "approvalRules":[], "dismissedApprovalIds":[], "connectedBackendIds":[], "memoryRecords":[], "importedKnowledgeSources":[]}),
                "now",
            )?;
            Ok(())
        })
        .unwrap();
    let populated_bootstrap = store
        .with_conn(|conn| {
            super::data::ensure_empty_destination(conn, &store)
                .map_err(crate::store::StoreError::Invalid)
        })
        .unwrap_err();
    assert!(populated_bootstrap
        .to_string()
        .contains("bootstrap documents"));
    store
        .transaction(|tx| {
            let scope = crate::store::repos::scope::DataScope::workspace("default")?;
            crate::store::repos::preferences::upsert_scoped(
                tx,
                &store,
                &scope,
                "document:runtime-snapshot.json",
                &json!({"composerDraft":"", "agents":[], "approvalAudit":[], "approvalRules":[], "dismissedApprovalIds":[], "connectedBackendIds":[], "memoryRecords":[], "importedKnowledgeSources":[]}),
                "now",
            )?;
            Ok(())
        })
        .unwrap();

    let value = json!({"text": "portable history"});
    let sealed = crate::store::repos::seal_json(&store, &value, "thread:thread-1").unwrap();
    let revision_value = json!({"text": "portable history"});
    let revision_sealed = crate::store::repos::seal_json(
        &store,
        &revision_value,
        "message-revision:default:revision-1",
    )
    .unwrap();
    let message_detail_sealed =
        crate::store::repos::seal_json(&store, &json!({}), "message:message-1").unwrap();
    store
        .transaction(|tx| {
            tx.execute(
                "INSERT INTO thread(id,workspace_id,last_sequence,last_message_id,created_at,updated_at,payload,payload_nonce) VALUES(?1,'default',1,'message-1','now','now',?2,?3)",
                rusqlite::params!["thread-1", sealed.ciphertext, sealed.nonce],
            )?;
            tx.execute(
                "INSERT INTO message(id,workspace_id,thread_id,kind,detail_kind,seq,idempotency_key,current_revision_id,current_revision_number,current_revision_state,created_at,payload,payload_nonce) VALUES('message-1','default','thread-1','user','{}',1,'idempotency-1','revision-1',1,'terminal','now',?1,?2)",
                rusqlite::params![message_detail_sealed.ciphertext, message_detail_sealed.nonce],
            )?;
            tx.execute(
                "INSERT INTO message_revision(id,workspace_id,thread_id,message_id,revision_number,base_revision_number,state,reason,idempotency_key,checkpointed_at,created_at,payload,payload_nonce) VALUES('revision-1','default','thread-1','message-1',1,0,'terminal','initial','idempotency-1','now','now',?1,?2)",
                rusqlite::params![revision_sealed.ciphertext, revision_sealed.nonce],
            )?;
            Ok(())
        })
        .unwrap();
    let scope = crate::store::repos::scope::DataScope::workspace("default").unwrap();
    let listed = store
        .with_conn(|conn| {
            crate::store::repos::thread::list(conn, &store, &scope)
                .map_err(|_| crate::store::StoreError::Invalid("thread list failed".into()))
        })
        .unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, "thread-1");
    let messages = store
        .with_conn(|conn| {
            crate::store::repos::message::list(conn, &store, &scope, "thread-1")
                .map_err(|_| crate::store::StoreError::Invalid("message list failed".into()))
        })
        .unwrap();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].id, "message-1");
    assert_eq!(messages[0].detail, json!({}));
    assert_eq!(messages[0].content["text"], json!("portable history"));
    let opened: serde_json::Value = store
        .with_conn(|conn| {
            let stored: crate::store::vault::Sealed = conn.query_row(
                "SELECT payload,payload_nonce FROM thread WHERE id='thread-1'",
                [],
                |row| {
                    Ok(crate::store::vault::Sealed {
                        ciphertext: row.get(0)?,
                        nonce: row.get(1)?,
                    })
                },
            )?;
            crate::store::repos::open_json(&store, &stored, "thread:thread-1")
                .map_err(|_| crate::store::StoreError::Vault)
        })
        .unwrap();
    assert_eq!(opened, value);
    let error = store
        .with_conn(|conn| {
            super::data::ensure_empty_destination(conn, &store)
                .map_err(crate::store::StoreError::Invalid)
        })
        .unwrap_err()
        .to_string();
    assert!(error.contains("empty destination"));
}

#[test]
fn real_envelope_to_new_vault_import_hydrates_history_and_agents() {
    let source = crate::store::Store::open_in_memory(
        crate::store::vault::Vault::new(&crate::store::vault::MasterKey::generate().unwrap())
            .unwrap(),
    )
    .unwrap();
    let destination = crate::store::Store::open_in_memory(
        crate::store::vault::Vault::new(&crate::store::vault::MasterKey::generate().unwrap())
            .unwrap(),
    )
    .unwrap();
    let scope = crate::store::repos::scope::DataScope::workspace("default").unwrap();
    let private = crate::store::repos::scope::PrivateDataScope::for_authenticated_user(
        scope.clone(),
        "account-destination",
        Some("member-destination"),
    )
    .unwrap();
    let payload = PortableTransferPayload {
        format: TRANSFER_FORMAT.into(),
        format_version: TRANSFER_FORMAT_VERSION,
        schema_version: 45,
        exported_at: "now".into(),
        account_binding_digest: binding_digest("account-alpha"),
        workspace_name: "Imported workspace".into(),
        snapshot: json!({
            "version": 1,
            "activeItem": "thread-1",
            "composerDraft": "",
            "voiceEnabled": false,
            "voiceProvider": null,
            "approvalAudit": [],
            "dismissedApprovalIds": [],
            "approvalRules": [],
            "agents": [{
                "id": "agent-1", "name": "Imported agent", "instructions": "Keep context",
                "modelId": "model-1", "reasoningEffort": null, "fastMode": null,
                "notificationsEnabled": null, "icon": "bot", "iconColor": "blue",
                "avatarSeed": null, "iconImageDataUrl": null, "connectorIds": ["secret-ref"],
                "knowledgeSourceIds": [], "permissionLabel": "Read only", "threadId": null,
                "threadIds": [], "learnedTasks": []
            }],
            "agentRevision": 4,
            "activeAgentId": "agent-1",
            "sidebarPreferences": null,
            "pinnedSourceIds": [],
            "importedKnowledgeSources": [], "memoryDisabled": false,
            "memoryRecords": [], "connectedBackendIds": ["provider-secret"],
            "onboardingComplete": true, "onboardingVersion": 1,
            "selectedModelId": "model-1", "hiddenModelIds": [],
            "permissionMode": "trusted-scope", "permissionLabel": "Trusted",
            "customApprovalSettings": null, "savedAt": "now"
        }),
        memory: json!({"disabled": false, "records": []}),
        knowledge: json!([]),
        threads: vec![PortableThread {
            id: "thread-1".into(),
            project_id: None,
            owner_member_id: None,
            title: "Imported conversation".into(),
            lifecycle: "active".into(),
            last_sequence: 1,
            last_message_id: Some("message-1".into()),
            selected_head_id: Some("message-1".into()),
            created_at: "now".into(),
            updated_at: "now".into(),
            payload: json!({
                "title": "Conversation metadata",
                "authorityScope": {"authority":"local"},
                "path": "C:/private/repository",
                "unknownSecret": "must-drop"
            }),
        }],
        messages: vec![PortableMessage {
            id: "message-1".into(),
            thread_id: "thread-1".into(),
            kind: "user".into(),
            detail_kind: "text".into(),
            seq: 1,
            previous_message_id: None,
            parent_message_id: None,
            idempotency_key: "message-1".into(),
            current_revision_id: "revision-1".into(),
            current_revision_number: 1,
            current_revision_state: "terminal".into(),
            created_at: "now".into(),
            payload: json!({
                "detail": {"authority": "must-drop"},
                "text": "Hello from portable history",
                "content": [{"type":"text", "text":"Nested text", "secret":"must-drop"}],
                "attachments": [{"path":"C:/private/file"}],
                "path": "C:/private/file"
            }),
        }],
        revisions: vec![PortableMessageRevision {
            id: "revision-1".into(),
            thread_id: "thread-1".into(),
            message_id: "message-1".into(),
            revision_number: 1,
            base_revision_number: 0,
            previous_revision_id: None,
            state: "terminal".into(),
            reason: "initial".into(),
            idempotency_key: "message-1".into(),
            checkpointed_at: "now".into(),
            run_id: None,
            payload: json!({
                "text": "Hello from portable history",
                "content": [{"type":"text", "text":"Nested text", "authority":"must-drop"}],
                "attachments": [{"path":"C:/private/file"}],
                "path": "C:/private/file"
            }),
        }],
        omitted: transfer_omissions(),
    };
    let archive = seal(&payload, PASSWORD).unwrap();
    let opened: PortableTransferPayload = open(&archive, PASSWORD).unwrap();
    assert_eq!(opened.threads.len(), 1);
    assert_eq!(
        validate_payload(&opened, &binding_digest("account-alpha")),
        Ok(())
    );
    assert_eq!(
        validate_payload(&opened, &binding_digest("wrong-account")),
        Err(TransferError::UnsupportedFormat)
    );
    let mut corrupt = archive.clone();
    let corrupt_index = corrupt.len() / 2;
    corrupt[corrupt_index] ^= 1;
    assert!(open::<PortableTransferPayload>(&corrupt, PASSWORD).is_err());

    let runtime_path = Path::new("runtime-snapshot.json");
    let memory_path = Path::new("memory-state.json");
    let knowledge_path = Path::new("imported-knowledge.json");
    let counts = destination
        .transaction(|tx| {
            super::data::apply_payload(
                tx,
                &destination,
                &opened,
                &scope,
                &private,
                runtime_path,
                memory_path,
                knowledge_path,
            )
        })
        .unwrap();
    assert_eq!(counts.agents, 1);
    let listed = destination
        .with_conn(|conn| {
            crate::store::repos::thread::list(conn, &destination, &scope)
                .map_err(|_| crate::store::StoreError::Invalid("thread list failed".into()))
        })
        .unwrap();
    assert_eq!(listed[0].id, "thread-1");
    let messages = destination
        .with_conn(|conn| {
            crate::store::repos::message::list(conn, &destination, &scope, "thread-1")
                .map_err(|_| crate::store::StoreError::Invalid("message list failed".into()))
        })
        .unwrap();
    assert_eq!(messages[0].id, "message-1");
    assert_eq!(
        messages[0].content["text"],
        json!("Hello from portable history")
    );
    assert!(messages[0].content.get("attachments").is_none());
    assert!(messages[0].content["content"][0].get("authority").is_none());
    let destination_thread_sealed = destination
        .with_conn(|conn| {
            conn.query_row(
                "SELECT payload,payload_nonce FROM thread WHERE id='thread-1'",
                [],
                |row| {
                    Ok(crate::store::vault::Sealed {
                        ciphertext: row.get(0)?,
                        nonce: row.get(1)?,
                    })
                },
            )
            .map_err(crate::store::StoreError::from)
        })
        .unwrap();
    assert!(
        crate::store::repos::open_json(&source, &destination_thread_sealed, "thread:thread-1",)
            .is_err()
    );
    let destination_thread_payload =
        crate::store::repos::open_json(&destination, &destination_thread_sealed, "thread:thread-1")
            .unwrap();
    assert_eq!(
        destination_thread_payload["title"],
        json!("Conversation metadata")
    );
    assert!(destination_thread_payload.get("authorityScope").is_none());
    assert!(destination_thread_payload.get("path").is_none());
    assert!(destination_thread_payload.get("unknownSecret").is_none());
    let owner: String = destination
        .with_conn(|conn| {
            conn.query_row(
                "SELECT owner_member_id FROM thread WHERE id='thread-1'",
                [],
                |row| row.get(0),
            )
            .map_err(crate::store::StoreError::from)
        })
        .unwrap();
    assert_eq!(owner, "member-destination");
    let snapshot: serde_json::Value = destination
        .transaction(|tx| {
            crate::store::read_document_in_transaction(tx, &destination, runtime_path, &scope)
                .map_err(crate::store::StoreError::Invalid)
                .map(|value| value.unwrap())
        })
        .unwrap();
    assert_eq!(snapshot["agents"][0]["connectorIds"], json!([]));
    assert_eq!(snapshot["connectedBackendIds"], json!([]));
    assert_eq!(snapshot["permissionMode"], json!("read-only"));

    let destination_thread_count = destination
        .with_conn(|conn| {
            conn.query_row("SELECT COUNT(*) FROM thread", [], |row| {
                row.get::<_, i64>(0)
            })
            .map_err(crate::store::StoreError::from)
        })
        .unwrap();
    let rollback = destination.transaction(|tx| {
        super::data::ensure_empty_destination(tx, &destination)
            .map_err(crate::store::StoreError::Invalid)
    });
    assert!(rollback.is_err());
    let after_rollback = destination
        .with_conn(|conn| {
            conn.query_row("SELECT COUNT(*) FROM thread", [], |row| {
                row.get::<_, i64>(0)
            })
            .map_err(crate::store::StoreError::from)
        })
        .unwrap();
    assert_eq!(after_rollback, destination_thread_count);
}
