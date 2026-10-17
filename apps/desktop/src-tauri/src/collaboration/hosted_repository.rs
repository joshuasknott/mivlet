//! File custody is attached to canonical Work; this module stores no queue.
use super::*;
use crate::local_computer::{
    authority::OperationTicket,
    coding::hosted_repository::{Target, TaskIdentity},
};
#[cfg(test)]
#[path = "hosted_repository_tests.rs"]
mod tests;

pub(crate) struct RepositoryContext {
    pub repository: crate::local_computer::coding::RepositoryWorkBinding,
    pub binding: Option<crate::hosted_tasks::models::Binding>,
}

fn current_at(
    ctx: &Context<'_>,
    task: &TaskIdentity,
    claimed: bool,
    user_review: bool,
) -> Result<RepositoryContext> {
    task.validate().map_err(StoreError::Invalid)?;
    if ctx.scope.data.workspace_id() != task.local_workspace_id {
        return Err(invalid(
            "This repository snapshot belongs to another workspace.",
        ));
    }
    let item = if user_review {
        work::current_for_user_review(ctx, &task.work_id, task.work_generation, Some(&task.run_id))?
    } else {
        work::current(
            ctx,
            &task.work_id,
            task.work_generation,
            claimed.then_some(task.run_id.as_str()),
        )?
    };
    if item.agent_id != task.agent_id || item.root_id != item.id || item.parent_id.is_some() {
        return Err(invalid(
            "The coding snapshot does not belong to this exact root task.",
        ));
    }
    let repository = item.repository_binding.clone().filter(|binding| binding.valid())
        .ok_or_else(|| invalid("This task has no immutable repository copy. Start a fresh task with its intended copy."))?;
    if claimed {
        let cloud = item
            .hosted_task
            .as_ref()
            .ok_or_else(|| invalid("This task has no admitted hosted coding owner."))?;
        let binding = &cloud.binding;
        let captured = binding
            .repository
            .as_ref()
            .ok_or_else(|| invalid("The exact hosted repository snapshot is unavailable."))?;
        crate::local_computer::coding::hosted_repository::validate_bound_snapshot(
            binding,
            &captured.snapshot,
        )
        .map_err(StoreError::Invalid)?;
        let head = thread::get(ctx.conn, ctx.store, &ctx.scope.data, &item.conversation_id)?
            .ok_or_else(|| invalid("The coding conversation is unavailable."))?;
        if item.execution_owner.as_deref() != Some("hosted")
            || binding.version != 3
            || binding.task_id != task.task_id
            || binding.run_id != task.run_id
            || binding.work_id != task.work_id
            || binding.agent_id != task.agent_id
            || binding.work_generation != task.work_generation
            || binding.conversation_id != item.conversation_id
            || binding.conversation_generation != item.conversation_generation
            || captured.snapshot.repository_id != repository.repository_id
            || captured.snapshot.branch != repository.branch
            || captured.snapshot.base_commit != repository.base_commit
            || !(matches!(cloud.phase.as_str(), "dispatching" | "accepted")
                || user_review
                    && matches!(
                        cloud.phase.as_str(),
                        "awaiting-import" | "scope-change-required"
                    ))
            || head.last_sequence != binding.expected_sequence
            || head.last_message_id != binding.expected_head_id
            || head
                .selected_head_id
                .as_ref()
                .is_some_and(|selected| Some(selected) != binding.expected_head_id.as_ref())
        {
            return Err(invalid("The hosted coding task or conversation changed. Its files remain separate; nothing was imported."));
        }
        return Ok(RepositoryContext {
            repository,
            binding: Some(binding.clone()),
        });
    }
    if item.status != WorkStatus::Queued
        || item.execution_owner.is_some()
        || item.current_run_id.is_some()
        || !item.run_ids.is_empty()
        || !item.queue.as_ref().is_some_and(|queue| queue.held)
        || item
            .hosted_task
            .as_ref()
            .is_some_and(|cloud| cloud.binding.task_id != task.task_id)
    {
        return Err(invalid(
            "Repository export requires this exact unstarted task to be held for cloud review.",
        ));
    }
    Ok(RepositoryContext {
        repository,
        binding: None,
    })
}

