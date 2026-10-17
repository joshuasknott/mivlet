//! Outcome goals share Work's existing attempt, budget and approval authority.
use super::*;

pub(super) fn set(
    ctx: &Context<'_>,
    key: &str,
    generation: u32,
    objective: &str,
    criteria: &str,
    max_turns: u32,
    max_tokens: u64,
) -> Result<()> {
    let mut item = ctx.item(key)?;
    if item.parent_id.is_some()
        || item.generation != generation
        || item.status != WorkStatus::Queued
        || !item.run_ids.is_empty()
        || item.schedule.is_some()
        || item.external_client.is_some()
        || ctx
            .all_work()?
            .iter()
            .any(|w| w.root_id == item.id && !w.run_ids.is_empty())
        || !(1..=24).contains(&max_turns)
        || !(1_000..=512_000).contains(&max_tokens)
    {
        return Err(invalid(
            "Set a goal on an unstarted request with 1–24 turns and 1,000–512,000 tokens.",
        ));
    }
    item.outcome_goal = Some(OutcomeGoal {
        objective: bounded(objective, 2000, "Goal")?,
        success_criteria: bounded(criteria, 4000, "Success criteria")?,
        status: "active".into(),
        report: None,
    });
    item.max_turns = max_turns;
    item.max_tokens = max_tokens;
    // Goal status uses native coordination tools. It cannot be silently moved
    // into the tool-free background text lane.
    item.execution_owner = None;
    item.hosted_task = None;
    item.generation += 1;
    item.updated_at = ctx.time.into();
    ctx.work(&item)
}

pub(super) fn pause(ctx: &Context<'_>, key: &str, generation: u32, paused: bool) -> Result<()> {
    let mut item = ctx.item(key)?;
    if item.parent_id.is_some() || item.generation != generation || !item.status.active() {
        return Err(invalid("Refresh this active goal before changing it. Interrupted work needs explicit Continue."));
    }
    let goal = item
        .outcome_goal
        .as_mut()
        .ok_or_else(|| invalid("This request has no outcome goal."))?;
    if !matches!(goal.status.as_str(), "active" | "paused") {
        return Err(invalid("This goal has ended. Review its saved evidence."));
    }
    // A running turn finishes normally. Pausing never revokes a completed
    // result or replays effects; dispatch is blocked at the next boundary.
    goal.status = if paused { "paused" } else { "active" }.into();
    if item.status == WorkStatus::Queued {
        item.generation += 1;
    }
    item.updated_at = ctx.time.into();
    ctx.work(&item)
}

pub(super) fn report(
    ctx: &Context<'_>,
    item: &mut Work,
    run: &str,
    status: &str,
    text: &str,
) -> Result<()> {
    if item.parent_id.is_some() || !matches!(status, "completed" | "continue" | "blocked") {
        return Err(invalid(
            "Only the goal's owning agent can report completed, continue or blocked.",
        ));
    }
    let goal = item
        .outcome_goal
        .as_mut()
        .ok_or_else(|| invalid("This request has no outcome goal."))?;
    if !matches!(goal.status.as_str(), "active" | "paused") {
        return Err(invalid("This goal is no longer active."));
    }
    goal.report = Some(GoalReport {
        status: status.into(),
        text: bounded(text, 4000, "Goal evidence")?,
        run_id: run.into(),
        created_at: ctx.time.into(),
    });
    item.updated_at = ctx.time.into();
    ctx.work(item)
}

/// Called only after finish verified and saved the completed assistant result.
/// A report from a previous run cannot complete the current goal.
pub(super) fn finished(item: &mut Work, run: &str) {
    let Some(goal) = item.outcome_goal.as_mut() else {
        return;
    };
    if item.status != WorkStatus::Completed {
        return;
    }
    let report = goal.report.as_ref().filter(|report| report.run_id == run);
    match report.map(|report| report.status.as_str()) {
        Some("completed") => goal.status = "completed".into(),
        Some("blocked") => {
            goal.status = "blocked".into();
            item.status = WorkStatus::AwaitingUser;
            item.awaiting_user = true;
            item.reason = Some(
                "The agent reported a goal blocker. Review its evidence before continuing.".into(),
            );
        }
        Some("continue") => {
            item.status = WorkStatus::Queued;
            item.reason = Some(
                if goal.status == "paused" {
                    "Goal paused at the completed turn boundary."
                } else {
                    "A fresh bounded turn will continue toward the goal using saved evidence."
                }
                .into(),
            );
        }
        _ => {
            goal.status = "blocked".into();
            item.status = WorkStatus::AwaitingUser;
            item.awaiting_user = false;
            item.reason = Some("No fresh goal progress report was saved for this turn. Review the result and remaining criteria before explicitly continuing.".into());
        }
    }
}

pub(super) fn enforce_budget(item: &mut Work) {
    let Some(goal) = item.outcome_goal.as_mut() else {
        return;
    };
    if matches!(goal.status.as_str(), "active" | "paused")
        && item.status == WorkStatus::Queued
        && (item.turn_count >= item.max_turns || item.token_usage >= item.max_tokens)
    {
        goal.status = "budget-exhausted".into();
        item.status = WorkStatus::AwaitingUser;
        item.awaiting_user = false;
        item.reason = Some("The goal reached its turn or token budget. Review saved results before explicitly continuing.".into());
    }
}
