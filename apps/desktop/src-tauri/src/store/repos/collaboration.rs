//! Typed, encrypted installation-member coordination records. No credentials or
//! permissions are stored here. Conversation/project deletion cascades; ordinary
//! backups include these rows and local-data deletion removes them. They are not
//! in a remote sync or plaintext export allowlist.

use rusqlite::{Connection, OptionalExtension};
use serde::{de::DeserializeOwned, Serialize};

use super::{open_json, payload_of, scope::PrivateDataScope, seal_json};
use crate::store::{Result, Store, StoreError};

#[derive(Clone, Copy)]
pub enum Kind {
    Conversation,
    Author,
    Team,
    Work,
    Fact,
    Layout,
    Receipt,
}

impl Kind {
    fn key(self) -> &'static str {
        match self {
            Self::Conversation => "conversation",
            Self::Author => "author",
            Self::Team => "team",
            Self::Work => "work",
            Self::Fact => "fact",
            Self::Layout => "layout",
            Self::Receipt => "receipt",
        }
    }
}

fn aad(scope: &PrivateDataScope, kind: Kind, id: &str) -> String {
    format!(
        "collaboration:{}:{}:{}:{id}",
        scope.workspace_id(),
        scope.owner_subject(),
        kind.key()
    )
}

pub fn get<T: DeserializeOwned>(
    conn: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    kind: Kind,
    id: &str,
) -> Result<Option<T>> {
    scope.ensure_exists(conn)?;
    let sealed = conn.query_row(
        "SELECT payload,payload_nonce FROM collaboration_record WHERE workspace_id=?1 AND owner_subject=?2 AND kind=?3 AND id=?4",
        rusqlite::params![scope.workspace_id(), scope.owner_subject(), kind.key(), id], payload_of,
    ).optional()?;
    sealed
        .map(|sealed| {
            let value = open_json(store, &sealed, &aad(scope, kind, id))?;
            serde_json::from_value(value).map_err(|_| {
                StoreError::Invalid(
                    "The coordination record is invalid. Restore a compatible backup.".into(),
                )
            })
        })
        .transpose()
}

pub fn list<T: DeserializeOwned>(
    conn: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    kind: Kind,
) -> Result<Vec<T>> {
    scope.ensure_exists(conn)?;
    let mut statement = conn.prepare("SELECT id FROM collaboration_record WHERE workspace_id=?1 AND owner_subject=?2 AND kind=?3 ORDER BY id LIMIT 4097")?;
    let ids = statement
        .query_map(
            rusqlite::params![scope.workspace_id(), scope.owner_subject(), kind.key()],
            |row| row.get::<_, String>(0),
        )?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if ids.len() > 4096 {
        return Err(StoreError::Invalid("The local coordination record limit was reached. Archive or delete finished conversations.".into()));
    }
    ids.into_iter()
        .map(|id| {
            get(conn, store, scope, kind, &id)?
                .ok_or_else(|| StoreError::Invalid("A coordination record disappeared.".into()))
        })
        .collect()
}

pub fn put<T: Serialize>(
    conn: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    kind: Kind,
    id: &str,
    conversation: Option<&str>,
    project: Option<&str>,
    value: &T,
) -> Result<()> {
    scope.ensure_exists(conn)?;
    if let Some(conversation) = conversation {
        let owned: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM thread WHERE workspace_id=?1 AND id=?2 AND owner_member_id IS ?3 AND deleted_at IS NULL)",
            rusqlite::params![scope.workspace_id(), conversation, scope.owner_member_id()], |row| row.get(0))?;
        if !owned {
            return Err(StoreError::Invalid(
                "The conversation is not owned by this workspace member.".into(),
            ));
        }
    }
    if let Some(project) = project {
        let owned: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM local_project WHERE workspace_id=?1 AND owner_subject=?2 AND id=?3)",
            rusqlite::params![scope.workspace_id(), scope.owner_subject(), project], |row| row.get(0))?;
        if !owned {
            return Err(StoreError::Invalid(
                "The project is not owned by this workspace member.".into(),
            ));
        }
    }
    let value = serde_json::to_value(value)
        .map_err(|_| StoreError::Invalid("The coordination record could not be encoded.".into()))?;
    let sealed = seal_json(store, &value, &aad(scope, kind, id))?;
    conn.execute("INSERT INTO collaboration_record(workspace_id,owner_subject,kind,id,conversation_id,project_id,payload,payload_nonce) VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(workspace_id,owner_subject,kind,id) DO UPDATE SET conversation_id=excluded.conversation_id,project_id=excluded.project_id,payload=excluded.payload,payload_nonce=excluded.payload_nonce",
        rusqlite::params![scope.workspace_id(), scope.owner_subject(), kind.key(), id, conversation, project, sealed.ciphertext, sealed.nonce])?;
    Ok(())
}
