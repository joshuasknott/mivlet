//! Authenticated member-private goal lifecycle repository.

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
const STATEMENT_MAX: usize = 8_000;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoalContent {
    title: String,
    statement: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalRow {
    pub id: String,
    pub workspace_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub authority: String,
    pub visibility: String,
    pub owner_member_id: String,
    pub schema_version: i64,
    pub revision: i64,
    pub created_by_internal_user_id: String,
    pub created_at: String,
    pub updated_at: String,
    pub title: String,
    pub statement: String,
    pub lifecycle: String,
}

fn aad(id: &str) -> String {
    format!("goal:{id}")
}

fn required(value: &str, label: &str, max: usize) -> Result<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max || value.chars().any(char::is_control) {
        return Err(StoreError::Invalid(format!(
            "Goal {label} must be between 1 and {max} characters."
        )));
    }
    Ok(value.to_string())
}

fn fingerprint(title: &str) -> String {
    let normalized = title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    format!("{:x}", Sha256::digest(normalized.as_bytes()))
}

fn ensure_project(
    tx: &Connection,
    scope: &DataScope,
    owner_member_id: &str,
    project_id: &str,
    require_active: bool,
) -> Result<String> {
    let project_id = normalize_id(project_id, "Project")?;
    let lifecycle = tx.query_row(
        "SELECT lifecycle FROM project WHERE id=?1 AND workspace_id=?2 AND owner_member_id=?3 AND authority='local' AND visibility='member-private' AND deleted_at IS NULL;",
        rusqlite::params![project_id, scope.workspace_id(), owner_member_id],
        |row| row.get::<_, String>(0),
    ).optional()?;
    match lifecycle.as_deref() {
        Some("active") => Ok(project_id),
        Some("archived") if !require_active => Ok(project_id),
        Some("archived") => Err(StoreError::Invalid(
            "Archived projects cannot receive new goals.".into(),
        )),
        _ => Err(StoreError::Invalid(
            "Project is unavailable in this workspace.".into(),
        )),
    }
}

fn read(store: &Store, row: &rusqlite::Row<'_>) -> rusqlite::Result<GoalRow> {
    let id: String = row.get("id")?;
    let content: GoalContent = open_json(store, &super::payload_of(row)?, &aad(&id))
        .and_then(|value| {
            serde_json::from_value(value)
                .map_err(|_| StoreError::Invalid("Goal content is invalid.".into()))
        })
        .map_err(|_| rusqlite::Error::InvalidQuery)?;
    Ok(GoalRow {
        id,
        workspace_id: row.get("workspace_id")?,
        project_id: row.get("project_id")?,
        authority: row.get("authority")?,
        visibility: row.get("visibility")?,
        owner_member_id: row.get("owner_member_id")?,
        schema_version: row.get("schema_version")?,
        revision: row.get("revision")?,
        created_by_internal_user_id: row.get("created_by_internal_user_id")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        title: content.title,
        statement: content.statement,
        lifecycle: row.get("lifecycle")?,
    })
}

const SELECT: &str = "SELECT id,workspace_id,project_id,authority,visibility,owner_member_id,
 schema_version,revision,created_by_internal_user_id,created_at,updated_at,lifecycle,payload,payload_nonce FROM goal";

#[derive(Clone, Copy)]
pub enum GoalListFilter<'a> {
    All,
    Workspace,
    Project(&'a str),
}

pub fn create(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    id: &str,
    owner_member_id: &str,
    internal_user_id: &str,
    project_id: Option<&str>,
    title: &str,
    statement: &str,
    at: &str,
) -> Result<GoalRow> {
    scope.ensure_exists(tx)?;
    let id = normalize_id(id, "Goal")?;
    let owner_member_id = normalize_id(owner_member_id, "Member")?;
    let internal_user_id = normalize_id(internal_user_id, "Internal user")?;
    let project_id = project_id
        .map(|id| ensure_project(tx, scope, &owner_member_id, id, true))
        .transpose()?;
    let content = GoalContent {
        title: required(title, "title", TITLE_MAX)?,
        statement: required(statement, "statement", STATEMENT_MAX)?,
    };
    let sealed = seal_json(
        store,
        &serde_json::to_value(&content)
            .map_err(|_| StoreError::Invalid("Goal content is invalid.".into()))?,
        &aad(&id),
    )?;
    tx.execute(
        "INSERT INTO goal (id,workspace_id,project_id,authority,visibility,owner_member_id,created_by_internal_user_id,schema_version,revision,lifecycle,title_fingerprint,created_at,updated_at,payload,payload_nonce)
         VALUES (?1,?2,?3,'local','member-private',?4,?5,1,1,'active',?6,?7,?7,?8,?9);",
        rusqlite::params![id,scope.workspace_id(),project_id,owner_member_id,internal_user_id,fingerprint(&content.title),at,sealed.ciphertext,sealed.nonce],
    )?;
    get(tx, store, scope, &id, &owner_member_id)?
        .ok_or_else(|| StoreError::Invalid("Goal was not saved.".into()))
}

