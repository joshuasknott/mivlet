//! Local schedule regression tests.

use super::*;
use crate::store::repos::scope::{DataScope, PrivateDataScope};
use crate::store::repos::{execution_attempt, thread};
use crate::store::vault::{MasterKey, Vault};
use chrono::NaiveDate;

pub(super) fn store_and_scope() -> (Store, AuthorizedCommandScope) {
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
        PrivateDataScope::for_authenticated_user(data.clone(), "user-1", Some("member-1")).unwrap();
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

pub(super) fn daily_request(status: LocalScheduleStatus) -> CreateLocalScheduleRequest {
    CreateLocalScheduleRequest {
        execution_kind: research_kind(),
        permission_mode: read_only_permission(),
        workspace_id: "workspace-1".into(),
        id: "schedule-1".into(),
        project_id: None,
        agent_id: "agent-research".into(),
        provider_id: "openai".into(),
        model: "gpt-5".into(),
        reasoning_effort: Some("low".into()),
        prompt: "Check the report. It may mention an API key without storing one.".into(),
        timezone: "Europe/London".into(),
        trigger: LocalScheduleTrigger::Daily {
            local_time: "09:00".into(),
        },
        status,
    }
}

pub(super) fn at(value: &str) -> DateTime<Utc> {
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
    assert_eq!(schedule.reasoning_effort.as_deref(), Some("low"));
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
            let mut legacy =
                repo::get_schedule(conn, &store, &scope.private, "schedule-1")?.unwrap();
            legacy
                .payload
                .as_object_mut()
                .unwrap()
                .remove("reasoningEffort");
            assert!(schedule_from_row(legacy)?.reasoning_effort.is_none());
            Ok(())
        })
        .unwrap();
}

#[test]
fn previews_use_saved_civil_time_rules_and_reject_invalid_inputs() {
    let result = local_schedule_preview(PreviewLocalScheduleRequest {
        timezone: "Europe/London".into(),
        trigger: LocalScheduleTrigger::Once {
            local_date_time: "2099-01-01T09:00".into(),
        },
    })
    .unwrap();
    assert_eq!(result.as_deref(), Some("2099-01-01T09:00:00.000Z"));
    assert!(local_schedule_preview(PreviewLocalScheduleRequest {
        timezone: "Not/A_Timezone".into(),
        trigger: LocalScheduleTrigger::Daily {
            local_time: "09:00".into()
        },
    })
    .is_err());
    assert!(validate_reasoning_effort(Some("invented-effort")).is_err());
    assert!(validate_reasoning_effort(Some("medium")).is_ok());
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
    let other =
        PrivateDataScope::for_authenticated_user(scope.data.clone(), "user-2", Some("member-2"))
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
    assert_eq!(claim.reasoning_effort.as_deref(), Some("low"));
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
            let current = repo::get_schedule(conn, &store, &scope.private, "schedule-1")?.unwrap();
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
                repo::get_occurrence(conn, &store, &scope.private, &claim.occurrence_id)?.unwrap();
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
                repo::get_occurrence(conn, &store, &scope.private, &claim.occurrence_id)?.unwrap();
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
        execution_kind: research_kind(),
        permission_mode: read_only_permission(),
        workspace_id: "workspace-1".into(),
        id: created.id.clone(),
        expected_revision: created.revision,
        project_id: created.project_id.clone(),
        agent_id: created.agent_id.clone(),
        provider_id: created.provider_id.clone(),
        model: created.model.clone(),
        reasoning_effort: created.reasoning_effort.clone(),
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
