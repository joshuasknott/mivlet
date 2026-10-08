//! Retention runs only inside the authenticated app process. It grants no Work
//! capacity and never replays or claims an event.
use super::super::*;

pub(super) fn start() {
    let Ok(fence) = crate::account_session::AccountDispatchFence::capture() else {
        return;
    };
    let fence = std::sync::Arc::new(fence);
    tauri::async_runtime::spawn(async move {
        loop {
            let fence = fence.clone();
            let active = tauri::async_runtime::spawn_blocking(move || {
                (|| {
                    let store = global_store()?;
                    let scope = authorized_scope::active_command_scope(ScopeAccess::Write)?;
                    store
                        .transaction_with_account_fence(&fence, |conn| {
                            sweep(conn, store, &scope.private, Utc::now())
                        })
                        .map_err(|_| "Event retention could not be updated.".to_string())
                })()
            })
            .await;
            if crate::account_session::ensure_current().is_err() {
                break;
            }
            // A storage failure preserves evidence and makes no new admission.
            let _ = active;
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        }
    });
}

pub(super) fn sweep(
    conn: &rusqlite::Connection,
    store: &Store,
    scope: &PrivateDataScope,
    now: DateTime<Utc>,
) -> crate::store::Result<()> {
    let time = timestamp(now);
    for mut schedule in repo::list_schedules(conn, store, scope, 1_000)? {
        if schedule.trigger_kind != "event" {
            continue;
        }
        let expires = schedule.payload["trigger"]["validUntil"]
            .as_str()
            .and_then(|value| DateTime::parse_from_rfc3339(value).ok());
        if expires.is_none_or(|expires| expires <= now) {
            crate::store::repos::local_event::retire_pending(conn, scope, &schedule.id, "expired")?;
        }
        crate::store::repos::local_event::prune(
            conn,
            store,
            scope,
            &schedule.id,
            &time,
            &timestamp(now - Duration::hours(24)),
        )?;
        let next =
            crate::store::repos::local_event::first_pending(conn, store, scope, &schedule.id)?
                .map(|row| row.received_at);
        if schedule.next_run_at != next {
            schedule.next_run_at = next;
            repo::replace_schedule(conn, store, scope, schedule.revision, &schedule)?;
        }
    }
    Ok(())
}