pub fn get(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    id: &str,
    owner_member_id: &str,
) -> Result<Option<GoalRow>> {
    scope.ensure_exists(tx)?;
    let sql = format!("{SELECT} WHERE workspace_id=?1 AND id=?2 AND owner_member_id=?3 AND authority='local' AND visibility='member-private';");
    tx.query_row(
        &sql,
        rusqlite::params![
            scope.workspace_id(),
            normalize_id(id, "Goal")?,
            owner_member_id
        ],
        |row| read(store, row),
    )
    .optional()
    .map_err(Into::into)
}

pub fn list(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    owner_member_id: &str,
    filter: GoalListFilter<'_>,
) -> Result<Vec<GoalRow>> {
    scope.ensure_exists(tx)?;
    let (mode, project_id) = match filter {
        GoalListFilter::All => ("all", None),
        GoalListFilter::Workspace => ("workspace", None),
        GoalListFilter::Project(id) => (
            "project",
            Some(ensure_project(tx, scope, owner_member_id, id, false)?),
        ),
    };
    let sql = format!("{SELECT} WHERE workspace_id=?1 AND owner_member_id=?2 AND authority='local' AND visibility='member-private' AND (?3='all' OR (?3='workspace' AND project_id IS NULL) OR (?3='project' AND project_id=?4)) ORDER BY updated_at DESC,id;");
    let mut statement = tx.prepare(&sql)?;
    let rows = statement.query_map(
        rusqlite::params![scope.workspace_id(), owner_member_id, mode, project_id],
        |row| read(store, row),
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
    project_id: Option<Option<&str>>,
    title: Option<&str>,
    statement: Option<&str>,
    at: &str,
) -> Result<GoalRow> {
    let old = get(tx, store, scope, id, owner_member_id)?
        .ok_or_else(|| StoreError::Invalid("Goal is unavailable in this workspace.".into()))?;
    if old.revision != base_revision {
        return Err(StoreError::Invalid(
            "Goal changed since it was opened.".into(),
        ));
    }
    let next_project = match project_id {
        Some(Some(id)) => Some(ensure_project(tx, scope, owner_member_id, id, true)?),
        Some(None) => None,
        None => old.project_id,
    };
    let content = GoalContent {
        title: title
            .map(|v| required(v, "title", TITLE_MAX))
            .transpose()?
            .unwrap_or(old.title),
        statement: statement
            .map(|v| required(v, "statement", STATEMENT_MAX))
            .transpose()?
            .unwrap_or(old.statement),
    };
    let sealed = seal_json(
        store,
        &serde_json::to_value(&content)
            .map_err(|_| StoreError::Invalid("Goal content is invalid.".into()))?,
        &aad(id),
    )?;
    let changed = tx.execute(
        "UPDATE goal SET project_id=?1,title_fingerprint=?2,payload=?3,payload_nonce=?4,revision=revision+1,updated_at=?5 WHERE workspace_id=?6 AND id=?7 AND owner_member_id=?8 AND revision=?9;",
        rusqlite::params![next_project,fingerprint(&content.title),sealed.ciphertext,sealed.nonce,at,scope.workspace_id(),id,owner_member_id,base_revision],
    )?;
    if changed != 1 {
        return Err(StoreError::Invalid(
            "Goal changed since it was opened.".into(),
        ));
    }
    get(tx, store, scope, id, owner_member_id)?
        .ok_or_else(|| StoreError::Invalid("Goal disappeared.".into()))
}

pub fn transition(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    owner_member_id: &str,
    id: &str,
    base_revision: i64,
    lifecycle: &str,
    at: &str,
) -> Result<GoalRow> {
    if !["active", "achieved", "archived"].contains(&lifecycle) {
        return Err(StoreError::Invalid("Goal lifecycle is invalid.".into()));
    }
    let old = get(tx, store, scope, id, owner_member_id)?
        .ok_or_else(|| StoreError::Invalid("Goal is unavailable in this workspace.".into()))?;
    if old.revision != base_revision {
        return Err(StoreError::Invalid(
            "Goal changed since it was opened.".into(),
        ));
    }
    let changed = tx.execute("UPDATE goal SET lifecycle=?1,revision=revision+1,updated_at=?2 WHERE workspace_id=?3 AND id=?4 AND owner_member_id=?5 AND revision=?6;", rusqlite::params![lifecycle,at,scope.workspace_id(),id,owner_member_id,base_revision])?;
    if changed != 1 {
        return Err(StoreError::Invalid(
            "Goal changed since it was opened.".into(),
        ));
    }
    get(tx, store, scope, id, owner_member_id)?
        .ok_or_else(|| StoreError::Invalid("Goal disappeared.".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{
        repos::project,
        vault::{MasterKey, Vault},
        Store,
    };

    fn store() -> Store {
        Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap()
    }

    fn seed(store: &Store) {
        store.transaction(|tx| {
            tx.execute("INSERT INTO workspace (id,name,created_at,updated_at) VALUES ('w1','One','t','t'),('w2','Two','t','t');", [])?;
            let scope = DataScope::workspace("w1")?;
            project::create(tx,store,&scope,"project-1","member-1","user-1","Project",None,None,"t1")?;
            Ok(())
        }).unwrap();
    }

    #[test]
    fn standalone_and_project_goals_are_isolated_revisioned_and_transitionable() {
        let store = store();
        seed(&store);
        let w1 = DataScope::workspace("w1").unwrap();
        let w2 = DataScope::workspace("w2").unwrap();
        store
            .transaction(|tx| {
                create(
                    tx,
                    &store,
                    &w1,
                    "goal-standalone",
                    "member-1",
                    "user-1",
                    None,
                    "Ship",
                    "Ship safely",
                    "t1",
                )?;
                create(
                    tx,
                    &store,
                    &w1,
                    "goal-project",
                    "member-1",
                    "user-1",
                    Some("project-1"),
                    "Launch",
                    "Launch well",
                    "t1",
                )?;
                Ok(())
            })
            .unwrap();
        assert_eq!(
            store
                .with_conn(|tx| list(tx, &store, &w1, "member-1", GoalListFilter::All))
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            store
                .with_conn(|tx| list(tx, &store, &w1, "member-1", GoalListFilter::Workspace))
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            store
                .with_conn(|tx| list(
                    tx,
                    &store,
                    &w1,
                    "member-1",
                    GoalListFilter::Project("project-1")
                ))
                .unwrap()
                .len(),
            1
        );
        assert!(store
            .with_conn(|tx| get(tx, &store, &w2, "goal-project", "member-1"))
            .unwrap()
            .is_none());
        assert!(store
            .with_conn(|tx| get(tx, &store, &w1, "goal-project", "member-2"))
            .unwrap()
            .is_none());

        let achieved = store
            .transaction(|tx| {
                transition(
                    tx,
                    &store,
                    &w1,
                    "member-1",
                    "goal-project",
                    1,
                    "achieved",
                    "t2",
                )
            })
            .unwrap();
        assert_eq!(
            (achieved.lifecycle.as_str(), achieved.revision),
            ("achieved", 2)
        );
        let stale = store.transaction(|tx| {
            update(
                tx,
                &store,
                &w1,
                "member-1",
                "goal-project",
                1,
                None,
                Some("Stale"),
                None,
                "t3",
            )
        });
        assert!(stale.unwrap_err().to_string().contains("changed"));
        let archived = store
            .transaction(|tx| {
                transition(
                    tx,
                    &store,
                    &w1,
                    "member-1",
                    "goal-project",
                    2,
                    "archived",
                    "t3",
                )
            })
            .unwrap();
        let restored = store
            .transaction(|tx| {
                transition(
                    tx,
                    &store,
                    &w1,
                    "member-1",
                    "goal-project",
                    archived.revision,
                    "active",
                    "t4",
                )
            })
            .unwrap();
        let detached = store
            .transaction(|tx| {
                update(
                    tx,
                    &store,
                    &w1,
                    "member-1",
                    "goal-project",
                    restored.revision,
                    Some(None),
                    None,
                    Some("Updated statement"),
                    "t5",
                )
            })
            .unwrap();
        assert_eq!(detached.project_id, None);
        assert_eq!(detached.statement, "Updated statement");
        assert_eq!(
            store
                .with_conn(|tx| list(tx, &store, &w1, "member-1", GoalListFilter::Workspace))
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn archived_or_foreign_projects_reject_goal_creation_and_assignment() {
        let store = store();
        seed(&store);
        let w1 = DataScope::workspace("w1").unwrap();
        store
            .transaction(|tx| {
                project::transition(
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
        let archived = store.transaction(|tx| {
            create(
                tx,
                &store,
                &w1,
                "goal-1",
                "member-1",
                "user-1",
                Some("project-1"),
                "No",
                "Archived target",
                "t3",
            )
        });
        assert!(archived.unwrap_err().to_string().contains("Archived"));
        let standalone = store
            .transaction(|tx| {
                create(
                    tx,
                    &store,
                    &w1,
                    "goal-2",
                    "member-1",
                    "user-1",
                    None,
                    "Yes",
                    "Standalone",
                    "t3",
                )
            })
            .unwrap();
        let assignment = store.transaction(|tx| {
            update(
                tx,
                &store,
                &w1,
                "member-1",
                "goal-2",
                standalone.revision,
                Some(Some("project-1")),
                None,
                None,
                "t4",
            )
        });
        assert!(assignment.unwrap_err().to_string().contains("Archived"));
        assert!(store
            .with_conn(|tx| list(
                tx,
                &store,
                &w1,
                "member-1",
                GoalListFilter::Project("project-1")
            ))
            .unwrap()
            .is_empty());
    }
}
