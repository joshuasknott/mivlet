use super::{
    author_from_row, collab, execution_attempt, next_revision, project_from_row, repo, thread,
    thread_is_owned, validate_id_store, validate_payload_store, ArchiveLocalProjectRequest,
    AuthorizedCommandScope, BindLocalProjectRunAuthorRequest, ChatBinding, Conversation,
    CreateLocalProjectRequest, Kind, LocalProject, LocalProjectPayload, LocalProjectRow,
    LocalProjectRunAuthor, LocalProjectRunAuthorRow, MivletAgentProfile, Participant,
    RunAuthorPayload, Store, StoreError, Team, UpdateLocalProjectRequest, MAX_ID_CHARACTERS,
    MAX_NAME_CHARACTERS, MAX_PROJECTS,
};
pub(crate) fn create_at(
    tx: &rusqlite::Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    request: CreateLocalProjectRequest,
    now: &str,
    profiles: Option<&[MivletAgentProfile]>,
) -> crate::store::Result<LocalProject> {
    validate_id_store(&request.id, "Project")?;
    validate_id_store(&request.thread_id, "Project thread")?;
    let payload = validate_payload_store(
        tx,
        scope,
        request.name,
        request.instructions,
        request.knowledge_source_ids,
        Vec::new(),
    )?;
    let project_name = payload.name.clone();
    let count: i64 = tx.query_row(
        "SELECT COUNT(*) FROM local_project WHERE workspace_id=?1 AND owner_subject=?2",
        rusqlite::params![scope.private.workspace_id(), scope.private.owner_subject()],
        |row| row.get(0),
    )?;
    if count >= MAX_PROJECTS {
        return Err(StoreError::Invalid(
            "This workspace has reached its local project limit.".into(),
        ));
    }
    let team = match request.participant_ids.as_ref() {
        None => {
            if request.lead_agent_id.is_some() {
                return Err(StoreError::Invalid(
                    "A project lead requires an initial project team.".into(),
                ));
            }
            None
        }
        Some(participant_ids) => {
            if participant_ids.is_empty()
                || participant_ids.len() > 8
                || participant_ids
                    .iter()
                    .any(|id| id.is_empty() || id.len() > MAX_ID_CHARACTERS)
            {
                return Err(StoreError::Invalid(
                    "A project team needs one to eight valid agents.".into(),
                ));
            }
            let mut seen = std::collections::HashSet::new();
            let mut members = Vec::with_capacity(participant_ids.len());
            for agent_id in participant_ids {
                if !seen.insert(agent_id) {
                    return Err(StoreError::Invalid(
                        "A project team cannot contain the same agent twice.".into(),
                    ));
                }
                if !agent_id
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '-'))
                {
                    return Err(StoreError::Invalid(
                        "A project team contains an invalid agent id.".into(),
                    ));
                }
                let name = profiles
                    .and_then(|profiles| profiles.iter().find(|profile| profile.id == *agent_id))
                    .ok_or_else(|| {
                        StoreError::Invalid(
                            "A project team contains an agent that is unavailable in this workspace."
                                .into(),
                        )
                    })?
                    .name
                    .clone();
                members.push(Participant {
                    agent_id: agent_id.clone(),
                    name,
                });
            }
            if let Some(lead) = request.lead_agent_id.as_deref() {
                if !participant_ids.iter().any(|id| id == lead) {
                    return Err(StoreError::Invalid(
                        "The project lead must be one of its participants.".into(),
                    ));
                }
            }
            Some((members, request.lead_agent_id.clone()))
        }
    };

    thread::create(
        tx,
        store,
        &scope.data,
        &request.thread_id,
        None,
        &payload.name,
        now,
        &serde_json::json!({
            "authorityScope": {
                "authority": "local",
                "visibility": "member-private",
                "ownerMemberId": scope.private.owner_member_id()
            }
        }),
    )?;
    let claimed = tx.execute(
        "UPDATE thread SET owner_member_id=?1
          WHERE workspace_id=?2 AND id=?3 AND owner_member_id IS NULL",
        rusqlite::params![
            scope.private.owner_member_id(),
            scope.data.workspace_id(),
            request.thread_id
        ],
    )?;
    if claimed != 1 {
        return Err(StoreError::Invalid(
            "Project conversation ownership could not be established.".into(),
        ));
    }
    let row = LocalProjectRow {
        id: request.id,
        lifecycle: "active".into(),
        revision: 1,
        thread_id: request.thread_id,
        created_at: now.into(),
        updated_at: now.into(),
        archived_at: None,
        payload: serde_json::to_value(payload)
            .map_err(|_| StoreError::Invalid("The project could not be encoded.".into()))?,
    };
    repo::insert_project(tx, store, &scope.private, &row)?;
    if let Some((members, lead_agent_id)) = team {
        let team = Team {
            project_id: row.id.clone(),
            lead_agent_id: lead_agent_id.clone(),
            participant_ids: members
                .iter()
                .map(|member| member.agent_id.clone())
                .collect(),
            revision: 1,
        };
        collab::put(
            tx,
            store,
            &scope.private,
            Kind::Team,
            &team.project_id,
            None,
            Some(&team.project_id),
            &team,
        )?;
        collab::put(
            tx,
            store,
            &scope.private,
            Kind::Conversation,
            &row.thread_id,
            Some(&row.thread_id),
            Some(&row.id),
            &Conversation {
                archived: false,
                chat: Some(ChatBinding {
                    role: "main".into(),
                    owner_kind: "project".into(),
                    owner_id: row.id.clone(),
                }),
                id: row.thread_id.clone(),
                workspace_id: scope.data.workspace_id().into(),
                kind: "group".into(),
                title: project_name,
                project_id: Some(row.id.clone()),
                facilitator_id: lead_agent_id,
                participants: members,
                revision: 1,
                generation: 1,
                created_at: now.into(),
                updated_at: now.into(),
            },
        )?;
    }
    project_from_row(scope, row)
}

