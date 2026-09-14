use super::*;

pub(super) fn apply(ctx: &Context<'_>, command: Command) -> Result<()> {
    match command {
        Command::SteerWork {
            id: key,
            expected_generation,
            event_id,
            text,
        } => {
            id(&event_id)?;
            let text = bounded(&text, 2_000, "Steering")?;
            let mut item = ctx.item(&key)?;
            if let Some(event) = item.steering.iter().find(|event| event.id == event_id) {
                return if event.text == text {
                    Ok(())
                } else {
                    Err(invalid("Steering event ID was already used."))
                };
            }
            if item.generation != expected_generation
                || item.steering.len() >= 16
                || item.status == WorkStatus::Completed
            {
                return Err(invalid(
                    "Refresh this Work before steering it; completed Work needs a new request.",
                ));
            }
            let uncertain = !item.run_ids.is_empty();
            item.generation += 1;
            item.current_run_id = None;
            item.steering.push(WorkSteering {
                id: event_id,
                text,
                created_at: ctx.time.into(),
            });
            item.status = if uncertain {
                WorkStatus::AwaitingUser
            } else {
                WorkStatus::Queued
            };
            item.reason = Some(if uncertain { "Steering saved. Review prior outcomes before continuing; no external effect was replayed." } else { "Steering saved before dispatch." }.into());
            item.updated_at = ctx.time.into();
            ctx.work(&item)?;
            for child in ctx.all_work()? {
                if child.parent_id.as_deref() == Some(&key) && child.status.active() {
                    work::invalidate_descendants(ctx, &child.id, "The requesting Work was steered. Review existing outcomes before continuing.", WorkStatus::AwaitingUser)?;
                }
            }
        }

        Command::OpenMainChat { agent_id } => {
            chats::open_main(ctx, &agent_id)?;
        }
        Command::CreateConversation {
            id,
            title,
            kind,
            participant_ids,
            facilitator_id,
            project_id,
        } => {
            let members = participants(ctx.profiles, &participant_ids, facilitator_id.as_deref())?;
            ctx.create_room(&id, &title, &kind, members, facilitator_id, project_id)?;
        }
        Command::RenameConversation {
            id,
            expected_revision,
            title,
        } => chats::rename(ctx, &id, expected_revision, &title)?,
        Command::SetConversationArchived {
            id,
            expected_revision,
            archived,
        } => chats::set_archived(ctx, &id, expected_revision, archived)?,
        Command::DeleteConversation {
            id,
            expected_revision,
        } => chats::delete(ctx, &id, expected_revision)?,
        Command::UpdateConversation {
            id,
            expected_revision,
            title,
            participant_ids,
            facilitator_id,
            share_history,
        } => {
            let mut room = ctx.room(&id)?;
            if room.revision != expected_revision {
                return Err(invalid("This conversation changed. Reload before editing."));
            }
            if participant_ids
                .iter()
                .any(|id| !room.participants.iter().any(|p| &p.agent_id == id))
                && !share_history
            {
                return Err(invalid(
                    "Confirm sharing existing conversation history with new participants.",
                ));
            }
            let members = participants(ctx.profiles, &participant_ids, facilitator_id.as_deref())?;
            if room.kind == "direct" && members.len() != 1 {
                return Err(invalid(
                    "Create a project to work with more than one teammate.",
                ));
            }
            if let Some(project) = &room.project_id {
                let team = ctx.project_team(project)?;
                if participant_ids
                    .iter()
                    .any(|id| !team.participant_ids.contains(id))
                {
                    return Err(invalid("Add new participants to the project first."));
                }
            }
            room.title = bounded(&title, 120, "Conversation title")?;
            if room.participants != members || room.facilitator_id != facilitator_id {
                invalidate_room(
                    ctx,
                    &id,
                    "Conversation participants changed. Review the assignment before continuing.",
                )?;
                room.generation += 1;
            }
            room.participants = members;
            room.facilitator_id = facilitator_id;
            room.revision += 1;
            room.updated_at = ctx.time.into();
            thread::update(
                ctx.conn,
                ctx.store,
                &ctx.scope.data,
                &id,
                Some(&room.title),
                None,
                None,
                ctx.time,
            )?;
            ctx.conversation(&room)?;
        }
        Command::PlaceConversation {
            id,
            expected_revision,
            project_id,
            share_history,
        } => {
            let mut room = ctx.room(&id)?;
            if !share_history {
                return Err(invalid(
                    "Confirm sharing this conversation's history with the project.",
                ));
            }
            if room.revision != expected_revision || room.project_id.is_some() {
                return Err(invalid(
                    "This conversation changed or already belongs to a project.",
                ));
            }
            let team = ctx.project_team(&project_id)?;
            let members = participants(
                ctx.profiles,
                &team.participant_ids,
                team.lead_agent_id.as_deref(),
            )?;
            invalidate_room(ctx, &id, "This conversation was shared with a project. Review its context before continuing.")?;
            room.project_id = Some(project_id.clone());
            room.kind = "group".into();
            room.participants = members;
            room.facilitator_id = team.lead_agent_id.clone();
            room.revision += 1;
            room.generation += 1;
            room.updated_at = ctx.time.into();
            ctx.conversation(&room)?;
            // Historical runs keep their original bytes. Where evidence exists,
            // they also gain permanent authorship for the new project.
            crate::local_projects::backfill_thread_authors(
                ctx.conn,
                ctx.store,
                ctx.scope,
                &project_id,
                &id,
                ctx.profiles,
            )?;
        }
        Command::UpdateTeam {
            project_id,
            expected_revision,
            lead_agent_id,
            participant_ids,
            share_history,
        } => {
            let mut team = ctx.project_team(&project_id)?;
            if team.revision != expected_revision {
                return Err(invalid(
                    "The project team or decisions changed. Reload before editing.",
                ));
            }
            if participant_ids
                .iter()
                .any(|id| !team.participant_ids.contains(id))
                && !share_history
            {
                return Err(invalid("Confirm sharing existing project conversations, references and work with new participants."));
            }
            let members = participants(ctx.profiles, &participant_ids, lead_agent_id.as_deref())?;
            invalidate_project(ctx, &project_id, None, "The project lead or participants changed. Review current assignments before continuing.")?;
            team.revision += 1;
            team.participant_ids = participant_ids;
            team.lead_agent_id = lead_agent_id.clone();
            ctx.team(&team)?;
            let project =
                local_project::get_project(ctx.conn, ctx.store, &ctx.scope.private, &project_id)?
                    .ok_or_else(|| invalid("Project missing."))?;
            for mut room in repo::list::<Conversation>(
                ctx.conn,
                ctx.store,
                &ctx.scope.private,
                Kind::Conversation,
            )? {
                if room.project_id.as_deref() != Some(&project_id) {
                    continue;
                }
                if room.id == project.thread_id {
                    room.participants = members.clone();
                    room.facilitator_id = lead_agent_id.clone();
                } else {
                    room.participants
                        .retain(|p| team.participant_ids.contains(&p.agent_id));
                    if !room
                        .participants
                        .iter()
                        .any(|p| Some(&p.agent_id) == room.facilitator_id.as_ref())
                    {
                        room.facilitator_id = room.participants.first().map(|p| p.agent_id.clone());
                    }
                }
                room.revision += 1;
                room.generation += 1;
                room.updated_at = ctx.time.into();
                ctx.conversation(&room)?;
            }
        }
        Command::StartWork {
            id,
            conversation_id,
            agent_id,
            prompt,
            discussion,
            attachments,
        } => {
            if let Some(refs) = &attachments {
                work::validate_attachments(refs)?;
            }
            work::start(
                ctx,
                id,
                conversation_id,
                agent_id,
                prompt,
                discussion,
                None,
                attachments.as_deref(),
            )?;
        }
        Command::BindWork {
            id,
            generation,
            run_id,
            attachments,
        } => work::bind(ctx, &id, generation, &run_id, attachments.as_deref())?,
        Command::CheckWork {
            id,
            generation,
            run_id,
        } => {
            work::current(ctx, &id, generation, Some(&run_id))?;
        }
        Command::FinishWork {
            id,
            generation,
            run_id,
            status,
            reason,
        } => work::finish(ctx, &id, generation, &run_id, status, reason)?,
        Command::StopWork { id } => {
            ctx.item(&id)?;
            work::invalidate_descendants(
                ctx,
                &id,
                "Stopped by the user. Already completed external actions are not undone.",
                WorkStatus::Cancelled,
            )?;
            work::wake_waiters(ctx)?;
        }
        Command::StopProject { project_id } => {
            ctx.project_team(&project_id)?;
            for item in ctx.all_work()? {
                if item.project_id.as_deref() == Some(&project_id)
                    && item.status != WorkStatus::Completed
                {
                    work::invalidate_descendants(
                        ctx,
                        &item.id,
                        "The user stopped this project.",
                        WorkStatus::Cancelled,
                    )?;
                }
            }
        }
        Command::ContinueWork {
            id,
            expected_generation,
            reconcile,
        } => {
            let mut item = ctx.item(&id)?;
            if !reconcile
                || expected_generation != item.generation
                || item.status.active()
                || item.status == WorkStatus::Completed
            {
                return Err(invalid("Inspect the latest saved results and reconcile external effects before continuing."));
            }
            let room = ctx.room(&item.conversation_id)?;
            let agent = profile(ctx.profiles, &item.agent_id)?;
            if !room
                .participants
                .iter()
                .any(|p| p.agent_id == item.agent_id)
            {
                return Err(invalid("This teammate is no longer a participant. Create a new assignment for a current participant."));
            }
            let root = ctx.item(&item.root_id)?;
            if root.id != item.id
                && matches!(root.status, WorkStatus::Cancelled | WorkStatus::Completed)
            {
                return Err(invalid(
                    "Start a new request; this assignment's parent has ended.",
                ));
            }
            if item.captured_context.is_none() {
                item.captured_context = Some(super::context::capture(ctx, &room, agent)?);
            }
            item.model_option_id = agent.model_id.clone();
            item.conversation_generation = room.generation;
            item.context_revision = room
                .project_id
                .as_deref()
                .map(|p| ctx.project_team(p).map(|t| t.revision))
                .transpose()?
                .unwrap_or(0);
            item.generation += 1;
            item.awaiting_user = false;
            item.status = WorkStatus::Queued;
            item.current_run_id = None;
            item.reason = Some("Continuation requested after reviewing saved results. Use a fresh attempt; never replay external effects.".into());
            // An explicit continuation adds a bounded round; it does not erase
            // prior usage or make a retry of an external action automatic.
            if item.root_id == item.id {
                item.max_turns = item.turn_count.saturating_add(6);
                item.max_tokens = item.token_usage.saturating_add(128_000);
            }
            item.updated_at = ctx.time.into();
            ctx.work(&item)?;
        }
        Command::WorkStatus {
            id,
            generation,
            status,
            reason,
        } => {
            let mut item = work::current(ctx, &id, generation, None)?;
            if !matches!(
                status,
                WorkStatus::AwaitingApproval | WorkStatus::Running | WorkStatus::Failed
            ) || status.executing() && item.current_run_id.is_none()
            {
                return Err(invalid("Invalid execution status transition."));
            }
            item.status = status;
            item.reason = reason.map(|s| bounded(&s, 2000, "Status")).transpose()?;
            item.updated_at = ctx.time.into();
            ctx.work(&item)?;
            if item.status == WorkStatus::Failed {
                for child in ctx.all_work()? {
                    if child.parent_id.as_deref() == Some(&item.id) && child.status.active() {
                        work::invalidate_descendants(
                            ctx,
                            &child.id,
                            "The requesting task failed. Review prior effects before continuing.",
                            WorkStatus::Cancelled,
                        )?;
                    }
                }
                work::wake_waiters(ctx)?;
            }
            work::wake_waiters(ctx)?;
        }
        Command::AgentAction {
            id,
            generation,
            run_id,
            call_id,
            command,
        } => work::agent_command(ctx, &id, generation, &run_id, &call_id, command)?,
        Command::SaveFact {
            project_id,
            conversation_id,
            id,
            kind,
            text,
            source,
            supersedes_id,
        } => save_fact(
            ctx,
            Fact {
                id,
                project_id,
                kind,
                text,
                confidence: "confirmed".into(),
                status: "current".into(),
                conversation_id,
                run_id: None,
                source,
                supersedes_id,
                created_at: ctx.time.into(),
            },
            None,
        )?,
        Command::ChangeFact {
            id,
            project_id,
            status,
        } => {
            ctx.project_team(&project_id)?;
            if !["stale", "forgotten"].contains(&status.as_str()) {
                return Err(invalid("Invalid fact status."));
            }
            let mut fact: Fact =
                repo::get(ctx.conn, ctx.store, &ctx.scope.private, Kind::Fact, &id)?
                    .ok_or_else(|| invalid("This fact is unavailable."))?;
            if fact.project_id != project_id {
                return Err(invalid("This fact belongs to another project."));
            }
            fact.status = status;
            if fact.status == "forgotten" {
                fact.text.clear();
                fact.source.clear();
            }
            ctx.fact(&fact)?;
            bump_context(ctx, &project_id, None)?;
        }
        Command::SaveLayout { layout } => {
            validate_layout(ctx, &layout)?;
            ctx.put(Kind::Layout, "workspace", None, None, &layout)?;
        }
    }
    Ok(())
}