pub(crate) fn current(
    app: &tauri::AppHandle,
    ticket: &OperationTicket,
    task: &TaskIdentity,
    claimed: bool,
) -> std::result::Result<RepositoryContext, String> {
    super::hosted::context(app, &task.local_workspace_id, Some(ticket), |ctx| {
        current_at(ctx, task, claimed, false)
    })
}
pub(crate) fn current_for_import(
    app: &tauri::AppHandle,
    ticket: &OperationTicket,
    task: &TaskIdentity,
) -> std::result::Result<RepositoryContext, String> {
    super::hosted::context(app, &task.local_workspace_id, Some(ticket), |ctx| {
        current_at(ctx, task, true, true)
    })
}
pub(crate) fn task_identity(
    app: &tauri::AppHandle,
    ticket: &OperationTicket,
    target: &Target,
) -> std::result::Result<TaskIdentity, String> {
    super::hosted::context(app, &target.workspace_id, Some(ticket), |ctx| {
        let item = ctx.item(&target.work_id)?;
        let cloud = item
            .hosted_task
            .as_ref()
            .ok_or_else(|| invalid("This task has no hosted coding result."))?;
        let task = TaskIdentity::from_binding(&target.workspace_id, &cloud.binding)
            .map_err(StoreError::Invalid)?;
        if !target_matches(target, &task) {
            return Err(invalid(
                "This coding task changed. Refresh its saved state.",
            ));
        }
        current_at(ctx, &task, true, true)?;
        Ok(task)
    })
}

/// Register only after canonical Work/head/permissions match. The same existing
/// gate is cancelled by Work Stop before its SQL COMMIT. No Store is acquired
/// while the caller performs the short final file rename under that gate.
pub(crate) fn register_import(
    app: &tauri::AppHandle,
    ticket: &OperationTicket,
    task: &TaskIdentity,
) -> std::result::Result<
    (
        crate::hosted_tasks::models::Binding,
        crate::hosted_tasks::dispatch::AdmissionGuard,
    ),
    String,
> {
    super::hosted::context(app, &task.local_workspace_id, Some(ticket), |ctx| {
        let current = current_at(ctx, task, true, true)?;
        let binding = current
            .binding
            .ok_or_else(|| invalid("The exact hosted coding owner is unavailable."))?;
        crate::hosted_tasks::dispatch::register(&binding).map_err(StoreError::Invalid)?;
        let guard = crate::hosted_tasks::dispatch::AdmissionGuard::retain(&binding);
        Ok((binding, guard))
    })
}

pub(crate) fn target_matches(target: &Target, task: &TaskIdentity) -> bool {
    target.workspace_id == task.local_workspace_id
        && target.agent_id == task.agent_id
        && target.work_id == task.work_id
        && target.expected_generation == task.work_generation
}
pub(crate) fn candidates(
    app: &tauri::AppHandle,
    ticket: &OperationTicket,
    target: &Target,
) -> std::result::Result<RepositoryContext, String> {
    super::hosted::context(app, &target.workspace_id, Some(ticket), |ctx| {
        let item = work::current(ctx, &target.work_id, target.expected_generation, None)?;
        if item.agent_id != target.agent_id
            || item.root_id != item.id
            || item.parent_id.is_some()
            || item.status != WorkStatus::Queued
            || item.execution_owner.is_some()
            || !item.run_ids.is_empty()
            || item.current_run_id.is_some()
        {
            return Err(invalid(
                "Select source files for one exact unstarted queued task.",
            ));
        }
        let repository = item
            .repository_binding
            .filter(|binding| binding.valid())
            .ok_or_else(|| invalid("This task has no immutable repository copy."))?;
        Ok(RepositoryContext {
            repository,
            binding: None,
        })
    })
}

