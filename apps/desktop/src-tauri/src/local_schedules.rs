//! Small, durable local schedules for one named agent.
//!
//! This module owns schedule validation and civil-time evaluation. Dispatch is
//! deliberately separate: claiming requires a native capacity reservation, and
//! a claimed occurrence still has no provider, Computer, or approval authority.

// The claim/start/finish seam is native-only and intentionally remains unused
// until the dispatcher can reserve capacity and revalidate all prerequisites.
#![allow(dead_code)]

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
            Self::Once { .. } => "once",
            Self::Daily { .. } => "daily",
            Self::Weekly { .. } => "weekly",
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateLocalScheduleRequest {
    pub workspace_id: String,
    pub id: String,
    pub agent_id: String,
    pub provider_id: String,
    pub model: String,
    pub prompt: String,
    pub timezone: String,
    pub trigger: LocalScheduleTrigger,
    pub status: LocalScheduleStatus,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateLocalScheduleRequest {
    pub workspace_id: String,
    pub id: String,
    pub expected_revision: i64,
    pub agent_id: String,
    pub provider_id: String,
    pub model: String,
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
    prompt: String,
    prompt_fingerprint: String,
    prompt_revision: i64,
    timezone: String,
    trigger: LocalScheduleTrigger,
    agent_id: String,
    provider_id: String,
    model: String,
    created_by_internal_user_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct OccurrencePayload {
    prompt: String,
    prompt_fingerprint: String,
    prompt_revision: i64,
    timezone: String,
    trigger: LocalScheduleTrigger,
    agent_id: String,
    provider_id: String,
    model: String,
    intended_local_slot: String,
    capacity_reservation_fingerprint: String,
    outcome: Option<String>,
    detail: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalSchedule {
    pub id: String,
    pub agent_id: String,
    pub provider_id: String,
    pub model: String,
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
    pub occurrence_id: String,
    pub schedule_id: String,
    pub schedule_revision: i64,
    pub prompt_revision: i64,
    pub scheduled_for: String,
    pub claim_token: String,
    pub lease_expires_at: String,
    pub agent_id: String,
    pub provider_id: String,
    pub model: String,
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

#[tauri::command]
pub fn local_schedule_create(request: CreateLocalScheduleRequest) -> Result<LocalSchedule, String> {
    let now = Utc::now();
    let store = global_store()?;
    let schedule = store
        .transaction(|tx| {
            let scope = authorized_scope::resolve(
                tx,
                Some(&request.workspace_id),
                None,
                ScopeAccess::Write,
            )?;
            create_at(tx, store, &scope, request, now)
        })
        .map_err(|error| error.to_string())?;
    record_schedule_change(&schedule, "create");
    Ok(schedule)
}

#[tauri::command]
pub fn local_schedule_update(request: UpdateLocalScheduleRequest) -> Result<LocalSchedule, String> {
    let now = Utc::now();
    let store = global_store()?;
    let schedule = store
        .transaction(|tx| {
            let scope = authorized_scope::resolve(
                tx,
                Some(&request.workspace_id),
                None,
                ScopeAccess::Write,
            )?;
            update_at(tx, store, &scope, request, now)
        })
        .map_err(|error| error.to_string())?;
    record_schedule_change(&schedule, "update");
    Ok(schedule)
}

#[tauri::command]
pub fn local_schedule_set_status(
    request: SetLocalScheduleStatusRequest,
) -> Result<LocalSchedule, String> {
    let now = Utc::now();
    let store = global_store()?;
    let schedule = store
        .transaction(|tx| {
            let scope = authorized_scope::resolve(
                tx,
                Some(&request.workspace_id),
                None,
                ScopeAccess::Write,
            )?;
            set_status_at(tx, store, &scope, request, now)
        })
        .map_err(|error| error.to_string())?;
    record_schedule_change(&schedule, schedule.status.as_str());
    Ok(schedule)
}

#[tauri::command]
pub fn local_schedule_list(
    request: ListLocalSchedulesRequest,
) -> Result<Vec<LocalSchedule>, String> {
    let store = global_store()?;
    store
        .with_conn(|conn| {
            let scope = authorized_scope::resolve(
                conn,
                Some(&request.workspace_id),
                None,
                ScopeAccess::Read,
            )?;
            repo::list_schedules(conn, store, &scope.private, LIST_LIMIT)?
                .into_iter()
                .map(schedule_from_row)
                .collect()
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn local_schedule_occurrence_list(
    request: ListLocalScheduleOccurrencesRequest,
) -> Result<Vec<LocalScheduleOccurrence>, String> {
    validate_bounded_id(&request.schedule_id, "Schedule", MAX_ID_CHARACTERS)?;
    let store = global_store()?;
    store
        .with_conn(|conn| {
            let scope = authorized_scope::resolve(
                conn,
                Some(&request.workspace_id),
                None,
                ScopeAccess::Read,
            )?;
            let limit = request
                .limit
                .unwrap_or(OCCURRENCE_LIST_LIMIT)
                .clamp(1, OCCURRENCE_LIST_LIMIT);
            repo::list_occurrences(conn, store, &scope.private, &request.schedule_id, limit)?
                .into_iter()
                .map(|row| {
                    let thread_id = repo::occurrence_thread_id(
                        conn,
                        &scope.private,
                        row.execution_attempt_id.as_deref(),
                    )?;
                    occurrence_from_row(row, thread_id)
                })
                .collect()
        })
        .map_err(|error| error.to_string())
}

fn require_main_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Scheduled work can only run from the main Mivlet window.".into());
    }
    Ok(())
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
    require_main_window(&window)?;
    validate_bounded_id(&request.expected_schedule_id, "Schedule", MAX_ID_CHARACTERS)?;
    let now = Utc::now();
    let now_text = timestamp(now);
    let mut active = coordinator
        .active
        .lock()
        .map_err(|_| "The local schedule dispatcher is unavailable.".to_string())?;
    if active
        .as_ref()
        .is_some_and(|dispatch| dispatch.lease_expires_at > now_text)
    {
        return Ok(None);
    }
    *active = None;
    let store = global_store()?;
    let scope = resolve_private_scope(store, &request.workspace_id, ScopeAccess::Write)?;
    let reservation = LocalScheduleCapacityReservation::new(
        random_token("capacity").map_err(|error| error.to_string())?,
    )?;
    let claim = claim_due_after_capacity_matching(
        store,
        &scope,
        reservation,
        now,
        Some((&request.expected_schedule_id, request.expected_revision)),
    )
    .map_err(|error| error.to_string())?;
    if let Some(claim) = &claim {
        *active = Some(ActiveDispatch {
            workspace_id: request.workspace_id,
            occurrence_id: claim.occurrence_id.clone(),
            claim_token: claim.claim_token.clone(),
            lease_expires_at: claim.lease_expires_at.clone(),
            attempt_id: None,
        });
    }
    Ok(claim)
}

#[tauri::command]
pub fn local_schedule_dispatch_bind(
    window: tauri::WebviewWindow,
    coordinator: tauri::State<'_, LocalScheduleDispatchCoordinator>,
    request: BindLocalScheduleDispatchRequest,
) -> Result<String, String> {
    require_main_window(&window)?;
    let mut active = coordinator
        .active
        .lock()
        .map_err(|_| "The local schedule dispatcher is unavailable.".to_string())?;
    let dispatch = active
        .as_mut()
        .ok_or_else(|| "No local schedule occurrence owns the dispatcher slot.".to_string())?;
    validate_dispatch_identity(
        dispatch,
        &request.workspace_id,
        &request.occurrence_id,
        &request.claim_token,
        None,
    )?;
    let store = global_store()?;
    let scope = resolve_private_scope(store, &request.workspace_id, ScopeAccess::Write)?;
    let lease = bind_claim_to_pending_attempt(
        store,
        &scope,
        &request.occurrence_id,
        &request.claim_token,
        &request.attempt_id,
        Utc::now(),
    )
    .map_err(|error| error.to_string())?;
    dispatch.attempt_id = Some(request.attempt_id);
    dispatch.lease_expires_at = lease.clone();
    Ok(lease)
}

#[tauri::command]
pub fn local_schedule_dispatch_renew(
    window: tauri::WebviewWindow,
    coordinator: tauri::State<'_, LocalScheduleDispatchCoordinator>,
    request: RenewLocalScheduleDispatchRequest,
) -> Result<String, String> {
    require_main_window(&window)?;
    let mut active = coordinator
        .active
        .lock()
        .map_err(|_| "The local schedule dispatcher is unavailable.".to_string())?;
    let dispatch = active
        .as_mut()
        .ok_or_else(|| "No local schedule occurrence owns the dispatcher slot.".to_string())?;
    validate_dispatch_identity(
        dispatch,
        &request.workspace_id,
        &request.occurrence_id,
        &request.claim_token,
        Some(&request.attempt_id),
    )?;
    let store = global_store()?;
    let scope = resolve_private_scope(store, &request.workspace_id, ScopeAccess::Write)?;
    let lease = renew_bound_occurrence_lease(
        store,
        &scope,
        &request.occurrence_id,
        &request.claim_token,
        &request.attempt_id,
        Utc::now(),
    )
    .map_err(|error| error.to_string())?;
    dispatch.lease_expires_at = lease.clone();
    Ok(lease)
}

#[tauri::command]
pub fn local_schedule_dispatch_finish(
    window: tauri::WebviewWindow,
    coordinator: tauri::State<'_, LocalScheduleDispatchCoordinator>,
    request: FinishLocalScheduleDispatchRequest,
) -> Result<(), String> {
    require_main_window(&window)?;
    let mut active = coordinator
        .active
        .lock()
        .map_err(|_| "The local schedule dispatcher is unavailable.".to_string())?;
    let dispatch = active
        .as_ref()
        .ok_or_else(|| "No local schedule occurrence owns the dispatcher slot.".to_string())?;
    validate_dispatch_identity(
        dispatch,
        &request.workspace_id,
        &request.occurrence_id,
        &request.claim_token,
        Some(&request.attempt_id),
    )?;
    let store = global_store()?;
    let scope = resolve_private_scope(store, &request.workspace_id, ScopeAccess::Write)?;
    finish_bound_occurrence(
        store,
        &scope,
        &request.occurrence_id,
        &request.claim_token,
        &request.attempt_id,
        &request.outcome,
        request.detail.as_deref(),
        Utc::now(),
    )
    .map_err(|error| error.to_string())?;
    *active = None;
    Ok(())
}

#[tauri::command]
pub fn local_schedule_dispatch_abandon(
    window: tauri::WebviewWindow,
    coordinator: tauri::State<'_, LocalScheduleDispatchCoordinator>,
    request: AbandonLocalScheduleDispatchRequest,
) -> Result<(), String> {
    require_main_window(&window)?;
    if request.detail.chars().count() > MAX_OUTCOME_DETAIL_CHARACTERS {
        return Err("The schedule interruption detail is too long.".into());
    }
    let mut active = coordinator
        .active
        .lock()
        .map_err(|_| "The local schedule dispatcher is unavailable.".to_string())?;
    let dispatch = active
        .as_ref()
        .ok_or_else(|| "No local schedule occurrence owns the dispatcher slot.".to_string())?;
    validate_dispatch_identity(
        dispatch,
        &request.workspace_id,
        &request.occurrence_id,
        &request.claim_token,
        None,
    )?;
    if dispatch.attempt_id.is_some() {
        return Err("A bound schedule occurrence must finish through its exact attempt.".into());
    }
    let store = global_store()?;
    let scope = resolve_private_scope(store, &request.workspace_id, ScopeAccess::Write)?;
    store
        .transaction(|tx| {
            repo::interrupt_claimed(
                tx,
                store,
                &scope,
                &request.occurrence_id,
                &fingerprint(&request.claim_token),
                &request.detail,
                &timestamp(Utc::now()),
            )?;
            Ok(())
        })
        .map_err(|error| error.to_string())?;
    *active = None;
    Ok(())
}

fn validate_dispatch_identity(
    active: &ActiveDispatch,
    workspace_id: &str,
    occurrence_id: &str,
    claim_token: &str,
    attempt_id: Option<&str>,
) -> Result<(), String> {
    if active.workspace_id != workspace_id
        || active.occurrence_id != occurrence_id
        || active.claim_token != claim_token
        || attempt_id.is_some_and(|id| active.attempt_id.as_deref() != Some(id))
    {
        return Err("The local schedule dispatcher identity is stale.".into());
    }
    Ok(())
}

fn resolve_private_scope(
    store: &Store,
    workspace_id: &str,
    access: ScopeAccess,
) -> Result<PrivateDataScope, String> {
    store
        .with_conn(|conn| {
            Ok(authorized_scope::resolve(conn, Some(workspace_id), None, access)?.private)
        })
        .map_err(|error| error.to_string())
}

fn global_store() -> Result<&'static Store, String> {
    crate::store::try_global()
        .ok_or_else(|| "Mivlet's encrypted store is not initialized.".to_string())
}

fn record_schedule_change(schedule: &LocalSchedule, action: &str) {
    crate::action_history::Recorder::new("system", "local-schedule", action, "completed")
        .risk("medium")
        .mode("explicit-user-change")
        .correlation(&format!("{}-r{}", schedule.id, schedule.revision))
        .summary("A local schedule definition changed.")
        .record();
}

fn create_at(
    tx: &rusqlite::Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    request: CreateLocalScheduleRequest,
    now: DateTime<Utc>,
) -> crate::store::Result<LocalSchedule> {
    validate_bounded_id_store(&request.id, "Schedule", MAX_ID_CHARACTERS)?;
    validate_route_and_agent(&request.agent_id, &request.provider_id, &request.model)?;
    validate_prompt(&request.prompt)?;
    if request.status == LocalScheduleStatus::Cancelled {
        return Err(StoreError::Invalid(
            "A new local schedule cannot start cancelled.".into(),
        ));
    }
    if repo::count_schedules(tx, &scope.private)? >= MAX_SCHEDULES {
        return Err(StoreError::Invalid(format!(
            "This account already has the maximum of {MAX_SCHEDULES} local schedules."
        )));
    }
    let timezone = parse_timezone(&request.timezone)?;
    validate_trigger(&request.trigger)?;
    let next = if request.status == LocalScheduleStatus::Enabled {
        initial_slot(&request.trigger, timezone, now)?.map(|slot| timestamp(slot.instant))
    } else {
        initial_slot(&request.trigger, timezone, now)?.map(|slot| timestamp(slot.instant))
    };
    let now_text = timestamp(now);
    let payload = SchedulePayload {
        prompt_fingerprint: fingerprint(&request.prompt),
        prompt: request.prompt,
        prompt_revision: 1,
        timezone: request.timezone,
        trigger: request.trigger,
        agent_id: request.agent_id.clone(),
        provider_id: request.provider_id.clone(),
        model: request.model.clone(),
        created_by_internal_user_id: scope.internal_user_id.clone(),
    };
    let row = ScheduleRow {
        id: request.id,
        agent_id: request.agent_id,
        status: request.status.as_str().into(),
        trigger_kind: payload.trigger.kind().into(),
        revision: 1,
        prompt_revision: 1,
        next_run_at: next,
        created_at: now_text.clone(),
        updated_at: now_text,
        payload: encode(&payload)?,
    };
    repo::insert_schedule(tx, store, &scope.private, &row)?;
    schedule_from_row(row)
}

fn update_at(
    tx: &rusqlite::Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    request: UpdateLocalScheduleRequest,
    now: DateTime<Utc>,
) -> crate::store::Result<LocalSchedule> {
    validate_bounded_id_store(&request.id, "Schedule", MAX_ID_CHARACTERS)?;
    validate_route_and_agent(&request.agent_id, &request.provider_id, &request.model)?;
    validate_prompt(&request.prompt)?;
    validate_trigger(&request.trigger)?;
    let mut row = repo::get_schedule(tx, store, &scope.private, &request.id)?
        .ok_or_else(|| StoreError::Invalid("The local schedule was not found.".into()))?;
    if row.revision != request.expected_revision {
        return Err(StoreError::Invalid(
            "The local schedule changed. Refresh it before editing.".into(),
        ));
    }
    if row.status == "cancelled" {
        return Err(StoreError::Invalid(
            "A cancelled local schedule is immutable.".into(),
        ));
    }
    let prior = decode_schedule_payload(&row)?;
    let timezone = parse_timezone(&request.timezone)?;
    let next = initial_slot(&request.trigger, timezone, now)?.map(|slot| timestamp(slot.instant));
    let prompt_changed = prior.prompt != request.prompt;
    let prompt_revision = if prompt_changed {
        checked_revision(row.prompt_revision)?
    } else {
        row.prompt_revision
    };
    let revision = checked_revision(row.revision)?;
    let payload = SchedulePayload {
        prompt_fingerprint: fingerprint(&request.prompt),
        prompt: request.prompt,
        prompt_revision,
        timezone: request.timezone,
        trigger: request.trigger,
        agent_id: request.agent_id.clone(),
        provider_id: request.provider_id.clone(),
        model: request.model.clone(),
        created_by_internal_user_id: prior.created_by_internal_user_id,
    };
    row.agent_id = request.agent_id;
    row.trigger_kind = payload.trigger.kind().into();
    row.revision = revision;
    row.prompt_revision = prompt_revision;
    row.next_run_at = next;
    row.updated_at = timestamp(now);
    row.payload = encode(&payload)?;
    repo::replace_schedule(tx, store, &scope.private, request.expected_revision, &row)?;
    schedule_from_row(row)
}

fn set_status_at(
    tx: &rusqlite::Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    request: SetLocalScheduleStatusRequest,
    now: DateTime<Utc>,
) -> crate::store::Result<LocalSchedule> {
    validate_bounded_id_store(&request.id, "Schedule", MAX_ID_CHARACTERS)?;
    let mut row = repo::get_schedule(tx, store, &scope.private, &request.id)?
        .ok_or_else(|| StoreError::Invalid("The local schedule was not found.".into()))?;
    if row.revision != request.expected_revision {
        return Err(StoreError::Invalid(
            "The local schedule changed. Refresh it before changing its status.".into(),
        ));
    }
    let current_status = LocalScheduleStatus::parse(&row.status)?;
    if current_status == LocalScheduleStatus::Cancelled {
        if request.status == LocalScheduleStatus::Cancelled {
            return schedule_from_row(row);
        }
        return Err(StoreError::Invalid(
            "A cancelled local schedule cannot be restarted.".into(),
        ));
    }
    if current_status == request.status {
        return schedule_from_row(row);
    }
    let payload = decode_schedule_payload(&row)?;
    row.revision = checked_revision(row.revision)?;
    row.status = request.status.as_str().into();
    row.updated_at = timestamp(now);
    match request.status {
        LocalScheduleStatus::Cancelled => row.next_run_at = None,
        LocalScheduleStatus::Paused => {}
        LocalScheduleStatus::Enabled => {
            if !matches!(payload.trigger, LocalScheduleTrigger::Once { .. }) {
                row.next_run_at =
                    next_slot_after(&payload.trigger, parse_timezone(&payload.timezone)?, now)?
                        .map(|slot| timestamp(slot.instant));
            }
        }
    }
    repo::replace_schedule(tx, store, &scope.private, request.expected_revision, &row)?;
    schedule_from_row(row)
}

/// Claim at most one due occurrence after the dispatcher has reserved capacity.
/// The returned token is the only authority to bind a queued attempt. It is
/// stored only as a hash and grants no tool approval or provider credential.
pub(crate) fn claim_due_after_capacity(
    store: &Store,
    scope: &PrivateDataScope,
    reservation: LocalScheduleCapacityReservation,
    now: DateTime<Utc>,
) -> crate::store::Result<Option<LocalScheduleClaim>> {
    claim_due_after_capacity_matching(store, scope, reservation, now, None)
}

fn claim_due_after_capacity_matching(
    store: &Store,
    scope: &PrivateDataScope,
    reservation: LocalScheduleCapacityReservation,
    now: DateTime<Utc>,
    expected: Option<(&str, i64)>,
) -> crate::store::Result<Option<LocalScheduleClaim>> {
    store.transaction(|tx| {
        let now_text = timestamp(now);
        repo::interrupt_expired(tx, store, scope, &now_text)?;
        let Some(mut schedule_row) = repo::first_due_schedule(tx, store, scope, &now_text)? else {
            return Ok(None);
        };
        if expected.is_some_and(|(id, revision)| {
            schedule_row.id != id || schedule_row.revision != revision
        }) {
            return Err(StoreError::Invalid(
                "The due schedule changed before capacity could be claimed.".into(),
            ));
        }
        let schedule = schedule_from_row(schedule_row.clone())?;
        let timezone = parse_timezone(&schedule.timezone)?;
        let Some(slot) = latest_due_slot(&schedule.trigger, timezone, now)? else {
            return Err(StoreError::Invalid(
                "The local schedule due cursor does not match its civil-time trigger.".into(),
            ));
        };
        let stored_next = parse_utc(
            schedule_row
                .next_run_at
                .as_deref()
                .ok_or_else(|| StoreError::Invalid("A due schedule has no next run.".into()))?,
        )?;
        if slot.instant < stored_next || slot.instant > now {
            return Err(StoreError::Invalid(
                "The local schedule due cursor is inconsistent.".into(),
            ));
        }
        let claim_token = random_token("schedule-claim")?;
        let occurrence_id = random_token("occurrence")?;
        let lease_expires_at = timestamp(now + Duration::minutes(CLAIM_LEASE_MINUTES));
        let occurrence_payload = OccurrencePayload {
            prompt: schedule.prompt.clone(),
            prompt_fingerprint: fingerprint(&schedule.prompt),
            prompt_revision: schedule.prompt_revision,
            timezone: schedule.timezone.clone(),
            trigger: schedule.trigger.clone(),
            agent_id: schedule.agent_id.clone(),
            provider_id: schedule.provider_id.clone(),
            model: schedule.model.clone(),
            intended_local_slot: slot.key.clone(),
            capacity_reservation_fingerprint: fingerprint(&reservation.id),
            outcome: None,
            detail: None,
        };
        let occurrence = OccurrenceRow {
            id: occurrence_id.clone(),
            schedule_id: schedule.id.clone(),
            schedule_revision: schedule.revision,
            prompt_revision: schedule.prompt_revision,
            state: "claimed".into(),
            slot_fingerprint: fingerprint(&format!(
                "{}|{}|{}",
                schedule.id, schedule.revision, slot.key
            )),
            claim_fingerprint: fingerprint(&claim_token),
            lease_expires_at: lease_expires_at.clone(),
            execution_attempt_id: None,
            scheduled_for: timestamp(slot.instant),
            claimed_at: now_text.clone(),
            started_at: None,
            completed_at: None,
            updated_at: now_text.clone(),
            payload: encode(&occurrence_payload)?,
        };
        repo::insert_claimed_occurrence(tx, store, scope, &occurrence)?;
        schedule_row.next_run_at = match schedule.trigger {
            LocalScheduleTrigger::Once { .. } => None,
            _ => next_slot_after(&schedule.trigger, timezone, now)?
                .map(|next| timestamp(next.instant)),
        };
        schedule_row.updated_at = now_text;
        repo::replace_schedule(tx, store, scope, schedule_row.revision, &schedule_row)?;
        Ok(Some(LocalScheduleClaim {
            occurrence_id,
            schedule_id: schedule.id,
            schedule_revision: schedule.revision,
            prompt_revision: schedule.prompt_revision,
            scheduled_for: timestamp(slot.instant),
            claim_token,
            lease_expires_at,
            agent_id: schedule.agent_id,
            provider_id: schedule.provider_id,
            model: schedule.model,
            prompt: schedule.prompt,
        }))
    })
}

/// Atomically bind an exact queued execution attempt after the dispatcher has
/// revalidated the active agent, Computer, provider/model, execution-control,
/// and capacity prerequisites. Ordinary single-use approvals remain mandatory
/// inside that attempt; the schedule claim never supplies or persists a grant.
pub(crate) fn bind_claim_to_pending_attempt(
    store: &Store,
    scope: &PrivateDataScope,
    occurrence_id: &str,
    claim_token: &str,
    attempt_id: &str,
    now: DateTime<Utc>,
) -> crate::store::Result<String> {
    validate_bounded_id_store(occurrence_id, "Occurrence", MAX_ID_CHARACTERS)?;
    validate_bounded_id_store(attempt_id, "Execution attempt", MAX_ID_CHARACTERS)?;
    let lease_expires_at = timestamp(now + Duration::minutes(CLAIM_LEASE_MINUTES));
    store.transaction(|tx| {
        repo::bind_pending_attempt(
            tx,
            store,
            scope,
            occurrence_id,
            &fingerprint(claim_token),
            attempt_id,
            &timestamp(now),
            &lease_expires_at,
        )?;
        Ok(lease_expires_at)
    })
}

/// Extend a running occurrence lease only while the exact claim and attempt are
/// still current. A crashed dispatcher cannot revive an expired occurrence.
pub(crate) fn renew_bound_occurrence_lease(
    store: &Store,
    scope: &PrivateDataScope,
    occurrence_id: &str,
    claim_token: &str,
    attempt_id: &str,
    now: DateTime<Utc>,
) -> crate::store::Result<String> {
    let lease_expires_at = timestamp(now + Duration::minutes(CLAIM_LEASE_MINUTES));
    store.transaction(|tx| {
        repo::renew_running_lease(
            tx,
            store,
            scope,
            occurrence_id,
            &fingerprint(claim_token),
            attempt_id,
            &timestamp(now),
            &lease_expires_at,
        )?;
        Ok(lease_expires_at)
    })
}

pub(crate) fn finish_bound_occurrence(
    store: &Store,
    scope: &PrivateDataScope,
    occurrence_id: &str,
    claim_token: &str,
    attempt_id: &str,
    outcome: &str,
    detail: Option<&str>,
    now: DateTime<Utc>,
) -> crate::store::Result<()> {
    if detail.is_some_and(|value| value.chars().count() > MAX_OUTCOME_DETAIL_CHARACTERS) {
        return Err(StoreError::Invalid(
            "The schedule outcome detail is too long.".into(),
        ));
    }
    store.transaction(|tx| {
        repo::finish_occurrence(
            tx,
            store,
            scope,
            occurrence_id,
            &fingerprint(claim_token),
            attempt_id,
            outcome,
            detail,
            &timestamp(now),
        )?;
        Ok(())
    })
}

fn schedule_from_row(row: ScheduleRow) -> crate::store::Result<LocalSchedule> {
    let payload = decode_schedule_payload(&row)?;
    Ok(LocalSchedule {
        id: row.id,
        agent_id: row.agent_id,
        provider_id: payload.provider_id,
        model: payload.model,
        prompt: payload.prompt,
        timezone: payload.timezone,
        trigger: payload.trigger,
        status: LocalScheduleStatus::parse(&row.status)?,
        revision: row.revision,
        prompt_revision: row.prompt_revision,
        next_run_at: row.next_run_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

fn occurrence_from_row(
    row: OccurrenceRow,
    thread_id: Option<String>,
) -> crate::store::Result<LocalScheduleOccurrence> {
    let payload: OccurrencePayload = serde_json::from_value(row.payload).map_err(|_| {
        StoreError::Invalid("The encrypted local schedule occurrence is invalid.".into())
    })?;
    Ok(LocalScheduleOccurrence {
        id: row.id,
        schedule_id: row.schedule_id,
        schedule_revision: row.schedule_revision,
        prompt_revision: row.prompt_revision,
        state: row.state,
        execution_attempt_id: row.execution_attempt_id,
        thread_id,
        scheduled_for: row.scheduled_for,
        claimed_at: row.claimed_at,
        started_at: row.started_at,
        completed_at: row.completed_at,
        updated_at: row.updated_at,
        outcome: payload.outcome,
        detail: payload.detail,
    })
}

fn decode_schedule_payload(row: &ScheduleRow) -> crate::store::Result<SchedulePayload> {
    let payload: SchedulePayload = serde_json::from_value(row.payload.clone())
        .map_err(|_| StoreError::Invalid("The encrypted local schedule is invalid.".into()))?;
    if payload.agent_id != row.agent_id
        || payload.prompt_revision != row.prompt_revision
        || payload.trigger.kind() != row.trigger_kind
        || payload.prompt_fingerprint != fingerprint(&payload.prompt)
    {
        return Err(StoreError::Invalid(
            "The encrypted local schedule does not match its index.".into(),
        ));
    }
    validate_route_and_agent(&payload.agent_id, &payload.provider_id, &payload.model)?;
    validate_prompt(&payload.prompt)?;
    validate_trigger(&payload.trigger)?;
    parse_timezone(&payload.timezone)?;
    Ok(payload)
}

fn encode<T: Serialize>(value: &T) -> crate::store::Result<serde_json::Value> {
    serde_json::to_value(value)
        .map_err(|_| StoreError::Invalid("The local schedule could not be encoded.".into()))
}

fn validate_route_and_agent(
    agent_id: &str,
    provider_id: &str,
    model: &str,
) -> crate::store::Result<()> {
    validate_bounded_id_store(agent_id, "Agent", MAX_ID_CHARACTERS)?;
    validate_catalog_id(provider_id, "Provider", MAX_PROVIDER_ID_CHARACTERS)?;
    validate_catalog_id(model, "Model", MAX_MODEL_ID_CHARACTERS)
}

fn validate_prompt(prompt: &str) -> crate::store::Result<()> {
    let count = prompt.chars().count();
    if prompt.trim().is_empty() || count > MAX_PROMPT_CHARACTERS {
        return Err(StoreError::Invalid(format!(
            "The schedule prompt must contain 1 to {MAX_PROMPT_CHARACTERS} characters."
        )));
    }
    Ok(())
}

fn validate_bounded_id(value: &str, label: &str, max: usize) -> Result<(), String> {
    validate_bounded_id_store(value, label, max).map_err(|error| error.to_string())
}

fn validate_bounded_id_store(value: &str, label: &str, max: usize) -> crate::store::Result<()> {
    if value.is_empty()
        || value.chars().count() > max
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(StoreError::Invalid(format!(
            "{label} id must use 1 to {max} letters, numbers, hyphens, or underscores."
        )));
    }
    Ok(())
}

fn validate_catalog_id(value: &str, label: &str, max: usize) -> crate::store::Result<()> {
    if value.is_empty()
        || value.chars().count() > max
        || !value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'/' | b':')
        })
    {
        return Err(StoreError::Invalid(format!(
            "{label} id is not a supported catalog identifier."
        )));
    }
    Ok(())
}

fn validate_trigger(trigger: &LocalScheduleTrigger) -> crate::store::Result<()> {
    match trigger {
        LocalScheduleTrigger::Once { local_date_time } => {
            parse_local_datetime(local_date_time)?;
        }
        LocalScheduleTrigger::Daily { local_time } => {
            parse_local_time(local_time)?;
        }
        LocalScheduleTrigger::Weekly {
            weekday,
            local_time,
        } => {
            parse_weekday(weekday)?;
            parse_local_time(local_time)?;
        }
    }
    Ok(())
}

fn parse_timezone(value: &str) -> crate::store::Result<Tz> {
    if value.is_empty() || value.chars().count() > MAX_TIMEZONE_CHARACTERS {
        return Err(StoreError::Invalid(
            "The schedule timezone is invalid.".into(),
        ));
    }
    value
        .parse::<Tz>()
        .map_err(|_| StoreError::Invalid("Use a valid IANA timezone for this schedule.".into()))
}

fn parse_local_datetime(value: &str) -> crate::store::Result<NaiveDateTime> {
    NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M").map_err(|_| {
        StoreError::Invalid("Use YYYY-MM-DDTHH:MM for a one-time local schedule.".into())
    })
}

fn parse_local_time(value: &str) -> crate::store::Result<NaiveTime> {
    NaiveTime::parse_from_str(value, "%H:%M")
        .map_err(|_| StoreError::Invalid("Use HH:MM for a recurring local schedule.".into()))
}

fn parse_weekday(value: &str) -> crate::store::Result<Weekday> {
    match value.to_ascii_lowercase().as_str() {
        "monday" => Ok(Weekday::Mon),
        "tuesday" => Ok(Weekday::Tue),
        "wednesday" => Ok(Weekday::Wed),
        "thursday" => Ok(Weekday::Thu),
        "friday" => Ok(Weekday::Fri),
        "saturday" => Ok(Weekday::Sat),
        "sunday" => Ok(Weekday::Sun),
        _ => Err(StoreError::Invalid(
            "The weekly schedule weekday is invalid.".into(),
        )),
    }
}

fn initial_slot(
    trigger: &LocalScheduleTrigger,
    timezone: Tz,
    now: DateTime<Utc>,
) -> crate::store::Result<Option<CivilSlot>> {
    match trigger {
        LocalScheduleTrigger::Once { local_date_time } => {
            let intended = parse_local_datetime(local_date_time)?;
            let slot = resolve_civil_slot(timezone, intended)?;
            if slot.instant <= now {
                return Err(StoreError::Invalid(
                    "Choose a future time for a new one-time schedule.".into(),
                ));
            }
            Ok(Some(slot))
        }
        _ => next_slot_after(trigger, timezone, now),
    }
}

fn next_slot_after(
    trigger: &LocalScheduleTrigger,
    timezone: Tz,
    after: DateTime<Utc>,
) -> crate::store::Result<Option<CivilSlot>> {
    match trigger {
        LocalScheduleTrigger::Once { local_date_time } => {
            let slot = resolve_civil_slot(timezone, parse_local_datetime(local_date_time)?)?;
            Ok((slot.instant > after).then_some(slot))
        }
        LocalScheduleTrigger::Daily { local_time } => {
            let time = parse_local_time(local_time)?;
            let local_date = after.with_timezone(&timezone).date_naive();
            for offset in 0..=2 {
                let date = local_date
                    .checked_add_days(Days::new(offset))
                    .ok_or_else(|| {
                        StoreError::Invalid("The daily schedule date overflowed.".into())
                    })?;
                let slot = resolve_civil_slot(timezone, date.and_time(time))?;
                if slot.instant > after {
                    return Ok(Some(slot));
                }
            }
            Err(StoreError::Invalid(
                "The next daily schedule time is invalid.".into(),
            ))
        }
        LocalScheduleTrigger::Weekly {
            weekday,
            local_time,
        } => {
            let weekday = parse_weekday(weekday)?;
            let time = parse_local_time(local_time)?;
            let local_date = after.with_timezone(&timezone).date_naive();
            let delta = (weekday.num_days_from_monday() as i64
                - local_date.weekday().num_days_from_monday() as i64)
                .rem_euclid(7) as u64;
            let mut date = local_date
                .checked_add_days(Days::new(delta))
                .ok_or_else(|| {
                    StoreError::Invalid("The weekly schedule date overflowed.".into())
                })?;
            let mut slot = resolve_civil_slot(timezone, date.and_time(time))?;
            if slot.instant <= after {
                date = date.checked_add_days(Days::new(7)).ok_or_else(|| {
                    StoreError::Invalid("The weekly schedule date overflowed.".into())
                })?;
                slot = resolve_civil_slot(timezone, date.and_time(time))?;
            }
            Ok(Some(slot))
        }
    }
}

fn latest_due_slot(
    trigger: &LocalScheduleTrigger,
    timezone: Tz,
    now: DateTime<Utc>,
) -> crate::store::Result<Option<CivilSlot>> {
    match trigger {
        LocalScheduleTrigger::Once { local_date_time } => {
            let slot = resolve_civil_slot(timezone, parse_local_datetime(local_date_time)?)?;
            Ok((slot.instant <= now).then_some(slot))
        }
        LocalScheduleTrigger::Daily { local_time } => {
            let time = parse_local_time(local_time)?;
            let mut date = now.with_timezone(&timezone).date_naive();
            let mut slot = resolve_civil_slot(timezone, date.and_time(time))?;
            if slot.instant > now {
                date = date.checked_sub_days(Days::new(1)).ok_or_else(|| {
                    StoreError::Invalid("The daily schedule date underflowed.".into())
                })?;
                slot = resolve_civil_slot(timezone, date.and_time(time))?;
            }
            Ok(Some(slot))
        }
        LocalScheduleTrigger::Weekly {
            weekday,
            local_time,
        } => {
            let weekday = parse_weekday(weekday)?;
            let time = parse_local_time(local_time)?;
            let local_date = now.with_timezone(&timezone).date_naive();
            let backwards = (local_date.weekday().num_days_from_monday() as i64
                - weekday.num_days_from_monday() as i64)
                .rem_euclid(7) as u64;
            let mut date = local_date
                .checked_sub_days(Days::new(backwards))
                .ok_or_else(|| {
                    StoreError::Invalid("The weekly schedule date underflowed.".into())
                })?;
            let mut slot = resolve_civil_slot(timezone, date.and_time(time))?;
            if slot.instant > now {
                date = date.checked_sub_days(Days::new(7)).ok_or_else(|| {
                    StoreError::Invalid("The weekly schedule date underflowed.".into())
                })?;
                slot = resolve_civil_slot(timezone, date.and_time(time))?;
            }
            Ok(Some(slot))
        }
    }
}

/// Resolve a wall-clock slot deterministically. During a fall-back overlap the
/// earlier instant wins; during a spring-forward gap the first valid minute
/// after the gap runs while the dedup key retains the intended wall-clock slot.
fn resolve_civil_slot(timezone: Tz, intended: NaiveDateTime) -> crate::store::Result<CivilSlot> {
    let key = intended.format("%Y-%m-%dT%H:%M").to_string();
    let instant = match timezone.from_local_datetime(&intended) {
        LocalResult::Single(value) => value.with_timezone(&Utc),
        LocalResult::Ambiguous(first, second) => {
            first.with_timezone(&Utc).min(second.with_timezone(&Utc))
        }
        LocalResult::None => {
            let mut resolved = None;
            for minutes in 1..=180 {
                let candidate = intended
                    .checked_add_signed(Duration::minutes(minutes))
                    .ok_or_else(|| StoreError::Invalid("The schedule time overflowed.".into()))?;
                match timezone.from_local_datetime(&candidate) {
                    LocalResult::Single(value) => {
                        resolved = Some(value.with_timezone(&Utc));
                        break;
                    }
                    LocalResult::Ambiguous(first, second) => {
                        resolved = Some(first.with_timezone(&Utc).min(second.with_timezone(&Utc)));
                        break;
                    }
                    LocalResult::None => {}
                }
            }
            resolved.ok_or_else(|| {
                StoreError::Invalid(
                    "The schedule time could not be resolved in its timezone.".into(),
                )
            })?
        }
    };
    Ok(CivilSlot { key, instant })
}

fn parse_utc(value: &str) -> crate::store::Result<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|_| StoreError::Invalid("A local schedule UTC timestamp is invalid.".into()))
}

