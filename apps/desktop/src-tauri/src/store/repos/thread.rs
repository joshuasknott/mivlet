//! Workspace-scoped durable conversation threads.

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::store::repos::{
    scope::{normalize_id, DataScope},
    seal_json,
};
use crate::store::{Result, Store, StoreError};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRow {
    pub id: String,
    pub project_id: Option<String>,
    pub title: String,
    pub lifecycle: String,
    pub last_sequence: i64,
    pub last_message_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

fn aad(_workspace: &str, id: &str) -> String {
    format!("thread:{id}")
}

pub fn create(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    id: &str,
    project_id: Option<&str>,
    title: &str,
    created_at: &str,
    payload: &Value,
) -> Result<ThreadRow> {
    scope.ensure_exists(tx)?;
    let id = normalize_id(id, "Thread")?;
    if title.trim().is_empty() || title.chars().count() > 256 {
        return Err(StoreError::Invalid("Thread title is invalid.".into()));
    }
    if let Some(project) = project_id {
        DataScope::new(scope.workspace_id(), Some(project.to_string()))?.ensure_exists(tx)?;
    }
    let tombstoned: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM conversation_tombstone WHERE workspace_id=?1 AND target='thread' AND thread_id=?2)", rusqlite::params![scope.workspace_id(),id], |r| r.get(0))?;
    if tombstoned {
        return Err(StoreError::Invalid(
            "A deleted conversation cannot be recreated.".into(),
        ));
    }
    let sealed = seal_json(store, payload, &aad(scope.workspace_id(), &id))?;
    tx.execute("INSERT INTO thread (id,workspace_id,project_id,title,lifecycle,created_at,updated_at,payload,payload_nonce) VALUES (?1,?2,?3,?4,'active',?5,?5,?6,?7)", rusqlite::params![id,scope.workspace_id(),project_id,title.trim(),created_at,sealed.ciphertext,sealed.nonce])?;
    get(tx, store, scope, &id)?.ok_or_else(|| StoreError::Invalid("Thread was not saved.".into()))
}

