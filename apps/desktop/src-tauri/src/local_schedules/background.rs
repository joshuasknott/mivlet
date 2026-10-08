//! Native scheduler access to the same occurrence ledger used by the desktop.
//! Claim tokens stay in this process and are never stored in Work or context.
use super::*;
use crate::collaboration::models::Work;

pub(crate) struct Claim {
    claim: LocalScheduleClaim,
    scope: PrivateDataScope,
    attempt: Option<String>,
    settled: bool,
}

pub(crate) fn next(app: &tauri::AppHandle) -> Result<Option<(Work, Claim)>, String> {
    let store = global_store()?;
    let workspace = crate::store::repos::scope::DEFAULT_WORKSPACE_ID;
    let scope = resolve_private_scope(store, workspace, ScopeAccess::Write)?;
    let profiles = crate::collaboration::native_profiles(app.clone(), workspace)?;
    let now = Utc::now();
    let schedules = store
        .with_conn(|conn| {
            repo::list_schedules(conn, store, &scope, LIST_LIMIT)?
                .into_iter()
                .map(schedule_from_row)
                .collect::<crate::store::Result<Vec<_>>>()
        })
        .map_err(|e| e.to_string())?;
    let now_text = timestamp(now);
    let Some(schedule) = schedules.into_iter().find(|schedule| {
        schedule.status == LocalScheduleStatus::Enabled
            && schedule.execution_kind == "agent"
            && schedule.permission_mode == "read-only"
            && schedule.project_id.is_none()
            && schedule
                .next_run_at
                .as_deref()
                .is_some_and(|next| next <= now_text.as_str())
            && crate::background_worker::dispatch::supports_provider(&schedule.provider_id)
            && profiles.iter().any(|profile| {
                profile.id == schedule.agent_id
                    && profile.connector_ids.is_empty()
                    && profile.knowledge_source_ids.is_empty()
            })
    }) else {
        return Ok(None);
    };
    // Check account-local capacity before advancing a schedule occurrence.
    let available = store
        .with_conn(|conn| {
            let authorized = authorized_scope::resolve(conn, None, None, ScopeAccess::Read)?;
            let works = crate::store::repos::collaboration::list::<Work>(
                conn,
                store,
                &authorized.private,
                crate::store::repos::collaboration::Kind::Work,
            )?;
            Ok(!works
                .iter()
                .any(|work| work.agent_id == schedule.agent_id && work.status.executing()))
        })
        .map_err(|e| e.to_string())?;
    if !available {
        return Ok(None);
    }
    let reservation = LocalScheduleCapacityReservation::new(
        random_token("background-capacity").map_err(|e| e.to_string())?,
    )?;
    let Some(claim) = claim_due_after_capacity_matching(
        store,
        &scope,
        reservation,
        now,
        Some((&schedule.id, schedule.revision)),
    )
    .map_err(|e| e.to_string())?
    else {
        return Ok(None);
    };
    let lease = Claim {
        claim,
        scope,
        attempt: None,
        settled: false,
    };
    let work = store
        .transaction(|conn| {
            let scope = authorized_scope::resolve(conn, None, None, ScopeAccess::Write)?;
            automation::stage_at(
                conn,
                store,
                &scope,
                &profiles,
                &lease.claim.occurrence_id,
                &lease.claim.claim_token,
                now,
            )?;
            let key = format!("work-schedule-{}", lease.claim.occurrence_id);
            let mut work = crate::store::repos::collaboration::get::<Work>(
                conn,
                store,
                &scope.private,
                crate::store::repos::collaboration::Kind::Work,
                &key,
            )?
            .ok_or_else(|| {
                StoreError::Invalid("The staged background Work is unavailable.".into())
            })?;
            work.execution_owner = Some("native-background".into());
            crate::store::repos::collaboration::put(
                conn,
                store,
                &scope.private,
                crate::store::repos::collaboration::Kind::Work,
                &work.id,
                Some(&work.conversation_id),
                work.project_id.as_deref(),
                &work,
            )?;
            Ok(work)
        })
        .map_err(|e| e.to_string())?;
    Ok(Some((work, lease)))
}

