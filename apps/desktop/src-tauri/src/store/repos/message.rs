//! Immutable encrypted message checkpoints with strictly scoped ordering.

use crate::store::repos::{
    open_json,
    scope::{normalize_id, DataScope},
    seal_json,
};
use crate::store::{Result, Store, StoreError};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRow {
    pub id: String,
    pub thread_id: String,
    pub sequence: i64,
    pub kind: String,
    pub run_id: Option<String>,
    pub detail: Value,
    pub current_revision_id: String,
    pub current_revision_number: i64,
    pub current_revision_state: String,
    pub content: Value,
    pub created_at: String,
}
fn maad(w: &str, id: &str) -> String {
    let _ = w;
    format!("message:{id}")
}
fn raad(w: &str, id: &str) -> String {
    format!("message-revision:{w}:{id}")
}
pub fn list(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    thread_id: &str,
) -> Result<Vec<MessageRow>> {
    list_limited(tx, store, scope, thread_id, i64::MAX)
}

pub fn list_limited(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    thread_id: &str,
    limit: i64,
) -> Result<Vec<MessageRow>> {
    list_page(tx, store, scope, thread_id, limit, 0)
}

pub fn list_page(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    thread_id: &str,
    limit: i64,
    offset: i64,
) -> Result<Vec<MessageRow>> {
    let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM thread WHERE workspace_id=?1 AND id=?2 AND deleted_at IS NULL)",rusqlite::params![scope.workspace_id(),thread_id],|r|r.get(0))?;
    if !exists {
        return Err(StoreError::Invalid(
            "Thread does not belong to this workspace.".into(),
        ));
    };
    let mut s=tx.prepare("SELECT m.id,m.thread_id,m.seq,m.kind,m.run_id,m.detail_kind,m.current_revision_id,m.current_revision_number,m.current_revision_state,m.created_at,r.payload,r.payload_nonce FROM message m JOIN message_revision r ON r.id=m.current_revision_id WHERE m.workspace_id=?1 AND m.thread_id=?2 AND m.deleted_at IS NULL ORDER BY m.seq LIMIT ?3 OFFSET ?4")?;
    let rows = s.query_map(
        rusqlite::params![scope.workspace_id(), thread_id, limit.max(0), offset.max(0)],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, i64>(7)?,
                r.get::<_, String>(8)?,
                r.get::<_, String>(9)?,
                crate::store::vault::Sealed {
                    ciphertext: r.get(10)?,
                    nonce: r.get(11)?,
                },
            ))
        },
    )?;
    rows.map(|x| {
        let (a, b, c, d, run_id, e, f, g, h, i, sealed) = x?;
        let content = open_json(store, &sealed, &raad(scope.workspace_id(), &f))?;
        Ok(MessageRow {
            id: a,
            thread_id: b,
            sequence: c,
            kind: d,
            run_id,
            detail: serde_json::from_str(&e).unwrap_or(Value::Null),
            current_revision_id: f,
            current_revision_number: g,
            current_revision_state: h,
            content,
            created_at: i,
        })
    })
    .collect()
}
#[allow(clippy::too_many_arguments)]
pub fn append(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    thread_id: &str,
    id: &str,
    kind: &str,
    detail: &Value,
    run_id: Option<&str>,
    sequence: i64,
    expected: i64,
    previous: Option<&str>,
    idempotency: &str,
    revision_id: &str,
    state: &str,
    reason: &str,
    content: &Value,
    checkpointed_at: &str,
) -> Result<MessageRow> {
    let id = normalize_id(id, "Message")?;
    let revision_id = normalize_id(revision_id, "Message revision")?;
    if ![
        "user",
        "assistant",
        "tool",
        "approval",
        "interruption",
        "error",
    ]
    .contains(&kind)
        || !["streaming", "terminal", "redacted"].contains(&state)
    {
        return Err(StoreError::Invalid(
            "Conversation message vocabulary is invalid.".into(),
        ));
    };
    let head:Option<(i64,Option<String>)>=tx.query_row("SELECT last_sequence,last_message_id FROM thread WHERE workspace_id=?1 AND id=?2 AND deleted_at IS NULL",rusqlite::params![scope.workspace_id(),thread_id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    let Some((last, last_id)) = head else {
        return Err(StoreError::Invalid(
            "Thread does not belong to this workspace.".into(),
        ));
    };
    if let Some(existing) = tx
        .query_row(
            "SELECT id FROM message WHERE workspace_id=?1 AND thread_id=?2 AND idempotency_key=?3",
            rusqlite::params![scope.workspace_id(), thread_id, idempotency],
            |r| r.get::<_, String>(0),
        )
        .optional()?
    {
        if existing == id {
            return list(tx, store, scope, thread_id)
                .map(|v| v.into_iter().find(|m| m.id == id).unwrap());
        };
        return Err(StoreError::Invalid(
            "Conflicting idempotent message replay.".into(),
        ));
    };
    if last != expected || sequence != last + 1 || previous != last_id.as_deref() {
        return Err(StoreError::Invalid(
            "Message sequence is stale or non-monotonic.".into(),
        ));
    };
    let m = seal_json(store, detail, &maad(scope.workspace_id(), &id))?;
    let r = seal_json(store, content, &raad(scope.workspace_id(), &revision_id))?;
    let detail_text = serde_json::to_string(detail)
        .map_err(|_| StoreError::Invalid("Message detail cannot be encoded.".into()))?;
    tx.execute("INSERT INTO message (id,workspace_id,thread_id,kind,run_id,detail_kind,seq,previous_message_id,idempotency_key,current_revision_id,current_revision_number,current_revision_state,created_at,payload,payload_nonce) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,1,?11,?12,?13,?14)",rusqlite::params![id,scope.workspace_id(),thread_id,kind,run_id,detail_text,sequence,previous,idempotency,revision_id,state,checkpointed_at,m.ciphertext,m.nonce])?;
    tx.execute("INSERT INTO message_revision (id,workspace_id,thread_id,message_id,revision_number,base_revision_number,state,reason,idempotency_key,checkpointed_at,created_at,run_id,payload,payload_nonce) VALUES (?1,?2,?3,?4,1,0,?5,?6,?7,?8,?8,?9,?10,?11)",rusqlite::params![revision_id,scope.workspace_id(),thread_id,id,state,reason,idempotency,checkpointed_at,run_id,r.ciphertext,r.nonce])?;
    tx.execute("UPDATE thread SET last_sequence=?1,last_message_id=?2,updated_at=?3 WHERE workspace_id=?4 AND id=?5",rusqlite::params![sequence,id,checkpointed_at,scope.workspace_id(),thread_id])?;
    list(tx, store, scope, thread_id).map(|v| v.into_iter().find(|m| m.id == id).unwrap())
}
pub fn revise(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    thread_id: &str,
    message_id: &str,
    revision_id: &str,
    base: i64,
    previous: Option<&str>,
    idempotency: &str,
    state: &str,
    reason: &str,
    content: &Value,
    run_id: Option<&str>,
    at: &str,
) -> Result<MessageRow> {
    let current:Option<(String,i64)>=tx.query_row("SELECT current_revision_id,current_revision_number FROM message WHERE workspace_id=?1 AND thread_id=?2 AND id=?3 AND deleted_at IS NULL",rusqlite::params![scope.workspace_id(),thread_id,message_id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    let Some((cid, num)) = current else {
        return Err(StoreError::Invalid(
            "Message does not belong to this workspace.".into(),
        ));
    };
    if let Some(existing) = tx
        .query_row(
            "SELECT id FROM message_revision WHERE message_id=?1 AND idempotency_key=?2",
            rusqlite::params![message_id, idempotency],
            |r| r.get::<_, String>(0),
        )
        .optional()?
    {
        if existing == revision_id {
            return list(tx, store, scope, thread_id)
                .map(|v| v.into_iter().find(|m| m.id == message_id).unwrap());
        };
        return Err(StoreError::Invalid(
            "Conflicting idempotent revision replay.".into(),
        ));
    };
    if base != num || previous != Some(cid.as_str()) {
        return Err(StoreError::Invalid("Message revision is stale.".into()));
    };
    if !["streaming", "terminal", "redacted"].contains(&state) {
        return Err(StoreError::Invalid(
            "Message revision state is invalid.".into(),
        ));
    };
    let sealed = seal_json(store, content, &raad(scope.workspace_id(), revision_id))?;
    let next = num + 1;
    tx.execute("INSERT INTO message_revision (id,workspace_id,thread_id,message_id,revision_number,base_revision_number,previous_revision_id,state,reason,idempotency_key,checkpointed_at,created_at,run_id,payload,payload_nonce) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11,?12,?13,?14)",rusqlite::params![revision_id,scope.workspace_id(),thread_id,message_id,next,base,previous,state,reason,idempotency,at,run_id,sealed.ciphertext,sealed.nonce])?;
    tx.execute("UPDATE message SET current_revision_id=?1,current_revision_number=?2,current_revision_state=?3,revision=revision+1 WHERE workspace_id=?4 AND thread_id=?5 AND id=?6",rusqlite::params![revision_id,next,state,scope.workspace_id(),thread_id,message_id])?;
    list(tx, store, scope, thread_id).map(|v| v.into_iter().find(|m| m.id == message_id).unwrap())
}
