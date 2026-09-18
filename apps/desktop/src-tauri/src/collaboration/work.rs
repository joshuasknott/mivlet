use super::*;
use crate::store::repos::{execution_attempt, message};
use sha2::{Digest, Sha256};

fn permission_mode(agent: &MivletAgentProfile) -> &'static str {
    match agent.permission_label.as_str() {
        "Work Freely" => "full-access",
        "Ask Me" => "trusted-scope",
        _ => "read-only",
    }
}

fn permission_rank(mode: &str) -> u8 {
    match mode {
        "full-access" => 2,
        "trusted-scope" => 1,
        _ => 0,
    }
}

fn attachments_for_child(attachments: &[WorkAttachment]) -> Vec<WorkAttachment> {
    attachments
        .iter()
        .cloned()
        .map(|mut attachment| {
            // A staged workspace path belongs to the originating agent's
            // namespace. Keep identity/size for a live handoff, while making
            // re-staging in the recipient namespace an explicit prerequisite
            // after restart rather than claiming the path is shared.
            if attachment.availability == "workspace-file" {
                attachment.availability = "transient".into();
                attachment.relative_path = None;
                attachment.sha256 = None;
            }
            attachment
        })
        .collect()
}

pub(super) fn start(
    ctx: &Context<'_>,
    key: String,
    room_id: String,
    agent_id: String,
    prompt: String,
    discussion: bool,
    origin: Option<&str>,
    attachments: Option<&[WorkAttachment]>,
) -> Result<()> {
    start_for_recipients(
        ctx,
        key,
        room_id,
        vec![agent_id],
        false,
        prompt,
        discussion,
        origin,
        attachments,
    )
}

/// Admit explicit workspace recipients into one durable effort. Recipients
/// remain outside the conversation membership; each receives only the frozen
/// originating conversation snapshot.
pub(super) fn start_for_recipients(
    ctx: &Context<'_>,
    key: String,
    room_id: String,
    recipient_ids: Vec<String>,
    explicit_recipients: bool,
    prompt: String,
    discussion: bool,
    origin: Option<&str>,
    attachments: Option<&[WorkAttachment]>,
) -> Result<()> {
    id(&key)?;
    let prompt = bounded(&prompt, 32_000, "Message")?;
    if recipient_ids.is_empty() || recipient_ids.len() > 8 {
        return Err(invalid("Choose one to eight workspace recipients."));
    }
    let mut seen = HashSet::new();
    for agent_id in &recipient_ids {
        id(agent_id)?;
        if !seen.insert(agent_id) {
            return Err(invalid(
                "Each workspace recipient can be included only once.",
            ));
        }
        profile(ctx.profiles, agent_id)?;
    }
    if let Some(existing) =
        repo::get::<Work>(ctx.conn, ctx.store, &ctx.scope.private, Kind::Work, &key)?
    {
        let recipients_match = if explicit_recipients {
            existing.recipient_ids == recipient_ids
        } else {
            existing.recipient_ids.is_empty()
                || existing.recipient_ids == vec![recipient_ids[0].clone()]
        };
        let recipients_present =
            recipient_ids
                .iter()
                .skip(1)
                .try_fold(true, |present, agent_id| {
                    if !present {
                        return Ok::<bool, StoreError>(false);
                    }
                    let child_id =
                        format!("work-{:x}", Sha256::digest(format!("{key}:{agent_id}")));
                    let child = repo::get::<Work>(
                        ctx.conn,
                        ctx.store,
                        &ctx.scope.private,
                        Kind::Work,
                        &child_id,
                    )?;
                    Ok::<bool, StoreError>(child.is_some_and(|child| {
                        child.agent_id == *agent_id && child.user_request == prompt
                    }))
                })?;
        return if existing.parent_id.is_none()
            && existing.conversation_id == room_id
            && existing.agent_id == recipient_ids[0]
            && existing.user_request == prompt
            && recipients_match
            && recipients_present
        {
            Ok(())
        } else {
            Err(invalid(
                "This submission ID already belongs to different work.",
            ))
        };
    }
    if ctx.all_work()?.len().saturating_add(recipient_ids.len()) > 2048 {
        return Err(invalid(
            "Archive or delete old conversations before starting more work.",
        ));
    }
    let room = ctx.room(&room_id)?;
    let mut work = new_work(
        ctx,
        key.clone(),
        &room,
        recipient_ids[0].clone(),
        prompt.clone(),
        prompt,
        origin,
        attachments,
        explicit_recipients,
    )?;
    if discussion {
        work.prompt = format!("{}\n\nThe user requested a wider discussion. Ask relevant participants for distinct contributions, compare their answers, and report agreement or remaining disagreement. Do not make everyone reply without a reason.", work.prompt);
    }
    if explicit_recipients {
        work.recipient_ids = recipient_ids.clone();
    }
    let captured = work.captured_context.clone();
    let delegated_attachments = attachments_for_child(&work.attachments);
    ctx.work(&work)?;
    for agent_id in recipient_ids.iter().skip(1) {
        let child_id = format!("work-{:x}", Sha256::digest(format!("{key}:{agent_id}")));
        if repo::get::<Work>(
            ctx.conn,
            ctx.store,
            &ctx.scope.private,
            Kind::Work,
            &child_id,
        )?
        .is_some()
        {
            continue;
        }
        let mut child = new_work(
            ctx,
            child_id,
            &room,
            agent_id.clone(),
            work.prompt.clone(),
            work.user_request.clone(),
            origin,
            Some(delegated_attachments.as_slice()),
            true,
        )?;
        child.root_id = work.root_id.clone();
        child.parent_id = Some(work.id.clone());
        child.depth = 1;
        child.workspace_recipient = true;
        let child_in_project_team = child
            .project_id
            .as_deref()
            .map(|project| {
                ctx.project_team(project)
                    .map(|team| team.participant_ids.contains(&child.agent_id))
            })
            .transpose()?
            .unwrap_or(true);
        super::context::inherit_shared_context(
            captured.as_ref(),
            &mut child.captured_context,
            child_in_project_team,
        )?;
        ctx.work(&child)?;
        work.dependencies.push(child.id.clone());
        work.waiting_for.push(child.id);
    }
    if recipient_ids.len() > 1 {
        work.updated_at = ctx.time.into();
        ctx.work(&work)?;
    }
    Ok(())
}

