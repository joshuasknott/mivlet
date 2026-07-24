//! Account-authorized, member-private project lifecycle repository.

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::store::repos::{
    open_json,
    scope::{normalize_id, DataScope},
    seal_json,
};
use crate::store::{Result, Store, StoreError};

const TITLE_MAX: usize = 200;
const DESCRIPTION_MAX: usize = 4_000;
const INSTRUCTIONS_MAX: usize = 32_000;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectContent {
    title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    instructions: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    created_by_device_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRow {
    pub id: String,
    pub workspace_id: String,
    pub authority: String,
    pub visibility: String,
    pub owner_member_id: String,
    pub schema_version: i64,
    pub revision: i64,
    pub created_by_internal_user_id: String,
    pub created_at: String,
    pub updated_at: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    pub lifecycle: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SharedProjectMirror {
    pub id: String,
    pub workspace_id: String,
    pub revision: i64,
    pub created_by_internal_user_id: String,
    pub created_by_device_id: String,
    pub created_at: String,
    pub updated_at: String,
    pub title: String,
    pub description: Option<String>,
    pub instructions: Option<String>,
}

fn aad(id: &str) -> String {
    format!("project:{id}")
}

fn normalize_required(value: &str, label: &str, max: usize) -> Result<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max || value.chars().any(char::is_control) {
        return Err(StoreError::Invalid(format!(
            "Project {label} must be between 1 and {max} characters."
        )));
    }
    Ok(value.to_string())
}

fn normalize_optional(value: Option<&str>, label: &str, max: usize) -> Result<Option<String>> {
    value
        .map(|value| {
            let value = value.trim();
            if value.chars().count() > max || value.chars().any(char::is_control) {
                return Err(StoreError::Invalid(format!(
                    "Project {label} must not exceed {max} characters."
                )));
            }
            Ok((!value.is_empty()).then(|| value.to_string()))
        })
        .transpose()
        .map(Option::flatten)
}

fn title_fingerprint(title: &str) -> String {
    let normalized = title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    format!("{:x}", Sha256::digest(normalized.as_bytes()))
}

fn read_project(store: &Store, row: &rusqlite::Row<'_>) -> rusqlite::Result<ProjectRow> {
    let id: String = row.get("id")?;
    let sealed = super::payload_of(row)?;
    let content: ProjectContent = open_json(store, &sealed, &aad(&id))
        .and_then(|value| {
            serde_json::from_value(value)
                .map_err(|_| StoreError::Invalid("Project content is invalid.".into()))
        })
        .map_err(|_| rusqlite::Error::InvalidQuery)?;
    Ok(ProjectRow {
        id,
        workspace_id: row.get("workspace_id")?,
        authority: row.get("authority")?,
        visibility: row.get("visibility")?,
        owner_member_id: row.get("owner_member_id")?,
        schema_version: row.get("schema_version")?,
        revision: row.get("revision")?,
        created_by_internal_user_id: row.get("created_by_internal_user_id")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        title: content.title,
        description: content.description,
        instructions: content.instructions,
        lifecycle: row.get("lifecycle")?,
    })
}

const SELECT_PROJECT: &str = "SELECT id,workspace_id,authority,visibility,owner_member_id,
    schema_version,revision,created_by_internal_user_id,created_at,updated_at,lifecycle,
    payload,payload_nonce FROM project";

pub fn upsert_shared_mirror(
    tx: &Connection,
    store: &Store,
    project: &SharedProjectMirror,
) -> Result<()> {
    let id = normalize_id(&project.id, "Project")?;
    let workspace_id = normalize_id(&project.workspace_id, "Workspace")?;
    let title = normalize_required(&project.title, "title", TITLE_MAX)?;
    if project.revision < 1 {
        return Err(StoreError::Invalid(
            "Shared project revision is invalid.".into(),
        ));
    }
    let existing: Option<(String, String, String, i64)> = tx
        .query_row(
            "SELECT workspace_id,authority,visibility,revision FROM project WHERE id=?1;",
            [&id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    if existing
        .as_ref()
        .is_some_and(|(workspace, authority, visibility, revision)| {
            workspace != &workspace_id
                || authority != "convex"
                || visibility != "workspace-shared"
                || *revision > project.revision
        })
    {
        return Err(StoreError::Invalid(
            "Shared project mirror conflicts with local authority.".into(),
        ));
    }
    let content = ProjectContent {
        title: title.clone(),
        description: normalize_optional(
            project.description.as_deref(),
            "description",
            DESCRIPTION_MAX,
        )?,
        instructions: normalize_optional(
            project.instructions.as_deref(),
            "instructions",
            INSTRUCTIONS_MAX,
        )?,
        created_by_device_id: Some(normalize_id(&project.created_by_device_id, "Device")?),
    };
    let sealed = seal_json(
        store,
        &serde_json::to_value(content)
            .map_err(|_| StoreError::Invalid("Project content is invalid.".into()))?,
        &aad(&id),
    )?;
    tx.execute(
        "INSERT INTO project (id,workspace_id,title_fingerprint,authority,visibility,owner_member_id,
          created_by_internal_user_id,schema_version,revision,lifecycle,created_at,updated_at,payload,payload_nonce)
         VALUES (?1,?2,?3,'convex','workspace-shared',NULL,?4,1,?5,'active',?6,?7,?8,?9)
         ON CONFLICT(id) DO UPDATE SET title_fingerprint=excluded.title_fingerprint,
          revision=excluded.revision,updated_at=excluded.updated_at,payload=excluded.payload,
          payload_nonce=excluded.payload_nonce WHERE project.authority='convex'
          AND project.visibility='workspace-shared' AND project.workspace_id=excluded.workspace_id
          AND project.revision<=excluded.revision;",
        rusqlite::params![id,workspace_id,title_fingerprint(&title),project.created_by_internal_user_id,
            project.revision,project.created_at,project.updated_at,sealed.ciphertext,sealed.nonce],
    )?;
    Ok(())
}

pub fn delete_shared_mirror(
    tx: &Connection,
    workspace_id: &str,
    project_id: &str,
    revision: i64,
) -> Result<()> {
    let existing: Option<(String, String, String, i64)> = tx
        .query_row(
            "SELECT workspace_id,authority,visibility,revision FROM project WHERE id=?1;",
            [project_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    if let Some((workspace, authority, visibility, current_revision)) = existing {
        if workspace != workspace_id || authority != "convex" || visibility != "workspace-shared" {
            return Err(StoreError::Invalid(
                "Shared project tombstone conflicts with another authority scope.".into(),
            ));
        }
        if current_revision > revision {
            return Ok(());
        }
    }
    let changed = tx.execute(
        "DELETE FROM project WHERE workspace_id=?1 AND id=?2 AND authority='convex'
         AND visibility='workspace-shared' AND revision<=?3;",
        rusqlite::params![workspace_id, project_id, revision],
    )?;
    let _ = changed;
    Ok(())
}

pub fn create(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    id: &str,
    owner_member_id: &str,
    created_by_internal_user_id: &str,
    title: &str,
    description: Option<&str>,
    instructions: Option<&str>,
    created_at: &str,
) -> Result<ProjectRow> {
    if scope.project_id().is_some() {
        return Err(StoreError::Invalid(
            "Project creation requires workspace scope.".into(),
        ));
    }
    scope.ensure_exists(tx)?;
    let id = normalize_id(id, "Project")?;
    let owner_member_id = normalize_id(owner_member_id, "Member")?;
    let created_by_internal_user_id = normalize_id(created_by_internal_user_id, "Internal user")?;
    let title = normalize_required(title, "title", TITLE_MAX)?;
    let content = ProjectContent {
        title: title.clone(),
        description: normalize_optional(description, "description", DESCRIPTION_MAX)?,
        instructions: normalize_optional(instructions, "instructions", INSTRUCTIONS_MAX)?,
        created_by_device_id: None,
    };
    let unavailable: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM project WHERE id=?1 UNION ALL SELECT 1 FROM project_tombstone WHERE project_id=?1);",
        [&id],
        |row| row.get(0),
    )?;
    if unavailable {
        return Err(StoreError::Invalid(
            "Project id is unavailable or was deleted.".into(),
        ));
    }
    let sealed = seal_json(
        store,
        &serde_json::to_value(content)
            .map_err(|_| StoreError::Invalid("Project content is invalid.".into()))?,
        &aad(&id),
    )?;
    tx.execute(
        "INSERT INTO project (id,workspace_id,title_fingerprint,authority,visibility,owner_member_id,
           created_by_internal_user_id,schema_version,revision,lifecycle,created_at,updated_at,payload,payload_nonce)
         VALUES (?1,?2,?3,'local','member-private',?4,?5,1,1,'active',?6,?6,?7,?8);",
        rusqlite::params![id, scope.workspace_id(), title_fingerprint(&title), owner_member_id,
            created_by_internal_user_id, created_at, sealed.ciphertext, sealed.nonce],
    )?;
    get(tx, store, scope, &id, &owner_member_id)?
        .ok_or_else(|| StoreError::Invalid("Project was not saved.".into()))
}

pub fn get(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    id: &str,
    owner_member_id: &str,
) -> Result<Option<ProjectRow>> {
    scope.ensure_exists(tx)?;
    let id = normalize_id(id, "Project")?;
    let sql = format!("{SELECT_PROJECT} WHERE workspace_id=?1 AND id=?2 AND owner_member_id=?3 AND authority='local' AND visibility='member-private' AND deleted_at IS NULL;");
    tx.query_row(
        &sql,
        rusqlite::params![scope.workspace_id(), id, owner_member_id],
        |row| read_project(store, row),
    )
    .optional()
    .map_err(Into::into)
}

pub fn list(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    owner_member_id: &str,
) -> Result<Vec<ProjectRow>> {
    scope.ensure_exists(tx)?;
    let sql = format!("{SELECT_PROJECT} WHERE workspace_id=?1 AND owner_member_id=?2 AND authority='local' AND visibility='member-private' AND deleted_at IS NULL ORDER BY updated_at DESC,id;");
    let mut statement = tx.prepare(&sql)?;
    let rows = statement.query_map(
        rusqlite::params![scope.workspace_id(), owner_member_id],
        |row| read_project(store, row),
    )?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn update(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    owner_member_id: &str,
    id: &str,
    base_revision: i64,
    title: Option<&str>,
    description: Option<Option<&str>>,
    instructions: Option<Option<&str>>,
    updated_at: &str,
) -> Result<ProjectRow> {
    let old = get(tx, store, scope, id, owner_member_id)?
        .ok_or_else(|| StoreError::Invalid("Project is unavailable in this workspace.".into()))?;
    if old.revision != base_revision {
        return Err(StoreError::Invalid(
            "Project changed since it was opened.".into(),
        ));
    }
    if old.lifecycle != "active" && old.lifecycle != "archived" {
        return Err(StoreError::Invalid(
            "Deleted projects cannot be changed.".into(),
        ));
    }
    let content = ProjectContent {
        title: match title {
            Some(value) => normalize_required(value, "title", TITLE_MAX)?,
            None => old.title,
        },
        description: match description {
            Some(value) => normalize_optional(value, "description", DESCRIPTION_MAX)?,
            None => old.description,
        },
        instructions: match instructions {
            Some(value) => normalize_optional(value, "instructions", INSTRUCTIONS_MAX)?,
            None => old.instructions,
        },
        created_by_device_id: None,
    };
    let fingerprint = title_fingerprint(&content.title);
    let sealed = seal_json(
        store,
        &serde_json::to_value(content)
            .map_err(|_| StoreError::Invalid("Project content is invalid.".into()))?,
        &aad(id),
    )?;
    let changed = tx.execute(
        "UPDATE project SET title_fingerprint=?1,payload=?2,payload_nonce=?3,revision=revision+1,updated_at=?4
         WHERE workspace_id=?5 AND id=?6 AND owner_member_id=?7 AND revision=?8 AND deleted_at IS NULL;",
        rusqlite::params![fingerprint,sealed.ciphertext,sealed.nonce,updated_at,scope.workspace_id(),id,owner_member_id,base_revision],
    )?;
    if changed != 1 {
        return Err(StoreError::Invalid(
            "Project changed since it was opened.".into(),
        ));
    }
    get(tx, store, scope, id, owner_member_id)?
        .ok_or_else(|| StoreError::Invalid("Project disappeared.".into()))
}

pub fn transition(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    owner_member_id: &str,
    id: &str,
    base_revision: i64,
    lifecycle: &str,
    updated_at: &str,
) -> Result<ProjectRow> {
    if !["active", "archived"].contains(&lifecycle) {
        return Err(StoreError::Invalid("Project lifecycle is invalid.".into()));
    }
    let old = get(tx, store, scope, id, owner_member_id)?
        .ok_or_else(|| StoreError::Invalid("Project is unavailable in this workspace.".into()))?;
    if old.revision != base_revision {
        return Err(StoreError::Invalid(
            "Project changed since it was opened.".into(),
        ));
    }
    let changed = tx.execute(
        "UPDATE project SET lifecycle=?1,revision=revision+1,updated_at=?2 WHERE workspace_id=?3 AND id=?4 AND owner_member_id=?5 AND revision=?6 AND deleted_at IS NULL;",
        rusqlite::params![lifecycle,updated_at,scope.workspace_id(),id,owner_member_id,base_revision],
    )?;
    if changed != 1 {
        return Err(StoreError::Invalid(
            "Project changed since it was opened.".into(),
        ));
    }
    get(tx, store, scope, id, owner_member_id)?
        .ok_or_else(|| StoreError::Invalid("Project disappeared.".into()))
}

pub fn delete(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    owner_member_id: &str,
    internal_user_id: &str,
    id: &str,
    base_revision: i64,
    deleted_at: &str,
) -> Result<ProjectRow> {
    let mut old = get(tx, store, scope, id, owner_member_id)?
        .ok_or_else(|| StoreError::Invalid("Project is unavailable in this workspace.".into()))?;
    if old.revision != base_revision {
        return Err(StoreError::Invalid(
            "Project changed since it was opened.".into(),
        ));
    }
    tx.execute("INSERT INTO project_tombstone (workspace_id,project_id,deleted_at,deleted_by_internal_user_id,last_revision) VALUES (?1,?2,?3,?4,?5);",
        rusqlite::params![scope.workspace_id(),id,deleted_at,internal_user_id,base_revision+1])?;
    super::routine::detach_project(tx, store, scope, owner_member_id, id, deleted_at)?;
    let private = super::scope::PrivateDataScope::for_authenticated_user(
        scope.clone(),
        internal_user_id,
        Some(owner_member_id),
    )?;
    super::artifact::detach_project_handoffs(tx, store, &private, id, deleted_at)?;
    for table in [
        "thread",
        "knowledge_source",
        "memory_record",
        "schedule",
        "workflow_definition",
        "workflow_run",
        "goal",
    ] {
        tx.execute(
            &format!("UPDATE {table} SET project_id=NULL WHERE workspace_id=?1 AND project_id=?2;"),
            rusqlite::params![scope.workspace_id(), id],
        )?;
    }
    tx.execute("UPDATE pinned_context SET scope_level='workspace',project_id=NULL WHERE workspace_id=?1 AND project_id=?2;", rusqlite::params![scope.workspace_id(),id])?;
    let deleted = tx.execute("DELETE FROM project WHERE workspace_id=?1 AND id=?2 AND owner_member_id=?3 AND revision=?4;",
        rusqlite::params![scope.workspace_id(),id,owner_member_id,base_revision])?;
    if deleted != 1 {
        return Err(StoreError::Invalid(
            "Project changed since it was opened.".into(),
        ));
    }
    old.lifecycle = "deleted".into();
    old.revision = base_revision + 1;
    old.updated_at = deleted_at.into();
    Ok(old)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{
        repos::thread,
        vault::{MasterKey, Vault},
        Store,
    };

    fn store() -> Store {
        Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap()
    }

    fn seed_workspaces(store: &Store) {
        store.transaction(|tx| {
            tx.execute("INSERT INTO workspace (id,name,created_at,updated_at) VALUES ('w1','One','t','t'),('w2','Two','t','t');", [])?;
            Ok(())
        }).unwrap();
    }

    #[test]
    fn lifecycle_updates_are_revision_fenced_and_workspace_safe() {
        let store = store();
        seed_workspaces(&store);
        let w1 = DataScope::workspace("w1").unwrap();
        let w2 = DataScope::workspace("w2").unwrap();
        let created = store
            .transaction(|tx| {
                create(
                    tx,
                    &store,
                    &w1,
                    "project-1",
                    "member-1",
                    "user-1",
                    " Launch plan ",
                    Some("A plan"),
                    Some("Keep it calm"),
                    "t1",
                )
            })
            .unwrap();
        assert_eq!(created.title, "Launch plan");
        assert_eq!(created.revision, 1);
        assert!(store
            .with_conn(|tx| get(tx, &store, &w2, "project-1", "member-1"))
            .unwrap()
            .is_none());

        let archived = store
            .transaction(|tx| {
                transition(
                    tx,
                    &store,
                    &w1,
                    "member-1",
                    "project-1",
                    1,
                    "archived",
                    "t2",
                )
            })
            .unwrap();
        assert_eq!(
            (archived.lifecycle.as_str(), archived.revision),
            ("archived", 2)
        );
        let stale = store.transaction(|tx| {
            update(
                tx,
                &store,
                &w1,
                "member-1",
                "project-1",
                1,
                Some("Stale"),
                None,
                None,
                "t3",
            )
        });
        assert!(stale.unwrap_err().to_string().contains("changed"));
        let restored = store
            .transaction(|tx| {
                transition(tx, &store, &w1, "member-1", "project-1", 2, "active", "t3")
            })
            .unwrap();
        assert_eq!(restored.revision, 3);

        let cross_thread = store.transaction(|tx| {
            thread::create(
                tx,
                &store,
                &w2,
                "thread-1",
                Some("project-1"),
                "Wrong workspace",
                "t4",
                &serde_json::json!({}),
            )
        });
        assert!(cross_thread.is_err());
        let duplicate = store.transaction(|tx| {
            create(
                tx,
                &store,
                &w2,
                "project-1",
                "member-2",
                "user-2",
                "Duplicate",
                None,
                None,
                "t4",
            )
        });
        assert!(duplicate.is_err());
    }

    #[test]
    fn delete_detaches_context_children_and_tombstone_blocks_recreation() {
        let store = store();
        seed_workspaces(&store);
        let scope = DataScope::workspace("w1").unwrap();
        store.transaction(|tx| {
            create(tx, &store, &scope, "project-1", "member-1", "user-1", "Project", None, None, "t1")?;
            tx.execute("INSERT INTO thread (id,workspace_id,project_id,title,created_at,updated_at,payload,payload_nonce) VALUES ('thread-1','w1','project-1','Thread','t','t',x'01',x'02');", [])?;
            tx.execute("INSERT INTO knowledge_source (workspace_id,owner_subject,authority,visibility,owner_member_id,id,project_id,connector_id,kind,trust,content_fingerprint,size_bytes,imported_at,origin,payload,payload_nonce) VALUES ('w1','member:member-1','local','member-private','member-1','source-1','project-1','local','text','trusted','fp',1,'t','local',x'01',x'02');", [])?;
            tx.execute("INSERT INTO memory_record (workspace_id,owner_subject,authority,visibility,owner_member_id,id,project_id,kind,created_at,payload,payload_nonce) VALUES ('w1','member:member-1','local','member-private','member-1','memory-1','project-1','fact','t',x'01',x'02');", [])?;
            tx.execute("INSERT INTO schedule (id,workspace_id,project_id,weekday,time,created_at,payload,payload_nonce) VALUES ('schedule-1','w1','project-1','mon','09:00','t',x'01',x'02');", [])?;
            tx.execute("INSERT INTO workflow_definition (workspace_id,project_id,id,version,created_at,updated_at,payload,payload_nonce) VALUES ('w1','project-1','definition-1',1,'t','t',x'01',x'02');", [])?;
            tx.execute("INSERT INTO workflow_run (workspace_id,project_id,id,definition_id,definition_version,status,started_at,updated_at,payload,payload_nonce) VALUES ('w1','project-1','run-1','definition-1',1,'completed','t','t',x'01',x'02');", [])?;
            tx.execute("INSERT INTO goal (id,workspace_id,project_id,owner_member_id,created_by_internal_user_id,title_fingerprint,created_at,updated_at,payload,payload_nonce) VALUES ('goal-1','w1','project-1','member-1','user-1','fp','t','t',x'01',x'02');", [])?;
            delete(tx, &store, &scope, "member-1", "user-1", "project-1", 1, "t2")?;
            Ok(())
        }).unwrap();

        store.with_conn(|tx| {
            for table in ["thread", "knowledge_source", "memory_record", "schedule", "workflow_definition", "workflow_run", "goal"] {
                let detached: i64 = tx.query_row(&format!("SELECT COUNT(*) FROM {table} WHERE workspace_id='w1' AND project_id IS NULL;"), [], |row| row.get(0))?;
                assert_eq!(detached, 1, "{table} was not detached");
            }
            let tombstone: i64 = tx.query_row("SELECT COUNT(*) FROM project_tombstone WHERE workspace_id='w1' AND project_id='project-1';", [], |row| row.get(0))?;
            assert_eq!(tombstone, 1);
            Ok(())
        }).unwrap();
        let recreated = store.transaction(|tx| {
            create(
                tx,
                &store,
                &scope,
                "project-1",
                "member-1",
                "user-1",
                "Resurrected",
                None,
                None,
                "t3",
            )
        });
        assert!(recreated.unwrap_err().to_string().contains("deleted"));
    }
}
