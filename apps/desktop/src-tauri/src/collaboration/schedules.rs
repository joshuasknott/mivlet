use super::*;

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
    profiles: &[FableAgentProfile],
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
        participants: participants(profiles, &team.participant_ids, agent)?,
        revision: 1,
        generation: 1,
        created_at: time.into(),
        updated_at: time.into(),
    };
    let key = format!("work-{run}");
    if repo::get::<Work>(conn, store, &scope.private, Kind::Work, &key)?.is_some() {
        return work::bind(&ctx, &key, 1, run);
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
    )?;
    let mut item = ctx.item(&key)?;
    item.permission_mode = "read-only".into();
    ctx.work(&item)?;
    work::bind(&ctx, &key, 1, run)
}

pub(crate) fn finish_schedule(
    conn: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    profiles: &[FableAgentProfile],
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
