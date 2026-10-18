use sha2::{Digest, Sha256};

use super::{
    collab, next_revision, project_from_row, repo, thread_is_owned, validate_id_store,
    AddProjectShare, AddProjectShareRequest, AuthorizedCommandScope, Kind, LocalProject,
    LocalProjectPayload, LocalProjectRow, ProjectShare, ProjectShareOwner,
    RemoveProjectShareRequest, Store, StoreError, Team, Work, MAX_NAME_CHARACTERS,
    MAX_REVISION_CHARACTERS, MAX_SHARES, MAX_SHARE_TEXT_CHARACTERS, MAX_SHARE_TITLE_CHARACTERS,
};
pub(super) fn add_share_at(
    tx: &rusqlite::Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    request: AddProjectShareRequest,
    now: &str,
) -> crate::store::Result<LocalProject> {
    validate_id_store(&request.project_id, "Project")?;
    let mut row = repo::get_project(tx, store, &scope.private, &request.project_id)?
        .ok_or_else(|| StoreError::Invalid("The local project was not found.".into()))?;
    if row.revision != request.expected_revision {
        return Err(StoreError::Invalid(
            "The local project changed. Refresh it before sharing.".into(),
        ));
    }
    if row.lifecycle != "active" {
        return Err(StoreError::Invalid(
            "An archived project cannot receive shares.".into(),
        ));
    }
    let mut payload: LocalProjectPayload = serde_json::from_value(row.payload.clone())
        .map_err(|_| StoreError::Invalid("The local project payload is invalid.".into()))?;
    let share = validate_share(tx, store, scope, &request.project_id, request.share, now)?;
    if let Some(existing) = payload.shares.iter().find(|item| item.id == share.id) {
        let same = existing.mode == share.mode
            && existing.source == share.source
            && existing.source_revision == share.source_revision
            && existing.recipient == share.recipient
            && existing.owner == share.owner
            && existing.title == share.title
            && existing.snapshot_text == share.snapshot_text;
        return if same {
            project_from_row(scope, row)
        } else {
            Err(StoreError::Invalid(
                "This share already exists with different content.".into(),
            ))
        };
    }
    if payload.shares.len() >= MAX_SHARES {
        return Err(StoreError::Invalid(
            "A project can hold at most 64 explicit shares.".into(),
        ));
    }
    payload.shares.push(share);
    row.revision = next_revision(row.revision)?;
    row.updated_at = now.into();
    row.payload = serde_json::to_value(payload)
        .map_err(|_| StoreError::Invalid("The project could not be encoded.".into()))?;
    repo::replace_project(tx, store, &scope.private, request.expected_revision, &row)?;
    project_from_row(scope, row)
}

