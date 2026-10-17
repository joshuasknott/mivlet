use super::{models::*, *};
use crate::{
    collaboration::hosted,
    local_computer::{authority::OperationTicket, LocalComputerState},
};
use serde_json::json;
use std::sync::Arc;

fn main(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Manage cloud text tasks from the main Mivlet window.".into());
    }
    Ok(())
}
pub(crate) fn ticket(
    state: &LocalComputerState,
    workspace: &str,
    agent: &str,
) -> Result<OperationTicket, String> {
    state.validate_target(workspace, agent)?;
    let authority = state.authority_for(workspace, agent)?;
    let generation = authority.snapshot()?.generation;
    authority.begin_viewer(generation)
}
fn commit<T>(
    ticket: &OperationTicket,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    ticket.check()?;
    operation()
}
#[tauri::command]
pub(crate) async fn hosted_text_prepare(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<LocalComputerState>>,
    request: Prepare,
) -> Result<Review, String> {
    main(&window)?;
    crate::execution_control::ensure_active_execution_allowed()?;
    valid_id(&request.credential_id)?;
    let ticket = ticket(&state, &request.workspace_id, &request.agent_id)?;
    let (request, originally_held) = hosted::begin_prepare(&app, &ticket, &request)?;
    let scope = transport::cloud_scope()?;
    let (connections, runner) = transport::connections(&ticket, &scope, &request.agent_id).await?;
    commit(&ticket, || {
        hosted::prepare(
            &app,
            &ticket,
            &request,
            &scope,
            ticket.generation,
            &runner,
            &connections,
            Some(originally_held),
        )
    })
}
#[tauri::command]
pub(crate) fn hosted_text_review_cancel(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<LocalComputerState>>,
    request: ReviewTarget,
) -> Result<ControlResult, String> {
    main(&window)?;
    let ticket = ticket(&state, &request.workspace_id, &request.agent_id)?;
    commit(&ticket, || hosted::cancel_review(&app, &ticket, &request))
}
#[tauri::command]
pub(crate) async fn hosted_text_admit(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<LocalComputerState>>,
    request: Commit,
) -> Result<ControlResult, String> {
    main(&window)?;
    crate::execution_control::ensure_active_execution_allowed()?;
    let ticket = ticket(&state, &request.workspace_id, &request.agent_id)?;
    let target = request.target();
    let (_, prepared) = hosted::load(&app, &target)?;
    if prepared.review_id != request.review_id
        || prepared.approval != request.resolution.request
        || request.resolution.decision != "once"
        || request.resolution.modification.is_some()
        || prepared.computer_generation != ticket.generation
    {
        return Err("This exact cloud review requires a fresh one-time approval.".into());
    }
    let resolution = crate::approvals::resolve_approval(request.resolution)?;
    if resolution.audit_entry.decision != "once"
        || resolution.effective_request != prepared.approval
    {
        return Err("Cloud tasks accept only their exact one-time approval.".into());
    }
    commit(&ticket, || {
        crate::execution_approvals::verify_and_consume_execution_approval(
            &crate::paths::execution_approvals_path(&app)?,
            &resolution.effective_request,
            &crate::execution_approvals::wall_clock_consumed_at(),
        )
    })?;
    // Only the sole successful ledger consumer creates this cleanup guard.
    // It also removes a gate installed by a claim whose SQL COMMIT is fenced.
    let _dispatch = super::dispatch::AdmissionGuard::retain(&prepared.admission.binding);
    let offer = hosted::claim(&app, &ticket, &target, &request.review_id)?;
    let scope = transport::cloud_scope()?;
    if scope.workspace_id != offer.admission.binding.workspace_id
        || scope.device_id != offer.device_id
    {
        return Err("Cloud admission is saved but its selected workspace changed. Refresh before continuing; no local fallback was used.".into());
    }
    ticket.check()?;
    let sent = transport::call(
        &ticket,
        &scope,
        &request.agent_id,
        "tasks",
        &offer.admission.binding.task_id,
        "admit",
        serde_json::to_value(&offer.admission).map_err(|_| "Invalid cloud admission.")?,
        None,
        Some(&offer.runner_url),
        Some(&offer.admission.binding),
    )
    .await;
    match sent {
        Ok((value, _)) => {
            let snapshot = serde_json::from_value(value)
                .map_err(|_| "Cloud admission is uncertain. Refresh its exact saved task.")?;
            commit(&ticket, || {
                hosted::result(
                    &app,
                    &ticket,
                    &target,
                    Some(TaskResult {
                        snapshot,
                        text: String::new(),
                    }),
                )
            })
        }
        Err(_) => hosted::result(&app, &ticket, &target, None),
    }
}
async fn refresh(
    app: &tauri::AppHandle,
    state: &LocalComputerState,
    target: &Target,
) -> Result<ControlResult, String> {
    let ticket = ticket(state, &target.workspace_id, &target.agent_id)?;
    let (item, offer) = hosted::load(app, target)?;
    let scope = transport::cloud_scope()?;
    if scope.workspace_id != offer.admission.binding.workspace_id
        || scope.device_id != offer.device_id
    {
        return Err(
            "Select this task's original hosted workspace and device to read or stop it.".into(),
        );
    }
    if item
        .hosted_task
        .as_ref()
        .is_some_and(|h| h.phase == "review")
    {
        return hosted::result(app, &ticket, target, None);
    }
    let (value, _) = match transport::call(
        &ticket,
        &scope,
        &target.agent_id,
        "tasks",
        &offer.admission.binding.task_id,
        "read",
        json!({"taskId":offer.admission.binding.task_id}),
        None,
        Some(&offer.runner_url),
        None,
    )
    .await
    {
        Ok(value) => value,
        Err(error) if error == "Cloud task request failed (task-not-found)." => {
            return commit(&ticket, || hosted::missing(app, &ticket, target))
        }
        Err(error) => return Err(error),
    };
    let result: TaskResult = serde_json::from_value(value)
        .map_err(|_| "The cloud task result failed native validation.")?;
    validate_result(
        &offer.admission.binding,
        offer.result.as_ref().map(|r| &r.snapshot),
        &result,
    )?;
    if item
        .hosted_task
        .as_ref()
        .is_some_and(|h| h.phase == "stop-pending")
        && matches!(result.snapshot.status.as_str(), "queued" | "running")
    {
        let (value, _) = transport::call(&ticket, &scope, &target.agent_id, "tasks", &offer.admission.binding.task_id, "cancel", json!({"taskId":offer.admission.binding.task_id,"generation":result.snapshot.generation}), None, Some(&offer.runner_url), None).await?;
        let snapshot: TaskSnapshot = serde_json::from_value(value)
            .map_err(|_| "Cloud cancellation is still pending. Refresh its exact saved task.")?;
        if snapshot.status == "completed" {
            // Completion may win a server-side cancel race. Only a new native
            // authenticated full read can provide that terminal answer.
            let (value, _) = transport::call(
                &ticket,
                &scope,
                &target.agent_id,
                "tasks",
                &offer.admission.binding.task_id,
                "read",
                json!({"taskId":offer.admission.binding.task_id}),
                None,
                Some(&offer.runner_url),
                None,
            )
            .await?;
            let completed = serde_json::from_value(value)
                .map_err(|_| "The completed cloud receipt could not be read.")?;
            return commit(&ticket, || {
                hosted::result(app, &ticket, target, Some(completed))
            });
        }
        return commit(&ticket, || {
            hosted::result(
                app,
                &ticket,
                target,
                Some(TaskResult {
                    snapshot,
                    text: String::new(),
                }),
            )
        });
    }
    commit(&ticket, || {
        hosted::result(app, &ticket, target, Some(result))
    })
}
#[tauri::command]
pub(crate) async fn hosted_text_refresh(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<LocalComputerState>>,
    request: Target,
) -> Result<ControlResult, String> {
    main(&window)?;
    refresh(&app, &state, &request).await
}
#[tauri::command]
pub(crate) async fn hosted_text_stop(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<LocalComputerState>>,
    request: Target,
) -> Result<ControlResult, String> {
    main(&window)?;
    let ticket = ticket(&state, &request.workspace_id, &request.agent_id)?;
    commit(&ticket, || hosted::stop(&app, &ticket, &request))?;
    let next = hosted::pending(&app)?
        .into_iter()
        .find(|t| t.work_id == request.work_id)
        .ok_or("Cloud Stop is saved. Refresh its current state.")?;
    refresh(&app, &state, &next).await
}
#[tauri::command]
pub(crate) async fn hosted_provider_list(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<LocalComputerState>>,
    request: ProviderScope,
) -> Result<Vec<ProviderConnection>, String> {
    main(&window)?;
    let ticket = ticket(&state, &request.workspace_id, &request.agent_id)?;
    let scope = transport::cloud_scope()?;
    let (connections, _) = transport::connections(&ticket, &scope, &request.agent_id).await?;
    ticket.finish(Ok(connections))
}
#[tauri::command]
pub(crate) async fn hosted_provider_revoke(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<LocalComputerState>>,
    request: ProviderRevoke,
) -> Result<ProviderConnection, String> {
    main(&window)?;
    valid_id(&request.credential_id)?;
    let ticket = ticket(&state, &request.workspace_id, &request.agent_id)?;
    let scope = transport::cloud_scope()?;
    let (value, _) = transport::call(
        &ticket,
        &scope,
        &request.agent_id,
        "credentials",
        &request.credential_id,
        "revoke",
        json!({"credentialId":request.credential_id,"revision":request.revision}),
        None,
        None,
        None,
    )
    .await?;
    ticket.finish(serde_json::from_value(value).map_err(|_| {
        "Cloud revocation outcome is uncertain. Refresh before replacing the connection.".into()
    }))
}
pub(crate) fn start_maintenance(app: tauri::AppHandle, state: Arc<LocalComputerState>) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
            if crate::account_session::ensure_current().is_err() {
                // Pinned account state never retargets another account. A
                // temporary session outage must not permanently kill refresh.
                continue;
            }
            if let Ok(targets) = hosted::pending(&app) {
                for target in targets {
                    let _ = refresh(&app, &state, &target).await;
                }
            }
        }
    });
}
pub(crate) fn wake_pending(app: tauri::AppHandle) {
    use std::sync::atomic::{AtomicBool, Ordering};
    use tauri::Manager;
    static WAKING: AtomicBool = AtomicBool::new(false);
    if WAKING.swap(true, Ordering::AcqRel) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        if let Some(state) = app
            .try_state::<Arc<LocalComputerState>>()
            .map(|s| s.inner().clone())
        {
            if let Ok(targets) = hosted::pending(&app) {
                for target in targets {
                    let _ = refresh(&app, &state, &target).await;
                }
            }
        }
        WAKING.store(false, Ordering::Release);
    });
}
