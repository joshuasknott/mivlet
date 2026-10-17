//! Browser handover narrows a unique current assignment's authority before the
//! computer generation is revoked. No model-supplied Work identity is accepted.
use super::*;

pub(super) fn pause(ctx: &Context<'_>, agent: &str, reason: &str) -> Result<()> {
    id(agent)?;
    let reason = bounded(reason, 2000, "Browser handover reason")?;
    let all = ctx.all_work()?;
    let mut executing = all
        .iter()
        .filter(|item| item.agent_id == agent && item.status.executing());
    let item = executing
        .next()
        .ok_or_else(|| invalid("No current assignment owns this browser handover."))?;
    if executing.next().is_some() {
        return Err(invalid("More than one assignment could own this browser handover. Stop or finish the other assignment first."));
    }
    let run = item
        .current_run_id
        .as_deref()
        .ok_or_else(|| invalid("The browser assignment has no live run binding."))?;
    let author: Author = repo::get(ctx.conn, ctx.store, &ctx.scope.private, Kind::Author, run)?
        .ok_or_else(|| invalid("The browser assignment's live author binding is unavailable."))?;
    if author.work_id.as_deref() != Some(&item.id)
        || author.generation != item.generation
        || author.agent_id != item.agent_id
        || author.conversation_id != item.conversation_id
    {
        return Err(invalid(
            "The browser assignment changed. Refresh before handing it over.",
        ));
    }
    ensure_run_current(ctx.conn, ctx.store, Some(run))?;
    let mut affected = HashSet::from([item.id.clone()]);
    loop {
        let count = affected.len();
        for candidate in &all {
            if candidate
                .parent_id
                .as_ref()
                .is_some_and(|parent| affected.contains(parent))
            {
                affected.insert(candidate.id.clone());
            }
        }
        if count == affected.len() {
            break;
        }
    }
    work::invalidate_descendants(ctx, &item.id, &reason, WorkStatus::AwaitingUser)?;
    for key in affected {
        let mut current = ctx.item(&key)?;
        if current.status == WorkStatus::AwaitingUser {
            current.current_run_id = None;
            current.awaiting_user = false;
            if let Some(goal) = current.outcome_goal.as_mut() {
                goal.status = "paused".into();
            }
            ctx.work(&current)?;
        }
    }
    Ok(())
}