fn invalidate_room(ctx: &Context<'_>, room: &str, reason: &str) -> Result<()> {
    for item in ctx.all_work()? {
        if item.conversation_id == room && item.status.active() {
            work::invalidate_descendants(ctx, &item.id, reason, WorkStatus::AwaitingUser)?;
        }
    }
    Ok(())
}

fn invalidate_project(
    ctx: &Context<'_>,
    project: &str,
    except: Option<&str>,
    reason: &str,
) -> Result<()> {
    for mut item in ctx.all_work()? {
        if item.project_id.as_deref() == Some(project)
            && item.status.active()
            && except != Some(&item.id)
        {
            item.generation += 1;
            item.status = WorkStatus::AwaitingUser;
            item.reason = Some(reason.into());
            item.updated_at = ctx.time.into();
            ctx.work(&item)?;
        }
    }
    Ok(())
}

fn bump_context(ctx: &Context<'_>, project: &str, except: Option<&str>) -> Result<()> {
    let mut team = ctx.project_team(project)?;
    team.revision += 1;
    ctx.team(&team)?;
    invalidate_project(ctx, project, except, "Project decisions or facts changed. Read the current record before continuing; previous external effects may need reconciliation.")?;
    if let Some(key) = except {
        let mut item = ctx.item(key)?;
        item.context_revision = team.revision;
        ctx.work(&item)?;
    }
    Ok(())
}

