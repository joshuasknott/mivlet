//! Allow-listed current-schema portable data and store extraction.

use super::envelope::{binding_digest, TransferError, TRANSFER_FORMAT, TRANSFER_FORMAT_VERSION};
use crate::store::repos::scope::{DataScope, PrivateDataScope, DEFAULT_WORKSPACE_ID};
use crate::store::Store;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Explicitly allow-listed history/configuration subset. Provider sessions,
/// approvals, runs, leases, paths, connector refs, and execution caches are
/// deliberately absent. User text remains user-owned content and is included
/// only after the native UI's explicit sensitive-content warning.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableTransferPayload {
    pub format: String,
    pub format_version: u32,
    pub schema_version: u32,
    pub exported_at: String,
    pub account_binding_digest: String,
    pub workspace_name: String,
    pub snapshot: serde_json::Value,
    pub memory: serde_json::Value,
    pub knowledge: serde_json::Value,
    pub threads: Vec<PortableThread>,
    pub messages: Vec<PortableMessage>,
    pub revisions: Vec<PortableMessageRevision>,
    pub omitted: PortableTransferOmissions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableTransferOmissions {
    pub credentials: Vec<String>,
    pub authority: Vec<String>,
    pub machine_specific: Vec<String>,
    pub unsupported_history: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableThread {
    pub id: String,
    pub project_id: Option<String>,
    pub owner_member_id: Option<String>,
    pub title: String,
    pub lifecycle: String,
    pub last_sequence: i64,
    pub last_message_id: Option<String>,
    pub selected_head_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableMessage {
    pub id: String,
    pub thread_id: String,
    pub kind: String,
    pub detail_kind: String,
    pub seq: i64,
    pub previous_message_id: Option<String>,
    pub parent_message_id: Option<String>,
    pub idempotency_key: String,
    pub current_revision_id: String,
    pub current_revision_number: i64,
    pub current_revision_state: String,
    pub created_at: String,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableMessageRevision {
    pub id: String,
    pub thread_id: String,
    pub message_id: String,
    pub revision_number: i64,
    pub base_revision_number: i64,
    pub previous_revision_id: Option<String>,
    pub state: String,
    pub reason: String,
    pub idempotency_key: String,
    pub checkpointed_at: String,
    pub run_id: Option<String>,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableTransferReceipt {
    pub file_name: String,
    pub bytes: u64,
    pub format_version: u32,
    pub schema_version: u32,
    pub credentials_included: bool,
    pub active_authority_included: bool,
    pub account_binding_digest: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableTransferImportReport {
    pub threads: usize,
    pub messages: usize,
    pub revisions: usize,
    pub agents: usize,
    pub memory_records: usize,
    pub knowledge_sources: usize,
    pub credentials_reconnected: bool,
    pub authority_recreated: bool,
    /// The caller must restart/reload the workspace before renderer writes
    /// resume, otherwise an old in-memory snapshot could overwrite the import.
    pub requires_restart: bool,
    pub omitted: PortableTransferOmissions,
}

pub(super) fn transfer_omissions() -> PortableTransferOmissions {
    PortableTransferOmissions {
        credentials: vec![
            "provider API keys and OAuth tokens".into(),
            "OS vault master key".into(),
            "connector credential references".into(),
        ],
        authority: vec![
            "approvals and approval rules".into(),
            "active runs, tool calls, leases, schedules, and background jobs".into(),
            "cloud workspace links and sync cursors".into(),
        ],
        machine_specific: vec![
            "absolute paths, repository bindings, browser profiles, and native runtime caches"
                .into(),
        ],
        unsupported_history: vec![
            "project-owned conversation rooms and collaboration records".into(),
            "run/provider/tool-call records (message text is retained)".into(),
            "published file bytes and attachment paths".into(),
        ],
    }
}

pub(super) fn value_count(value: &serde_json::Value, key: &str) -> usize {
    value
        .get(key)
        .and_then(serde_json::Value::as_array)
        .map_or(0, Vec::len)
}

/// Convert the current documents into explicit, inert DTOs. In particular,
/// this is intentionally not implemented as "clone then remove known bad
/// fields": unknown fields are not part of the portable contract and must not
/// cross the vault boundary merely because a newer producer added them.
fn string_field(object: &serde_json::Map<String, serde_json::Value>, key: &str) -> Option<String> {
    object
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
}

fn bool_field(object: &serde_json::Map<String, serde_json::Value>, key: &str) -> Option<bool> {
    object.get(key).and_then(serde_json::Value::as_bool)
}

fn optional_string(
    object: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> serde_json::Value {
    string_field(object, key).map_or(serde_json::Value::Null, serde_json::Value::String)
}

fn sanitize_memory_record(value: &serde_json::Value) -> Option<serde_json::Value> {
    let object = value.as_object()?;
    Some(serde_json::json!({
        "workspaceId": DEFAULT_WORKSPACE_ID,
        "authorityScope": {"authority": "local", "visibility": "member-private"},
        "id": string_field(object, "id")?,
        "kind": string_field(object, "kind").unwrap_or_default(),
        "title": string_field(object, "title").unwrap_or_default(),
        "value": string_field(object, "value").unwrap_or_default(),
        "source": string_field(object, "source").unwrap_or_default(),
        "freshness": string_field(object, "freshness").unwrap_or_default(),
        "approved": false,
        "pinned": bool_field(object, "pinned").unwrap_or(false),
        "scope": {"level": "global"},
        "confidence": object.get("confidence").and_then(serde_json::Value::as_f64),
        "createdAt": optional_string(object, "createdAt"),
        "updatedAt": optional_string(object, "updatedAt"),
        "disabled": bool_field(object, "disabled").unwrap_or(false),
    }))
}

pub(super) fn sanitize_memory_value(value: &serde_json::Value) -> serde_json::Value {
    let Some(object) = value.as_object() else {
        return serde_json::json!({"disabled": false, "records": []});
    };
    let records = object
        .get("records")
        .and_then(serde_json::Value::as_array)
        .map(|records| {
            records
                .iter()
                .filter_map(sanitize_memory_record)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    serde_json::json!({
        "disabled": bool_field(object, "disabled").unwrap_or(false),
        "records": records,
    })
}

fn sanitize_knowledge_source(value: &serde_json::Value) -> Option<serde_json::Value> {
    let source = value.as_object()?;
    Some(serde_json::json!({
        "workspaceId": DEFAULT_WORKSPACE_ID,
        "authorityScope": {"authority": "local", "visibility": "member-private"},
        "scope": {"level": "global"},
        "id": string_field(source, "id")?,
        "title": string_field(source, "title").unwrap_or_default(),
        "kind": string_field(source, "kind").unwrap_or_default(),
        "connectorId": "local-files",
        "provenance": "Portable transfer",
        "freshness": string_field(source, "freshness").unwrap_or_default(),
        "pinned": bool_field(source, "pinned").unwrap_or(false),
        "trust": string_field(source, "trust").unwrap_or_default(),
        "contentPreview": string_field(source, "contentPreview").unwrap_or_default(),
        "contentFingerprint": string_field(source, "contentFingerprint").unwrap_or_default(),
        "sizeBytes": source.get("sizeBytes").and_then(serde_json::Value::as_u64).unwrap_or(0),
        "importedAt": string_field(source, "importedAt").unwrap_or_default(),
        "origin": "local-import",
        "disabled": bool_field(source, "disabled").unwrap_or(false),
        "deletedAt": optional_string(source, "deletedAt"),
        "status": optional_string(source, "status"),
        "statusMessage": optional_string(source, "statusMessage"),
    }))
}

pub(super) fn sanitize_knowledge_value(value: &serde_json::Value) -> serde_json::Value {
    serde_json::Value::Array(
        value
            .as_array()
            .map(|sources| {
                sources
                    .iter()
                    .filter_map(sanitize_knowledge_source)
                    .collect()
            })
            .unwrap_or_default(),
    )
}

fn sanitize_learned_task(value: &serde_json::Value) -> Option<serde_json::Value> {
    let object = value.as_object()?;
    Some(serde_json::json!({
        "id": string_field(object, "id")?,
        "title": string_field(object, "title")?,
        "instruction": string_field(object, "instruction")?,
        "createdAt": string_field(object, "createdAt")?,
        "updatedAt": string_field(object, "updatedAt")?,
    }))
}

fn sanitize_agent(value: &serde_json::Value) -> Option<serde_json::Value> {
    let object = value.as_object()?;
    let learned_tasks = object
        .get("learnedTasks")
        .and_then(serde_json::Value::as_array)
        .map(|tasks| {
            tasks
                .iter()
                .filter_map(sanitize_learned_task)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let thread_ids = object
        .get("threadIds")
        .and_then(serde_json::Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(|id| id.as_str().map(str::to_owned))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let mut agent = serde_json::Map::new();
    for key in ["id", "name", "instructions", "modelId", "icon", "iconColor"] {
        if let Some(value) = string_field(object, key) {
            agent.insert(key.to_string(), value.into());
        } else if matches!(key, "id" | "name" | "instructions" | "modelId" | "icon") {
            return None;
        }
    }
    for key in ["reasoningEffort", "avatarSeed", "threadId"] {
        if let Some(value) = string_field(object, key) {
            agent.insert(key.to_string(), value.into());
        }
    }
    for key in ["fastMode", "notificationsEnabled"] {
        if let Some(value) = bool_field(object, key) {
            agent.insert(key.to_string(), value.into());
        }
    }
    if let Some(image) = string_field(object, "iconImageDataUrl").filter(|image| {
        image.len() <= 512_000
            && (image.starts_with("data:image/png;base64,")
                || image.starts_with("data:image/jpeg;base64,")
                || image.starts_with("data:image/webp;base64,"))
    }) {
        agent.insert("iconImageDataUrl".into(), image.into());
    }
    agent.insert("connectorIds".into(), serde_json::json!([]));
    agent.insert("knowledgeSourceIds".into(), serde_json::json!([]));
    agent.insert("permissionLabel".into(), serde_json::json!("Read Only"));
    agent.insert("threadIds".into(), serde_json::json!(thread_ids));
    agent.insert("learnedTasks".into(), serde_json::json!(learned_tasks));
    Some(serde_json::Value::Object(agent))
}

fn sanitize_sidebar(value: Option<&serde_json::Value>) -> serde_json::Value {
    let Some(object) = value.and_then(serde_json::Value::as_object) else {
        return serde_json::Value::Null;
    };
    let pinned = object
        .get("pinned")
        .and_then(serde_json::Value::as_array)
        .map(|pins| {
            pins.iter()
                .filter_map(|pin| {
                    let pin = pin.as_object()?;
                    if string_field(pin, "kind").as_deref() != Some("agent") {
                        return None;
                    }
                    Some(serde_json::json!({
                        "kind": "agent",
                        "id": string_field(pin, "id")?,
                    }))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let ids = |key: &str| {
        object
            .get(key)
            .and_then(serde_json::Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(str::to_owned))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    };
    serde_json::json!({
        "pinned": pinned,
        "projectOrder": [],
        "agentOrder": ids("agentOrder"),
        "projectSort": string_field(object, "projectSort").unwrap_or_default(),
        "agentSort": string_field(object, "agentSort").unwrap_or_default(),
        "projectsCollapsed": bool_field(object, "projectsCollapsed").unwrap_or(false),
        "agentsCollapsed": bool_field(object, "agentsCollapsed").unwrap_or(false),
    })
}

pub(super) fn sanitize_snapshot_value(
    value: &serde_json::Value,
    memory: &serde_json::Value,
    knowledge: &serde_json::Value,
) -> serde_json::Value {
    let object = value.as_object();
    let agents = object
        .and_then(|object| object.get("agents"))
        .and_then(serde_json::Value::as_array)
        .map(|agents| agents.iter().filter_map(sanitize_agent).collect::<Vec<_>>())
        .unwrap_or_default();
    let snapshot = serde_json::json!({
        "version": object.and_then(|o| o.get("version")).and_then(serde_json::Value::as_u64).unwrap_or(1).min(u8::MAX as u64),
        "activeItem": object.and_then(|o| string_field(o, "activeItem")).unwrap_or_else(|| "new-chat".into()),
        "composerDraft": object.and_then(|o| string_field(o, "composerDraft")).unwrap_or_default(),
        "voiceEnabled": object.and_then(|o| bool_field(o, "voiceEnabled")).unwrap_or(false),
        "voiceProvider": object.and_then(|o| optional_string(o, "voiceProvider").as_str().map(str::to_owned)),
        "approvalAudit": [],
        "dismissedApprovalIds": [],
        "approvalRules": [],
        "agents": agents,
        "agentRevision": 0,
        "activeAgentId": object.and_then(|o| string_field(o, "activeAgentId")),
        "sidebarPreferences": sanitize_sidebar(object.and_then(|o| o.get("sidebarPreferences"))),
        "pinnedSourceIds": [],
        "importedKnowledgeSources": knowledge,
        "memoryDisabled": memory.get("disabled").and_then(serde_json::Value::as_bool).unwrap_or(false),
        "memoryRecords": memory.get("records").cloned().unwrap_or_else(|| serde_json::json!([])),
        "connectedBackendIds": [],
        "onboardingComplete": false,
        "onboardingVersion": 0,
        "selectedModelId": "",
        "hiddenModelIds": [],
        "permissionMode": "read-only",
        "permissionLabel": "Read Only",
        "customApprovalSettings": null,
        "savedAt": object.and_then(|o| string_field(o, "savedAt")).unwrap_or_default(),
    });
    snapshot
}

const HISTORY_KEYS: &[&str] = &[
    "text",
    "content",
    "transcript",
    "summary",
    "title",
    "label",
    "role",
    "kind",
    "type",
    "status",
    "state",
    "reason",
    "detail",
    "detailKind",
    "sequence",
    "seq",
    "id",
    "messageId",
    "revisionId",
    "threadId",
    "parentMessageId",
    "previousMessageId",
    "currentRevisionId",
    "currentRevisionNumber",
    "branchId",
    "createdAt",
    "updatedAt",
    "language",
    "value",
    "parts",
];

const DETAIL_KEYS: &[&str] = &[
    "phase",
    "reason",
    "code",
    "retryable",
    "outcome",
    "state",
    "label",
];

fn sanitize_history_value(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Array(values) => {
            serde_json::Value::Array(values.iter().map(sanitize_history_value).collect())
        }
        serde_json::Value::Object(object) => serde_json::Value::Object(
            object
                .iter()
                .filter(|(key, _)| HISTORY_KEYS.contains(&key.as_str()))
                .map(|(key, value)| (key.clone(), sanitize_history_value(value)))
                .collect(),
        ),
        scalar => scalar.clone(),
    }
}

fn sanitize_detail_value(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(object) => serde_json::Value::Object(
            object
                .iter()
                .filter(|(key, _)| DETAIL_KEYS.contains(&key.as_str()))
                .map(|(key, value)| (key.clone(), sanitize_history_value(value)))
                .collect(),
        ),
        serde_json::Value::Null => serde_json::Value::Null,
        _ => serde_json::Value::Object(serde_json::Map::new()),
    }
}

/// `message.detail_kind` is a JSON string despite its historical column name.
/// Keep only inert presentation metadata; tool, approval, attachment, and
/// path-bearing detail never crosses a portable-transfer boundary.
fn sanitize_detail_kind(value: &str) -> String {
    serde_json::from_str::<serde_json::Value>(value)
        .ok()
        .map(|value| sanitize_detail_value(&value))
        .and_then(|value| serde_json::to_string(&value).ok())
        .unwrap_or_else(|| "{}".to_string())
}

fn inert_history_state(state: &str) -> bool {
    matches!(state, "terminal" | "redacted")
}

/// Completed messages can retain earlier partial streaming revisions. Those
/// revisions are historical content, not live authority; materialize them as
/// inert terminal snapshots. A streaming current revision is rejected because
/// exporting it would capture an active provider turn.
pub(super) fn normalize_export_revisions(
    messages: &[PortableMessage],
    revisions: Vec<PortableMessageRevision>,
) -> Result<Vec<PortableMessageRevision>, String> {
    let current_revision_ids = messages
        .iter()
        .map(|message| (message.id.as_str(), message.current_revision_id.as_str()))
        .collect::<std::collections::HashMap<_, _>>();
    revisions
        .into_iter()
        .map(|mut revision| {
            if revision.state == "streaming" {
                if current_revision_ids
                    .get(revision.message_id.as_str())
                    .is_some_and(|current| *current == revision.id.as_str())
                {
                    return Err(
                        "Portable transfer cannot export an active conversation revision."
                            .to_string(),
                    );
                }
                revision.state = "terminal".to_string();
                revision.reason = "Portable transfer snapshot".to_string();
            } else if !inert_history_state(&revision.state) {
                return Err("Portable transfer contains an invalid conversation revision.".into());
            }
            revision.payload = sanitize_history_value(&revision.payload);
            Ok(revision)
        })
        .collect()
}

pub(super) fn validate_sanitized_documents(
    snapshot: &serde_json::Value,
    memory: &serde_json::Value,
    knowledge: &serde_json::Value,
) -> Result<(), String> {
    serde_json::from_value::<crate::models::RuntimeSnapshot>(snapshot.clone())
        .map_err(|_| "The portable transfer contains an invalid agent snapshot.".to_string())?;
    serde_json::from_value::<crate::models::MemoryControlState>(memory.clone())
        .map_err(|_| "The portable transfer contains invalid memory data.".to_string())?;
    serde_json::from_value::<Vec<crate::models::LocalFileImport>>(knowledge.clone())
        .map_err(|_| "The portable transfer contains invalid knowledge metadata.".to_string())?;
    Ok(())
}

pub(super) fn validate_payload(
    payload: &PortableTransferPayload,
    expected_binding: &str,
) -> Result<(), TransferError> {
    if payload.format != TRANSFER_FORMAT
        || payload.format_version != TRANSFER_FORMAT_VERSION
        || payload.schema_version == 0
        || payload.schema_version > crate::store::schema::CURRENT_SCHEMA_VERSION
        || payload.account_binding_digest != expected_binding
        || payload
            .threads
            .iter()
            .any(|thread| thread.project_id.is_some())
    {
        return Err(TransferError::UnsupportedFormat);
    }
    let mut threads = std::collections::BTreeSet::new();
    if payload
        .threads
        .iter()
        .any(|thread| !threads.insert(thread.id.as_str()))
    {
        return Err(TransferError::InvalidEnvelope);
    }
    let mut messages = std::collections::BTreeSet::new();
    let mut message_by_id = std::collections::HashMap::new();
    if payload.messages.iter().any(|message| {
        !threads.contains(message.thread_id.as_str())
            || !messages.insert(message.id.as_str())
            || !inert_history_state(&message.current_revision_state)
            || message_by_id
                .insert(
                    message.id.clone(),
                    (
                        message.thread_id.clone(),
                        message.current_revision_id.clone(),
                        message.current_revision_number,
                        message.current_revision_state.clone(),
                    ),
                )
                .is_some()
    }) {
        return Err(TransferError::InvalidEnvelope);
    }
    let mut revisions = std::collections::BTreeSet::new();
    let mut revision_by_id = std::collections::HashMap::new();
    if payload.revisions.iter().any(|revision| {
        !messages.contains(revision.message_id.as_str())
            || !threads.contains(revision.thread_id.as_str())
            || !revisions.insert(revision.id.as_str())
            || !inert_history_state(&revision.state)
            || revision_by_id
                .insert(
                    revision.id.clone(),
                    (
                        revision.thread_id.clone(),
                        revision.message_id.clone(),
                        revision.revision_number,
                        revision.state.clone(),
                    ),
                )
                .is_some()
    }) {
        return Err(TransferError::InvalidEnvelope);
    }
    for thread in &payload.threads {
        for message_id in [
            thread.last_message_id.as_ref(),
            thread.selected_head_id.as_ref(),
        ]
        .into_iter()
        .flatten()
        {
            if message_by_id
                .get(message_id)
                .is_none_or(|(thread_id, ..)| thread_id != &thread.id)
            {
                return Err(TransferError::InvalidEnvelope);
            }
        }
    }
    for message in &payload.messages {
        for parent_id in [
            message.previous_message_id.as_ref(),
            message.parent_message_id.as_ref(),
        ]
        .into_iter()
        .flatten()
        {
            if message_by_id
                .get(parent_id)
                .is_none_or(|(thread_id, ..)| thread_id != &message.thread_id)
            {
                return Err(TransferError::InvalidEnvelope);
            }
        }
        let Some((current_thread, current_revision, current_number, current_state)) =
            message_by_id.get(&message.id)
        else {
            return Err(TransferError::InvalidEnvelope);
        };
        let Some((revision_thread, revision_message, revision_number, revision_state)) =
            revision_by_id.get(current_revision)
        else {
            return Err(TransferError::InvalidEnvelope);
        };
        if current_thread != revision_thread
            || revision_message != &message.id
            || current_number != revision_number
            || current_state != revision_state
        {
            return Err(TransferError::InvalidEnvelope);
        }
    }
    for revision in &payload.revisions {
        let Some((message_thread, ..)) = message_by_id.get(&revision.message_id) else {
            return Err(TransferError::InvalidEnvelope);
        };
        if message_thread != &revision.thread_id {
            return Err(TransferError::InvalidEnvelope);
        }
        if let Some(previous) = &revision.previous_revision_id {
            let Some((thread_id, message_id, number, _)) = revision_by_id.get(previous) else {
                return Err(TransferError::InvalidEnvelope);
            };
            if thread_id != &revision.thread_id
                || message_id != &revision.message_id
                || number >= &revision.revision_number
            {
                return Err(TransferError::InvalidEnvelope);
            }
        }
    }
    Ok(())
}

pub(super) fn payload_from_store(
    app: &tauri::AppHandle,
    store: &Store,
) -> Result<PortableTransferPayload, String> {
    let binding = crate::account_session::binding()?.to_string();
    let principals = crate::account_session::principals()?;
    let scope = DataScope::workspace(DEFAULT_WORKSPACE_ID.to_string())
        .map_err(|error| error.to_string())?;
    let private =
        PrivateDataScope::for_authenticated_user(scope.clone(), &principals.0, Some(&principals.1))
            .map_err(|error| error.to_string())?;
    // Read rows and all encrypted documents under one transaction snapshot so
    // export cannot combine history from one generation with an older agent or
    // memory document.
    let (workspace_name, threads, messages, revisions, raw_snapshot, raw_memory, raw_knowledge) =
        store
            .transaction(|tx| {
                let workspace_name: String = tx.query_row(
                    "SELECT name FROM workspace WHERE id=?1",
                    [DEFAULT_WORKSPACE_ID],
                    |row| row.get(0),
                )?;
                let mut thread_stmt = tx.prepare("SELECT id,project_id,owner_member_id,title,lifecycle,last_sequence,last_message_id,selected_head_id,created_at,updated_at,payload,payload_nonce FROM thread WHERE workspace_id=?1 AND deleted_at IS NULL AND project_id IS NULL AND (owner_member_id IS NULL OR owner_member_id=?2) ORDER BY id")?;
                let threads = thread_stmt
                    .query_map(
                        rusqlite::params![DEFAULT_WORKSPACE_ID, private.owner_member_id()],
                        |row| {
                            let id: String = row.get(0)?;
                            let sealed = crate::store::vault::Sealed {
                                ciphertext: row.get(10)?,
                                nonce: row.get(11)?,
                            };
                            let payload = crate::store::repos::open_json(
                                store,
                                &sealed,
                                &format!("thread:{id}"),
                            )
                            .map_err(|_| rusqlite::Error::InvalidQuery)?;
                            Ok(PortableThread {
                                id,
                                project_id: row.get(1)?,
                                owner_member_id: None,
                                title: row.get(3)?,
                                lifecycle: row.get(4)?,
                                last_sequence: row.get(5)?,
                                last_message_id: row.get(6)?,
                                selected_head_id: row.get(7)?,
                                created_at: row.get(8)?,
                                updated_at: row.get(9)?,
                                payload,
                            })
                        },
                    )?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                let mut message_stmt = tx.prepare("SELECT id,thread_id,kind,detail_kind,seq,previous_message_id,parent_message_id,idempotency_key,current_revision_id,current_revision_number,current_revision_state,created_at,payload,payload_nonce FROM message WHERE workspace_id=?1 AND deleted_at IS NULL AND thread_id IN (SELECT id FROM thread WHERE workspace_id=?1 AND deleted_at IS NULL AND project_id IS NULL AND (owner_member_id IS NULL OR owner_member_id=?2)) ORDER BY thread_id,seq")?;
                let messages = message_stmt
                    .query_map(
                        rusqlite::params![DEFAULT_WORKSPACE_ID, private.owner_member_id()],
                        |row| {
                            let id: String = row.get(0)?;
                            let detail_kind: String = row.get(3)?;
                            let current_state: String = row.get(10)?;
                            if !inert_history_state(&current_state) {
                                return Err(rusqlite::Error::InvalidQuery);
                            }
                            let sealed = crate::store::vault::Sealed {
                                ciphertext: row.get(12)?,
                                nonce: row.get(13)?,
                            };
                            let payload = crate::store::repos::open_json(
                                store,
                                &sealed,
                                &format!("message:{id}"),
                            )
                            .map_err(|_| rusqlite::Error::InvalidQuery)?;
                            Ok(PortableMessage {
                                id,
                                thread_id: row.get(1)?,
                                kind: row.get(2)?,
                                detail_kind: sanitize_detail_kind(&detail_kind),
                                seq: row.get(4)?,
                                previous_message_id: row.get(5)?,
                                parent_message_id: row.get(6)?,
                                idempotency_key: row.get(7)?,
                                current_revision_id: row.get(8)?,
                                current_revision_number: row.get(9)?,
                                current_revision_state: current_state,
                                created_at: row.get(11)?,
                                payload,
                            })
                        },
                    )?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                let mut revision_stmt = tx.prepare("SELECT id,thread_id,message_id,revision_number,base_revision_number,previous_revision_id,state,reason,idempotency_key,checkpointed_at,run_id,payload,payload_nonce FROM message_revision WHERE workspace_id=?1 AND thread_id IN (SELECT id FROM thread WHERE workspace_id=?1 AND deleted_at IS NULL AND project_id IS NULL AND (owner_member_id IS NULL OR owner_member_id=?2)) AND message_id IN (SELECT id FROM message WHERE workspace_id=?1 AND deleted_at IS NULL) ORDER BY thread_id,message_id,revision_number")?;
                let revisions = revision_stmt
                    .query_map(
                        rusqlite::params![DEFAULT_WORKSPACE_ID, private.owner_member_id()],
                        |row| {
                            let id: String = row.get(0)?;
                            let state: String = row.get(6)?;
                            let sealed = crate::store::vault::Sealed {
                                ciphertext: row.get(11)?,
                                nonce: row.get(12)?,
                            };
                            let payload = crate::store::repos::open_json(
                                store,
                                &sealed,
                                &format!("message-revision:{DEFAULT_WORKSPACE_ID}:{id}"),
                            )
                            .map_err(|_| rusqlite::Error::InvalidQuery)?;
                            Ok(PortableMessageRevision {
                                id,
                                thread_id: row.get(1)?,
                                message_id: row.get(2)?,
                                revision_number: row.get(3)?,
                                base_revision_number: row.get(4)?,
                                previous_revision_id: row.get(5)?,
                                state,
                                reason: row.get(7)?,
                                idempotency_key: row.get(8)?,
                                checkpointed_at: row.get(9)?,
                                run_id: None,
                                payload,
                            })
                        },
                    )?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                drop(thread_stmt);
                drop(message_stmt);
                drop(revision_stmt);
                let runtime_path = crate::paths::runtime_snapshot_path(app)
                    .map_err(crate::store::StoreError::Invalid)?;
                let memory_path = crate::paths::memory_state_path(app)
                    .map_err(crate::store::StoreError::Invalid)?;
                let knowledge_path = crate::paths::imported_knowledge_path(app)
                    .map_err(crate::store::StoreError::Invalid)?;
                let snapshot = crate::store::read_document_in_transaction::<serde_json::Value>(
                    tx, store, &runtime_path, &scope,
                )
                .map_err(crate::store::StoreError::Invalid)?;
                let memory = crate::store::read_private_document_in_transaction::<serde_json::Value>(
                    tx, store, &memory_path, &private,
                )
                .map_err(crate::store::StoreError::Invalid)?;
                let knowledge = crate::store::read_private_document_in_transaction::<serde_json::Value>(
                    tx, store, &knowledge_path, &private,
                )
                .map_err(crate::store::StoreError::Invalid)?;
                Ok((workspace_name, threads, messages, revisions, snapshot, memory, knowledge))
            })
            .map_err(|error| error.to_string())?;
    let raw_snapshot = raw_snapshot.unwrap_or_else(|| serde_json::json!({}));
    let raw_memory =
        raw_memory.unwrap_or_else(|| serde_json::json!({"disabled": false, "records": []}));
    let raw_knowledge = raw_knowledge.unwrap_or_else(|| serde_json::json!([]));
    let threads = threads
        .into_iter()
        .map(|mut thread| {
            thread.payload = sanitize_history_value(&thread.payload);
            thread
        })
        .collect();
    let messages: Vec<PortableMessage> = messages
        .into_iter()
        .map(|mut message| {
            message.payload = sanitize_history_value(&message.payload);
            message
        })
        .collect();
    let revisions = normalize_export_revisions(&messages, revisions)?;
    let memory = sanitize_memory_value(&raw_memory);
    let knowledge = sanitize_knowledge_value(&raw_knowledge);
    let snapshot = sanitize_snapshot_value(&raw_snapshot, &memory, &knowledge);
    let payload = PortableTransferPayload {
        format: TRANSFER_FORMAT.into(),
        format_version: TRANSFER_FORMAT_VERSION,
        schema_version: crate::store::schema::CURRENT_SCHEMA_VERSION,
        exported_at: chrono::Utc::now().to_rfc3339(),
        account_binding_digest: binding_digest(&binding),
        workspace_name,
        snapshot,
        memory,
        knowledge,
        threads,
        messages,
        revisions,
        omitted: transfer_omissions(),
    };
    validate_payload(&payload, &payload.account_binding_digest)
        .map_err(|error| error.to_string())?;
    Ok(payload)
}

fn empty_array(value: Option<&serde_json::Value>, key: &str) -> bool {
    value
        .and_then(|value| value.get(key))
        .and_then(serde_json::Value::as_array)
        .is_some_and(Vec::is_empty)
}

fn empty_array_or_missing(value: Option<&serde_json::Value>, key: &str) -> bool {
    value
        .and_then(|value| value.get(key))
        .is_none_or(|value| value.as_array().is_some_and(Vec::is_empty))
}

fn bootstrap_agent(value: &serde_json::Value) -> bool {
    let Some(agent) = value.as_object() else {
        return false;
    };
    agent.get("id").and_then(serde_json::Value::as_str) == Some("chief-of-staff")
        && agent.get("name").and_then(serde_json::Value::as_str) == Some("Chief of Staff")
        && agent.get("instructions").and_then(serde_json::Value::as_str)
            == Some("Coordinate my work, keep priorities clear, and help me move from decision to execution.")
        && agent.get("modelId").and_then(serde_json::Value::as_str).is_none_or(str::is_empty)
        && agent.get("icon").and_then(serde_json::Value::as_str) == Some("agent")
        && agent.get("iconColor").and_then(serde_json::Value::as_str) == Some("#3659E3")
        && agent.get("avatarSeed").and_then(serde_json::Value::as_str)
            == Some("ink-v1:0:chief-of-staff")
        && agent.get("permissionLabel").and_then(serde_json::Value::as_str) == Some("Ask Me")
        && empty_array_or_missing(Some(value), "connectorIds")
        && empty_array_or_missing(Some(value), "knowledgeSourceIds")
        && empty_array_or_missing(Some(value), "threadIds")
        && empty_array_or_missing(Some(value), "learnedTasks")
}

fn pristine_runtime_snapshot(value: Option<&serde_json::Value>) -> bool {
    let Some(value) = value.and_then(serde_json::Value::as_object) else {
        return true;
    };
    let value = serde_json::Value::Object(value.clone());
    let agents_pristine = match value.get("agents") {
        None => true,
        Some(agents) => agents.as_array().is_some_and(|agents| {
            agents.is_empty() || (agents.len() == 1 && bootstrap_agent(&agents[0]))
        }),
    };
    value
        .get("composerDraft")
        .and_then(serde_json::Value::as_str)
        .is_none_or(str::is_empty)
        && agents_pristine
        && empty_array_or_missing(Some(&value), "approvalAudit")
        && empty_array_or_missing(Some(&value), "approvalRules")
        && empty_array_or_missing(Some(&value), "dismissedApprovalIds")
        && empty_array_or_missing(Some(&value), "connectedBackendIds")
        && empty_array_or_missing(Some(&value), "memoryRecords")
        && empty_array_or_missing(Some(&value), "importedKnowledgeSources")
        && empty_array_or_missing(Some(&value), "pinnedSourceIds")
        && empty_array_or_missing(Some(&value), "hiddenModelIds")
        && value
            .get("activeItem")
            .and_then(serde_json::Value::as_str)
            .is_none_or(|item| item == "new-chat")
        && value
            .get("activeAgentId")
            .and_then(serde_json::Value::as_str)
            .is_none_or(|agent| agent == "chief-of-staff")
        && value
            .get("onboardingComplete")
            .and_then(serde_json::Value::as_bool)
            .is_none_or(|complete| !complete)
        && value
            .get("selectedModelId")
            .and_then(serde_json::Value::as_str)
            .is_none_or(str::is_empty)
        && value
            .get("permissionMode")
            .and_then(serde_json::Value::as_str)
            .is_none_or(|mode| mode == "trusted-scope")
        && value.get("customApprovalSettings").is_none_or(|settings| {
            settings.is_null()
                || (settings
                    .get("allowSmallLocalEdits")
                    .and_then(serde_json::Value::as_bool)
                    .is_none_or(|enabled| !enabled))
                    && settings
                        .get("allowPowerfulCommands")
                        .and_then(serde_json::Value::as_bool)
                        .is_none_or(|enabled| !enabled)
        })
}

pub(super) fn ensure_empty_destination(
    conn: &rusqlite::Connection,
    store: &Store,
) -> Result<(), String> {
    let checks = [
        "SELECT COUNT(*) FROM workspace WHERE id <> 'default'",
        "SELECT COUNT(*) FROM profile",
        "SELECT COUNT(*) FROM project",
        "SELECT COUNT(*) FROM project_tombstone",
        "SELECT COUNT(*) FROM thread",
        "SELECT COUNT(*) FROM message",
        "SELECT COUNT(*) FROM message_revision",
        "SELECT COUNT(*) FROM conversation_tombstone",
        "SELECT COUNT(*) FROM conversation_ui",
        "SELECT COUNT(*) FROM collaboration_record",
        "SELECT COUNT(*) FROM local_project",
        "SELECT COUNT(*) FROM local_project_run_author",
        "SELECT COUNT(*) FROM local_schedule",
        "SELECT COUNT(*) FROM local_schedule_occurrence",
        "SELECT COUNT(*) FROM mission_approval_consumption",
        "SELECT COUNT(*) FROM routine_record",
        "SELECT COUNT(*) FROM routine_version",
        "SELECT COUNT(*) FROM routine_trigger",
        "SELECT COUNT(*) FROM routine_occurrence",
        "SELECT COUNT(*) FROM routine_driver_occurrence",
        "SELECT COUNT(*) FROM routine_migration_batch",
        "SELECT COUNT(*) FROM routine_migration_source",
        "SELECT COUNT(*) FROM routine_migration_quarantine",
        "SELECT COUNT(*) FROM routine_scheduler_authority",
        "SELECT COUNT(*) FROM routine_migration_snapshot",
        "SELECT COUNT(*) FROM routine_trigger_cursor",
        "SELECT COUNT(*) FROM output_record",
        "SELECT COUNT(*) FROM output_revision",
        "SELECT COUNT(*) FROM run",
        "SELECT COUNT(*) FROM tool_call",
        "SELECT COUNT(*) FROM approval",
        "SELECT COUNT(*) FROM audit_event",
        "SELECT COUNT(*) FROM connector_account",
        "SELECT COUNT(*) FROM connection_record",
        "SELECT COUNT(*) FROM connection_selection",
        "SELECT COUNT(*) FROM capability_grant",
        "SELECT COUNT(*) FROM mcp_local_server_config",
        "SELECT COUNT(*) FROM backend_connection",
        "SELECT COUNT(*) FROM knowledge_source",
        "SELECT COUNT(*) FROM memory_record",
        "SELECT COUNT(*) FROM knowledge_chunk",
        "SELECT COUNT(*) FROM pinned_context",
        "SELECT COUNT(*) FROM model_config",
        "SELECT COUNT(*) FROM draft",
        "SELECT COUNT(*) FROM connector_cache",
        "SELECT COUNT(*) FROM connector_cache_settings",
        "SELECT COUNT(*) FROM connector_cache_tombstone",
        "SELECT COUNT(*) FROM connection_legacy_unattributed",
        "SELECT COUNT(*) FROM backend_connection_legacy_unowned",
        "SELECT COUNT(*) FROM provider_route_observation",
        "SELECT COUNT(*) FROM provider_route_quality_observation",
        "SELECT COUNT(*) FROM knowledge_tombstone",
        "SELECT COUNT(*) FROM memory_tombstone",
        "SELECT COUNT(*) FROM private_context_legacy_unowned",
        "SELECT COUNT(*) FROM scheduled_job",
        "SELECT COUNT(*) FROM scheduler_queue_entry",
        "SELECT COUNT(*) FROM workflow_definition",
        "SELECT COUNT(*) FROM workflow_run",
        "SELECT COUNT(*) FROM cloud_workspace_link",
        "SELECT COUNT(*) FROM cloud_sync_cursor",
        "SELECT COUNT(*) FROM cloud_mutation_outbox",
        "SELECT COUNT(*) FROM cloud_record_shadow",
        "SELECT COUNT(*) FROM cloud_conflict",
    ];
    for query in checks {
        let table = query
            .strip_prefix("SELECT COUNT(*) FROM ")
            .and_then(|rest| rest.split_whitespace().next())
            .unwrap_or_default();
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                [table],
                |row| row.get(0),
            )
            .map_err(|_| "Mivlet cannot verify that the destination is empty.".to_string())?;
        if !exists {
            continue;
        }
        let count: i64 = conn
            .query_row(query, [], |row| row.get(0))
            .map_err(|_| "Mivlet cannot verify that the destination is empty.".to_string())?;
        if count != 0 {
            return Err("Portable transfer import requires an empty destination. Existing local data was left untouched.".into());
        }
    }
    let preferences_exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='preferences')",
            [],
            |row| row.get(0),
        )
        .map_err(|_| "Mivlet cannot verify that the destination is empty.".to_string())?;
    if preferences_exists {
        let mut preferences = conn
            .prepare("SELECT key FROM preferences WHERE workspace_id=?1")
            .map_err(|_| "Mivlet cannot verify that the destination is empty.".to_string())?;
        let keys = preferences
            .query_map([DEFAULT_WORKSPACE_ID], |row| row.get::<_, String>(0))
            .map_err(|_| "Mivlet cannot verify that the destination is empty.".to_string())?;
        for key in keys {
            let key =
                key.map_err(|_| "Mivlet cannot verify that the destination is empty.".to_string())?;
            let bootstrap = matches!(key.as_str(), "theme" | "document:runtime-snapshot.json")
                || (key.starts_with("document:owner:")
                    && (key.ends_with("memory-state.json")
                        || key.ends_with("imported-knowledge.json")));
            if !bootstrap {
                return Err("Portable transfer import requires an empty destination. Existing local preferences were left untouched.".into());
            }
            let scope = DataScope::workspace(DEFAULT_WORKSPACE_ID.to_string())
                .map_err(|error| error.to_string())?;
            let value = crate::store::repos::preferences::get_scoped(conn, store, &scope, &key)
                .map_err(|_| "Mivlet cannot verify that the destination is empty.".to_string())?;
            let pristine = match key.as_str() {
                "theme" => value
                    .as_ref()
                    .and_then(serde_json::Value::as_str)
                    .is_none_or(|theme| matches!(theme, "light" | "dark")),
                "document:runtime-snapshot.json" => pristine_runtime_snapshot(value.as_ref()),
                key if key.ends_with("memory-state.json") => value
                    .as_ref()
                    .is_none_or(|value| empty_array(Some(value), "records")),
                key if key.ends_with("imported-knowledge.json") => value
                    .as_ref()
                    .is_none_or(|value| value.as_array().is_some_and(Vec::is_empty)),
                _ => false,
            };
            if !pristine {
                return Err("Portable transfer import requires an empty destination. Existing bootstrap documents were left untouched.".into());
            }
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Copy)]
pub(super) struct AppliedTransferCounts {
    pub agents: usize,
    pub memory_records: usize,
    pub knowledge_sources: usize,
}

/// Apply a decrypted allow-listed payload in the caller's transaction. Every
/// imported row is re-encrypted through the destination Store vault and every
/// document is rebound to the destination private owner before commit.
pub(super) fn apply_payload(
    tx: &rusqlite::Transaction<'_>,
    store: &Store,
    payload: &PortableTransferPayload,
    scope: &DataScope,
    private: &PrivateDataScope,
    runtime_path: &Path,
    memory_path: &Path,
    knowledge_path: &Path,
) -> crate::store::Result<AppliedTransferCounts> {
    let memory = sanitize_memory_value(&payload.memory);
    let knowledge = sanitize_knowledge_value(&payload.knowledge);
    let snapshot = sanitize_snapshot_value(&payload.snapshot, &memory, &knowledge);
    validate_sanitized_documents(&snapshot, &memory, &knowledge)
        .map_err(crate::store::StoreError::Invalid)?;

    crate::store::repos::workspace::upsert(
        tx,
        DEFAULT_WORKSPACE_ID,
        &payload.workspace_name,
        &chrono::Utc::now().to_rfc3339(),
    )?;
    for thread in &payload.threads {
        let history_payload = sanitize_history_value(&thread.payload);
        let sealed = crate::store::repos::seal_json(
            store,
            &history_payload,
            &format!("thread:{}", thread.id),
        )?;
        tx.execute(
            "INSERT INTO thread(id,workspace_id,project_id,title,lifecycle,last_sequence,last_message_id,selected_head_id,owner_member_id,created_at,updated_at,payload,payload_nonce) VALUES(?1,?2,NULL,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            rusqlite::params![thread.id, DEFAULT_WORKSPACE_ID, thread.title, thread.lifecycle, thread.last_sequence, thread.last_message_id, thread.selected_head_id, private.owner_member_id(), thread.created_at, thread.updated_at, sealed.ciphertext, sealed.nonce],
        )?;
    }
    for message in &payload.messages {
        if !inert_history_state(&message.current_revision_state) {
            return Err(crate::store::StoreError::Invalid(
                "Portable transfer contains an active conversation revision.".into(),
            ));
        }
        let history_payload = sanitize_history_value(&message.payload);
        let sealed = crate::store::repos::seal_json(
            store,
            &history_payload,
            &format!("message:{}", message.id),
        )?;
        tx.execute(
            "INSERT INTO message(id,workspace_id,thread_id,kind,run_id,detail_kind,seq,previous_message_id,parent_message_id,idempotency_key,current_revision_id,current_revision_number,current_revision_state,owner_member_id,created_at,payload,payload_nonce) VALUES(?1,?2,?3,?4,NULL,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",
            rusqlite::params![message.id, DEFAULT_WORKSPACE_ID, message.thread_id, message.kind, sanitize_detail_kind(&message.detail_kind), message.seq, message.previous_message_id, message.parent_message_id, message.idempotency_key, message.current_revision_id, message.current_revision_number, message.current_revision_state, private.owner_member_id(), message.created_at, sealed.ciphertext, sealed.nonce],
        )?;
    }
    for revision in &payload.revisions {
        if !inert_history_state(&revision.state) {
            return Err(crate::store::StoreError::Invalid(
                "Portable transfer contains an active conversation revision.".into(),
            ));
        }
        let history_payload = sanitize_history_value(&revision.payload);
        let sealed = crate::store::repos::seal_json(
            store,
            &history_payload,
            &format!("message-revision:{DEFAULT_WORKSPACE_ID}:{}", revision.id),
        )?;
        tx.execute(
            "INSERT INTO message_revision(id,workspace_id,thread_id,message_id,revision_number,base_revision_number,previous_revision_id,state,reason,idempotency_key,checkpointed_at,run_id,owner_member_id,created_at,payload,payload_nonce) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,NULL,?12,?13,?14,?15)",
            rusqlite::params![revision.id, DEFAULT_WORKSPACE_ID, revision.thread_id, revision.message_id, revision.revision_number, revision.base_revision_number, revision.previous_revision_id, revision.state, revision.reason, revision.idempotency_key, revision.checkpointed_at, private.owner_member_id(), revision.checkpointed_at, sealed.ciphertext, sealed.nonce],
        )?;
    }
    crate::store::write_document_in_transaction(tx, store, runtime_path, scope, &snapshot)
        .map_err(crate::store::StoreError::Invalid)?;
    crate::store::write_private_document_in_transaction(tx, store, memory_path, private, &memory)
        .map_err(crate::store::StoreError::Invalid)?;
    crate::store::write_private_document_in_transaction(
        tx,
        store,
        knowledge_path,
        private,
        &knowledge,
    )
    .map_err(crate::store::StoreError::Invalid)?;
    Ok(AppliedTransferCounts {
        agents: value_count(&snapshot, "agents"),
        memory_records: value_count(&memory, "records"),
        knowledge_sources: knowledge.as_array().map_or(0, Vec::len),
    })
}