fn new_work(
    ctx: &Context<'_>,
    key: String,
    room: &Conversation,
    agent_id: String,
    prompt: String,
    user_request: String,
    origin: Option<&str>,
    attachments: Option<&[WorkAttachment]>,
    workspace_recipient: bool,
) -> Result<Work> {
    if !workspace_recipient && !room.participants.iter().any(|p| p.agent_id == agent_id) {
        return Err(invalid(
            "This agent is not a participant in this conversation.",
        ));
    }
    let agent = profile(ctx.profiles, &agent_id)?;
    let outside_project_team = if let Some(project) = &room.project_id {
        let team = ctx.project_team(project)?;
        let outside = !team.participant_ids.contains(&agent_id);
        if !workspace_recipient && outside {
            return Err(invalid("This agent is no longer a project participant."));
        }
        outside
    } else {
        false
    };
    let revision = room
        .project_id
        .as_deref()
        .map(|project| ctx.project_team(project).map(|team| team.revision))
        .transpose()?
        .unwrap_or(0);
    let mut captured_context = Some(super::context::capture(ctx, room, agent)?);
    if workspace_recipient && outside_project_team {
        super::context::narrow_workspace_context(captured_context.as_mut().unwrap())?;
    }
    Ok(Work {
        steering: vec![],
        messages: vec![],
        delivered_message_count: 0,
        delivered_steering_count: 0,
        captured_context,
        permission_mode: permission_mode(agent).into(),
        attachments: attachments.map(|refs| refs.to_vec()).unwrap_or_default(),
        origin: origin.map(Into::into),
        id: key.clone(),
        root_id: key,
        workspace_id: ctx.scope.data.workspace_id().into(),
        conversation_id: room.id.clone(),
        project_id: room.project_id.clone(),
        parent_id: None,
        agent_id,
        agent_name: agent.name.clone(),
        workspace_recipient,
        resource_claims: vec![],
        recipient_ids: vec![],
        prompt,
        user_request,
        status: WorkStatus::Queued,
        reason: None,
        dependencies: vec![],
        waiting_for: vec![],
        prerequisites: vec![],
        awaiting_user: false,
        generation: 1,
        conversation_generation: room.generation,
        context_revision: revision,
        depth: 0,
        turn_count: 0,
        token_usage: 0,
        max_turns: 12,
        max_tokens: 128_000,
        run_ids: vec![],
        current_run_id: None,
        model_option_id: agent.model_id.clone(),
        outputs: vec![],
        created_at: ctx.time.into(),
        updated_at: ctx.time.into(),
    })
}

