//! Encrypted, owner-qualified output documents and immutable revisions.
//!
//! Outputs are related to a conversation but are not conversation messages.
//! Every write re-resolves the authenticated account scope and checks the
//! caller's exact current revision, so a delayed agent response cannot replace
//! a newer user edit made in another pane.

use crate::authorized_scope::{command_scope, ScopeAccess};
use crate::collaboration::models::{Author, Conversation, Work};
use crate::store::repos::{
    collaboration::{self as collaboration_repo, Kind as CollaborationKind},
    message, open_json, payload_of, seal_json,
};
use crate::store::{Result as StoreResult, Store, StoreError};
use chrono::{SecondsFormat, Utc};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const MAX_TITLE: usize = 160;
const MAX_CONTENT: usize = 1_048_576;

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputSource {
    pub conversation_id: String,
    pub branch_id: Option<String>,
    pub message_id: Option<String>,
    pub source_revision_id: Option<String>,
    pub artifact_id: Option<String>,
    pub agent_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputProvenance {
    #[serde(flatten)]
    pub source: OutputSource,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputRevision {
    pub id: String,
    pub output_id: String,
    pub number: i64,
    pub base_number: i64,
    pub content: String,
    pub author: String,
    pub provenance: OutputProvenance,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputPin {
    pub revision_id: String,
    pub source: OutputSource,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputDocument {
    pub id: String,
    pub title: String,
    pub format: String,
    pub mime_type: String,
    pub source: OutputSource,
    pub revisions: Vec<OutputRevision>,
    pub current_revision_id: String,
    pub current_revision_number: i64,
    pub pinned: bool,
    pub pinned_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pin: Option<OutputPin>,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureInput {
    pub id: String,
    pub title: String,
    pub format: String,
    pub mime_type: String,
    pub source: OutputSource,
    pub content: String,
    pub author: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendInput {
    pub output_id: String,
    pub expected_revision_id: String,
    pub expected_revision_number: i64,
    pub content: String,
    pub author: String,
    pub provenance: OutputProvenance,
    pub revision_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreInput {
    pub output_id: String,
    pub revision_number: i64,
    pub expected_revision_id: String,
    pub expected_revision_number: i64,
    #[serde(rename = "source", default)]
    pub _source: Option<OutputSource>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinInput {
    pub output_id: String,
    pub pinned: bool,
    pub location: Option<OutputSource>,
    pub revision_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportInput {
    pub output_id: String,
    /// Kept for wire compatibility; native export chooses the destination
    /// through the OS save dialog rather than trusting a renderer path.
    pub destination: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListInput {
    pub conversation_id: Option<String>,
    pub include_unpinned: Option<bool>,
}

#[derive(Debug)]
struct OutputRow {
    id: String,
    format: String,
    mime_type: String,
    current_revision_id: String,
    current_revision_number: i64,
    pinned: bool,
    pinned_at: Option<String>,
    updated_at: String,
    payload: crate::store::vault::Sealed,
}

fn scope(
    workspace_id: &str,
    access: ScopeAccess,
) -> Result<crate::authorized_scope::AuthorizedCommandScope, String> {
    command_scope(Some(workspace_id.to_string()), None, access)
}

fn validate_id(value: &str, label: &str) -> StoreResult<()> {
    if value.is_empty()
        || value.len() > 256
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | ':' | '.'))
    {
        return Err(StoreError::Invalid(format!("{label} is invalid.")));
    }
    Ok(())
}

/// Authorize an output or artifact operation against the authenticated thread
/// and its persisted agent assignment. Renderer supplied conversation and agent
/// ids are never sufficient by themselves.
pub(crate) fn validate_conversation_agent(
    conn: &Connection,
    store: &Store,
    conversation_id: &str,
    agent_id: &str,
    scope: &crate::authorized_scope::AuthorizedCommandScope,
) -> StoreResult<()> {
    validate_id(conversation_id, "The source conversation")?;
    validate_id(agent_id, "The source agent")?;
    let owned: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM thread WHERE workspace_id=?1 AND id=?2 AND owner_member_id IS ?3 AND deleted_at IS NULL)",
        rusqlite::params![scope.data.workspace_id(), conversation_id, scope.member_id.as_deref()],
        |row| row.get(0),
    )?;
    if !owned {
        return Err(StoreError::Invalid(
            "The source conversation is not owned by this account.".into(),
        ));
    }
    let room = collaboration_repo::get::<Conversation>(
        conn,
        store,
        &scope.private,
        CollaborationKind::Conversation,
        conversation_id,
    )?
    .ok_or_else(|| {
        StoreError::Invalid("The source conversation assignment is unavailable.".into())
    })?;
    let room_assignment = room
        .participants
        .iter()
        .any(|participant| participant.agent_id == agent_id)
        || room.facilitator_id.as_deref() == Some(agent_id);
    let delegated_assignment = if room_assignment {
        false
    } else {
        collaboration_repo::list::<Work>(conn, store, &scope.private, CollaborationKind::Work)?
            .into_iter()
            .any(|work| {
                work.workspace_recipient
                    && work.conversation_id == conversation_id
                    && work.agent_id == agent_id
            })
    };
    if !room_assignment && !delegated_assignment {
        return Err(StoreError::Invalid(
            "The source agent is not assigned to this conversation or its delegated workspace work.".into(),
        ));
    }
    Ok(())
}

fn validate_source(
    conn: &Connection,
    store: &Store,
    source: &OutputSource,
    scope: &crate::authorized_scope::AuthorizedCommandScope,
) -> StoreResult<()> {
    validate_id(&source.conversation_id, "The source conversation")?;
    let owned: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM thread WHERE workspace_id=?1 AND id=?2 AND owner_member_id IS ?3 AND deleted_at IS NULL)",
        rusqlite::params![scope.data.workspace_id(), source.conversation_id, scope.member_id.as_deref()],
        |row| row.get(0),
    )?;
    if !owned {
        return Err(StoreError::Invalid(
            "The source conversation is not owned by this account.".into(),
        ));
    }
    if let Some(agent_id) = source.agent_id.as_deref() {
        if let Some(message_id) = source.message_id.as_deref() {
            let message_row = message::list(conn, store, &scope.data, &source.conversation_id)?
                .into_iter()
                .find(|row| row.id == message_id)
                .ok_or_else(|| {
                    StoreError::Invalid("The output source message is unavailable.".into())
                })?;
            let Some(run_id) = message_row.run_id.as_deref() else {
                return Err(StoreError::Invalid(
                    "User and system messages cannot be attributed to an agent.".into(),
                ));
            };
            let author = collaboration_repo::get::<Author>(
                conn,
                store,
                &scope.private,
                CollaborationKind::Author,
                run_id,
            )?
            .ok_or_else(|| {
                StoreError::Invalid("The source message author is unavailable.".into())
            })?;
            if !source_agent_matches_author(source, &author) {
                return Err(StoreError::Invalid(
                    "The output source agent does not own its source message.".into(),
                ));
            }
        } else {
            let room = collaboration_repo::get::<Conversation>(
                conn,
                store,
                &scope.private,
                CollaborationKind::Conversation,
                &source.conversation_id,
            )?
            .ok_or_else(|| {
                StoreError::Invalid("The source conversation record is unavailable.".into())
            })?;
            if !room
                .participants
                .iter()
                .any(|participant| participant.agent_id == agent_id)
                && room.facilitator_id.as_deref() != Some(agent_id)
            {
                return Err(StoreError::Invalid(
                    "The output source agent is not a participant in its conversation.".into(),
                ));
            }
        }
    }
    for message_id in [source.message_id.as_deref(), source.branch_id.as_deref()]
        .into_iter()
        .flatten()
    {
        let belongs: bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM message WHERE workspace_id=?1 AND thread_id=?2 AND id=?3 AND deleted_at IS NULL)",rusqlite::params![scope.data.workspace_id(),source.conversation_id,message_id],|row|row.get(0))?;
        if !belongs {
            return Err(StoreError::Invalid(
                "The output passage or branch does not belong to its conversation.".into(),
            ));
        }
    }
    if let Some(revision_id) = source.source_revision_id.as_deref() {
        let belongs: bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM message_revision r JOIN message m ON m.id=r.message_id WHERE m.workspace_id=?1 AND m.thread_id=?2 AND r.id=?3 AND (?4 IS NULL OR m.id=?4) AND m.deleted_at IS NULL)",rusqlite::params![scope.data.workspace_id(),source.conversation_id,revision_id,source.message_id],|row|row.get(0))?;
        if !belongs {
            return Err(StoreError::Invalid(
                "The source revision does not belong to the saved conversation passage.".into(),
            ));
        }
    }
    for value in [
        source.branch_id.as_deref(),
        source.message_id.as_deref(),
        source.source_revision_id.as_deref(),
        source.artifact_id.as_deref(),
        source.agent_id.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        validate_id(value, "The output source")?;
    }
    Ok(())
}

fn validate_content(content: &str) -> StoreResult<()> {
    if content.len() > MAX_CONTENT {
        return Err(StoreError::Invalid(
            "This output is too large to edit in Mivlet.".into(),
        ));
    }
    Ok(())
}

/// Generic output revisions are limited to formats whose structure can be
/// validated and edited by the conversation output surface. Office files and
/// other binary/document formats must use their dedicated native editor.
pub(crate) fn validate_generic_revision_format(format: &str) -> StoreResult<()> {
    if matches!(format, "text" | "markdown" | "csv" | "json") {
        Ok(())
    } else {
        Err(StoreError::Invalid(
            "Edit this file using its format-specific native editor.".into(),
        ))
    }
}

fn validate_csv(content: &str) -> StoreResult<()> {
    const MAX_ROWS: usize = 10_000;
    const MAX_COLUMNS: usize = 256;
    let mut chars = content.chars().peekable();
    let mut in_quotes = false;
    let mut after_quote = false;
    let mut field_started = false;
    let mut columns = 0usize;
    let mut rows = 0usize;

    let invalid =
        || StoreError::Invalid("The CSV output is malformed or too large to edit safely.".into());
    let finish_field = |columns: &mut usize| -> StoreResult<()> {
        *columns += 1;
        if *columns > MAX_COLUMNS {
            return Err(invalid());
        }
        Ok(())
    };
    let finish_row = |columns: &mut usize, rows: &mut usize| -> StoreResult<()> {
        if *columns == 0 {
            return Err(invalid());
        }
        *rows += 1;
        if *rows > MAX_ROWS {
            return Err(invalid());
        }
        *columns = 0;
        Ok(())
    };

    while let Some(character) = chars.next() {
        if in_quotes {
            if character == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                } else {
                    in_quotes = false;
                    after_quote = true;
                }
            }
            continue;
        }
        if after_quote {
            match character {
                ',' => {
                    finish_field(&mut columns)?;
                    field_started = false;
                    after_quote = false;
                }
                '\n' => {
                    finish_field(&mut columns)?;
                    finish_row(&mut columns, &mut rows)?;
                    field_started = false;
                    after_quote = false;
                }
                '\r' => {
                    finish_field(&mut columns)?;
                    finish_row(&mut columns, &mut rows)?;
                    if chars.peek() == Some(&'\n') {
                        chars.next();
                    }
                    field_started = false;
                    after_quote = false;
                }
                _ => return Err(invalid()),
            }
            continue;
        }
        match character {
            '"' if !field_started => {
                in_quotes = true;
                field_started = true;
            }
            '"' => return Err(invalid()),
            ',' => {
                finish_field(&mut columns)?;
                field_started = false;
            }
            '\n' => {
                finish_field(&mut columns)?;
                finish_row(&mut columns, &mut rows)?;
                field_started = false;
            }
            '\r' => {
                finish_field(&mut columns)?;
                finish_row(&mut columns, &mut rows)?;
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                field_started = false;
            }
            _ => field_started = true,
        }
    }
    if in_quotes {
        return Err(invalid());
    }
    if after_quote || field_started || columns > 0 {
        finish_field(&mut columns)?;
        finish_row(&mut columns, &mut rows)?;
    }
    Ok(())
}

