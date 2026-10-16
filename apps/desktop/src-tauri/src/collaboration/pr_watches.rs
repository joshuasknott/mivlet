//! PR monitor admission into the existing Work lane. Never dispatches a provider.
use super::*;
pub(crate) fn check_or_deliver(
    workspace: &str,
    agent: &str,
    work_id: &str,
    expected_generation: u32,
    event: Option<(&str, &str)>,
    ticket: &crate::local_computer::authority::OperationTicket,
) -> std::result::Result<u32, String> {
    let store = crate::store::try_global().ok_or("Encrypted Work store is unavailable.")?;
    store
        .transaction(|conn| {
            let scope = authorized_scope::resolve(conn, Some(workspace), None, ScopeAccess::Write)?;
            let time = now();
            let ctx = Context {
                conn,
                store,
                scope: &scope,
                profiles: &[],
                time: &time,
            };
            ticket
                .with_current(|| {
                    deliver(&ctx, agent, work_id, expected_generation, event)
                        .map_err(|error| error.to_string())
                })
                .map_err(StoreError::Invalid)
        })
        .map_err(|error| error.to_string())
}
pub(super) fn deliver(
    ctx: &Context<'_>,
    agent: &str,
    work_id: &str,
    generation: u32,
    event: Option<(&str, &str)>,
) -> Result<u32> {
    let mut item = ctx.item(work_id)?;
    if item.agent_id != agent
        || item.parent_id.is_some()
        || item.schedule.is_some()
        || matches!(
            item.status,
            WorkStatus::Cancelled
                | WorkStatus::Failed
                | WorkStatus::AwaitingUser
                | WorkStatus::Blocked
        )
    {
        return Err(invalid(
            "PR watch stopped: Work ended, awaits a user decision, or belongs to another agent.",
        ));
    }
    let room = ctx.room(&item.conversation_id)?;
    if room.generation != item.conversation_generation
        || room.archived
        || (!item.workspace_recipient
            && !room
                .participants
                .iter()
                .any(|p| p.agent_id == item.agent_id))
        || item.turn_count >= item.max_turns
        || item.token_usage >= item.max_tokens
    {
        return Err(invalid(
            "PR watch stopped: conversation changed or Work reached its existing limit.",
        ));
    }
    if let Some(project) = &item.project_id {
        let team = ctx.project_team(project)?;
        if team.revision != item.context_revision
            || (!item.workspace_recipient && !team.participant_ids.contains(&item.agent_id))
        {
            return Err(invalid("PR watch stopped: project context changed."));
        }
    }
    if let Some((event_id, _)) = event {
        if item.messages.iter().any(|m| m.id == event_id)
            && (item.generation == generation || item.generation == generation.saturating_add(1))
        {
            return Ok(item.generation);
        }
    }
    if item.generation != generation {
        return Err(invalid("PR watch stopped: Work generation changed."));
    }
    let Some((event_id, text)) = event else {
        return Ok(item.generation);
    };
    if item.messages.len() >= 24 {
        return Err(invalid("PR watch stopped: Work message limit reached."));
    }
    id(event_id)?;
    item.messages.push(TaskMessage {
        id: event_id.into(),
        from_work_id: item.id.clone(),
        from_agent_id: agent.into(),
        to_work_id: item.id.clone(),
        text: bounded(text, 6000, "PR update")?,
        question: false,
        created_at: ctx.time.into(),
    });
    if !item.status.executing() {
        item.generation += 1;
        item.current_run_id = None;
        item.status = WorkStatus::Queued;
        item.reason = Some("A watched PR changed. A fresh turn can inspect it; remote actions still need exact approval.".into());
    }
    item.updated_at = ctx.time.into();
    ctx.work(&item)?;
    Ok(item.generation)
}
