//! Retrieval only from the exact continuation source, gated by live Work.
use super::*;
use crate::store::repos::message;
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadRequest {
    workspace_id: String,
    id: String,
    generation: u32,
    run_id: String,
    sequence: u64,
    text_offset: usize,
}

pub(super) fn read(
    ctx: &Context<'_>,
    id: &str,
    generation: u32,
    run: &str,
    sequence: u64,
    offset: usize,
) -> Result<Value> {
    if sequence == 0 || sequence > i64::MAX as u64 || offset > 2_000_000 {
        return Err(invalid("Invalid saved-history cursor."));
    }
    let item = work::current(ctx, id, generation, Some(run))?;
    let continuation = item
        .continuation
        .as_ref()
        .ok_or_else(|| invalid("This Work has no reviewed provider continuation."))?;
    let room = ctx.room(&item.conversation_id)?;
    let capture = context::capture(ctx, &room, profile(ctx.profiles, &item.agent_id)?)?;
    let context: Value =
        serde_json::from_str(&capture.text).map_err(|_| invalid("Invalid saved context."))?;
    if context
        .pointer("/contextSelection/includeHistory")
        .and_then(Value::as_bool)
        == Some(false)
    {
        return Err(invalid(
            "History is excluded from this conversation's context.",
        ));
    }
    let rows: Vec<_> = message::list(ctx.conn, ctx.store, &ctx.scope.data, &item.conversation_id)?
        .into_iter()
        .filter(|r| r.sequence <= continuation.through_sequence)
        .collect();
    if provider_continuation::history_digest(&rows) != continuation.source_history_digest {
        return Err(invalid(
            "The source history was edited or redacted. Review a fresh continuation.",
        ));
    }
    let next = rows
        .iter()
        .filter(|r| r.sequence >= sequence as i64)
        .find_map(provider_continuation::public_message);
    let Some(mut message) = next else {
        return Ok(json!({"message":null,"nextSequence":null,"nextTextOffset":null}));
    };
    let length = message.text.chars().count();
    if offset > length {
        return Err(invalid("The saved-history text offset is out of range."));
    }
    // Unicode scalar offsets; bounded response, no slicing inside a UTF-8 sequence.
    message.text = message.text.chars().skip(offset).take(4_000).collect();
    let end = offset.saturating_add(4_000).min(length);
    Ok(json!({
        "instructionAuthority":"none", "message": message,
        "nextSequence": if end < length { message.sequence } else { message.sequence + 1 },
        "nextTextOffset": if end < length { end } else { 0 },
    }))
}

#[tauri::command]
pub fn provider_continuation_read(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: ReadRequest,
) -> std::result::Result<Value, String> {
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
            read(
                &ctx,
                &request.id,
                request.generation,
                &request.run_id,
                request.sequence,
                request.text_offset,
            )
        })
        .map_err(|e| e.to_string())
}