/// Renderer supplied metadata is only a request for a user initiated output
/// change. Authorship and provenance for agent revisions are admitted by the
/// native runtime (`collaboration::output_revisions`) through `append_output`;
/// they must never be forgeable by invoking the renderer command directly.
fn validate_renderer_ensure(input: &EnsureInput) -> StoreResult<()> {
    if input
        .author
        .as_deref()
        .is_some_and(|author| author != "system")
    {
        return Err(StoreError::Invalid(
            "Output authorship is controlled by Mivlet.".into(),
        ));
    }
    if input
        .reason
        .as_deref()
        .is_some_and(|reason| reason != "generated")
    {
        return Err(StoreError::Invalid(
            "Output provenance is controlled by Mivlet.".into(),
        ));
    }
    Ok(())
}

fn validate_renderer_append(input: &AppendInput) -> StoreResult<()> {
    if input.author != "user" || input.provenance.reason != "direct-edit" {
        return Err(StoreError::Invalid(
            "Renderer output revisions must be user direct edits.".into(),
        ));
    }
    Ok(())
}

fn validate_format(format: &str, content: &str) -> StoreResult<()> {
    validate_generic_revision_format(format)?;
    match format {
        "text" | "markdown" => Ok(()),
        "csv" => validate_csv(content),
        "json" => serde_json::from_str::<Value>(content)
            .map(|_| ())
            .map_err(|_| {
                StoreError::Invalid(
                    "The output must contain valid JSON before it can be saved.".into(),
                )
            }),
        _ => unreachable!("generic format validation should reject this format"),
    }
}

