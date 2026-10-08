use super::super::*;
use super::{models::*, signature, template};
use crate::store::repos::local_event::{self, DeliveryRow};
use std::collections::BTreeMap;

pub(super) struct Receipt {
    pub status: u16,
    pub id: Option<String>,
    pub reason: &'static str,
}

pub(super) struct IncomingEvent<'a> {
    pub schedule_id: &'a str,
    pub route: &'a str,
    pub headers: &'a BTreeMap<String, String>,
    pub raw: &'a [u8],
    pub now: DateTime<Utc>,
}

/// The production account guard owns the final SQL commit, after native custody
/// verification has released its own identity lock. A fixture guard exists only
/// in tests; no renderer or event selects a fence.
pub(super) trait ReceiptFence {
    fn commit<T>(
        &self,
        operation: impl FnOnce() -> crate::store::Result<T>,
    ) -> crate::store::Result<T>;
}
impl ReceiptFence for crate::account_session::AccountDispatchFence {
    fn commit<T>(
        &self,
        operation: impl FnOnce() -> crate::store::Result<T>,
    ) -> crate::store::Result<T> {
        self.with_current(|| Ok(operation()))
            .map_err(StoreError::Invalid)?
    }
}
#[cfg(test)]
impl ReceiptFence for () {
    fn commit<T>(
        &self,
        operation: impl FnOnce() -> crate::store::Result<T>,
    ) -> crate::store::Result<T> {
        operation()
    }
}

pub(super) fn receive(
    store: &Store,
    scope: &AuthorizedCommandScope,
    incoming: IncomingEvent<'_>,
    verify: impl FnOnce(
        &LocalSchedule,
        &events::models::EventConfig,
        &[u8],
        &str,
    ) -> Result<bool, String>,
    sanitize: impl FnOnce(&LocalSchedule, &EventConfig, EventPreview) -> Result<EventPreview, String>,
    fence: &impl ReceiptFence,
) -> crate::store::Result<Receipt> {
    let IncomingEvent {
        schedule_id,
        route,
        headers,
        raw,
        now,
    } = incoming;
    let schedule = store.with_conn(|conn| {
        repo::get_schedule(conn, store, &scope.private, schedule_id)?
            .map(schedule_from_row)
            .transpose()
    })?;
    let Some(schedule) = schedule else {
        return Ok(Receipt {
            status: 404,
            id: None,
            reason: "unknown_endpoint",
        });
    };
    let LocalScheduleTrigger::Event { config } = &schedule.trigger else {
        return Ok(Receipt {
            status: 404,
            id: None,
            reason: "unknown_endpoint",
        });
    };
    if config.route_id != route || schedule.status == LocalScheduleStatus::Cancelled {
        return Ok(Receipt {
            status: 404,
            id: None,
            reason: "unknown_endpoint",
        });
    }
    let authentication = signature::verify(config, headers, raw, now, |body, signature| {
        verify(&schedule, config, body, signature)
    });
    let preview = match authentication.as_ref() {
        Ok(event) => template::render(&config.draft(), &schedule.prompt, &event.body)
            .map_err(|_| "invalid_selected_fields")
            .and_then(|preview| {
                sanitize(&schedule, config, preview).map_err(|_| "signing_key_unavailable")
            })
            .map(Some),
        Err(_) => Ok(None),
    };
    fence.commit(|| {
        store.transaction(|conn| {
            let current = repo::get_schedule(conn, store, &scope.private, schedule_id)?
                .ok_or_else(|| StoreError::Invalid("The event trigger is unavailable.".into()))?;
            if current.revision != schedule.revision || current.status == "cancelled" {
                return Ok(Receipt {
                    status: 409,
                    id: None,
                    reason: "trigger_changed",
                });
            }
            let time = timestamp(now);
            local_event::prune(
                conn,
                store,
                &scope.private,
                schedule_id,
                &time,
                &timestamp(now - Duration::hours(24)),
            )?;
            let (status, reason, verified) = match authentication {
                Ok(verified) => (202, "accepted", Some(verified)),
                Err(reason) => (
                    match reason {
                        "invalid_signature" => 401,
                        "signing_key_unavailable" => 503,
                        "event_expired" | "trigger_expired" => 410,
                        _ => 422,
                    },
                    reason,
                    None,
                ),
            };
            if let Some(verified) = &verified {
                if let Some(id) = local_event::duplicate(
                    conn,
                    &scope.private,
                    schedule_id,
                    &verified.id_fingerprint,
                    &verified.body_fingerprint,
                )? {
                    let original =
                        local_event::get(conn, store, &scope.private, &id)?.ok_or_else(|| {
                            StoreError::Invalid("The prior delivery is unavailable.".into())
                        })?;
                    return Ok(Receipt {
                        status: if original.body_fingerprint.as_deref()
                            == Some(verified.body_fingerprint.as_str())
                        {
                            200
                        } else {
                            409
                        },
                        id: Some(id),
                        reason: if original.body_fingerprint.as_deref()
                            == Some(verified.body_fingerprint.as_str())
                        {
                            "duplicate"
                        } else {
                            "idempotency_conflict"
                        },
                    });
                }
            }
            if local_event::count(conn, &scope.private, schedule_id)? >= 10_000 {
                return Ok(Receipt {
                    status: 429,
                    id: None,
                    reason: "delivery_capacity",
                });
            }
            let (status, reason, preview) = match preview {
                Ok(Some(preview)) if !preview.missing.is_empty() => {
                    (422, "missing_selected_fields", None)
                }
                Ok(preview) => (status, reason, preview),
                Err(reason) => (
                    if reason == "signing_key_unavailable" {
                        503
                    } else {
                        422
                    },
                    reason,
                    None,
                ),
            };
            let paused = current.status != "enabled";
            if status == 202
                && !paused
                && local_event::pending_count(conn, &scope.private, schedule_id)? >= 128
            {
                return Ok(Receipt {
                    status: 429,
                    id: None,
                    reason: "pending_capacity",
                });
            }
            let state = if status != 202 {
                "rejected"
            } else if paused {
                "paused"
            } else {
                "pending"
            };
            let id = random_token("delivery")?;
            let expires_at = verified
                .as_ref()
                .map(|event| {
                    timestamp(event.event_time + Duration::seconds(config.max_age_seconds.into()))
                })
                .unwrap_or_else(|| time.clone());
            let payload = DeliveryPayload {
                source: config.source.clone(),
                reason: if paused && status == 202 {
                    "This trigger is paused. The event will not run or replay on resume.".into()
                } else {
                    reason.into()
                },
                selected_fields: preview
                    .as_ref()
                    .map(|p| p.selected_fields.clone())
                    .unwrap_or_default(),
                prompt: preview.map(|p| p.prompt),
                event_time: verified.as_ref().map(|event| timestamp(event.event_time)),
            };
            local_event::insert(
                conn,
                store,
                &scope.private,
                &DeliveryRow {
                    id: id.clone(),
                    schedule_id: schedule_id.into(),
                    schedule_revision: current.revision,
                    fingerprint: verified.as_ref().map(|event| event.id_fingerprint.clone()),
                    body_fingerprint: verified
                        .as_ref()
                        .map(|event| event.body_fingerprint.clone()),
                    state: state.into(),
                    received_at: time.clone(),
                    expires_at,
                    dedup_until: timestamp(now + Duration::days(7)),
                    occurrence_id: None,
                    payload: encode(&payload)?,
                },
            )?;
            local_event::prune(
                conn,
                store,
                &scope.private,
                schedule_id,
                &time,
                &timestamp(now - Duration::hours(24)),
            )?;
            if state == "pending" {
                let mut row = current;
                row.next_run_at =
                    local_event::first_pending(conn, store, &scope.private, schedule_id)?
                        .map(|event| event.received_at);
                repo::replace_schedule(conn, store, &scope.private, row.revision, &row)?;
            }
            Ok(Receipt {
                status: if paused && status == 202 { 409 } else { status },
                id: Some(id),
                reason: if paused && status == 202 {
                    "trigger_paused"
                } else {
                    reason
                },
            })
        })
    })
}

