//! Admission metadata on canonical Work, never a second execution queue.
use super::*;
use crate::hosted_tasks::{self as cloud, models::*};
use crate::local_computer::authority::OperationTicket;
use crate::models::ExecutionAttempt;
use crate::store::repos::{execution_attempt, workspace_directory::HostedComputerScope};
use serde_json::json;

fn context<T>(
    app: &tauri::AppHandle,
    workspace: &str,
    ticket: Option<&OperationTicket>,
    operation: impl FnOnce(&Context<'_>) -> Result<T>,
) -> std::result::Result<T, String> {
    let profiles = native_profiles(app.clone(), workspace)?;
    let store = crate::store::try_global().ok_or("Account storage unavailable.")?;
    let account = crate::account_session::AccountDispatchFence::capture()?;
    if let Some(ticket) = ticket {
        ticket.check()?;
    }
    store
        .transaction_with_commit_fence(
            |conn| {
                let scope =
                    authorized_scope::resolve(conn, Some(workspace), None, ScopeAccess::Write)?;
                let time = now();
                operation(&Context {
                    conn,
                    store,
                    scope: &scope,
                    profiles: &profiles,
                    time: &time,
                })
            },
            |tx| {
                // Store preparation/account checks are outside identity and generation
                // locks. Only SQL COMMIT runs under the cached native dispatch fence.
                let close = || account.with_current(|| Ok(tx.commit().map_err(StoreError::from)));
                let committed = if let Some(ticket) = ticket {
                    ticket.with_current(close)
                } else {
                    close()
                };
                committed.map_err(StoreError::Invalid)??;
                Ok(())
            },
        )
        .map_err(|e| e.to_string())
}
fn target(ctx: &Context<'_>, target: &Target) -> Result<Work> {
    let item = ctx.item(&target.work_id)?;
    if item.agent_id != target.agent_id || item.generation != target.expected_generation {
        return Err(invalid("This cloud task changed. Refresh before acting."));
    }
    Ok(item)
}
fn offer(ctx: &Context<'_>, item: &Work) -> Result<Offer> {
    repo::get(
        ctx.conn,
        ctx.store,
        &ctx.scope.private,
        Kind::HostedTask,
        &item.id,
    )?
    .ok_or_else(|| invalid("This cloud review or receipt is unavailable."))
}
fn put_offer(ctx: &Context<'_>, offer: &Offer, item: &Work) -> Result<()> {
    ctx.put(
        Kind::HostedTask,
        &item.id,
        Some(&item.conversation_id),
        None,
        offer,
    )
}
fn eligible(ctx: &Context<'_>, item: &Work) -> Result<()> {
    if item.status != WorkStatus::Queued
        || item.parent_id.is_some()
        || item.project_id.is_some()
        || item.schedule.is_some()
        || item.external_client.is_some()
        || item.parent_message_id.is_some()
        || !item.attachments.is_empty()
        || !item.run_ids.is_empty()
        || item.current_run_id.is_some()
        || !item.dependencies.is_empty()
        || !item.prerequisites.is_empty()
        || item.recipient_ids.len() > 1
        || item.outcome_goal.is_some()
        || !item.steering.is_empty()
        || !item.messages.is_empty()
        || ctx
            .all_work()?
            .iter()
            .any(|other| other.root_id == item.id && other.id != item.id)
    {
        return Err(invalid("Cloud text tasks need one unstarted queued request without files, tools, project context, schedules or delegated work."));
    }
    let agent = profile(ctx.profiles, &item.agent_id)?;
    if agent.model_id != item.model_option_id {
        return Err(invalid(
            "The agent's selected model changed. Start a fresh request.",
        ));
    }
    let (provider, model) = item.model_option_id.split_once("::").ok_or_else(|| {
        invalid(
            "Select a supported API provider/model for this agent before using cloud text tasks.",
        )
    })?;
    if !cloud::supported_provider(provider)
        || model.is_empty()
        || model.len() > 160
        || !model
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._:/-".contains(&c))
    {
        return Err(invalid("This provider uses local credentials or an unsupported route. Select a supported API provider for cloud text tasks."));
    }
    if agent.reasoning_effort.as_deref().is_some_and(|effort| {
        !["none", "minimal", "low", "medium", "high", "xhigh"].contains(&effort)
    }) {
        return Err(invalid(
            "The selected reasoning level is unavailable for cloud text tasks.",
        ));
    }
    Ok(())
}
pub(crate) fn prepare(
    app: &tauri::AppHandle,
    ticket: &OperationTicket,
    request: &Prepare,
    scope: &HostedComputerScope,
    generation: u64,
    runner_url: &str,
    connections: &[ProviderConnection],
    originally_held: Option<bool>,
) -> std::result::Result<Review, String> {
    context(app, &request.workspace_id, Some(ticket), |ctx| {
        prepare_at(
            ctx,
            request,
            scope,
            generation,
            runner_url,
            connections,
            originally_held,
        )
    })
}
fn prepare_at(
    ctx: &Context<'_>,
    request: &Prepare,
    scope: &HostedComputerScope,
    generation: u64,
    runner_url: &str,
    connections: &[ProviderConnection],
    originally_held: Option<bool>,
) -> Result<Review> {
    let mut item = target(ctx, &request.target())?;
    eligible(ctx, &item)?;
    let agent = profile(ctx.profiles, &item.agent_id)?;
    let (provider, model) = item.model_option_id.split_once("::").unwrap();
    let (provider, model) = (provider.to_string(), model.to_string());
    if !connections.iter().any(|c| {
        c.credential_id == request.credential_id
            && c.revision == request.credential_revision
            && c.enabled
            && c.provider_id == provider
            && c.expires_at > chrono::Utc::now().timestamp_millis()
    }) {
        return Err(invalid(
            "Connect a separate cloud API key for this task's selected provider.",
        ));
    }
    let mut messages = Vec::new();
    if !agent.instructions.trim().is_empty() {
        messages.push(TextMessage {
            role: "system".into(),
            content: agent.instructions.clone(),
        });
    }
    messages.push(TextMessage {
        role: "user".into(),
        content: item.user_request.clone(),
    });
    if messages.iter().any(|m| cloud::text_failure(&m.content)) {
        return Err(invalid("This text contains a credential marker or local path. Remove it before preparing a cloud task."));
    }
    let input = TextInput { messages };
    let encoded = serde_json::to_value(&input).map_err(|_| invalid("Invalid cloud text."))?;
    let input_bytes = serde_json::to_vec(&cloud::canonical(&encoded))
        .map_err(|_| invalid("Invalid cloud text."))?
        .len();
    if input_bytes > 65_536 {
        return Err(invalid(
            "Cloud task input is limited to 64 KiB of explicitly disclosed text.",
        ));
    }
    let head = thread::get(ctx.conn, ctx.store, &ctx.scope.data, &item.conversation_id)?
        .ok_or_else(|| invalid("Conversation unavailable."))?;
    if head
        .selected_head_id
        .as_ref()
        .is_some_and(|selected| Some(selected) != head.last_message_id.as_ref())
    {
        return Err(invalid(
            "Select the latest conversation branch before preparing a cloud task.",
        ));
    }
    let originally_held = originally_held.unwrap_or_else(|| {
        item.hosted_task
            .as_ref()
            .filter(|h| h.phase == "review")
            .and_then(|h| h.originally_held)
            .unwrap_or_else(|| item.queue.as_ref().is_some_and(|q| q.held))
    });
    if !item.queue.as_ref().is_some_and(|q| q.held) {
        queue::hold(ctx, &item.id, item.generation, true)?;
    }
    item = ctx.item(&item.id)?;
    let run_id = cloud::opaque("cloud-run").map_err(StoreError::Invalid)?;
    let expires = chrono::Utc::now().timestamp_millis() + 120_000;
    let binding = Binding {
        version: 1,
        task_id: cloud::opaque("task").map_err(StoreError::Invalid)?,
        admission_id: cloud::opaque("admission").map_err(StoreError::Invalid)?,
        run_id: run_id.clone(),
        workspace_id: scope.workspace_id.clone(),
        agent_id: item.agent_id.clone(),
        work_id: item.id.clone(),
        work_generation: item.generation,
        conversation_id: item.conversation_id.clone(),
        conversation_generation: item.conversation_generation,
        expected_head_id: Some(format!("{run_id}-user")),
        expected_sequence: head.last_sequence + 1,
        input_sha256: cloud::digest_value(&encoded).map_err(StoreError::Invalid)?,
        provider_id: provider,
        model: model,
        reasoning_effort: agent.reasoning_effort.clone(),
        credential_id: request.credential_id.clone(),
        credential_revision: request.credential_revision,
        budget: Budget {
            max_model_calls: 1,
            max_output_tokens: 4096,
            max_elapsed_ms: 120_000,
            max_result_bytes: 65_536,
        },
        expires_at: expires,
    };
    let admission = Admission {
        binding: binding.clone(),
        input,
    };
    let review_id = cloud::opaque("cloud-review").map_err(StoreError::Invalid)?;
    let approval = crate::models::ApprovalRequest { id: cloud::opaque("approval-cloud-text").map_err(StoreError::Invalid)?, service: "Mivlet cloud text task".into(),
            action: format!("Send this exact text to {} / {}", binding.provider_id, binding.model), mode: "trusted-scope".into(), risk_level: "high".into(),
            data_used: vec![format!("Task worker: {runner_url}"), format!("Exact admission SHA-256: {}", cloud::digest_value(&serde_json::to_value(&admission).map_err(|_| invalid("Invalid cloud admission."))?).map_err(StoreError::Invalid)?),
                format!("Full disclosed messages shown in this exact review: {} bytes; input SHA-256 {}", input_bytes, binding.input_sha256)],
            consequence: "Sends the complete displayed text to the selected API provider through the cloud task worker. One model call; no tools, files, browser or local context. Task text is retained for 24 hours; receipt metadata for 7 more days. Provider billing and retention apply. A sent request can have an uncertain outcome and is never automatically repeated.".into(),
            requested_at: ctx.time.into(), decisions: vec!["once".into(), "deny".into()], confirmation_phrase: None };
    let approval =
        crate::approvals::normalize_approval_request(approval).map_err(StoreError::Invalid)?;
    let offer = Offer {
        runner_url: runner_url.into(),
        review_id: review_id.clone(),
        work_id: item.id.clone(),
        work_generation: item.generation,
        admission,
        input_bytes,
        expires_at: expires,
        originally_held,
        approval,
        previous_head_id: head.last_message_id,
        previous_sequence: head.last_sequence,
        device_id: scope.device_id.clone(),
        computer_generation: generation,
        result: None,
    };
    item.hosted_task = Some(Execution {
        version: 1,
        binding,
        phase: "review".into(),
        review_id: Some(review_id),
        review_expires_at: Some(expires),
        originally_held: Some(originally_held),
        snapshot: None,
    });
    item.reason = Some("Paused for cloud text review. Confirm the exact disclosed text, or cancel to restore its previous queue state.".into());
    item.updated_at = ctx.time.into();
    ctx.work(&item)?;
    put_offer(ctx, &offer, &item)?;
    Ok(offer.public(ctx.snapshot()?))
}
/// Commit the hold before the first network await. A renderer session already
/// preparing its old generation can no longer bind; missing cloud prerequisites
/// leave a visible paused request with its ordinary queue recovery controls.
pub(crate) fn begin_prepare(
    app: &tauri::AppHandle,
    ticket: &OperationTicket,
    request: &Prepare,
) -> std::result::Result<(Prepare, bool), String> {
    context(app, &request.workspace_id, Some(ticket), |ctx| {
        let item = target(ctx, &request.target())?;
        eligible(ctx, &item)?;
        let originally_held = item
            .hosted_task
            .as_ref()
            .filter(|h| h.phase == "review")
            .and_then(|h| h.originally_held)
            .unwrap_or_else(|| item.queue.as_ref().is_some_and(|q| q.held));
        queue::hold(ctx, &item.id, item.generation, true)?;
        let mut item = ctx.item(&item.id)?;
        item.reason = Some("Paused while preparing cloud text consent. If cloud setup is unavailable, keep it paused or resume it explicitly from the queue.".into());
        ctx.work(&item)?;
        let mut request = request.clone();
        request.expected_generation = item.generation;
        Ok((request, originally_held))
    })
}
pub(crate) fn load(
    app: &tauri::AppHandle,
    request: &Target,
) -> std::result::Result<(Work, Offer), String> {
    context(app, &request.workspace_id, None, |ctx| {
        let item = target(ctx, request)?;
        let offer = offer(ctx, &item)?;
        Ok((item, offer))
    })
}
pub(crate) fn cancel_review(
    app: &tauri::AppHandle,
    ticket: &OperationTicket,
    request: &ReviewTarget,
) -> std::result::Result<ControlResult, String> {
    context(app, &request.workspace_id, Some(ticket), |ctx| {
        let item = target(ctx, &request.target())?;
        let offer = offer(ctx, &item)?;
        if offer.review_id != request.review_id
            || item
                .hosted_task
                .as_ref()
                .is_none_or(|h| h.phase != "review")
        {
            return Err(invalid("This cloud review is no longer current."));
        }
        queue::hold(ctx, &item.id, item.generation, offer.originally_held)?;
        let mut updated = ctx.item(&item.id)?;
        updated.hosted_task = None;
        updated.reason = None;
        ctx.work(&updated)?;
        Ok(ControlResult {
            collaboration: ctx.snapshot()?,
            task_result: None,
            reconcile_required: false,
        })
    })
}
fn write_attempt(ctx: &Context<'_>, attempt: &ExecutionAttempt) -> Result<()> {
    execution_attempt::upsert_scoped(
        ctx.conn,
        ctx.store,
        &ctx.scope.data,
        &attempt.id,
        attempt.thread_id.as_deref(),
        &attempt.provider_id,
        &attempt.model,
        &attempt.status,
        attempt.turn,
        attempt.recoverable,
        attempt.retry_count,
        &attempt.created_at,
        &attempt.updated_at,
        &serde_json::to_value(attempt).map_err(|_| invalid("Invalid cloud attempt."))?,
    )
}
fn append(ctx: &Context<'_>, item: &Work, run: &str, kind: &str, text: &str) -> Result<()> {
    let head = thread::get(ctx.conn, ctx.store, &ctx.scope.data, &item.conversation_id)?
        .ok_or_else(|| invalid("Cloud conversation unavailable."))?;
    let id = format!("{run}-{kind}");
    message::append(
        ctx.conn,
        ctx.store,
        &ctx.scope.data,
        &item.conversation_id,
        &id,
        kind,
        &json!({"executionOwner":"hosted","agentId":item.agent_id}),
        Some(run),
        head.last_sequence + 1,
        head.last_sequence,
        head.last_message_id.as_deref(),
        &id,
        &format!("{id}-revision"),
        "terminal",
        "hosted-text",
        &json!({"text":text}),
        ctx.time,
    )?;
    Ok(())
}
pub(crate) fn claim(
    app: &tauri::AppHandle,
    ticket: &OperationTicket,
    request: &Target,
    review_id: &str,
) -> std::result::Result<Offer, String> {
    context(app, &request.workspace_id, Some(ticket), |ctx| {
        claim_at(ctx, request, review_id)
    })
}
fn claim_at(ctx: &Context<'_>, request: &Target, review_id: &str) -> Result<Offer> {
    crate::execution_control::ensure_active_execution_allowed_in(ctx.conn, ctx.store)?;
    let mut item = target(ctx, request)?;
    eligible(ctx, &item)?;
    let offer = offer(ctx, &item)?;
    if offer.review_id != review_id
        || offer.work_generation != item.generation
        || offer.expires_at <= chrono::Utc::now().timestamp_millis()
        || item
            .hosted_task
            .as_ref()
            .is_none_or(|h| h.phase != "review" || h.review_id.as_deref() != Some(review_id))
    {
        return Err(invalid(
            "Cloud review expired or changed. Prepare a fresh review.",
        ));
    }
    let head = thread::get(ctx.conn, ctx.store, &ctx.scope.data, &item.conversation_id)?
        .ok_or_else(|| invalid("Conversation unavailable."))?;
    if head.last_sequence != offer.previous_sequence
        || head.last_message_id != offer.previous_head_id
    {
        return Err(invalid(
            "Conversation changed after cloud review. Prepare it again.",
        ));
    }
    item.execution_owner = None;
    item.queue
        .as_mut()
        .ok_or_else(|| invalid("The queued request is unavailable."))?
        .held = false;
    ctx.work(&item)?;
    let b = &offer.admission.binding;
    let attempt = ExecutionAttempt {
        id: b.run_id.clone(),
        provider_id: b.provider_id.clone(),
        model: b.model.clone(),
        status: "queued".into(),
        transcript: String::new(),
        reasoning_summaries: Default::default(),
        thread_id: Some(item.conversation_id.clone()),
        exchanges: vec![],
        parent_attempt_id: None,
        context_receipt: None,
        provider_route: None,
        turn: 0,
        usage: None,
        pending_approval_ids: vec![],
        recoverable: false,
        retry_count: 0,
        error: None,
        created_at: ctx.time.into(),
        updated_at: ctx.time.into(),
    };
    write_attempt(ctx, &attempt)?;
    work::bind(ctx, &item.id, item.generation, &b.run_id, None)?;
    append(ctx, &item, &b.run_id, "user", &item.user_request)?;
    item = ctx.item(&item.id)?;
    item.execution_owner = Some("hosted".into());
    item.hosted_task.as_mut().unwrap().phase = "dispatching".into();
    item.reason = Some("Cloud admission is being confirmed. Delivery uncertainty stays with this saved task; it will not fall back to a local provider.".into());
    ctx.work(&item)?;
    cloud::dispatch::register(&offer.admission.binding).map_err(StoreError::Invalid)?;
    Ok(offer)
}
pub(crate) fn result(
    app: &tauri::AppHandle,
    ticket: &OperationTicket,
    request: &Target,
    incoming: Option<TaskResult>,
) -> std::result::Result<ControlResult, String> {
    context(app, &request.workspace_id, Some(ticket), |ctx| {
        result_at(ctx, request, incoming)
    })
}
fn result_at(
    ctx: &Context<'_>,
    request: &Target,
    incoming: Option<TaskResult>,
) -> Result<ControlResult> {
    let mut item = target(ctx, request)?;
    let mut offer = offer(ctx, &item)?;
    if let Some(incoming) = incoming {
        cloud::validate_result(
            &offer.admission.binding,
            offer.result.as_ref().map(|r| &r.snapshot),
            &incoming,
        )
        .map_err(StoreError::Invalid)?;
        if let Some(existing) = &offer.result {
            if existing.snapshot.sequence == incoming.snapshot.sequence && existing != &incoming {
                return Err(invalid("The cloud receipt changed at the same sequence."));
            }
        }
        offer.result = Some(incoming);
        put_offer(ctx, &offer, &item)?;
    }
    let Some(saved) = &offer.result else {
        return Ok(ControlResult {
            collaboration: ctx.snapshot()?,
            task_result: None,
            reconcile_required: false,
        });
    };
    let b = &offer.admission.binding;
    let h = item
        .hosted_task
        .as_mut()
        .ok_or_else(|| invalid("Cloud Work binding unavailable."))?;
    h.snapshot = Some(saved.snapshot.clone());
    let phase = h.phase.clone();
    if phase == "reconciled" {
        ctx.work(&item)?;
        return Ok(ControlResult {
            collaboration: ctx.snapshot()?,
            task_result: Some(saved.clone()),
            reconcile_required: false,
        });
    }
    let terminal = !matches!(saved.snapshot.status.as_str(), "queued" | "running");
    if !terminal {
        if phase != "stop-pending" {
            h.phase = "accepted".into();
        }
        item.reason = Some("Running one cloud text task. It can continue while this desktop app is closed. Tools and local files are unavailable.".into());
        ctx.work(&item)?;
    } else {
        // Preserve authenticated evidence in the existing attempt even
        // when its old conversation branch cannot accept a late message.
        let stored =
            execution_attempt::get_scoped(ctx.conn, ctx.store, &ctx.scope.data, &b.run_id)?
                .ok_or_else(|| invalid("Cloud attempt unavailable."))?;
        let mut attempt: ExecutionAttempt = serde_json::from_value(stored.payload)
            .map_err(|_| invalid("Invalid cloud attempt."))?;
        attempt.status = match saved.snapshot.status.as_str() {
            "completed" => "completed",
            "cancelled" => "cancelled",
            "uncertain" => "interrupted",
            _ => "failed",
        }
        .into();
        attempt.transcript = saved.text.clone();
        attempt.updated_at = ctx.time.into();
        attempt.usage = saved
            .snapshot
            .usage
            .clone()
            .map(serde_json::from_value)
            .transpose()
            .map_err(|_| invalid("Invalid cloud usage."))?;
        attempt.error = saved.snapshot.error_code.clone();
        write_attempt(ctx, &attempt)?;
        let head = thread::get(ctx.conn, ctx.store, &ctx.scope.data, &item.conversation_id)?
            .ok_or_else(|| invalid("Conversation unavailable."))?;
        let matches = item.generation == b.work_generation
            && item.current_run_id.as_deref() == Some(b.run_id.as_str())
            && item.status.executing()
            && item.conversation_generation == b.conversation_generation
            && head.last_sequence == b.expected_sequence
            && head.last_message_id == b.expected_head_id
            && head
                .selected_head_id
                .as_ref()
                .is_none_or(|selected| Some(selected) == b.expected_head_id.as_ref())
            && ctx.room(&item.conversation_id)?.generation == b.conversation_generation
            && profile(ctx.profiles, &item.agent_id)
                .is_ok_and(|p| p.model_id == item.model_option_id)
            && work::current(ctx, &item.id, b.work_generation, Some(&b.run_id)).is_ok();
        if matches && phase != "stop-pending" {
            if saved.snapshot.status == "completed" {
                append(ctx, &item, &b.run_id, "assistant", &saved.text)?;
            }
            work::finish(
                ctx,
                &item.id,
                item.generation,
                &b.run_id,
                match saved.snapshot.status.as_str() {
                    "completed" => WorkStatus::Completed,
                    "cancelled" => WorkStatus::Cancelled,
                    "uncertain" => WorkStatus::AwaitingUser,
                    _ => WorkStatus::Failed,
                },
                attempt.error,
            )?;
            item = ctx.item(&item.id)?;
            item.hosted_task.as_mut().unwrap().phase = "reconciled".into();
        } else if phase == "stop-pending" && saved.snapshot.status == "cancelled" {
            item.hosted_task.as_mut().unwrap().phase = "reconciled".into();
            item.reason = Some("Cloud cancellation acknowledged. A request already received by the provider may still be billed.".into());
        } else {
            item.hosted_task.as_mut().unwrap().phase = "reconcile-required".into();
            item.reason = Some("The authenticated cloud result is retained separately because this task or conversation changed. Review it before continuing; it was not inserted into a different branch.".into());
            if item.status.executing() {
                item.status = WorkStatus::AwaitingUser;
                item.generation += 1;
                item.current_run_id = None;
            }
        }
        ctx.work(&item)?;
    }
    Ok(ControlResult {
        collaboration: ctx.snapshot()?,
        task_result: Some(saved.clone()),
        reconcile_required: item
            .hosted_task
            .as_ref()
            .is_some_and(|h| h.phase == "reconcile-required"),
    })
}
pub(crate) fn missing(
    app: &tauri::AppHandle,
    ticket: &OperationTicket,
    request: &Target,
) -> std::result::Result<ControlResult, String> {
    context(app, &request.workspace_id, Some(ticket), |ctx| {
        let mut item = target(ctx, request)?;
        let offer = offer(ctx, &item)?;
        if chrono::Utc::now().timestamp_millis() <= offer.expires_at + 20_000 {
            return Err(invalid("Cloud admission is still uncertain. Refresh this saved task; do not send it to another provider."));
        }
        if let Some(stored) = execution_attempt::get_scoped(
            ctx.conn,
            ctx.store,
            &ctx.scope.data,
            &offer.admission.binding.run_id,
        )? {
            let mut attempt: ExecutionAttempt = serde_json::from_value(stored.payload)
                .map_err(|_| invalid("Invalid cloud attempt."))?;
            if matches!(attempt.status.as_str(), "queued" | "streaming") {
                attempt.status = "interrupted".into();
                attempt.updated_at = ctx.time.into();
                attempt.error = Some("Cloud receipt is unavailable after admission or retention ended. No result was assumed or replayed.".into());
                write_attempt(ctx, &attempt)?;
            }
        }
        if item.status.active() {
            item.status = WorkStatus::AwaitingUser;
            item.generation += 1;
            item.current_run_id = None;
        }
        item.hosted_task
            .as_mut()
            .ok_or_else(|| invalid("Cloud Work binding unavailable."))?
            .phase = "reconciled".into();
        item.reason = Some("The authenticated cloud task was not found after admission closed or retention ended. No result was assumed or replayed. Review provider billing before an explicit continuation.".into());
        ctx.work(&item)?;
        Ok(ControlResult {
            collaboration: ctx.snapshot()?,
            task_result: None,
            reconcile_required: true,
        })
    })
}
pub(crate) fn mark_stop(item: &mut Work) {
    if let Some(cloud) = &mut item.hosted_task {
        if item.execution_owner.as_deref() == Some("hosted") && cloud.phase != "reconciled" {
            cloud.phase = "stop-pending".into();
            crate::hosted_tasks::dispatch::cancel(&cloud.binding);
        }
    }
}
pub(crate) fn stop(
    app: &tauri::AppHandle,
    ticket: &OperationTicket,
    request: &Target,
) -> std::result::Result<Offer, String> {
    context(app, &request.workspace_id, Some(ticket), |ctx| {
        let item = target(ctx, request)?;
        let offer = offer(ctx, &item)?;
        if item.execution_owner.as_deref() != Some("hosted") {
            return Err(invalid("This request has no admitted cloud owner."));
        }
        if item
            .hosted_task
            .as_ref()
            .is_none_or(|h| h.phase != "stop-pending")
        {
            work::invalidate_descendants(ctx, &item.id, "Cloud Stop requested. Local writes are fenced now; remote cancellation is pending until acknowledged.", WorkStatus::Cancelled)?;
        }
        Ok(offer)
    })
}
pub(crate) fn pending(app: &tauri::AppHandle) -> std::result::Result<Vec<Target>, String> {
    context(
        app,
        crate::store::repos::scope::DEFAULT_WORKSPACE_ID,
        None,
        |ctx| {
            Ok(ctx
                .all_work()?
                .into_iter()
                .filter(|w| {
                    w.execution_owner.as_deref() == Some("hosted")
                        && w.hosted_task.as_ref().is_some_and(|h| {
                            matches!(
                                h.phase.as_str(),
                                "dispatching" | "accepted" | "stop-pending"
                            )
                        })
                })
                .take(2)
                .map(|w| Target {
                    workspace_id: w.workspace_id,
                    agent_id: w.agent_id,
                    work_id: w.id,
                    expected_generation: w.generation,
                })
                .collect())
        },
    )
}
#[cfg(test)]
#[path = "hosted_tests.rs"]
mod tests;
