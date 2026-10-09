//! Native command boundary for SQLite-authoritative conversations. Webview
//! callers may name records, but never select their workspace owner.

use crate::store::repos::{message, scope::DataScope, thread};
use chrono::{SecondsFormat, Utc};
use serde::Deserialize;
use serde_json::Value;

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn scope() -> Result<DataScope, String> {
    DataScope::workspace(crate::store::repos::scope::DEFAULT_WORKSPACE_ID)
        .map_err(|error| error.to_string())
}
fn validate_workspace(expected_workspace_id: Option<&str>, action: &str) -> Result<(), String> {
    if expected_workspace_id
        .is_some_and(|id| id != crate::store::repos::scope::DEFAULT_WORKSPACE_ID)
    {
        return Err(format!(
            "The selected workspace changed before the draft was {action}."
        ));
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateThread {
    pub id: String,
    pub project_id: Option<String>,
    pub title: String,
    pub payload: Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateThread {
    pub thread_id: String,
    pub title: Option<String>,
    pub lifecycle: Option<String>,
    pub project_id: Option<Option<String>>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendMessage {
    pub thread_id: String,
    pub message_id: String,
    pub kind: String,
    #[serde(default)]
    pub detail: Value,
    pub run_id: Option<String>,
    pub expected_last_sequence: i64,
    pub sequence: i64,
    pub previous_message_id: Option<String>,
    pub parent_message_id: Option<String>,
    pub edit_source_message_id: Option<String>,
    pub idempotency_key: String,
    pub revision_id: String,
    pub state: String,
    pub reason: String,
    pub content: Value,
    pub checkpointed_at: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviseMessage {
    pub thread_id: String,
    pub message_id: String,
    pub revision_id: String,
    pub base_message_revision_number: i64,
    pub previous_revision_id: Option<String>,
    pub idempotency_key: String,
    pub state: String,
    pub reason: String,
    pub content: Value,
    pub run_id: Option<String>,
    pub checkpointed_at: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectBranch {
    pub thread_id: String,
    pub head_id: Option<String>,
    pub expected_head_id: Option<String>,
    pub expected_last_sequence: i64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListMessagesPage {
    pub thread_id: String,
    pub limit: Option<i64>,
    pub before_sequence: Option<i64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftInput {
    pub thread_id: Option<String>,
    pub id: String,
    pub payload: Value,
}
#[tauri::command]
pub fn conversation_create_thread(
    input: CreateThread,
    expected_workspace_id: Option<String>,
) -> Result<thread::ThreadRow, String> {
    if expected_workspace_id
        .as_deref()
        .is_some_and(|workspace_id| {
            workspace_id != crate::store::repos::scope::DEFAULT_WORKSPACE_ID
        })
    {
        return Err("The selected workspace changed before the conversation was created.".into());
    }
    if input.project_id.is_some() {
        return Err("Project-scoped conversations are no longer part of Mivlet.".into());
    }
    let store = crate::store::try_global()
        .ok_or_else(|| "Mivlet's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            let (_, member_id) = crate::account_session::principals().map_err(crate::store::StoreError::Invalid)?;
            let scope =
                DataScope::workspace(crate::store::repos::scope::DEFAULT_WORKSPACE_ID)?;
            let created = thread::create(
                tx,
                store,
                &scope,
                &input.id,
                None,
                &input.title,
                &now(),
                &input.payload,
            )?;
            let changed = tx.execute(
                "UPDATE thread SET owner_member_id=?1 WHERE workspace_id=?2 AND id=?3 AND owner_member_id IS NULL",
                rusqlite::params![member_id, scope.workspace_id(), created.id],
            )?;
            if changed != 1 {
                return Err(crate::store::StoreError::Invalid(
                    "Conversation ownership could not be established.".into(),
                ));
            }
            Ok(created)
        })
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn conversation_list_threads() -> Result<Vec<thread::ThreadRow>, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Mivlet's encrypted store is not initialized.".to_string())?;
    let scope = scope()?;
    store
        .with_conn(|tx| thread::list(tx, store, &scope))
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn conversation_get_thread(thread_id: String) -> Result<Option<thread::ThreadRow>, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Mivlet's encrypted store is not initialized.".to_string())?;
    let scope = scope()?;
    store
        .with_conn(|tx| thread::get(tx, store, &scope, &thread_id))
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn conversation_update_thread(input: UpdateThread) -> Result<thread::ThreadRow, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Mivlet's encrypted store is not initialized.".to_string())?;
    let scope = scope()?;
    store
        .transaction(|tx| {
            thread::update(
                tx,
                store,
                &scope,
                &input.thread_id,
                input.title.as_deref(),
                input.lifecycle.as_deref(),
                input.project_id.as_ref().map(|v| v.as_deref()),
                &now(),
            )
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn conversation_select_branch(
    window: tauri::WebviewWindow,
    input: SelectBranch,
) -> Result<thread::ThreadRow, String> {
    if window.label() != "main" {
        return Err("Select conversations from the Mivlet window.".into());
    }
    let store = crate::store::try_global()
        .ok_or_else(|| "Mivlet's encrypted store is not initialized.".to_string())?;
    let scope = scope()?;
    store
        .transaction(|tx| {
            crate::collaboration::ensure_conversation_idle(tx, store, &input.thread_id)?;
            let current = thread::get(tx, store, &scope, &input.thread_id)?.ok_or_else(|| crate::store::StoreError::Invalid("Conversation unavailable.".into()))?;
            if current.last_sequence != input.expected_last_sequence || current.selected_head_id.as_ref().or(current.last_message_id.as_ref()) != input.expected_head_id.as_ref() {
                return Err(crate::store::StoreError::Invalid("The selected conversation changed in another pane. Reload before switching alternatives.".into()));
            }
            thread::select_head(tx, store, &scope, &input.thread_id, input.head_id.as_deref(), &now())
        })
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn conversation_list_messages(thread_id: String) -> Result<Vec<message::MessageRow>, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Mivlet's encrypted store is not initialized.".to_string())?;
    let scope = scope()?;
    store
        .with_conn(|tx| message::list(tx, store, &scope, &thread_id))
        .map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagePage {
    pub messages: Vec<message::MessageRow>,
    pub older_cursor: Option<String>,
    pub has_older_messages: bool,
    pub branch_heads: Vec<String>,
}

#[tauri::command]
pub fn conversation_list_messages_page(input: ListMessagesPage) -> Result<MessagePage, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Mivlet's encrypted store is not initialized.".to_string())?;
    let scope = scope()?;
    let limit = input.limit.unwrap_or(80).clamp(1, 200);
    store
        .with_conn(|tx| {
            let messages = crate::store::repos::message::list_before(
                tx,
                store,
                &scope,
                &input.thread_id,
                limit + 1,
                input.before_sequence,
            )?;
            let has_older_messages = messages.len() > limit as usize;
            let mut messages = messages;
            if has_older_messages {
                messages.remove(0);
            }
            let older_cursor = messages
                .first()
                .filter(|_| has_older_messages)
                .map(|message| message.sequence.to_string());
            let mut branch_heads = message::list_branch_heads(tx, &scope, &input.thread_id, 512)?;
            if let Some(thread) = thread::get(tx, store, &scope, &input.thread_id)? {
                if let Some(selected) = thread.selected_head_id.or(thread.last_message_id) {
                    if !branch_heads.iter().any(|head| head == &selected) {
                        branch_heads.push(selected);
                    }
                }
            }
            Ok(MessagePage {
                messages,
                older_cursor,
                has_older_messages,
                branch_heads,
            })
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn conversation_delete_thread(
    window: tauri::WebviewWindow,
    thread_id: String,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Delete conversations from the Mivlet window.".into());
    }
    let store = crate::store::try_global()
        .ok_or_else(|| "Mivlet's encrypted store is not initialized.".to_string())?;
    let scope = scope()?;
    store
        .transaction(|tx| thread::delete(tx, &scope, &thread_id, &now()))
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn conversation_append_message(input: AppendMessage) -> Result<message::MessageRow, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Mivlet's encrypted store is not initialized.".to_string())?;
    let scope = scope()?;
    let at = input.checkpointed_at.unwrap_or_else(now);
    store
        .transaction(|tx| {
            crate::collaboration::ensure_run_current(tx, store, input.run_id.as_deref())?;
            let edit_parent = input
                .edit_source_message_id
                .as_deref()
                .map(|source| {
                    if input.kind != "user" {
                        return Err(crate::store::StoreError::Invalid(
                            "Only user messages can be edited.".into(),
                        ));
                    }
                    message::edit_parent(tx, store, &scope, &input.thread_id, source)
                })
                .transpose()?;
            message::append_with_parent(
                tx,
                store,
                &scope,
                &input.thread_id,
                &input.message_id,
                &input.kind,
                &input.detail,
                input.run_id.as_deref(),
                input.sequence,
                input.expected_last_sequence,
                input.previous_message_id.as_deref(),
                edit_parent
                    .as_ref()
                    .map(|parent| parent.as_deref())
                    .or_else(|| input.parent_message_id.as_deref().map(Some)),
                &input.idempotency_key,
                &input.revision_id,
                &input.state,
                &input.reason,
                &input.content,
                &at,
            )
        })
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn conversation_revise_message(input: ReviseMessage) -> Result<message::MessageRow, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Mivlet's encrypted store is not initialized.".to_string())?;
    let scope = scope()?;
    let at = input.checkpointed_at.unwrap_or_else(now);
    store
        .transaction(|tx| {
            crate::collaboration::ensure_run_current(tx, store, input.run_id.as_deref())?;
            message::revise(
                tx,
                store,
                &scope,
                &input.thread_id,
                &input.message_id,
                &input.revision_id,
                input.base_message_revision_number,
                input.previous_revision_id.as_deref(),
                &input.idempotency_key,
                &input.state,
                &input.reason,
                &input.content,
                input.run_id.as_deref(),
                &at,
            )
        })
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn conversation_load_draft(
    thread_id: Option<String>,
    id: String,
    expected_workspace_id: Option<String>,
) -> Result<Option<Value>, String> {
    validate_workspace(expected_workspace_id.as_deref(), "loaded")?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Mivlet's encrypted store is not initialized.".to_string())?;
    let scope = scope()?;
    store
        .with_conn(|tx| {
            crate::store::repos::draft::get_scoped(tx, store, &scope, thread_id.as_deref(), &id)
        })
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn conversation_save_draft(
    input: DraftInput,
    expected_workspace_id: Option<String>,
) -> Result<(), String> {
    validate_workspace(expected_workspace_id.as_deref(), "saved")?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Mivlet's encrypted store is not initialized.".to_string())?;
    let scope = scope()?;
    store
        .transaction(|tx| {
            crate::store::repos::draft::upsert_scoped(
                tx,
                store,
                &scope,
                input.thread_id.as_deref(),
                &input.id,
                &input.payload,
                &now(),
            )
        })
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn conversation_delete_draft(thread_id: Option<String>, id: String) -> Result<(), String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Mivlet's encrypted store is not initialized.".to_string())?;
    let scope = scope()?;
    store
        .transaction(|tx| {
            crate::store::repos::draft::delete_scoped(tx, &scope, thread_id.as_deref(), &id)
        })
        .map_err(|e| e.to_string())
}
