//! Small, durable local schedules for one named agent.
//!
//! This module owns schedule validation and civil-time evaluation. Dispatch is
//! deliberately separate: claiming requires a native capacity reservation, and
//! a claimed occurrence still has no provider, Computer, or approval authority.

// The claim/start/finish seam is native-only and intentionally remains unused
// until the dispatcher can reserve capacity and revalidate all prerequisites.
#![allow(dead_code)]

pub(crate) mod automation;
pub(crate) mod background;
pub(crate) mod events;

use chrono::{
    DateTime, Datelike, Days, Duration, LocalResult, NaiveDateTime, NaiveTime, SecondsFormat,
    TimeZone, Utc, Weekday,
};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Mutex;

use crate::authorized_scope::{self, AuthorizedCommandScope, ScopeAccess};
use crate::store::repos::local_schedule::{self as repo, OccurrenceRow, ScheduleRow};
use crate::store::repos::scope::PrivateDataScope;
use crate::store::{Store, StoreError};

fn research_kind() -> String {
    "research".into()
}
fn read_only_permission() -> String {
    "read-only".into()
}

const MAX_SCHEDULES: i64 = 128;
const MAX_PROMPT_CHARACTERS: usize = 32_000;
const MAX_ID_CHARACTERS: usize = 96;
const MAX_PROVIDER_ID_CHARACTERS: usize = 80;
const MAX_MODEL_ID_CHARACTERS: usize = 160;
const MAX_TIMEZONE_CHARACTERS: usize = 128;
const MAX_OUTCOME_DETAIL_CHARACTERS: usize = 4_000;
const CLAIM_LEASE_MINUTES: i64 = 5;
const LIST_LIMIT: usize = 128;
const OCCURRENCE_LIST_LIMIT: usize = 20;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LocalScheduleStatus {
    Enabled,
    Paused,
    Cancelled,
}