pub(super) fn update_at(
    tx: &rusqlite::Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    request: UpdateLocalProjectRequest,
    now: &str,
) -> crate::store::Result<LocalProject> {
    validate_id_store(&request.id, "Project")?;
    let mut row = repo::get_project(tx, store, &scope.private, &request.id)?
        .ok_or_else(|| StoreError::Invalid("The local project was not found.".into()))?;
    if row.revision != request.expected_revision {
        return Err(StoreError::Invalid(
            "The local project changed. Refresh it before editing.".into(),
        ));
    }
    if row.lifecycle != "active" {
        return Err(StoreError::Invalid(
            "An archived project cannot be edited.".into(),
        ));
    }
    if !thread_is_owned(tx, scope, &row.thread_id)? {
        return Err(StoreError::Invalid(
            "The project conversation is not owned by this private workspace.".into(),
        ));
    }
    let payload: LocalProjectPayload = serde_json::from_value(row.payload.clone())
        .map_err(|_| StoreError::Invalid("The local project payload is invalid.".into()))?;
    let payload = validate_payload_store(
        tx,
        scope,
        request.name,
        request.instructions,
        request.knowledge_source_ids,
        payload.shares,
    )?;
    thread::update(
        tx,
        store,
        &scope.data,
        &row.thread_id,
        Some(&payload.name),
        None,
        None,
        now,
    )?;
    row.revision = next_revision(row.revision)?;
    row.updated_at = now.into();
    row.payload = serde_json::to_value(payload)
        .map_err(|_| StoreError::Invalid("The project could not be encoded.".into()))?;
    repo::replace_project(tx, store, &scope.private, request.expected_revision, &row)?;
    crate::collaboration::project_changed(tx, store, scope, &row.id, now, false)?;
    project_from_row(scope, row)
}