pub(super) fn current(
    ctx: &Context<'_>,
    key: &str,
    generation: u32,
    run: Option<&str>,
) -> Result<Work> {
    let item = ctx.item(key)?;
    if item.generation != generation
        || !item.status.active()
        || run.is_some_and(|run| item.current_run_id.as_deref() != Some(run))
    {
        return Err(invalid(
            "This assignment was stopped or changed. Its late result was rejected.",
        ));
    }
    let room = ctx.room(&item.conversation_id)?;
    if room.generation != item.conversation_generation
        || (!item.workspace_recipient
            && !room
                .participants
                .iter()
                .any(|p| p.agent_id == item.agent_id))
    {
        return Err(invalid(
            "Conversation membership changed. Start a fresh assignment.",
        ));
    }
    let agent = profile(ctx.profiles, &item.agent_id)?;
    if agent.model_id != item.model_option_id {
        return Err(invalid(
            "The agent's model changed. Continue using its current model.",
        ));
    }
    if permission_rank(permission_mode(agent)) < permission_rank(&item.permission_mode) {
        return Err(invalid(
            "The agent's permissions were reduced. Review this assignment before continuing.",
        ));
    }
    if let Some(project) = &item.project_id {
        let team = ctx.project_team(project)?;
        if team.revision != item.context_revision
            || (!item.workspace_recipient && !team.participant_ids.contains(&item.agent_id))
        {
            return Err(invalid(
                "The project context changed. Review the current work record before continuing.",
            ));
        }
    }
    let root = ctx.item(&item.root_id)?;
    let independent_recipient = item.workspace_recipient
        && item.parent_id.as_deref() == Some(root.id.as_str())
        && root
            .recipient_ids
            .iter()
            .any(|agent_id| agent_id == &item.agent_id)
        && root.dependencies.iter().any(|id| id == &item.id);
    if matches!(
        root.status,
        WorkStatus::Cancelled | WorkStatus::Failed | WorkStatus::AwaitingUser | WorkStatus::Blocked
    ) && root.id != item.id
        && !independent_recipient
    {
        return Err(invalid("The parent request is no longer active."));
    }
    Ok(item)
}

/// Validate a failure report using only durable identity and generation. A
/// removed or reconfigured recipient must still be able to fail closed; the
/// normal `current` path intentionally requires a live profile for execution.
pub(super) fn current_for_failure(ctx: &Context<'_>, key: &str, generation: u32) -> Result<Work> {
    let item = ctx.item(key)?;
    if item.generation != generation || !item.status.active() {
        return Err(invalid(
            "This assignment was stopped or changed. Its late failure was rejected.",
        ));
    }
    // Keep the conversation fence even when the profile itself has gone away.
    let _ = ctx.room(&item.conversation_id)?;
    Ok(item)
}

