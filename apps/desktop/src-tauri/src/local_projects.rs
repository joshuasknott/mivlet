//! Small member-private project rooms shared by every local named agent.
//!
//! A project owns one ordinary durable conversation thread. It widens neither
//! human visibility nor provider/tool authority; run attribution is captured
//! before work begins and is immutable for that run.

use crate::authorized_scope::{self, AuthorizedCommandScope, ScopeAccess};
use crate::collaboration::models::{Author, ChatBinding, Conversation, Participant, Team, Work};
use crate::models::MivletAgentProfile;
use crate::store::repos::collaboration::{self as collab, Kind};
use crate::store::repos::local_project::{self as repo, LocalProjectRow, LocalProjectRunAuthorRow};
use crate::store::repos::{execution_attempt, thread};
use crate::store::{Store, StoreError};
use serde::{Deserialize, Serialize};

const MAX_PROJECTS: i64 = 128;
const MAX_ID_CHARACTERS: usize = 128;
const MAX_NAME_CHARACTERS: usize = 120;
const MAX_INSTRUCTIONS_CHARACTERS: usize = 12_000;
const MAX_KNOWLEDGE_SOURCES: usize = 64;
const MAX_SHARES: usize = 64;
const MAX_SHARE_TEXT_CHARACTERS: usize = 32_000;
const MAX_SHARE_TITLE_CHARACTERS: usize = 200;
const MAX_REVISION_CHARACTERS: usize = 200;
const PROJECT_LIST_LIMIT: usize = 128;
const AUTHOR_LIST_LIMIT: usize = 500;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct LocalProjectPayload {
    name: String,
    instructions: String,
    knowledge_source_ids: Vec<String>,
    #[serde(default)]
    shares: Vec<ProjectShare>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectShareSource {
    pub workspace_id: String,
    pub kind: String,
    pub id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectShareRecipient {
    pub kind: String,
    pub id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectShareOwner {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub name: String,
}

/// Explicit sharing never conveys tool authority. Snapshots retain the selected
/// bytes; live references resolve again under the current account on each use.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectShare {
    pub id: String,
    pub mode: String,
    pub source: ProjectShareSource,
    pub source_revision: String,
    pub recipient: ProjectShareRecipient,
    pub owner: ProjectShareOwner,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot_text: Option<String>,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RunAuthorPayload {
    agent_name: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalProject {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub instructions: String,
    pub knowledge_source_ids: Vec<String>,
    pub shares: Vec<ProjectShare>,
    pub thread_id: String,
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalProjectRunAuthor {
    pub project_id: String,
    pub run_id: String,
    pub agent_id: String,
    pub agent_name: String,
    pub thread_id: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateLocalProjectRequest {
    pub workspace_id: String,
    pub id: String,
    pub thread_id: String,
    pub name: String,
    #[serde(default)]
    pub instructions: String,
    #[serde(default)]
    pub knowledge_source_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateLocalProjectRequest {
    pub workspace_id: String,
    pub id: String,
    pub expected_revision: i64,
    pub name: String,
    #[serde(default)]
    pub instructions: String,
    #[serde(default)]
    pub knowledge_source_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveLocalProjectRequest {
    pub workspace_id: String,
    pub id: String,
    pub expected_revision: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListLocalProjectsRequest {
    pub workspace_id: String,
    #[serde(default)]
    pub include_archived: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindLocalProjectRunAuthorRequest {
    pub workspace_id: String,
    pub project_id: String,
    pub expected_revision: i64,
    pub run_id: String,
    pub agent_id: String,
    pub thread_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListLocalProjectRunAuthorsRequest {
    pub workspace_id: String,
    pub project_id: String,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetLocalProjectRunAuthorRequest {
    pub workspace_id: String,
    pub project_id: String,
    pub run_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddProjectShare {
    pub mode: String,
    pub source: ProjectShareSource,
    pub source_revision: String,
    pub recipient: ProjectShareRecipient,
    pub owner: ProjectShareOwner,
    pub title: String,
    #[serde(default)]
    pub snapshot_text: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddProjectShareRequest {
    pub workspace_id: String,
    pub project_id: String,
    pub expected_revision: i64,
    pub share: AddProjectShare,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveProjectShareRequest {
    pub workspace_id: String,
    pub project_id: String,
    pub expected_revision: i64,
    pub share_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrateLegacyGroupRequest {
    pub workspace_id: String,
    /// New Project id.
    pub id: String,
    /// The legacy standalone group conversation id, which is also its thread.
    pub conversation_id: String,
    pub expected_revision: u32,
    pub name: String,
    #[serde(default)]
    pub instructions: String,
    pub participant_ids: Vec<String>,
    #[serde(default)]
    pub lead_agent_id: Option<String>,
    /// Existing history is shared with the new Project; migration never deletes it.
    pub share_history: bool,
}

mod commands;
mod helpers;
mod migration;
mod project_ops;
mod sharing;

use helpers::{
    author_from_row, global_store, next_revision, project_from_row, require_main_window,
    thread_is_owned, timestamp, validate_id, validate_id_store, validate_payload_store,
};
use migration::migrate_group_at;
use project_ops::{archive_at, bind_author_at, create_at, update_at};
use sharing::{add_share_at, remove_share_at};

#[tauri::command]
pub fn local_project_create(
    window: tauri::WebviewWindow,
    request: CreateLocalProjectRequest,
) -> Result<LocalProject, String> {
    commands::local_project_create(window, request)
}

#[tauri::command]
pub fn local_project_list(
    window: tauri::WebviewWindow,
    request: ListLocalProjectsRequest,
) -> Result<Vec<LocalProject>, String> {
    commands::local_project_list(window, request)
}

#[tauri::command]
pub fn local_project_update(
    window: tauri::WebviewWindow,
    request: UpdateLocalProjectRequest,
) -> Result<LocalProject, String> {
    commands::local_project_update(window, request)
}

#[tauri::command]
pub fn local_project_archive(
    window: tauri::WebviewWindow,
    request: ArchiveLocalProjectRequest,
) -> Result<LocalProject, String> {
    commands::local_project_archive(window, request)
}

#[tauri::command]
pub fn local_project_share_add(
    window: tauri::WebviewWindow,
    request: AddProjectShareRequest,
) -> Result<LocalProject, String> {
    commands::local_project_share_add(window, request)
}

#[tauri::command]
pub fn local_project_share_remove(
    window: tauri::WebviewWindow,
    request: RemoveProjectShareRequest,
) -> Result<LocalProject, String> {
    commands::local_project_share_remove(window, request)
}

/// Converts a legacy standalone group into a project that owns its existing
/// thread. History, run attribution and participant identity are retained.
#[tauri::command]
pub fn local_project_migrate_group(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: MigrateLegacyGroupRequest,
) -> Result<LocalProject, String> {
    commands::local_project_migrate_group(app, window, request)
}

#[tauri::command]
pub fn local_project_run_author_bind(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: BindLocalProjectRunAuthorRequest,
) -> Result<LocalProjectRunAuthor, String> {
    commands::local_project_run_author_bind(app, window, request)
}

#[tauri::command]
pub fn local_project_run_author_list(
    window: tauri::WebviewWindow,
    request: ListLocalProjectRunAuthorsRequest,
) -> Result<Vec<LocalProjectRunAuthor>, String> {
    commands::local_project_run_author_list(window, request)
}

#[tauri::command]
pub fn local_project_run_author_get(
    window: tauri::WebviewWindow,
    request: GetLocalProjectRunAuthorRequest,
) -> Result<Option<LocalProjectRunAuthor>, String> {
    commands::local_project_run_author_get(window, request)
}
pub(crate) use migration::backfill_thread_authors;
pub(crate) use sharing::capture_shares;

#[cfg(test)]
mod tests;