pub fn get(
    tx: &Connection,
    _store: &Store,
    scope: &DataScope,
    id: &str,
) -> Result<Option<ThreadRow>> {
    scope.ensure_exists(tx)?;
    tx.query_row("SELECT id,project_id,title,lifecycle,last_sequence,last_message_id,created_at,updated_at FROM thread WHERE workspace_id=?1 AND id=?2 AND deleted_at IS NULL",rusqlite::params![scope.workspace_id(),id],|r| Ok(ThreadRow{id:r.get(0)?,project_id:r.get(1)?,title:r.get(2)?,lifecycle:r.get(3)?,last_sequence:r.get(4)?,last_message_id:r.get(5)?,created_at:r.get(6)?,updated_at:r.get(7)?})).optional().map_err(Into::into)
}
pub fn list(tx: &Connection, _store: &Store, scope: &DataScope) -> Result<Vec<ThreadRow>> {
    scope.ensure_exists(tx)?;
    let mut s=tx.prepare("SELECT id,project_id,title,lifecycle,last_sequence,last_message_id,created_at,updated_at FROM thread WHERE workspace_id=?1 AND deleted_at IS NULL ORDER BY updated_at DESC,id")?;
    let rows = s
        .query_map([scope.workspace_id()], |r| {
            Ok(ThreadRow {
                id: r.get(0)?,
                project_id: r.get(1)?,
                title: r.get(2)?,
                lifecycle: r.get(3)?,
                last_sequence: r.get(4)?,
                last_message_id: r.get(5)?,
                created_at: r.get(6)?,
                updated_at: r.get(7)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into);
    rows
}

/// Bounded thread read for scoped search and other incremental scans. Returns
/// the newest `limit` threads plus whether older rows were withheld.
pub fn list_bounded(
    tx: &Connection,
    _store: &Store,
    scope: &DataScope,
    limit: usize,
) -> Result<(Vec<ThreadRow>, bool)> {
    scope.ensure_exists(tx)?;
    let mut s=tx.prepare("SELECT id,project_id,title,lifecycle,last_sequence,last_message_id,created_at,updated_at FROM thread WHERE workspace_id=?1 AND deleted_at IS NULL ORDER BY updated_at DESC,id LIMIT ?2")?;
    let mut rows = s
        .query_map(
            rusqlite::params![scope.workspace_id(), limit as i64 + 1],
            |r| {
                Ok(ThreadRow {
                    id: r.get(0)?,
                    project_id: r.get(1)?,
                    title: r.get(2)?,
                    lifecycle: r.get(3)?,
                    last_sequence: r.get(4)?,
                    last_message_id: r.get(5)?,
                    created_at: r.get(6)?,
                    updated_at: r.get(7)?,
                })
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let truncated = rows.len() > limit;
    rows.truncate(limit);
    Ok((rows, truncated))
}
pub fn update(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    id: &str,
    title: Option<&str>,
    lifecycle: Option<&str>,
    project_id: Option<Option<&str>>,
    updated_at: &str,
) -> Result<ThreadRow> {
    let old = get(tx, store, scope, id)?
        .ok_or_else(|| StoreError::Invalid("Thread does not belong to this workspace.".into()))?;
    let title = title.unwrap_or(&old.title);
    if title.trim().is_empty() || title.chars().count() > 256 {
        return Err(StoreError::Invalid("Thread title is invalid.".into()));
    };
    let life = lifecycle.unwrap_or(&old.lifecycle);
    if !["active", "archived"].contains(&life) {
        return Err(StoreError::Invalid("Thread lifecycle is invalid.".into()));
    };
    let project = project_id.unwrap_or(old.project_id.as_deref());
    if let Some(p) = project {
        DataScope::new(scope.workspace_id(), Some(p.to_string()))?.ensure_exists(tx)?;
    }
    tx.execute("UPDATE thread SET title=?1,lifecycle=?2,project_id=?3,revision=revision+1,updated_at=?4 WHERE workspace_id=?5 AND id=?6",rusqlite::params![title.trim(),life,project,updated_at,scope.workspace_id(),id])?;
    get(tx, store, scope, id)?.ok_or_else(|| StoreError::Invalid("Thread disappeared.".into()))
}

pub fn delete(tx: &Connection, scope: &DataScope, id: &str, deleted_at: &str) -> Result<()> {
    scope.ensure_exists(tx)?;
    let id = normalize_id(id, "Thread")?;
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM thread WHERE workspace_id=?1 AND id=?2)",
        rusqlite::params![scope.workspace_id(), id],
        |r| r.get(0),
    )?;
    if !exists {
        return Err(StoreError::Invalid(
            "Conversation was not found in this workspace.".into(),
        ));
    }
    let active: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM run WHERE workspace_id=?1 AND thread_id=?2 AND status NOT IN ('completed','failed','cancelled','interrupted'))", rusqlite::params![scope.workspace_id(), id], |r| r.get(0))?;
    if active {
        return Err(StoreError::Invalid(
            "Stop the response before deleting this conversation.".into(),
        ));
    }
    tx.execute("INSERT INTO conversation_tombstone(workspace_id,target,thread_id,message_id,idempotency_key,deleted_at,reason) VALUES(?1,'thread',?2,NULL,?3,?4,'user-request')", rusqlite::params![scope.workspace_id(), id, format!("delete:{id}"), deleted_at])?;
    tx.execute(
        "DELETE FROM draft WHERE workspace_id=?1 AND thread_id=?2",
        rusqlite::params![scope.workspace_id(), id],
    )?;
    // Associated messages, revisions and execution attempts cascade with the thread.
    tx.execute(
        "DELETE FROM thread WHERE workspace_id=?1 AND id=?2",
        rusqlite::params![scope.workspace_id(), id],
    )?;
    Ok(())
}
