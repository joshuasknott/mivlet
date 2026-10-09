use super::super::*;
use super::models::{DeliveryPayload, EventConfig};
use crate::store::repos::local_event;

pub(in crate::local_schedules) fn claim(
    conn: &rusqlite::Connection,
    store: &Store,
    scope: &PrivateDataScope,
    mut row: ScheduleRow,
    config: &EventConfig,
    reservation: &LocalScheduleCapacityReservation,
    now: DateTime<Utc>,
) -> crate::store::Result<Option<LocalScheduleClaim>> {
    let time = timestamp(now);
    local_event::purge_expired_tombstones(conn, scope, &time)?;
    let expired = DateTime::parse_from_rfc3339(&config.valid_until)
        .map_err(|_| StoreError::Invalid("The event trigger expiry is invalid.".into()))?
        .with_timezone(&Utc)
        <= now;
    if expired {
        local_event::retire_pending(conn, scope, &row.id, "expired")?;
        row.next_run_at = None;
        repo::replace_schedule(conn, store, scope, row.revision, &row)?;
        return Ok(None);
    }
    while let Some(mut delivery) = local_event::first_pending(conn, store, scope, &row.id)? {
        if delivery.expires_at <= time || delivery.schedule_revision != row.revision {
            delivery.state = "expired".into();
            delivery.payload["reason"] = serde_json::json!(if delivery.expires_at <= time {
                "The event expired while waiting for admission."
            } else {
                "The trigger changed before admission. Redeliver a fresh event."
            });
            local_event::replace(conn, store, scope, &delivery)?;
            continue;
        }
        let payload: DeliveryPayload =
            serde_json::from_value(delivery.payload.clone()).map_err(|_| {
                StoreError::Invalid("The event delivery context is unavailable.".into())
            })?;
        let prompt = payload
            .prompt
            .ok_or_else(|| StoreError::Invalid("The event request is unavailable.".into()))?;
        let schedule = schedule_from_row(row.clone())?;
        let occurrence_id = random_token("occurrence")?;
        let claim_token = random_token("schedule-claim")?;
        let lease_expires_at = timestamp(now + Duration::minutes(CLAIM_LEASE_MINUTES));
        let occurrence_payload = OccurrencePayload {
            execution_kind: "agent".into(),
            permission_mode: schedule.permission_mode.clone(),
            work_id: None,
            prompt: prompt.clone(),
            prompt_fingerprint: fingerprint(&prompt),
            prompt_revision: schedule.prompt_revision,
            timezone: schedule.timezone.clone(),
            trigger: schedule.trigger.clone(),
            project_id: schedule.project_id.clone(),
            agent_id: schedule.agent_id.clone(),
            provider_id: schedule.provider_id.clone(),
            model: schedule.model.clone(),
            reasoning_effort: schedule.reasoning_effort.clone(),
            intended_local_slot: delivery.id.clone(),
            capacity_reservation_fingerprint: fingerprint(&reservation.id),
            outcome: None,
            detail: None,
            event: Some(super::models::EventWorkOrigin {
                delivery_id: delivery.id.clone(),
                source: config.source.clone(),
                received_at: delivery.received_at.clone(),
                expires_at: delivery.expires_at.clone(),
                selected_fields: payload.selected_fields,
            }),
        };
        repo::insert_claimed_occurrence(
            conn,
            store,
            scope,
            &OccurrenceRow {
                id: occurrence_id.clone(),
                schedule_id: schedule.id.clone(),
                schedule_revision: schedule.revision,
                prompt_revision: schedule.prompt_revision,
                state: "claimed".into(),
                slot_fingerprint: delivery.fingerprint.clone().ok_or_else(|| {
                    StoreError::Invalid("The event authentication receipt is unavailable.".into())
                })?,
                claim_fingerprint: fingerprint(&claim_token),
                lease_expires_at: lease_expires_at.clone(),
                execution_attempt_id: None,
                scheduled_for: delivery.received_at.clone(),
                claimed_at: time.clone(),
                started_at: None,
                completed_at: None,
                updated_at: time.clone(),
                payload: encode(&occurrence_payload)?,
            },
        )?;
        delivery.state = "claimed".into();
        delivery.occurrence_id = Some(occurrence_id.clone());
        delivery.payload["reason"] =
            serde_json::json!("Authenticated event claimed for ordinary Work admission.");
        local_event::replace(conn, store, scope, &delivery)?;
        row.next_run_at = local_event::first_pending(conn, store, scope, &row.id)?
            .map(|delivery| delivery.received_at);
        repo::replace_schedule(conn, store, scope, row.revision, &row)?;
        return Ok(Some(LocalScheduleClaim {
            execution_kind: "agent".into(),
            permission_mode: schedule.permission_mode,
            occurrence_id,
            schedule_id: schedule.id,
            schedule_revision: schedule.revision,
            prompt_revision: schedule.prompt_revision,
            scheduled_for: delivery.received_at,
            claim_token,
            lease_expires_at,
            project_id: schedule.project_id,
            agent_id: schedule.agent_id,
            provider_id: schedule.provider_id,
            model: schedule.model,
            reasoning_effort: schedule.reasoning_effort,
            prompt,
        }));
    }
    row.next_run_at = None;
    repo::replace_schedule(conn, store, scope, row.revision, &row)?;
    Ok(None)
}
