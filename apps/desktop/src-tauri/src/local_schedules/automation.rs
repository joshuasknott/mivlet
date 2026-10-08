//! Native staging binds automation occurrences to the existing durable Work lane.
use super::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StageRequest {
    workspace_id: String,
    occurrence_id: String,
    claim_token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedWork {
    work_id: String,
    thread_id: String,
}

#[tauri::command]
pub fn local_schedule_dispatch_stage(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    coordinator: tauri::State<'_, LocalScheduleDispatchCoordinator>,
    request: StageRequest,
) -> Result<StagedWork, String> {
    require_main_window(&window)?;
    let active = coordinator
        .active
        .lock()
        .map_err(|_| "The schedule dispatcher is unavailable.")?;
    let dispatch = active
        .as_ref()
        .ok_or("This schedule no longer owns the dispatcher slot.")?;
    validate_dispatch_identity(
        dispatch,
        &request.workspace_id,
        &request.occurrence_id,
        &request.claim_token,
        None,
    )?;
    let profiles = crate::collaboration::native_profiles(app, &request.workspace_id)?;
    let store = global_store()?;
    let private_scope = resolve_private_scope(store, &request.workspace_id, ScopeAccess::Write)?;
    events::require_occurrence_key(store, &private_scope, &request.occurrence_id)?;
    store
        .transaction(|conn| {
            let scope = authorized_scope::resolve(
                conn,
                Some(&request.workspace_id),
                None,
                ScopeAccess::Write,
            )?;
            stage_at(
                conn,
                store,
                &scope,
                &profiles,
                &request.occurrence_id,
                &request.claim_token,
                Utc::now(),
            )
        })
        .map_err(|error| error.to_string())
}

pub(super) fn stage_at(
    conn: &rusqlite::Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    profiles: &[crate::models::MivletAgentProfile],
    occurrence_id: &str,
    claim_token: &str,
    now: DateTime<Utc>,
) -> crate::store::Result<StagedWork> {
    let time = timestamp(now);
    let mut row = repo::get_occurrence(conn, store, &scope.private, occurrence_id)?
        .ok_or_else(|| StoreError::Invalid("This schedule occurrence is unavailable.".into()))?;
    let schedule = repo::get_schedule(conn, store, &scope.private, &row.schedule_id)?
        .ok_or_else(|| StoreError::Invalid("This schedule is unavailable.".into()))?;
    if row.state != "claimed"
        || row.claim_fingerprint != fingerprint(claim_token)
        || row.lease_expires_at <= time
        || schedule.status != "enabled"
    {
        return Err(StoreError::Invalid(
            "The schedule occurrence was paused, cancelled or expired.".into(),
        ));
    }
    if schedule.trigger_kind == "event" {
        let expiry = schedule.payload["trigger"]["validUntil"]
            .as_str()
            .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
            .ok_or_else(|| StoreError::Invalid("The event trigger expiry is invalid.".into()))?;
        if schedule.revision != row.schedule_revision || expiry <= now {
            return Err(StoreError::Invalid(
                "The event trigger changed or expired before Work admission.".into(),
            ));
        }
        let event_expiry = row.payload["event"]["expiresAt"]
            .as_str()
            .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
            .ok_or_else(|| StoreError::Invalid("The event receipt expiry is invalid.".into()))?;
        if event_expiry <= now {
            return Err(StoreError::Invalid(
                "The event expired before Work admission.".into(),
            ));
        }
    }
    let mut payload: OccurrencePayload = serde_json::from_value(row.payload.clone())
        .map_err(|_| StoreError::Invalid("The frozen schedule context is invalid.".into()))?;
    if payload.execution_kind != "agent" {
        return Err(StoreError::Invalid(
            "Research schedules use their restricted research runner.".into(),
        ));
    }
    let claim = LocalScheduleClaim {
        execution_kind: payload.execution_kind.clone(),
        permission_mode: payload.permission_mode.clone(),
        occurrence_id: row.id.clone(),
        schedule_id: row.schedule_id.clone(),
        schedule_revision: row.schedule_revision,
        prompt_revision: row.prompt_revision,
        scheduled_for: row.scheduled_for.clone(),
        claim_token: String::new(),
        lease_expires_at: row.lease_expires_at.clone(),
        project_id: payload.project_id.clone(),
        agent_id: payload.agent_id.clone(),
        provider_id: payload.provider_id.clone(),
        model: payload.model.clone(),
        reasoning_effort: payload.reasoning_effort.clone(),
        prompt: payload.prompt.clone(),
    };
    let work = crate::collaboration::stage_schedule(conn, store, scope, profiles, &claim, &time)?;
    payload.work_id = Some(work.id.clone());
    row.payload = encode(&payload)?;
    repo::replace_occurrence(conn, store, &scope.private, &row, Some("claimed"))?;
    Ok(StagedWork {
        work_id: work.id,
        thread_id: work.conversation_id,
    })
}

#[cfg(test)]
mod tests {
    use super::super::tests::{at, daily_request, store_and_scope};
    use super::*;
    use crate::collaboration::models::{Work, WorkStatus};
    use crate::store::repos::{collaboration, execution_attempt};
    const NOW: &str = "2026-09-07T12:00:00.000Z";

    fn fixture() -> (
        Store,
        AuthorizedCommandScope,
        LocalScheduleClaim,
        Vec<crate::models::MivletAgentProfile>,
    ) {
        let (store, scope) = store_and_scope();
        let mut request = daily_request(LocalScheduleStatus::Enabled);
        request.execution_kind = "agent".into();
        request.permission_mode = "full-access".into();
        store
            .transaction(|conn| {
                create_at(conn, &store, &scope, request, at("2026-09-07T07:00:00Z"))
            })
            .unwrap();
        let claim = claim_due_after_capacity(
            &store,
            &scope.private,
            LocalScheduleCapacityReservation::new("capacity".into()).unwrap(),
            at(NOW),
        )
        .unwrap()
        .unwrap();
        let profiles = vec![serde_json::from_value(serde_json::json!({
            "id":"agent-research", "name":"Researcher", "instructions":"Fixture agent",
            "modelId":"openai::later-model", "icon":"sparkle", "permissionLabel":"Ask Me"
        }))
        .unwrap()];
        (store, scope, claim, profiles)
    }
    fn staged(
        store: &Store,
        scope: &AuthorizedCommandScope,
        claim: &LocalScheduleClaim,
        profiles: &[crate::models::MivletAgentProfile],
    ) -> StagedWork {
        store
            .transaction(|conn| {
                stage_at(
                    conn,
                    store,
                    scope,
                    profiles,
                    &claim.occurrence_id,
                    &claim.claim_token,
                    at(NOW),
                )
            })
            .unwrap()
    }
    fn work(store: &Store, scope: &AuthorizedCommandScope, id: &str) -> Work {
        store
            .with_conn(|conn| {
                collaboration::get(conn, store, &scope.private, collaboration::Kind::Work, id)
            })
            .unwrap()
            .unwrap()
    }

    #[test]
    fn captures_route_effort_and_minimum_permission_without_persisting_claim() {
        let (store, scope, claim, profiles) = fixture();
        let first = staged(&store, &scope, &claim, &profiles);
        let second = staged(&store, &scope, &claim, &profiles);
        assert_eq!(first.work_id, second.work_id);
        let work = work(&store, &scope, &first.work_id);
        assert_eq!(work.model_option_id, "openai::gpt-5");
        assert_eq!(work.user_request, claim.prompt);
        assert_eq!(work.permission_mode, "trusted-scope");
        assert_eq!(
            work.schedule.as_ref().unwrap().reasoning_effort.as_deref(),
            Some("low")
        );
        assert!(!serde_json::to_string(&work)
            .unwrap()
            .contains(&claim.claim_token));
        assert!(store
            .transaction(|conn| stage_at(
                conn,
                &store,
                &scope,
                &profiles,
                &claim.occurrence_id,
                "wrong-token",
                at(NOW)
            ))
            .is_err());
        assert!(store
            .transaction(|conn| stage_at(
                conn,
                &store,
                &scope,
                &profiles,
                &claim.occurrence_id,
                &claim.claim_token,
                at("2026-09-07T12:06:00Z")
            ))
            .is_err());
    }

    #[test]
    fn exact_due_selection_skips_unavailable_routes_without_granting_other_scopes_or_future_slots()
    {
        let (store, scope) = store_and_scope();
        store
            .transaction(|conn| {
                create_at(
                    conn,
                    &store,
                    &scope,
                    daily_request(LocalScheduleStatus::Enabled),
                    at("2026-09-07T07:00:00Z"),
                )?;
                let mut next = daily_request(LocalScheduleStatus::Enabled);
                next.id = "schedule-2".into();
                create_at(conn, &store, &scope, next, at("2026-09-07T07:00:00Z"))?;
                Ok(())
            })
            .unwrap();
        let claim = claim_due_after_capacity_matching(
            &store,
            &scope.private,
            LocalScheduleCapacityReservation::new("capacity-2".into()).unwrap(),
            at(NOW),
            Some(("schedule-2", 1)),
        )
        .unwrap()
        .unwrap();
        assert_eq!(claim.schedule_id, "schedule-2");
        assert!(claim_due_after_capacity_matching(
            &store,
            &scope.private,
            LocalScheduleCapacityReservation::new("future".into()).unwrap(),
            at(NOW),
            Some(("schedule-2", 1))
        )
        .unwrap()
        .is_none());
        let other = crate::store::repos::scope::PrivateDataScope::for_authenticated_user(
            scope.data.clone(),
            "user-2",
            Some("member-2"),
        )
        .unwrap();
        assert!(claim_due_after_capacity_matching(
            &store,
            &other,
            LocalScheduleCapacityReservation::new("other".into()).unwrap(),
            at(NOW),
            Some(("schedule-1", 1))
        )
        .unwrap()
        .is_none());
    }

    #[test]
    fn abandoned_and_expired_stages_require_explicit_reconciliation() {
        for expired in [false, true] {
            let (store, scope, claim, profiles) = fixture();
            let staged = staged(&store, &scope, &claim, &profiles);
            store
                .transaction(|conn| {
                    if expired {
                        repo::interrupt_expired(
                            conn,
                            &store,
                            &scope.private,
                            "2026-09-07T12:06:00.000Z",
                        )?;
                    } else {
                        repo::interrupt_claimed(
                            conn,
                            &store,
                            &scope.private,
                            &claim.occurrence_id,
                            &fingerprint(&claim.claim_token),
                            "Fixture interruption",
                            NOW,
                        )?;
                    }
                    Ok(())
                })
                .unwrap();
            let work = work(&store, &scope, &staged.work_id);
            assert_eq!(work.status, WorkStatus::AwaitingUser);
            assert_eq!(work.generation, 2);
            assert!(work.awaiting_user);
            assert!(work.run_ids.is_empty());
        }
    }

    #[test]
    fn occurrence_authority_rejects_unbound_paused_expired_and_cross_member_effects() {
        let (store, scope, claim, profiles) = fixture();
        let staged = staged(&store, &scope, &claim, &profiles);
        let root = work(&store, &scope, &staged.work_id);
        store
            .transaction(|conn| {
                let check = |private: &crate::store::repos::scope::PrivateDataScope,
                             time: &str,
                             running| {
                    crate::collaboration::check_schedule(
                        conn, &store, private, &root, time, running,
                    )
                };
                assert!(check(&scope.private, NOW, false).is_ok());
                assert!(check(&scope.private, NOW, true).is_err());
                let other = crate::store::repos::scope::PrivateDataScope::for_authenticated_user(
                    scope.data.clone(),
                    "user-2",
                    Some("member-2"),
                )?;
                assert!(check(&other, NOW, false).is_err());
                let mut row =
                    repo::get_occurrence(conn, &store, &scope.private, &claim.occurrence_id)?
                        .unwrap();
                row.state = "running".into();
                repo::replace_occurrence(conn, &store, &scope.private, &row, Some("claimed"))?;
                assert!(check(&scope.private, NOW, true).is_ok());
                assert!(check(&scope.private, "2026-09-07T12:06:00.000Z", true).is_err());
                let mut schedule =
                    repo::get_schedule(conn, &store, &scope.private, &claim.schedule_id)?.unwrap();
                schedule.status = "paused".into();
                repo::replace_schedule(conn, &store, &scope.private, schedule.revision, &schedule)?;
                assert!(check(&scope.private, NOW, true).is_err());
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn late_occurrence_expiry_does_not_interrupt_a_reconciled_user_continuation() {
        let (store, scope, claim, profiles) = fixture();
        let staged = staged(&store, &scope, &claim, &profiles);
        store
            .transaction(|conn| {
                let mut item: Work = collaboration::get(
                    conn,
                    &store,
                    &scope.private,
                    collaboration::Kind::Work,
                    &staged.work_id,
                )?
                .unwrap();
                item.schedule = None;
                item.generation = 2;
                collaboration::put(
                    conn,
                    &store,
                    &scope.private,
                    collaboration::Kind::Work,
                    &item.id,
                    Some(&item.conversation_id),
                    None,
                    &item,
                )?;
                repo::interrupt_expired(conn, &store, &scope.private, "2026-09-07T12:06:00.000Z")?;
                Ok(())
            })
            .unwrap();
        let item = work(&store, &scope, &staged.work_id);
        assert_eq!(item.status, WorkStatus::Queued);
        assert_eq!(item.generation, 2);
    }

    #[test]
    fn binds_only_frozen_attempt_and_finishes_from_durable_work_after_multiple_turns() {
        let (store, scope, claim, profiles) = fixture();
        let staged = staged(&store, &scope, &claim, &profiles);
        store
            .transaction(|conn| {
                execution_attempt::upsert_scoped(
                    conn,
                    &store,
                    &scope.data,
                    "actual-attempt",
                    Some(&staged.thread_id),
                    &claim.provider_id,
                    &claim.model,
                    "queued",
                    0,
                    true,
                    0,
                    NOW,
                    NOW,
                    &serde_json::json!({"exchanges":[{"role":"user","content":claim.prompt}]}),
                )?;
                repo::bind_pending_attempt(
                    conn,
                    &store,
                    &scope.private,
                    &claim.occurrence_id,
                    &fingerprint(&claim.claim_token),
                    "actual-attempt",
                    NOW,
                    "2026-09-07T12:05:00.000Z",
                )?;
                Ok(())
            })
            .unwrap();
        let finish = |outcome: &str| {
            store.transaction(|conn| {
                repo::finish_occurrence(
                    conn,
                    &store,
                    &scope.private,
                    &claim.occurrence_id,
                    &fingerprint(&claim.claim_token),
                    "actual-attempt",
                    outcome,
                    None,
                    NOW,
                )
            })
        };
        assert!(finish("completed").is_err());
        store
            .transaction(|conn| {
                let mut item: Work = collaboration::get(
                    conn,
                    &store,
                    &scope.private,
                    collaboration::Kind::Work,
                    &staged.work_id,
                )?
                .unwrap();
                item.status = WorkStatus::Completed;
                item.run_ids = vec!["actual-attempt".into(), "fresh-final-turn".into()];
                collaboration::put(
                    conn,
                    &store,
                    &scope.private,
                    collaboration::Kind::Work,
                    &item.id,
                    Some(&item.conversation_id),
                    None,
                    &item,
                )
            })
            .unwrap();
        assert!(finish("failed").is_err());
        assert_eq!(finish("completed").unwrap().state, "completed");
        assert!(finish("completed").is_err());
    }
}