pub(super) fn save_fact(ctx: &Context<'_>, mut fact: Fact, sender: Option<&str>) -> Result<()> {
    id(&fact.id)?;
    ctx.project_team(&fact.project_id)?;
    let room = ctx.room(&fact.conversation_id)?;
    if room.project_id.as_ref() != Some(&fact.project_id) {
        return Err(invalid(
            "A shared fact must originate in a conversation in this project.",
        ));
    }
    if !["fact", "decision"].contains(&fact.kind.as_str()) {
        return Err(invalid("Choose a fact or a decision."));
    }
    fact.text = bounded(&fact.text, 2000, "Fact or decision")?;
    fact.source = bounded(&fact.source, 1000, "Provenance")?;
    if let Some(existing) = repo::get::<Fact>(
        ctx.conn,
        ctx.store,
        &ctx.scope.private,
        Kind::Fact,
        &fact.id,
    )? {
        return if existing.text == fact.text
            && existing.project_id == fact.project_id
            && existing.confidence == fact.confidence
        {
            Ok(())
        } else {
            Err(invalid("This fact ID already belongs to another record."))
        };
    }
    if let Some(old_id) = &fact.supersedes_id {
        let mut old: Fact = repo::get(ctx.conn, ctx.store, &ctx.scope.private, Kind::Fact, old_id)?
            .ok_or_else(|| invalid("The superseded fact is unavailable."))?;
        if old.project_id != fact.project_id || old.status == "forgotten" {
            return Err(invalid(
                "This fact cannot supersede a forgotten or cross-project record.",
            ));
        }
        if sender.is_some() && old.confidence == "confirmed" {
            return Err(invalid(
                "An agent cannot supersede a user-confirmed fact. Ask the user to correct it.",
            ));
        }
        old.status = "superseded".into();
        ctx.fact(&old)?;
    }
    ctx.fact(&fact)?;
    if sender.is_none() || fact.supersedes_id.is_some() {
        bump_context(ctx, &fact.project_id, sender)?;
    }
    Ok(())
}

