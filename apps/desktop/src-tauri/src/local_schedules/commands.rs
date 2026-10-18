//! Local schedule commands and dispatch lifecycle.

use super::*;

/// Pure civil-time preview using the same rules as saving and dispatching.
pub(super) fn local_schedule_preview(
    request: PreviewLocalScheduleRequest,
) -> Result<Option<String>, String> {
    let timezone = parse_timezone(&request.timezone).map_err(|error| error.to_string())?;
    validate_trigger(&request.trigger).map_err(|error| error.to_string())?;
    initial_slot(&request.trigger, timezone, Utc::now())
        .map(|slot| slot.map(|slot| timestamp(slot.instant)))
        .map_err(|error| error.to_string())
}

pub(super) fn local_schedule_create(
    request: CreateLocalScheduleRequest,
) -> Result<LocalSchedule, String> {
    if matches!(request.trigger, LocalScheduleTrigger::Event { .. }) {
        return Err("Configure event triggers through protected signing-key setup.".into());
    }
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

pub(super) fn local_schedule_update(
    request: UpdateLocalScheduleRequest,
) -> Result<LocalSchedule, String> {
    if matches!(request.trigger, LocalScheduleTrigger::Event { .. }) {
        return Err("Edit event triggers through their scoped event configuration.".into());
    }
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

pub(super) fn local_schedule_set_status(
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

pub(super) fn local_schedule_list(
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

pub(super) fn local_schedule_occurrence_list(
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

pub(super) fn require_main_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Scheduled work can only run from the main Mivlet window.".into());
    }
    Ok(())
}

/// Reserve the process-wide serial dispatcher slot and atomically claim the
/// exact due definition the renderer already validated. This is a main-window
/// orchestration command, not a model-callable tool.
pub(super) fn local_schedule_dispatch_claim(
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
    events::require_schedule_key(store, &scope, &request.expected_schedule_id)?;
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

pub(super) fn local_schedule_dispatch_bind(
    app: tauri::AppHandle,
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
    record_project_occurrence(
        app,
        &request.workspace_id,
        &request.occurrence_id,
        &request.attempt_id,
        false,
    )?;
    dispatch.attempt_id = Some(request.attempt_id);
    dispatch.lease_expires_at = lease.clone();
    Ok(lease)
}

pub(super) fn local_schedule_dispatch_renew(
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

pub(super) fn local_schedule_dispatch_finish(
    app: tauri::AppHandle,
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
    record_project_occurrence(
        app,
        &request.workspace_id,
        &request.occurrence_id,
        &request.attempt_id,
        true,
    )?;
    *active = None;
    Ok(())
}

pub(super) fn local_schedule_dispatch_abandon(
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

pub(super) fn record_project_occurrence(
    app: tauri::AppHandle,
    workspace: &str,
    occurrence: &str,
    run: &str,
    finished: bool,
) -> Result<(), String> {
    let profiles = crate::collaboration::native_profiles(app, workspace)?;
    let store = global_store()?;
    store
        .transaction(|conn| {
            let scope = authorized_scope::resolve(conn, Some(workspace), None, ScopeAccess::Write)?;
            let row = repo::get_occurrence(conn, store, &scope.private, occurrence)?
                .ok_or_else(|| StoreError::Invalid("The occurrence is unavailable.".into()))?;
            let payload: OccurrencePayload = serde_json::from_value(row.payload)
                .map_err(|_| StoreError::Invalid("The occurrence context is invalid.".into()))?;
            if payload.work_id.is_some() {
                return Ok(());
            }
            if let Some(project) = payload.project_id {
                let time = timestamp(Utc::now());
                if finished {
                    crate::collaboration::finish_schedule(
                        conn, store, &scope, &profiles, run, &time,
                    )?;
                } else {
                    crate::collaboration::bind_schedule(
                        conn,
                        store,
                        &scope,
                        &profiles,
                        &project,
                        &payload.agent_id,
                        run,
                        &time,
                    )?;
                }
            }
            Ok(())
        })
        .map_err(|error| error.to_string())
}

pub(super) fn validate_dispatch_identity(
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

pub(super) fn resolve_private_scope(
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

pub(super) fn global_store() -> Result<&'static Store, String> {
    crate::store::try_global()
        .ok_or_else(|| "Mivlet's encrypted store is not initialized.".to_string())
}

pub(super) fn record_schedule_change(schedule: &LocalSchedule, action: &str) {
    crate::action_history::Recorder::new("system", "local-schedule", action, "completed")
        .risk("medium")
        .mode("explicit-user-change")
        .correlation(&format!("{}-r{}", schedule.id, schedule.revision))
        .summary("A local schedule definition changed.")
        .record();
}

pub(super) fn create_at(
    tx: &rusqlite::Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    request: CreateLocalScheduleRequest,
    now: DateTime<Utc>,
) -> crate::store::Result<LocalSchedule> {
    validate_bounded_id_store(&request.id, "Schedule", MAX_ID_CHARACTERS)?;
    validate_execution_kind(&request.execution_kind, &request.permission_mode)?;
    validate_route_and_agent(&request.agent_id, &request.provider_id, &request.model)?;
    validate_reasoning_effort(request.reasoning_effort.as_deref())?;
    validate_prompt(&request.prompt)?;
    crate::collaboration::validate_schedule_project(
        tx,
        store,
        scope,
        request.project_id.as_deref(),
        &request.agent_id,
    )?;
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
        execution_kind: request.execution_kind,
        permission_mode: request.permission_mode,
        prompt_fingerprint: fingerprint(&request.prompt),
        prompt: request.prompt,
        prompt_revision: 1,
        timezone: request.timezone,
        trigger: request.trigger,
        project_id: request.project_id.clone(),
        agent_id: request.agent_id.clone(),
        provider_id: request.provider_id.clone(),
        model: request.model.clone(),
        reasoning_effort: request.reasoning_effort,
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

pub(super) fn update_at(
    tx: &rusqlite::Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    request: UpdateLocalScheduleRequest,
    now: DateTime<Utc>,
) -> crate::store::Result<LocalSchedule> {
    validate_bounded_id_store(&request.id, "Schedule", MAX_ID_CHARACTERS)?;
    validate_execution_kind(&request.execution_kind, &request.permission_mode)?;
    validate_route_and_agent(&request.agent_id, &request.provider_id, &request.model)?;
    validate_reasoning_effort(request.reasoning_effort.as_deref())?;
    validate_prompt(&request.prompt)?;
    crate::collaboration::validate_schedule_project(
        tx,
        store,
        scope,
        request.project_id.as_deref(),
        &request.agent_id,
    )?;
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
    if matches!(prior.trigger, LocalScheduleTrigger::Event { .. })
        && !matches!(request.trigger, LocalScheduleTrigger::Event { .. })
    {
        return Err(StoreError::Invalid(
            "An event trigger cannot become a clock schedule.".into(),
        ));
    }
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
        execution_kind: request.execution_kind,
        permission_mode: request.permission_mode,
        prompt_fingerprint: fingerprint(&request.prompt),
        prompt: request.prompt,
        prompt_revision,
        timezone: request.timezone,
        trigger: request.trigger,
        project_id: request.project_id.clone(),
        agent_id: request.agent_id.clone(),
        provider_id: request.provider_id.clone(),
        model: request.model.clone(),
        reasoning_effort: request.reasoning_effort,
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

pub(super) fn set_status_at(
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
    if matches!(payload.trigger, LocalScheduleTrigger::Event { .. }) {
        crate::store::repos::local_event::retire_pending(
            tx,
            &scope.private,
            &row.id,
            if request.status == LocalScheduleStatus::Cancelled {
                "removed"
            } else {
                "paused"
            },
        )?;
        row.next_run_at = None;
    }
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

pub(super) fn claim_due_after_capacity_matching(
    store: &Store,
    scope: &PrivateDataScope,
    reservation: LocalScheduleCapacityReservation,
    now: DateTime<Utc>,
    expected: Option<(&str, i64)>,
) -> crate::store::Result<Option<LocalScheduleClaim>> {
    store.transaction(|tx| {
        let now_text = timestamp(now);
        repo::interrupt_expired(tx, store, scope, &now_text)?;
        let selected = if let Some((id, _)) = expected {
            repo::get_schedule(tx, store, scope, id)?.filter(|row| {
                row.status == "enabled"
                    && row
                        .next_run_at
                        .as_deref()
                        .is_some_and(|next| next <= now_text.as_str())
            })
        } else {
            repo::first_due_schedule(tx, store, scope, &now_text)?
        };
        let Some(mut schedule_row) = selected else {
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
        if let LocalScheduleTrigger::Event { config } = &schedule.trigger {
            return events::claim(tx, store, scope, schedule_row, config, &reservation, now);
        }
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
            event: None,
            execution_kind: schedule.execution_kind.clone(),
            permission_mode: schedule.permission_mode.clone(),
            work_id: None,
            prompt: schedule.prompt.clone(),
            prompt_fingerprint: fingerprint(&schedule.prompt),
            prompt_revision: schedule.prompt_revision,
            timezone: schedule.timezone.clone(),
            trigger: schedule.trigger.clone(),
            project_id: schedule.project_id.clone(),
            agent_id: schedule.agent_id.clone(),
            provider_id: schedule.provider_id.clone(),
            model: schedule.model.clone(),
            reasoning_effort: schedule.reasoning_effort.clone(),
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
            execution_kind: schedule.execution_kind,
            permission_mode: schedule.permission_mode,
            occurrence_id,
            schedule_id: schedule.id,
            schedule_revision: schedule.revision,
            prompt_revision: schedule.prompt_revision,
            scheduled_for: timestamp(slot.instant),
            claim_token,
            lease_expires_at,
            project_id: schedule.project_id,
            agent_id: schedule.agent_id,
            provider_id: schedule.provider_id,
            model: schedule.model,
            reasoning_effort: schedule.reasoning_effort,
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