fn main_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Open this output in the Mivlet workspace.".into());
    }
    Ok(())
}

fn aad(
    scope: &crate::store::repos::scope::PrivateDataScope,
    output_id: &str,
    revision_id: &str,
) -> String {
    format!(
        "output:{}:{}:{}:{}",
        scope.workspace_id(),
        scope.owner_subject(),
        output_id,
        revision_id
    )
}

fn decode_revision(
    store: &Store,
    scope: &crate::authorized_scope::AuthorizedCommandScope,
    output_id: &str,
    revision_id: &str,
    number: i64,
    base_number: i64,
    author: String,
    created_at: String,
    payload: crate::store::vault::Sealed,
) -> StoreResult<OutputRevision> {
    let value = open_json(
        store,
        &payload,
        &aad(&scope.private, output_id, revision_id),
    )?;
    let content = value
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| StoreError::Invalid("The saved output revision is invalid.".into()))?;
    let provenance: OutputProvenance =
        serde_json::from_value(value.get("provenance").cloned().ok_or_else(|| {
            StoreError::Invalid("The saved output provenance is invalid.".into())
        })?)
        .map_err(|_| StoreError::Invalid("The saved output provenance is invalid.".into()))?;
    Ok(OutputRevision {
        id: revision_id.to_string(),
        output_id: output_id.to_string(),
        number,
        base_number,
        content: content.to_string(),
        author,
        provenance,
        created_at,
    })
}

