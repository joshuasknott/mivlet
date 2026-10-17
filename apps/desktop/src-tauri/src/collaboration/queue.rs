//! Scheduling metadata on canonical Work. Queue edits cannot change authority.
use super::*;
use std::cmp::Ordering;

pub(super) fn compare(a: &Work, b: &Work) -> Ordering {
    a.queue
        .as_ref()
        .map_or(0, |q| q.order)
        .cmp(&b.queue.as_ref().map_or(0, |q| q.order))
        .then(a.created_at.cmp(&b.created_at))
        .then(a.id.cmp(&b.id))
}

fn unstarted(ctx: &Context<'_>, key: &str, generation: u32) -> Result<Work> {
    let item = ctx.item(key)?;
    if item.generation != generation
        || item.parent_id.is_some()
        || item.status != WorkStatus::Queued
        || item.origin.as_deref().is_some_and(|o| o != "chat")
        || item.schedule.is_some()
        || item.parent_message_id.is_some()
        || ctx.all_work()?.iter().any(|w| {
            w.root_id == item.id
                && (!w.run_ids.is_empty()
                    || w.current_run_id.is_some()
                    || w.status != WorkStatus::Queued)
        })
    {
        return Err(invalid(
            "Only an unstarted queued request can be edited. Refresh its current state.",
        ));
    }
    Ok(item)
}

pub(super) fn recoverable_unstarted(ctx: &Context<'_>, item: &Work) -> Result<bool> {
    let root = ctx.item(&item.root_id)?;
    // Legacy queues, scheduled/external requests and branch edits keep the
    // existing explicit reconciliation path. Only new, intact queue records
    // can survive restart without a provider attempt.
    Ok(root.queue.is_some() && unstarted(ctx, &root.id, root.generation).is_ok())
}

fn update_effort(ctx: &Context<'_>, root: &Work, mut update: impl FnMut(&mut Work)) -> Result<()> {
    for mut item in ctx.all_work()?.into_iter().filter(|w| w.root_id == root.id) {
        update(&mut item);
        item.generation = item.generation.saturating_add(1);
        item.updated_at = ctx.time.into();
        ctx.work(&item)?;
    }
    Ok(())
}

pub(super) fn edit(ctx: &Context<'_>, key: &str, generation: u32, prompt: &str) -> Result<()> {
    let root = unstarted(ctx, key, generation)?;
    let prompt = bounded(prompt, 32_000, "Queued message")?;
    update_effort(ctx, &root, |item| {
        let suffix = item.prompt.strip_prefix(&item.user_request).unwrap_or("");
        item.prompt = format!("{prompt}{suffix}");
        item.user_request = prompt.clone();
        item.reason = Some("Queued message edited before dispatch.".into());
    })
}

pub(super) fn hold(ctx: &Context<'_>, key: &str, generation: u32, held: bool) -> Result<()> {
    let root = unstarted(ctx, key, generation)?;
    update_effort(ctx, &root, |item| {
        let queue = item.queue.get_or_insert(WorkQueue {
            held: false,
            order: 0,
        });
        queue.held = held;
    })
}

pub(super) fn move_before(
    ctx: &Context<'_>,
    key: &str,
    generation: u32,
    before: Option<&str>,
) -> Result<()> {
    let root = unstarted(ctx, key, generation)?;
    let mut roots: Vec<_> = ctx
        .all_work()?
        .into_iter()
        .filter(|w| unstarted(ctx, &w.id, w.generation).is_ok())
        .collect();
    roots.sort_by(compare);
    let target = before
        .map(|id| unstarted(ctx, id, ctx.item(id)?.generation))
        .transpose()?;
    if target.as_ref().is_some_and(|target| {
        target.conversation_id != root.conversation_id || target.id == root.id
    }) {
        return Err(invalid(
            "Move this request relative to another queued request in the same conversation.",
        ));
    }
    roots.retain(|w| w.id != root.id);
    let position = if let Some(target) = target {
        roots
            .iter()
            .position(|w| w.id == target.id)
            .ok_or_else(|| invalid("The queue changed. Refresh before moving this request."))?
    } else {
        roots
            .iter()
            .rposition(|w| w.conversation_id == root.conversation_id)
            .map_or(roots.len(), |i| i + 1)
    };
    roots.insert(position, root);
    // Renumber in the same native transaction. Every changed generation fences
    // an already-preparing renderer session before it can bind its old order.
    for (index, root) in roots.into_iter().enumerate() {
        let order = index as u32 + 1;
        update_effort(ctx, &root, |item| {
            let queue = item.queue.get_or_insert(WorkQueue { held: false, order });
            queue.order = order;
        })?;
    }
    Ok(())
}

pub(super) fn dispatchable(item: &Work, all: &[Work]) -> bool {
    let root = all.iter().find(|w| w.id == item.root_id).unwrap_or(item);
    if root.execution_owner.as_deref() == Some("hosted")
        || root.queue.as_ref().is_some_and(|q| q.held)
        || root
            .outcome_goal
            .as_ref()
            .is_some_and(|g| g.status != "active")
    {
        return false;
    }
    !all.iter().any(|other| {
        if other.id == item.id
            || other.root_id == item.root_id
            || other.agent_id != item.agent_id
            || other.status != WorkStatus::Queued
        {
            return false;
        }
        let earlier = all.iter().find(|w| w.id == other.root_id).unwrap_or(other);
        !earlier.queue.as_ref().is_some_and(|q| q.held)
            && earlier
                .outcome_goal
                .as_ref()
                .is_none_or(|g| g.status == "active")
            && compare(earlier, root).is_lt()
    })
}

pub(super) fn ensure_dispatchable(ctx: &Context<'_>, item: &Work) -> Result<()> {
    if !dispatchable(item, &ctx.all_work()?) {
        return Err(invalid(
            "This request is paused or another queued request for this agent comes first.",
        ));
    }
    Ok(())
}
