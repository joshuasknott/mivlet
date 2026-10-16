use super::*;

/// The occurrence lease fences every automation descendant before provider
/// dispatch and every tool effect, including approval resumes.
pub(crate) fn check_schedule(
    conn: &Connection,
    store: &Store,
    scope: &crate::store::repos::scope::PrivateDataScope,
    root: &Work,
    time: &str,
    running: bool,
) -> Result<()> {
    let Some(context) = &root.schedule else {
        return Ok(());
    };
    let occurrence = crate::store::repos::local_schedule::get_occurrence(
        conn,
        store,
        scope,
        &context.occurrence_id,
    )?
    .ok_or_else(|| invalid("This automation occurrence is unavailable."))?;
    let schedule = crate::store::repos::local_schedule::get_schedule(
        conn,
        store,
        scope,
        &occurrence.schedule_id,
    )?
    .ok_or_else(|| invalid("This automation schedule is unavailable."))?;
    if schedule.trigger_kind == "event" {
        let expiry = schedule.payload["trigger"]["validUntil"]
            .as_str()
            .ok_or_else(|| invalid("This event trigger expiry is unavailable."))?;
        let expires = chrono::DateTime::parse_from_rfc3339(expiry)
            .map_err(|_| invalid("This event trigger expiry is invalid."))?;
        let current = chrono::DateTime::parse_from_rfc3339(time)
            .map_err(|_| invalid("This event execution time is invalid."))?;
        if schedule.revision != occurrence.schedule_revision || expires <= current {
            return Err(invalid(
                "This event trigger changed or expired. Review saved results before continuing.",
            ));
        }
        let event_expiry = context
            .event
            .as_ref()
            .and_then(|event| chrono::DateTime::parse_from_rfc3339(&event.expires_at).ok())
            .ok_or_else(|| invalid("This event receipt expiry is unavailable."))?;
        if event_expiry <= current {
            return Err(invalid(
                "This event receipt expired. Redeliver a fresh event before continuing.",
            ));
        }
    }
    if occurrence.payload["workId"].as_str() != Some(root.id.as_str())
        || occurrence.lease_expires_at.as_str() <= time
        || schedule.status != "enabled"
        || (running && occurrence.state != "running")
        || !matches!(occurrence.state.as_str(), "claimed" | "running")
    {
        return Err(invalid("This automation was paused, stopped or its claim expired. Review saved results before continuing."));
    }
    Ok(())
}

/// Stage a frozen occurrence through the ordinary Work executor. The claim is
/// supplied only by native schedule orchestration and grants no tool permit.
pub(crate) fn stage_schedule(
    conn: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    profiles: &[MivletAgentProfile],
    claim: &crate::local_schedules::LocalScheduleClaim,
    time: &str,
) -> Result<Work> {
    let mut captured_profiles = profiles.to_vec();
    let agent = captured_profiles
        .iter_mut()
        .find(|p| p.id == claim.agent_id)
        .ok_or_else(|| invalid("This schedule's named agent is unavailable."))?;
    agent.model_id = format!("{}::{}", claim.provider_id, claim.model);
    agent.reasoning_effort = claim.reasoning_effort.clone();
    let ctx = Context {
        conn,
        store,
        scope,
        profiles: &captured_profiles,
        time,
    };
    validate_schedule_project(
        conn,
        store,
        scope,
        claim.project_id.as_deref(),
        &claim.agent_id,
    )?;
    let key = format!("work-schedule-{}", claim.occurrence_id);
    if let Some(item) = repo::get::<Work>(conn, store, &scope.private, Kind::Work, &key)? {
        if item.status != WorkStatus::Queued || !item.run_ids.is_empty() {
            return Err(invalid(
                "This schedule occurrence has already started or stopped.",
            ));
        }
        return Ok(item);
    }
    let room = ctx.create_room(
        &format!("schedule-chat-{}", claim.occurrence_id),
        "Scheduled task",
        if claim.project_id.is_some() {
            "group"
        } else {
            "direct"
        },
        participants(
            &captured_profiles,
            std::slice::from_ref(&claim.agent_id),
            Some(&claim.agent_id),
        )?,
        Some(claim.agent_id.clone()),
        claim.project_id.clone(),
    )?;
    work::start(
        &ctx,
        key.clone(),
        room.id,
        claim.agent_id.clone(),
        claim.prompt.clone(),
        false,
        Some("schedule"),
        None,
    )?;
    let mut item = ctx.item(&key)?;
    let rank = |mode: &str| match mode {
        "full-access" => 2,
        "trusted-scope" => 1,
        _ => 0,
    };
    if rank(&claim.permission_mode) < rank(&item.permission_mode) {
        item.permission_mode = claim.permission_mode.clone();
    }
    item.schedule = Some(ScheduledWorkContext {
        event: crate::store::repos::local_schedule::get_occurrence(
            conn,
            store,
            &scope.private,
            &claim.occurrence_id,
        )?
        .and_then(|row| row.payload.get("event").cloned())
        .map(serde_json::from_value)
        .transpose()
        .map_err(|_| invalid("The event provenance is invalid."))?,
        occurrence_id: claim.occurrence_id.clone(),
        reasoning_effort: claim.reasoning_effort.clone(),
    });
    ctx.work(&item)?;
    Ok(item)
}