#[derive(Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Imported {
    task: TaskIdentity,
    snapshot: crate::local_computer::coding::hosted_repository::Snapshot,
    receipt: crate::local_computer::coding::hosted_repository::ImportReceipt,
}
pub(crate) fn record_import(
    app: &tauri::AppHandle,
    ticket: &OperationTicket,
    task: &TaskIdentity,
    snapshot: &crate::local_computer::coding::hosted_repository::Snapshot,
    receipt: &crate::local_computer::coding::hosted_repository::ImportReceipt,
) -> std::result::Result<(), String> {
    super::hosted::context(app, &task.local_workspace_id, Some(ticket), |ctx| {
        let current = current_at(ctx, task, true, true)?;
        crate::local_computer::coding::hosted_repository::validate_snapshot(snapshot)
            .map_err(StoreError::Invalid)?;
        crate::local_computer::coding::hosted_repository::validate_bound_snapshot(
            current
                .binding
                .as_ref()
                .ok_or_else(|| invalid("The exact hosted coding owner is unavailable."))?,
            snapshot,
        )
        .map_err(StoreError::Invalid)?;
        receipt.validate().map_err(StoreError::Invalid)?;
        if current.repository.repository_id != receipt.repository_id
            || snapshot.snapshot_id != receipt.snapshot_id
            || !receipt.verification_invalidated
        {
            return Err(invalid(
                "The imported files do not belong to this exact task copy.",
            ));
        }
        let item = ctx.item(&task.work_id)?;
        ctx.put(
            Kind::Receipt,
            &format!("hosted-repository-import:{}", receipt.snapshot_id),
            Some(&item.conversation_id),
            None,
            &Imported {
                task: task.clone(),
                snapshot: snapshot.clone(),
                receipt: receipt.clone(),
            },
        )
    })
}
/// Called by authenticated v3 reconciliation, inside its canonical transaction.
/// An encrypted native import receipt is necessary; renderer success is not.
pub(super) fn verified_import_receipt(
    ctx: &Context<'_>,
    binding: &crate::hosted_tasks::models::Binding,
    snapshot_id: &str,
    output_manifest_sha256: &str,
) -> Result<Option<crate::local_computer::coding::hosted_repository::ImportReceipt>> {
    let Some(saved) = repo::get::<Imported>(
        ctx.conn,
        ctx.store,
        &ctx.scope.private,
        Kind::Receipt,
        &format!("hosted-repository-import:{snapshot_id}"),
    )?
    else {
        return Ok(None);
    };
    crate::local_computer::coding::hosted_repository::validate_snapshot(&saved.snapshot)
        .map_err(StoreError::Invalid)?;
    crate::local_computer::coding::hosted_repository::validate_bound_snapshot(
        binding,
        &saved.snapshot,
    )
    .map_err(StoreError::Invalid)?;
    saved.receipt.validate().map_err(StoreError::Invalid)?;
    let item = ctx.item(&binding.work_id)?;
    let expected = TaskIdentity::from_binding(ctx.scope.data.workspace_id(), binding)
        .map_err(StoreError::Invalid)?;
    let repository = item
        .repository_binding
        .as_ref()
        .ok_or_else(|| invalid("The imported task copy binding is unavailable."))?;
    if saved.task != expected
        || item.generation != binding.work_generation
        || saved.snapshot.snapshot_id != snapshot_id
        || saved.receipt.snapshot_id != snapshot_id
        || saved.receipt.output_manifest_sha256 != output_manifest_sha256
        || saved.snapshot.repository_id != repository.repository_id
        || saved.snapshot.branch != repository.branch
        || saved.snapshot.base_commit != repository.base_commit
        || saved.receipt.repository_id != repository.repository_id
        || !saved.receipt.verification_invalidated
    {
        return Err(invalid(
            "The native file import receipt does not match this exact coding task.",
        ));
    }
    Ok(Some(saved.receipt))
}
