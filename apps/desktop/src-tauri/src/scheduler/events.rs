//! Tauri event adaptation for durable scheduler transitions.

use tauri::{AppHandle, Emitter};

use crate::models::SchedulerQueueEntry;

/// Emit a run-request event so the TS scheduler driver picks up a due job.
pub(crate) fn emit_run_request(app: &AppHandle, entry: &SchedulerQueueEntry) {
    let execution = entry.execution.as_ref().map(|route| {
        serde_json::json!({
            "policy": route.policy,
            "backendId": route.backend_id,
            "modelId": route.model_id,
            "permissionMode": route.permission_mode,
            "permissionProfile": route.permission_profile,
        })
    });
    let _ = app.emit(
        "fable://scheduler/run-request",
        serde_json::json!({
            "jobId": entry.job_id,
            "runId": entry.run_id,
            "scheduledAt": entry.scheduled_at,
            "leaseToken": entry.lease_token,
            "attemptNumber": super::logic::failed_count(entry) + 1,
            "workspaceId": entry.workspace_id,
            "projectId": entry.project_id,
            "execution": execution,
        }),
    );
}