pub(super) fn archive_at(
    tx: &rusqlite::Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    request: ArchiveLocalProjectRequest,
    now: &str,
) -> crate::store::Result<LocalProject> {
    validate_id_store(&request.id, "Project")?;
    let mut row = repo::get_project(tx, store, &scope.private, &request.id)?
        .ok_or_else(|| StoreError::Invalid("The local project was not found.".into()))?;
    if row.revision != request.expected_revision {
        return Err(StoreError::Invalid(
            "The local project changed. Refresh it before archiving.".into(),
        ));
    }
    if row.lifecycle == "archived" {
        return project_from_row(scope, row);
    }
    if !thread_is_owned(tx, scope, &row.thread_id)? {
        return Err(StoreError::Invalid(
            "The project conversation is not owned by this private workspace.".into(),
        ));
    }
    thread::update(
        tx,
        store,
        &scope.data,
        &row.thread_id,
        None,
        Some("archived"),
        None,
        now,
    )?;
    row.lifecycle = "archived".into();
    row.revision = next_revision(row.revision)?;
    row.updated_at = now.into();
    row.archived_at = Some(now.into());
    repo::replace_project(tx, store, &scope.private, request.expected_revision, &row)?;
    crate::collaboration::project_changed(tx, store, scope, &row.id, now, true)?;
    project_from_row(scope, row)
}

pub(super) fn bind_author_at(
    tx: &rusqlite::Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    request: BindLocalProjectRunAuthorRequest,
    agent_name: &str,
    now: &str,
) -> crate::store::Result<LocalProjectRunAuthor> {
    validate_id_store(&request.project_id, "Project")?;
    validate_id_store(&request.run_id, "Run")?;
    validate_id_store(&request.agent_id, "Agent")?;
    validate_id_store(&request.thread_id, "Project thread")?;
    if agent_name.trim().is_empty() || agent_name.chars().count() > MAX_NAME_CHARACTERS {
        return Err(StoreError::Invalid(
            "The persisted agent name is invalid.".into(),
        ));
    }
    let project = repo::get_project(tx, store, &scope.private, &request.project_id)?
        .ok_or_else(|| StoreError::Invalid("The local project was not found.".into()))?;
    if project.revision != request.expected_revision || project.lifecycle != "active" {
        return Err(StoreError::Invalid(
            "The local project changed or was archived before work could start.".into(),
        ));
    }
    if project.thread_id != request.thread_id {
        return Err(StoreError::Invalid(
            "The run does not belong to this project's conversation.".into(),
        ));
    }
    let project_payload: LocalProjectPayload = serde_json::from_value(project.payload.clone())
        .map_err(|_| StoreError::Invalid("The local project payload is invalid.".into()))?;
    // Sources can be removed or disabled after the project was edited. Recheck
    // them at the pre-run bind so stale references cannot silently enter work.
    validate_payload_store(
        tx,
        scope,
        project_payload.name,
        project_payload.instructions,
        project_payload.knowledge_source_ids,
        project_payload.shares,
    )?;
    let payload = serde_json::to_value(RunAuthorPayload {
        agent_name: agent_name.trim().into(),
    })
    .map_err(|_| StoreError::Invalid("The project run author could not be encoded.".into()))?;
    let proposed = LocalProjectRunAuthorRow {
        project_id: request.project_id,
        run_id: request.run_id,
        agent_id: request.agent_id,
        thread_id: request.thread_id,
        created_at: now.into(),
        payload,
    };
    if let Some(existing) = repo::get_run_author(tx, store, &scope.private, &proposed.run_id)? {
        if existing.project_id == proposed.project_id
            && existing.agent_id == proposed.agent_id
            && existing.thread_id == proposed.thread_id
            && existing.payload == proposed.payload
        {
            return author_from_row(existing);
        }
        return Err(StoreError::Invalid(
            "This run already has a different immutable project author.".into(),
        ));
    }
    let attempt = execution_attempt::get_scoped(tx, store, &scope.data, &proposed.run_id)?
        .ok_or_else(|| StoreError::Invalid("The queued project run was not found.".into()))?;
    if attempt.status != "queued" || attempt.thread_id.as_deref() != Some(&proposed.thread_id) {
        return Err(StoreError::Invalid(
            "Project authorship requires the exact queued run in this conversation.".into(),
        ));
    }
    if !thread_is_owned(tx, scope, &proposed.thread_id)? {
        return Err(StoreError::Invalid(
            "The project conversation is not owned by this private workspace.".into(),
        ));
    }
    repo::insert_run_author(tx, store, &scope.private, &proposed)?;
    author_from_row(proposed)
}