pub(super) fn bind(
    ctx: &Context<'_>,
    key: &str,
    generation: u32,
    run: &str,
    attachments: Option<&[WorkAttachment]>,
) -> Result<()> {
    id(run)?;
    let mut item = current(ctx, key, generation, None)?;
    // An already-dispatched run keeps the exact inputs it captured. A repeated
    // bind is idempotent and never rewrites them.
    if item.current_run_id.as_deref() == Some(run) && item.status.executing() {
        if let Some(refs) = attachments {
            validate_attachments(refs)?;
        }
        return Ok(());
    }
    if item.status != WorkStatus::Queued {
        return Err(invalid("This assignment is not queued."));
    }
    if let Some(refs) = attachments {
        validate_attachments(refs)?;
        item.attachments = refs.to_vec();
        item.updated_at = ctx.time.into();
        ctx.work(&item)?;
    }
    let all = ctx.all_work()?;
    let concurrent = all
        .iter()
        .filter(|w| w.agent_id == item.agent_id && w.id != item.id && w.status.executing())
        .count();
    if concurrent > 0 {
        return Err(invalid(if item.workspace_recipient {
            "This teammate is already executing another assignment. The request remains queued."
        } else {
            "This teammate is working on another assignment. The request remains queued."
        }));
    }
    for dep in &item.prerequisites {
        let dependency = ctx.item(dep)?;
        if dependency.status != WorkStatus::Completed {
            return Err(invalid("An assignment dependency is unresolved."));
        }
    }
    let mut root = ctx.item(&item.root_id)?;
    if root.turn_count >= root.max_turns || root.token_usage >= root.max_tokens {
        return Err(invalid(
            "This exchange reached its turn or usage limit. Review the results before continuing.",
        ));
    }
    let attempt = execution_attempt::get_scoped(ctx.conn, ctx.store, &ctx.scope.data, run)?
        .ok_or_else(|| invalid("The queued provider attempt is missing."))?;
    if attempt.status != "queued" || attempt.thread_id.as_deref() != Some(&item.conversation_id) {
        return Err(invalid(
            "Bind only this conversation's exact queued provider attempt.",
        ));
    }
    let model_route = format!("{}::{}", attempt.provider_id, attempt.model);
    if item.model_option_id != model_route && item.model_option_id != attempt.model {
        return Err(invalid(
            "The queued provider/model differs from this agent's saved selection.",
        ));
    }
    item.status = WorkStatus::Running;
    item.reason = None;
    item.current_run_id = Some(run.into());
    item.delivered_message_count = item.messages.len() as u32;
    item.delivered_steering_count = item.steering.len() as u32;
    let first_run = item.run_ids.is_empty();
    item.run_ids.push(run.into());
    item.turn_count += 1;
    if !first_run || item.recipient_ids.len() > 1 {
        item.waiting_for.retain(|dependency| {
            ctx.item(dependency)
                .map(|work| work.status != WorkStatus::Completed)
                .unwrap_or(true)
        });
    } else {
        item.waiting_for.clear();
    }
    item.updated_at = ctx.time.into();
    if root.id != item.id {
        root.turn_count += 1;
        ctx.work(&root)?;
    }
    ctx.work(&item)?;
    let author = Author {
        run_id: run.into(),
        conversation_id: item.conversation_id.clone(),
        agent_id: item.agent_id,
        name: item.agent_name,
        work_id: Some(key.into()),
        generation,
    };
    if repo::get::<Author>(ctx.conn, ctx.store, &ctx.scope.private, Kind::Author, run)?.is_some() {
        return Err(invalid("This attempt already has immutable authorship."));
    }
    ctx.put(
        Kind::Author,
        run,
        Some(&author.conversation_id),
        item.project_id.as_deref(),
        &author,
    )
}

pub(super) fn finish(
    ctx: &Context<'_>,
    key: &str,
    generation: u32,
    run: &str,
    status: WorkStatus,
    reason: Option<String>,
) -> Result<()> {
    let saved = ctx.item(key)?;
    if saved.outputs.iter().any(|o| o.run_id == run)
        && saved.current_run_id.as_deref() == Some(run)
        && !saved.status.executing()
    {
        return Ok(());
    }
    let mut item = current(ctx, key, generation, Some(run))?;
    if ![
        WorkStatus::Completed,
        WorkStatus::Failed,
        WorkStatus::Cancelled,
        WorkStatus::AwaitingUser,
    ]
    .contains(&status)
    {
        return Err(invalid("Invalid terminal work status."));
    }
    let row = execution_attempt::get_scoped(ctx.conn, ctx.store, &ctx.scope.data, run)?
        .ok_or_else(|| invalid("The provider attempt is unavailable."))?;
    let attempt: crate::models::ExecutionAttempt =
        serde_json::from_value(row.payload).map_err(|_| invalid("Invalid attempt evidence."))?;
    if matches!(
        attempt.status.as_str(),
        "queued" | "streaming" | "awaiting-approval" | "retrying"
    ) {
        return Err(invalid("This attempt is still executing."));
    }
    item.status = status;
    if let Some(reason) = reason {
        item.reason = Some(bounded(&reason, 2000, "Work status")?);
    }
    if item.status == WorkStatus::Completed {
        let actual = message::list(ctx.conn, ctx.store, &ctx.scope.data, &item.conversation_id)?;
        let has_output = actual.iter().any(|m| {
            m.run_id.as_deref() == Some(run)
                && m.kind == "assistant"
                && m.current_revision_state != "redacted"
        });
        if attempt.status != "completed" || attempt.transcript.trim().is_empty() || !has_output {
            return Err(invalid(
                "Completion needs a completed provider attempt and its saved result.",
            ));
        }
        item.outputs.push(Output {
            run_id: run.into(),
            conversation_id: item.conversation_id.clone(),
            text: attempt.transcript.chars().take(6000).collect(),
            evidence: "agent-report".into(),
            created_at: ctx.time.into(),
        });
        if item.awaiting_user {
            item.status = WorkStatus::AwaitingUser;
        } else if item.steering.len() as u32 > item.delivered_steering_count {
            item.status = WorkStatus::Queued;
            item.reason =
                Some("A user follow-up arrived. A fresh turn is queued to review it.".into());
        } else if item.messages.len() as u32 > item.delivered_message_count {
            // A task message arrived while the provider was running. Keep the
            // completed evidence, then queue one fresh bounded turn so the
            // provider can see it; never replay the just-finished attempt.
            item.status = WorkStatus::Queued;
            item.reason =
                Some("A task-scoped message arrived. A fresh turn is queued to review it.".into());
        } else if !item.waiting_for.is_empty() {
            item.status = WorkStatus::Waiting;
        }
    }
    let usage = attempt
        .usage
        .as_ref()
        .map(|u| u.input_tokens + u.output_tokens)
        .unwrap_or(8_000);
    let mut root = ctx.item(&item.root_id)?;
    item.token_usage = item.token_usage.saturating_add(usage);
    item.updated_at = ctx.time.into();
    if root.id != item.id {
        root.token_usage = root.token_usage.saturating_add(usage);
        ctx.work(&root)?;
    }
    ctx.work(&item)?;
    if !matches!(
        item.status,
        WorkStatus::Completed | WorkStatus::Waiting | WorkStatus::Queued
    ) {
        for child in ctx.all_work()? {
            let preserve_explicit_recipient = item.parent_id.is_none()
                && item
                    .recipient_ids
                    .iter()
                    .any(|agent_id| agent_id == &child.agent_id);
            if child.parent_id.as_deref() == Some(key)
                && child.status.active()
                && !preserve_explicit_recipient
            {
                invalidate_descendants(
                    ctx,
                    &child.id,
                    "The requesting assignment stopped or needs the user.",
                    WorkStatus::Cancelled,
                )?;
            }
        }
    }
    wake_waiters(ctx)
}

