//! Member-private shared project rooms and immutable run attribution.

use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;

use crate::store::repos::scope::PrivateDataScope;
use crate::store::repos::{open_json, seal_json};
use crate::store::vault::Sealed;
use crate::store::{Result, Store, StoreError};

#[derive(Clone, Debug, PartialEq)]
pub struct LocalProjectRow {
    pub id: String,
    pub lifecycle: String,
    pub revision: i64,
    pub thread_id: String,
    pub created_at: String,
    pub updated_at: String,
    pub archived_at: Option<String>,
    pub payload: Value,
}

#[derive(Clone, Debug, PartialEq)]
pub struct LocalProjectRunAuthorRow {
    pub project_id: String,
    pub run_id: String,
    pub agent_id: String,
    pub thread_id: String,
    pub created_at: String,
    pub payload: Value,
}

fn project_aad(scope: &PrivateDataScope, id: &str) -> String {
    format!(
        "local_project:{}:{}:{id}",
        scope.workspace_id(),
        scope.owner_subject()
    )
}

fn author_aad(scope: &PrivateDataScope, run_id: &str) -> String {
    format!(
        "local_project_run_author:{}:{}:{run_id}",
        scope.workspace_id(),
        scope.owner_subject()
    )
}

pub fn insert_project(
    tx: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    row: &LocalProjectRow,
) -> Result<()> {
    scope.ensure_exists(tx)?;
    let sealed = seal_json(store, &row.payload, &project_aad(scope, &row.id))?;
    tx.execute(
        "INSERT INTO local_project(
           workspace_id,owner_subject,id,lifecycle,revision,thread_id,
           created_at,updated_at,archived_at,payload,payload_nonce
         ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        rusqlite::params![
            scope.workspace_id(),
            scope.owner_subject(),
            row.id,
            row.lifecycle,
            row.revision,
            row.thread_id,
            row.created_at,
            row.updated_at,
            row.archived_at,
            sealed.ciphertext,
            sealed.nonce
        ],
    )
    .map_err(|error| match error {
        rusqlite::Error::SqliteFailure(_, Some(message))
            if message.contains("UNIQUE") || message.contains("PRIMARY KEY") =>
        {
            StoreError::Invalid("That local project already exists.".into())
        }
        other => StoreError::Sqlite(other.to_string()),
    })?;
    Ok(())
}

pub fn get_project(
    tx: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    id: &str,
) -> Result<Option<LocalProjectRow>> {
    scope.ensure_exists(tx)?;
    let partial = tx
        .query_row(
            "SELECT id,lifecycle,revision,thread_id,created_at,updated_at,archived_at,
                    payload,payload_nonce
               FROM local_project
              WHERE workspace_id=?1 AND owner_subject=?2 AND id=?3",
            rusqlite::params![scope.workspace_id(), scope.owner_subject(), id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    Sealed {
                        ciphertext: row.get(7)?,
                        nonce: row.get(8)?,
                    },
                ))
            },
        )
        .optional()?;
    partial
        .map(
            |(id, lifecycle, revision, thread_id, created_at, updated_at, archived_at, sealed)| {
                let payload = open_json(store, &sealed, &project_aad(scope, &id))?;
                Ok(LocalProjectRow {
                    id,
                    lifecycle,
                    revision,
                    thread_id,
                    created_at,
                    updated_at,
                    archived_at,
                    payload,
                })
            },
        )
        .transpose()
}

pub fn list_projects(
    tx: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    include_archived: bool,
    limit: usize,
) -> Result<Vec<LocalProjectRow>> {
    scope.ensure_exists(tx)?;
    let mut statement = tx.prepare(
        "SELECT id FROM local_project
          WHERE workspace_id=?1 AND owner_subject=?2
            AND (?3=1 OR lifecycle='active')
          ORDER BY updated_at DESC,id ASC LIMIT ?4",
    )?;
    let ids = statement
        .query_map(
            rusqlite::params![
                scope.workspace_id(),
                scope.owner_subject(),
                include_archived as i64,
                limit as i64
            ],
            |row| row.get::<_, String>(0),
        )?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    ids.into_iter()
        .map(|id| {
            get_project(tx, store, scope, &id)?.ok_or_else(|| {
                StoreError::Invalid("A local project changed while it was being read.".into())
            })
        })
        .collect()
}