pub(crate) fn read_row(
    conn: &Connection,
    store: &Store,
    scope: &crate::authorized_scope::AuthorizedCommandScope,
    id: &str,
) -> StoreResult<Option<OutputDocument>> {
    let row = conn.query_row(
        "SELECT id,format,mime_type,source_conversation_id,current_revision_id,current_revision_number,pinned,pinned_at,updated_at,payload,payload_nonce FROM output_record WHERE workspace_id=?1 AND owner_subject=?2 AND id=?3",
        rusqlite::params![scope.data.workspace_id(), scope.private.owner_subject(), id],
        |row| Ok(OutputRow { id: row.get(0)?, format: row.get(1)?, mime_type: row.get(2)?, current_revision_id: row.get(4)?, current_revision_number: row.get(5)?, pinned: row.get::<_, i64>(6)? != 0, pinned_at: row.get(7)?, updated_at: row.get(8)?, payload: payload_of(row)? }),
    ).optional()?;
    let Some(row) = row else {
        return Ok(None);
    };
    let metadata = open_json(
        store,
        &row.payload,
        &format!(
            "output-meta:{}:{}:{}",
            scope.data.workspace_id(),
            scope.private.owner_subject(),
            id
        ),
    )?;
    let title = metadata
        .get("title")
        .and_then(Value::as_str)
        .ok_or_else(|| StoreError::Invalid("The saved output title is invalid.".into()))?
        .to_string();
    let source: OutputSource = serde_json::from_value(
        metadata
            .get("source")
            .cloned()
            .ok_or_else(|| StoreError::Invalid("The saved output source is invalid.".into()))?,
    )
    .map_err(|_| StoreError::Invalid("The saved output metadata is invalid.".into()))?;
    let mut revisions = Vec::new();
    let mut stmt = conn.prepare("SELECT id,revision_number,base_revision_number,author,created_at,payload,payload_nonce FROM output_revision WHERE workspace_id=?1 AND owner_subject=?2 AND output_id=?3 ORDER BY revision_number")?;
    let rows = stmt.query_map(
        rusqlite::params![scope.data.workspace_id(), scope.private.owner_subject(), id],
        |record| {
            Ok((
                record.get::<_, String>(0)?,
                record.get::<_, i64>(1)?,
                record.get::<_, i64>(2)?,
                record.get::<_, String>(3)?,
                record.get::<_, String>(4)?,
                payload_of(record)?,
            ))
        },
    )?;
    for record in rows {
        let (revision_id, number, base_number, author, created_at, payload) = record?;
        revisions.push(decode_revision(
            store,
            scope,
            id,
            &revision_id,
            number,
            base_number,
            author,
            created_at,
            payload,
        )?);
    }
    Ok(Some(OutputDocument {
        id: row.id,
        title,
        format: row.format,
        mime_type: row.mime_type,
        source,
        revisions,
        current_revision_id: row.current_revision_id,
        current_revision_number: row.current_revision_number,
        pinned: row.pinned,
        pinned_at: row.pinned_at,
        pin: metadata
            .get("pin")
            .filter(|value| !value.is_null())
            .cloned()
            .map(serde_json::from_value)
            .transpose()
            .map_err(|_| StoreError::Invalid("The saved output pin is invalid.".into()))?,
        updated_at: row.updated_at,
    }))
}

pub(crate) fn ensure_output(
    conn: &Connection,
    store: &Store,
    scope: &crate::authorized_scope::AuthorizedCommandScope,
    input: EnsureInput,
) -> StoreResult<OutputDocument> {
    validate_id(&input.id, "The output id")?;
    if input.title.trim().is_empty() || input.title.chars().count() > MAX_TITLE {
        return Err(StoreError::Invalid("The output title is invalid.".into()));
    }
    validate_content(&input.content)?;
    validate_format(&input.format, &input.content)?;
    validate_source(conn, store, &input.source, scope)?;
    if let Some(existing) = read_row(conn, store, scope, &input.id)? {
        if !same_source_identity(&existing.source, &input.source) {
            return Err(StoreError::Invalid(
                "This output identity belongs to another source.".into(),
            ));
        }
        return Ok(existing);
    }
    let created = now();
    let revision_id = format!("{}-1", input.id);
    let author = input.author.unwrap_or_else(|| "system".into());
    let reason = input.reason.unwrap_or_else(|| "generated".into());
    let provenance = OutputProvenance {
        source: input.source.clone(),
        reason,
    };
    let payload = seal_json(
        store,
        &json!({ "content": input.content, "provenance": provenance }),
        &aad(&scope.private, &input.id, &revision_id),
    )?;
    let metadata = seal_json(
        store,
        &json!({ "title": input.title.trim(), "source": input.source }),
        &format!(
            "output-meta:{}:{}:{}",
            scope.data.workspace_id(),
            scope.private.owner_subject(),
            input.id
        ),
    )?;
    conn.execute("INSERT INTO output_record(workspace_id,owner_subject,id,format,mime_type,source_conversation_id,current_revision_id,current_revision_number,pinned,pinned_at,created_at,updated_at,payload,payload_nonce) VALUES(?1,?2,?3,?4,?5,?6,?7,1,0,NULL,?8,?8,?9,?10)", rusqlite::params![scope.data.workspace_id(), scope.private.owner_subject(), input.id, input.format, input.mime_type, input.source.conversation_id, revision_id, created, metadata.ciphertext, metadata.nonce])?;
    conn.execute("INSERT INTO output_revision(workspace_id,owner_subject,output_id,id,revision_number,base_revision_number,author,created_at,payload,payload_nonce) VALUES(?1,?2,?3,?4,1,0,?5,?6,?7,?8)", rusqlite::params![scope.data.workspace_id(), scope.private.owner_subject(), input.id, revision_id, author, created, payload.ciphertext, payload.nonce])?;
    read_row(conn, store, scope, &input.id)?
        .ok_or_else(|| StoreError::Invalid("The output could not be saved.".into()))
}

fn same_source_identity(left: &OutputSource, right: &OutputSource) -> bool {
    left.conversation_id == right.conversation_id
        && left.branch_id == right.branch_id
        && left.message_id == right.message_id
        && left.source_revision_id == right.source_revision_id
        && left.artifact_id == right.artifact_id
        && left.agent_id == right.agent_id
}

fn restore_source(current: &OutputDocument) -> OutputSource {
    current.source.clone()
}