pub(super) fn agent_command(
    ctx: &Context<'_>,
    key: &str,
    generation: u32,
    run: &str,
    call: &str,
    command: AgentCommand,
) -> Result<()> {
    bounded(call, 256, "Tool call ID")?;
    let receipt = format!("call-{:x}", Sha256::digest(format!("{run}:{call}")));
    if let Some(old) = repo::get::<AgentCommand>(
        ctx.conn,
        ctx.store,
        &ctx.scope.private,
        Kind::Receipt,
        &receipt,
    )? {
        return if old == command {
            current(ctx, key, generation, Some(run)).map(|_| ())
        } else {
            Err(invalid(
                "A tool call ID was reused with different instructions.",
            ))
        };
    }
    let mut item = current(ctx, key, generation, Some(run))?;
    if !item.status.executing() {
        return Err(invalid("This assignment is not executing."));
    }
    match &command {
        AgentCommand::Delegate {
            agent_id,
            prompt,
            title,
            dependencies,
            focused,
        } => {
            if item.depth >= 2 || agent_id == &item.agent_id {
                return Err(invalid("Delegation depth reached or self-handoff requested. Report the remaining work."));
            }
            let room = ctx.room(&item.conversation_id)?;
            let all = ctx.all_work()?;
            let root = ctx.item(&item.root_id)?;
            if root.turn_count >= root.max_turns
                || root.token_usage >= root.max_tokens
                || all.iter().filter(|w| w.root_id == item.root_id).count() >= 12
                || all
                    .iter()
                    .filter(|w| w.parent_id.as_deref() == Some(key))
                    .count()
                    >= 4
            {
                return Err(invalid("This exchange reached its delegation budget."));
            }
            let mut ancestor = Some(item.clone());
            while let Some(parent) = ancestor {
                if &parent.agent_id == agent_id {
                    return Err(invalid(
                        "Circular handoffs are not allowed. Return your result to the requester.",
                    ));
                }
                ancestor = parent
                    .parent_id
                    .as_deref()
                    .map(|id| ctx.item(id))
                    .transpose()?;
            }
            let prompt = bounded(prompt, 6000, "Assignment")?;
            let title = bounded(title, 120, "Assignment title")?;
            if all
                .iter()
                .any(|w| w.root_id == item.root_id && w.agent_id == *agent_id && w.prompt == prompt)
            {
                return Err(invalid(
                    "That assignment has already been dispatched. Wait for its result.",
                ));
            }
            if dependencies.len() > 4 {
                return Err(invalid("Use at most four dependencies."));
            }
            for dep in dependencies {
                let prior = ctx.item(dep)?;
                if prior.root_id != item.root_id
                    || prior.id == item.id
                    || prior.parent_id != item.parent_id && prior.parent_id.as_deref() != Some(key)
                {
                    return Err(invalid(
                        "Dependencies must be existing peer assignments within this request.",
                    ));
                }
            }
            let child_id = format!(
                "work-{:x}",
                Sha256::digest(format!("{run}:{call}:{agent_id}"))
            );
            let child_room = if *focused {
                if room.project_id.is_none() {
                    room
                } else {
                    ctx.create_room(
                        &format!("thread-{child_id}"),
                        &title,
                        "group",
                        room.participants.clone(),
                        Some(agent_id.clone()),
                        room.project_id.clone(),
                    )?
                }
            } else {
                room
            };
            let mut child = new_work(
                ctx,
                child_id.clone(),
                &child_room,
                agent_id.clone(),
                prompt,
                item.user_request.clone(),
                item.origin.as_deref(),
                Some(attachments_for_child(&item.attachments).as_slice()),
                true,
            )?;
            child.workspace_recipient = true;
            // Both focused and inline delegation inherit the originating
            // request snapshot. A focused side room changes presentation,
            // not the authorization or context boundary of the assignment.
            let child_in_project_team = child
                .project_id
                .as_deref()
                .map(|project| {
                    ctx.project_team(project)
                        .map(|team| team.participant_ids.contains(&child.agent_id))
                })
                .transpose()?
                .unwrap_or(true);
            super::context::inherit_shared_context(
                item.captured_context.as_ref(),
                &mut child.captured_context,
                child_in_project_team,
            )?;
            child.parent_id = Some(item.id.clone());
            child.root_id = item.root_id.clone();
            child.depth = item.depth + 1;
            if permission_rank(&child.permission_mode) > permission_rank(&item.permission_mode) {
                child.permission_mode = item.permission_mode.clone();
            }
            child.dependencies = dependencies.clone();
            child.prerequisites = dependencies.clone();
            child.max_tokens = item.max_tokens;
            child.max_turns = item.max_turns;
            if !dependencies.is_empty() {
                child.status = WorkStatus::Waiting;
                child.waiting_for = dependencies.clone();
            }
            ctx.work(&child)?;
            item.dependencies.push(child_id.clone());
            item.waiting_for.push(child_id);
            ctx.work(&item)?;
        }
        AgentCommand::Message {
            assignment_id,
            message,
            question,
        } => exchanges::message(ctx, &mut item, &receipt, assignment_id, message, *question)?,
        AgentCommand::ClaimResource { resource } => {
            exchanges::claim_resource(ctx, &mut item, resource)?;
        }
        AgentCommand::RecordFact {
            text,
            fact_kind,
            source,
            confidence,
            supersedes_id,
        } => {
            if !["inference", "external-observation"].contains(&confidence.as_str()) {
                return Err(invalid("Agents may record inferences or dated observations. Only the user confirms facts."));
            }
            let project = item
                .project_id
                .clone()
                .ok_or_else(|| invalid("Shared facts require a project."))?;
            let team = ctx.project_team(&project)?;
            if !team.participant_ids.contains(&item.agent_id) {
                return Err(invalid(
                    "Only a project's configured team members may record shared facts.",
                ));
            }
            commands::save_fact(
                ctx,
                Fact {
                    id: receipt.clone(),
                    project_id: project,
                    kind: fact_kind.clone(),
                    text: text.clone(),
                    confidence: confidence.clone(),
                    status: "current".into(),
                    conversation_id: item.conversation_id.clone(),
                    run_id: Some(run.into()),
                    source: source.clone(),
                    supersedes_id: supersedes_id.clone(),
                    created_at: ctx.time.into(),
                },
                Some(key),
            )?;
        }
        AgentCommand::AwaitUser { reason } => {
            item.awaiting_user = true;
            item.reason = Some(bounded(reason, 2000, "Question or blocker")?);
            ctx.work(&item)?;
        }
    }
    ctx.put(
        Kind::Receipt,
        &receipt,
        Some(&item.conversation_id),
        item.project_id.as_deref(),
        &command,
    )
}