#[allow(clippy::too_many_arguments)]
fn validate_share(
    tx: &rusqlite::Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    project_id: &str,
    share: AddProjectShare,
    now: &str,
) -> crate::store::Result<ProjectShare> {
    if !["snapshot", "live-reference"].contains(&share.mode.as_str()) {
        return Err(StoreError::Invalid(
            "Choose a snapshot or a live reference share.".into(),
        ));
    }
    if share.source.workspace_id != scope.data.workspace_id() {
        return Err(StoreError::Invalid(
            "A share source belongs to another workspace.".into(),
        ));
    }
    if ![
        "file",
        "work",
        "artifact",
        "conversation",
        "message",
        "memory",
    ]
    .contains(&share.source.kind.as_str())
    {
        return Err(StoreError::Invalid("Unsupported share source.".into()));
    }
    validate_id_store(&share.source.id, "Share source")?;
    let source_revision = share.source_revision.trim();
    if source_revision.is_empty() || source_revision.chars().count() > MAX_REVISION_CHARACTERS {
        return Err(StoreError::Invalid(
            "A share needs a source revision of 1-200 characters.".into(),
        ));
    }
    match share.recipient.kind.as_str() {
        "project" if share.recipient.id == project_id => {}
        "agent" => {
            validate_id_store(&share.recipient.id, "Share recipient")?;
            require_team_participant(tx, store, scope, project_id, &share.recipient.id)?;
        }
        _ => {
            return Err(StoreError::Invalid(
                "Choose this project or a current participant as the share recipient.".into(),
            ))
        }
    }
    if !["user", "agent"].contains(&share.owner.kind.as_str()) {
        return Err(StoreError::Invalid(
            "A share owner is the user or a participant agent.".into(),
        ));
    }
    let owner_name = share.owner.name.trim();
    if owner_name.is_empty() || owner_name.chars().count() > MAX_NAME_CHARACTERS {
        return Err(StoreError::Invalid(
            "The share owner needs a 1-120 character name.".into(),
        ));
    }
    if share.owner.kind == "agent" {
        let owner_id = share.owner.id.as_deref().ok_or_else(|| {
            StoreError::Invalid("An agent share owner needs its durable agent id.".into())
        })?;
        validate_id_store(owner_id, "Share owner agent")?;
        require_team_participant(tx, store, scope, project_id, owner_id)?;
    }
    let title = share.title.trim();
    if title.is_empty() || title.chars().count() > MAX_SHARE_TITLE_CHARACTERS {
        return Err(StoreError::Invalid(
            "A share needs a 1-200 character title.".into(),
        ));
    }
    let snapshot_text = match share.mode.as_str() {
        "snapshot" => {
            let text = share.snapshot_text.as_deref().map(str::trim).unwrap_or("");
            if text.is_empty() || text.chars().count() > MAX_SHARE_TEXT_CHARACTERS {
                return Err(StoreError::Invalid(
                    "A snapshot share needs 1-32000 characters of selected text.".into(),
                ));
            }
            Some(text.to_string())
        }
        _ => {
            if share
                .snapshot_text
                .as_deref()
                .is_some_and(|text| !text.trim().is_empty())
            {
                return Err(StoreError::Invalid(
                    "A live reference copies no source bytes; it resolves under the current account on each deliberate use.".into(),
                ));
            }
            None
        }
    };
    match share.source.kind.as_str() {
        "file" => require_owned_file(tx, scope, project_id, &share.source.id)?,
        "work" => {
            if collab::get::<Work>(tx, store, &scope.private, Kind::Work, &share.source.id)?
                .is_none()
            {
                return Err(StoreError::Invalid(
                    "The shared Work result is unavailable.".into(),
                ));
            }
        }
        "conversation" => {
            if !thread_is_owned(tx, scope, &share.source.id)? {
                return Err(StoreError::Invalid(
                    "The shared conversation is not owned by this private workspace.".into(),
                ));
            }
        }
        "message" => {
            let owned: bool = tx.query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM message m JOIN thread t ON t.id=m.thread_id
                     WHERE m.id=?1 AND m.workspace_id=?2 AND m.deleted_at IS NULL
                       AND t.owner_member_id IS ?3
                )",
                rusqlite::params![
                    share.source.id,
                    scope.private.workspace_id(),
                    scope.private.owner_member_id()
                ],
                |row| row.get(0),
            )?;
            if !owned {
                return Err(StoreError::Invalid(
                    "The shared message is not owned by this private workspace.".into(),
                ));
            }
        }
        _ => {}
    }
    let id = format!(
        "share-{:x}",
        Sha256::digest(
            format!(
                "{project_id}:{}:{}:{}:{}:{}",
                share.mode,
                share.source.kind,
                share.source.id,
                share.recipient.kind,
                share.recipient.id
            )
            .as_bytes()
        )
    );
    Ok(ProjectShare {
        id,
        mode: share.mode,
        source: share.source,
        source_revision: source_revision.into(),
        recipient: share.recipient,
        owner: ProjectShareOwner {
            kind: share.owner.kind,
            id: share.owner.id,
            name: owner_name.into(),
        },
        title: title.into(),
        snapshot_text,
        created_at: now.into(),
    })
}

fn require_team_participant(
    tx: &rusqlite::Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    project_id: &str,
    agent_id: &str,
) -> crate::store::Result<()> {
    let team = collab::get::<Team>(tx, store, &scope.private, Kind::Team, project_id)?;
    if team.is_some_and(|team| team.participant_ids.iter().any(|id| id == agent_id)) {
        return Ok(());
    }
    Err(StoreError::Invalid(
        "Choose a current project participant for this share.".into(),
    ))
}

fn require_owned_file(
    tx: &rusqlite::Connection,
    scope: &AuthorizedCommandScope,
    project_id: &str,
    source_id: &str,
) -> crate::store::Result<()> {
    let owned: bool = tx.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM knowledge_source
             WHERE workspace_id=?1 AND owner_subject=?2 AND id=?3
               AND disabled=0 AND (project_id IS NULL OR project_id=?4)
        )",
        rusqlite::params![
            scope.private.workspace_id(),
            scope.private.owner_subject(),
            source_id,
            project_id
        ],
        |row| row.get(0),
    )?;
    if owned {
        Ok(())
    } else {
        Err(StoreError::Invalid(
            "The shared file is unavailable or belongs to another owner.".into(),
        ))
    }
}

