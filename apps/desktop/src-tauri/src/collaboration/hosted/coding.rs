//! Coding remains one canonical Work with an exact native source snapshot.
//! This bridge never treats a cloud answer as permission to import files.
use super::*;
use crate::local_computer::coding::hosted_repository::TaskIdentity;
#[cfg(test)]
#[path = "coding_tests.rs"]
mod tests;

pub(crate) fn prepare_coding(
    app: &tauri::AppHandle,
    ticket: &OperationTicket,
    request: &Prepare,
    scope: &HostedComputerScope,
    runner: &str,
    connections: &[ProviderConnection],
    originally_held: bool,
    task: &TaskIdentity,
    repository: CodingRepository,
) -> std::result::Result<Review, String> {
    context(app, &request.workspace_id, Some(ticket), |ctx| {
        prepare_at(
            ctx,
            request,
            scope,
            ticket.generation,
            runner,
            connections,
            originally_held,
            task,
            repository,
        )
    })
}
fn prepare_at(
    ctx: &Context<'_>,
    request: &Prepare,
    scope: &HostedComputerScope,
    generation: u64,
    runner: &str,
    connections: &[ProviderConnection],
    originally_held: bool,
    task: &TaskIdentity,
    repository: CodingRepository,
) -> Result<Review> {
    let (_, reviewed_scope) = cloud::coding::requested(request).map_err(StoreError::Invalid)?;
    if task.local_workspace_id != request.workspace_id
        || task.agent_id != request.agent_id
        || task.work_id != request.work_id
        || task.work_generation != request.expected_generation
        || reviewed_scope != repository.scope
        || repository.snapshot.writable_paths != repository.scope.writable_paths
    {
        return Err(invalid(
            "The native coding source scope changed before its review.",
        ));
    }
    let mut plain = request.clone();
    plain.mode = None;
    plain.web_scope = None;
    plain.selected_paths = None;
    plain.writable_paths = None;
    plain.checks = None;
    super::prepare_at(
        ctx,
        &plain,
        scope,
        generation,
        runner,
        connections,
        Some(originally_held),
    )?;
    let mut item = target(ctx, &request.target())?;
    let mut saved = offer(ctx, &item)?;
    let binding = &mut saved.admission.binding;
    binding.version = 3;
    binding.mode = Some("offline-coding".into());
    binding.repository = Some(repository.clone());
    binding.task_id = task.task_id.clone();
    binding.run_id = task.run_id.clone();
    binding.expected_head_id = Some(format!("{}-user", task.run_id));
    binding.budget.max_model_calls = 4;
    binding.budget.max_tool_calls = Some(8);
    let policy = cloud::coding::policy(&repository).map_err(StoreError::Invalid)?;
    let last = saved.admission.input.messages.len().saturating_sub(1);
    saved.admission.input.messages.insert(
        last,
        TextMessage {
            role: "system".into(),
            content: policy,
        },
    );
    let input = serde_json::to_value(&saved.admission.input)
        .map_err(|_| invalid("Invalid coding input."))?;
    saved.input_bytes = serde_json::to_vec(&cloud::canonical(&input))
        .map_err(|_| invalid("Invalid coding input."))?
        .len();
    if saved.input_bytes > 65536 {
        return Err(invalid("The disclosed instructions exceed the 64 KiB model-input limit. Shorten the request or exact check arguments."));
    }
    saved.admission.binding.input_sha256 =
        cloud::digest_value(&input).map_err(StoreError::Invalid)?;
    let admission =
        serde_json::to_value(&saved.admission).map_err(|_| invalid("Invalid coding admission."))?;
    if serde_json::to_vec(&cloud::canonical(&admission))
        .map_err(|_| invalid("Invalid coding admission."))?
        .len()
        > 512 * 1024
    {
        return Err(invalid("Selected file and writable-path metadata exceeds 512 KiB. Select fewer or shorter paths; no file bytes were sent."));
    }
    saved.approval.service = "Mivlet isolated cloud coding task".into();
    saved.approval.action = format!(
        "Run this exact isolated scratch operation using {} / {}",
        saved.admission.binding.provider_id, saved.admission.binding.model
    );
    saved.approval.data_used=vec![format!("Task worker: {runner}"),format!("Exact admission SHA-256: {}",cloud::digest_value(&admission).map_err(StoreError::Invalid)?),format!("Selected source: {} files, {} bytes; input manifest SHA-256: {}. Complete file/hash list, writable paths and exact argv shown in this review.",repository.snapshot.files.len(),repository.snapshot.total_bytes,repository.snapshot.manifest_sha256),format!("Disclosed model messages: {} bytes; input SHA-256 {}",saved.input_bytes,saved.admission.binding.input_sha256)];
    saved.approval.consequence="Exports only the exact selected immutable UTF-8 source snapshot and all displayed model messages to cloud custody and the selected API provider. Authorizes ONE task-scoped scratch operation: exact writable paths, exact argv checks, pinned image, network disabled, four model calls, eight scratch tools, 4096 aggregate requested output tokens, 120 seconds, 32 MiB input/output, 256 KiB per file, and 64 KiB answer. Fixed trusted network/isolation probes send no task data. No host files, credentials, connections, browser, installs, local tool grants or repository import. A new path/command scope parks the exact proposal for a fresh full task review. Any local import requires a separate one-time approval. Code, task text and output are removed from cloud custody after 24 hours; four coding results per account are retained at once. Provider billing/retention apply; cost can be unknown, and interrupted possible effects are never automatically repeated.".into();
    saved.approval.confirmation_phrase = Some("Run this isolated task".into());
    saved.approval = crate::approvals::normalize_approval_request(saved.approval)
        .map_err(StoreError::Invalid)?;
    item.hosted_task
        .as_mut()
        .ok_or_else(|| invalid("Coding review unavailable."))?
        .binding = saved.admission.binding.clone();
    item.reason=Some("Paused for one isolated cloud coding review. Review the selected file hashes, writable names, exact argv, complete messages and limits before confirming.".into());
    ctx.work(&item)?;
    put_offer(ctx, &saved, &item)?;
    Ok(saved.public(ctx.snapshot()?))
}