impl LocalScheduleStatus {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Enabled => "enabled",
            Self::Paused => "paused",
            Self::Cancelled => "cancelled",
        }
    }

    fn parse(value: &str) -> crate::store::Result<Self> {
        match value {
            "enabled" => Ok(Self::Enabled),
            "paused" => Ok(Self::Paused),
            "cancelled" => Ok(Self::Cancelled),
            _ => Err(StoreError::Invalid(
                "The local schedule status is invalid.".into(),
            )),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum LocalScheduleTrigger {
    Event {
        #[serde(flatten)]
        config: events::models::EventConfig,
    },
    Once {
        #[serde(rename = "localDateTime")]
        local_date_time: String,
    },
    Daily {
        #[serde(rename = "localTime")]
        local_time: String,
    },
    Weekly {
        weekday: String,
        #[serde(rename = "localTime")]
        local_time: String,
    },
}

impl LocalScheduleTrigger {
    fn kind(&self) -> &'static str {
        match self {
            Self::Event { .. } => "event",
            Self::Once { .. } => "once",
            Self::Daily { .. } => "daily",
            Self::Weekly { .. } => "weekly",
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateLocalScheduleRequest {
    #[serde(default = "research_kind")]
    pub execution_kind: String,
    #[serde(default = "read_only_permission")]
    pub permission_mode: String,
    pub workspace_id: String,
    pub id: String,
    pub project_id: Option<String>,
    pub agent_id: String,
    pub provider_id: String,
    pub model: String,
    pub reasoning_effort: Option<String>,
    pub prompt: String,
    pub timezone: String,
    pub trigger: LocalScheduleTrigger,
    pub status: LocalScheduleStatus,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateLocalScheduleRequest {
    #[serde(default = "research_kind")]
    pub execution_kind: String,
    #[serde(default = "read_only_permission")]
    pub permission_mode: String,
    pub workspace_id: String,
    pub id: String,
    pub expected_revision: i64,
    pub project_id: Option<String>,
    pub agent_id: String,
    pub provider_id: String,
    pub model: String,
    pub reasoning_effort: Option<String>,
    pub prompt: String,
    pub timezone: String,
    pub trigger: LocalScheduleTrigger,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetLocalScheduleStatusRequest {
    pub workspace_id: String,
    pub id: String,
    pub expected_revision: i64,
    pub status: LocalScheduleStatus,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListLocalSchedulesRequest {
    pub workspace_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListLocalScheduleOccurrencesRequest {
    pub workspace_id: String,
    pub schedule_id: String,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SchedulePayload {
    #[serde(default = "research_kind")]
    pub execution_kind: String,
    #[serde(default = "read_only_permission")]
    pub permission_mode: String,
    prompt: String,
    prompt_fingerprint: String,
    prompt_revision: i64,
    timezone: String,
    trigger: LocalScheduleTrigger,
    project_id: Option<String>,
    agent_id: String,
    provider_id: String,
    model: String,
    reasoning_effort: Option<String>,
    created_by_internal_user_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct OccurrencePayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    event: Option<events::models::EventWorkOrigin>,
    #[serde(default = "research_kind")]
    pub execution_kind: String,
    #[serde(default = "read_only_permission")]
    pub permission_mode: String,
    #[serde(default)]
    work_id: Option<String>,
    prompt: String,
    prompt_fingerprint: String,
    prompt_revision: i64,
    timezone: String,
    trigger: LocalScheduleTrigger,
    project_id: Option<String>,
    agent_id: String,
    provider_id: String,
    model: String,
    reasoning_effort: Option<String>,
    intended_local_slot: String,
    capacity_reservation_fingerprint: String,
    outcome: Option<String>,
    detail: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalSchedule {
    #[serde(default = "research_kind")]
    pub execution_kind: String,
    #[serde(default = "read_only_permission")]
    pub permission_mode: String,
    pub id: String,
    pub project_id: Option<String>,
    pub agent_id: String,
    pub provider_id: String,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    pub prompt: String,
    pub timezone: String,
    pub trigger: LocalScheduleTrigger,
    pub status: LocalScheduleStatus,
    pub revision: i64,
    pub prompt_revision: i64,
    pub next_run_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalScheduleOccurrence {
    pub id: String,
    pub schedule_id: String,
    pub schedule_revision: i64,
    pub prompt_revision: i64,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_attempt_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    pub scheduled_for: String,
    pub claimed_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// Opaque proof that the future native dispatcher reserved one execution slot.
/// There is intentionally no Tauri command that manufactures this value.
#[derive(Clone, Debug)]
pub(crate) struct LocalScheduleCapacityReservation {
    id: String,
}

impl LocalScheduleCapacityReservation {
    pub(crate) fn new(id: String) -> Result<Self, String> {
        validate_bounded_id(&id, "Capacity reservation", MAX_ID_CHARACTERS)?;
        Ok(Self { id })
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalScheduleClaim {
    #[serde(default = "research_kind")]
    pub execution_kind: String,
    #[serde(default = "read_only_permission")]
    pub permission_mode: String,
    pub occurrence_id: String,
    pub schedule_id: String,
    pub schedule_revision: i64,
    pub prompt_revision: i64,
    pub scheduled_for: String,
    pub claim_token: String,
    pub lease_expires_at: String,
    pub project_id: Option<String>,
    pub agent_id: String,
    pub provider_id: String,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    pub prompt: String,
}

#[derive(Default)]
pub struct LocalScheduleDispatchCoordinator {
    active: Mutex<Option<ActiveDispatch>>,
}

#[derive(Clone, Debug)]
struct ActiveDispatch {
    workspace_id: String,
    occurrence_id: String,
    claim_token: String,
    lease_expires_at: String,
    attempt_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimLocalScheduleDispatchRequest {
    pub workspace_id: String,
    pub expected_schedule_id: String,
    pub expected_revision: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindLocalScheduleDispatchRequest {
    pub workspace_id: String,
    pub occurrence_id: String,
    pub claim_token: String,
    pub attempt_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenewLocalScheduleDispatchRequest {
    pub workspace_id: String,
    pub occurrence_id: String,
    pub claim_token: String,
    pub attempt_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishLocalScheduleDispatchRequest {
    pub workspace_id: String,
    pub occurrence_id: String,
    pub claim_token: String,
    pub attempt_id: String,
    pub outcome: String,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AbandonLocalScheduleDispatchRequest {
    pub workspace_id: String,
    pub occurrence_id: String,
    pub claim_token: String,
    pub detail: String,
}

#[derive(Clone, Debug)]
struct CivilSlot {
    key: String,
    instant: DateTime<Utc>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewLocalScheduleRequest {
    timezone: String,
    trigger: LocalScheduleTrigger,
}

mod civil_time;
mod commands;
mod validation;
use civil_time::*;
use commands::{
    create_at, global_store, require_main_window, resolve_private_scope, set_status_at, update_at,
    validate_dispatch_identity,
};
use validation::*;

#[cfg(test)]
pub(crate) use commands::{bind_claim_to_pending_attempt, claim_due_after_capacity};
pub(crate) use commands::{finish_bound_occurrence, renew_bound_occurrence_lease};

/// Pure civil-time preview using the same rules as saving and dispatching.
#[tauri::command]
pub fn local_schedule_preview(
    request: PreviewLocalScheduleRequest,
) -> Result<Option<String>, String> {
    commands::local_schedule_preview(request)
}

#[tauri::command]
pub fn local_schedule_create(request: CreateLocalScheduleRequest) -> Result<LocalSchedule, String> {
    commands::local_schedule_create(request)
}

#[tauri::command]
pub fn local_schedule_update(request: UpdateLocalScheduleRequest) -> Result<LocalSchedule, String> {
    commands::local_schedule_update(request)
}

#[tauri::command]
pub fn local_schedule_set_status(
    request: SetLocalScheduleStatusRequest,
) -> Result<LocalSchedule, String> {
    commands::local_schedule_set_status(request)
}

#[tauri::command]
pub fn local_schedule_list(
    request: ListLocalSchedulesRequest,
) -> Result<Vec<LocalSchedule>, String> {
    commands::local_schedule_list(request)
}

#[tauri::command]
pub fn local_schedule_occurrence_list(
    request: ListLocalScheduleOccurrencesRequest,
) -> Result<Vec<LocalScheduleOccurrence>, String> {
    commands::local_schedule_occurrence_list(request)
}

/// Reserve the process-wide serial dispatcher slot and atomically claim the
/// exact due definition the renderer already validated. This is a main-window
/// orchestration command, not a model-callable tool.
#[tauri::command]
pub fn local_schedule_dispatch_claim(
    window: tauri::WebviewWindow,
    coordinator: tauri::State<'_, LocalScheduleDispatchCoordinator>,
    request: ClaimLocalScheduleDispatchRequest,
) -> Result<Option<LocalScheduleClaim>, String> {
    commands::local_schedule_dispatch_claim(window, coordinator, request)
}

#[tauri::command]
pub fn local_schedule_dispatch_bind(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    coordinator: tauri::State<'_, LocalScheduleDispatchCoordinator>,
    request: BindLocalScheduleDispatchRequest,
) -> Result<String, String> {
    commands::local_schedule_dispatch_bind(app, window, coordinator, request)
}

#[tauri::command]
pub fn local_schedule_dispatch_renew(
    window: tauri::WebviewWindow,
    coordinator: tauri::State<'_, LocalScheduleDispatchCoordinator>,
    request: RenewLocalScheduleDispatchRequest,
) -> Result<String, String> {
    commands::local_schedule_dispatch_renew(window, coordinator, request)
}

#[tauri::command]
pub fn local_schedule_dispatch_finish(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    coordinator: tauri::State<'_, LocalScheduleDispatchCoordinator>,
    request: FinishLocalScheduleDispatchRequest,
) -> Result<(), String> {
    commands::local_schedule_dispatch_finish(app, window, coordinator, request)
}

#[tauri::command]
pub fn local_schedule_dispatch_abandon(
    window: tauri::WebviewWindow,
    coordinator: tauri::State<'_, LocalScheduleDispatchCoordinator>,
    request: AbandonLocalScheduleDispatchRequest,
) -> Result<(), String> {
    commands::local_schedule_dispatch_abandon(window, coordinator, request)
}

#[cfg(test)]
#[path = "local_schedules/tests.rs"]
mod tests;
