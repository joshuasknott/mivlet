//! Canonical retirement authorization; only the prepared atomic rename runs
//! under this transaction. Recursive deletion is outside Store and all fences.
use super::*;
use crate::hosted_tasks::{self as cloud, models::Offer};
use crate::local_computer::coding::hosted_repository::{is_preparing, Snapshot};
use crate::store::repos::execution_attempt;

pub(crate) fn retire_snapshot(
    app: &tauri::AppHandle,
    ticket: &OperationTicket,
    task: &TaskIdentity,
    snapshot: &Snapshot,
    rename: impl FnOnce() -> std::result::Result<(), String>,
) -> std::result::Result<bool, String> {
    let account = crate::account_session::AccountDispatchFence::capture()?;
    super::super::hosted::context(app, &task.local_workspace_id, Some(ticket), |ctx| {
        retire_at(ctx, task, snapshot, || {
            ticket.with_current(|| account.with_current(rename))
        })
    })
}
pub(in crate::collaboration) fn retire_at(
    ctx: &Context<'_>,
    task: &TaskIdentity,
    snapshot: &Snapshot,
    rename: impl FnOnce() -> std::result::Result<(), String>,
) -> Result<bool> {
    if !discardable(ctx, task, snapshot)? {
        return Ok(false);
    }
    rename().map_err(StoreError::Invalid)?;
    Ok(true)
}
fn discardable(ctx: &Context<'_>, task: &TaskIdentity, snapshot: &Snapshot) -> Result<bool> {
    task.validate().map_err(StoreError::Invalid)?;
    crate::local_computer::coding::hosted_repository::validate_snapshot(snapshot)
        .map_err(StoreError::Invalid)?;
    if task.local_workspace_id != ctx.scope.data.workspace_id()
        || is_preparing(task).map_err(StoreError::Invalid)?
    {
        return Ok(false);
    }
    let item = ctx.item(&task.work_id)?;
    if item.generation < task.work_generation
        || item.agent_id != task.agent_id
        || item.repository_binding.as_ref().is_none_or(|repo| {
            !repo.valid()
                || repo.repository_id != snapshot.repository_id
                || repo.branch != snapshot.branch
                || repo.base_commit != snapshot.base_commit
        })
    {
        return Ok(false);
    }
    let claimed = item.run_ids.contains(&task.run_id)
        || item.current_run_id.as_deref() == Some(task.run_id.as_str())
        || execution_attempt::get_scoped(ctx.conn, ctx.store, &ctx.scope.data, &task.run_id)?
            .is_some();
    let exact = item.hosted_task.as_ref().filter(|hosted| {
        hosted.binding.task_id == task.task_id
            || hosted.binding.run_id == task.run_id
            || hosted
                .binding
                .repository
                .as_ref()
                .is_some_and(|repo| repo.snapshot.snapshot_id == snapshot.snapshot_id)
    });
    if !claimed {
        // The native preparation guard spans capture through publication. An
        // absent canonical reference plus absent attempt/run proves an unused
        // review/capture, even after the queue advanced to another held review.
        return Ok(exact.is_none()
            && item.execution_owner.is_none()
            && matches!(item.status, WorkStatus::Queued | WorkStatus::Cancelled));
    }
    let Some(hosted) = exact else {
        return Ok(false);
    };
    let binding = &hosted.binding;
    if hosted.phase != "reconciled"
        || binding.version != 3
        || binding.task_id != task.task_id
        || binding.run_id != task.run_id
        || binding.work_generation != task.work_generation
        || binding.work_id != task.work_id
        || binding.agent_id != task.agent_id
        || binding
            .repository
            .as_ref()
            .is_none_or(|repo| repo.snapshot != *snapshot)
        || item.execution_owner.as_deref() != Some("hosted")
        || item.current_run_id.as_deref() != Some(task.run_id.as_str())
    {
        return Ok(false);
    }
    let Some(stored) = repo::get::<Offer>(
        ctx.conn,
        ctx.store,
        &ctx.scope.private,
        Kind::Receipt,
        &format!("hosted-task:{}", item.id),
    )?
    else {
        return Ok(false);
    };
    let Some(result) = stored.result else {
        return Ok(false);
    };
    if stored.admission.binding != *binding
        || hosted.snapshot.as_ref() != Some(&result.snapshot)
        || cloud::validate_result(binding, None, &result).is_err()
    {
        return Ok(false);
    }
    match (&item.status, result.snapshot.status.as_str()) {
        (WorkStatus::Completed, "completed") if item.generation == task.work_generation => {
            let Some(output) = result.snapshot.coding.as_ref().map(|coding| &coding.output) else {
                return Ok(false);
            };
            Ok(cloud::coding::unchanged(binding, output)
                || verified_import_receipt(
                    ctx,
                    binding,
                    &snapshot.snapshot_id,
                    &output.output_manifest_sha256,
                )?
                .is_some())
        }
        (WorkStatus::Failed, "failed") => Ok(item.generation == task.work_generation),
        (WorkStatus::Cancelled, "cancelled") => Ok(item.generation == task.work_generation
            || task.work_generation.checked_add(1) == Some(item.generation)),
        _ => Ok(false),
    }
}
