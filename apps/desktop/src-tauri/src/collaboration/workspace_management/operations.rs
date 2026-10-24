use super::*;

pub(super) fn apply_operation(
    ctx: &Context<'_>,
    item: &Work,
    operation: &WorkspaceOperation,
    expected_agent_revision: Option<u64>,
    snapshot: &mut RuntimeSnapshot,
    receipt_key: &str,
    arguments_digest: &str,
) -> Result<String, StoreError> {
    let time = ctx.time;
    match operation {
        WorkspaceOperation::Inspect => {
            Ok("Workspace roster and collaboration snapshot inspected.".into())
        }
        WorkspaceOperation::CreateAgent {
            name,
            instructions,
            model_agent_id,
        } => {
            let expected = expected_agent_revision
                .ok_or_else(|| invalid("Create-agent requires expectedAgentRevision."))?;
            if snapshot.agent_revision != expected {
                return Err(invalid(
                    "The agent roster changed. Reload before creating an agent.",
                ));
            }
            let name = bounded(name, MAX_NAME, "Agent name")?;
            let instructions = instructions.trim().to_string();
            if instructions.chars().count() > MAX_INSTRUCTIONS || instructions.contains('\0') {
                return Err(invalid(
                    "Agent instructions must be at most 8000 characters.",
                ));
            }
            let source = profile(
                &snapshot.agents,
                model_agent_id.as_deref().unwrap_or(&item.agent_id),
            )?;
            let (model_id, reasoning_effort, fast_mode) = (
                source.model_id.clone(),
                source.reasoning_effort.clone(),
                source.fast_mode,
            );
            let agent_id = digest_id("agent-chat", receipt_key);
            let mut agent = default_profile(agent_id, name, instructions, model_id);
            agent.reasoning_effort = reasoning_effort;
            agent.fast_mode = fast_mode;
            snapshot.agents.push(agent);
            snapshot.agent_revision = expected
                .checked_add(1)
                .ok_or_else(|| invalid("Agent roster revision overflowed."))?;
            save_receipt(
                ctx,
                item,
                receipt_key,
                operation.name(),
                "Created an agent profile.",
                arguments_digest,
            )?;
            Ok("Created an agent profile.".into())
        }
        WorkspaceOperation::UpdateAgent {
            agent_id: target,
            name,
            instructions,
            model_agent_id,
        } => {
            if name.is_none() && instructions.is_none() && model_agent_id.is_none() {
                return Err(invalid(
                    "Provide a name, instructions, or modelAgentId to update.",
                ));
            }
            let expected = expected_agent_revision
                .ok_or_else(|| invalid("Update-agent requires expectedAgentRevision."))?;
            if snapshot.agent_revision != expected {
                return Err(invalid(
                    "The agent roster changed. Reload before editing an agent.",
                ));
            }
            let index = snapshot
                .agents
                .iter()
                .position(|p| p.id == *target)
                .ok_or_else(|| invalid("That agent profile is unavailable."))?;
            let previous = snapshot.agents[index].clone();
            if let Some(name) = name.as_deref() {
                snapshot.agents[index].name = bounded(name, MAX_NAME, "Agent name")?;
            }
            if let Some(instructions) = instructions.as_deref() {
                let instructions = instructions.trim();
                if instructions.chars().count() > MAX_INSTRUCTIONS || instructions.contains('\0') {
                    return Err(invalid(
                        "Agent instructions must be at most 8000 characters.",
                    ));
                }
                snapshot.agents[index].instructions = instructions.into();
            }
            if let Some(source) = model_agent_id.as_deref() {
                let (model_id, reasoning_effort, fast_mode) = profile(&snapshot.agents, source)
                    .map(|p| (p.model_id.clone(), p.reasoning_effort.clone(), p.fast_mode))?;
                snapshot.agents[index].model_id = model_id;
                snapshot.agents[index].reasoning_effort = reasoning_effort;
                snapshot.agents[index].fast_mode = fast_mode;
            }
            if snapshot.agents[index] == previous {
                let summary = "Agent profile already matches the requested settings.";
                save_receipt(
                    ctx,
                    item,
                    receipt_key,
                    operation.name(),
                    summary,
                    arguments_digest,
                )?;
                return Ok(summary.into());
            }
            snapshot.agent_revision = expected
                .checked_add(1)
                .ok_or_else(|| invalid("Agent roster revision overflowed."))?;
            let updated_profiles = snapshot.agents.clone();
            let team_ctx = Context {
                conn: ctx.conn,
                store: ctx.store,
                scope: ctx.scope,
                profiles: &updated_profiles,
                time: ctx.time,
            };
            // Freeze active direct work whose prompt/model no longer matches
            // the saved profile, including a self-edit after its receipt commits.
            if previous.instructions != snapshot.agents[index].instructions
                || previous.model_id != snapshot.agents[index].model_id
                || previous.reasoning_effort != snapshot.agents[index].reasoning_effort
                || previous.fast_mode != snapshot.agents[index].fast_mode
            {
                for mut work in ctx
                    .all_work()?
                    .into_iter()
                    .filter(|work| work.agent_id == *target && work.status.active())
                {
                    work.generation += 1;
                    work.status = crate::collaboration::models::WorkStatus::AwaitingUser;
                    work.reason = Some(
                        "Agent settings changed. Review prior results before continuing.".into(),
                    );
                    work.updated_at = ctx.time.into();
                    ctx.work(&work)?;
                }
            }
            // Team participant names are denormalized. Re-apply each affected
            // team through the existing invalidating command so old work is
            // parked for review rather than silently continuing with stale context.
            let teams: Vec<Team> = repo::list(ctx.conn, ctx.store, &ctx.scope.private, Kind::Team)?;
            for team in teams
                .into_iter()
                .filter(|team| team.participant_ids.iter().any(|id| id == target))
            {
                commands::apply(
                    &team_ctx,
                    crate::collaboration::models::Command::UpdateTeam {
                        project_id: team.project_id,
                        expected_revision: team.revision,
                        lead_agent_id: team.lead_agent_id,
                        participant_ids: team.participant_ids,
                        share_history: true,
                    },
                )?;
            }
            save_receipt(
                ctx,
                item,
                receipt_key,
                operation.name(),
                "Updated an agent profile.",
                arguments_digest,
            )?;
            Ok("Updated an agent profile.".into())
        }
        WorkspaceOperation::DeleteAgent { agent_id: target } => {
            let expected = expected_agent_revision
                .ok_or_else(|| invalid("Delete-agent requires expectedAgentRevision."))?;
            if snapshot.agent_revision != expected {
                return Err(invalid(
                    "The agent roster changed. Reload before deleting an agent.",
                ));
            }
            if target == &item.agent_id {
                return Err(invalid(
                    "The executing agent cannot delete itself during an active turn.",
                ));
            }
            profile(&snapshot.agents, target)?;
            if snapshot.agents.len() <= 1 {
                return Err(invalid("Mivlet must keep at least one agent."));
            }
            if ctx
                .all_work()?
                .into_iter()
                .any(|work| work.agent_id == *target && work.status.active())
            {
                return Err(invalid(
                    "Stop or reassign this agent's active work before deleting it.",
                ));
            }
            if crate::store::repos::local_schedule::list_schedules(
                ctx.conn,
                ctx.store,
                &ctx.scope.private,
                256,
            )?
            .into_iter()
            .any(|schedule| schedule.agent_id == *target)
            {
                return Err(invalid(
                    "Remove or reassign this agent's schedules before deleting it.",
                ));
            }
            let teams: Vec<Team> = repo::list(ctx.conn, ctx.store, &ctx.scope.private, Kind::Team)?;
            for team in teams
                .into_iter()
                .filter(|team| team.participant_ids.iter().any(|id| id == target))
            {
                if team.lead_agent_id.as_deref() == Some(target.as_str()) {
                    return Err(invalid(
                        "Choose another project lead before deleting this agent.",
                    ));
                }
                if team.participant_ids.len() <= 1 {
                    return Err(invalid(
                        "Remove the agent from its project team before deleting it.",
                    ));
                }
                let ids: Vec<String> = team
                    .participant_ids
                    .into_iter()
                    .filter(|id| id != target)
                    .collect();
                let lead = team.lead_agent_id.filter(|lead| lead != target);
                commands::apply(
                    ctx,
                    crate::collaboration::models::Command::UpdateTeam {
                        project_id: team.project_id,
                        expected_revision: team.revision,
                        lead_agent_id: lead,
                        participant_ids: ids,
                        share_history: true,
                    },
                )?;
            }
            snapshot.agents.retain(|agent| agent.id != *target);
            snapshot.active_agent_id = snapshot.active_agent_id.clone().filter(|id| id != target);
            snapshot.agent_revision = expected
                .checked_add(1)
                .ok_or_else(|| invalid("Agent roster revision overflowed."))?;
            save_receipt(
                ctx,
                item,
                receipt_key,
                operation.name(),
                "Deleted the agent profile and preserved its history.",
                arguments_digest,
            )?;
            Ok("Deleted the agent profile and preserved its history.".into())
        }
        WorkspaceOperation::CreateProject {
            name,
            instructions,
            participant_ids: ids,
            lead_agent_id,
        } => {
            let name = bounded(name, MAX_NAME, "Project name")?;
            let instructions = instructions.trim();
            if instructions.chars().count() > MAX_INSTRUCTIONS || instructions.contains('\0') {
                return Err(invalid(
                    "Project instructions must be at most 8000 characters.",
                ));
            }
            let ids = ids.clone();
            let members = participants(&snapshot.agents, &ids, lead_agent_id.as_deref())?;
            let project_id = digest_id("project-chat", receipt_key);
            let thread_id = format!("{project_id}-thread");
            let project = local_projects::create_project_at(
                ctx.conn,
                ctx.store,
                ctx.scope,
                CreateLocalProjectRequest {
                    workspace_id: ctx.scope.data.workspace_id().into(),
                    id: project_id.clone(),
                    thread_id,
                    name,
                    instructions: instructions.to_string(),
                    knowledge_source_ids: vec![],
                    participant_ids: None,
                    lead_agent_id: None,
                },
                time,
                None,
            )?;
            let team = Team {
                project_id: project.id.clone(),
                lead_agent_id: lead_agent_id.clone(),
                participant_ids: ids,
                revision: 1,
            };
            ctx.team(&team)?;
            project_conversation(ctx, &project, members, team.lead_agent_id.clone(), time)?;
            save_receipt(
                ctx,
                item,
                receipt_key,
                operation.name(),
                "Created a project and team.",
                arguments_digest,
            )?;
            Ok("Created a project and team.".into())
        }
        WorkspaceOperation::UpdateTeam {
            project_id,
            expected_revision,
            participant_ids,
            lead_agent_id,
            share_history,
        } => {
            commands::apply(
                ctx,
                crate::collaboration::models::Command::UpdateTeam {
                    project_id: project_id.clone(),
                    expected_revision: *expected_revision,
                    lead_agent_id: lead_agent_id.clone(),
                    participant_ids: participant_ids.clone(),
                    share_history: *share_history,
                },
            )?;
            save_receipt(
                ctx,
                item,
                receipt_key,
                operation.name(),
                "Updated the project team.",
                arguments_digest,
            )?;
            Ok("Updated the project team.".into())
        }
    }
}