pub(crate) fn validate_schedule_project(
    conn: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    project: Option<&str>,
    agent: &str,
) -> Result<()> {
    let Some(project) = project else {
        return Ok(());
    };
    let ctx = Context {
        conn,
        store,
        scope,
        profiles: &[],
        time: "",
    };
    let team = ctx.project_team(project)?;
    if !team.participant_ids.iter().any(|id| id == agent) {
        return Err(invalid(
            "Choose a current project participant for scheduled research.",
        ));
    }
    Ok(())
}

/// Called only after the occurrence repository binds its exact frozen prompt
/// and queued attempt. No new grant or automatic continuation is introduced.
pub(crate) fn bind_schedule(
    conn: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    profiles: &[MivletAgentProfile],
    project: &str,
    agent: &str,
    run: &str,
    time: &str,
) -> Result<()> {
    let ctx = Context {
        conn,
        store,
        scope,
        profiles,
        time,
    };
    validate_schedule_project(conn, store, scope, Some(project), agent)?;
    let attempt =
        crate::store::repos::execution_attempt::get_scoped(conn, store, &scope.data, run)?
            .ok_or_else(|| invalid("The scheduled attempt is unavailable."))?;
    let thread_id = attempt
        .thread_id
        .as_deref()
        .ok_or_else(|| invalid("The scheduled result conversation is missing."))?;
    let thread = thread::get(conn, store, &scope.data, thread_id)?
        .ok_or_else(|| invalid("The scheduled result conversation is missing."))?;
    let team = ctx.project_team(project)?;
    let room = Conversation {
        chat: None,
        id: thread.id,
        workspace_id: scope.data.workspace_id().into(),
        kind: "group".into(),
        title: "Scheduled project research".into(),
        project_id: Some(project.into()),
        facilitator_id: Some(agent.into()),
        participants: participants(profiles, &team.participant_ids, Some(agent))?,
        revision: 1,
        generation: 1,
        archived: false,
        created_at: time.into(),
        updated_at: time.into(),
    };
    let key = format!("work-{run}");
    if repo::get::<Work>(conn, store, &scope.private, Kind::Work, &key)?.is_some() {
        return work::bind(&ctx, &key, 1, run, None);
    }
    ctx.conversation(&room)?;
    let prompt = attempt
        .payload
        .get("exchanges")
        .and_then(|value| value.as_array())
        .and_then(|items| items.first())
        .and_then(|value| value.get("content"))
        .and_then(|value| value.as_str())
        .ok_or_else(|| invalid("The scheduled prompt is missing."))?;
    work::start(
        &ctx,
        key.clone(),
        room.id,
        agent.into(),
        prompt.into(),
        false,
        Some("schedule"),
        None,
    )?;
    let mut item = ctx.item(&key)?;
    item.permission_mode = "read-only".into();
    ctx.work(&item)?;
    work::bind(&ctx, &key, 1, run, None)
}

pub(crate) fn finish_schedule(
    conn: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    profiles: &[MivletAgentProfile],
    run: &str,
    time: &str,
) -> Result<()> {
    let ctx = Context {
        conn,
        store,
        scope,
        profiles,
        time,
    };
    let key = format!("work-{run}");
    let Some(item) = repo::get::<Work>(conn, store, &scope.private, Kind::Work, &key)? else {
        return Ok(());
    };
    // Stop, a context correction, or restart may have already invalidated it.
    if !item.status.executing() {
        return Ok(());
    }
    let row = crate::store::repos::execution_attempt::get_scoped(conn, store, &scope.data, run)?
        .ok_or_else(|| invalid("The scheduled result evidence is unavailable."))?;
    let status = match row.status.as_str() {
        "completed" => WorkStatus::Completed,
        "failed" => WorkStatus::Failed,
        _ => WorkStatus::AwaitingUser,
    };
    work::finish(
        &ctx,
        &key,
        item.generation,
        run,
        status,
        row.payload
            .get("error")
            .and_then(|value| value.as_str())
            .map(String::from),
    )
}