pub(super) fn public(
    store: &Store,
    conn: &rusqlite::Connection,
    scope: &PrivateDataScope,
    row: DeliveryRow,
) -> crate::store::Result<EventDelivery> {
    let payload: DeliveryPayload = serde_json::from_value(row.payload)
        .map_err(|_| StoreError::Invalid("The event delivery history is invalid.".into()))?;
    let mut event = EventDelivery {
        id: row.id,
        schedule_id: row.schedule_id,
        received_at: row.received_at,
        expires_at: row.expires_at,
        state: row.state,
        payload,
        occurrence_id: row.occurrence_id.clone(),
        work_id: None,
        thread_id: None,
    };
    match event.state.as_str() {
        "pending" => event.payload.reason = "Waiting for an available agent/provider and ordinary Work capacity. The event must still be fresh when admitted.".into(),
        "expired" => {
            event.payload.reason = "The event or trigger expired before Work admission.".into()
        }
        "paused" => {
            event.payload.reason =
                "The trigger was paused. This event will not replay on resume.".into()
        }
        "removed" => event.payload.reason = "The trigger was removed before Work admission.".into(),
        _ => {}
    }
    if let Some(id) = row.occurrence_id {
        if let Some(occurrence) = repo::get_occurrence(conn, store, scope, &id)? {
            event.state = occurrence.state.clone();
            event.work_id = occurrence.payload["workId"].as_str().map(str::to_string);
            event.thread_id = repo::occurrence_thread_id(
                conn,
                scope,
                occurrence.execution_attempt_id.as_deref(),
            )?;
            if let Some(detail) = occurrence.payload["detail"].as_str() {
                event.payload.reason = crate::secret_redaction::redact_secret_text_or_omit(detail);
            }
            if let Some(work_id) = &event.work_id {
                if let Some(work) =
                    crate::store::repos::collaboration::get::<crate::collaboration::models::Work>(
                        conn,
                        store,
                        scope,
                        crate::store::repos::collaboration::Kind::Work,
                        work_id,
                    )?
                {
                    event.thread_id.get_or_insert(work.conversation_id.clone());
                    event.state = serde_json::to_value(work.status)
                        .map_err(|_| StoreError::Invalid("The Work outcome is invalid.".into()))?
                        .as_str()
                        .unwrap_or("unknown")
                        .into();
                }
            }
        }
    }
    Ok(event)
}