fn source_agent_matches_author(source: &OutputSource, author: &Author) -> bool {
    source.conversation_id == author.conversation_id
        && source.agent_id.as_deref() == Some(author.agent_id.as_str())
}

fn normalize_renderer_append(
    conn: &Connection,
    store: &Store,
    scope: &crate::authorized_scope::AuthorizedCommandScope,
    mut input: AppendInput,
) -> StoreResult<AppendInput> {
    let current = read_row(conn, store, scope, &input.output_id)?
        .ok_or_else(|| StoreError::Invalid("The output is no longer available.".into()))?;
    let revision = current
        .revisions
        .iter()
        .find(|revision| revision.id == current.current_revision_id)
        .ok_or_else(|| StoreError::Invalid("The current output revision is unavailable.".into()))?;
    input.provenance.source = revision.provenance.source.clone();
    Ok(input)
}

pub(crate) fn append_output(
    conn: &Connection,
    store: &Store,
    scope: &crate::authorized_scope::AuthorizedCommandScope,
    input: AppendInput,
) -> StoreResult<OutputDocument> {
    validate_id(&input.output_id, "The output id")?;
    validate_content(&input.content)?;
    validate_source(conn, store, &input.provenance.source, scope)?;
    let current = read_row(conn, store, scope, &input.output_id)?
        .ok_or_else(|| StoreError::Invalid("The output is no longer available.".into()))?;
    validate_format(&current.format, &input.content)?;
    if current.source.conversation_id != input.provenance.source.conversation_id {
        return Err(StoreError::Invalid(
            "The revision belongs to another conversation.".into(),
        ));
    }
    if current.revisions.len() >= 256
        || current
            .revisions
            .iter()
            .map(|revision| revision.content.len())
            .sum::<usize>()
            + input.content.len()
            > 32 * MAX_CONTENT
    {
        return Err(StoreError::Invalid("This output has reached its saved revision limit. Export it before creating a new output.".into()));
    }
    if current.current_revision_id != input.expected_revision_id
        || current.current_revision_number != input.expected_revision_number
    {
        return Err(StoreError::Invalid(
            "This output changed in another pane. Reload it before saving your edit.".into(),
        ));
    }
    let number = current.current_revision_number + 1;
    let revision_id = input
        .revision_id
        .unwrap_or_else(|| format!("{}-{number}", input.output_id));
    validate_id(&revision_id, "The revision id")?;
    let created = now();
    let payload = seal_json(
        store,
        &json!({ "content": input.content, "provenance": input.provenance }),
        &aad(&scope.private, &input.output_id, &revision_id),
    )?;
    conn.execute("INSERT INTO output_revision(workspace_id,owner_subject,output_id,id,revision_number,base_revision_number,author,created_at,payload,payload_nonce) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)", rusqlite::params![scope.data.workspace_id(), scope.private.owner_subject(), input.output_id, revision_id, number, current.current_revision_number, input.author, created, payload.ciphertext, payload.nonce])?;
    conn.execute("UPDATE output_record SET current_revision_id=?1,current_revision_number=?2,updated_at=?3 WHERE workspace_id=?4 AND owner_subject=?5 AND id=?6 AND current_revision_id=?7 AND current_revision_number=?8", rusqlite::params![revision_id, number, created, scope.data.workspace_id(), scope.private.owner_subject(), input.output_id, input.expected_revision_id, input.expected_revision_number])?;
    if conn.changes() != 1 {
        return Err(StoreError::Invalid(
            "This output changed in another pane. Reload it before saving your edit.".into(),
        ));
    }
    read_row(conn, store, scope, &input.output_id)?
        .ok_or_else(|| StoreError::Invalid("The output could not be reloaded.".into()))
}