fn timestamp(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn checked_revision(value: i64) -> crate::store::Result<i64> {
    value
        .checked_add(1)
        .ok_or_else(|| StoreError::Invalid("The local schedule revision overflowed.".into()))
}

fn fingerprint(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

fn random_token(prefix: &str) -> crate::store::Result<String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|_| StoreError::Invalid("Mivlet could not create schedule identity.".into()))?;
    Ok(format!("{prefix}-{}", hex::encode(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::repos::scope::{DataScope, PrivateDataScope};
    use crate::store::repos::{execution_attempt, thread};
    use crate::store::vault::{MasterKey, Vault};
    use chrono::NaiveDate;

    fn store_and_scope() -> (Store, AuthorizedCommandScope) {
        let store =
            Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap();
        let data = DataScope::workspace("workspace-1").unwrap();
        store
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO workspace(id,name,created_at,updated_at) VALUES(?1,'Workspace','t','t')",
                    [data.workspace_id()],
                )?;
                Ok(())
            })
            .unwrap();
        let private =
            PrivateDataScope::for_authenticated_user(data.clone(), "user-1", Some("member-1"))
                .unwrap();
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

    fn daily_request(status: LocalScheduleStatus) -> CreateLocalScheduleRequest {
        CreateLocalScheduleRequest {
            workspace_id: "workspace-1".into(),
            id: "schedule-1".into(),
            agent_id: "agent-research".into(),
            provider_id: "openai".into(),
            model: "gpt-5".into(),
            prompt: "Check the report. It may mention an API key without storing one.".into(),
            timezone: "Europe/London".into(),
            trigger: LocalScheduleTrigger::Daily {
                local_time: "09:00".into(),
            },
            status,
        }
    }

    fn at(value: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(value)
            .unwrap()
            .with_timezone(&Utc)
    }

    #[allow(clippy::too_many_arguments)]
    fn queue_attempt(
        store: &Store,
        scope: &AuthorizedCommandScope,
        attempt_id: &str,
        thread_id: &str,
        owner_member_id: &str,
        provider_id: &str,
        model: &str,
        prompt: &str,
    ) {
        store
            .transaction(|tx| {
                thread::create(
                    tx,
                    store,
                    &scope.data,
                    thread_id,
                    None,
                    "Scheduled web research",
                    "2026-09-07T12:00:01.000Z",
                    &serde_json::json!({"authorityScope":{"authority":"local","visibility":"member-private"}}),
                )?;
                tx.execute(
                    "UPDATE thread SET owner_member_id=?1 WHERE workspace_id=?2 AND id=?3",
                    rusqlite::params![owner_member_id, scope.data.workspace_id(), thread_id],
                )?;
                execution_attempt::upsert_scoped(
                    tx,
                    store,
                    &scope.data,
                    attempt_id,
                    Some(thread_id),
                    provider_id,
                    model,
                    "queued",
                    0,
                    true,
                    0,
                    "2026-09-07T12:00:01.000Z",
                    "2026-09-07T12:00:01.000Z",
                    &serde_json::json!({
                        "exchanges":[{"role":"user","content":prompt}],
                        "transcript":"",
                        "pendingApprovalIds":[]
                    }),
                )
            })
            .unwrap();
    }

    #[test]
    fn creates_private_encrypted_schedule_and_accepts_legitimate_key_wording() {
        let (store, scope) = store_and_scope();
        let schedule = store
            .transaction(|tx| {
                create_at(
                    tx,
                    &store,
                    &scope,
                    daily_request(LocalScheduleStatus::Enabled),
                    at("2026-09-07T07:30:00Z"),
                )
            })
            .unwrap();
        assert_eq!(schedule.prompt_revision, 1);
        assert_eq!(
            schedule.next_run_at.as_deref(),
            Some("2026-09-07T08:00:00.000Z")
        );
        store
            .with_conn(|conn| {
                let payload: Vec<u8> = conn.query_row(
                    "SELECT payload FROM local_schedule WHERE id='schedule-1'",
                    [],
                    |row| row.get(0),
                )?;
                assert!(!String::from_utf8_lossy(&payload).contains("API key"));
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn owner_scope_and_aad_prevent_cross_member_reads_and_ciphertext_swaps() {
        let (store, scope) = store_and_scope();
        store
            .transaction(|tx| {
                create_at(
                    tx,
                    &store,
                    &scope,
                    daily_request(LocalScheduleStatus::Enabled),
                    at("2026-09-07T08:30:00Z"),
                )
            })
            .unwrap();
        let other = PrivateDataScope::for_authenticated_user(
            scope.data.clone(),
            "user-2",
            Some("member-2"),
        )
        .unwrap();
        store
            .with_conn(|conn| {
                assert!(repo::get_schedule(conn, &store, &other, "schedule-1")?.is_none());
                conn.execute(
                    "UPDATE local_schedule SET owner_subject=?1 WHERE id='schedule-1'",
                    [other.owner_subject()],
                )?;
                assert!(repo::get_schedule(conn, &store, &other, "schedule-1").is_err());
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn daily_claim_skips_backlog_and_cannot_be_claimed_twice() {
        let (store, scope) = store_and_scope();
        store
            .transaction(|tx| {
                create_at(
                    tx,
                    &store,
                    &scope,
                    daily_request(LocalScheduleStatus::Enabled),
                    at("2026-09-01T07:00:00Z"),
                )
            })
            .unwrap();
        let now = at("2026-09-07T12:00:00Z");
        let claim = claim_due_after_capacity(
            &store,
            &scope.private,
            LocalScheduleCapacityReservation::new("capacity-1".into()).unwrap(),
            now,
        )
        .unwrap()
        .unwrap();
        assert_eq!(claim.scheduled_for, "2026-09-07T08:00:00.000Z");
        assert!(claim_due_after_capacity(
            &store,
            &scope.private,
            LocalScheduleCapacityReservation::new("capacity-2".into()).unwrap(),
            now,
        )
        .unwrap()
        .is_none());
        store
            .with_conn(|conn| {
                assert_eq!(
                    repo::count_occurrences(conn, &scope.private, "schedule-1")?,
                    1
                );
                let current =
                    repo::get_schedule(conn, &store, &scope.private, "schedule-1")?.unwrap();
                assert!(parse_utc(current.next_run_at.as_deref().unwrap())? > now);
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn once_claims_exactly_once_and_weekly_uses_the_named_local_weekday() {
        let (store, scope) = store_and_scope();
        let once = CreateLocalScheduleRequest {
            trigger: LocalScheduleTrigger::Once {
                local_date_time: "2026-09-07T09:00".into(),
            },
            ..daily_request(LocalScheduleStatus::Enabled)
        };
        store
            .transaction(|tx| create_at(tx, &store, &scope, once, at("2026-09-07T07:00:00Z")))
            .unwrap();
        let claim = claim_due_after_capacity(
            &store,
            &scope.private,
            LocalScheduleCapacityReservation::new("capacity-once".into()).unwrap(),
            at("2026-09-07T10:00:00Z"),
        )
        .unwrap()
        .unwrap();
        assert_eq!(claim.scheduled_for, "2026-09-07T08:00:00.000Z");
        assert!(claim_due_after_capacity(
            &store,
            &scope.private,
            LocalScheduleCapacityReservation::new("capacity-once-2".into()).unwrap(),
            at("2026-09-08T10:00:00Z"),
        )
        .unwrap()
        .is_none());

        let weekly = LocalScheduleTrigger::Weekly {
            weekday: "wednesday".into(),
            local_time: "09:00".into(),
        };
        let next = next_slot_after(
            &weekly,
            "Europe/London".parse().unwrap(),
            at("2026-09-07T10:00:00Z"),
        )
        .unwrap()
        .unwrap();
        assert_eq!(timestamp(next.instant), "2026-09-09T08:00:00.000Z");
    }

    #[test]
    fn concurrent_capacity_claims_serialize_to_one_occurrence() {
        use std::sync::{Arc, Barrier};

        let (store, scope) = store_and_scope();
        store
            .transaction(|tx| {
                create_at(
                    tx,
                    &store,
                    &scope,
                    daily_request(LocalScheduleStatus::Enabled),
                    at("2026-09-07T07:00:00Z"),
                )
            })
            .unwrap();
        let store = Arc::new(store);
        let barrier = Arc::new(Barrier::new(2));
        let handles = (0..2)
            .map(|index| {
                let store = store.clone();
                let private = scope.private.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    claim_due_after_capacity(
                        &store,
                        &private,
                        LocalScheduleCapacityReservation::new(format!("capacity-{index}")).unwrap(),
                        at("2026-09-07T12:00:00Z"),
                    )
                    .unwrap()
                })
            })
            .collect::<Vec<_>>();
        let claimed = handles
            .into_iter()
            .map(|handle| handle.join().unwrap().is_some())
            .filter(|claimed| *claimed)
            .count();
        assert_eq!(claimed, 1);
        store
            .with_conn(|conn| {
                assert_eq!(
                    repo::count_occurrences(conn, &scope.private, "schedule-1")?,
                    1
                );
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn paused_and_cancelled_schedules_never_claim_and_cancel_is_terminal() {
        let (store, scope) = store_and_scope();
        let created = store
            .transaction(|tx| {
                create_at(
                    tx,
                    &store,
                    &scope,
                    daily_request(LocalScheduleStatus::Paused),
                    at("2026-09-01T07:00:00Z"),
                )
            })
            .unwrap();
        assert!(claim_due_after_capacity(
            &store,
            &scope.private,
            LocalScheduleCapacityReservation::new("capacity-1".into()).unwrap(),
            at("2026-09-07T12:00:00Z"),
        )
        .unwrap()
        .is_none());
        let cancelled = store
            .transaction(|tx| {
                set_status_at(
                    tx,
                    &store,
                    &scope,
                    SetLocalScheduleStatusRequest {
                        workspace_id: "workspace-1".into(),
                        id: created.id.clone(),
                        expected_revision: created.revision,
                        status: LocalScheduleStatus::Cancelled,
                    },
                    at("2026-09-02T07:00:00Z"),
                )
            })
            .unwrap();
        assert!(cancelled.next_run_at.is_none());
        assert!(store
            .transaction(|tx| {
                set_status_at(
                    tx,
                    &store,
                    &scope,
                    SetLocalScheduleStatusRequest {
                        workspace_id: "workspace-1".into(),
                        id: cancelled.id,
                        expected_revision: cancelled.revision,
                        status: LocalScheduleStatus::Enabled,
                    },
                    at("2026-09-02T08:00:00Z"),
                )
            })
            .is_err());
    }

    #[test]
    fn expired_claim_becomes_interrupted_without_replay() {
        let (store, scope) = store_and_scope();
        store
            .transaction(|tx| {
                create_at(
                    tx,
                    &store,
                    &scope,
                    daily_request(LocalScheduleStatus::Enabled),
                    at("2026-09-07T07:00:00Z"),
                )
            })
            .unwrap();
        let claim = claim_due_after_capacity(
            &store,
            &scope.private,
            LocalScheduleCapacityReservation::new("capacity-1".into()).unwrap(),
            at("2026-09-07T12:00:00Z"),
        )
        .unwrap()
        .unwrap();
        assert!(claim_due_after_capacity(
            &store,
            &scope.private,
            LocalScheduleCapacityReservation::new("capacity-2".into()).unwrap(),
            at("2026-09-07T12:06:00Z"),
        )
        .unwrap()
        .is_none());
        store
            .with_conn(|conn| {
                let occurrence =
                    repo::get_occurrence(conn, &store, &scope.private, &claim.occurrence_id)?
                        .unwrap();
                assert_eq!(occurrence.state, "interrupted");
                assert_eq!(
                    repo::count_occurrences(conn, &scope.private, "schedule-1")?,
                    1
                );
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn claim_binds_exact_queued_attempt_and_completion_requires_terminal_match() {
        let (store, scope) = store_and_scope();
        store
            .transaction(|tx| {
                create_at(
                    tx,
                    &store,
                    &scope,
                    daily_request(LocalScheduleStatus::Enabled),
                    at("2026-09-07T07:00:00Z"),
                )
            })
            .unwrap();
        let claim = claim_due_after_capacity(
            &store,
            &scope.private,
            LocalScheduleCapacityReservation::new("capacity-1".into()).unwrap(),
            at("2026-09-07T12:00:00Z"),
        )
        .unwrap()
        .unwrap();
        let attempt_id = format!("schedule-run-{}", claim.occurrence_id);
        queue_attempt(
            &store,
            &scope,
            &attempt_id,
            "thread-1",
            "member-1",
            "openai",
            "gpt-5",
            &claim.prompt,
        );
        assert!(bind_claim_to_pending_attempt(
            &store,
            &scope.private,
            &claim.occurrence_id,
            "wrong-token",
            &attempt_id,
            at("2026-09-07T12:00:02Z"),
        )
        .is_err());
        bind_claim_to_pending_attempt(
            &store,
            &scope.private,
            &claim.occurrence_id,
            &claim.claim_token,
            &attempt_id,
            at("2026-09-07T12:00:02Z"),
        )
        .unwrap();
        assert!(finish_bound_occurrence(
            &store,
            &scope.private,
            &claim.occurrence_id,
            &claim.claim_token,
            &attempt_id,
            "completed",
            None,
            at("2026-09-07T12:01:00Z"),
        )
        .is_err());
        store
            .transaction(|tx| {
                execution_attempt::upsert_scoped(
                    tx,
                    &store,
                    &scope.data,
                    &attempt_id,
                    Some("thread-1"),
                    "openai",
                    "gpt-5",
                    "completed",
                    1,
                    false,
                    0,
                    "2026-09-07T12:00:01.000Z",
                    "2026-09-07T12:01:01.000Z",
                    &serde_json::json!({"transcript":"done","pendingApprovalIds":[]}),
                )
            })
            .unwrap();
        finish_bound_occurrence(
            &store,
            &scope.private,
            &claim.occurrence_id,
            &claim.claim_token,
            &attempt_id,
            "completed",
            Some("Verified terminal completion."),
            at("2026-09-07T12:01:02Z"),
        )
        .unwrap();
        store
            .with_conn(|conn| {
                let occurrence =
                    repo::get_occurrence(conn, &store, &scope.private, &claim.occurrence_id)?
                        .unwrap();
                assert_eq!(occurrence.state, "completed");
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn pause_between_claim_and_bind_rejects_provider_start() {
        let (store, scope) = store_and_scope();
        store
            .transaction(|tx| {
                create_at(
                    tx,
                    &store,
                    &scope,
                    daily_request(LocalScheduleStatus::Enabled),
                    at("2026-09-07T07:00:00Z"),
                )
            })
            .unwrap();
        let claim = claim_due_after_capacity(
            &store,
            &scope.private,
            LocalScheduleCapacityReservation::new("capacity-pause-bind".into()).unwrap(),
            at("2026-09-07T12:00:00Z"),
        )
        .unwrap()
        .unwrap();
        let attempt_id = format!("schedule-run-{}", claim.occurrence_id);
        queue_attempt(
            &store,
            &scope,
            &attempt_id,
            "thread-pause-bind",
            "member-1",
            &claim.provider_id,
            &claim.model,
            &claim.prompt,
        );
        store
            .transaction(|tx| {
                set_status_at(
                    tx,
                    &store,
                    &scope,
                    SetLocalScheduleStatusRequest {
                        workspace_id: "workspace-1".into(),
                        id: claim.schedule_id.clone(),
                        expected_revision: claim.schedule_revision,
                        status: LocalScheduleStatus::Paused,
                    },
                    at("2026-09-07T12:00:01Z"),
                )
            })
            .unwrap();
        assert!(bind_claim_to_pending_attempt(
            &store,
            &scope.private,
            &claim.occurrence_id,
            &claim.claim_token,
            &attempt_id,
            at("2026-09-07T12:00:02Z"),
        )
        .is_err());
    }

    #[test]
    fn bind_rejects_interactive_attempt_and_mismatched_frozen_prompt() {
        let (store, scope) = store_and_scope();
        store
            .transaction(|tx| {
                create_at(
                    tx,
                    &store,
                    &scope,
                    daily_request(LocalScheduleStatus::Enabled),
                    at("2026-09-07T07:00:00Z"),
                )
            })
            .unwrap();
        let claim = claim_due_after_capacity(
            &store,
            &scope.private,
            LocalScheduleCapacityReservation::new("capacity-mismatch".into()).unwrap(),
            at("2026-09-07T12:00:00Z"),
        )
        .unwrap()
        .unwrap();
        queue_attempt(
            &store,
            &scope,
            "interactive-attempt",
            "thread-interactive",
            "member-1",
            &claim.provider_id,
            &claim.model,
            &claim.prompt,
        );
        assert!(bind_claim_to_pending_attempt(
            &store,
            &scope.private,
            &claim.occurrence_id,
            &claim.claim_token,
            "interactive-attempt",
            at("2026-09-07T12:00:02Z"),
        )
        .is_err());

        let attempt_id = format!("schedule-run-{}", claim.occurrence_id);
        queue_attempt(
            &store,
            &scope,
            &attempt_id,
            "thread-mismatched-prompt",
            "member-1",
            &claim.provider_id,
            &claim.model,
            "A different request",
        );
        assert!(bind_claim_to_pending_attempt(
            &store,
            &scope.private,
            &claim.occurrence_id,
            &claim.claim_token,
            &attempt_id,
            at("2026-09-07T12:00:03Z"),
        )
        .is_err());
    }

    #[test]
    fn bind_rejects_a_queued_attempt_owned_by_another_member() {
        let (store, scope) = store_and_scope();
        store
            .transaction(|tx| {
                create_at(
                    tx,
                    &store,
                    &scope,
                    daily_request(LocalScheduleStatus::Enabled),
                    at("2026-09-07T07:00:00Z"),
                )
            })
            .unwrap();
        let claim = claim_due_after_capacity(
            &store,
            &scope.private,
            LocalScheduleCapacityReservation::new("capacity-owner".into()).unwrap(),
            at("2026-09-07T12:00:00Z"),
        )
        .unwrap()
        .unwrap();
        let attempt_id = format!("schedule-run-{}", claim.occurrence_id);
        queue_attempt(
            &store,
            &scope,
            &attempt_id,
            "thread-foreign-owner",
            "member-2",
            &claim.provider_id,
            &claim.model,
            &claim.prompt,
        );
        assert!(bind_claim_to_pending_attempt(
            &store,
            &scope.private,
            &claim.occurrence_id,
            &claim.claim_token,
            &attempt_id,
            at("2026-09-07T12:00:02Z"),
        )
        .is_err());
    }

    #[test]
    fn civil_time_resolution_is_deterministic_across_dst_gap_and_overlap() {
        let timezone: Tz = "Europe/London".parse().unwrap();
        let gap = resolve_civil_slot(
            timezone,
            NaiveDate::from_ymd_opt(2026, 3, 29)
                .unwrap()
                .and_hms_opt(1, 30, 0)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(gap.key, "2026-03-29T01:30");
        assert_eq!(timestamp(gap.instant), "2026-03-29T01:00:00.000Z");

        let overlap = resolve_civil_slot(
            timezone,
            NaiveDate::from_ymd_opt(2026, 10, 25)
                .unwrap()
                .and_hms_opt(1, 30, 0)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(timestamp(overlap.instant), "2026-10-25T00:30:00.000Z");
    }

    #[test]
    fn prompt_edits_increment_prompt_revision_and_stale_updates_fail() {
        let (store, scope) = store_and_scope();
        let created = store
            .transaction(|tx| {
                create_at(
                    tx,
                    &store,
                    &scope,
                    daily_request(LocalScheduleStatus::Enabled),
                    at("2026-09-07T07:00:00Z"),
                )
            })
            .unwrap();
        let update = UpdateLocalScheduleRequest {
            workspace_id: "workspace-1".into(),
            id: created.id.clone(),
            expected_revision: created.revision,
            agent_id: created.agent_id.clone(),
            provider_id: created.provider_id.clone(),
            model: created.model.clone(),
            prompt: "Use the revised report prompt.".into(),
            timezone: created.timezone.clone(),
            trigger: created.trigger.clone(),
        };
        let updated = store
            .transaction(|tx| {
                update_at(
                    tx,
                    &store,
                    &scope,
                    update.clone(),
                    at("2026-09-07T07:01:00Z"),
                )
            })
            .unwrap();
        assert_eq!(updated.prompt_revision, 2);
        assert_eq!(updated.revision, 2);
        assert!(store
            .transaction(|tx| update_at(tx, &store, &scope, update, at("2026-09-07T07:02:00Z")))
            .is_err());
    }
}