pub fn replace_project(
    tx: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    expected_revision: i64,
    row: &LocalProjectRow,
) -> Result<()> {
    let sealed = seal_json(store, &row.payload, &project_aad(scope, &row.id))?;
    let changed = tx.execute(
        "UPDATE local_project SET lifecycle=?1,revision=?2,updated_at=?3,archived_at=?4,
                                  payload=?5,payload_nonce=?6
          WHERE workspace_id=?7 AND owner_subject=?8 AND id=?9 AND revision=?10",
        rusqlite::params![
            row.lifecycle,
            row.revision,
            row.updated_at,
            row.archived_at,
            sealed.ciphertext,
            sealed.nonce,
            scope.workspace_id(),
            scope.owner_subject(),
            row.id,
            expected_revision
        ],
    )?;
    if changed != 1 {
        return Err(StoreError::Invalid(
            "The local project changed. Refresh it before editing.".into(),
        ));
    }
    Ok(())
}

pub fn get_run_author(
    tx: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    run_id: &str,
) -> Result<Option<LocalProjectRunAuthorRow>> {
    let partial = tx
        .query_row(
            "SELECT project_id,run_id,agent_id,thread_id,created_at,payload,payload_nonce
               FROM local_project_run_author
              WHERE workspace_id=?1 AND owner_subject=?2 AND run_id=?3",
            rusqlite::params![scope.workspace_id(), scope.owner_subject(), run_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    Sealed {
                        ciphertext: row.get(5)?,
                        nonce: row.get(6)?,
                    },
                ))
            },
        )
        .optional()?;
    partial
        .map(
            |(project_id, run_id, agent_id, thread_id, created_at, sealed)| {
                let payload = open_json(store, &sealed, &author_aad(scope, &run_id))?;
                Ok(LocalProjectRunAuthorRow {
                    project_id,
                    run_id,
                    agent_id,
                    thread_id,
                    created_at,
                    payload,
                })
            },
        )
        .transpose()
}

pub fn insert_run_author(
    tx: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    row: &LocalProjectRunAuthorRow,
) -> Result<()> {
    let sealed = seal_json(store, &row.payload, &author_aad(scope, &row.run_id))?;
    tx.execute(
        "INSERT INTO local_project_run_author(
           workspace_id,owner_subject,project_id,run_id,agent_id,thread_id,created_at,
           payload,payload_nonce
         ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        rusqlite::params![
            scope.workspace_id(),
            scope.owner_subject(),
            row.project_id,
            row.run_id,
            row.agent_id,
            row.thread_id,
            row.created_at,
            sealed.ciphertext,
            sealed.nonce
        ],
    )?;
    Ok(())
}

pub fn list_run_authors(
    tx: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    project_id: &str,
    limit: usize,
) -> Result<Vec<LocalProjectRunAuthorRow>> {
    let mut statement = tx.prepare(
        "SELECT run_id FROM local_project_run_author
          WHERE workspace_id=?1 AND owner_subject=?2 AND project_id=?3
          ORDER BY created_at DESC,run_id ASC LIMIT ?4",
    )?;
    let ids = statement
        .query_map(
            rusqlite::params![
                scope.workspace_id(),
                scope.owner_subject(),
                project_id,
                limit as i64
            ],
            |row| row.get::<_, String>(0),
        )?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    ids.into_iter()
        .map(|id| {
            get_run_author(tx, store, scope, &id)?.ok_or_else(|| {
                StoreError::Invalid("A project run author changed while it was being read.".into())
            })
        })
        .collect()
}
