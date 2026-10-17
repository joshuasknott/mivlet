//! Explicit Codex live input. Admission and receipt use canonical Work; a lost
//! receipt is uncertainty, never permission to send the same guidance twice.
use super::*;

pub(super) fn admit(
    ctx: &Context<'_>,
    key: &str,
    generation: u32,
    event: &str,
    text: &str,
) -> Result<Option<String>> {
    id(event)?;
    let text = bounded(text, 2000, "Live guidance")?;
    let mut item = work::current(ctx, key, generation, None)?;
    if let Some(old) = item.live_steering.iter().find(|old| old.id == event) {
        return if old.text == text {
            Ok(None)
        } else {
            Err(invalid(
                "This live guidance ID already belongs to different text.",
            ))
        };
    }
    if item.status != WorkStatus::Running
        || item.execution_owner.is_some()
        || !item.model_option_id.starts_with("codex::")
        || item.live_steering.len() >= 16
    {
        return Err(invalid("Live steering is available only for an active foreground Codex turn. Use a next-turn follow-up for this route."));
    }
    let run = item
        .current_run_id
        .clone()
        .ok_or_else(|| invalid("Wait for the active provider turn before steering."))?;
    let author: Author = repo::get(ctx.conn, ctx.store, &ctx.scope.private, Kind::Author, &run)?
        .ok_or_else(|| invalid("The active guidance request has no canonical run binding."))?;
    if author.work_id.as_deref() != Some(&item.id)
        || author.generation != generation
        || author.agent_id != item.agent_id
        || author.conversation_id != item.conversation_id
    {
        return Err(invalid(
            "The active guidance request no longer belongs to this assignment.",
        ));
    }
    ensure_run_current(ctx.conn, ctx.store, Some(&run))?;
    if item
        .live_steering
        .iter()
        .any(|old| old.run_id == run && matches!(old.delivery.as_str(), "pending" | "uncertain"))
    {
        return Err(invalid("Inspect the existing live guidance receipt before sending another update. Unconfirmed input is never resent."));
    }
    item.live_steering.push(LiveWorkSteering {
        id: event.into(),
        text,
        run_id: run.clone(),
        delivery: "pending".into(),
        created_at: ctx.time.into(),
    });
    item.updated_at = ctx.time.into();
    ctx.work(&item)?;
    Ok(Some(run))
}

pub(super) fn live(
    app: &tauri::AppHandle,
    workspace: &str,
    key: &str,
    generation: u32,
    event: &str,
    text: &str,
) -> std::result::Result<Snapshot, String> {
    let store = crate::store::try_global().ok_or("Account storage is unavailable.")?;
    let profiles = native_profiles(app.clone(), workspace)?;
    let with_context = |operation: &mut dyn FnMut(&Context<'_>) -> Result<Option<String>>| {
        store
            .transaction(|conn| {
                let scope =
                    authorized_scope::resolve(conn, Some(workspace), None, ScopeAccess::Write)?;
                let time = now();
                operation(&Context {
                    conn,
                    store,
                    scope: &scope,
                    profiles: &profiles,
                    time: &time,
                })
            })
            .map_err(|e| e.to_string())
    };
    let run = with_context(&mut |ctx| admit(ctx, key, generation, event, text))?;
    if let Some(run) = run {
        // No SQLite transaction or identity lock is held during provider I/O.
        // Late receipts can never change a stopped/newer Work generation.
        let delivery = crate::codex_app_server::steer_active_turn(&run, event, text);
        with_context(&mut |ctx| {
            let mut item = ctx.item(key)?;
            if item.generation != generation {
                return Ok(None);
            }
            let saved = item
                .live_steering
                .iter_mut()
                .find(|saved| saved.id == event)
                .ok_or_else(|| invalid("The live guidance receipt is unavailable."))?;
            saved.delivery = delivery.as_str().into();
            if delivery == crate::codex_app_server::SteeringDelivery::Uncertain
                && item.status.active()
            {
                item.status = WorkStatus::AwaitingUser;
                item.awaiting_user = false;
                item.generation += 1;
                item.current_run_id = None;
                item.reason = Some("Live guidance delivery is uncertain. Stop and inspect the saved result before continuing; it was not sent again.".into());
                if let Some(goal) = item.outcome_goal.as_mut() {
                    goal.status = "paused".into();
                }
            }
            item.updated_at = ctx.time.into();
            ctx.work(&item)?;
            Ok(None)
        })?;
    }
    store
        .transaction(|conn| {
            let scope = authorized_scope::resolve(conn, Some(workspace), None, ScopeAccess::Write)?;
            let time = now();
            Context {
                conn,
                store,
                scope: &scope,
                profiles: &profiles,
                time: &time,
            }
            .snapshot()
        })
        .map_err(|e| e.to_string())
}