pub(super) fn invalidate_descendants(
    ctx: &Context<'_>,
    key: &str,
    reason: &str,
    status: WorkStatus,
) -> Result<()> {
    let all = ctx.all_work()?;
    let mut affected = HashSet::from([key.to_string()]);
    loop {
        let count = affected.len();
        for item in &all {
            if item
                .parent_id
                .as_ref()
                .is_some_and(|p| affected.contains(p))
            {
                affected.insert(item.id.clone());
            }
        }
        if affected.len() == count {
            break;
        }
    }
    for mut item in all {
        if affected.contains(&item.id)
            && item.status != WorkStatus::Completed
            && item.status != WorkStatus::Cancelled
        {
            item.generation += 1;
            item.status = status.clone();
            item.reason = Some(reason.into());
            item.updated_at = ctx.time.into();
            ctx.work(&item)?;
        }
    }
    Ok(())
}

pub(super) fn wake_waiters(ctx: &Context<'_>) -> Result<()> {
    // Resolve to a fixed point: a failed prerequisite may block a peer later
    // in this scan, which must then wake its lead in the same transaction.
    // Every transition leaves Waiting, so this is bounded by the work count.
    loop {
        let mut changed = false;
        for mut item in ctx.all_work()? {
            if item.status != WorkStatus::Waiting {
                continue;
            }
            let dependencies = item
                .waiting_for
                .iter()
                .map(|key| ctx.item(key))
                .collect::<Result<Vec<_>>>()?;
            if dependencies.iter().any(|dep| {
                matches!(
                    dep.status,
                    WorkStatus::Failed
                        | WorkStatus::Cancelled
                        | WorkStatus::Blocked
                        | WorkStatus::AwaitingUser
                )
            }) {
                if item.prerequisites.is_empty() {
                    if dependencies.iter().any(|dep| dep.status.active()) {
                        continue;
                    }
                    item.status = WorkStatus::Queued;
                    item.awaiting_user = true;
                    item.reason = Some("Report the unresolved delegated assignment and ask the user what is needed. Do not claim it completed.".into());
                } else {
                    item.status = WorkStatus::Blocked;
                    item.reason = Some("A delegated assignment is unresolved. Review its result or question before continuing.".into());
                }
            } else if dependencies
                .iter()
                .all(|dep| dep.status == WorkStatus::Completed)
            {
                let root = ctx.item(&item.root_id)?;
                if root.turn_count >= root.max_turns || root.token_usage >= root.max_tokens {
                    item.status = WorkStatus::AwaitingUser;
                    item.reason = Some("The exchange reached its turn or usage limit. Review results before continuing.".into());
                } else {
                    item.status = WorkStatus::Queued;
                    item.reason = Some("Delegated results are ready for review.".into());
                }
            } else {
                continue;
            }
            item.updated_at = ctx.time.into();
            ctx.work(&item)?;
            changed = true;
        }
        if !changed {
            break;
        }
    }
    Ok(())
}

