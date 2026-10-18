use chrono::{SecondsFormat, Utc};

use super::{
    AuthorizedCommandScope, LocalProject, LocalProjectPayload, LocalProjectRow,
    LocalProjectRunAuthor, LocalProjectRunAuthorRow, ProjectShare, RunAuthorPayload, Store,
    StoreError, MAX_ID_CHARACTERS, MAX_INSTRUCTIONS_CHARACTERS, MAX_KNOWLEDGE_SOURCES,
    MAX_NAME_CHARACTERS,
};
pub(super) fn validate_payload_store(
    tx: &rusqlite::Connection,
    scope: &AuthorizedCommandScope,
    name: String,
    instructions: String,
    knowledge_source_ids: Vec<String>,
    shares: Vec<ProjectShare>,
) -> crate::store::Result<LocalProjectPayload> {
    let name = name.trim().to_string();
    let instructions = instructions.trim().to_string();
    if name.is_empty() || name.chars().count() > MAX_NAME_CHARACTERS {
        return Err(StoreError::Invalid(
            "Project name must be 1-120 characters.".into(),
        ));
    }
    if instructions.chars().count() > MAX_INSTRUCTIONS_CHARACTERS {
        return Err(StoreError::Invalid(
            "Project instructions must be at most 12000 characters.".into(),
        ));
    }
    if knowledge_source_ids.len() > MAX_KNOWLEDGE_SOURCES {
        return Err(StoreError::Invalid(
            "A project can reference at most 64 knowledge sources.".into(),
        ));
    }
    let mut source_ids = Vec::with_capacity(knowledge_source_ids.len());
    for id in knowledge_source_ids {
        validate_id_store(&id, "Knowledge source")?;
        if source_ids.contains(&id) {
            continue;
        }
        let owned: bool = tx.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM knowledge_source
                 WHERE workspace_id=?1 AND owner_subject=?2 AND id=?3
                   AND project_id IS NULL AND authority='local'
                   AND visibility='member-private' AND disabled=0
            )",
            rusqlite::params![
                scope.private.workspace_id(),
                scope.private.owner_subject(),
                id
            ],
            |row| row.get(0),
        )?;
        if !owned {
            return Err(StoreError::Invalid(
                "A referenced knowledge source is unavailable or belongs to another owner.".into(),
            ));
        }
        source_ids.push(id);
    }
    Ok(LocalProjectPayload {
        name,
        instructions,
        knowledge_source_ids: source_ids,
        shares,
    })
}

pub(super) fn project_from_row(
    scope: &AuthorizedCommandScope,
    row: LocalProjectRow,
) -> crate::store::Result<LocalProject> {
    let payload: LocalProjectPayload = serde_json::from_value(row.payload)
        .map_err(|_| StoreError::Invalid("The local project payload is invalid.".into()))?;
    Ok(LocalProject {
        id: row.id,
        workspace_id: scope.data.workspace_id().into(),
        name: payload.name,
        instructions: payload.instructions,
        knowledge_source_ids: payload.knowledge_source_ids,
        shares: payload.shares,
        thread_id: row.thread_id,
        revision: row.revision,
        created_at: row.created_at,
        updated_at: row.updated_at,
        archived_at: row.archived_at,
    })
}

pub(super) fn author_from_row(
    row: LocalProjectRunAuthorRow,
) -> crate::store::Result<LocalProjectRunAuthor> {
    let payload: RunAuthorPayload = serde_json::from_value(row.payload)
        .map_err(|_| StoreError::Invalid("The project run author payload is invalid.".into()))?;
    Ok(LocalProjectRunAuthor {
        project_id: row.project_id,
        run_id: row.run_id,
        agent_id: row.agent_id,
        agent_name: payload.agent_name,
        thread_id: row.thread_id,
        created_at: row.created_at,
    })
}

pub(super) fn thread_is_owned(
    tx: &rusqlite::Connection,
    scope: &AuthorizedCommandScope,
    thread_id: &str,
) -> crate::store::Result<bool> {
    tx.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM thread
             WHERE workspace_id=?1 AND id=?2 AND deleted_at IS NULL
               AND authority='local' AND visibility='member-private'
               AND owner_member_id IS ?3
        )",
        rusqlite::params![
            scope.private.workspace_id(),
            thread_id,
            scope.private.owner_member_id()
        ],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

pub(super) fn next_revision(revision: i64) -> crate::store::Result<i64> {
    revision
        .checked_add(1)
        .ok_or_else(|| StoreError::Invalid("The project revision overflowed.".into()))
}

pub(super) fn validate_id(value: &str, label: &str) -> Result<(), String> {
    validate_id_store(value, label).map_err(|error| error.to_string())
}

pub(super) fn validate_id_store(value: &str, label: &str) -> crate::store::Result<()> {
    let valid = !value.is_empty()
        && value.len() <= MAX_ID_CHARACTERS
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '-'));
    if valid {
        Ok(())
    } else {
        Err(StoreError::Invalid(format!(
            "{label} id must be 1-{MAX_ID_CHARACTERS} URL-safe characters."
        )))
    }
}

pub(super) fn require_main_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Manage local projects from the Mivlet window.".into())
    }
}

pub(super) fn global_store() -> Result<&'static Store, String> {
    crate::store::try_global()
        .ok_or_else(|| "Mivlet's encrypted store is not initialized.".to_string())
}

pub(super) fn timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
