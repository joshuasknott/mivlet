//! Immutable encrypted message checkpoints with strictly scoped ordering.

use crate::secret_redaction;
use crate::store::repos::{
    open_json,
    scope::{normalize_id, DataScope},
    seal_json,
};
use crate::store::{Result, Store, StoreError};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

const CURRENT_MESSAGE_SELECT: &str = "
    SELECT m.id,m.thread_id,m.seq,m.kind,m.run_id,m.detail_kind,m.parent_message_id,
           m.current_revision_id,m.current_revision_number,m.current_revision_state,
           m.created_at,r.payload,r.payload_nonce
    FROM message m JOIN message_revision r ON r.id=m.current_revision_id";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRow {
    pub id: String,
    pub thread_id: String,
    pub sequence: i64,
    pub parent_message_id: Option<String>,
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

/// Defense-in-depth scrub before native seal. Matches TypeScript durable
/// `redactPersistedContent`: JSON documents walk like `redactSecretsFromObject`
/// then omit if a marker survives; other strings use redact-or-omit. Callers
/// that skip the renderer still cannot persist secret-shaped leaves.
fn scrub_before_seal(value: &Value) -> Value {
    match value {
        Value::String(text) => Value::String(scrub_persisted_text(text)),
        other => {
            let walked = redact_json_like_ts(other);
            omit_surviving_secret_leaves(walked)
        }
    }
}

fn scrub_persisted_text(value: &str) -> String {
    let trimmed = value.trim();
    if looks_like_json_document(trimmed) {
        if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
            let walked = redact_json_like_ts(&parsed);
            if let Ok(serialized) = serde_json::to_string(&walked) {
                return if secret_redaction::secret_marker_survives(&serialized) {
                    secret_redaction::omitted_marker().to_string()
                } else {
                    serialized
                };
            }
        }
    }
    secret_redaction::redact_secret_text_or_omit(value)
}

fn looks_like_json_document(value: &str) -> bool {
    (value.starts_with('{') && value.ends_with('}'))
        || (value.starts_with('[') && value.ends_with(']'))
}