const MAX_WORK_ATTACHMENTS: usize = 12;
const MAX_WORK_ATTACHMENT_BYTES: u64 = 2 * 1024 * 1024;

fn sha256_is_well_formed(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Durable attachment references are bounded and exact. Transient and image
/// inputs may only carry identity metadata; workspace refs require the staged
/// account-root path and the exact staged content hash, and knowledge refs the
/// exact source id.
pub(super) fn validate_attachments(attachments: &[WorkAttachment]) -> Result<()> {
    if attachments.len() > MAX_WORK_ATTACHMENTS {
        return Err(invalid(
            "A request can reference at most twelve attached files.",
        ));
    }
    let mut ids = HashSet::new();
    for attachment in attachments {
        if attachment.id.is_empty()
            || attachment.id.chars().count() > 160
            || !ids.insert(&attachment.id)
        {
            return Err(invalid(
                "Each attached file needs a unique bounded identity.",
            ));
        }
        let name = attachment.name.trim();
        if name.is_empty()
            || name.chars().count() > 256
            || name.contains(['/', '\\'])
            || name.chars().any(char::is_control)
        {
            return Err(invalid("The attached file name is invalid."));
        }
        let mime = attachment.mime_type.trim();
        if mime.is_empty() || mime.chars().count() > 120 || mime.chars().any(char::is_control) {
            return Err(invalid("The attached file media type is invalid."));
        }
        if attachment.size_bytes == 0 || attachment.size_bytes > MAX_WORK_ATTACHMENT_BYTES {
            return Err(invalid("The attached file size is invalid."));
        }
        let path_is_safe = attachment.relative_path.as_ref().is_some_and(|path| {
            path.chars().count() <= 512
                && path.starts_with("Attachments/")
                && !path.contains('\\')
                && path
                    .split('/')
                    .all(|part| !part.is_empty() && part != "." && part != "..")
                && !path.chars().any(char::is_control)
        });
        let source_is_safe = attachment
            .source_id
            .as_ref()
            .is_some_and(|id| !id.is_empty() && id.chars().count() <= 200 && !id.contains('\0'));
        let hash_is_safe = attachment
            .sha256
            .as_deref()
            .is_some_and(sha256_is_well_formed);
        match attachment.availability.as_str() {
            "workspace-file" => {
                if !path_is_safe || attachment.source_id.is_some() || !hash_is_safe {
                    return Err(invalid("The staged file reference is invalid."));
                }
            }
            "knowledge-context" => {
                if !source_is_safe
                    || attachment.relative_path.is_some()
                    || attachment.sha256.is_some()
                {
                    return Err(invalid("The knowledge reference is invalid."));
                }
            }
            "image-input" | "transient" => {
                if attachment.relative_path.is_some()
                    || attachment.source_id.is_some()
                    || attachment.sha256.is_some()
                {
                    return Err(invalid("In-memory inputs cannot carry durable references."));
                }
            }
            _ => return Err(invalid("The attached file reference kind is unknown.")),
        }
    }
    Ok(())
}

/// Native authority for staged inputs: every workspace ref must resolve inside
/// the exact agent workspace for this account and still match the staged size
/// and content hash. Missing or changed files fail closed with the reattach
/// prerequisite; the renderer never has to be trusted for this.
pub(super) fn verify_attachment_files(
    computer: Option<&crate::local_computer::LocalComputerState>,
    workspace_id: &str,
    agent_id: &str,
    attachments: &[WorkAttachment],
) -> Result<()> {
    let files = attachments
        .iter()
        .filter(|attachment| attachment.availability == "workspace-file")
        .collect::<Vec<_>>();
    if files.is_empty() {
        return Ok(());
    }
    let computer = computer.ok_or_else(|| {
        invalid("The local computer is unavailable, so staged attachments cannot be verified.")
    })?;
    let root = computer
        .tool_workspace_root(workspace_id, agent_id)
        .map_err(|_| {
            invalid(
                "This agent's workspace is unavailable, so staged attachments cannot be verified.",
            )
        })?;
    let canonical_root = crate::paths::strict_canonicalize(&root)
        .map_err(|_| invalid("This agent's workspace failed its security check."))?;
    for attachment in files {
        let relative = attachment
            .relative_path
            .as_deref()
            .ok_or_else(|| invalid("The staged file reference is invalid."))?;
        let canonical = crate::paths::strict_canonicalize(&root.join(relative)).map_err(|_| {
            StoreError::Invalid(format!(
                "This request's staged file is no longer available: {}. Reattach it before continuing.",
                attachment.name
            ))
        })?;
        if !canonical.starts_with(&canonical_root) {
            return Err(invalid(
                "The staged attachment path is outside this agent's workspace.",
            ));
        }
        let metadata = std::fs::metadata(&canonical).map_err(|_| {
            StoreError::Invalid(format!(
                "This request's staged file is no longer available: {}. Reattach it before continuing.",
                attachment.name
            ))
        })?;
        if !metadata.is_file() || metadata.len() != attachment.size_bytes {
            return Err(StoreError::Invalid(format!(
                "This request's staged file changed since it was attached: {}. Reattach it before continuing.",
                attachment.name
            )));
        }
        if let Some(expected) = attachment.sha256.as_deref() {
            let bytes = std::fs::read(&canonical).map_err(|_| {
                StoreError::Invalid(format!(
                    "This request's staged file could not be verified: {}. Reattach it before continuing.",
                    attachment.name
                ))
            })?;
            let actual = hex::encode(Sha256::digest(&bytes));
            if actual != expected {
                return Err(StoreError::Invalid(format!(
                    "This request's staged file changed since it was attached: {}. Reattach it before continuing.",
                    attachment.name
                )));
            }
        }
    }
    Ok(())
}

pub(super) fn reconcile_profiles(ctx: &Context<'_>) -> Result<()> {
    for item in ctx.all_work()? {
        if item.status.active()
            && (profile(ctx.profiles, &item.agent_id).is_err()
                || profile(ctx.profiles, &item.agent_id)?.model_id != item.model_option_id)
        {
            invalidate_descendants(ctx, &item.id, "The agent was removed or its model changed. Inspect prior results before continuing with a current teammate.", WorkStatus::AwaitingUser)?;
        }
    }
    wake_waiters(ctx)
}
