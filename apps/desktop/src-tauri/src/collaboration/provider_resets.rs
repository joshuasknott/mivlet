//! One user-authorized reset continuation through canonical Work admission.
use super::*;
use crate::provider_usage;
use crate::store::repos::execution_attempt;

fn unchanged(ctx: &Context<'_>, item: &Work) -> Result<()> {
    let room = commands::continuation_context(ctx, item)?;
    if room.generation != item.conversation_generation
        || profile(ctx.profiles, &item.agent_id)?.model_id != item.model_option_id
        || item.captured_context.is_none()
        || item
            .project_id
            .as_deref()
            .map(|p| {
                ctx.project_team(p)
                    .map(|t| t.revision != item.context_revision)
            })
            .transpose()?
            .unwrap_or(false)
    {
        return Err(invalid("The conversation, model or project changed. Review Work before requesting continuation."));
    }
    if ctx
        .all_work()?
        .iter()
        .any(|w| w.root_id == item.root_id && w.status.active())
    {
        return Err(invalid(
            "Wait for the remaining effort to stop before scheduling a continuation.",
        ));
    }
    Ok(())
}
pub(super) fn arm(
    ctx: &Context<'_>,
    key: &str,
    generation: u32,
    opportunity_id: &str,
    reconcile: bool,
) -> Result<()> {
    let mut item = ctx.item(key)?;
    if !reconcile
        || item.generation != generation
        || !matches!(item.status, WorkStatus::Failed | WorkStatus::AwaitingUser)
        || item
            .reset_continuation
            .as_ref()
            .is_some_and(|r| r.opportunity_id == opportunity_id)
    {
        return Err(invalid(
            "Review the latest saved effects and choose a new provider reset opportunity.",
        ));
    }
    unchanged(ctx, &item)?;
    let provider = item
        .model_option_id
        .split("::")
        .next()
        .ok_or_else(|| invalid("The provider route is unavailable."))?;
    let run = item
        .run_ids
        .last()
        .ok_or_else(|| invalid("Reset continuation needs a failed provider run."))?;
    let row = execution_attempt::get_scoped(ctx.conn, ctx.store, &ctx.scope.data, run)?
        .ok_or_else(|| invalid("The failed run is unavailable."))?;
    if row.status != "failed"
        || row.provider_id != provider
        || !provider_usage::has_limit_failure(ctx.conn, ctx.store, ctx.scope, provider, run)?
    {
        return Err(invalid("This run has no native provider-reported usage limit. Use ordinary reviewed continuation."));
    }
    let report = provider_usage::cached(ctx.conn, ctx.store, ctx.scope, provider, ctx.time)?;
    let reset = report
        .reset_opportunity
        .as_ref()
        .filter(|r| r.id == opportunity_id && r.resets_at.as_str() > ctx.time)
        .ok_or_else(|| invalid("Refresh provider allowance and choose a current future reset."))?;
    if !provider_usage::fresh(&report, ctx.time) {
        return Err(invalid("Fresh provider measurements are required."));
    }
    item.reset_continuation = Some(ResetContinuation {
        opportunity_id: reset.id.clone(),
        resets_at: reset.resets_at.clone(),
        provider_id: provider.into(),
        identity: report.identity.clone(),
        generation,
        run_id: run.clone(),
        state: "armed".into(),
        reason: None,
    });
    item.updated_at = ctx.time.into();
    ctx.work(&item)
}
pub(super) fn cancel(ctx: &Context<'_>, key: &str, generation: u32) -> Result<()> {
    let mut item = ctx.item(key)?;
    if item.generation != generation {
        return Err(invalid(
            "This Work changed. Refresh before cancelling its continuation.",
        ));
    }
    if let Some(reset) = &mut item.reset_continuation {
        reset.state = "review-required".into();
        reset.reason = Some("Reset continuation cancelled by the user.".into());
        item.updated_at = ctx.time.into();
        ctx.work(&item)?;
    }
    Ok(())
}
pub(super) fn dispatch(ctx: &Context<'_>) -> Result<()> {
    for mut item in ctx.all_work()? {
        let Some(mut reset) = item
            .reset_continuation
            .clone()
            .filter(|r| r.state == "armed" && r.resets_at.as_str() <= ctx.time)
        else {
            continue;
        };
        let report =
            provider_usage::cached(ctx.conn, ctx.store, ctx.scope, &reset.provider_id, ctx.time)?;
        let valid = item.generation == reset.generation
            && item.run_ids.last() == Some(&reset.run_id)
            && matches!(item.status, WorkStatus::Failed | WorkStatus::AwaitingUser)
            && unchanged(ctx, &item).is_ok()
            && provider_usage::fresh(&report, ctx.time)
            && report.identity == reset.identity
            && report
                .observed_at
                .as_deref()
                .is_some_and(|at| at >= reset.resets_at.as_str())
            && !report.windows.is_empty()
            && report.windows.iter().all(|w| w.used_percent < 100.0);
        // Consume before admission in the same transaction. A failed or unknown
        // reset requires a new explicit choice; it never loops on provider turns.
        reset.state = if valid { "consumed" } else { "review-required" }.into();
        reset.reason=Some(if valid { "Reset verified; one fresh continuation admitted." } else { "The reset could not be validated, or Work changed. Inspect saved results and refresh allowance before continuing." }.into());
        item.reset_continuation = Some(reset);
        item.updated_at = ctx.time.into();
        ctx.work(&item)?;
        if valid {
            commands::apply(
                ctx,
                Command::ContinueWork {
                    id: item.id.clone(),
                    expected_generation: item.generation,
                    reconcile: true,
                },
            )?;
        }
    }
    Ok(())
}

pub(super) fn require_restart_review(item: &mut Work) -> bool {
    require_review(
        item,
        "Mivlet restarted. Review saved outcomes before choosing a new continuation.",
    )
}
pub(super) fn require_review(item: &mut Work, reason: &str) -> bool {
    if let Some(reset) = item
        .reset_continuation
        .as_mut()
        .filter(|r| r.state == "armed")
    {
        reset.state = "review-required".into();
        reset.reason = Some(reason.into());
        return true;
    }
    false
}