pub(super) fn result_at(ctx: &Context<'_>, mut item: Work, saved: &Offer) -> Result<ControlResult> {
    let result = saved
        .result
        .as_ref()
        .ok_or_else(|| invalid("Coding result unavailable."))?;
    let binding = &saved.admission.binding;
    let coding = result
        .snapshot
        .coding
        .as_ref()
        .ok_or_else(|| invalid("Authenticated coding output unavailable."))?;
    let phase = item
        .hosted_task
        .as_ref()
        .ok_or_else(|| invalid("Coding owner unavailable."))?
        .phase
        .clone();
    item.hosted_task.as_mut().unwrap().snapshot = Some(result.snapshot.clone());
    if phase == "reconciled" {
        ctx.work(&item)?;
        return control(ctx, &item, result);
    }
    let stored =
        execution_attempt::get_scoped(ctx.conn, ctx.store, &ctx.scope.data, &binding.run_id)?
            .ok_or_else(|| invalid("Coding attempt unavailable."))?;
    let mut attempt: ExecutionAttempt =
        serde_json::from_value(stored.payload).map_err(|_| invalid("Invalid coding attempt."))?;
    attempt.status = "completed".into();
    attempt.transcript = result.text.clone();
    attempt.updated_at = ctx.time.into();
    attempt.error = result.snapshot.error_code.clone();
    attempt.usage = result
        .snapshot
        .usage
        .clone()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|_| invalid("Invalid coding usage."))?;
    write_attempt(ctx, &attempt)?;
    let head = thread::get(ctx.conn, ctx.store, &ctx.scope.data, &item.conversation_id)?
        .ok_or_else(|| invalid("Coding conversation unavailable."))?;
    let matches = phase != "stop-pending"
        && item.execution_owner.as_deref() == Some("hosted")
        && item.generation == binding.work_generation
        && item.current_run_id.as_deref() == Some(binding.run_id.as_str())
        && item.conversation_generation == binding.conversation_generation
        && head.last_sequence == binding.expected_sequence
        && head.last_message_id == binding.expected_head_id
        && head
            .selected_head_id
            .as_ref()
            .is_none_or(|selected| Some(selected) == binding.expected_head_id.as_ref())
        && work::current_for_user_review(
            ctx,
            &item.id,
            binding.work_generation,
            Some(&binding.run_id),
        )
        .is_ok();
    if !matches {
        item.hosted_task.as_mut().unwrap().phase = "reconcile-required".into();
        item.reason=Some("The authenticated coding result is retained separately because this Work or conversation changed. No returned file was imported into a different task.".into());
        if item.status.executing() {
            item.status = WorkStatus::AwaitingUser;
            item.generation += 1;
            item.current_run_id = None;
        }
    } else {
        let imported = super::super::hosted_repository::verified_import_receipt(
            ctx,
            binding,
            &coding.output.snapshot_id,
            &coding.output.output_manifest_sha256,
        )?
        .is_some();
        let no_changes = cloud::coding::unchanged(binding, &coding.output);
        if result.snapshot.status == "completed" && (imported || no_changes) {
            // Same transaction, no provider dispatch: permit the existing
            // terminal helper to consume its already-validated parked owner.
            item.status = WorkStatus::Running;
            ctx.work(&item)?;
            append(ctx, &item, &binding.run_id, "assistant", &result.text)?;
            work::finish(
                ctx,
                &item.id,
                item.generation,
                &binding.run_id,
                WorkStatus::Completed,
                None,
            )?;
            item = ctx.item(&item.id)?;
            item.hosted_task.as_mut().unwrap().phase = "reconciled".into();
        } else {
            item.status = WorkStatus::AwaitingUser;
            item.hosted_task.as_mut().unwrap().phase = if coding.proposal.is_some() {
                "scope-change-required"
            } else {
                "awaiting-import"
            }
            .into();
            item.reason=Some(if coding.proposal.is_some(){if imported{"The partial candidate was imported. The recorded extra file or command requires a fresh full task review; this operation cannot Resume."}else{"Needs you: the exact extra file or command proposal is retained. Review the authenticated partial candidate separately, or start a fresh full task review. No local file has been imported."}}else{"The cloud scratch operation finished. Returned files remain separate until their exact native import review is approved. Refresh retries only immutable result transfer, never the task."}.into());
        }
    }
    ctx.work(&item)?;
    control(ctx, &item, result)
}
fn control(ctx: &Context<'_>, item: &Work, result: &TaskResult) -> Result<ControlResult> {
    Ok(ControlResult {
        collaboration: ctx.snapshot()?,
        task_result: Some(result.clone()),
        reconcile_required: item
            .hosted_task
            .as_ref()
            .is_some_and(|state| state.phase == "reconcile-required"),
    })
}
