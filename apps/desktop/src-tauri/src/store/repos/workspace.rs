//! Durable workspace and project ownership roots.

use rusqlite::{Connection, OptionalExtension};

use crate::store::repos::scope::{normalize_id, DataScope, DEFAULT_WORKSPACE_ID};
use crate::store::{Result, StoreError};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceRow {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectRow {
    pub id: String,
    pub workspace_id: String,
    pub title_fingerprint: String,
    pub created_at: String,
    pub updated_at: String,
}

pub fn ensure_default(conn: &Connection) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO workspace (id, name, created_at, updated_at)
         VALUES (?1, 'My Workspace', '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z');",
        [DEFAULT_WORKSPACE_ID],
    )?;
    Ok(())
}

pub fn upsert(conn: &Connection, id: &str, name: &str, now: &str) -> Result<()> {
    let id = normalize_id(id, "Workspace")?;
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 200 {
        return Err(StoreError::Invalid("Workspace name is invalid.".into()));
    }
    conn.execute(
        "INSERT INTO workspace (id, name, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?3)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at;",
        rusqlite::params![id, name, now],
    )?;
    Ok(())
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<WorkspaceRow>> {
    let id = normalize_id(id, "Workspace")?;
    conn.query_row(
        "SELECT id, name, created_at, updated_at FROM workspace WHERE id=?1;",
        [id],
        |row| {
            Ok(WorkspaceRow {
                id: row.get(0)?,
                name: row.get(1)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

pub fn list(conn: &Connection) -> Result<Vec<WorkspaceRow>> {
    let mut stmt = conn
        .prepare("SELECT id, name, created_at, updated_at FROM workspace ORDER BY created_at;")?;
    let rows = stmt.query_map([], |row| {
        Ok(WorkspaceRow {
            id: row.get(0)?,
            name: row.get(1)?,
            created_at: row.get(2)?,
            updated_at: row.get(3)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn upsert_project(
    conn: &Connection,
    scope: &DataScope,
    id: &str,
    title_fingerprint: &str,
    now: &str,
    payload: &[u8],
    payload_nonce: &[u8],
) -> Result<()> {
    if scope.project_id().is_some() {
        return Err(StoreError::Invalid(
            "Project creation requires a workspace-level scope.".into(),
        ));
    }
    scope.ensure_exists(conn)?;
    let id = normalize_id(id, "Project")?;
    let existing_owner = conn
        .query_row(
            "SELECT workspace_id FROM project WHERE id=?1;",
            [&id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if existing_owner
        .as_deref()
        .is_some_and(|owner| owner != scope.workspace_id())
    {
        return Err(StoreError::Invalid(
            "Project id is already owned by another workspace.".into(),
        ));
    }
    conn.execute(
        "INSERT INTO project (
           id, workspace_id, title_fingerprint, created_at, updated_at, payload, payload_nonce
         ) VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET
           title_fingerprint=excluded.title_fingerprint,
           updated_at=excluded.updated_at,
           payload=excluded.payload, payload_nonce=excluded.payload_nonce;",
        rusqlite::params![
            id,
            scope.workspace_id(),
            title_fingerprint,
            now,
            payload,
            payload_nonce
        ],
    )?;
    Ok(())
}

pub fn list_projects(conn: &Connection, workspace_id: &str) -> Result<Vec<ProjectRow>> {
    let scope = DataScope::workspace(workspace_id.to_string())?;
    scope.ensure_exists(conn)?;
    let mut stmt = conn.prepare(
        "SELECT id, workspace_id, title_fingerprint, created_at, updated_at
         FROM project WHERE workspace_id=?1 ORDER BY created_at;",
    )?;
    let rows = stmt.query_map([scope.workspace_id()], |row| {
        Ok(ProjectRow {
            id: row.get(0)?,
            workspace_id: row.get(1)?,
            title_fingerprint: row.get(2)?,
            created_at: row.get(3)?,
            updated_at: row.get(4)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn delete_project(conn: &Connection, scope: &DataScope, id: &str) -> Result<bool> {
    if scope.project_id().is_some() {
        return Err(StoreError::Invalid(
            "Project deletion requires a workspace-level scope.".into(),
        ));
    }
    scope.ensure_exists(conn)?;
    Ok(conn.execute(
        "DELETE FROM project WHERE id=?1 AND workspace_id=?2;",
        rusqlite::params![id, scope.workspace_id()],
    )? > 0)
}