/// Resolve explicit shares at Work admission under the same transaction and
/// current membership. The returned bytes are evidence, never tool authority.
pub(crate) fn capture_shares(
    tx: &rusqlite::Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    project: &LocalProjectRow,
    agent_id: &str,
) -> crate::store::Result<Vec<serde_json::Value>> {
    use crate::store::repos::message;
    use serde_json::json;
    if project.lifecycle != "active"
        || require_team_participant(tx, store, scope, &project.id, agent_id).is_err()
    {
        return Ok(vec![]);
    }
    let payload: LocalProjectPayload = serde_json::from_value(project.payload.clone())
        .map_err(|_| StoreError::Invalid("Invalid Project context.".into()))?;
    let mut remaining = 32_000usize;
    let mut result = Vec::new();
    for share in payload.shares.iter().filter(|share| {
        share.source.workspace_id == scope.data.workspace_id()
            && ((share.recipient.kind == "project" && share.recipient.id == project.id)
                || (share.recipient.kind == "agent" && share.recipient.id == agent_id))
    }) {
        if remaining == 0 || result.len() == 12 {
            break;
        }
        let resolved = if share.mode == "snapshot" {
            share
                .snapshot_text
                .clone()
                .map(|text| (text, share.source_revision.clone()))
        } else {
            match share.source.kind.as_str() {
                "work" => {
                    collab::get::<Work>(tx, store, &scope.private, Kind::Work, &share.source.id)?
                        .and_then(|work| {
                            work.outputs
                                .last()
                                .map(|output| (output.text.clone(), output.run_id.clone()))
                        })
                }
                "conversation" if thread_is_owned(tx, scope, &share.source.id)? => {
                    let rows = message::list_selected(tx, store, &scope.data, &share.source.id)?;
                    let revision = rows
                        .last()
                        .map(|row| row.sequence.to_string())
                        .unwrap_or_default();
                    let mut texts: Vec<_> = rows
                        .iter()
                        .rev()
                        .filter(|row| {
                            row.current_revision_state == "terminal"
                                && matches!(row.kind.as_str(), "user" | "assistant")
                        })
                        .take(24)
                        .map(|row| {
                            format!(
                                "{}: {}",
                                row.kind,
                                row.content
                                    .as_str()
                                    .or_else(|| row
                                        .content
                                        .get("text")
                                        .and_then(serde_json::Value::as_str))
                                    .unwrap_or("")
                                    .chars()
                                    .take(1_000)
                                    .collect::<String>()
                            )
                        })
                        .collect();
                    texts.reverse();
                    Some((texts.join("\n"), revision))
                }
                "file" if require_owned_file(tx, scope, &project.id, &share.source.id).is_ok() => {
                    crate::store::repos::knowledge_source::get_shared_source(
                        tx,
                        store,
                        &scope.private,
                        &project.id,
                        &share.source.id,
                    )?
                    .map(|source| {
                        (
                            source.payload["contentPreview"]
                                .as_str()
                                .unwrap_or("")
                                .to_string(),
                            source.content_fingerprint,
                        )
                    })
                }
                _ => None,
            }
        };
        let (text, revision, available) = match resolved {
            Some((text, revision)) if !text.is_empty() => (text, revision, true),
            _ => (
                "This shared source is unavailable.".into(),
                share.source_revision.clone(),
                false,
            ),
        };
        let truncated = text.chars().count() > remaining.min(8_000);
        let text: String = text.chars().take(remaining.min(8_000)).collect();
        remaining -= text.chars().count();
        result.push(json!({"id":share.id,"mode":share.mode,"source":share.source,"sourceRevision":revision,"recipient":share.recipient,"available":available,"truncated":truncated,"text":text,"instructionAuthority":"none"}));
    }
    Ok(result)
}

pub(super) fn remove_share_at(
    tx: &rusqlite::Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    request: RemoveProjectShareRequest,
    now: &str,
) -> crate::store::Result<LocalProject> {
    validate_id_store(&request.project_id, "Project")?;
    validate_id_store(&request.share_id, "Share")?;
    let mut row = repo::get_project(tx, store, &scope.private, &request.project_id)?
        .ok_or_else(|| StoreError::Invalid("The local project was not found.".into()))?;
    if row.revision != request.expected_revision {
        return Err(StoreError::Invalid(
            "The local project changed. Refresh it before removing a share.".into(),
        ));
    }
    if row.lifecycle != "active" {
        return Err(StoreError::Invalid(
            "An archived project cannot change shares.".into(),
        ));
    }
    let mut payload: LocalProjectPayload = serde_json::from_value(row.payload.clone())
        .map_err(|_| StoreError::Invalid("The local project payload is invalid.".into()))?;
    let before = payload.shares.len();
    payload.shares.retain(|item| item.id != request.share_id);
    if payload.shares.len() == before {
        return project_from_row(scope, row);
    }
    row.revision = next_revision(row.revision)?;
    row.updated_at = now.into();
    row.payload = serde_json::to_value(payload)
        .map_err(|_| StoreError::Invalid("The project could not be encoded.".into()))?;
    repo::replace_project(tx, store, &scope.private, request.expected_revision, &row)?;
    project_from_row(scope, row)
}
