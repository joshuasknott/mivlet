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
        return Err("Project-scoped conversations are no longer part of Fable.".into());
    }
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            let (_, member_id) = crate::account_workspace::local_install_principals();
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
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let scope = scope()?;
    store
        .with_conn(|tx| thread::list(tx, store, &scope))
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn conversation_get_thread(thread_id: String) -> Result<Option<thread::ThreadRow>, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let scope = scope()?;
    store
        .with_conn(|tx| thread::get(tx, store, &scope, &thread_id))
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn conversation_update_thread(input: UpdateThread) -> Result<thread::ThreadRow, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
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
pub fn conversation_list_messages(thread_id: String) -> Result<Vec<message::MessageRow>, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let scope = scope()?;
    store
        .with_conn(|tx| message::list(tx, store, &scope, &thread_id))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn conversation_delete_thread(
    window: tauri::WebviewWindow,
    thread_id: String,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Delete conversations from the Fable window.".into());
    }
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let scope = scope()?;
    store
        .transaction(|tx| thread::delete(tx, &scope, &thread_id, &now()))
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn conversation_append_message(input: AppendMessage) -> Result<message::MessageRow, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let scope = scope()?;
    let at = input.checkpointed_at.unwrap_or_else(now);
    store
        .transaction(|tx| {
            message::append(
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
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let scope = scope()?;
    let at = input.checkpointed_at.unwrap_or_else(now);
    store
        .transaction(|tx| {
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
) -> Result<Option<Value>, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let scope = scope()?;
    store
        .with_conn(|tx| {
            crate::store::repos::draft::get_scoped(tx, store, &scope, thread_id.as_deref(), &id)
        })
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn conversation_save_draft(input: DraftInput) -> Result<(), String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
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
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let scope = scope()?;
    store
        .transaction(|tx| {
            crate::store::repos::draft::delete_scoped(tx, &scope, thread_id.as_deref(), &id)
        })
        .map_err(|e| e.to_string())
}
