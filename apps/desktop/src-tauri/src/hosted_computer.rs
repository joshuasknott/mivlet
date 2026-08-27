//! Authenticated renderer-to-Convex bridge for the hosted computer control plane.
//!
//! The webview never receives Clerk tokens or the runner service credential.
//! It can request provisioning only for the current signed-in user's active
//! device; Convex remains authoritative for workspace membership and role.

use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use chrono::{SecondsFormat, Utc};
use futures_util::StreamExt;
use reqwest::{header, Method};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::Duration;
use url::Url;

use crate::clerk_identity::{self, ConvexFunctionType, ConvexIdentityCallRequest};
use crate::models::{ApprovalRequest, ApprovalResolutionRequest};

const ACCOUNT_CHANGED_ERROR: &str = "Fable account changed during the request. Please try again.";
const MAX_RUNNER_RESPONSE_BYTES: usize = 600 * 1024;
const MAX_PROCESS_ARGUMENTS: usize = 20;
const MAX_PROCESS_ARGUMENT_CHARACTERS: usize = 200;
const MIN_PROCESS_TIMEOUT_MS: u64 = 1_000;
const MAX_PROCESS_TIMEOUT_MS: u64 = 15 * 60_000;
const HOSTED_COMPUTER_SERVICE: &str = "Fable cloud computer";
const HOSTED_PROCESS_CONFIRMATION: &str = "run on cloud computer";
const HOSTED_SCHEDULE_CONFIRMATION: &str = "schedule on cloud computer";
const HOSTED_SCHEDULE_CANCEL_CONFIRMATION: &str = "cancel cloud schedule";
const HOSTED_SCHEDULE_CONTROL_CONFIRMATION: &str = "change cloud schedule";
const HOSTED_AGENT_ROUTINE_CONFIRMATION: &str = "schedule cloud teammate";
const HOSTED_AGENT_ROUTINE_CANCEL_CONFIRMATION: &str = "cancel cloud routine";
const HOSTED_AGENT_ROUTINE_CONTROL_CONFIRMATION: &str = "change cloud routine";
const HOSTED_BROWSER_CONFIRMATION: &str = "open cloud browser";
const HOSTED_BROWSER_ACTION_CONFIRMATION: &str = "act in cloud browser";

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedExecutionNodeSnapshot {
    execution_node_id: String,
    workspace_id: String,
    agent_id: String,
    locality: String,
    status: String,
    runtime_active: bool,
    keep_alive: bool,
    runner_generation: i64,
    revision: i64,
    updated_at: i64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedComputerProvisionReceipt {
    request_key: String,
    execution_node_id: String,
    computer_id: String,
    status: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedProcessDraft {
    workspace_id: String,
    agent_id: String,
    device_id: String,
    run_id: String,
    argv: Vec<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    timeout_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedProcessLaunchProposal {
    request_key: String,
    workspace_id: String,
    agent_id: String,
    device_id: String,
    run_id: String,
    argv: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedHostedProcessLaunch {
    proposal: HostedProcessLaunchProposal,
    proposal_fingerprint: String,
    approval: ApprovalRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitHostedProcessLaunchRequest {
    proposal: HostedProcessLaunchProposal,
    resolution: ApprovalResolutionRequest,
    source_resolution: ApprovalResolutionRequest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedProcessTarget {
    workspace_id: String,
    agent_id: String,
    device_id: String,
    process_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostedExecutionCapabilityReceipt {
    runner_url: String,
    token: String,
    computer_id: String,
    generation: i64,
    expires_at: i64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedProcessSnapshot {
    request_key: String,
    run_id: String,
    lifecycle: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    process_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pid: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ended_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    exit_code: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    timed_out: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    stdout: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    stderr: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    output_truncated: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedProcessScheduleDraft {
    workspace_id: String,
    agent_id: String,
    device_id: String,
    schedule_id: String,
    run_id: String,
    argv: Vec<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    timeout_ms: Option<u64>,
    first_run_at: String,
    interval_seconds: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedProcessScheduleProposal {
    request_key: String,
    workspace_id: String,
    agent_id: String,
    device_id: String,
    schedule_id: String,
    run_id: String,
    argv: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    timeout_ms: Option<u64>,
    first_run_at: String,
    interval_seconds: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedHostedProcessSchedule {
    proposal: HostedProcessScheduleProposal,
    proposal_fingerprint: String,
    approval: ApprovalRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitHostedProcessScheduleRequest {
    proposal: HostedProcessScheduleProposal,
    resolution: ApprovalResolutionRequest,
    source_resolution: ApprovalResolutionRequest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedProcessScheduleTarget {
    workspace_id: String,
    agent_id: String,
    device_id: String,
    schedule_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedProcessScheduleListTarget {
    workspace_id: String,
    agent_id: String,
    device_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedProcessScheduleCancelProposal {
    request_key: String,
    workspace_id: String,
    agent_id: String,
    device_id: String,
    schedule_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedHostedProcessScheduleCancel {
    proposal: HostedProcessScheduleCancelProposal,
    proposal_fingerprint: String,
    approval: ApprovalRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitHostedProcessScheduleCancelRequest {
    proposal: HostedProcessScheduleCancelProposal,
    resolution: ApprovalResolutionRequest,
    source_resolution: ApprovalResolutionRequest,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedProcessScheduleControlDraft {
    workspace_id: String,
    agent_id: String,
    device_id: String,
    schedule_id: String,
    action: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedProcessScheduleControlProposal {
    request_key: String,
    workspace_id: String,
    agent_id: String,
    device_id: String,
    schedule_id: String,
    action: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedHostedProcessScheduleControl {
    proposal: HostedProcessScheduleControlProposal,
    proposal_fingerprint: String,
    approval: ApprovalRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitHostedProcessScheduleControlRequest {
    proposal: HostedProcessScheduleControlProposal,
    resolution: ApprovalResolutionRequest,
    source_resolution: ApprovalResolutionRequest,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedProcessScheduleSnapshot {
    schedule_id: String,
    request_key: String,
    run_id: String,
    lifecycle: String,
    first_run_at: String,
    interval_seconds: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    next_run_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_run_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_process_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_error_code: Option<String>,
    generation: i64,
    updated_at: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedProcessScheduleRunSnapshot {
    occurrence_id: String,
    schedule_id: String,
    scheduled_at: String,
    request_key: String,
    run_id: String,
    lifecycle: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    process_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ended_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    exit_code: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    timed_out: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error_code: Option<String>,
    generation: i64,
    updated_at: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedAgentRoutineDraft {
    workspace_id: String,
    agent_id: String,
    device_id: String,
    routine_id: String,
    run_id: String,
    title: String,
    instruction: String,
    first_run_at: String,
    interval_seconds: u64,
    capabilities: Vec<String>,
    #[serde(default)]
    max_steps: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedAgentRoutineProposal {
    request_key: String,
    workspace_id: String,
    agent_id: String,
    device_id: String,
    routine_id: String,
    run_id: String,
    title: String,
    instruction: String,
    first_run_at: String,
    interval_seconds: u64,
    capabilities: Vec<String>,
    max_steps: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedHostedAgentRoutine {
    proposal: HostedAgentRoutineProposal,
    proposal_fingerprint: String,
    approval: ApprovalRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitHostedAgentRoutineRequest {
    proposal: HostedAgentRoutineProposal,
    resolution: ApprovalResolutionRequest,
    source_resolution: ApprovalResolutionRequest,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedAgentRoutineTarget {
    workspace_id: String,
    agent_id: String,
    device_id: String,
    routine_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedAgentRoutineListTarget {
    workspace_id: String,
    agent_id: String,
    device_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedAgentRoutineCancelProposal {
    request_key: String,
    workspace_id: String,
    agent_id: String,
    device_id: String,
    routine_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedHostedAgentRoutineCancel {
    proposal: HostedAgentRoutineCancelProposal,
    proposal_fingerprint: String,
    approval: ApprovalRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitHostedAgentRoutineCancelRequest {
    proposal: HostedAgentRoutineCancelProposal,
    resolution: ApprovalResolutionRequest,
    source_resolution: ApprovalResolutionRequest,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedAgentRoutineControlDraft {
    workspace_id: String,
    agent_id: String,
    device_id: String,
    routine_id: String,
    action: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedAgentRoutineControlProposal {
    request_key: String,
    workspace_id: String,
    agent_id: String,
    device_id: String,
    routine_id: String,
    action: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedHostedAgentRoutineControl {
    proposal: HostedAgentRoutineControlProposal,
    proposal_fingerprint: String,
    approval: ApprovalRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitHostedAgentRoutineControlRequest {
    proposal: HostedAgentRoutineControlProposal,
    resolution: ApprovalResolutionRequest,
    source_resolution: ApprovalResolutionRequest,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedAgentRoutineSnapshot {
    routine_id: String,
    request_key: String,
    run_id: String,
    title: String,
    instruction: String,
    lifecycle: String,
    first_run_at: String,
    interval_seconds: u64,
    capabilities: Vec<String>,
    max_steps: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    next_run_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_run_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_run_lifecycle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_result: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_error_code: Option<String>,
    generation: i64,
    updated_at: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedAgentRoutineToolRunSnapshot {
    tool: String,
    summary: String,
    status: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedAgentRoutineRunSnapshot {
    occurrence_id: String,
    routine_id: String,
    run_id: String,
    scheduled_at: String,
    lifecycle: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    result: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error_code: Option<String>,
    tools: Vec<HostedAgentRoutineToolRunSnapshot>,
    started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ended_at: Option<String>,
    generation: i64,
    updated_at: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedBrowserNavigateDraft {
    workspace_id: String,
    agent_id: String,
    device_id: String,
    url: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedBrowserNavigateProposal {
    request_key: String,
    workspace_id: String,
    agent_id: String,
    device_id: String,
    url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedHostedBrowserNavigation {
    proposal: HostedBrowserNavigateProposal,
    proposal_fingerprint: String,
    approval: ApprovalRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitHostedBrowserNavigationRequest {
    proposal: HostedBrowserNavigateProposal,
    resolution: ApprovalResolutionRequest,
    #[serde(default)]
    source_resolution: Option<ApprovalResolutionRequest>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedBrowserActionDraft {
    workspace_id: String,
    agent_id: String,
    device_id: String,
    observation_id: String,
    element_ref: String,
    control_role: String,
    control_name: String,
    action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    key: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedBrowserActionProposal {
    request_key: String,
    workspace_id: String,
    agent_id: String,
    device_id: String,
    observation_id: String,
    element_ref: String,
    control_role: String,
    control_name: String,
    action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    key: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedHostedBrowserAction {
    proposal: HostedBrowserActionProposal,
    proposal_fingerprint: String,
    approval: ApprovalRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitHostedBrowserActionRequest {
    proposal: HostedBrowserActionProposal,
    resolution: ApprovalResolutionRequest,
    source_resolution: ApprovalResolutionRequest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedBrowserTarget {
    workspace_id: String,
    agent_id: String,
    device_id: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedBrowserSnapshot {
    current_url: String,
    title: String,
    observation_id: String,
    viewport: HostedBrowserViewportSnapshot,
    navigation: HostedBrowserNavigationSnapshot,
    controls: Vec<HostedBrowserControl>,
    preview_data_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    live_view_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_download: Option<HostedBrowserDownloadSnapshot>,
    updated_at: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedBrowserDownloadSnapshot {
    file_name: String,
    workspace_path: String,
    bytes_written: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedBrowserNavigationSnapshot {
    can_go_back: bool,
    can_go_forward: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedBrowserViewportSnapshot {
    scroll_x: u64,
    scroll_y: u64,
    width: u64,
    height: u64,
    document_width: u64,
    document_height: u64,
    can_scroll_up: bool,
    can_scroll_down: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedBrowserControl {
    r#ref: String,
    role: String,
    name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    options: Option<Vec<String>>,
}

fn valid_id(value: &str) -> bool {
    (3..=160).contains(&value.len())
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'_' | b'-' | b'.' | b':'))
        })
}

fn valid_schedule_id(value: &str) -> bool {
    let Some(suffix) = value.strip_prefix("schedule-") else {
        return false;
    };
    (8..=120).contains(&suffix.len())
        && suffix
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn valid_routine_id(value: &str) -> bool {
    let Some(suffix) = value.strip_prefix("routine-") else {
        return false;
    };
    (8..=120).contains(&suffix.len())
        && suffix
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn opaque_key(prefix: &str) -> Result<String, String> {
    let mut bytes = [0_u8; 24];
    getrandom::fill(&mut bytes)
        .map_err(|_| "Fable could not create a hosted computer request.".to_string())?;
    Ok(format!("{prefix}-{}", URL_SAFE_NO_PAD.encode(bytes)))
}

fn unwrap_success(envelope: Value) -> Result<Value, String> {
    let object = envelope
        .as_object()
        .ok_or_else(|| "The hosted computer response is malformed.".to_string())?;
    if object.len() != 2 || object.get("status").and_then(Value::as_str) != Some("success") {
        return Err("The hosted computer request was rejected.".into());
    }
    object
        .get("value")
        .cloned()
        .ok_or_else(|| "The hosted computer response omitted its value.".into())
}

async fn call_convex(
    function_type: ConvexFunctionType,
    path: &str,
    args: Value,
) -> Result<Value, String> {
    let before = clerk_identity::native_identity_generation_snapshot()?;
    let envelope = clerk_identity::call_convex(ConvexIdentityCallRequest {
        function_type,
        function_path: path.to_string(),
        args,
    })
    .await?;
    let after = clerk_identity::native_identity_generation_snapshot()
        .map_err(|_| ACCOUNT_CHANGED_ERROR.to_string())?;
    if after != before {
        return Err(ACCOUNT_CHANGED_ERROR.into());
    }
    let _identity_guard = clerk_identity::lock_native_identity_generation(&before)?;
    unwrap_success(envelope)
}

fn validate_process_id(value: &str) -> bool {
    valid_id(value) && value.len() <= 160
}

fn normalize_cwd(value: Option<String>) -> Result<Option<String>, String> {
    let Some(value) = value else { return Ok(None) };
    let value = value.trim().replace('\\', "/");
    if value == "/workspace" {
        return Ok(Some(value));
    }
    if !value.starts_with("/workspace/")
        || value.contains("//")
        || value
            .split('/')
            .any(|segment| segment == "." || segment == "..")
        || value.chars().any(char::is_control)
        || value.len() > 512
    {
        return Err("The hosted process working directory must stay below /workspace.".into());
    }
    Ok(Some(value))
}

fn normalize_draft(draft: HostedProcessDraft) -> Result<HostedProcessDraft, String> {
    if !valid_id(&draft.workspace_id)
        || !valid_id(&draft.agent_id)
        || !valid_id(&draft.device_id)
        || !valid_id(&draft.run_id)
    {
        return Err("The hosted process scope is invalid.".into());
    }
    if draft.argv.is_empty() || draft.argv.len() > MAX_PROCESS_ARGUMENTS {
        return Err("Hosted processes need between 1 and 20 explicit arguments.".into());
    }
    let mut argv = Vec::with_capacity(draft.argv.len());
    for argument in draft.argv {
        if argument.is_empty()
            || argument.chars().count() > MAX_PROCESS_ARGUMENT_CHARACTERS
            || argument
                .chars()
                .any(|character| character == '\0' || character.is_control())
        {
            return Err("Hosted process arguments must be visible, non-empty text of at most 200 characters each.".into());
        }
        argv.push(argument);
    }
    if draft.timeout_ms.is_some_and(|timeout| {
        !(MIN_PROCESS_TIMEOUT_MS..=MAX_PROCESS_TIMEOUT_MS).contains(&timeout)
    }) {
        return Err("Hosted process timeouts must be between 1 second and 15 minutes.".into());
    }
    Ok(HostedProcessDraft {
        workspace_id: draft.workspace_id,
        agent_id: draft.agent_id,
        device_id: draft.device_id,
        run_id: draft.run_id,
        argv,
        cwd: normalize_cwd(draft.cwd)?,
        timeout_ms: draft.timeout_ms,
    })
}

fn normalize_schedule_draft(
    draft: HostedProcessScheduleDraft,
) -> Result<HostedProcessScheduleDraft, String> {
    let process = normalize_draft(HostedProcessDraft {
        workspace_id: draft.workspace_id,
        agent_id: draft.agent_id,
        device_id: draft.device_id,
        run_id: draft.run_id,
        argv: draft.argv,
        cwd: draft.cwd,
        timeout_ms: draft.timeout_ms,
    })?;
    if !valid_schedule_id(&draft.schedule_id)
        || process.run_id.len() > 100
        || !(5 * 60..=7 * 24 * 60 * 60).contains(&draft.interval_seconds)
    {
        return Err("The hosted process schedule is invalid.".into());
    }
    let parsed = chrono::DateTime::parse_from_rfc3339(&draft.first_run_at)
        .map_err(|_| "The hosted process schedule time is invalid.".to_string())?
        .with_timezone(&Utc);
    let delay = parsed.signed_duration_since(Utc::now());
    if delay < chrono::Duration::seconds(10) || delay > chrono::Duration::days(30) {
        return Err(
            "The hosted process schedule must start between 10 seconds and 30 days from now."
                .into(),
        );
    }
    Ok(HostedProcessScheduleDraft {
        workspace_id: process.workspace_id,
        agent_id: process.agent_id,
        device_id: process.device_id,
        schedule_id: draft.schedule_id,
        run_id: process.run_id,
        argv: process.argv,
        cwd: process.cwd,
        timeout_ms: process.timeout_ms,
        first_run_at: parsed.to_rfc3339_opts(SecondsFormat::Millis, true),
        interval_seconds: draft.interval_seconds,
    })
}

fn validate_schedule_proposal(
    proposal: HostedProcessScheduleProposal,
) -> Result<HostedProcessScheduleProposal, String> {
    if !valid_id(&proposal.request_key) || !proposal.request_key.starts_with("schedule-request-") {
        return Err("The hosted process schedule request key is invalid.".into());
    }
    let draft = normalize_schedule_draft(HostedProcessScheduleDraft {
        workspace_id: proposal.workspace_id,
        agent_id: proposal.agent_id,
        device_id: proposal.device_id,
        schedule_id: proposal.schedule_id,
        run_id: proposal.run_id,
        argv: proposal.argv,
        cwd: proposal.cwd,
        timeout_ms: proposal.timeout_ms,
        first_run_at: proposal.first_run_at,
        interval_seconds: proposal.interval_seconds,
    })?;
    Ok(HostedProcessScheduleProposal {
        request_key: proposal.request_key,
        workspace_id: draft.workspace_id,
        agent_id: draft.agent_id,
        device_id: draft.device_id,
        schedule_id: draft.schedule_id,
        run_id: draft.run_id,
        argv: draft.argv,
        cwd: draft.cwd,
        timeout_ms: draft.timeout_ms,
        first_run_at: draft.first_run_at,
        interval_seconds: draft.interval_seconds,
    })
}

fn schedule_fingerprint(proposal: &HostedProcessScheduleProposal) -> Result<String, String> {
    let encoded = serde_json::to_vec(proposal)
        .map_err(|_| "Fable could not fingerprint the hosted process schedule.".to_string())?;
    Ok(format!("{:x}", Sha256::digest(encoded)))
}

fn normalize_schedule_cancel_proposal(
    proposal: HostedProcessScheduleCancelProposal,
) -> Result<HostedProcessScheduleCancelProposal, String> {
    if !valid_id(&proposal.request_key)
        || !proposal.request_key.starts_with("schedule-cancel-")
        || !valid_id(&proposal.workspace_id)
        || !valid_id(&proposal.agent_id)
        || !valid_id(&proposal.device_id)
        || !valid_schedule_id(&proposal.schedule_id)
    {
        return Err("The hosted process schedule cancellation is invalid.".into());
    }
    Ok(proposal)
}

fn schedule_cancel_fingerprint(
    proposal: &HostedProcessScheduleCancelProposal,
) -> Result<String, String> {
    let encoded = serde_json::to_vec(proposal)
        .map_err(|_| "Fable could not fingerprint the hosted schedule cancellation.".to_string())?;
    Ok(format!("{:x}", Sha256::digest(encoded)))
}

fn normalize_schedule_control_draft(
    draft: HostedProcessScheduleControlDraft,
) -> Result<HostedProcessScheduleControlDraft, String> {
    if !valid_id(&draft.workspace_id)
        || !valid_id(&draft.agent_id)
        || !valid_id(&draft.device_id)
        || !valid_schedule_id(&draft.schedule_id)
        || !matches!(draft.action.as_str(), "pause" | "resume")
    {
        return Err("The hosted process schedule change is invalid.".into());
    }
    Ok(draft)
}

fn normalize_schedule_control_proposal(
    proposal: HostedProcessScheduleControlProposal,
) -> Result<HostedProcessScheduleControlProposal, String> {
    if !valid_id(&proposal.request_key)
        || !proposal.request_key.starts_with("schedule-control-")
    {
        return Err("The hosted process schedule change is invalid.".into());
    }
    let draft = normalize_schedule_control_draft(HostedProcessScheduleControlDraft {
        workspace_id: proposal.workspace_id,
        agent_id: proposal.agent_id,
        device_id: proposal.device_id,
        schedule_id: proposal.schedule_id,
        action: proposal.action,
    })?;
    Ok(HostedProcessScheduleControlProposal {
        request_key: proposal.request_key,
        workspace_id: draft.workspace_id,
        agent_id: draft.agent_id,
        device_id: draft.device_id,
        schedule_id: draft.schedule_id,
        action: draft.action,
    })
}

fn schedule_control_fingerprint(
    proposal: &HostedProcessScheduleControlProposal,
) -> Result<String, String> {
    let encoded = serde_json::to_vec(proposal)
        .map_err(|_| "Fable could not fingerprint the hosted schedule change.".to_string())?;
    Ok(format!("{:x}", Sha256::digest(encoded)))
}

fn normalize_agent_routine_draft(
    draft: HostedAgentRoutineDraft,
) -> Result<HostedAgentRoutineDraft, String> {
    if !valid_id(&draft.workspace_id)
        || !valid_id(&draft.agent_id)
        || !valid_id(&draft.device_id)
        || !valid_routine_id(&draft.routine_id)
        || !valid_id(&draft.run_id)
        || draft.run_id.len() > 100
        || draft.title.is_empty()
        || draft.title.chars().count() > 120
        || draft.title.chars().any(char::is_control)
        || draft.instruction.is_empty()
        || draft.instruction.chars().count() > 12_000
        || draft.instruction.chars().any(|character| {
            character.is_control() && !matches!(character, '\n' | '\r' | '\t')
        })
        || !(5 * 60..=7 * 24 * 60 * 60).contains(&draft.interval_seconds)
    {
        return Err("The hosted agent routine is invalid.".into());
    }
    if draft.title.trim() != draft.title || draft.instruction.trim() != draft.instruction {
        return Err("The hosted agent routine text must not have surrounding whitespace.".into());
    }
    let parsed = chrono::DateTime::parse_from_rfc3339(&draft.first_run_at)
        .map_err(|_| "The hosted agent routine time is invalid.".to_string())?
        .with_timezone(&Utc);
    let delay = parsed.signed_duration_since(Utc::now());
    if delay < chrono::Duration::seconds(10) || delay > chrono::Duration::days(30) {
        return Err("The hosted agent routine must start between 10 seconds and 30 days from now.".into());
    }
    let max_steps = draft.max_steps.unwrap_or(6);
    if !(1..=8).contains(&max_steps) {
        return Err("Hosted agent routines allow between 1 and 8 tool steps per run.".into());
    }
    let allowed = ["workspace-read", "workspace-write", "process-run"];
    if draft.capabilities.is_empty()
        || draft.capabilities.len() > allowed.len()
        || draft.capabilities.iter().any(|value| !allowed.contains(&value.as_str()))
        || !draft.capabilities.iter().any(|value| value == "workspace-read")
    {
        return Err("The hosted agent routine capabilities are invalid.".into());
    }
    let capabilities = allowed
        .iter()
        .filter(|capability| draft.capabilities.iter().any(|value| value == **capability))
        .map(|value| (*value).to_string())
        .collect();
    Ok(HostedAgentRoutineDraft {
        workspace_id: draft.workspace_id,
        agent_id: draft.agent_id,
        device_id: draft.device_id,
        routine_id: draft.routine_id,
        run_id: draft.run_id,
        title: draft.title,
        instruction: draft.instruction,
        first_run_at: parsed.to_rfc3339_opts(SecondsFormat::Millis, true),
        interval_seconds: draft.interval_seconds,
        capabilities,
        max_steps: Some(max_steps),
    })
}

fn validate_agent_routine_proposal(
    proposal: HostedAgentRoutineProposal,
) -> Result<HostedAgentRoutineProposal, String> {
    if !valid_id(&proposal.request_key) || !proposal.request_key.starts_with("agent-routine-request-") {
        return Err("The hosted agent routine request key is invalid.".into());
    }
    let draft = normalize_agent_routine_draft(HostedAgentRoutineDraft {
        workspace_id: proposal.workspace_id,
        agent_id: proposal.agent_id,
        device_id: proposal.device_id,
        routine_id: proposal.routine_id,
        run_id: proposal.run_id,
        title: proposal.title,
        instruction: proposal.instruction,
        first_run_at: proposal.first_run_at,
        interval_seconds: proposal.interval_seconds,
        capabilities: proposal.capabilities,
        max_steps: Some(proposal.max_steps),
    })?;
    Ok(HostedAgentRoutineProposal {
        request_key: proposal.request_key,
        workspace_id: draft.workspace_id,
        agent_id: draft.agent_id,
        device_id: draft.device_id,
        routine_id: draft.routine_id,
        run_id: draft.run_id,
        title: draft.title,
        instruction: draft.instruction,
        first_run_at: draft.first_run_at,
        interval_seconds: draft.interval_seconds,
        capabilities: draft.capabilities,
        max_steps: draft.max_steps.unwrap_or(6),
    })
}

fn agent_routine_fingerprint(proposal: &HostedAgentRoutineProposal) -> Result<String, String> {
    let encoded = serde_json::to_vec(proposal)
        .map_err(|_| "Fable could not fingerprint the hosted agent routine.".to_string())?;
    Ok(format!("{:x}", Sha256::digest(encoded)))
}

fn normalize_agent_routine_cancel_proposal(
    proposal: HostedAgentRoutineCancelProposal,
) -> Result<HostedAgentRoutineCancelProposal, String> {
    if !valid_id(&proposal.request_key)
        || !proposal.request_key.starts_with("agent-routine-cancel-")
        || !valid_id(&proposal.workspace_id)
        || !valid_id(&proposal.agent_id)
        || !valid_id(&proposal.device_id)
        || !valid_routine_id(&proposal.routine_id)
    {
        return Err("The hosted agent routine cancellation is invalid.".into());
    }
    Ok(proposal)
}

fn agent_routine_cancel_fingerprint(proposal: &HostedAgentRoutineCancelProposal) -> Result<String, String> {
    let encoded = serde_json::to_vec(proposal)
        .map_err(|_| "Fable could not fingerprint the hosted agent routine cancellation.".to_string())?;
    Ok(format!("{:x}", Sha256::digest(encoded)))
}

fn normalize_agent_routine_control_draft(
    draft: HostedAgentRoutineControlDraft,
) -> Result<HostedAgentRoutineControlDraft, String> {
    if !valid_id(&draft.workspace_id)
        || !valid_id(&draft.agent_id)
        || !valid_id(&draft.device_id)
        || !valid_routine_id(&draft.routine_id)
        || !matches!(draft.action.as_str(), "pause" | "resume")
    {
        return Err("The hosted agent routine change is invalid.".into());
    }
    Ok(draft)
}

fn normalize_agent_routine_control_proposal(
    proposal: HostedAgentRoutineControlProposal,
) -> Result<HostedAgentRoutineControlProposal, String> {
    if !valid_id(&proposal.request_key) || !proposal.request_key.starts_with("agent-routine-control-") {
        return Err("The hosted agent routine change is invalid.".into());
    }
    let draft = normalize_agent_routine_control_draft(HostedAgentRoutineControlDraft {
        workspace_id: proposal.workspace_id,
        agent_id: proposal.agent_id,
        device_id: proposal.device_id,
        routine_id: proposal.routine_id,
        action: proposal.action,
    })?;
    Ok(HostedAgentRoutineControlProposal {
        request_key: proposal.request_key,
        workspace_id: draft.workspace_id,
        agent_id: draft.agent_id,
        device_id: draft.device_id,
        routine_id: draft.routine_id,
        action: draft.action,
    })
}

fn agent_routine_control_fingerprint(proposal: &HostedAgentRoutineControlProposal) -> Result<String, String> {
    let encoded = serde_json::to_vec(proposal)
        .map_err(|_| "Fable could not fingerprint the hosted agent routine change.".to_string())?;
    Ok(format!("{:x}", Sha256::digest(encoded)))
}

pub(crate) fn normalize_public_https_url(value: &str) -> Result<String, String> {
    if value.trim() != value || value.len() > 2_048 || value.chars().any(char::is_control) {
        return Err("The cloud browser URL is invalid.".into());
    }
    let mut url = Url::parse(value).map_err(|_| "The cloud browser URL is invalid.".to_string())?;
    let host = url
        .host()
        .ok_or_else(|| "The cloud browser URL is invalid.".to_string())?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || !public_browser_host(&host)
    {
        return Err("Only public HTTPS pages can open in the cloud browser.".into());
    }
    url.set_fragment(None);
    Ok(url.to_string())
}

fn public_browser_host(host: &url::Host<&str>) -> bool {
    match host {
        url::Host::Domain(domain) => {
            let domain = domain.trim_end_matches('.').to_ascii_lowercase();
            domain.contains('.')
                && domain != "localhost"
                && !domain.ends_with(".localhost")
                && !domain.ends_with(".local")
        }
        url::Host::Ipv4(address) => {
            let octets = address.octets();
            !(address.is_private()
                || address.is_loopback()
                || address.is_link_local()
                || address.is_unspecified()
                || address.is_multicast()
                || octets[0] == 0)
        }
        url::Host::Ipv6(_) => false,
    }
}

fn normalize_browser_draft(
    draft: HostedBrowserNavigateDraft,
) -> Result<HostedBrowserNavigateDraft, String> {
    if !valid_id(&draft.workspace_id) || !valid_id(&draft.agent_id) || !valid_id(&draft.device_id) {
        return Err("The cloud browser scope is invalid.".into());
    }
    Ok(HostedBrowserNavigateDraft {
        workspace_id: draft.workspace_id,
        agent_id: draft.agent_id,
        device_id: draft.device_id,
        url: normalize_public_https_url(&draft.url)?,
    })
}

fn validate_browser_proposal(
    proposal: HostedBrowserNavigateProposal,
) -> Result<HostedBrowserNavigateProposal, String> {
    if !valid_id(&proposal.request_key) || !proposal.request_key.starts_with("browser-") {
        return Err("The cloud browser request key is invalid.".into());
    }
    let draft = normalize_browser_draft(HostedBrowserNavigateDraft {
        workspace_id: proposal.workspace_id,
        agent_id: proposal.agent_id,
        device_id: proposal.device_id,
        url: proposal.url,
    })?;
    Ok(HostedBrowserNavigateProposal {
        request_key: proposal.request_key,
        workspace_id: draft.workspace_id,
        agent_id: draft.agent_id,
        device_id: draft.device_id,
        url: draft.url,
    })
}

fn browser_proposal_fingerprint(
    proposal: &HostedBrowserNavigateProposal,
) -> Result<String, String> {
    let encoded = serde_json::to_vec(proposal)
        .map_err(|_| "Fable could not fingerprint the cloud browser request.".to_string())?;
    Ok(format!("{:x}", Sha256::digest(encoded)))
}

fn normalize_browser_action_draft(
    draft: HostedBrowserActionDraft,
) -> Result<HostedBrowserActionDraft, String> {
    if !valid_id(&draft.workspace_id)
        || !valid_id(&draft.agent_id)
        || !valid_id(&draft.device_id)
        || !valid_id(&draft.observation_id)
        || !draft.observation_id.starts_with("observation-")
        || !valid_id(&draft.element_ref)
        || !draft.element_ref.starts_with("control-")
        || draft.control_role.is_empty()
        || draft.control_role.chars().count() > 40
        || draft.control_role.chars().any(char::is_control)
        || draft.control_name.is_empty()
        || draft.control_name.chars().count() > 160
        || draft.control_name.chars().any(char::is_control)
    {
        return Err("The cloud browser action scope is invalid.".into());
    }
    let unsafe_text = |value: &str| {
        value.chars().any(|character| {
            (character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
                || character == '\u{7f}'
        })
    };
    match draft.action.as_str() {
        "click" | "download" if draft.value.is_none() && draft.key.is_none() => {}
        "fill"
            if draft.key.is_none()
                && draft
                    .value
                    .as_deref()
                    .is_some_and(|value| value.chars().count() <= 2_000 && !unsafe_text(value)) => {
        }
        "select"
            if draft.key.is_none()
                && draft
                    .value
                    .as_deref()
                    .is_some_and(|value| value.chars().count() <= 2_000 && !unsafe_text(value)) => {
        }
        "scroll"
            if draft.key.is_none()
                && draft.control_role == "document"
                && draft.control_name == "Page"
                && draft.element_ref
                    == format!(
                        "control-{}-0",
                        draft
                            .observation_id
                            .strip_prefix("observation-")
                            .unwrap_or_default()
                    )
                && draft.value.as_deref().is_some_and(|value| {
                    matches!(
                        value,
                        "half-page-up" | "half-page-down" | "page-up" | "page-down"
                    )
                }) => {}
        "history"
            if draft.key.is_none()
                && draft.control_role == "document"
                && draft.control_name == "Page"
                && draft.element_ref
                    == format!(
                        "control-{}-0",
                        draft
                            .observation_id
                            .strip_prefix("observation-")
                            .unwrap_or_default()
                    )
                && draft
                    .value
                    .as_deref()
                    .is_some_and(|value| matches!(value, "back" | "forward")) => {}
        "press"
            if draft.value.is_none()
                && draft.key.as_deref().is_some_and(|key| {
                    matches!(
                        key,
                        "Enter"
                            | "Escape"
                            | "Tab"
                            | "ArrowUp"
                            | "ArrowDown"
                            | "ArrowLeft"
                            | "ArrowRight"
                            | "Space"
                    )
                }) => {}
        _ => return Err("The cloud browser action is invalid.".into()),
    }
    Ok(draft)
}

fn validate_browser_action_proposal(
    proposal: HostedBrowserActionProposal,
) -> Result<HostedBrowserActionProposal, String> {
    if !valid_id(&proposal.request_key) || !proposal.request_key.starts_with("browser-action-") {
        return Err("The cloud browser action request key is invalid.".into());
    }
    let draft = normalize_browser_action_draft(HostedBrowserActionDraft {
        workspace_id: proposal.workspace_id,
        agent_id: proposal.agent_id,
        device_id: proposal.device_id,
        observation_id: proposal.observation_id,
        element_ref: proposal.element_ref,
        control_role: proposal.control_role,
        control_name: proposal.control_name,
        action: proposal.action,
        value: proposal.value,
        key: proposal.key,
    })?;
    Ok(HostedBrowserActionProposal {
        request_key: proposal.request_key,
        workspace_id: draft.workspace_id,
        agent_id: draft.agent_id,
        device_id: draft.device_id,
        observation_id: draft.observation_id,
        element_ref: draft.element_ref,
        control_role: draft.control_role,
        control_name: draft.control_name,
        action: draft.action,
        value: draft.value,
        key: draft.key,
    })
}

fn browser_action_fingerprint(proposal: &HostedBrowserActionProposal) -> Result<String, String> {
    let encoded = serde_json::to_vec(proposal)
        .map_err(|_| "Fable could not fingerprint the cloud browser action.".to_string())?;
    Ok(format!("{:x}", Sha256::digest(encoded)))
}

fn validate_proposal(
    proposal: HostedProcessLaunchProposal,
) -> Result<HostedProcessLaunchProposal, String> {
    if !valid_id(&proposal.request_key) || !proposal.request_key.starts_with("process-") {
        return Err("The hosted process request key is invalid.".into());
    }
    let normalized = normalize_draft(HostedProcessDraft {
        workspace_id: proposal.workspace_id,
        agent_id: proposal.agent_id,
        device_id: proposal.device_id,
        run_id: proposal.run_id,
        argv: proposal.argv,
        cwd: proposal.cwd,
        timeout_ms: proposal.timeout_ms,
    })?;
    Ok(HostedProcessLaunchProposal {
        request_key: proposal.request_key,
        workspace_id: normalized.workspace_id,
        agent_id: normalized.agent_id,
        device_id: normalized.device_id,
        run_id: normalized.run_id,
        argv: normalized.argv,
        cwd: normalized.cwd,
        timeout_ms: normalized.timeout_ms,
    })
}

fn proposal_fingerprint(proposal: &HostedProcessLaunchProposal) -> Result<String, String> {
    let encoded = serde_json::to_vec(proposal)
        .map_err(|_| "Fable could not fingerprint the hosted process request.".to_string())?;
    Ok(format!("{:x}", Sha256::digest(encoded)))
}

fn approval_for_process(
    proposal: &HostedProcessLaunchProposal,
    fingerprint: &str,
    id: String,
    requested_at: String,
) -> ApprovalRequest {
    let mut data_used = vec![
        format!(
            "computer scope: workspace {} / teammate {}",
            proposal.workspace_id, proposal.agent_id
        ),
        format!(
            "working directory: {}",
            proposal.cwd.as_deref().unwrap_or("/workspace")
        ),
        format!("timeout: {} ms", proposal.timeout_ms.unwrap_or(5 * 60_000)),
        format!("exact request fingerprint: {fingerprint}"),
    ];
    data_used.extend(proposal.argv.iter().enumerate().map(|(index, argument)| {
        if index == 0 {
            format!("program: {argument}")
        } else {
            format!("argument {index}: {argument}")
        }
    }));
    ApprovalRequest {
        id,
        service: HOSTED_COMPUTER_SERVICE.into(),
        action: format!("Run {} on this teammate's cloud computer", proposal.argv[0]),
        mode: "full-access".into(),
        risk_level: "critical".into(),
        data_used,
        consequence: "Starts the exact displayed program inside this teammate's isolated, always-on cloud computer. The program can change its workspace and access the network until it exits or is stopped.".into(),
        requested_at,
        decisions: vec!["once".into(), "deny".into()],
        confirmation_phrase: Some(HOSTED_PROCESS_CONFIRMATION.into()),
    }
}

fn approval_for_schedule(
    proposal: &HostedProcessScheduleProposal,
    fingerprint: &str,
    id: String,
    requested_at: String,
) -> ApprovalRequest {
    let mut data_used = vec![
        format!(
            "computer scope: workspace {} / teammate {}",
            proposal.workspace_id, proposal.agent_id
        ),
        format!("schedule: {}", proposal.schedule_id),
        format!("first run: {}", proposal.first_run_at),
        format!("interval: {} seconds", proposal.interval_seconds),
        format!(
            "working directory: {}",
            proposal.cwd.as_deref().unwrap_or("/workspace")
        ),
        format!("timeout: {} ms", proposal.timeout_ms.unwrap_or(5 * 60_000)),
        format!("exact request fingerprint: {fingerprint}"),
    ];
    data_used.extend(proposal.argv.iter().enumerate().map(|(index, argument)| {
        if index == 0 {
            format!("program: {argument}")
        } else {
            format!("argument {index}: {argument}")
        }
    }));
    ApprovalRequest {
        id,
        service: HOSTED_COMPUTER_SERVICE.into(),
        action: format!("Schedule {} on this teammate's cloud computer", proposal.argv[0]),
        mode: "full-access".into(),
        risk_level: "critical".into(),
        data_used,
        consequence: "Stores and repeatedly starts the exact displayed program on this teammate's isolated cloud computer, even while Fable is closed. Each run can change the hosted workspace and access the network.".into(),
        requested_at,
        decisions: vec!["once".into(), "deny".into()],
        confirmation_phrase: Some(HOSTED_SCHEDULE_CONFIRMATION.into()),
    }
}

fn approval_for_schedule_cancel(
    proposal: &HostedProcessScheduleCancelProposal,
    fingerprint: &str,
    id: String,
    requested_at: String,
) -> ApprovalRequest {
    ApprovalRequest {
        id,
        service: HOSTED_COMPUTER_SERVICE.into(),
        action: format!("Cancel hosted schedule {}", proposal.schedule_id),
        mode: "full-access".into(),
        risk_level: "critical".into(),
        data_used: vec![
            format!(
                "computer scope: workspace {} / teammate {}",
                proposal.workspace_id, proposal.agent_id
            ),
            format!("schedule: {}", proposal.schedule_id),
            format!("exact request fingerprint: {fingerprint}"),
        ],
        consequence: "Stops future launches for the displayed hosted schedule. A process that already started is not killed by this cancellation.".into(),
        requested_at,
        decisions: vec!["once".into(), "deny".into()],
        confirmation_phrase: Some(HOSTED_SCHEDULE_CANCEL_CONFIRMATION.into()),
    }
}

fn approval_for_schedule_control(
    proposal: &HostedProcessScheduleControlProposal,
    fingerprint: &str,
    id: String,
    requested_at: String,
) -> ApprovalRequest {
    let verb = if proposal.action == "pause" { "Pause" } else { "Resume" };
    ApprovalRequest {
        id,
        service: HOSTED_COMPUTER_SERVICE.into(),
        action: format!("{verb} hosted schedule {}", proposal.schedule_id),
        mode: "full-access".into(),
        risk_level: "critical".into(),
        data_used: vec![
            format!(
                "computer scope: workspace {} / teammate {}",
                proposal.workspace_id, proposal.agent_id
            ),
            format!("schedule: {}", proposal.schedule_id),
            format!("action: {}", proposal.action),
            format!("exact request fingerprint: {fingerprint}"),
        ],
        consequence: if proposal.action == "pause" {
            "Stops future launches for the displayed hosted schedule until it is resumed. A process that already started is not killed.".into()
        } else {
            "Restarts future launches for the displayed hosted schedule on its original recurrence cadence, including while Fable is closed.".into()
        },
        requested_at,
        decisions: vec!["once".into(), "deny".into()],
        confirmation_phrase: Some(HOSTED_SCHEDULE_CONTROL_CONFIRMATION.into()),
    }
}

fn approval_for_agent_routine(
    proposal: &HostedAgentRoutineProposal,
    fingerprint: &str,
    id: String,
    requested_at: String,
) -> ApprovalRequest {
    ApprovalRequest {
        id,
        service: HOSTED_COMPUTER_SERVICE.into(),
        action: format!("Let {} run this cloud routine", proposal.title),
        mode: "full-access".into(),
        risk_level: "critical".into(),
        data_used: vec![
            format!("computer scope: workspace {} / teammate {}", proposal.workspace_id, proposal.agent_id),
            format!("routine: {}", proposal.routine_id),
            format!("instruction: {}", proposal.instruction),
            format!("first run: {}", proposal.first_run_at),
            format!("interval: {} seconds", proposal.interval_seconds),
            format!("standing capabilities: {}", proposal.capabilities.join(", ")),
            format!("tool-step limit per run: {}", proposal.max_steps),
            format!("exact request fingerprint: {fingerprint}"),
        ],
        consequence: "Stores this natural-language instruction and lets the teammate reason and use only the displayed standing capabilities on its isolated /workspace, including while every Fable client is closed. Workspace writes replace files and approved programs may change workspace contents. The routine cannot access Fable's local provider credentials.".into(),
        requested_at,
        decisions: vec!["once".into(), "deny".into()],
        confirmation_phrase: Some(HOSTED_AGENT_ROUTINE_CONFIRMATION.into()),
    }
}

fn approval_for_agent_routine_cancel(
    proposal: &HostedAgentRoutineCancelProposal,
    fingerprint: &str,
    id: String,
    requested_at: String,
) -> ApprovalRequest {
    ApprovalRequest {
        id,
        service: HOSTED_COMPUTER_SERVICE.into(),
        action: format!("Cancel cloud routine {}", proposal.routine_id),
        mode: "full-access".into(),
        risk_level: "critical".into(),
        data_used: vec![
            format!("computer scope: workspace {} / teammate {}", proposal.workspace_id, proposal.agent_id),
            format!("routine: {}", proposal.routine_id),
            format!("exact request fingerprint: {fingerprint}"),
        ],
        consequence: "Stops future background turns for the displayed routine. Work already started may finish.".into(),
        requested_at,
        decisions: vec!["once".into(), "deny".into()],
        confirmation_phrase: Some(HOSTED_AGENT_ROUTINE_CANCEL_CONFIRMATION.into()),
    }
}

fn approval_for_agent_routine_control(
    proposal: &HostedAgentRoutineControlProposal,
    fingerprint: &str,
    id: String,
    requested_at: String,
) -> ApprovalRequest {
    let verb = if proposal.action == "pause" { "Pause" } else { "Resume" };
    ApprovalRequest {
        id,
        service: HOSTED_COMPUTER_SERVICE.into(),
        action: format!("{verb} cloud routine {}", proposal.routine_id),
        mode: "full-access".into(),
        risk_level: "critical".into(),
        data_used: vec![
            format!("computer scope: workspace {} / teammate {}", proposal.workspace_id, proposal.agent_id),
            format!("routine: {}", proposal.routine_id),
            format!("action: {}", proposal.action),
            format!("exact request fingerprint: {fingerprint}"),
        ],
        consequence: if proposal.action == "pause" {
            "Stops future background turns until the routine is resumed. A turn already running may finish.".into()
        } else {
            "Restarts natural-language background turns on the routine's original cadence, including while Fable is closed.".into()
        },
        requested_at,
        decisions: vec!["once".into(), "deny".into()],
        confirmation_phrase: Some(HOSTED_AGENT_ROUTINE_CONTROL_CONFIRMATION.into()),
    }
}

fn approval_for_browser(
    proposal: &HostedBrowserNavigateProposal,
    fingerprint: &str,
    id: String,
    requested_at: String,
) -> ApprovalRequest {
    ApprovalRequest {
        id,
        service: HOSTED_COMPUTER_SERVICE.into(),
        action: "Open this page in the teammate's cloud browser".into(),
        mode: "full-access".into(),
        risk_level: "critical".into(),
        data_used: vec![
            format!(
                "computer scope: workspace {} / teammate {}",
                proposal.workspace_id, proposal.agent_id
            ),
            format!("page: {}", proposal.url),
            format!("exact request fingerprint: {fingerprint}"),
        ],
        consequence: "Loads the displayed public page from this teammate's isolated cloud browser and creates a short-lived interactive takeover link. A page can observe the browser's network address and may change browser state while the session remains active.".into(),
        requested_at,
        decisions: vec!["once".into(), "deny".into()],
        confirmation_phrase: Some(HOSTED_BROWSER_CONFIRMATION.into()),
    }
}

fn approval_for_browser_action(
    proposal: &HostedBrowserActionProposal,
    fingerprint: &str,
    id: String,
    requested_at: String,
) -> ApprovalRequest {
    let operation = match proposal.action.as_str() {
        "click" => format!("Click control {}", proposal.element_ref),
        "fill" => format!("Fill control {}", proposal.element_ref),
        "select" => format!("Select an option in control {}", proposal.element_ref),
        "scroll" => format!(
            "Scroll the page {}",
            proposal
                .value
                .as_deref()
                .unwrap_or("by the requested amount")
        ),
        "history" => format!(
            "Move {} in the page history",
            proposal
                .value
                .as_deref()
                .unwrap_or("within the approved history")
        ),
        "download" => format!("Download from control {}", proposal.element_ref),
        "press" => format!(
            "Press {} on control {}",
            proposal.key.as_deref().unwrap_or("key"),
            proposal.element_ref
        ),
        _ => "Use a cloud browser control".into(),
    };
    let mut data_used = vec![
        format!(
            "computer scope: workspace {} / teammate {}",
            proposal.workspace_id, proposal.agent_id
        ),
        format!("observation: {}", proposal.observation_id),
        format!("control: {}", proposal.element_ref),
        format!("control role: {}", proposal.control_role),
        format!("control name: {}", proposal.control_name),
        format!("action: {}", proposal.action),
        format!("exact request fingerprint: {fingerprint}"),
    ];
    if let Some(value) = proposal.value.as_deref() {
        data_used.push(format!("value: {value}"));
    }
    if let Some(key) = proposal.key.as_deref() {
        data_used.push(format!("key: {key}"));
    }
    ApprovalRequest {
        id,
        service: HOSTED_COMPUTER_SERVICE.into(),
        action: operation,
        mode: "full-access".into(),
        risk_level: "critical".into(),
        data_used,
        consequence: "Performs the exact displayed interaction on one visible control from the latest cloud-browser observation. The page may submit data, change an external account, navigate, or trigger another consequential action.".into(),
        requested_at,
        decisions: vec!["once".into(), "deny".into()],
        confirmation_phrase: Some(HOSTED_BROWSER_ACTION_CONFIRMATION.into()),
    }
}

fn validate_capability(
    receipt: HostedExecutionCapabilityReceipt,
) -> Result<(HostedExecutionCapabilityReceipt, Url), String> {
    let now = Utc::now().timestamp_millis();
    if !valid_id(&receipt.computer_id)
        || receipt.generation < 1
        || receipt.expires_at <= now
        || receipt.expires_at > now + 5 * 60_000
        || !(16..=4096).contains(&receipt.token.len())
        || receipt.token.chars().any(char::is_whitespace)
        || !receipt.token.starts_with("v1.")
    {
        return Err("The hosted execution capability failed validation.".into());
    }
    let url = Url::parse(&receipt.runner_url)
        .map_err(|_| "The hosted runner URL failed validation.".to_string())?;
    if url.scheme() != "https"
        || url.host_str().is_none_or(|host| !host.contains('.'))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("The hosted runner URL failed validation.".into());
    }
    Ok((receipt, url))
}

async fn request_execution_capability(
    workspace_id: &str,
    agent_id: &str,
    device_id: &str,
    scope: &str,
) -> Result<(HostedExecutionCapabilityReceipt, Url), String> {
    let value = call_convex(
        ConvexFunctionType::Action,
        "hostedExecution:requestExecutionCapability",
        json!({
            "workspaceId": workspace_id,
            "agentId": agent_id,
            "deviceId": device_id,
            "scope": scope
        }),
    )
    .await?;
    let receipt: HostedExecutionCapabilityReceipt = serde_json::from_value(value)
        .map_err(|_| "The hosted execution capability failed validation.".to_string())?;
    validate_capability(receipt)
}

fn runner_url(base: &Url, computer_id: &str, suffix: &[&str]) -> Result<Url, String> {
    let mut url = base.clone();
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| "The hosted runner URL failed validation.".to_string())?;
        segments.clear().extend(["v1", "computers", computer_id]);
        segments.extend(suffix.iter().copied());
    }
    Ok(url)
}

async fn runner_json(
    method: Method,
    url: Url,
    token: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    crate::ensure_rustls_provider();
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(45))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Fable could not initialize the hosted runner connection.".to_string())?;
    let mut request = client
        .request(method, url)
        .header(header::AUTHORIZATION, format!("FableCapability {token}"))
        .header(header::ACCEPT, "application/json");
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "The hosted runner is unavailable.".to_string())?;
    let status = response.status();
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RUNNER_RESPONSE_BYTES as u64)
    {
        return Err("The hosted runner response was too large.".into());
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "The hosted runner response was interrupted.".to_string())?;
        if bytes.len() + chunk.len() > MAX_RUNNER_RESPONSE_BYTES {
            return Err("The hosted runner response was too large.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "The hosted runner returned an invalid response.".to_string())?;
    if !status.is_success() {
        let code = value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("request-rejected");
        return Err(format!("The hosted runner rejected the request ({code})."));
    }
    Ok(value)
}

fn validate_process_snapshot(
    snapshot: &HostedProcessSnapshot,
    expected_request_key: Option<&str>,
    expected_run_id: Option<&str>,
    expected_process_id: Option<&str>,
) -> Result<(), String> {
    if !valid_id(&snapshot.request_key)
        || !valid_id(&snapshot.run_id)
        || !matches!(
            snapshot.lifecycle.as_str(),
            "launching" | "running" | "cancelling" | "completed" | "failed" | "stale"
        )
        || snapshot
            .process_id
            .as_deref()
            .is_some_and(|id| !validate_process_id(id))
        || snapshot
            .error_code
            .as_deref()
            .is_some_and(|code| !valid_id(code))
        || expected_request_key.is_some_and(|value| snapshot.request_key != value)
        || expected_run_id.is_some_and(|value| snapshot.run_id != value)
        || expected_process_id.is_some_and(|value| snapshot.process_id.as_deref() != Some(value))
        || snapshot
            .started_at
            .as_deref()
            .is_some_and(|value| chrono::DateTime::parse_from_rfc3339(value).is_err())
        || snapshot
            .ended_at
            .as_deref()
            .is_some_and(|value| chrono::DateTime::parse_from_rfc3339(value).is_err())
    {
        return Err("The hosted process response failed validation.".into());
    }
    Ok(())
}

fn validate_schedule_snapshot(
    snapshot: &HostedProcessScheduleSnapshot,
    expected_schedule_id: &str,
    expected_request_key: Option<&str>,
) -> Result<(), String> {
    let valid_time = |value: &str| chrono::DateTime::parse_from_rfc3339(value).is_ok();
    if snapshot.schedule_id != expected_schedule_id
        || !valid_schedule_id(&snapshot.schedule_id)
        || !valid_id(&snapshot.request_key)
        || !valid_id(&snapshot.run_id)
        || !matches!(
            snapshot.lifecycle.as_str(),
            "active" | "paused" | "cancelled" | "stale"
        )
        || !valid_time(&snapshot.first_run_at)
        || !(5 * 60..=7 * 24 * 60 * 60).contains(&snapshot.interval_seconds)
        || snapshot
            .next_run_at
            .as_deref()
            .is_some_and(|value| !valid_time(value))
        || snapshot
            .last_run_at
            .as_deref()
            .is_some_and(|value| !valid_time(value))
        || snapshot
            .last_process_id
            .as_deref()
            .is_some_and(|value| !validate_process_id(value))
        || snapshot
            .last_error_code
            .as_deref()
            .is_some_and(|value| !valid_id(value))
        || snapshot.generation < 1
        || !valid_time(&snapshot.updated_at)
        || expected_request_key.is_some_and(|value| snapshot.request_key != value)
    {
        return Err("The hosted process schedule response failed validation.".into());
    }
    Ok(())
}

fn validate_schedule_run_snapshot(
    snapshot: &HostedProcessScheduleRunSnapshot,
) -> Result<(), String> {
    let valid_time = |value: &str| chrono::DateTime::parse_from_rfc3339(value).is_ok();
    if !valid_id(&snapshot.occurrence_id)
        || !snapshot.occurrence_id.starts_with("occurrence-")
        || !valid_schedule_id(&snapshot.schedule_id)
        || !valid_time(&snapshot.scheduled_at)
        || !valid_id(&snapshot.request_key)
        || !valid_id(&snapshot.run_id)
        || !matches!(
            snapshot.lifecycle.as_str(),
            "launching" | "running" | "cancelling" | "completed" | "failed" | "stale"
        )
        || snapshot
            .process_id
            .as_deref()
            .is_some_and(|value| !validate_process_id(value))
        || snapshot
            .started_at
            .as_deref()
            .is_some_and(|value| !valid_time(value))
        || snapshot
            .ended_at
            .as_deref()
            .is_some_and(|value| !valid_time(value))
        || snapshot
            .error_code
            .as_deref()
            .is_some_and(|value| !valid_id(value))
        || snapshot.generation < 1
        || !valid_time(&snapshot.updated_at)
    {
        return Err("The hosted schedule run history failed validation.".into());
    }
    Ok(())
}

fn validate_agent_routine_snapshot(
    snapshot: &HostedAgentRoutineSnapshot,
    expected_routine_id: Option<&str>,
    expected_request_key: Option<&str>,
) -> Result<(), String> {
    let valid_time = |value: &str| chrono::DateTime::parse_from_rfc3339(value).is_ok();
    let valid_capabilities = validate_agent_capabilities(&snapshot.capabilities);
    if !valid_routine_id(&snapshot.routine_id)
        || expected_routine_id.is_some_and(|value| snapshot.routine_id != value)
        || expected_request_key.is_some_and(|value| snapshot.request_key != value)
        || !valid_id(&snapshot.request_key)
        || !valid_id(&snapshot.run_id)
        || snapshot.title.is_empty()
        || snapshot.title.chars().count() > 120
        || snapshot.title.chars().any(char::is_control)
        || snapshot.instruction.is_empty()
        || snapshot.instruction.chars().count() > 12_000
        || snapshot.instruction.chars().any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
        || !matches!(snapshot.lifecycle.as_str(), "active" | "paused" | "cancelled" | "stale")
        || !valid_time(&snapshot.first_run_at)
        || !(5 * 60..=7 * 24 * 60 * 60).contains(&snapshot.interval_seconds)
        || !valid_capabilities
        || !(1..=8).contains(&snapshot.max_steps)
        || snapshot.next_run_at.as_deref().is_some_and(|value| !valid_time(value))
        || snapshot.last_run_at.as_deref().is_some_and(|value| !valid_time(value))
        || snapshot.last_run_id.as_deref().is_some_and(|value| !valid_id(value))
        || snapshot.last_run_lifecycle.as_deref().is_some_and(|value| !matches!(value, "running" | "completed" | "failed" | "stale"))
        || snapshot.last_result.as_deref().is_some_and(|value| value.chars().count() > 12_000 || value.chars().any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t')))
        || snapshot.last_error_code.as_deref().is_some_and(|value| !valid_id(value))
        || snapshot.generation < 1
        || !valid_time(&snapshot.updated_at)
    {
        return Err("The hosted agent routine response failed validation.".into());
    }
    Ok(())
}

fn validate_agent_routine_run_snapshot(snapshot: &HostedAgentRoutineRunSnapshot) -> Result<(), String> {
    let valid_time = |value: &str| chrono::DateTime::parse_from_rfc3339(value).is_ok();
    if !valid_id(&snapshot.occurrence_id)
        || !snapshot.occurrence_id.starts_with("occurrence-")
        || !valid_routine_id(&snapshot.routine_id)
        || !valid_id(&snapshot.run_id)
        || !valid_time(&snapshot.scheduled_at)
        || !matches!(snapshot.lifecycle.as_str(), "running" | "completed" | "failed" | "stale")
        || snapshot.result.as_deref().is_some_and(|value| value.chars().count() > 12_000 || value.chars().any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t')))
        || snapshot.error_code.as_deref().is_some_and(|value| !valid_id(value))
        || snapshot.tools.len() > 8
        || snapshot.tools.iter().any(|tool| {
            !matches!(tool.tool.as_str(), "workspace-list" | "workspace-read" | "workspace-write" | "process-run")
                || !matches!(tool.status.as_str(), "completed" | "failed")
                || tool.summary.is_empty()
                || tool.summary.chars().count() > 240
                || tool.summary.chars().any(char::is_control)
        })
        || !valid_time(&snapshot.started_at)
        || snapshot.ended_at.as_deref().is_some_and(|value| !valid_time(value))
        || snapshot.generation < 1
        || !valid_time(&snapshot.updated_at)
    {
        return Err("The hosted agent routine history failed validation.".into());
    }
    Ok(())
}

fn validate_agent_capabilities(capabilities: &[String]) -> bool {
    let allowed = ["workspace-read", "workspace-write", "process-run"];
    !capabilities.is_empty()
        && capabilities.len() <= allowed.len()
        && capabilities.iter().any(|value| value == "workspace-read")
        && capabilities.iter().all(|value| allowed.contains(&value.as_str()))
        && capabilities.windows(2).all(|pair| {
            let left = allowed.iter().position(|value| *value == pair[0]).unwrap_or(usize::MAX);
            let right = allowed.iter().position(|value| *value == pair[1]).unwrap_or(usize::MAX);
            left < right
        })
}

fn normalize_browser_target(target: HostedBrowserTarget) -> Result<HostedBrowserTarget, String> {
    if !valid_id(&target.workspace_id)
        || !valid_id(&target.agent_id)
        || !valid_id(&target.device_id)
    {
        return Err("The cloud browser scope is invalid.".into());
    }
    Ok(target)
}

fn validate_browser_snapshot(
    snapshot: &HostedBrowserSnapshot,
    expect_live_view: bool,
) -> Result<(), String> {
    if normalize_public_https_url(&snapshot.current_url)? != snapshot.current_url
        || snapshot.title.chars().count() > 240
        || snapshot.title.chars().any(char::is_control)
        || !valid_id(&snapshot.observation_id)
        || !snapshot.observation_id.starts_with("observation-")
        || snapshot.controls.len() > 40
        || snapshot.viewport.width == 0
        || snapshot.viewport.width > 4_096
        || snapshot.viewport.height == 0
        || snapshot.viewport.height > 4_096
        || snapshot.viewport.document_width < snapshot.viewport.width
        || snapshot.viewport.document_width > 10_000_000
        || snapshot.viewport.document_height < snapshot.viewport.height
        || snapshot.viewport.document_height > 10_000_000
        || snapshot.viewport.scroll_x > snapshot.viewport.document_width
        || snapshot.viewport.scroll_y > snapshot.viewport.document_height
        || snapshot.viewport.can_scroll_up != (snapshot.viewport.scroll_y > 0)
        || snapshot.viewport.can_scroll_down
            != (snapshot.viewport.scroll_y + snapshot.viewport.height + 1
                < snapshot.viewport.document_height)
        || snapshot.last_download.as_ref().is_some_and(|download| {
            download.file_name.is_empty()
                || download.file_name.chars().count() > 120
                || download.file_name.chars().any(char::is_control)
                || download.file_name.contains('/')
                || download.file_name.contains('\\')
                || !download.workspace_path.starts_with("/workspace/downloads/")
                || download.workspace_path.chars().count() > 260
                || download.workspace_path.chars().any(char::is_control)
                || download.bytes_written > 25 * 1_024 * 1_024
        })
        || chrono::DateTime::parse_from_rfc3339(&snapshot.updated_at).is_err()
    {
        return Err("The cloud browser response failed validation.".into());
    }
    let mut refs = std::collections::BTreeSet::new();
    if snapshot.controls.iter().any(|control| {
        !valid_id(&control.r#ref)
            || !control.r#ref.starts_with("control-")
            || !refs.insert(control.r#ref.as_str())
            || control.role.is_empty()
            || control.role.chars().count() > 40
            || control.role.chars().any(char::is_control)
            || control.name.is_empty()
            || control.name.chars().count() > 160
            || control.name.chars().any(char::is_control)
            || control.options.as_ref().is_some_and(|options| {
                options.len() > 20
                    || options.iter().any(|option| {
                        option.is_empty()
                            || option.chars().count() > 160
                            || option.chars().any(char::is_control)
                    })
            })
    }) {
        return Err("The cloud browser controls failed validation.".into());
    }
    let encoded = snapshot
        .preview_data_url
        .strip_prefix("data:image/jpeg;base64,")
        .ok_or_else(|| "The cloud browser preview failed validation.".to_string())?;
    let preview = STANDARD
        .decode(encoded)
        .map_err(|_| "The cloud browser preview failed validation.".to_string())?;
    if preview.is_empty() || preview.len() > 300 * 1_024 {
        return Err("The cloud browser preview failed validation.".into());
    }
    match snapshot.live_view_url.as_deref() {
        Some(value) => {
            let url = Url::parse(value)
                .map_err(|_| "The cloud browser Live View link failed validation.".to_string())?;
            if url.scheme() != "https"
                || url.host_str() != Some("live.browser.run")
                || !url.username().is_empty()
                || url.password().is_some()
                || !url.path().starts_with("/ui/")
                || !url
                    .query_pairs()
                    .any(|(key, value)| key == "wss" && !value.is_empty())
            {
                return Err("The cloud browser Live View link failed validation.".into());
            }
        }
        None if expect_live_view => {
            return Err("The cloud browser did not return a Live View link.".into());
        }
        None => {}
    }
    Ok(())
}

async fn fetch_process_snapshot(
    method: Method,
    target: &HostedProcessTarget,
    suffix: &[&str],
) -> Result<HostedProcessSnapshot, String> {
    if !valid_id(&target.workspace_id)
        || !valid_id(&target.agent_id)
        || !valid_id(&target.device_id)
        || !validate_process_id(&target.process_id)
    {
        return Err("The hosted process target is invalid.".into());
    }
    let account_generation = clerk_identity::native_identity_generation_snapshot()?;
    let scope = if suffix == ["kill"] {
        "process:kill"
    } else {
        "process:inspect"
    };
    let (capability, base) = request_execution_capability(
        &target.workspace_id,
        &target.agent_id,
        &target.device_id,
        scope,
    )
    .await?;
    let mut path = vec!["processes", target.process_id.as_str()];
    path.extend_from_slice(suffix);
    let value = runner_json(
        method,
        runner_url(&base, &capability.computer_id, &path)?,
        &capability.token,
        None,
    )
    .await?;
    if clerk_identity::native_identity_generation_snapshot()? != account_generation {
        return Err(ACCOUNT_CHANGED_ERROR.into());
    }
    let _identity_guard = clerk_identity::lock_native_identity_generation(&account_generation)?;
    let snapshot: HostedProcessSnapshot = serde_json::from_value(value)
        .map_err(|_| "The hosted process response failed validation.".to_string())?;
    validate_process_snapshot(&snapshot, None, None, Some(&target.process_id))?;
    Ok(snapshot)
}

fn validate_node(
    node: &HostedExecutionNodeSnapshot,
    workspace_id: &str,
    agent_id: &str,
) -> Result<(), String> {
    if node.workspace_id != workspace_id
        || node.agent_id != agent_id
        || node.locality != "hosted"
        || !matches!(
            node.status.as_str(),
            "provisioning" | "ready" | "degraded" | "destroyed"
        )
        || node.runner_generation < 0
        || node.revision < 1
        || node.updated_at < 0
        || !valid_id(&node.execution_node_id)
    {
        return Err("The hosted computer response failed validation.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn hosted_computer_status(
    workspace_id: String,
    agent_id: String,
) -> Result<Option<HostedExecutionNodeSnapshot>, String> {
    if !valid_id(&workspace_id) || !valid_id(&agent_id) {
        return Err("The hosted computer scope is invalid.".into());
    }
    let value = call_convex(
        ConvexFunctionType::Query,
        "hostedExecution:getComputer",
        json!({ "workspaceId": workspace_id, "agentId": agent_id }),
    )
    .await?;
    if value.is_null() {
        return Ok(None);
    }
    let node: HostedExecutionNodeSnapshot = serde_json::from_value(value)
        .map_err(|_| "The hosted computer response failed validation.".to_string())?;
    validate_node(&node, &workspace_id, &agent_id)?;
    Ok(Some(node))
}

#[tauri::command]
pub async fn hosted_computer_provision(
    workspace_id: String,
    agent_id: String,
    device_id: String,
) -> Result<HostedComputerProvisionReceipt, String> {
    if !valid_id(&workspace_id) || !valid_id(&agent_id) || !valid_id(&device_id) {
        return Err("The hosted computer scope is invalid.".into());
    }
    let request_key = opaque_key("provision")?;
    let value = call_convex(
        ConvexFunctionType::Mutation,
        "hostedExecution:requestProvision",
        json!({
            "workspaceId": workspace_id,
            "agentId": agent_id,
            "deviceId": device_id,
            "requestKey": request_key
        }),
    )
    .await?;
    let receipt: HostedComputerProvisionReceipt = serde_json::from_value(value)
        .map_err(|_| "The hosted computer provision response failed validation.".to_string())?;
    if receipt.request_key != request_key
        || !valid_id(&receipt.execution_node_id)
        || !valid_id(&receipt.computer_id)
        || !matches!(receipt.status.as_str(), "pending" | "completed" | "failed")
    {
        return Err("The hosted computer provision response failed validation.".into());
    }
    Ok(receipt)
}

#[tauri::command]
pub fn hosted_process_prepare(
    draft: HostedProcessDraft,
) -> Result<PreparedHostedProcessLaunch, String> {
    let draft = normalize_draft(draft)?;
    let proposal = HostedProcessLaunchProposal {
        request_key: opaque_key("process")?,
        workspace_id: draft.workspace_id,
        agent_id: draft.agent_id,
        device_id: draft.device_id,
        run_id: draft.run_id,
        argv: draft.argv,
        cwd: draft.cwd,
        timeout_ms: draft.timeout_ms,
    };
    let fingerprint = proposal_fingerprint(&proposal)?;
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let approval = approval_for_process(
        &proposal,
        &fingerprint,
        opaque_key("approval-hosted-process")?,
        now,
    );
    Ok(PreparedHostedProcessLaunch {
        proposal,
        proposal_fingerprint: fingerprint,
        approval,
    })
}

#[tauri::command]
pub async fn hosted_process_launch(
    app: tauri::AppHandle,
    request: CommitHostedProcessLaunchRequest,
) -> Result<HostedProcessSnapshot, String> {
    let proposal = validate_proposal(request.proposal)?;
    if proposal.argv.len() != 3 || proposal.argv[0] != "sh" || proposal.argv[1] != "-lc" {
        return Err("The hosted process is not bound to an approved shell command.".into());
    }
    let fingerprint = proposal_fingerprint(&proposal)?;
    let expected = approval_for_process(
        &proposal,
        &fingerprint,
        request.resolution.request.id.clone(),
        request.resolution.request.requested_at.clone(),
    );
    if request.resolution.request != expected
        || request.resolution.decision != "once"
        || request.resolution.modification.is_some()
    {
        return Err("The hosted process changed after the approval preview.".into());
    }
    let source_resolution = crate::approvals::resolve_approval(request.source_resolution)?;
    if source_resolution.audit_entry.decision == "deny" {
        return Err("The source shell command was not approved.".into());
    }
    crate::tools::validate_tool_approval_binding(
        "run-shell",
        &json!({ "command": proposal.argv[2] }),
        &source_resolution.effective_request,
    )?;
    let resolution = crate::approvals::resolve_approval(request.resolution)?;
    if resolution.audit_entry.decision != "once" {
        return Err("Hosted process launches require a fresh one-time approval.".into());
    }
    crate::execution_approvals::verify_and_consume_execution_approval(
        &crate::paths::execution_approvals_path(&app)?,
        &source_resolution.effective_request,
        &source_resolution.audit_entry.decided_at,
    )?;
    crate::execution_approvals::verify_and_consume_execution_approval(
        &crate::paths::execution_approvals_path(&app)?,
        &resolution.effective_request,
        &resolution.audit_entry.decided_at,
    )?;

    let account_generation = clerk_identity::native_identity_generation_snapshot()?;
    let (capability, base) = request_execution_capability(
        &proposal.workspace_id,
        &proposal.agent_id,
        &proposal.device_id,
        "process:launch",
    )
    .await?;
    let url = runner_url(&base, &capability.computer_id, &["processes"])?;
    let value = runner_json(
        Method::POST,
        url,
        &capability.token,
        Some(json!({
            "requestKey": proposal.request_key,
            "runId": proposal.run_id,
            "argv": proposal.argv,
            "cwd": proposal.cwd,
            "timeoutMs": proposal.timeout_ms
        })),
    )
    .await?;
    let snapshot: HostedProcessSnapshot = serde_json::from_value(value)
        .map_err(|_| "The hosted process response failed validation.".to_string())?;
    validate_process_snapshot(
        &snapshot,
        Some(&proposal.request_key),
        Some(&proposal.run_id),
        None,
    )?;

    if clerk_identity::native_identity_generation_snapshot()? != account_generation {
        if let Some(process_id) = snapshot.process_id.as_deref() {
            if let Ok(url) = runner_url(
                &base,
                &capability.computer_id,
                &["processes", process_id, "kill"],
            ) {
                let _ = runner_json(Method::POST, url, &capability.token, None).await;
            }
        }
        return Err(ACCOUNT_CHANGED_ERROR.into());
    }
    let _identity_guard = clerk_identity::lock_native_identity_generation(&account_generation)?;
    Ok(snapshot)
}

#[tauri::command]
pub fn hosted_process_schedule_prepare(
    draft: HostedProcessScheduleDraft,
) -> Result<PreparedHostedProcessSchedule, String> {
    let draft = normalize_schedule_draft(draft)?;
    let proposal = HostedProcessScheduleProposal {
        request_key: opaque_key("schedule-request")?,
        workspace_id: draft.workspace_id,
        agent_id: draft.agent_id,
        device_id: draft.device_id,
        schedule_id: draft.schedule_id,
        run_id: draft.run_id,
        argv: draft.argv,
        cwd: draft.cwd,
        timeout_ms: draft.timeout_ms,
        first_run_at: draft.first_run_at,
        interval_seconds: draft.interval_seconds,
    };
    let fingerprint = schedule_fingerprint(&proposal)?;
    let approval = approval_for_schedule(
        &proposal,
        &fingerprint,
        opaque_key("approval-hosted-schedule")?,
        Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    );
    Ok(PreparedHostedProcessSchedule {
        proposal,
        proposal_fingerprint: fingerprint,
        approval,
    })
}

#[tauri::command]
pub async fn hosted_process_schedule_create(
    app: tauri::AppHandle,
    request: CommitHostedProcessScheduleRequest,
) -> Result<HostedProcessScheduleSnapshot, String> {
    let proposal = validate_schedule_proposal(request.proposal)?;
    let fingerprint = schedule_fingerprint(&proposal)?;
    let expected = approval_for_schedule(
        &proposal,
        &fingerprint,
        request.resolution.request.id.clone(),
        request.resolution.request.requested_at.clone(),
    );
    if request.resolution.request != expected
        || request.resolution.decision != "once"
        || request.resolution.modification.is_some()
    {
        return Err("The hosted process schedule changed after the approval preview.".into());
    }
    let source_resolution = crate::approvals::resolve_approval(request.source_resolution)?;
    if source_resolution.audit_entry.decision == "deny" {
        return Err("The source cloud-process-schedule call was not approved.".into());
    }
    let mut source_arguments = json!({
        "scheduleId": proposal.schedule_id.clone(),
        "runId": proposal.run_id.clone(),
        "argv": proposal.argv.clone(),
        "firstRunAt": proposal.first_run_at.clone(),
        "intervalSeconds": proposal.interval_seconds
    });
    if let Some(cwd) = proposal.cwd.clone() {
        source_arguments["cwd"] = Value::String(cwd);
    }
    if let Some(timeout_ms) = proposal.timeout_ms {
        source_arguments["timeoutMs"] = json!(timeout_ms);
    }
    crate::tools::validate_tool_approval_binding(
        "cloud-process-schedule",
        &source_arguments,
        &source_resolution.effective_request,
    )?;
    let resolution = crate::approvals::resolve_approval(request.resolution)?;
    if resolution.audit_entry.decision != "once" {
        return Err("Hosted process schedules require a fresh one-time approval.".into());
    }
    crate::execution_approvals::verify_and_consume_execution_approval(
        &crate::paths::execution_approvals_path(&app)?,
        &source_resolution.effective_request,
        &source_resolution.audit_entry.decided_at,
    )?;
    crate::execution_approvals::verify_and_consume_execution_approval(
        &crate::paths::execution_approvals_path(&app)?,
        &resolution.effective_request,
        &resolution.audit_entry.decided_at,
    )?;

    let account_generation = clerk_identity::native_identity_generation_snapshot()?;
    let (capability, base) = request_execution_capability(
        &proposal.workspace_id,
        &proposal.agent_id,
        &proposal.device_id,
        "schedule:manage",
    )
    .await?;
    let expected_schedule_id = proposal.schedule_id.clone();
    let expected_request_key = proposal.request_key.clone();
    let url = runner_url(
        &base,
        &capability.computer_id,
        &["schedules", proposal.schedule_id.as_str()],
    )?;
    let mut runner_body = json!({
        "requestKey": proposal.request_key,
        "scheduleId": proposal.schedule_id,
        "runId": proposal.run_id,
        "argv": proposal.argv,
        "firstRunAt": proposal.first_run_at,
        "intervalSeconds": proposal.interval_seconds
    });
    if let Some(cwd) = proposal.cwd {
        runner_body["cwd"] = Value::String(cwd);
    }
    if let Some(timeout_ms) = proposal.timeout_ms {
        runner_body["timeoutMs"] = json!(timeout_ms);
    }
    let value = runner_json(Method::POST, url, &capability.token, Some(runner_body)).await?;
    let snapshot: HostedProcessScheduleSnapshot = serde_json::from_value(value)
        .map_err(|_| "The hosted process schedule response failed validation.".to_string())?;
    validate_schedule_snapshot(
        &snapshot,
        &expected_schedule_id,
        Some(&expected_request_key),
    )?;
    if clerk_identity::native_identity_generation_snapshot()? != account_generation {
        if let Ok(url) = runner_url(
            &base,
            &capability.computer_id,
            &["schedules", snapshot.schedule_id.as_str()],
        ) {
            let _ = runner_json(Method::DELETE, url, &capability.token, None).await;
        }
        return Err(ACCOUNT_CHANGED_ERROR.into());
    }
    let _identity_guard = clerk_identity::lock_native_identity_generation(&account_generation)?;
    Ok(snapshot)
}

#[tauri::command]
pub async fn hosted_process_schedule_status(
    target: HostedProcessScheduleTarget,
) -> Result<HostedProcessScheduleSnapshot, String> {
    if !valid_id(&target.workspace_id)
        || !valid_id(&target.agent_id)
        || !valid_id(&target.device_id)
        || !valid_schedule_id(&target.schedule_id)
    {
        return Err("The hosted process schedule target is invalid.".into());
    }
    let account_generation = clerk_identity::native_identity_generation_snapshot()?;
    let (capability, base) = request_execution_capability(
        &target.workspace_id,
        &target.agent_id,
        &target.device_id,
        "schedule:manage",
    )
    .await?;
    let value = runner_json(
        Method::GET,
        runner_url(
            &base,
            &capability.computer_id,
            &["schedules", target.schedule_id.as_str()],
        )?,
        &capability.token,
        None,
    )
    .await?;
    if clerk_identity::native_identity_generation_snapshot()? != account_generation {
        return Err(ACCOUNT_CHANGED_ERROR.into());
    }
    let _identity_guard = clerk_identity::lock_native_identity_generation(&account_generation)?;
    let snapshot: HostedProcessScheduleSnapshot = serde_json::from_value(value)
        .map_err(|_| "The hosted process schedule response failed validation.".to_string())?;
    validate_schedule_snapshot(&snapshot, &target.schedule_id, None)?;
    Ok(snapshot)
}

#[tauri::command]
pub async fn hosted_process_schedule_list(
    target: HostedProcessScheduleListTarget,
) -> Result<Vec<HostedProcessScheduleSnapshot>, String> {
    if !valid_id(&target.workspace_id)
        || !valid_id(&target.agent_id)
        || !valid_id(&target.device_id)
    {
        return Err("The hosted process schedule scope is invalid.".into());
    }
    let account_generation = clerk_identity::native_identity_generation_snapshot()?;
    let (capability, base) = request_execution_capability(
        &target.workspace_id,
        &target.agent_id,
        &target.device_id,
        "schedule:manage",
    )
    .await?;
    let value = runner_json(
        Method::GET,
        runner_url(&base, &capability.computer_id, &["schedules"])?,
        &capability.token,
        None,
    )
    .await?;
    if clerk_identity::native_identity_generation_snapshot()? != account_generation {
        return Err(ACCOUNT_CHANGED_ERROR.into());
    }
    let _identity_guard = clerk_identity::lock_native_identity_generation(&account_generation)?;
    let snapshots: Vec<HostedProcessScheduleSnapshot> = serde_json::from_value(value)
        .map_err(|_| "The hosted process schedule list failed validation.".to_string())?;
    if snapshots.len() > 100 {
        return Err("The hosted process schedule list failed validation.".into());
    }
    let mut ids = std::collections::BTreeSet::new();
    for snapshot in &snapshots {
        validate_schedule_snapshot(snapshot, &snapshot.schedule_id, None)?;
        if !ids.insert(snapshot.schedule_id.as_str()) {
            return Err("The hosted process schedule list failed validation.".into());
        }
    }
    Ok(snapshots)
}

#[tauri::command]
pub async fn hosted_process_schedule_run_list(
    target: HostedProcessScheduleListTarget,
) -> Result<Vec<HostedProcessScheduleRunSnapshot>, String> {
    if !valid_id(&target.workspace_id)
        || !valid_id(&target.agent_id)
        || !valid_id(&target.device_id)
    {
        return Err("The hosted process schedule scope is invalid.".into());
    }
    let account_generation = clerk_identity::native_identity_generation_snapshot()?;
    let (capability, base) = request_execution_capability(
        &target.workspace_id,
        &target.agent_id,
        &target.device_id,
        "schedule:manage",
    )
    .await?;
    let value = runner_json(
        Method::GET,
        runner_url(&base, &capability.computer_id, &["schedule-runs"])?,
        &capability.token,
        None,
    )
    .await?;
    if clerk_identity::native_identity_generation_snapshot()? != account_generation {
        return Err(ACCOUNT_CHANGED_ERROR.into());
    }
    let _identity_guard = clerk_identity::lock_native_identity_generation(&account_generation)?;
    let snapshots: Vec<HostedProcessScheduleRunSnapshot> = serde_json::from_value(value)
        .map_err(|_| "The hosted schedule run history failed validation.".to_string())?;
    if snapshots.len() > 100 {
        return Err("The hosted schedule run history failed validation.".into());
    }
    let mut ids = std::collections::BTreeSet::new();
    for snapshot in &snapshots {
        validate_schedule_run_snapshot(snapshot)?;
        if !ids.insert((
            snapshot.schedule_id.as_str(),
            snapshot.occurrence_id.as_str(),
        )) {
            return Err("The hosted schedule run history failed validation.".into());
        }
    }
    Ok(snapshots)
}

#[tauri::command]
pub fn hosted_process_schedule_cancel_prepare(
    target: HostedProcessScheduleTarget,
) -> Result<PreparedHostedProcessScheduleCancel, String> {
    if !valid_id(&target.workspace_id)
        || !valid_id(&target.agent_id)
        || !valid_id(&target.device_id)
        || !valid_schedule_id(&target.schedule_id)
    {
        return Err("The hosted process schedule target is invalid.".into());
    }
    let proposal = HostedProcessScheduleCancelProposal {
        request_key: opaque_key("schedule-cancel")?,
        workspace_id: target.workspace_id,
        agent_id: target.agent_id,
        device_id: target.device_id,
        schedule_id: target.schedule_id,
    };
    let fingerprint = schedule_cancel_fingerprint(&proposal)?;
    let approval = approval_for_schedule_cancel(
        &proposal,
        &fingerprint,
        opaque_key("approval-hosted-schedule-cancel")?,
        Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    );
    Ok(PreparedHostedProcessScheduleCancel {
        proposal,
        proposal_fingerprint: fingerprint,
        approval,
    })
}

#[tauri::command]
pub async fn hosted_process_schedule_cancel(
    app: tauri::AppHandle,
    request: CommitHostedProcessScheduleCancelRequest,
) -> Result<HostedProcessScheduleSnapshot, String> {
    let proposal = normalize_schedule_cancel_proposal(request.proposal)?;
    let fingerprint = schedule_cancel_fingerprint(&proposal)?;
    let expected = approval_for_schedule_cancel(
        &proposal,
        &fingerprint,
        request.resolution.request.id.clone(),
        request.resolution.request.requested_at.clone(),
    );
    if request.resolution.request != expected
        || request.resolution.decision != "once"
        || request.resolution.modification.is_some()
    {
        return Err("The hosted schedule cancellation changed after the approval preview.".into());
    }
    let source_resolution = crate::approvals::resolve_approval(request.source_resolution)?;
    if source_resolution.audit_entry.decision == "deny" {
        return Err("The source cloud-process-schedule-cancel call was not approved.".into());
    }
    crate::tools::validate_tool_approval_binding(
        "cloud-process-schedule-cancel",
        &json!({ "scheduleId": proposal.schedule_id.clone() }),
        &source_resolution.effective_request,
    )?;
    let resolution = crate::approvals::resolve_approval(request.resolution)?;
    if resolution.audit_entry.decision != "once" {
        return Err("Hosted schedule cancellation requires a fresh one-time approval.".into());
    }
    crate::execution_approvals::verify_and_consume_execution_approval(
        &crate::paths::execution_approvals_path(&app)?,
        &source_resolution.effective_request,
        &source_resolution.audit_entry.decided_at,
    )?;
    crate::execution_approvals::verify_and_consume_execution_approval(
        &crate::paths::execution_approvals_path(&app)?,
        &resolution.effective_request,
        &resolution.audit_entry.decided_at,
    )?;
    let account_generation = clerk_identity::native_identity_generation_snapshot()?;
    let (capability, base) = request_execution_capability(
        &proposal.workspace_id,
        &proposal.agent_id,
        &proposal.device_id,
        "schedule:manage",
    )
    .await?;
    let value = runner_json(
        Method::DELETE,
        runner_url(
            &base,
            &capability.computer_id,
            &["schedules", proposal.schedule_id.as_str()],
        )?,
        &capability.token,
        None,
    )
    .await?;
    if clerk_identity::native_identity_generation_snapshot()? != account_generation {
        return Err(ACCOUNT_CHANGED_ERROR.into());
    }
    let _identity_guard = clerk_identity::lock_native_identity_generation(&account_generation)?;
    let snapshot: HostedProcessScheduleSnapshot = serde_json::from_value(value)
        .map_err(|_| "The hosted process schedule response failed validation.".to_string())?;
    validate_schedule_snapshot(&snapshot, &proposal.schedule_id, None)?;
    if snapshot.lifecycle != "cancelled" {
        return Err("The hosted process schedule was not cancelled.".into());
    }
    Ok(snapshot)
}

#[tauri::command]
pub fn hosted_process_schedule_control_prepare(
    draft: HostedProcessScheduleControlDraft,
) -> Result<PreparedHostedProcessScheduleControl, String> {
    let draft = normalize_schedule_control_draft(draft)?;
    let proposal = HostedProcessScheduleControlProposal {
        request_key: opaque_key("schedule-control")?,
        workspace_id: draft.workspace_id,
        agent_id: draft.agent_id,
        device_id: draft.device_id,
        schedule_id: draft.schedule_id,
        action: draft.action,
    };
    let fingerprint = schedule_control_fingerprint(&proposal)?;
    let approval = approval_for_schedule_control(
        &proposal,
        &fingerprint,
        opaque_key("approval-hosted-schedule-control")?,
        Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    );
    Ok(PreparedHostedProcessScheduleControl {
        proposal,
        proposal_fingerprint: fingerprint,
        approval,
    })
}

#[tauri::command]
pub async fn hosted_process_schedule_control(
    app: tauri::AppHandle,
    request: CommitHostedProcessScheduleControlRequest,
) -> Result<HostedProcessScheduleSnapshot, String> {
    let proposal = normalize_schedule_control_proposal(request.proposal)?;
    let fingerprint = schedule_control_fingerprint(&proposal)?;
    let expected = approval_for_schedule_control(
        &proposal,
        &fingerprint,
        request.resolution.request.id.clone(),
        request.resolution.request.requested_at.clone(),
    );
    if request.resolution.request != expected
        || request.resolution.decision != "once"
        || request.resolution.modification.is_some()
    {
        return Err("The hosted schedule change changed after the approval preview.".into());
    }
    let source_tool = format!("cloud-process-schedule-{}", proposal.action);
    let source_resolution = crate::approvals::resolve_approval(request.source_resolution)?;
    if source_resolution.audit_entry.decision == "deny" {
        return Err(format!("The source {source_tool} call was not approved."));
    }
    crate::tools::validate_tool_approval_binding(
        &source_tool,
        &json!({ "scheduleId": proposal.schedule_id.clone() }),
        &source_resolution.effective_request,
    )?;
    let resolution = crate::approvals::resolve_approval(request.resolution)?;
    if resolution.audit_entry.decision != "once" {
        return Err("Hosted schedule changes require a fresh one-time approval.".into());
    }
    crate::execution_approvals::verify_and_consume_execution_approval(
        &crate::paths::execution_approvals_path(&app)?,
        &source_resolution.effective_request,
        &source_resolution.audit_entry.decided_at,
    )?;
    crate::execution_approvals::verify_and_consume_execution_approval(
        &crate::paths::execution_approvals_path(&app)?,
        &resolution.effective_request,
        &resolution.audit_entry.decided_at,
    )?;
    let account_generation = clerk_identity::native_identity_generation_snapshot()?;
    let (capability, base) = request_execution_capability(
        &proposal.workspace_id,
        &proposal.agent_id,
        &proposal.device_id,
        "schedule:manage",
    )
    .await?;
    let value = runner_json(
        Method::POST,
        runner_url(
            &base,
            &capability.computer_id,
            &["schedules", proposal.schedule_id.as_str(), proposal.action.as_str()],
        )?,
        &capability.token,
        None,
    )
    .await?;
    if clerk_identity::native_identity_generation_snapshot()? != account_generation {
        return Err(ACCOUNT_CHANGED_ERROR.into());
    }
    let _identity_guard = clerk_identity::lock_native_identity_generation(&account_generation)?;
    let snapshot: HostedProcessScheduleSnapshot = serde_json::from_value(value)
        .map_err(|_| "The hosted process schedule response failed validation.".to_string())?;
    validate_schedule_snapshot(&snapshot, &proposal.schedule_id, None)?;
    let expected_lifecycle = if proposal.action == "pause" { "paused" } else { "active" };
    if snapshot.lifecycle != expected_lifecycle {
        return Err("The hosted process schedule did not reach the requested state.".into());
    }
    Ok(snapshot)
}

#[tauri::command]
pub fn hosted_agent_routine_prepare(
    draft: HostedAgentRoutineDraft,
) -> Result<PreparedHostedAgentRoutine, String> {
    let draft = normalize_agent_routine_draft(draft)?;
    let proposal = HostedAgentRoutineProposal {
        request_key: opaque_key("agent-routine-request")?,
        workspace_id: draft.workspace_id,
        agent_id: draft.agent_id,
        device_id: draft.device_id,
        routine_id: draft.routine_id,
        run_id: draft.run_id,
        title: draft.title,
        instruction: draft.instruction,
        first_run_at: draft.first_run_at,
        interval_seconds: draft.interval_seconds,
        capabilities: draft.capabilities,
        max_steps: draft.max_steps.unwrap_or(6),
    };
    let fingerprint = agent_routine_fingerprint(&proposal)?;
    let approval = approval_for_agent_routine(
        &proposal,
        &fingerprint,
        opaque_key("approval-hosted-agent-routine")?,
        Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    );
    Ok(PreparedHostedAgentRoutine { proposal, proposal_fingerprint: fingerprint, approval })
}

#[tauri::command]
pub async fn hosted_agent_routine_create(
    app: tauri::AppHandle,
    request: CommitHostedAgentRoutineRequest,
) -> Result<HostedAgentRoutineSnapshot, String> {
    let proposal = validate_agent_routine_proposal(request.proposal)?;
    let fingerprint = agent_routine_fingerprint(&proposal)?;
    let expected = approval_for_agent_routine(
        &proposal,
        &fingerprint,
        request.resolution.request.id.clone(),
        request.resolution.request.requested_at.clone(),
    );
    if request.resolution.request != expected
        || request.resolution.decision != "once"
        || request.resolution.modification.is_some()
    {
        return Err("The hosted agent routine changed after the approval preview.".into());
    }
    let source_resolution = crate::approvals::resolve_approval(request.source_resolution)?;
    if source_resolution.audit_entry.decision == "deny" {
        return Err("The source cloud-agent-routine call was not approved.".into());
    }
    crate::tools::validate_tool_approval_binding(
        "cloud-agent-routine",
        &json!({
            "routineId": proposal.routine_id.clone(),
            "runId": proposal.run_id.clone(),
            "title": proposal.title.clone(),
            "instruction": proposal.instruction.clone(),
            "firstRunAt": proposal.first_run_at.clone(),
            "intervalSeconds": proposal.interval_seconds,
            "capabilities": proposal.capabilities.clone(),
            "maxSteps": proposal.max_steps
        }),
        &source_resolution.effective_request,
    )?;
    let resolution = crate::approvals::resolve_approval(request.resolution)?;
    if resolution.audit_entry.decision != "once" {
        return Err("Hosted agent routines require a fresh one-time approval.".into());
    }
    crate::execution_approvals::verify_and_consume_execution_approval(
        &crate::paths::execution_approvals_path(&app)?,
        &source_resolution.effective_request,
        &source_resolution.audit_entry.decided_at,
    )?;
    crate::execution_approvals::verify_and_consume_execution_approval(
        &crate::paths::execution_approvals_path(&app)?,
        &resolution.effective_request,
        &resolution.audit_entry.decided_at,
    )?;
    let account_generation = clerk_identity::native_identity_generation_snapshot()?;
    let (capability, base) = request_execution_capability(
        &proposal.workspace_id,
        &proposal.agent_id,
        &proposal.device_id,
        "schedule:manage",
    ).await?;
    let expected_routine_id = proposal.routine_id.clone();
    let expected_request_key = proposal.request_key.clone();
    let value = runner_json(
        Method::POST,
        runner_url(&base, &capability.computer_id, &["agent-routines", proposal.routine_id.as_str()])?,
        &capability.token,
        Some(json!({
            "requestKey": proposal.request_key,
            "routineId": proposal.routine_id,
            "runId": proposal.run_id,
            "title": proposal.title,
            "instruction": proposal.instruction,
            "firstRunAt": proposal.first_run_at,
            "intervalSeconds": proposal.interval_seconds,
            "capabilities": proposal.capabilities,
            "maxSteps": proposal.max_steps
        })),
    ).await?;
    if clerk_identity::native_identity_generation_snapshot()? != account_generation {
        return Err(ACCOUNT_CHANGED_ERROR.into());
    }
    let _identity_guard = clerk_identity::lock_native_identity_generation(&account_generation)?;
    let snapshot: HostedAgentRoutineSnapshot = serde_json::from_value(value)
        .map_err(|_| "The hosted agent routine response failed validation.".to_string())?;
    validate_agent_routine_snapshot(&snapshot, Some(&expected_routine_id), Some(&expected_request_key))?;
    Ok(snapshot)
}

#[tauri::command]
pub async fn hosted_agent_routine_list(
    target: HostedAgentRoutineListTarget,
) -> Result<Vec<HostedAgentRoutineSnapshot>, String> {
    if !valid_id(&target.workspace_id) || !valid_id(&target.agent_id) || !valid_id(&target.device_id) {
        return Err("The hosted agent routine scope is invalid.".into());
    }
    let account_generation = clerk_identity::native_identity_generation_snapshot()?;
    let (capability, base) = request_execution_capability(
        &target.workspace_id,
        &target.agent_id,
        &target.device_id,
        "schedule:manage",
    ).await?;
    let value = runner_json(
        Method::GET,
        runner_url(&base, &capability.computer_id, &["agent-routines"] )?,
        &capability.token,
        None,
    ).await?;
    if clerk_identity::native_identity_generation_snapshot()? != account_generation {
        return Err(ACCOUNT_CHANGED_ERROR.into());
    }
    let _identity_guard = clerk_identity::lock_native_identity_generation(&account_generation)?;
    let snapshots: Vec<HostedAgentRoutineSnapshot> = serde_json::from_value(value)
        .map_err(|_| "The hosted agent routine list failed validation.".to_string())?;
    if snapshots.len() > 50 {
        return Err("The hosted agent routine list failed validation.".into());
    }
    let mut ids = std::collections::BTreeSet::new();
    for snapshot in &snapshots {
        validate_agent_routine_snapshot(snapshot, None, None)?;
        if !ids.insert(snapshot.routine_id.as_str()) {
            return Err("The hosted agent routine list failed validation.".into());
        }
    }
    Ok(snapshots)
}

#[tauri::command]
pub async fn hosted_agent_routine_run_list(
    target: HostedAgentRoutineListTarget,
) -> Result<Vec<HostedAgentRoutineRunSnapshot>, String> {
    if !valid_id(&target.workspace_id) || !valid_id(&target.agent_id) || !valid_id(&target.device_id) {
        return Err("The hosted agent routine scope is invalid.".into());
    }
    let account_generation = clerk_identity::native_identity_generation_snapshot()?;
    let (capability, base) = request_execution_capability(
        &target.workspace_id,
        &target.agent_id,
        &target.device_id,
        "schedule:manage",
    ).await?;
    let value = runner_json(
        Method::GET,
        runner_url(&base, &capability.computer_id, &["agent-routine-runs"] )?,
        &capability.token,
        None,
    ).await?;
    if clerk_identity::native_identity_generation_snapshot()? != account_generation {
        return Err(ACCOUNT_CHANGED_ERROR.into());
    }
    let _identity_guard = clerk_identity::lock_native_identity_generation(&account_generation)?;
    let snapshots: Vec<HostedAgentRoutineRunSnapshot> = serde_json::from_value(value)
        .map_err(|_| "The hosted agent routine history failed validation.".to_string())?;
    if snapshots.len() > 50 {
        return Err("The hosted agent routine history failed validation.".into());
    }
    let mut ids = std::collections::BTreeSet::new();
    for snapshot in &snapshots {
        validate_agent_routine_run_snapshot(snapshot)?;
        if !ids.insert((snapshot.routine_id.as_str(), snapshot.occurrence_id.as_str())) {
            return Err("The hosted agent routine history failed validation.".into());
        }
    }
    Ok(snapshots)
}

#[tauri::command]
pub fn hosted_agent_routine_cancel_prepare(
    target: HostedAgentRoutineTarget,
) -> Result<PreparedHostedAgentRoutineCancel, String> {
    if !valid_id(&target.workspace_id)
        || !valid_id(&target.agent_id)
        || !valid_id(&target.device_id)
        || !valid_routine_id(&target.routine_id)
    {
        return Err("The hosted agent routine target is invalid.".into());
    }
    let proposal = HostedAgentRoutineCancelProposal {
        request_key: opaque_key("agent-routine-cancel")?,
        workspace_id: target.workspace_id,
        agent_id: target.agent_id,
        device_id: target.device_id,
        routine_id: target.routine_id,
    };
    let fingerprint = agent_routine_cancel_fingerprint(&proposal)?;
    let approval = approval_for_agent_routine_cancel(
        &proposal,
        &fingerprint,
        opaque_key("approval-hosted-agent-routine-cancel")?,
        Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    );
    Ok(PreparedHostedAgentRoutineCancel { proposal, proposal_fingerprint: fingerprint, approval })
}

#[tauri::command]
pub async fn hosted_agent_routine_cancel(
    app: tauri::AppHandle,
    request: CommitHostedAgentRoutineCancelRequest,
) -> Result<HostedAgentRoutineSnapshot, String> {
    let proposal = normalize_agent_routine_cancel_proposal(request.proposal)?;
    let fingerprint = agent_routine_cancel_fingerprint(&proposal)?;
    let expected = approval_for_agent_routine_cancel(
        &proposal,
        &fingerprint,
        request.resolution.request.id.clone(),
        request.resolution.request.requested_at.clone(),
    );
    if request.resolution.request != expected || request.resolution.decision != "once" || request.resolution.modification.is_some() {
        return Err("The hosted agent routine cancellation changed after the approval preview.".into());
    }
    let source_resolution = crate::approvals::resolve_approval(request.source_resolution)?;
    crate::tools::validate_tool_approval_binding(
        "cloud-agent-routine-cancel",
        &json!({ "routineId": proposal.routine_id.clone() }),
        &source_resolution.effective_request,
    )?;
    let resolution = crate::approvals::resolve_approval(request.resolution)?;
    if source_resolution.audit_entry.decision == "deny" || resolution.audit_entry.decision != "once" {
        return Err("The hosted agent routine cancellation was not approved.".into());
    }
    crate::execution_approvals::verify_and_consume_execution_approval(
        &crate::paths::execution_approvals_path(&app)?, &source_resolution.effective_request, &source_resolution.audit_entry.decided_at,
    )?;
    crate::execution_approvals::verify_and_consume_execution_approval(
        &crate::paths::execution_approvals_path(&app)?, &resolution.effective_request, &resolution.audit_entry.decided_at,
    )?;
    let account_generation = clerk_identity::native_identity_generation_snapshot()?;
    let (capability, base) = request_execution_capability(
        &proposal.workspace_id, &proposal.agent_id, &proposal.device_id, "schedule:manage",
    ).await?;
    let value = runner_json(
        Method::DELETE,
        runner_url(&base, &capability.computer_id, &["agent-routines", proposal.routine_id.as_str()])?,
        &capability.token,
        None,
    ).await?;
    if clerk_identity::native_identity_generation_snapshot()? != account_generation { return Err(ACCOUNT_CHANGED_ERROR.into()); }
    let _identity_guard = clerk_identity::lock_native_identity_generation(&account_generation)?;
    let snapshot: HostedAgentRoutineSnapshot = serde_json::from_value(value)
        .map_err(|_| "The hosted agent routine response failed validation.".to_string())?;
    validate_agent_routine_snapshot(&snapshot, Some(&proposal.routine_id), None)?;
    if snapshot.lifecycle != "cancelled" { return Err("The hosted agent routine was not cancelled.".into()); }
    Ok(snapshot)
}

#[tauri::command]
pub fn hosted_agent_routine_control_prepare(
    draft: HostedAgentRoutineControlDraft,
) -> Result<PreparedHostedAgentRoutineControl, String> {
    let draft = normalize_agent_routine_control_draft(draft)?;
    let proposal = HostedAgentRoutineControlProposal {
        request_key: opaque_key("agent-routine-control")?,
        workspace_id: draft.workspace_id,
        agent_id: draft.agent_id,
        device_id: draft.device_id,
        routine_id: draft.routine_id,
        action: draft.action,
    };
    let fingerprint = agent_routine_control_fingerprint(&proposal)?;
    let approval = approval_for_agent_routine_control(
        &proposal,
        &fingerprint,
        opaque_key("approval-hosted-agent-routine-control")?,
        Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    );
    Ok(PreparedHostedAgentRoutineControl { proposal, proposal_fingerprint: fingerprint, approval })
}

#[tauri::command]
pub async fn hosted_agent_routine_control(
    app: tauri::AppHandle,
    request: CommitHostedAgentRoutineControlRequest,
) -> Result<HostedAgentRoutineSnapshot, String> {
    let proposal = normalize_agent_routine_control_proposal(request.proposal)?;
    let fingerprint = agent_routine_control_fingerprint(&proposal)?;
    let expected = approval_for_agent_routine_control(
        &proposal, &fingerprint, request.resolution.request.id.clone(), request.resolution.request.requested_at.clone(),
    );
    if request.resolution.request != expected || request.resolution.decision != "once" || request.resolution.modification.is_some() {
        return Err("The hosted agent routine change changed after the approval preview.".into());
    }
    let source_tool = format!("cloud-agent-routine-{}", proposal.action);
    let source_resolution = crate::approvals::resolve_approval(request.source_resolution)?;
    crate::tools::validate_tool_approval_binding(
        &source_tool,
        &json!({ "routineId": proposal.routine_id.clone() }),
        &source_resolution.effective_request,
    )?;
    let resolution = crate::approvals::resolve_approval(request.resolution)?;
    if source_resolution.audit_entry.decision == "deny" || resolution.audit_entry.decision != "once" {
        return Err("The hosted agent routine change was not approved.".into());
    }
    crate::execution_approvals::verify_and_consume_execution_approval(
        &crate::paths::execution_approvals_path(&app)?, &source_resolution.effective_request, &source_resolution.audit_entry.decided_at,
    )?;
    crate::execution_approvals::verify_and_consume_execution_approval(
        &crate::paths::execution_approvals_path(&app)?, &resolution.effective_request, &resolution.audit_entry.decided_at,
    )?;
    let account_generation = clerk_identity::native_identity_generation_snapshot()?;
    let (capability, base) = request_execution_capability(
        &proposal.workspace_id, &proposal.agent_id, &proposal.device_id, "schedule:manage",
    ).await?;
    let value = runner_json(
        Method::POST,
        runner_url(&base, &capability.computer_id, &["agent-routines", proposal.routine_id.as_str(), proposal.action.as_str()])?,
        &capability.token,
        None,
    ).await?;
    if clerk_identity::native_identity_generation_snapshot()? != account_generation { return Err(ACCOUNT_CHANGED_ERROR.into()); }
    let _identity_guard = clerk_identity::lock_native_identity_generation(&account_generation)?;
    let snapshot: HostedAgentRoutineSnapshot = serde_json::from_value(value)
        .map_err(|_| "The hosted agent routine response failed validation.".to_string())?;
    validate_agent_routine_snapshot(&snapshot, Some(&proposal.routine_id), None)?;
    let expected_lifecycle = if proposal.action == "pause" { "paused" } else { "active" };
    if snapshot.lifecycle != expected_lifecycle { return Err("The hosted agent routine did not reach the requested state.".into()); }
    Ok(snapshot)
}

#[tauri::command]
pub async fn hosted_process_status(
    target: HostedProcessTarget,
) -> Result<HostedProcessSnapshot, String> {
    fetch_process_snapshot(Method::GET, &target, &[]).await
}

#[tauri::command]
pub async fn hosted_process_kill(
    target: HostedProcessTarget,
) -> Result<HostedProcessSnapshot, String> {
    fetch_process_snapshot(Method::POST, &target, &["kill"]).await
}

#[tauri::command]
pub fn hosted_browser_prepare(
    draft: HostedBrowserNavigateDraft,
) -> Result<PreparedHostedBrowserNavigation, String> {
    let draft = normalize_browser_draft(draft)?;
    let proposal = HostedBrowserNavigateProposal {
        request_key: opaque_key("browser")?,
        workspace_id: draft.workspace_id,
        agent_id: draft.agent_id,
        device_id: draft.device_id,
        url: draft.url,
    };
    let fingerprint = browser_proposal_fingerprint(&proposal)?;
    let approval = approval_for_browser(
        &proposal,
        &fingerprint,
        opaque_key("approval-hosted-browser")?,
        Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    );
    Ok(PreparedHostedBrowserNavigation {
        proposal,
        proposal_fingerprint: fingerprint,
        approval,
    })
}

#[tauri::command]
pub async fn hosted_browser_navigate(
    app: tauri::AppHandle,
    request: CommitHostedBrowserNavigationRequest,
) -> Result<HostedBrowserSnapshot, String> {
    let proposal = validate_browser_proposal(request.proposal)?;
    let fingerprint = browser_proposal_fingerprint(&proposal)?;
    let expected = approval_for_browser(
        &proposal,
        &fingerprint,
        request.resolution.request.id.clone(),
        request.resolution.request.requested_at.clone(),
    );
    if request.resolution.request != expected
        || request.resolution.decision != "once"
        || request.resolution.modification.is_some()
    {
        return Err("The cloud browser request changed after the approval preview.".into());
    }
    if let Some(source_resolution) = request.source_resolution {
        let source_resolution = crate::approvals::resolve_approval(source_resolution)?;
        if source_resolution.audit_entry.decision == "deny" {
            return Err("The source cloud-browser call was not approved.".into());
        }
        crate::tools::validate_tool_approval_binding(
            "cloud-browser",
            &json!({ "url": proposal.url.clone() }),
            &source_resolution.effective_request,
        )?;
        crate::execution_approvals::verify_and_consume_execution_approval(
            &crate::paths::execution_approvals_path(&app)?,
            &source_resolution.effective_request,
            &source_resolution.audit_entry.decided_at,
        )?;
    }
    let resolution = crate::approvals::resolve_approval(request.resolution)?;
    if resolution.audit_entry.decision != "once" {
        return Err("Cloud browser navigation requires a fresh one-time approval.".into());
    }
    crate::execution_approvals::verify_and_consume_execution_approval(
        &crate::paths::execution_approvals_path(&app)?,
        &resolution.effective_request,
        &resolution.audit_entry.decided_at,
    )?;

    let account_generation = clerk_identity::native_identity_generation_snapshot()?;
    let (capability, base) = request_execution_capability(
        &proposal.workspace_id,
        &proposal.agent_id,
        &proposal.device_id,
        "browser:navigate",
    )
    .await?;
    let value = runner_json(
        Method::POST,
        runner_url(&base, &capability.computer_id, &["browser", "navigate"])?,
        &capability.token,
        Some(json!({ "requestKey": proposal.request_key, "url": proposal.url })),
    )
    .await?;
    let snapshot: HostedBrowserSnapshot = serde_json::from_value(value)
        .map_err(|_| "The cloud browser response failed validation.".to_string())?;
    validate_browser_snapshot(&snapshot, true)?;
    if clerk_identity::native_identity_generation_snapshot()? != account_generation {
        return Err(ACCOUNT_CHANGED_ERROR.into());
    }
    let _identity_guard = clerk_identity::lock_native_identity_generation(&account_generation)?;
    Ok(snapshot)
}

#[tauri::command]
pub fn hosted_browser_action_prepare(
    draft: HostedBrowserActionDraft,
) -> Result<PreparedHostedBrowserAction, String> {
    let draft = normalize_browser_action_draft(draft)?;
    let proposal = HostedBrowserActionProposal {
        request_key: opaque_key("browser-action")?,
        workspace_id: draft.workspace_id,
        agent_id: draft.agent_id,
        device_id: draft.device_id,
        observation_id: draft.observation_id,
        element_ref: draft.element_ref,
        control_role: draft.control_role,
        control_name: draft.control_name,
        action: draft.action,
        value: draft.value,
        key: draft.key,
    };
    let fingerprint = browser_action_fingerprint(&proposal)?;
    let approval = approval_for_browser_action(
        &proposal,
        &fingerprint,
        opaque_key("approval-hosted-browser-action")?,
        Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    );
    Ok(PreparedHostedBrowserAction {
        proposal,
        proposal_fingerprint: fingerprint,
        approval,
    })
}

#[tauri::command]
pub async fn hosted_browser_action(
    app: tauri::AppHandle,
    request: CommitHostedBrowserActionRequest,
) -> Result<HostedBrowserSnapshot, String> {
    let proposal = validate_browser_action_proposal(request.proposal)?;
    let fingerprint = browser_action_fingerprint(&proposal)?;
    let expected = approval_for_browser_action(
        &proposal,
        &fingerprint,
        request.resolution.request.id.clone(),
        request.resolution.request.requested_at.clone(),
    );
    if request.resolution.request != expected
        || request.resolution.decision != "once"
        || request.resolution.modification.is_some()
    {
        return Err("The cloud browser action changed after the approval preview.".into());
    }
    let source_resolution = crate::approvals::resolve_approval(request.source_resolution)?;
    if source_resolution.audit_entry.decision == "deny" {
        return Err("The source cloud-browser-action call was not approved.".into());
    }
    let source_arguments = match proposal.action.as_str() {
        "fill" | "select" | "scroll" | "history" => json!({
            "action": proposal.action.clone(),
            "elementRef": proposal.element_ref.clone(),
            "controlRole": proposal.control_role.clone(),
            "controlName": proposal.control_name.clone(),
            "observationId": proposal.observation_id.clone(),
            "value": proposal.value.clone()
        }),
        "press" => json!({
            "action": proposal.action.clone(),
            "elementRef": proposal.element_ref.clone(),
            "controlRole": proposal.control_role.clone(),
            "controlName": proposal.control_name.clone(),
            "key": proposal.key.clone(),
            "observationId": proposal.observation_id.clone()
        }),
        _ => json!({
            "action": proposal.action.clone(),
            "elementRef": proposal.element_ref.clone(),
            "controlRole": proposal.control_role.clone(),
            "controlName": proposal.control_name.clone(),
            "observationId": proposal.observation_id.clone()
        }),
    };
    crate::tools::validate_tool_approval_binding(
        "cloud-browser-action",
        &source_arguments,
        &source_resolution.effective_request,
    )?;
    crate::execution_approvals::verify_and_consume_execution_approval(
        &crate::paths::execution_approvals_path(&app)?,
        &source_resolution.effective_request,
        &source_resolution.audit_entry.decided_at,
    )?;
    let resolution = crate::approvals::resolve_approval(request.resolution)?;
    if resolution.audit_entry.decision != "once" {
        return Err("Cloud browser actions require a fresh one-time approval.".into());
    }
    crate::execution_approvals::verify_and_consume_execution_approval(
        &crate::paths::execution_approvals_path(&app)?,
        &resolution.effective_request,
        &resolution.audit_entry.decided_at,
    )?;

    let account_generation = clerk_identity::native_identity_generation_snapshot()?;
    let (capability, base) = request_execution_capability(
        &proposal.workspace_id,
        &proposal.agent_id,
        &proposal.device_id,
        "browser:act",
    )
    .await?;
    let mut runner_body = json!({
        "requestKey": proposal.request_key,
        "observationId": proposal.observation_id,
        "elementRef": proposal.element_ref,
        "controlRole": proposal.control_role,
        "controlName": proposal.control_name,
        "action": proposal.action
    });
    if let Some(value) = proposal.value {
        runner_body["value"] = Value::String(value);
    }
    if let Some(key) = proposal.key {
        runner_body["key"] = Value::String(key);
    }
    let value = runner_json(
        Method::POST,
        runner_url(&base, &capability.computer_id, &["browser", "act"])?,
        &capability.token,
        Some(runner_body),
    )
    .await?;
    let snapshot: HostedBrowserSnapshot = serde_json::from_value(value)
        .map_err(|_| "The cloud browser response failed validation.".to_string())?;
    validate_browser_snapshot(&snapshot, true)?;
    if clerk_identity::native_identity_generation_snapshot()? != account_generation {
        return Err(ACCOUNT_CHANGED_ERROR.into());
    }
    let _identity_guard = clerk_identity::lock_native_identity_generation(&account_generation)?;
    Ok(snapshot)
}

#[tauri::command]
pub async fn hosted_browser_snapshot(
    target: HostedBrowserTarget,
) -> Result<HostedBrowserSnapshot, String> {
    let target = normalize_browser_target(target)?;
    let account_generation = clerk_identity::native_identity_generation_snapshot()?;
    let (capability, base) = request_execution_capability(
        &target.workspace_id,
        &target.agent_id,
        &target.device_id,
        "browser:snapshot",
    )
    .await?;
    let value = runner_json(
        Method::GET,
        runner_url(&base, &capability.computer_id, &["browser", "snapshot"])?,
        &capability.token,
        None,
    )
    .await?;
    let snapshot: HostedBrowserSnapshot = serde_json::from_value(value)
        .map_err(|_| "The cloud browser response failed validation.".to_string())?;
    validate_browser_snapshot(&snapshot, false)?;
    if clerk_identity::native_identity_generation_snapshot()? != account_generation {
        return Err(ACCOUNT_CHANGED_ERROR.into());
    }
    let _identity_guard = clerk_identity::lock_native_identity_generation(&account_generation)?;
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_public_control_plane_identifiers() {
        assert!(valid_id("workspace:alpha"));
        assert!(valid_id("agent_research-1"));
        assert!(!valid_id("../escape"));
        assert!(!valid_id("ab"));
        assert!(!valid_id("agent secret"));
    }

    #[test]
    fn provision_keys_are_opaque_and_valid() {
        let first = opaque_key("provision").unwrap();
        let second = opaque_key("provision").unwrap();
        assert!(valid_id(&first));
        assert_ne!(first, second);
    }

    fn draft() -> HostedProcessDraft {
        HostedProcessDraft {
            workspace_id: "workspace:alpha".into(),
            agent_id: "agent-research".into(),
            device_id: "device-desktop".into(),
            run_id: "run-123".into(),
            argv: vec!["node".into(), "worker.mjs".into(), "--once".into()],
            cwd: Some("/workspace/project".into()),
            timeout_ms: Some(60_000),
        }
    }

    #[test]
    fn process_approval_binds_every_visible_argument() {
        let draft = normalize_draft(draft()).unwrap();
        let proposal = HostedProcessLaunchProposal {
            request_key: "process-example".into(),
            workspace_id: draft.workspace_id,
            agent_id: draft.agent_id,
            device_id: draft.device_id,
            run_id: draft.run_id,
            argv: draft.argv,
            cwd: draft.cwd,
            timeout_ms: draft.timeout_ms,
        };
        let fingerprint = proposal_fingerprint(&proposal).unwrap();
        let approval = approval_for_process(
            &proposal,
            &fingerprint,
            "approval-hosted-process-example".into(),
            "2026-08-24T12:00:00.000Z".into(),
        );
        assert!(approval.data_used.contains(&"program: node".to_string()));
        assert!(approval
            .data_used
            .contains(&"argument 1: worker.mjs".to_string()));
        assert!(approval
            .data_used
            .contains(&"argument 2: --once".to_string()));
        assert!(approval
            .data_used
            .iter()
            .any(|value| value.ends_with(&fingerprint)));
        assert_eq!(approval.decisions, vec!["once", "deny"]);
    }

    #[test]
    fn process_proposal_fingerprint_changes_with_arguments() {
        let draft = normalize_draft(draft()).unwrap();
        let mut proposal = HostedProcessLaunchProposal {
            request_key: "process-example".into(),
            workspace_id: draft.workspace_id,
            agent_id: draft.agent_id,
            device_id: draft.device_id,
            run_id: draft.run_id,
            argv: draft.argv,
            cwd: draft.cwd,
            timeout_ms: draft.timeout_ms,
        };
        let first = proposal_fingerprint(&proposal).unwrap();
        proposal.argv[2] = "--all".into();
        assert_ne!(first, proposal_fingerprint(&proposal).unwrap());
    }

    #[test]
    fn hosted_schedule_approval_binds_program_and_recurrence() {
        let first_run_at =
            (Utc::now() + chrono::Duration::hours(1)).to_rfc3339_opts(SecondsFormat::Millis, true);
        let proposal = validate_schedule_proposal(HostedProcessScheduleProposal {
            request_key: "schedule-request-example".into(),
            workspace_id: "workspace:alpha".into(),
            agent_id: "agent-research".into(),
            device_id: "device-desktop".into(),
            schedule_id: "schedule-digest-123".into(),
            run_id: "scheduled-digest".into(),
            argv: vec!["node".into(), "digest.mjs".into()],
            cwd: Some("/workspace/project".into()),
            timeout_ms: Some(60_000),
            first_run_at,
            interval_seconds: 3_600,
        })
        .unwrap();
        let fingerprint = schedule_fingerprint(&proposal).unwrap();
        let approval = approval_for_schedule(
            &proposal,
            &fingerprint,
            "approval-hosted-schedule-example".into(),
            Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        );
        assert!(approval
            .data_used
            .contains(&"schedule: schedule-digest-123".to_string()));
        assert!(approval
            .data_used
            .contains(&"interval: 3600 seconds".to_string()));
        assert!(approval.data_used.contains(&"program: node".to_string()));
        assert_eq!(
            approval.confirmation_phrase.as_deref(),
            Some("schedule on cloud computer")
        );
    }

    #[test]
    fn hosted_schedule_cancel_approval_binds_exact_schedule() {
        let proposal = normalize_schedule_cancel_proposal(HostedProcessScheduleCancelProposal {
            request_key: "schedule-cancel-example".into(),
            workspace_id: "workspace:alpha".into(),
            agent_id: "agent-research".into(),
            device_id: "device-desktop".into(),
            schedule_id: "schedule-digest-123".into(),
        })
        .unwrap();
        let fingerprint = schedule_cancel_fingerprint(&proposal).unwrap();
        let approval = approval_for_schedule_cancel(
            &proposal,
            &fingerprint,
            "approval-hosted-schedule-cancel-example".into(),
            Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        );
        assert!(approval
            .data_used
            .contains(&"schedule: schedule-digest-123".to_string()));
        assert_eq!(
            approval.confirmation_phrase.as_deref(),
            Some("cancel cloud schedule")
        );
    }

    #[test]
    fn hosted_agent_routine_normalizes_authority_and_binds_the_exact_instruction() {
        let first_run_at =
            (Utc::now() + chrono::Duration::hours(1)).to_rfc3339_opts(SecondsFormat::Millis, true);
        let draft = normalize_agent_routine_draft(HostedAgentRoutineDraft {
            workspace_id: "workspace:alpha".into(),
            agent_id: "agent-research".into(),
            device_id: "device-desktop".into(),
            routine_id: "routine-research-digest-123".into(),
            run_id: "routine-research-digest".into(),
            title: "Research digest".into(),
            instruction: "Review workspace notes and update digest.md.".into(),
            first_run_at,
            interval_seconds: 86_400,
            capabilities: vec!["process-run".into(), "workspace-read".into(), "workspace-write".into()],
            max_steps: Some(6),
        })
        .unwrap();
        assert_eq!(
            draft.capabilities,
            vec!["workspace-read", "workspace-write", "process-run"]
        );

        let proposal = HostedAgentRoutineProposal {
            request_key: "agent-routine-request-example".into(),
            workspace_id: draft.workspace_id,
            agent_id: draft.agent_id,
            device_id: draft.device_id,
            routine_id: draft.routine_id,
            run_id: draft.run_id,
            title: draft.title,
            instruction: draft.instruction,
            first_run_at: draft.first_run_at,
            interval_seconds: draft.interval_seconds,
            capabilities: draft.capabilities,
            max_steps: draft.max_steps.unwrap(),
        };
        let fingerprint = agent_routine_fingerprint(&proposal).unwrap();
        let approval = approval_for_agent_routine(
            &proposal,
            &fingerprint,
            "approval-hosted-agent-routine-example".into(),
            Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        );
        assert!(approval
            .data_used
            .contains(&"instruction: Review workspace notes and update digest.md.".to_string()));
        assert!(approval.data_used.contains(
            &"standing capabilities: workspace-read, workspace-write, process-run".to_string()
        ));
        assert!(approval
            .data_used
            .contains(&"tool-step limit per run: 6".to_string()));
        assert!(approval
            .data_used
            .iter()
            .any(|value| value.ends_with(&fingerprint)));
        assert_eq!(
            approval.confirmation_phrase.as_deref(),
            Some("schedule cloud teammate")
        );
    }

    #[test]
    fn hosted_agent_routine_rejects_missing_read_authority_and_unbounded_results() {
        let first_run_at =
            (Utc::now() + chrono::Duration::hours(1)).to_rfc3339_opts(SecondsFormat::Millis, true);
        let invalid = HostedAgentRoutineDraft {
            workspace_id: "workspace:alpha".into(),
            agent_id: "agent-research".into(),
            device_id: "device-desktop".into(),
            routine_id: "routine-research-digest-123".into(),
            run_id: "routine-research-digest".into(),
            title: "Research digest".into(),
            instruction: "Run a workspace process.".into(),
            first_run_at,
            interval_seconds: 86_400,
            capabilities: vec!["process-run".into()],
            max_steps: Some(6),
        };
        assert!(normalize_agent_routine_draft(invalid).is_err());

        let mut snapshot = HostedAgentRoutineRunSnapshot {
            occurrence_id: "occurrence-1787767200000".into(),
            routine_id: "routine-research-digest-123".into(),
            run_id: "routine-research-digest:1787767200000".into(),
            scheduled_at: "2026-08-26T18:00:00.000Z".into(),
            lifecycle: "completed".into(),
            result: Some("Digest written to digest.md.".into()),
            error_code: None,
            tools: vec![HostedAgentRoutineToolRunSnapshot {
                tool: "workspace-write".into(),
                summary: "Updated /workspace/digest.md".into(),
                status: "completed".into(),
            }],
            started_at: "2026-08-26T18:00:00.000Z".into(),
            ended_at: Some("2026-08-26T18:00:03.000Z".into()),
            generation: 1,
            updated_at: "2026-08-26T18:00:03.000Z".into(),
        };
        assert!(validate_agent_routine_run_snapshot(&snapshot).is_ok());
        snapshot.tools[0].summary = "x".repeat(241);
        assert!(validate_agent_routine_run_snapshot(&snapshot).is_err());
    }

    #[test]
    fn rejects_shell_control_characters_and_workspace_escape() {
        let mut invalid = draft();
        invalid.argv[1] = "worker.mjs\nmalicious".into();
        assert!(normalize_draft(invalid).is_err());
        let mut escaped = draft();
        escaped.cwd = Some("/workspace/../etc".into());
        assert!(normalize_draft(escaped).is_err());
    }

    #[test]
    fn cloud_browser_accepts_only_public_https_pages() {
        assert_eq!(
            normalize_public_https_url("https://example.com/path?q=1#section").unwrap(),
            "https://example.com/path?q=1"
        );
        for value in [
            "http://example.com",
            "https://localhost",
            "https://127.0.0.1",
            "https://10.0.0.1",
            "https://192.168.1.1",
            "https://[::1]",
            "https://user:secret@example.com",
        ] {
            assert!(
                normalize_public_https_url(value).is_err(),
                "accepted {value}"
            );
        }
    }

    #[test]
    fn browser_approval_binds_the_exact_page_and_scope() {
        let proposal = HostedBrowserNavigateProposal {
            request_key: "browser-example".into(),
            workspace_id: "workspace:alpha".into(),
            agent_id: "agent-research".into(),
            device_id: "device-desktop".into(),
            url: "https://example.com/".into(),
        };
        let fingerprint = browser_proposal_fingerprint(&proposal).unwrap();
        let approval = approval_for_browser(
            &proposal,
            &fingerprint,
            "approval-hosted-browser-example".into(),
            "2026-08-25T12:00:00.000Z".into(),
        );
        assert!(approval
            .data_used
            .contains(&"page: https://example.com/".to_string()));
        assert!(approval
            .data_used
            .iter()
            .any(|value| value.ends_with(&fingerprint)));
        assert_eq!(
            approval.confirmation_phrase.as_deref(),
            Some("open cloud browser")
        );
        assert_eq!(approval.decisions, vec!["once", "deny"]);
    }

    #[test]
    fn browser_action_binds_one_observed_control_and_rejects_unsupported_keys() {
        let draft = HostedBrowserActionDraft {
            workspace_id: "workspace:alpha".into(),
            agent_id: "agent-research".into(),
            device_id: "device-desktop".into(),
            observation_id: "observation-1234567890abcdef".into(),
            element_ref: "control-1234567890abcdef-1".into(),
            control_role: "button".into(),
            control_name: "Continue".into(),
            action: "click".into(),
            value: None,
            key: None,
        };
        let normalized = normalize_browser_action_draft(draft).unwrap();
        let proposal = HostedBrowserActionProposal {
            request_key: "browser-action-example".into(),
            workspace_id: normalized.workspace_id,
            agent_id: normalized.agent_id,
            device_id: normalized.device_id,
            observation_id: normalized.observation_id,
            element_ref: normalized.element_ref,
            control_role: normalized.control_role,
            control_name: normalized.control_name,
            action: normalized.action,
            value: normalized.value,
            key: normalized.key,
        };
        let fingerprint = browser_action_fingerprint(&proposal).unwrap();
        let approval = approval_for_browser_action(
            &proposal,
            &fingerprint,
            "approval-hosted-browser-action-example".into(),
            "2026-08-25T12:00:00.000Z".into(),
        );
        assert!(approval
            .data_used
            .contains(&"control name: Continue".to_string()));
        assert_eq!(
            approval.confirmation_phrase.as_deref(),
            Some("act in cloud browser")
        );
        let mut invalid_key = HostedBrowserActionDraft {
            workspace_id: "workspace:alpha".into(),
            agent_id: "agent-research".into(),
            device_id: "device-desktop".into(),
            observation_id: "observation-1234567890abcdef".into(),
            element_ref: "control-1234567890abcdef-1".into(),
            control_role: "textbox".into(),
            control_name: "Search".into(),
            action: "press".into(),
            value: None,
            key: Some("Control+A".into()),
        };
        assert!(normalize_browser_action_draft(invalid_key.clone()).is_err());
        invalid_key.key = Some("Enter".into());
        assert!(normalize_browser_action_draft(invalid_key).is_ok());
        let select = HostedBrowserActionDraft {
            workspace_id: "workspace:alpha".into(),
            agent_id: "agent-research".into(),
            device_id: "device-desktop".into(),
            observation_id: "observation-1234567890abcdef".into(),
            element_ref: "control-1234567890abcdef-2".into(),
            control_role: "combobox".into(),
            control_name: "Region".into(),
            action: "select".into(),
            value: Some("Europe".into()),
            key: None,
        };
        assert!(normalize_browser_action_draft(select).is_ok());
        let mut scroll = HostedBrowserActionDraft {
            workspace_id: "workspace:alpha".into(),
            agent_id: "agent-research".into(),
            device_id: "device-desktop".into(),
            observation_id: "observation-1234567890abcdef".into(),
            element_ref: "control-1234567890abcdef-0".into(),
            control_role: "document".into(),
            control_name: "Page".into(),
            action: "scroll".into(),
            value: Some("page-down".into()),
            key: None,
        };
        assert!(normalize_browser_action_draft(scroll.clone()).is_ok());
        scroll.element_ref = "control-1234567890abcdef-1".into();
        assert!(normalize_browser_action_draft(scroll.clone()).is_err());
        scroll.element_ref = "control-1234567890abcdef-0".into();
        scroll.value = Some("bottom".into());
        assert!(normalize_browser_action_draft(scroll).is_err());
        let mut history = HostedBrowserActionDraft {
            workspace_id: "workspace:alpha".into(),
            agent_id: "agent-research".into(),
            device_id: "device-desktop".into(),
            observation_id: "observation-1234567890abcdef".into(),
            element_ref: "control-1234567890abcdef-0".into(),
            control_role: "document".into(),
            control_name: "Page".into(),
            action: "history".into(),
            value: Some("back".into()),
            key: None,
        };
        assert!(normalize_browser_action_draft(history.clone()).is_ok());
        history.value = Some("reload".into());
        assert!(normalize_browser_action_draft(history).is_err());
        let mut download = HostedBrowserActionDraft {
            workspace_id: "workspace:alpha".into(),
            agent_id: "agent-research".into(),
            device_id: "device-desktop".into(),
            observation_id: "observation-1234567890abcdef".into(),
            element_ref: "control-1234567890abcdef-3".into(),
            control_role: "link".into(),
            control_name: "Download report".into(),
            action: "download".into(),
            value: None,
            key: None,
        };
        assert!(normalize_browser_action_draft(download.clone()).is_ok());
        download.value = Some("report.pdf".into());
        assert!(normalize_browser_action_draft(download).is_err());
    }

    #[test]
    fn hosted_schedule_run_history_accepts_only_bounded_durable_evidence() {
        let mut snapshot = HostedProcessScheduleRunSnapshot {
            occurrence_id: "occurrence-1787680800000".into(),
            schedule_id: "schedule-digest-123".into(),
            scheduled_at: "2026-08-25T18:00:00.000Z".into(),
            request_key: "scheduled:schedule-digest-123:1787680800000".into(),
            run_id: "weekly-digest:1787680800000".into(),
            lifecycle: "completed".into(),
            process_id: Some("process-history-123".into()),
            started_at: Some("2026-08-25T18:00:00.000Z".into()),
            ended_at: Some("2026-08-25T18:00:05.000Z".into()),
            exit_code: Some(0),
            timed_out: Some(false),
            error_code: None,
            generation: 1,
            updated_at: "2026-08-25T18:00:05.000Z".into(),
        };
        assert!(validate_schedule_run_snapshot(&snapshot).is_ok());
        snapshot.lifecycle = "active".into();
        assert!(validate_schedule_run_snapshot(&snapshot).is_err());
        snapshot.lifecycle = "failed".into();
        snapshot.occurrence_id = "../occurrence".into();
        assert!(validate_schedule_run_snapshot(&snapshot).is_err());
    }
}