fn validate_layout(ctx: &Context<'_>, layout: &Layout) -> Result<()> {
    if layout.version != 2
        || layout.panes.is_empty()
        || layout.panes.len() > 8
        || layout.active_pane >= layout.panes.len()
        || layout.active.len() != layout.panes.len()
        || layout.views.len() > 40
        || layout.closed.len() > 20
    {
        return Err(invalid("This workspace layout is invalid."));
    }
    fn validate_node(
        node: &LayoutNode,
        depth: usize,
        count: usize,
        leaves: &mut HashSet<usize>,
    ) -> bool {
        if depth > 7 {
            return false;
        }
        match node {
            LayoutNode::Pane { pane } => *pane < count && leaves.insert(*pane),
            LayoutNode::Split {
                axis,
                ratio,
                children,
            } => {
                ["row", "column"].contains(&axis.as_str())
                    && ratio.is_finite()
                    && (0.2..=0.8).contains(ratio)
                    && children
                        .iter()
                        .all(|child| validate_node(child, depth + 1, count, leaves))
            }
        }
    }
    let mut leaves = HashSet::new();
    if !layout
        .tree
        .as_ref()
        .is_some_and(|tree| validate_node(tree, 0, layout.panes.len(), &mut leaves))
        || leaves.len() != layout.panes.len()
    {
        return Err(invalid("Each pane must appear exactly once in the grid."));
    }
    let mut ids = HashSet::new();
    for view in layout.views.iter().chain(&layout.closed) {
        id(&view.id)?;
        ctx.room(&view.conversation_id)?;
        if !["conversation", "artifact"].contains(&view.kind.as_str()) {
            return Err(invalid("Unsupported workspace view."));
        }
        if view.kind == "artifact" {
            bounded(
                view.output.as_deref().unwrap_or(""),
                32_000,
                "Artifact reference",
            )?;
            bounded(view.title.as_deref().unwrap_or(""), 160, "Artifact title")?;
            id(view.agent_id.as_deref().unwrap_or(""))?;
        }
    }
    for view in &layout.views {
        if !ids.insert(&view.id) {
            return Err(invalid("Duplicate view ID."));
        }
    }
    let pane_ids: Vec<_> = layout.panes.iter().flatten().collect();
    if pane_ids.len() != ids.len()
        || pane_ids.iter().collect::<HashSet<_>>().len() != ids.len()
        || pane_ids.iter().any(|key| !ids.contains(key))
    {
        return Err(invalid("Each open view must belong to exactly one pane."));
    }
    for (pane, active) in layout.panes.iter().zip(&layout.active) {
        if pane.is_empty() != active.is_none()
            || active.as_ref().is_some_and(|id| !pane.contains(id))
        {
            return Err(invalid("The active tab is not in its pane."));
        }
    }
    Ok(())
}