#[tauri::command]
pub fn output_ensure(
    window: tauri::WebviewWindow,
    workspace_id: String,
    input: EnsureInput,
) -> Result<OutputDocument, String> {
    main_window(&window)?;
    validate_renderer_ensure(&input).map_err(|e| e.to_string())?;
    let authorized = scope(&workspace_id, ScopeAccess::Write)?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Mivlet's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|conn| ensure_output(conn, store, &authorized, input))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn output_get(
    window: tauri::WebviewWindow,
    workspace_id: String,
    output_id: String,
) -> Result<Option<OutputDocument>, String> {
    main_window(&window)?;
    let authorized = scope(&workspace_id, ScopeAccess::Read)?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Mivlet's encrypted store is not initialized.".to_string())?;
    store
        .with_conn(|conn| read_row(conn, store, &authorized, &output_id))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn output_list(
    window: tauri::WebviewWindow,
    workspace_id: String,
    input: ListInput,
) -> Result<Vec<OutputDocument>, String> {
    main_window(&window)?;
    let authorized = scope(&workspace_id, ScopeAccess::Read)?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Mivlet's encrypted store is not initialized.".to_string())?;
    store.with_conn(|conn| {
        let mut stmt = conn.prepare("SELECT id FROM output_record WHERE workspace_id=?1 AND owner_subject=?2 AND (?3 IS NULL OR source_conversation_id=?3) AND (?4=1 OR pinned=1) ORDER BY updated_at DESC LIMIT 4096")?;
        let ids = stmt.query_map(rusqlite::params![authorized.data.workspace_id(), authorized.private.owner_subject(), input.conversation_id, input.include_unpinned.unwrap_or(true)], |row| row.get::<_, String>(0))?;
        ids.map(|id| read_row(conn, store, &authorized, &id?).and_then(|row| row.ok_or_else(|| StoreError::Invalid("An output disappeared while loading.".into())))).collect()
    }).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn output_append_revision(
    window: tauri::WebviewWindow,
    workspace_id: String,
    input: AppendInput,
) -> Result<OutputDocument, String> {
    main_window(&window)?;
    validate_renderer_append(&input).map_err(|e| e.to_string())?;
    let authorized = scope(&workspace_id, ScopeAccess::Write)?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Mivlet's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|conn| {
            let input = normalize_renderer_append(conn, store, &authorized, input)?;
            append_output(conn, store, &authorized, input)
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn output_restore_revision(
    window: tauri::WebviewWindow,
    workspace_id: String,
    input: RestoreInput,
) -> Result<OutputDocument, String> {
    main_window(&window)?;
    let authorized = scope(&workspace_id, ScopeAccess::Write)?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Mivlet's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|conn| {
            let current = read_row(conn, store, &authorized, &input.output_id)?
                .ok_or_else(|| StoreError::Invalid("The output is no longer available.".into()))?;
            let revision = current
                .revisions
                .iter()
                .find(|item| item.number == input.revision_number)
                .ok_or_else(|| {
                    StoreError::Invalid("That output revision is no longer available.".into())
                })?;
            append_output(
                conn,
                store,
                &authorized,
                AppendInput {
                    output_id: input.output_id,
                    expected_revision_id: input.expected_revision_id,
                    expected_revision_number: input.expected_revision_number,
                    content: revision.content.clone(),
                    author: "user".into(),
                    provenance: OutputProvenance {
                        // A renderer may request which historical content to
                        // restore, but it cannot rewrite the owning source
                        // identity while doing so. The durable current source
                        // remains authoritative for the new user revision.
                        source: restore_source(&current),
                        reason: "restore".into(),
                    },
                    revision_id: None,
                },
            )
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn output_set_pin(
    window: tauri::WebviewWindow,
    workspace_id: String,
    input: PinInput,
) -> Result<OutputDocument, String> {
    main_window(&window)?;
    let authorized = scope(&workspace_id, ScopeAccess::Write)?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Mivlet's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|conn| pin_output(conn, store, &authorized, input))
        .map_err(|e| e.to_string())
}

pub(crate) fn pin_output(
    conn: &Connection,
    store: &Store,
    authorized: &crate::authorized_scope::AuthorizedCommandScope,
    input: PinInput,
) -> StoreResult<OutputDocument> {
    let current = read_row(conn, store, authorized, &input.output_id)?
        .ok_or_else(|| StoreError::Invalid("The output is no longer available.".into()))?;
    if let Some(location) = input.location.as_ref() {
        validate_source(conn, store, location, authorized)?;
        if location.conversation_id != current.source.conversation_id {
            return Err(StoreError::Invalid(
                "The pin belongs to another conversation.".into(),
            ));
        }
    }
    let revision = current
        .revisions
        .iter()
        .find(|revision| {
            revision.id
                == *input
                    .revision_id
                    .as_ref()
                    .unwrap_or(&current.current_revision_id)
        })
        .ok_or_else(|| StoreError::Invalid("The pinned revision is unavailable.".into()))?;
    let pin = input.pinned.then(|| OutputPin {
        revision_id: revision.id.clone(),
        source: revision.provenance.source.clone(),
    });
    let metadata = seal_json(
        store,
        &json!({"title":current.title,"source":current.source,"pin":pin}),
        &format!(
            "output-meta:{}:{}:{}",
            authorized.data.workspace_id(),
            authorized.private.owner_subject(),
            current.id
        ),
    )?;
    conn.execute("UPDATE output_record SET pinned=?1,pinned_at=?2,updated_at=?3,payload=?4,payload_nonce=?5 WHERE workspace_id=?6 AND owner_subject=?7 AND id=?8",rusqlite::params![input.pinned,input.pinned.then(now),now(),metadata.ciphertext,metadata.nonce,authorized.data.workspace_id(),authorized.private.owner_subject(),current.id])?;
    read_row(conn, store, authorized, &current.id)?
        .ok_or_else(|| StoreError::Invalid("The output could not be reloaded.".into()))
}

#[tauri::command]
pub async fn output_export(
    window: tauri::WebviewWindow,
    workspace_id: String,
    input: ExportInput,
) -> Result<String, String> {
    use std::io::Write;
    main_window(&window)?;
    let authorized = scope(&workspace_id, ScopeAccess::Read)?;
    let store = crate::store::try_global().ok_or("Mivlet's encrypted store is not initialized.")?;
    let output = store
        .with_conn(|conn| read_row(conn, store, &authorized, &input.output_id))
        .map_err(|error| error.to_string())?
        .ok_or("The output is no longer available.")?;
    let revision = output
        .revisions
        .iter()
        .find(|revision| revision.id == output.current_revision_id)
        .ok_or("The saved revision is unavailable.")?;
    validate_format(&output.format, &revision.content).map_err(|error| error.to_string())?;
    let extension = match output.format.as_str() {
        "markdown" => "md",
        "json" => "json",
        "csv" => "csv",
        _ => "txt",
    };
    let file_name = format!("{}.{}", crate::paths::file_slug(&output.title), extension);
    let _ = input.destination;
    let Some(selected) = rfd::AsyncFileDialog::new()
        .set_file_name(&file_name)
        .add_filter("Output", &[extension])
        .save_file()
        .await
    else {
        return Err("Export cancelled.".into());
    };
    if scope(&workspace_id, ScopeAccess::Read)? != authorized {
        return Err("The account changed before export.".into());
    }
    let current = store
        .with_conn(|conn| read_row(conn, store, &authorized, &input.output_id))
        .map_err(|error| error.to_string())?
        .ok_or("The output is no longer available.")?;
    if current.current_revision_id != output.current_revision_id {
        return Err("The output changed while choosing a destination. Review its latest revision and export again.".into());
    }
    let path = selected.path();
    let parent = path.parent().ok_or("Choose a valid destination folder.")?;
    let mut staged = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| "Could not stage the output export.")?;
    staged
        .write_all(revision.content.as_bytes())
        .and_then(|_| staged.as_file().sync_all())
        .map_err(|_| "Could not write the output export.")?;
    if scope(&workspace_id, ScopeAccess::Read)? != authorized {
        return Err("The account changed before export.".into());
    }
    staged
        .persist_noclobber(path)
        .map_err(|_| "Choose a new file name. Mivlet does not overwrite an existing export.")?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collaboration::models::{Participant, WorkStatus};
    use crate::store::repos::{scope::DEFAULT_WORKSPACE_ID, thread};
    use crate::store::vault::{MasterKey, Vault};

    fn source() -> OutputSource {
        OutputSource {
            conversation_id: "conversation-1".into(),
            branch_id: Some("branch-1".into()),
            message_id: Some("message-1".into()),
            source_revision_id: Some("revision-1".into()),
            artifact_id: Some("artifact-1".into()),
            agent_id: Some("agent-1".into()),
        }
    }

    fn ensure(author: Option<&str>, reason: Option<&str>) -> EnsureInput {
        EnsureInput {
            id: "output-1".into(),
            title: "Output".into(),
            format: "text".into(),
            mime_type: "text/plain".into(),
            source: source(),
            content: "draft".into(),
            author: author.map(str::to_owned),
            reason: reason.map(str::to_owned),
        }
    }

    fn append(author: &str, reason: &str) -> AppendInput {
        AppendInput {
            output_id: "output-1".into(),
            expected_revision_id: "output-1-1".into(),
            expected_revision_number: 1,
            content: "edited".into(),
            author: author.into(),
            provenance: OutputProvenance {
                source: source(),
                reason: reason.into(),
            },
            revision_id: Some("output-1-2".into()),
        }
    }

    #[test]
    fn renderer_ensure_accepts_native_generated_metadata() {
        assert!(validate_renderer_ensure(&ensure(None, None)).is_ok());
        assert!(validate_renderer_ensure(&ensure(Some("system"), Some("generated"))).is_ok());
    }

    #[test]
    fn renderer_ensure_rejects_forged_agent_metadata() {
        assert!(validate_renderer_ensure(&ensure(Some("agent"), Some("agent-revision"))).is_err());
        assert!(validate_renderer_ensure(&ensure(Some("system"), Some("agent-revision"))).is_err());
        assert!(validate_renderer_ensure(&ensure(Some("agent"), Some("generated"))).is_err());
    }

    #[test]
    fn renderer_append_accepts_only_user_direct_edits() {
        assert!(validate_renderer_append(&append("user", "direct-edit")).is_ok());
    }

    #[test]
    fn renderer_append_rejects_forged_agent_revision() {
        assert!(validate_renderer_append(&append("agent", "agent-revision")).is_err());
        assert!(validate_renderer_append(&append("user", "agent-revision")).is_err());
        assert!(validate_renderer_append(&append("system", "direct-edit")).is_err());
    }

    #[test]
    fn output_identity_includes_agent_and_message_provenance() {
        let mut changed = source();
        assert!(same_source_identity(&source(), &changed));
        changed.agent_id = Some("another-agent".into());
        assert!(!same_source_identity(&source(), &changed));
        changed = source();
        changed.message_id = Some("another-message".into());
        assert!(!same_source_identity(&source(), &changed));
    }

    #[test]
    fn restoring_content_keeps_the_durable_output_source() {
        let current = OutputDocument {
            id: "output-1".into(),
            title: "Output".into(),
            format: "text".into(),
            mime_type: "text/plain".into(),
            source: source(),
            revisions: Vec::new(),
            current_revision_id: "output-1-2".into(),
            current_revision_number: 2,
            pinned: false,
            pinned_at: None,
            pin: None,
            updated_at: String::new(),
        };
        let mut forged = source();
        forged.agent_id = Some("another-agent".into());
        assert_eq!(restore_source(&current).agent_id, source().agent_id);
        assert_ne!(restore_source(&current).agent_id, forged.agent_id);
    }

    #[test]
    fn source_cannot_attribute_a_message_to_another_same_room_agent() {
        let actual = Author {
            run_id: "run-1".into(),
            conversation_id: "conversation-1".into(),
            agent_id: "agent-1".into(),
            name: "Agent One".into(),
            work_id: None,
            generation: 1,
        };
        let mut forged = source();
        forged.agent_id = Some("agent-2".into());
        assert!(!source_agent_matches_author(&forged, &actual));
        forged.agent_id = Some(actual.agent_id.clone());
        assert!(source_agent_matches_author(&forged, &actual));
    }

    #[test]
    fn csv_validation_accepts_rfc4180_quotes_and_empty_fields() {
        assert!(validate_format("csv", "name,value\r\n\"a,b\",2\r\n,").is_ok());
        assert!(validate_format("csv", "").is_ok());
    }

    #[test]
    fn csv_validation_rejects_unquoted_quotes_and_trailing_data() {
        assert!(validate_format("csv", "a\"b").is_err());
        assert!(validate_format("csv", "\"value\"tail").is_err());
        assert!(validate_format("csv", "\"unterminated").is_err());
    }

    #[test]
    fn generic_revision_boundary_rejects_native_document_formats() {
        for format in ["document", "spreadsheet", "presentation", "pdf", "image"] {
            assert!(
                validate_generic_revision_format(format).is_err(),
                "{format}"
            );
            assert!(
                validate_format(format, "plain preview").is_err(),
                "{format}"
            );
        }
        for format in ["text", "markdown", "csv", "json"] {
            assert!(validate_generic_revision_format(format).is_ok(), "{format}");
        }
    }

    #[test]
    fn office_conversation_authority_requires_owner_and_assignment() {
        let store =
            Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap();
        store
            .transaction(|conn| {
                let scope = crate::authorized_scope::resolve(
                    conn,
                    Some(DEFAULT_WORKSPACE_ID),
                    None,
                    ScopeAccess::Write,
                )?;
                let conversation = "office-authority";
                thread::create(
                    conn,
                    &store,
                    &scope.data,
                    conversation,
                    None,
                    "Office authority",
                    "2026-10-08T00:00:00Z",
                    &serde_json::json!({}),
                )?;
                conn.execute(
                    "UPDATE thread SET owner_member_id=?1 WHERE workspace_id=?2 AND id=?3",
                    rusqlite::params![
                        scope.private.owner_member_id(),
                        scope.data.workspace_id(),
                        conversation
                    ],
                )?;
                let room = Conversation {
                    archived: false,
                    chat: None,
                    id: conversation.into(),
                    workspace_id: scope.data.workspace_id().into(),
                    kind: "direct".into(),
                    title: "Office authority".into(),
                    project_id: None,
                    facilitator_id: Some("facilitator".into()),
                    participants: vec![Participant {
                        agent_id: "worker".into(),
                        name: "Worker".into(),
                    }],
                    revision: 1,
                    generation: 1,
                    created_at: "2026-10-08T00:00:00Z".into(),
                    updated_at: "2026-10-08T00:00:00Z".into(),
                };
                collaboration_repo::put(
                    conn,
                    &store,
                    &scope.private,
                    CollaborationKind::Conversation,
                    conversation,
                    Some(conversation),
                    None,
                    &room,
                )?;
                assert!(
                    validate_conversation_agent(conn, &store, conversation, "worker", &scope)
                        .is_ok()
                );
                assert!(validate_conversation_agent(
                    conn,
                    &store,
                    conversation,
                    "facilitator",
                    &scope
                )
                .is_ok());
                assert!(validate_conversation_agent(
                    conn,
                    &store,
                    conversation,
                    "forged-agent",
                    &scope
                )
                .is_err());
                let delegated = Work {
                    schedule: None,
                    captured_context: None,
                    steering: vec![],
                    messages: vec![],
                    delivered_message_count: 0,
                    delivered_steering_count: 0,
                    permission_mode: "read-only".into(),
                    attachments: vec![],
                    origin: None,
                    id: "work-delegated".into(),
                    workspace_id: scope.data.workspace_id().into(),
                    conversation_id: conversation.into(),
                    parent_message_id: None,
                    project_id: None,
                    root_id: "work-root".into(),
                    parent_id: Some("work-root".into()),
                    agent_id: "delegated".into(),
                    agent_name: "Delegated".into(),
                    workspace_recipient: true,
                    resource_claims: vec![],
                    recipient_ids: vec![],
                    prompt: "Prepare the Office output".into(),
                    user_request: "Prepare the Office output".into(),
                    status: WorkStatus::Queued,
                    reason: None,
                    dependencies: vec![],
                    waiting_for: vec![],
                    prerequisites: vec![],
                    awaiting_user: false,
                    generation: 1,
                    conversation_generation: 1,
                    context_revision: 0,
                    depth: 1,
                    turn_count: 0,
                    token_usage: 0,
                    max_turns: 12,
                    max_tokens: 128_000,
                    run_ids: vec![],
                    current_run_id: None,
                    model_option_id: "fixture-model".into(),
                    outputs: vec![],
                    created_at: "2026-10-08T00:00:00Z".into(),
                    updated_at: "2026-10-08T00:00:00Z".into(),
                };
                collaboration_repo::put(
                    conn,
                    &store,
                    &scope.private,
                    CollaborationKind::Work,
                    "work-delegated",
                    Some(conversation),
                    None,
                    &delegated,
                )?;
                assert!(validate_conversation_agent(
                    conn,
                    &store,
                    conversation,
                    "delegated",
                    &scope
                )
                .is_ok());
                assert!(validate_conversation_agent(
                    conn,
                    &store,
                    conversation,
                    "forged-delegated",
                    &scope
                )
                .is_err());
                conn.execute(
                    "UPDATE thread SET owner_member_id=?1 WHERE workspace_id=?2 AND id=?3",
                    rusqlite::params!["another-member", scope.data.workspace_id(), conversation],
                )?;
                assert!(
                    validate_conversation_agent(conn, &store, conversation, "worker", &scope)
                        .is_err()
                );
                Ok(())
            })
            .unwrap();
    }
}
