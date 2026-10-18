use super::{
    collab, project_from_row, repo, thread, thread_is_owned, validate_id_store,
    validate_payload_store, Author, AuthorizedCommandScope, ChatBinding, Conversation, Kind,
    LocalProject, LocalProjectRow, MigrateLegacyGroupRequest, MivletAgentProfile, Participant,
    Store, StoreError, Team,
};
pub(super) fn migrate_group_at(
    tx: &rusqlite::Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    profiles: &[MivletAgentProfile],
    request: MigrateLegacyGroupRequest,
    now: &str,
) -> crate::store::Result<LocalProject> {
    if !request.share_history {
        return Err(StoreError::Invalid(
            "Confirm sharing the existing history before converting this group.".into(),
        ));
    }
    validate_id_store(&request.id, "Project")?;
    validate_id_store(&request.conversation_id, "Conversation")?;
    let mut room: Conversation = collab::get(
        tx,
        store,
        &scope.private,
        Kind::Conversation,
        &request.conversation_id,
    )?
    .ok_or_else(|| StoreError::Invalid("This legacy group conversation is unavailable.".into()))?;
    if room.kind != "group" || room.project_id.is_some() {
        return Err(StoreError::Invalid(
            "Only a standalone group can be converted to a project.".into(),
        ));
    }
    if room.revision != request.expected_revision {
        return Err(StoreError::Invalid(
            "This conversation changed. Reload it before converting.".into(),
        ));
    }
    if !thread_is_owned(tx, scope, &request.conversation_id)? {
        return Err(StoreError::Invalid(
            "The legacy group is not owned by this private workspace.".into(),
        ));
    }
    let already: bool = tx.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM local_project
             WHERE workspace_id=?1 AND owner_subject=?2 AND (id=?3 OR thread_id=?4)
        )",
        rusqlite::params![
            scope.private.workspace_id(),
            scope.private.owner_subject(),
            request.id,
            request.conversation_id
        ],
        |row| row.get(0),
    )?;
    if already {
        return Err(StoreError::Invalid(
            "This group or project was already converted. Reload the workspace.".into(),
        ));
    }
    let members = validated_participants(
        profiles,
        &request.participant_ids,
        request.lead_agent_id.as_deref(),
    )?;
    let payload = validate_payload_store(
        tx,
        scope,
        request.name,
        request.instructions,
        Vec::new(),
        Vec::new(),
    )?;
    let row = LocalProjectRow {
        id: request.id.clone(),
        lifecycle: "active".into(),
        revision: 1,
        thread_id: request.conversation_id.clone(),
        created_at: now.into(),
        updated_at: now.into(),
        archived_at: None,
        payload: serde_json::to_value(&payload)
            .map_err(|_| StoreError::Invalid("The project could not be encoded.".into()))?,
    };
    repo::insert_project(tx, store, &scope.private, &row)?;
    let team = Team {
        project_id: request.id.clone(),
        lead_agent_id: request.lead_agent_id.clone(),
        participant_ids: request.participant_ids.clone(),
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
    room.title = payload.name.clone();
    room.project_id = Some(request.id.clone());
    room.chat = Some(ChatBinding {
        role: "main".into(),
        owner_kind: "project".into(),
        owner_id: request.id.clone(),
    });
    room.kind = "group".into();
    room.participants = members;
    room.facilitator_id = request.lead_agent_id.clone();
    room.revision = room
        .revision
        .checked_add(1)
        .ok_or_else(|| StoreError::Invalid("The conversation revision overflowed.".into()))?;
    room.generation = room.generation.saturating_add(1);
    room.updated_at = now.into();
    collab::put(
        tx,
        store,
        &scope.private,
        Kind::Conversation,
        &room.id,
        Some(&room.id),
        Some(&request.id),
        &room,
    )?;
    thread::update(
        tx,
        store,
        &scope.data,
        &room.id,
        Some(&payload.name),
        None,
        None,
        now,
    )?;
    backfill_thread_authors(tx, store, scope, &request.id, &room.id, profiles)?;
    project_from_row(scope, row)
}

fn validated_participants(
    profiles: &[MivletAgentProfile],
    ids: &[String],
    lead: Option<&str>,
) -> crate::store::Result<Vec<Participant>> {
    if ids.is_empty() || ids.len() > 8 || lead.is_some_and(|lead| !ids.iter().any(|id| id == lead))
    {
        return Err(StoreError::Invalid(
            "Choose one to eight participants. A coordinator, when designated, must be one of them."
                .into(),
        ));
    }
    let mut seen = std::collections::HashSet::new();
    ids.iter()
        .map(|agent_id| {
            if !seen.insert(agent_id) {
                return Err(StoreError::Invalid(
                    "Each participant can be included only once.".into(),
                ));
            }
            let profile = profiles
                .iter()
                .find(|profile| &profile.id == agent_id)
                .ok_or_else(|| {
                    StoreError::Invalid("Choose a current persisted agent as a participant.".into())
                })?;
            Ok(Participant {
                agent_id: profile.id.clone(),
                name: profile.name.clone(),
            })
        })
        .collect()
}

/// Attribution backfill uses recorded evidence only: an existing project author
/// ledger, a unique model-route match or a sole participant. Otherwise the run
/// stays explicitly unattributed rather than invented.
pub(crate) fn backfill_thread_authors(
    tx: &rusqlite::Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    project_id: &str,
    room_id: &str,
    profiles: &[MivletAgentProfile],
) -> crate::store::Result<usize> {
    let runs: Vec<(String, String, String)> = {
        let mut statement = tx.prepare(
            "SELECT id,provider_id,model FROM run
              WHERE workspace_id=?1 AND thread_id=?2 ORDER BY created_at,id",
        )?;
        let rows = statement
            .query_map(
                rusqlite::params![scope.data.workspace_id(), room_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    };
    let mut created = 0;
    for (run_id, provider_id, model) in runs {
        if collab::get::<Author>(tx, store, &scope.private, Kind::Author, &run_id)?.is_some() {
            continue;
        }
        let attributed = repo::get_run_author(tx, store, &scope.private, &run_id)?
            .and_then(|row| {
                let name = row
                    .payload
                    .get("agentName")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                profiles
                    .iter()
                    .find(|profile| profile.id == row.agent_id)
                    .map(|profile| (profile.id.clone(), profile.name.clone()))
                    .or_else(|| {
                        Some((
                            row.agent_id,
                            if name.is_empty() {
                                "Historical teammate".into()
                            } else {
                                name.to_string()
                            },
                        ))
                    })
            })
            .or_else(|| {
                let route = format!("{provider_id}::{model}");
                let matches: Vec<_> = profiles
                    .iter()
                    .filter(|profile| profile.model_id == route || profile.model_id == model)
                    .collect();
                (matches.len() == 1).then(|| (matches[0].id.clone(), matches[0].name.clone()))
            })
            .or_else(|| {
                (profiles.len() == 1).then(|| (profiles[0].id.clone(), profiles[0].name.clone()))
            });
        let author = match attributed {
            Some((agent_id, name)) => Author {
                run_id: run_id.clone(),
                conversation_id: room_id.into(),
                agent_id,
                name,
                work_id: None,
                generation: 0,
            },
            None => Author {
                run_id: run_id.clone(),
                conversation_id: room_id.into(),
                agent_id: "historical".into(),
                name: "Historical teammate (attribution unavailable)".into(),
                work_id: None,
                generation: 0,
            },
        };
        collab::put(
            tx,
            store,
            &scope.private,
            Kind::Author,
            &run_id,
            Some(room_id),
            Some(project_id),
            &author,
        )?;
        created += 1;
    }
    Ok(created)
}