impl Claim {
    pub(crate) fn bind_at(
        &self,
        conn: &rusqlite::Connection,
        store: &Store,
        attempt: &str,
    ) -> crate::store::Result<()> {
        self.bind_at_time(conn, store, attempt, Utc::now())
    }
    fn bind_at_time(
        &self,
        conn: &rusqlite::Connection,
        store: &Store,
        attempt: &str,
        now: DateTime<Utc>,
    ) -> crate::store::Result<()> {
        repo::bind_pending_attempt(
            conn,
            store,
            &self.scope,
            &self.claim.occurrence_id,
            &fingerprint(&self.claim.claim_token),
            attempt,
            &timestamp(now),
            &timestamp(now + Duration::minutes(CLAIM_LEASE_MINUTES)),
        )?;
        Ok(())
    }
    pub(crate) fn bound(&mut self, attempt: &str) {
        self.attempt = Some(attempt.into());
    }
    pub(crate) fn renew(&self) -> Result<(), String> {
        let Some(attempt) = &self.attempt else {
            return Err("The scheduled background attempt is not bound.".into());
        };
        renew_bound_occurrence_lease(
            global_store()?,
            &self.scope,
            &self.claim.occurrence_id,
            &self.claim.claim_token,
            attempt,
            Utc::now(),
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
    }
    pub(crate) fn finish(&mut self, outcome: &str) -> Result<(), String> {
        let Some(attempt) = &self.attempt else {
            return Err("The scheduled background attempt is not bound.".into());
        };
        finish_bound_occurrence(
            global_store()?,
            &self.scope,
            &self.claim.occurrence_id,
            &self.claim.claim_token,
            attempt,
            outcome,
            None,
            Utc::now(),
        )
        .map_err(|e| e.to_string())?;
        self.settled = true;
        Ok(())
    }
}

impl Drop for Claim {
    fn drop(&mut self) {
        if self.settled {
            return;
        }
        let Ok(store) = global_store() else {
            return;
        };
        if let Some(attempt) = &self.attempt {
            let _ = finish_bound_occurrence(
                store,
                &self.scope,
                &self.claim.occurrence_id,
                &self.claim.claim_token,
                attempt,
                "interrupted",
                Some("The native owner stopped. No automatic replay."),
                Utc::now(),
            );
        } else {
            let _ = store.transaction(|conn| {
                repo::interrupt_claimed(
                    conn,
                    store,
                    &self.scope,
                    &self.claim.occurrence_id,
                    &fingerprint(&self.claim.claim_token),
                    "Background dispatch stopped before binding.",
                    &timestamp(Utc::now()),
                )
                .map(|_| ())
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{at, daily_request, store_and_scope};
    use super::*;

    #[test]
    fn native_claim_requires_the_frozen_attempt_and_cannot_be_replayed() {
        let (store, scope) = store_and_scope();
        let now = at("2026-09-07T12:00:00Z");
        let mut request = daily_request(LocalScheduleStatus::Enabled);
        request.execution_kind = "agent".into();
        store
            .transaction(|conn| {
                create_at(conn, &store, &scope, request, at("2026-09-07T07:00:00Z"))
            })
            .unwrap();
        let claim = claim_due_after_capacity_matching(
            &store,
            &scope.private,
            LocalScheduleCapacityReservation::new("native-capacity".into()).unwrap(),
            now,
            Some(("schedule-1", 1)),
        )
        .unwrap()
        .unwrap();
        let profiles = vec![serde_json::from_value(
            serde_json::json!({"id":"agent-research","name":"Researcher","instructions":"Fixture",
            "modelId":"openai::gpt-5","icon":"sparkle","permissionLabel":"Read Only"}),
        )
        .unwrap()];
        let staged = store
            .transaction(|conn| {
                automation::stage_at(
                    conn,
                    &store,
                    &scope,
                    &profiles,
                    &claim.occurrence_id,
                    &claim.claim_token,
                    now,
                )
            })
            .unwrap();
        let lease = Claim {
            claim,
            scope: scope.private.clone(),
            attempt: None,
            settled: true,
        };
        let queue = |prompt: &str| {
            store
                .transaction(|conn| {
                    crate::store::repos::execution_attempt::upsert_scoped(
                        conn,
                        &store,
                        &scope.data,
                        "native-attempt",
                        Some(&staged.thread_id),
                        "openai",
                        "gpt-5",
                        "queued",
                        1,
                        false,
                        0,
                        &timestamp(now),
                        &timestamp(now),
                        &serde_json::json!({"exchanges":[{"role":"user","content":prompt}]}),
                    )
                })
                .unwrap()
        };
        queue("Changed after claim");
        assert!(store
            .transaction(|conn| lease.bind_at_time(conn, &store, "native-attempt", now))
            .is_err());
        queue(&lease.claim.prompt);
        store
            .transaction(|conn| lease.bind_at_time(conn, &store, "native-attempt", now))
            .unwrap();
        // A second process cannot claim the same recurring slot; binding a
        // different attempt also fails after the exact occurrence is running.
        assert!(claim_due_after_capacity_matching(
            &store,
            &scope.private,
            LocalScheduleCapacityReservation::new("other-capacity".into()).unwrap(),
            now,
            Some(("schedule-1", 1))
        )
        .unwrap()
        .is_none());
        assert!(store
            .transaction(|conn| lease.bind_at_time(conn, &store, "different-attempt", now))
            .is_err());
        assert!(store
            .transaction(|conn| lease.bind_at_time(
                conn,
                &store,
                "native-attempt",
                now + Duration::minutes(10)
            ))
            .is_err());
    }
}
