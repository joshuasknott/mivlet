//! Bounded task-scoped agent exchanges and durable shared-resource claims.
use super::*;

/// Append an explicit user follow-up without replaying an uncertain provider
/// attempt. Deliberate agent questions may resume; recovery and prerequisite
/// blockers still require the existing Continue/Reconcile path.
pub(super) fn reply_user(
    ctx: &Context<'_>,
    key: &str,
    expected_generation: u32,
    event_id: &str,
    text: &str,
) -> Result<()> {
    id(key)?;
    id(event_id)?;
    let text = bounded(text, 32_000, "Follow-up")?;
    let mut item = ctx.item(key)?;
    if let Some(existing) = item.steering.iter().find(|event| event.id == event_id) {
        return if existing.text == text {
            Ok(())
        } else {
            Err(invalid("This follow-up event ID was already used."))
        };
    }
    if item.generation != expected_generation {
        return Err(invalid("This assignment changed. Reload before replying."));
    }
    if item.status == WorkStatus::Cancelled || item.status == WorkStatus::Failed {
        return Err(invalid("This assignment has already ended."));
    }
    if item.status == WorkStatus::Completed && item.parent_id.is_some() && !item.workspace_recipient
    {
        let parent_active = item
            .parent_id
            .as_deref()
            .and_then(|parent_id| ctx.item(parent_id).ok())
            .is_some_and(|parent| parent.status.active());
        if !parent_active {
            return Err(invalid(
                "This delegated assignment's effort has ended. Start a fresh request instead of replaying it.",
            ));
        }
    }
    if item.status == WorkStatus::AwaitingUser && !item.awaiting_user {
        return Err(invalid(
            "Review the saved result and reconcile the prerequisite before continuing.",
        ));
    }
    item.steering.push(WorkSteering {
        id: event_id.into(),
        text,
        created_at: ctx.time.into(),
    });
    if item.status == WorkStatus::AwaitingUser {
        item.generation += 1;
        item.awaiting_user = false;
        item.current_run_id = None;
        item.status = WorkStatus::Queued;
        item.reason = Some("A user follow-up is queued for a fresh turn.".into());
    } else if item.status == WorkStatus::Completed {
        item.generation += 1;
        item.current_run_id = None;
        item.status = WorkStatus::Queued;
        item.reason = Some("A user follow-up starts a fresh turn from the saved result.".into());
    } else if item.status == WorkStatus::Waiting {
        // User guidance may unblock a lead's next turn while workers are
        // still running. Keep the dependency edges so the lead returns to
        // waiting after this bounded turn instead of cancelling its workers.
        item.generation += 1;
        item.current_run_id = None;
        item.status = WorkStatus::Queued;
        item.reason = Some("A user follow-up is queued after delegated results.".into());
    }
    item.updated_at = ctx.time.into();
    ctx.work(&item)
}

pub(super) fn message(
    ctx: &Context<'_>,
    item: &mut Work,
    receipt: &str,
    assignment_id: &str,
    text: &str,
    question: bool,
) -> Result<()> {
    id(assignment_id)?;
    let text = bounded(text, 6_000, "Task message")?;
    let mut target = ctx.item(assignment_id)?;
    if target.id == item.id {
        return Err(invalid("An assignment cannot message itself."));
    }
    if target.root_id != item.root_id {
        return Err(invalid(
            "Task messages must stay within the originating effort.",
        ));
    }
    let related = target.parent_id.as_deref() == Some(item.id.as_str())
        || item.parent_id.as_deref() == Some(target.id.as_str())
        || (target.parent_id.is_some() && target.parent_id == item.parent_id)
        || (target.parent_id.is_none() && item.workspace_recipient);
    if !related {
        return Err(invalid(
            "This agent can only message its task-scoped lead or worker.",
        ));
    }
    if target.status == WorkStatus::Cancelled || target.status == WorkStatus::Failed {
        return Err(invalid("This assignment has already ended."));
    }
    if target.status == WorkStatus::AwaitingUser {
        return Err(invalid(
            "This assignment is waiting for the user; another agent cannot bypass that decision.",
        ));
    }
    if target.messages.len() >= 24 {
        return Err(invalid("This assignment reached its task-message limit."));
    }
    let target_was_executing = target.status.executing();
    target.messages.push(TaskMessage {
        id: receipt.into(),
        from_work_id: item.id.clone(),
        from_agent_id: item.agent_id.clone(),
        to_work_id: target.id.clone(),
        text,
        created_at: ctx.time.into(),
        question,
    });
    // Running providers finish their current turn and are then queued by
    // finish(); changing generation here would reject that result.
    if !target_was_executing {
        target.generation += 1;
        target.current_run_id = None;
        target.status = WorkStatus::Queued;
        target.reason = Some("A task-scoped follow-up is queued for the next turn.".into());
    }
    if question && !item.waiting_for.iter().any(|id| id == &target.id) {
        // A parent and descendant already wait through their existing
        // dependency edge; adding the reverse edge would deadlock. Traverse
        // the full closure so peer A -> B -> C -> A is rejected as well.
        let mut pending = target.waiting_for.clone();
        let mut visited = HashSet::new();
        let mut cycle = item.parent_id.as_deref() == Some(target.id.as_str());
        while !cycle {
            let Some(waiting_id) = pending.pop() else {
                break;
            };
            if waiting_id == item.id {
                cycle = true;
                break;
            }
            if visited.insert(waiting_id.clone()) {
                if let Ok(waiting) = ctx.item(&waiting_id) {
                    pending.extend(waiting.waiting_for);
                }
            }
        }
        if !cycle {
            item.waiting_for.push(target.id.clone());
            ctx.work(item)?;
        }
    }
    target.updated_at = ctx.time.into();
    ctx.work(&target)
}

pub(super) fn claim_resource(ctx: &Context<'_>, item: &mut Work, resource: &str) -> Result<()> {
    let resource = bounded(resource, 512, "Resource claim")?
        .replace('\\', "/")
        .to_ascii_lowercase();
    let already_claimed = item.resource_claims.iter().any(|claim| claim == &resource);
    if !already_claimed && item.resource_claims.len() >= 16 {
        return Err(invalid("This assignment reached its resource claim limit."));
    }
    let all = ctx.all_work()?;
    if all.iter().any(|other| {
        let effort_is_live = all.iter().any(|candidate| {
            candidate.root_id == other.root_id
                && !matches!(
                    candidate.status,
                    WorkStatus::Completed | WorkStatus::Cancelled
                )
        });
        let explicit_transfer = other.root_id == item.root_id
            && other.status == WorkStatus::Completed
            && (item.prerequisites.iter().any(|id| id == &other.id)
                || item.dependencies.iter().any(|id| id == &other.id));
        other.id != item.id
            && other.status != WorkStatus::Cancelled
            && effort_is_live
            && other.resource_claims.iter().any(|claim| claim == &resource)
            && !explicit_transfer
    }) {
        return Err(invalid(
            "This shared resource is already claimed by another active effort. Coordinate before writing.",
        ));
    }
    // Completion releases reservations. A user can resume this assignment
    // later, so an old claim must be checked against current owners again.
    if !already_claimed {
        item.resource_claims.push(resource);
    }
    item.updated_at = ctx.time.into();
    ctx.work(item)
}