/// Surgical string replacement plus sensitive-key elision. Mirrors
/// `redactSecretsFromObject` so native object payloads match TS JSON persist.
fn redact_json_like_ts(value: &Value) -> Value {
    match value {
        Value::String(text) => Value::String(secret_redaction::redact_secret_text(text)),
        Value::Array(items) => Value::Array(items.iter().map(redact_json_like_ts).collect()),
        Value::Object(map) => {
            let mut out = Map::with_capacity(map.len());
            for (key, child) in map {
                if secret_redaction::is_sensitive_key(key) {
                    out.insert(
                        key.clone(),
                        Value::String(secret_redaction::redacted_marker().to_string()),
                    );
                } else {
                    out.insert(key.clone(), redact_json_like_ts(child));
                }
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

fn omit_surviving_secret_leaves(value: Value) -> Value {
    match value {
        Value::String(text) if secret_redaction::secret_marker_survives(&text) => {
            Value::String(secret_redaction::omitted_marker().to_string())
        }
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(omit_surviving_secret_leaves)
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, child)| (key, omit_surviving_secret_leaves(child)))
                .collect(),
        ),
        other => other,
    }
}
pub fn list(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    thread_id: &str,
) -> Result<Vec<MessageRow>> {
    list_limited(tx, store, scope, thread_id, i64::MAX)
}

/// Return only the root-to-selected-head path for context assembly. Branch
/// alternatives stay durable and inspectable, but a continuation never feeds
/// an unselected branch back to the provider.
pub fn list_selected(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    thread_id: &str,
) -> Result<Vec<MessageRow>> {
    let head: Option<String> = tx
        .query_row(
            "SELECT COALESCE(selected_head_id,last_message_id) FROM thread WHERE workspace_id=?1 AND id=?2 AND deleted_at IS NULL",
            rusqlite::params![scope.workspace_id(), thread_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();
    list_branch(tx, store, scope, thread_id, head.as_deref())
}

/// An explicit None means the root before the first message, not the selected head.
pub fn list_branch(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    thread_id: &str,
    head: Option<&str>,
) -> Result<Vec<MessageRow>> {
    let rows = list(tx, store, scope, thread_id)?;
    let Some(head) = head else {
        return Ok(Vec::new());
    };
    let mut current = head.to_string();
    let by_id = rows
        .iter()
        .map(|row| (row.id.as_str(), row))
        .collect::<std::collections::HashMap<_, _>>();
    let mut selected = Vec::new();
    let mut seen = std::collections::HashSet::new();
    while seen.insert(current.clone()) {
        let Some(row) = by_id.get(current.as_str()) else {
            break;
        };
        selected.push((*row).clone());
        let Some(parent) = row.parent_message_id.clone() else {
            break;
        };
        current = parent;
    }
    selected.reverse();
    Ok(selected)
}

pub fn edit_parent(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    thread_id: &str,
    source: &str,
) -> Result<Option<String>> {
    let row = get_current(tx, store, scope, thread_id, source)?.ok_or_else(|| {
        StoreError::Invalid("The edited message is unavailable in this conversation.".into())
    })?;
    if row.kind != "user" || row.current_revision_state != "terminal" {
        return Err(StoreError::Invalid(
            "Only a saved user message can start an alternative.".into(),
        ));
    }
    Ok(row.parent_message_id)
}

fn decode_current(row: &rusqlite::Row<'_>, store: &Store, scope: &DataScope) -> Result<MessageRow> {
    let revision_id: String = row.get(7)?;
    let sealed = crate::store::vault::Sealed {
        ciphertext: row.get(11)?,
        nonce: row.get(12)?,
    };
    let detail: String = row.get(5)?;
    let content = open_json(store, &sealed, &raad(scope.workspace_id(), &revision_id))?;
    Ok(MessageRow {
        id: row.get(0)?,
        thread_id: row.get(1)?,
        sequence: row.get(2)?,
        kind: row.get(3)?,
        run_id: row.get(4)?,
        detail: serde_json::from_str(&detail).unwrap_or(Value::Null),
        parent_message_id: row.get(6)?,
        current_revision_id: revision_id,
        current_revision_number: row.get(8)?,
        current_revision_state: row.get(9)?,
        created_at: row.get(10)?,
        content,
    })
}

fn get_current(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    thread_id: &str,
    message_id: &str,
) -> Result<Option<MessageRow>> {
    let mut statement = tx.prepare(&format!(
        "{CURRENT_MESSAGE_SELECT}
         JOIN thread t ON t.id=m.thread_id AND t.workspace_id=m.workspace_id
         WHERE m.workspace_id=?1 AND m.thread_id=?2 AND m.id=?3
           AND m.deleted_at IS NULL AND t.deleted_at IS NULL
           AND r.workspace_id=m.workspace_id AND r.thread_id=m.thread_id AND r.message_id=m.id"
    ))?;
    let mut rows = statement.query(rusqlite::params![
        scope.workspace_id(),
        thread_id,
        message_id
    ])?;
    rows.next()?
        .map(|row| decode_current(row, store, scope))
        .transpose()
}

fn saved_message(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    thread_id: &str,
    message_id: &str,
) -> Result<MessageRow> {
    get_current(tx, store, scope, thread_id, message_id)?
        .ok_or_else(|| StoreError::Invalid("Message is unavailable in this conversation.".into()))
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
    let mut statement = tx.prepare(&format!(
        "{CURRENT_MESSAGE_SELECT}
         WHERE m.workspace_id=?1 AND m.thread_id=?2 AND m.deleted_at IS NULL
         ORDER BY m.seq LIMIT ?3 OFFSET ?4"
    ))?;
    let rows = statement.query_and_then(
        rusqlite::params![scope.workspace_id(), thread_id, limit.max(0), offset.max(0)],
        |row| decode_current(row, store, scope),
    )?;
    rows.collect()
}

/// Return the newest bounded window before an optional sequence cursor. The
/// cursor is a durable sequence boundary rather than an offset, so appending
/// a new message cannot shift an already visible older page.
pub fn list_before(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    thread_id: &str,
    limit: i64,
    before_sequence: Option<i64>,
) -> Result<Vec<MessageRow>> {
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM thread WHERE workspace_id=?1 AND id=?2 AND deleted_at IS NULL)",
        rusqlite::params![scope.workspace_id(), thread_id],
        |row| row.get(0),
    )?;
    if !exists {
        return Err(StoreError::Invalid(
            "Thread does not belong to this workspace.".into(),
        ));
    }
    let mut statement = tx.prepare(&format!(
        "{CURRENT_MESSAGE_SELECT}
         WHERE m.workspace_id=?1 AND m.thread_id=?2 AND m.deleted_at IS NULL AND (?3 IS NULL OR m.seq < ?3)
         ORDER BY m.seq DESC LIMIT ?4"
    ))?;
    let rows = statement.query_and_then(
        rusqlite::params![
            scope.workspace_id(),
            thread_id,
            before_sequence,
            limit.max(1),
        ],
        |row| decode_current(row, store, scope),
    )?;
    let mut decoded = rows.collect::<Result<Vec<_>>>()?;
    decoded.reverse();
    Ok(decoded)
}

/// Return bounded durable leaf IDs so a newest-page read can still expose
/// alternatives whose content is outside the loaded message window.
pub fn list_branch_heads(
    tx: &Connection,
    scope: &DataScope,
    thread_id: &str,
    limit: i64,
) -> Result<Vec<String>> {
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM thread WHERE workspace_id=?1 AND id=?2 AND deleted_at IS NULL)",
        rusqlite::params![scope.workspace_id(), thread_id],
        |row| row.get(0),
    )?;
    if !exists {
        return Err(StoreError::Invalid(
            "Thread does not belong to this workspace.".into(),
        ));
    }
    let mut statement = tx.prepare(
        r#"SELECT m.id
           FROM message m
           WHERE m.workspace_id=?1 AND m.thread_id=?2 AND m.deleted_at IS NULL
             AND m.kind IN ('user','assistant')
             AND NOT EXISTS (
                 SELECT 1 FROM message child
                 WHERE child.workspace_id=m.workspace_id AND child.thread_id=m.thread_id
                   AND child.deleted_at IS NULL AND child.parent_message_id=m.id
             )
           ORDER BY m.seq DESC
           LIMIT ?3"#,
    )?;
    let mut result = statement
        .query_map(
            rusqlite::params![scope.workspace_id(), thread_id, limit.max(1)],
            |row| row.get::<_, String>(0),
        )?
        .map(|row| row.map_err(StoreError::from))
        .collect::<Result<Vec<_>>>()?;
    // The query is descending so the bounded window retains the newest
    // alternatives. Return chronological order to keep picker and transport
    // output stable for callers.
    result.reverse();
    Ok(result)
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
    append_with_parent(
        tx,
        store,
        scope,
        thread_id,
        id,
        kind,
        detail,
        run_id,
        sequence,
        expected,
        previous,
        None,
        idempotency,
        revision_id,
        state,
        reason,
        content,
        checkpointed_at,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn append_with_parent(
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
    parent: Option<Option<&str>>,
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
    let head:Option<(i64,Option<String>,Option<String>)>=tx.query_row("SELECT last_sequence,last_message_id,selected_head_id FROM thread WHERE workspace_id=?1 AND id=?2 AND deleted_at IS NULL",rusqlite::params![scope.workspace_id(),thread_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    let Some((last, last_id, selected_head)) = head else {
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
            return saved_message(tx, store, scope, thread_id, &id);
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
    let detail = scrub_before_seal(detail);
    let content = scrub_before_seal(content);
    let m = seal_json(store, &detail, &maad(scope.workspace_id(), &id))?;
    let r = seal_json(store, &content, &raad(scope.workspace_id(), &revision_id))?;
    let detail_text = serde_json::to_string(&detail)
        .map_err(|_| StoreError::Invalid("Message detail cannot be encoded.".into()))?;
    let parent = parent.unwrap_or(selected_head.as_deref().or(previous));
    if let Some(parent_id) = parent {
        let belongs: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM message WHERE workspace_id=?1 AND thread_id=?2 AND id=?3 AND deleted_at IS NULL)",
            rusqlite::params![scope.workspace_id(), thread_id, parent_id],
            |r| r.get(0),
        )?;
        if !belongs {
            return Err(StoreError::Invalid(
                "Message branch parent does not belong to this conversation.".into(),
            ));
        }
    }
    tx.execute("INSERT INTO message (id,workspace_id,thread_id,kind,run_id,detail_kind,seq,previous_message_id,parent_message_id,idempotency_key,current_revision_id,current_revision_number,current_revision_state,created_at,payload,payload_nonce) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,1,?12,?13,?14,?15)",rusqlite::params![id,scope.workspace_id(),thread_id,kind,run_id,detail_text,sequence,previous,parent,idempotency,revision_id,state,checkpointed_at,m.ciphertext,m.nonce])?;
    tx.execute("INSERT INTO message_revision (id,workspace_id,thread_id,message_id,revision_number,base_revision_number,state,reason,idempotency_key,checkpointed_at,created_at,run_id,payload,payload_nonce) VALUES (?1,?2,?3,?4,1,0,?5,?6,?7,?8,?8,?9,?10,?11)",rusqlite::params![revision_id,scope.workspace_id(),thread_id,id,state,reason,idempotency,checkpointed_at,run_id,r.ciphertext,r.nonce])?;
    tx.execute("UPDATE thread SET last_sequence=?1,last_message_id=?2,selected_head_id=?2,updated_at=?3 WHERE workspace_id=?4 AND id=?5",rusqlite::params![sequence,id,checkpointed_at,scope.workspace_id(),thread_id])?;
    saved_message(tx, store, scope, thread_id, &id)
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
            return saved_message(tx, store, scope, thread_id, message_id);
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
    let content = scrub_before_seal(content);
    let sealed = seal_json(store, &content, &raad(scope.workspace_id(), revision_id))?;
    let next = num + 1;
    tx.execute("INSERT INTO message_revision (id,workspace_id,thread_id,message_id,revision_number,base_revision_number,previous_revision_id,state,reason,idempotency_key,checkpointed_at,created_at,run_id,payload,payload_nonce) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11,?12,?13,?14)",rusqlite::params![revision_id,scope.workspace_id(),thread_id,message_id,next,base,previous,state,reason,idempotency,at,run_id,sealed.ciphertext,sealed.nonce])?;
    tx.execute("UPDATE message SET current_revision_id=?1,current_revision_number=?2,current_revision_state=?3,revision=revision+1 WHERE workspace_id=?4 AND thread_id=?5 AND id=?6",rusqlite::params![revision_id,next,state,scope.workspace_id(),thread_id,message_id])?;
    saved_message(tx, store, scope, thread_id, message_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::repos::thread;
    use crate::store::vault::{MasterKey, Vault};

    const GITHUB_PAT: &str = "ghp_abcdefghijklmnopqrstuvwx1234567890";
    const ANTHROPIC_KEY: &str = "sk-ant-12345678901234567890abc123";
    const TIME: &str = "2026-09-16T00:00:00.000Z";

    fn store() -> Store {
        Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap()
    }

    fn seed_thread(store: &Store, workspace: &str, thread_id: &str) -> DataScope {
        store
            .transaction(|tx| {
                tx.execute(
                    "INSERT INTO workspace(id,name,created_at,updated_at) VALUES (?1,?1,?2,?2)",
                    rusqlite::params![workspace, TIME],
                )?;
                thread::create(
                    tx,
                    store,
                    &DataScope::workspace(workspace)?,
                    thread_id,
                    None,
                    "Thread",
                    TIME,
                    &serde_json::json!({}),
                )?;
                Ok(())
            })
            .unwrap();
        DataScope::workspace(workspace).unwrap()
    }

    #[allow(clippy::too_many_arguments)]
    fn append_row(
        store: &Store,
        scope: &DataScope,
        thread_id: &str,
        id: &str,
        kind: &str,
        detail: &Value,
        sequence: i64,
        expected: i64,
        previous: Option<&str>,
        content: &Value,
    ) -> Result<MessageRow> {
        store.transaction(|tx| {
            append(
                tx,
                store,
                scope,
                thread_id,
                id,
                kind,
                detail,
                None,
                sequence,
                expected,
                previous,
                &format!("idempotency-{id}"),
                &format!("revision-{id}"),
                "terminal",
                "test",
                content,
                TIME,
            )
        })
    }

    #[test]
    fn scrub_keeps_ordinary_prose_and_json_shape() {
        let prose = serde_json::json!("Launch plan milestone");
        assert_eq!(scrub_before_seal(&prose), prose);
        let object = serde_json::json!({"text": "read-file src/index.ts", "ok": true, "n": 2});
        assert_eq!(scrub_before_seal(&object), object);
        assert!(scrub_before_seal(&Value::Null).is_null());
        assert_eq!(scrub_before_seal(&serde_json::json!(7)), 7);
    }

    #[test]
    fn scrub_redacts_string_leaves_like_typescript_or_omit() {
        let leaked = format!("Ship Friday. export GITHUB_TOKEN={GITHUB_PAT} then deploy.");
        let redacted = scrub_before_seal(&Value::String(leaked));
        let text = redacted.as_str().expect("string content");
        assert!(text.contains("Ship Friday"));
        assert!(text.contains("then deploy"));
        assert!(!text.contains(GITHUB_PAT));
        assert!(text.contains(secret_redaction::redacted_marker()));
    }

    #[test]
    fn scrub_omits_when_a_survivor_remains() {
        let omitted =
            scrub_before_seal(&Value::String("export GITHUB_TOKEN=ghp_short".to_string()));
        assert_eq!(omitted.as_str(), Some(secret_redaction::omitted_marker()));
    }

    #[test]
    fn scrub_redacts_sensitive_keys_and_json_encoded_tool_payloads() {
        let object = serde_json::json!({
            "command": "env",
            "token": "super-secret-token",
            "nested": { "note": "ok", "apiKey": "still-secret" }
        });
        let redacted = scrub_before_seal(&object);
        assert_eq!(redacted["command"], "env");
        assert_eq!(redacted["token"], secret_redaction::redacted_marker());
        assert_eq!(redacted["nested"]["note"], "ok");
        assert_eq!(
            redacted["nested"]["apiKey"],
            secret_redaction::redacted_marker()
        );

        let encoded = serde_json::to_string(&object).unwrap();
        let as_string = scrub_before_seal(&Value::String(encoded));
        let parsed: Value = serde_json::from_str(as_string.as_str().expect("json string")).unwrap();
        assert_eq!(parsed["token"], secret_redaction::redacted_marker());
        assert!(!as_string.as_str().unwrap().contains("super-secret-token"));
    }

    #[test]
    fn append_and_revise_seal_scrubbed_content_not_raw_secrets() {
        let store = store();
        let scope = seed_thread(&store, "alpha", "thread-one");
        let leaked = format!("Authorization: Bearer abcdefghij1234567890 and {ANTHROPIC_KEY}");
        let detail = serde_json::json!({
            "phase": "result",
            "note": format!("token={GITHUB_PAT}")
        });
        let row = append_row(
            &store,
            &scope,
            "thread-one",
            "message-1",
            "assistant",
            &detail,
            1,
            0,
            None,
            &Value::String(leaked),
        )
        .unwrap();
        let content = row.content.as_str().expect("string content");
        assert!(!content.contains("abcdefghij1234567890"));
        assert!(!content.contains(ANTHROPIC_KEY));
        assert!(content.contains(secret_redaction::redacted_marker()));
        let detail_text = row.detail["note"].as_str().expect("detail note");
        assert!(!detail_text.contains(GITHUB_PAT));
        assert!(!serde_json::to_string(&row.detail)
            .unwrap()
            .contains(GITHUB_PAT));

        let revised = store
            .transaction(|tx| {
                revise(
                    tx,
                    &store,
                    &scope,
                    "thread-one",
                    "message-1",
                    "revision-2",
                    1,
                    Some("revision-message-1"),
                    "idempotency-revision-2",
                    "terminal",
                    "stream-checkpoint",
                    &serde_json::json!({
                        "text": format!("keep this {GITHUB_PAT} around")
                    }),
                    None,
                    TIME,
                )
            })
            .unwrap();
        let text = revised.content["text"].as_str().expect("object text");
        assert!(text.contains("keep this"));
        assert!(text.contains("around"));
        assert!(!text.contains(GITHUB_PAT));
        assert_eq!(revised.current_revision_id, "revision-2");
        assert_eq!(revised.current_revision_number, 2);
    }

    #[test]
    fn bounded_older_window_uses_sequence_cursor_and_keeps_order() {
        let store = store();
        let scope = seed_thread(&store, "alpha", "thread-one");
        for sequence in 1..=4 {
            let previous = (sequence > 1).then(|| format!("message-{}", sequence - 1));
            append_row(
                &store,
                &scope,
                "thread-one",
                &format!("message-{sequence}"),
                "assistant",
                &Value::Null,
                sequence,
                sequence - 1,
                previous.as_deref(),
                &Value::String(format!("message {sequence}")),
            )
            .unwrap();
        }
        let newest = store
            .with_conn(|tx| list_before(tx, &store, &scope, "thread-one", 3, None))
            .unwrap();
        assert_eq!(
            newest.iter().map(|row| row.sequence).collect::<Vec<_>>(),
            vec![2, 3, 4]
        );
        let older = store
            .with_conn(|tx| list_before(tx, &store, &scope, "thread-one", 3, Some(2)))
            .unwrap();
        assert_eq!(
            older.iter().map(|row| row.sequence).collect::<Vec<_>>(),
            vec![1]
        );
    }

    #[test]
    fn branch_heads_follow_parent_not_append_predecessor_and_keep_newest_window() {
        let store = store();
        let scope = seed_thread(&store, "alpha", "thread-one");
        append_row(
            &store,
            &scope,
            "thread-one",
            "user-1",
            "user",
            &Value::Null,
            1,
            0,
            None,
            &Value::String("Question".into()),
        )
        .unwrap();
        append_row(
            &store,
            &scope,
            "thread-one",
            "answer-1",
            "assistant",
            &Value::Null,
            2,
            1,
            Some("user-1"),
            &Value::String("First answer".into()),
        )
        .unwrap();

        // This alternative is appended after answer-1 for monotonic storage,
        // but both answers belong to the same user turn. A predecessor link
        // must not make answer-1 disappear from the branch picker.
        store
            .transaction(|tx| {
                append_with_parent(
                    tx,
                    &store,
                    &scope,
                    "thread-one",
                    "answer-2",
                    "assistant",
                    &Value::Null,
                    None,
                    3,
                    2,
                    Some("answer-1"),
                    Some(Some("user-1")),
                    "idempotency-answer-2",
                    "revision-answer-2",
                    "terminal",
                    "test",
                    &Value::String("Alternative answer".into()),
                    TIME,
                )
            })
            .unwrap();

        let heads = store
            .with_conn(|tx| list_branch_heads(tx, &scope, "thread-one", 2))
            .unwrap();
        assert_eq!(heads, vec!["answer-1", "answer-2"]);

        // A smaller bounded window keeps the newest head rather than the
        // oldest row, while callers separately add the selected head when it
        // falls outside this window.
        let newest = store
            .with_conn(|tx| list_branch_heads(tx, &scope, "thread-one", 1))
            .unwrap();
        assert_eq!(newest, vec!["answer-2"]);
    }

    #[test]
    fn append_idempotent_replay_does_not_reseal_or_change_aad() {
        let store = store();
        let scope = seed_thread(&store, "alpha", "thread-one");
        let content = serde_json::json!("ordinary checkpoint");
        let first = append_row(
            &store,
            &scope,
            "thread-one",
            "message-1",
            "user",
            &serde_json::json!({"kind": "text"}),
            1,
            0,
            None,
            &content,
        )
        .unwrap();
        let replay = append_row(
            &store,
            &scope,
            "thread-one",
            "message-1",
            "user",
            &serde_json::json!({"kind": "text"}),
            1,
            0,
            None,
            &serde_json::json!(format!("later leak {GITHUB_PAT}")),
        )
        .unwrap();
        assert_eq!(replay.id, first.id);
        assert_eq!(replay.content, first.content);
        assert_eq!(replay.content, content);
        assert_eq!(replay.current_revision_id, first.current_revision_id);
    }

    fn revise_row(
        store: &Store,
        scope: &DataScope,
        base: &MessageRow,
        content: &Value,
    ) -> Result<MessageRow> {
        let revision_id = format!("{}-rev-{}", base.id, base.current_revision_number + 1);
        store.transaction(|tx| {
            revise(
                tx,
                store,
                scope,
                &base.thread_id,
                &base.id,
                &revision_id,
                base.current_revision_number,
                Some(&base.current_revision_id),
                &revision_id,
                "terminal",
                "test",
                content,
                None,
                TIME,
            )
        })
    }

    #[test]
    fn saves_authenticate_only_the_message_they_return() {
        let store = store();
        let scope = seed_thread(&store, "alpha", "thread-one");
        let detail = serde_json::json!({"kind": "text"});
        let content = serde_json::json!("original content");
        let append = |id, sequence, previous| {
            append_row(
                &store,
                &scope,
                "thread-one",
                id,
                "user",
                &detail,
                sequence,
                sequence - 1,
                previous,
                &content,
            )
        };
        append("first", 1, None).unwrap();
        let second = append("second", 2, Some("first")).unwrap();
        store
            .with_conn(|tx| {
                tx.execute(
                    "UPDATE message_revision SET (payload, payload_nonce)=(
                    SELECT payload, payload_nonce FROM message_revision WHERE id='revision-second'
                 ) WHERE id='revision-first'",
                    [],
                )?;
                Ok(())
            })
            .unwrap();

        let third = append("third", 3, Some("second")).unwrap();
        assert_eq!(third.parent_message_id.as_deref(), Some("second"));
        assert_eq!(append("second", 2, Some("first")).unwrap().content, content);
        assert_eq!(
            store
                .with_conn(|tx| edit_parent(tx, &store, &scope, "thread-one", "second"))
                .unwrap(),
            Some("first".into()),
        );
        let revised_content = serde_json::json!({"text": "revision"});
        let revised = revise_row(&store, &scope, &second, &revised_content).unwrap();
        let latest = revise_row(&store, &scope, &revised, &content).unwrap();
        let replay = revise_row(&store, &scope, &second, &Value::Null).unwrap();
        let listed = store
            .with_conn(|tx| list_page(tx, &store, &scope, "thread-one", 1, 1))
            .unwrap();
        let expected = serde_json::to_value(&latest).unwrap();
        assert_eq!(serde_json::to_value(&replay).unwrap(), expected);
        assert_eq!(serde_json::to_value(&listed[0]).unwrap(), expected);
        assert_eq!(latest.current_revision_number, 3);
        assert_eq!(latest.content, content);
        assert!(matches!(append("first", 1, None), Err(StoreError::Vault)));
        assert!(matches!(
            store.with_conn(|tx| list(tx, &store, &scope, "thread-one")),
            Err(StoreError::Vault)
        ));
    }

    #[test]
    fn current_message_lookup_requires_a_live_message_in_a_live_scoped_thread() {
        let store = store();
        let scope = seed_thread(&store, "alpha", "thread-one");
        let other = seed_thread(&store, "beta", "thread-two");
        append_row(
            &store,
            &scope,
            "thread-one",
            "message-1",
            "user",
            &Value::Null,
            1,
            0,
            None,
            &Value::Null,
        )
        .unwrap();
        store
            .transaction(|tx| {
                assert!(get_current(tx, &store, &other, "thread-one", "message-1")?.is_none());
                assert!(get_current(tx, &store, &scope, "thread-two", "message-1")?.is_none());
                tx.execute(
                    "UPDATE thread SET deleted_at=?1 WHERE id='thread-one'",
                    [TIME],
                )?;
                assert!(get_current(tx, &store, &scope, "thread-one", "message-1")?.is_none());
                tx.execute(
                    "UPDATE thread SET deleted_at=NULL WHERE id='thread-one'",
                    [],
                )?;
                tx.execute(
                    "UPDATE message SET deleted_at=?1 WHERE id='message-1'",
                    [TIME],
                )?;
                assert!(get_current(tx, &store, &scope, "thread-one", "message-1")?.is_none());
                Ok(())
            })
            .unwrap();
    }

    #[test]
    #[ignore = "manual encrypted-store benchmark"]
    fn message_save_benchmark() {
        use crate::store::vault::OPEN_COUNT;
        use std::time::{Duration, Instant};

        fn measure<T>(
            samples: &mut Vec<(Duration, usize)>,
            operation: impl FnOnce() -> Result<T>,
        ) -> T {
            let before = OPEN_COUNT.with(|count| count.get());
            let start = Instant::now();
            let result = operation().unwrap();
            samples.push((
                start.elapsed(),
                OPEN_COUNT.with(|count| count.get()) - before,
            ));
            result
        }

        const EXISTING: i64 = 2_048;
        const SAMPLES: i64 = 51;
        let store = store();
        let scope = seed_thread(&store, "alpha", "thread-one");
        let content = Value::String("Ordinary message text. ".repeat(45));
        let append = |sequence, previous: Option<&str>| {
            append_row(
                &store,
                &scope,
                "thread-one",
                &format!("message-{sequence}"),
                "assistant",
                &Value::Null,
                sequence,
                sequence - 1,
                previous,
                &content,
            )
        };
        let mut head = None;
        for sequence in 1..=EXISTING {
            head = Some(append(sequence, head.as_deref()).unwrap().id);
        }

        let (mut appends, mut revisions, mut pages) = (Vec::new(), Vec::new(), Vec::new());
        for sequence in EXISTING + 1..=EXISTING + SAMPLES {
            let row = measure(&mut appends, || append(sequence, head.as_deref()));
            let revised = measure(&mut revisions, || {
                revise_row(&store, &scope, &row, &content)
            });
            assert_eq!(revised.content, content);
            let page = measure(&mut pages, || {
                store.with_conn(|tx| list_before(tx, &store, &scope, "thread-one", 80, None))
            });
            assert_eq!(page.len(), 80);
            assert_eq!(
                page.last().unwrap().current_revision_id,
                revised.current_revision_id
            );
            head = Some(row.id);
        }
        for (label, samples) in [
            ("append", appends),
            ("revise", revisions),
            ("latest 80", pages),
        ] {
            let mut times = samples.iter().map(|sample| sample.0).collect::<Vec<_>>();
            let mut opens = samples.iter().map(|sample| sample.1).collect::<Vec<_>>();
            times.sort_unstable();
            opens.sort_unstable();
            println!(
                "{label}: median {:.3} ms, {} vault opens",
                times[times.len() / 2].as_secs_f64() * 1_000.0,
                opens[opens.len() / 2],
            );
        }
    }
}
