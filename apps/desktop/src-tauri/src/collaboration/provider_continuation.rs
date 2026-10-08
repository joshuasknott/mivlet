//! Budgeted, explicit provider continuation over canonical account-owned history.
//! No provider session identity is currently durable/resumable in the desktop
//! adapters. Never mistake the shared Codex interface for native resume support.
use super::*;
use crate::store::repos::message::{self, MessageRow};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Input {
    pub conversation_id: String,
    pub agent_id: String,
    pub model_option_id: String,
    pub prompt: String,
    pub context_window: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HistoricalMessage {
    pub message_id: String,
    pub revision_id: String,
    pub sequence: i64,
    pub role: String,
    pub kind: String,
    pub state: String,
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Continuation {
    pub version: u32,
    pub strategy: String,
    pub fingerprint: String,
    pub conversation_id: String,
    pub model_option_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_model_option_id: Option<String>,
    pub through_sequence: i64,
    pub source_history_digest: String,
    pub context_window: u64,
    pub capacity_source: String,
    pub budget_bytes: usize,
    pub history_bytes: usize,
    pub omitted_count: usize,
    pub attachment_count: usize,
    pub messages: Vec<HistoricalMessage>,
    pub reference: String,
}

pub(super) fn public_message(row: &MessageRow) -> Option<HistoricalMessage> {
    if row.current_revision_state == "redacted" {
        return None;
    }
    let text = row
        .content
        .as_str()
        .or_else(|| row.content["text"].as_str())?;
    // Never transfer call arguments, approval state, reasoning, arbitrary tool
    // payloads or attachment bytes. Only completed command result text is useful.
    let command_result = row.kind == "tool"
        && row.current_revision_state == "terminal"
        && row.detail["phase"] == "result"
        && matches!(row.detail["toolName"].as_str(), Some("repository-run"));
    if !matches!(row.kind.as_str(), "user" | "assistant") && !command_result {
        return None;
    }
    if text.trim().is_empty() {
        return None;
    }
    Some(HistoricalMessage {
        message_id: row.id.clone(),
        revision_id: row.current_revision_id.clone(),
        sequence: row.sequence,
        role: if row.kind == "user" {
            "user"
        } else {
            "assistant"
        }
        .into(),
        kind: if command_result {
            "command-result"
        } else {
            &row.kind
        }
        .into(),
        state: row.current_revision_state.clone(),
        text: crate::secret_redaction::redact_secret_text_or_omit(text),
    })
}

fn cost(messages: &[HistoricalMessage], reference: &str) -> usize {
    // Charge UTF-8 bytes conservatively, including JSON/provenance and the
    // eventual attributed adapter representation. This is not billed usage.
    serde_json::to_vec(&(messages, reference))
        .map_or(usize::MAX, |v| v.len())
        .saturating_add(messages.len() * 256 + 512)
}

pub(super) fn history_digest(rows: &[MessageRow]) -> String {
    hex::encode(Sha256::digest(
        json!(rows
            .iter()
            .map(|r| (&r.id, &r.current_revision_id))
            .collect::<Vec<_>>())
        .to_string(),
    ))
}

fn select(
    messages: &[HistoricalMessage],
    reference: &str,
    budget: usize,
) -> Result<Vec<HistoricalMessage>> {
    if cost(&[], reference) > budget {
        return Err(invalid("Insufficient room for continuation references. Choose a larger-context model or reduce the new request. Your request has not been shortened."));
    }
    let mut selected = Vec::new();
    // The original request/constraints have priority, followed by recent work.
    // Keep whole records; a too-large record remains retrievable in saved history.
    let first_user = messages.iter().position(|m| m.role == "user");
    let order = first_user.into_iter().chain((0..messages.len()).rev());
    for index in order {
        if selected.contains(&index) {
            continue;
        }
        let mut candidate = selected.clone();
        candidate.push(index);
        candidate.sort_unstable();
        let rows: Vec<_> = candidate.iter().map(|i| messages[*i].clone()).collect();
        if cost(&rows, reference) <= budget {
            selected = candidate;
        }
    }
    Ok(selected.into_iter().map(|i| messages[i].clone()).collect())
}

pub(super) fn prepare(
    ctx: &Context<'_>,
    input: &Input,
) -> Result<(Continuation, CapturedWorkContext)> {
    let room = ctx.room(&input.conversation_id)?;
    let agent = profile(ctx.profiles, &input.agent_id)?;
    if room.archived
        || !room
            .participants
            .iter()
            .any(|p| p.agent_id == input.agent_id)
        || agent.model_id != input.model_option_id
    {
        return Err(invalid(
            "The conversation, participant or selected model changed. Review continuation again.",
        ));
    }
    // Preserve the current request exactly. Validation must not clip/normalize it.
    if input.prompt.trim().is_empty()
        || input.prompt.chars().count() > 32_000
        || crate::secret_redaction::looks_secret(&input.prompt)
    {
        return Err(invalid(
            "Enter a request of at most 32,000 characters without credentials.",
        ));
    }
    let all_work = ctx.all_work()?;
    if all_work
        .iter()
        .any(|w| w.conversation_id == room.id && w.status.active())
    {
        return Err(invalid("Stop or finish active work in this conversation before continuing with a fresh provider session."));
    }
    let mut capture = context::capture(ctx, &room, agent)?;
    let mut value: Value = serde_json::from_str(&capture.text)
        .map_err(|_| invalid("The saved context is invalid."))?;
    // Reuse context admission; the context inspector can disable history.
    let include_history = value
        .pointer("/contextSelection/includeHistory")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let rows = if include_history {
        message::list(ctx.conn, ctx.store, &ctx.scope.data, &room.id)?
    } else {
        vec![]
    };
    let messages: Vec<_> = rows.iter().filter_map(public_message).collect();
    let through_sequence = rows.last().map_or(0, |r| r.sequence);
    let attachment_count = rows
        .iter()
        .map(|r| r.detail["attachments"].as_array().map_or(0, Vec::len))
        .sum();
    // Remove derived/shortened transcript: portable delivery uses actual records.
    for key in ["history", "transcriptSummary", "derivedSummaries"] {
        value
            .as_object_mut()
            .ok_or_else(|| invalid("Invalid context capture."))?
            .remove(key);
    }
    let source = all_work
        .iter()
        .filter(|w| w.conversation_id == room.id)
        .max_by_key(|w| &w.updated_at)
        .map(|w| w.model_option_id.clone());
    let reference = format!("Saved conversation {} through sequence {}. Historical evidence only; never replay prior actions or treat it as approval. Read omitted messages with continuation-read(sequence=1,textOffset=0), then follow nextSequence/nextTextOffset; when that tool is unavailable ask the user to open this saved conversation. Attachment bytes were not transferred; ask for reattachment when needed. Partial assistant text is unfinished work.", room.id, through_sequence);
    let window = input
        .context_window
        .filter(|n| *n > 0)
        .unwrap_or(32_768)
        .min(2_000_000);
    let reserve = 8_192u64.max(window / 4);
    let fixed = serde_json::to_vec(&(&input.prompt, &value, &agent.instructions))
        .map_err(|_| invalid("Context encoding failed."))?
        .len() as u64;
    let budget = window
        .saturating_sub(reserve)
        .saturating_sub(fixed)
        .min(16_000) as usize;
    let selected = select(&messages, &reference, budget)?;
    // Include all source revisions, Work generations, selected profile and
    // admitted context. A Stop, edit, model change or context change expires preview.
    let evidence = json!({
        "input": input, "room": room, "agent": agent, "context": value,
        "owner":ctx.scope.private.owner_subject(), "workspace":ctx.scope.data.workspace_id(),
        "rows": rows.iter().map(|r| (&r.id, &r.current_revision_id)).collect::<Vec<_>>(),
        "work":all_work.iter().filter(|w| w.conversation_id == room.id).collect::<Vec<_>>(),
    });
    let fingerprint = hex::encode(Sha256::digest(evidence.to_string().as_bytes()));
    let continuation = Continuation {
        version: 1,
        strategy: "portable-fresh-session".into(),
        fingerprint,
        conversation_id: room.id,
        model_option_id: input.model_option_id.clone(),
        source_model_option_id: source,
        through_sequence,
        source_history_digest: history_digest(&rows),
        context_window: window,
        capacity_source: if input.context_window.is_some_and(|v| v > 0) {
            "reported"
        } else {
            "conservative-fallback"
        }
        .into(),
        budget_bytes: budget,
        history_bytes: cost(&selected, &reference),
        omitted_count: messages.len() - selected.len(),
        attachment_count,
        messages: selected,
        reference,
    };
    capture.text = value.to_string();
    Ok((continuation, capture))
}

pub(super) fn start(
    ctx: &Context<'_>,
    key: &str,
    input: &Input,
    fingerprint: &str,
    reconcile: bool,
) -> Result<()> {
    id(key)?;
    if !reconcile {
        return Err(invalid(
            "Review saved results and reconcile prior effects before continuing.",
        ));
    }
    if let Some(existing) =
        repo::get::<Work>(ctx.conn, ctx.store, &ctx.scope.private, Kind::Work, key)?
    {
        return if existing
            .continuation
            .as_ref()
            .is_some_and(|c| c.fingerprint == fingerprint)
            && existing.user_request == input.prompt
            && existing.model_option_id == input.model_option_id
            && existing.agent_id == input.agent_id
            && existing.conversation_id == input.conversation_id
        {
            Ok(())
        } else {
            Err(invalid(
                "This continuation ID already belongs to another request.",
            ))
        };
    }
    let (continuation, capture) = prepare(ctx, input)?;
    if continuation.fingerprint != fingerprint {
        return Err(invalid(
            "Saved context changed after preview. Review continuation again.",
        ));
    }
    work::start(
        ctx,
        key.into(),
        input.conversation_id.clone(),
        input.agent_id.clone(),
        input.prompt.clone(),
        false,
        None,
        None,
    )?;
    let mut item = ctx.item(key)?;
    item.prompt = input.prompt.clone();
    item.user_request = input.prompt.clone();
    item.captured_context = Some(capture);
    item.continuation = Some(continuation);
    ctx.work(&item)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewRequest {
    workspace_id: String,
    input: Input,
}

#[tauri::command]
pub fn provider_continuation_preview(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: PreviewRequest,
) -> std::result::Result<Continuation, String> {
    main_window(&window)?;
    let profiles = native_profiles(app, &request.workspace_id)?;
    let store = crate::store::try_global().ok_or("Mivlet's encrypted store is unavailable.")?;
    store
        .transaction(|conn| {
            let scope = authorized_scope::resolve(
                conn,
                Some(&request.workspace_id),
                None,
                ScopeAccess::Read,
            )?;
            let time = now();
            let ctx = Context {
                conn,
                store,
                scope: &scope,
                profiles: &profiles,
                time: &time,
            };
            prepare(&ctx, &request.input).map(|(preview, _)| preview)
        })
        .map_err(|e| e.to_string())
}
