use super::*;
use crate::store::repos::scope::DataScope;
use crate::store::vault::{MasterKey, Vault};
use crate::store::Store;
use serde_json::json;
use std::path::Path;

fn test_agent(id: &str, name: &str) -> serde_json::Value {
    json!({
        "id": id,
        "name": name,
        "instructions": "Keep the research brief precise.",
        "modelId": "fixture-model",
        "reasoningEffort": "high",
        "fastMode": true,
        "icon": "agent",
        "iconColor": "#6D5DF7",
        "connectorIds": [],
        "knowledgeSourceIds": [],
        "permissionLabel": "Ask Me",
        "threadIds": [],
        "learnedTasks": []
    })
}

fn test_snapshot(
    agent_revision: u64,
    agents: Vec<serde_json::Value>,
    composer_draft: &str,
) -> RuntimeSnapshot {
    serde_json::from_value(json!({
        "version": RUNTIME_SNAPSHOT_VERSION,
        "activeItem": "Chat",
        "composerDraft": composer_draft,
        "voiceEnabled": false,
        "approvalAudit": [],
        "dismissedApprovalIds": [],
        "approvalRules": [],
        "agents": agents,
        "agentRevision": agent_revision,
        "activeAgentId": "lead",
        "pinnedSourceIds": [],
        "importedKnowledgeSources": [],
        "memoryDisabled": false,
        "memoryRecords": [],
        "connectedBackendIds": [],
        "savedAt": "2026-10-19T00:00:00Z",
        "permissionMode": "trusted-scope",
        "permissionLabel": "Ask Me"
    }))
    .expect("snapshot fixture")
}

fn test_store() -> Store {
    Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap()
}

fn test_scope() -> DataScope {
    DataScope::workspace("default").unwrap()
}

fn save_test_snapshot(
    store: &Store,
    path: &Path,
    scope: &DataScope,
    snapshot: &RuntimeSnapshot,
) -> Result<(), String> {
    store
        .transaction(|tx| save_snapshot_document_in_transaction(tx, store, path, scope, snapshot))
        .map_err(|error| error.to_string())
}

fn read_test_snapshot(store: &Store, path: &Path, scope: &DataScope) -> Option<RuntimeSnapshot> {
    store
        .transaction(|tx| read_snapshot_document_in_transaction(tx, store, path, scope))
        .unwrap()
}

#[test]
fn stale_revision_cannot_replace_a_newer_saved_roster() {
    let store = test_store();
    let scope = test_scope();
    let path = Path::new("runtime-snapshot-cas.json");
    let lead = test_agent("lead", "Lead");
    save_test_snapshot(
        &store,
        path,
        &scope,
        &test_snapshot(0, vec![lead.clone()], "initial"),
    )
    .unwrap();
    store
        .transaction(|tx| {
            write_snapshot_document_in_transaction(
                tx,
                &store,
                path,
                &scope,
                &test_snapshot(
                    1,
                    vec![lead.clone(), test_agent("researcher", "Researcher")],
                    "newer",
                ),
            )
        })
        .unwrap();

    let stale = test_snapshot(0, vec![test_agent("lead", "Stale Lead")], "stale");
    assert!(save_test_snapshot(&store, path, &scope, &stale).is_err());
    let saved = read_test_snapshot(&store, path, &scope).unwrap();
    assert_eq!(saved.agent_revision, 1);
    assert_eq!(saved.agents.len(), 2);
    assert_eq!(saved.agents[0].name, "Lead");
    assert_eq!(saved.composer_draft, "newer");
}

#[test]
fn missing_snapshot_rejects_nonzero_revision() {
    let store = test_store();
    let scope = test_scope();
    let path = Path::new("runtime-snapshot-missing.json");
    let snapshot = test_snapshot(1, vec![test_agent("lead", "Lead")], "first");
    assert!(save_test_snapshot(&store, path, &scope, &snapshot).is_err());
    assert!(read_test_snapshot(&store, path, &scope).is_none());
}

#[test]
fn current_revision_save_retains_agent_profiles_and_settings() {
    let store = test_store();
    let scope = test_scope();
    let path = Path::new("runtime-snapshot-retain.json");
    let initial = test_snapshot(0, vec![test_agent("lead", "Lead")], "initial");
    save_test_snapshot(&store, path, &scope, &initial).unwrap();

    let updated = test_snapshot(0, vec![test_agent("lead", "Lead")], "kept draft");
    save_test_snapshot(&store, path, &scope, &updated).unwrap();
    let saved = read_test_snapshot(&store, path, &scope).unwrap();
    assert_eq!(saved.agent_revision, 0);
    assert_eq!(saved.composer_draft, "kept draft");
    assert_eq!(saved.agents[0].id, "lead");
    assert_eq!(
        saved.agents[0].instructions,
        "Keep the research brief precise."
    );
    assert_eq!(saved.agents[0].model_id, "fixture-model");
    assert_eq!(saved.agents[0].reasoning_effort.as_deref(), Some("high"));
    assert_eq!(saved.agents[0].fast_mode, Some(true));
}
