//! Authenticated renderer-to-Convex bridge for the hosted computer control plane.
//!
//! The webview never receives Clerk tokens or the runner service credential.
//! It can request provisioning only for the current signed-in user's active
//! device; Convex remains authoritative for workspace membership and role.

mod commands;
mod contracts;
mod live_view;
#[cfg(test)]
mod tests;
mod transport;
mod validation;

use contracts::HostedExecutionCapabilityReceipt;
pub use contracts::{
    CommitHostedBrowserActionRequest, CommitHostedBrowserNavigationRequest,
    CommitHostedProcessLaunchRequest, HostedBrowserActionDraft, HostedBrowserActionProposal,
    HostedBrowserNavigateDraft, HostedBrowserNavigateProposal, HostedBrowserNavigationSnapshot,
    HostedBrowserSnapshot, HostedBrowserTarget, HostedBrowserViewportSnapshot,
    HostedComputerProvisionReceipt, HostedExecutionNodeSnapshot, HostedProcessDraft,
    HostedProcessLaunchProposal, HostedProcessSnapshot, HostedProcessTarget,
    PreparedHostedBrowserAction, PreparedHostedBrowserNavigation, PreparedHostedProcessLaunch,
};
#[cfg(test)]
use live_view::{live_view_handle, live_view_handles, store_live_view};
use live_view::{live_view_url_for_open, retain_live_view_for_frontend};
use transport::{
    call_convex, fetch_process_snapshot, request_execution_capability,
    require_matching_hosted_scope, runner_json, runner_url,
};
pub(crate) use validation::normalize_public_https_url;
use validation::{
    approval_for_browser, approval_for_browser_action, approval_for_process,
    browser_action_fingerprint, browser_proposal_fingerprint, normalize_browser_action_draft,
    normalize_browser_draft, normalize_browser_target, normalize_draft, opaque_key,
    proposal_fingerprint, valid_id, validate_browser_action_proposal, validate_browser_proposal,
    validate_browser_snapshot, validate_live_view_url, validate_node, validate_process_id,
    validate_process_snapshot, validate_proposal,
};

const ACCOUNT_CHANGED_ERROR: &str = "Mivlet account changed during the request. Please try again.";
const MAX_RUNNER_RESPONSE_BYTES: usize = 600 * 1024;
const MAX_PROCESS_ARGUMENTS: usize = 20;
const MAX_PROCESS_ARGUMENT_CHARACTERS: usize = 200;
const MIN_PROCESS_TIMEOUT_MS: u64 = 1_000;
const MAX_PROCESS_TIMEOUT_MS: u64 = 15 * 60_000;
const HOSTED_COMPUTER_SERVICE: &str = "Mivlet cloud computer";
const HOSTED_PROCESS_CONFIRMATION: &str = "run on cloud computer";
const HOSTED_BROWSER_CONFIRMATION: &str = "open cloud browser";
const HOSTED_BROWSER_ACTION_CONFIRMATION: &str = "act in cloud browser";
const LIVE_VIEW_TTL: std::time::Duration = std::time::Duration::from_secs(5 * 60);

#[tauri::command]
pub async fn hosted_computer_status(
    workspace_id: String,
    agent_id: String,
) -> Result<Option<HostedExecutionNodeSnapshot>, String> {
    commands::hosted_computer_status_impl(workspace_id, agent_id).await
}

#[tauri::command]
pub async fn hosted_computer_provision(
    workspace_id: String,
    agent_id: String,
    device_id: String,
) -> Result<HostedComputerProvisionReceipt, String> {
    commands::hosted_computer_provision_impl(workspace_id, agent_id, device_id).await
}

#[tauri::command]
pub fn hosted_process_prepare(
    draft: HostedProcessDraft,
) -> Result<PreparedHostedProcessLaunch, String> {
    commands::hosted_process_prepare_impl(draft)
}

#[tauri::command]
pub async fn hosted_process_launch(
    app: tauri::AppHandle,
    request: CommitHostedProcessLaunchRequest,
) -> Result<HostedProcessSnapshot, String> {
    commands::hosted_process_launch_impl(app, request).await
}

#[tauri::command]
pub async fn hosted_process_status(
    target: HostedProcessTarget,
) -> Result<HostedProcessSnapshot, String> {
    commands::hosted_process_status_impl(target).await
}

#[tauri::command]
pub async fn hosted_process_kill(
    target: HostedProcessTarget,
) -> Result<HostedProcessSnapshot, String> {
    commands::hosted_process_kill_impl(target).await
}

#[tauri::command]
pub fn hosted_browser_prepare(
    draft: HostedBrowserNavigateDraft,
) -> Result<PreparedHostedBrowserNavigation, String> {
    commands::hosted_browser_prepare_impl(draft)
}

#[tauri::command]
pub async fn hosted_browser_navigate(
    app: tauri::AppHandle,
    request: CommitHostedBrowserNavigationRequest,
) -> Result<HostedBrowserSnapshot, String> {
    commands::hosted_browser_navigate_impl(app, request).await
}

#[tauri::command]
pub fn hosted_browser_action_prepare(
    draft: HostedBrowserActionDraft,
) -> Result<PreparedHostedBrowserAction, String> {
    commands::hosted_browser_action_prepare_impl(draft)
}

#[tauri::command]
pub async fn hosted_browser_action(
    app: tauri::AppHandle,
    request: CommitHostedBrowserActionRequest,
) -> Result<HostedBrowserSnapshot, String> {
    commands::hosted_browser_action_impl(app, request).await
}

#[tauri::command]
pub async fn hosted_browser_snapshot(
    target: HostedBrowserTarget,
) -> Result<HostedBrowserSnapshot, String> {
    commands::hosted_browser_snapshot_impl(target).await
}

#[tauri::command]
pub fn hosted_browser_open_live_view(target: HostedBrowserTarget) -> Result<(), String> {
    commands::hosted_browser_open_live_view_impl(target)
}
