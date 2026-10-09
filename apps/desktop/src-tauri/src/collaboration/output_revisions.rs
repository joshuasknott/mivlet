//! An explicit output revision request survives renderer close and restart.
//! Authority is bound before admission to one request, agent and immutable base.
use super::*;
use crate::outputs::{AppendInput, OutputProvenance};
use crate::store::repos::{conversation_ui, message};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[derive(Serialize, Deserialize)]
struct Request {
    output_id: String,
    revision_id: String,
    revision_number: i64,
    agent_id: String,
    prompt_hash: String,
    applied: bool,
}

#[allow(clippy::too_many_arguments)]
pub(super) fn stage(
    ctx: &Context<'_>,
    room: &Conversation,
    agent: &str,
    work: &str,
    output: &str,
    revision: &str,
    number: i64,
    prompt: &str,
) -> Result<Value> {
    id(work)?;
    id(output)?;
    id(revision)?;
    let prompt = bounded(prompt, 32_000, "Revision request")?;
    if repo::get::<Work>(ctx.conn, ctx.store, &ctx.scope.private, Kind::Work, work)?.is_some() {
        return Err(invalid(
            "Stage a new revision request before starting work.",
        ));
    }
    let output = crate::outputs::read_row(ctx.conn, ctx.store, ctx.scope, output)?
        .ok_or_else(|| invalid("Output unavailable."))?;
    if output.source.conversation_id != room.id
        || output.current_revision_id != revision
        || output.current_revision_number != number
    {
        return Err(invalid(
            "The output changed. Reopen the current revision before asking for an edit.",
        ));
    }
    crate::outputs::validate_generic_revision_format(&output.format)
        .map_err(|error| invalid(&error.to_string()))?;
    let key = format!("output-request:{work}");
    if conversation_ui::get::<Request>(ctx.conn, ctx.store, &ctx.scope.private, &room.id, &key)?
        .is_some()
    {
        return Err(invalid("This revision request was already staged."));
    }
    conversation_ui::put(
        ctx.conn,
        ctx.store,
        &ctx.scope.private,
        &room.id,
        &key,
        &Request {
            output_id: output.id,
            revision_id: revision.into(),
            revision_number: number,
            agent_id: agent.into(),
            prompt_hash: format!("{:x}", Sha256::digest(prompt.as_bytes())),
            applied: false,
        },
    )?;
    Ok(Value::Null)
}

pub(super) fn apply(
    ctx: &Context<'_>,
    room: &Conversation,
    agent: &str,
    work: &str,
) -> Result<Value> {
    let key = format!("output-request:{work}");
    let Some(mut request) =
        conversation_ui::get::<Request>(ctx.conn, ctx.store, &ctx.scope.private, &room.id, &key)?
    else {
        return Ok(Value::Null);
    };
    if request.applied {
        return Ok(Value::Null);
    }
    let item = ctx.item(work)?;
    if item.conversation_id != room.id
        || item.agent_id != agent
        || request.agent_id != agent
        || item.generation != 1
        || request.prompt_hash != format!("{:x}", Sha256::digest(item.user_request.as_bytes()))
    {
        return Err(invalid(
            "This revision request was stopped, superseded or changed. The output was preserved.",
        ));
    }
    if item.status != WorkStatus::Completed {
        return Ok(Value::Null);
    }
    let selected = message::list_selected(ctx.conn, ctx.store, &ctx.scope.data, &room.id)?;
    let response=selected.iter().rev().find(|row| row.kind=="assistant" && row.current_revision_state=="terminal" && row.run_id.as_ref().is_some_and(|run|item.run_ids.contains(run)))
        .ok_or_else(|| invalid("The revision response is not on the selected branch. Open its conversation branch to review it."))?;
    let content = response
        .content
        .as_str()
        .or_else(|| response.content.get("text").and_then(Value::as_str))
        .ok_or_else(|| invalid("The revision response has no saved text."))?;
    let current = crate::outputs::read_row(ctx.conn, ctx.store, ctx.scope, &request.output_id)?
        .ok_or_else(|| invalid("Output unavailable."))?;
    crate::outputs::validate_generic_revision_format(&current.format)
        .map_err(|error| invalid(&error.to_string()))?;
    let mut source = current.source;
    source.message_id = Some(response.id.clone());
    source.source_revision_id = Some(response.current_revision_id.clone());
    source.branch_id = Some(response.id.clone());
    source.agent_id = Some(agent.into());
    let output = crate::outputs::append_output(
        ctx.conn,
        ctx.store,
        ctx.scope,
        AppendInput {
            output_id: request.output_id.clone(),
            expected_revision_id: request.revision_id.clone(),
            expected_revision_number: request.revision_number,
            content: content.into(),
            author: "agent".into(),
            provenance: OutputProvenance {
                source,
                reason: "agent-revision".into(),
            },
            revision_id: Some(format!("revision-{work}")),
        },
    )?;
    request.applied = true;
    conversation_ui::put(
        ctx.conn,
        ctx.store,
        &ctx.scope.private,
        &room.id,
        &key,
        &request,
    )?;
    Ok(json!(output))
}

pub(super) fn apply_pending(ctx: &Context<'_>, room: &Conversation, agent: &str) -> Result<Value> {
    let mut stmt=ctx.conn.prepare("SELECT id FROM conversation_ui WHERE workspace_id=?1 AND owner_subject=?2 AND conversation_id=?3 AND id LIKE 'output-request:%' LIMIT 2048")?;
    let keys = stmt
        .query_map(
            rusqlite::params![
                ctx.scope.data.workspace_id(),
                ctx.scope.private.owner_subject(),
                room.id
            ],
            |row| row.get::<_, String>(0),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    let mut outputs = vec![];
    let mut errors = vec![];
    for key in keys {
        let Some(request) = conversation_ui::get::<Request>(
            ctx.conn,
            ctx.store,
            &ctx.scope.private,
            &room.id,
            &key,
        )?
        else {
            continue;
        };
        if request.applied || request.agent_id != agent {
            continue;
        }
        let work = key.trim_start_matches("output-request:");
        let Some(item) =
            repo::get::<Work>(ctx.conn, ctx.store, &ctx.scope.private, Kind::Work, work)?
        else {
            continue;
        };
        if item.status != WorkStatus::Completed {
            continue;
        }
        ctx.conn.execute_batch("SAVEPOINT output_revision_apply")?;
        match apply(ctx, room, agent, work) {
            Ok(output) => {
                ctx.conn.execute_batch("RELEASE output_revision_apply")?;
                if !output.is_null() {
                    outputs.push(output);
                }
            }
            Err(error) => {
                ctx.conn.execute_batch(
                    "ROLLBACK TO output_revision_apply; RELEASE output_revision_apply",
                )?;
                errors.push(json!({"workId":work,"message":error.to_string()}));
            }
        }
    }
    Ok(json!({"outputs":outputs,"errors":errors}))
}
