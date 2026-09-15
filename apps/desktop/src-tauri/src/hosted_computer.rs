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
use crate::store::repos::workspace_directory as directory;

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

fn opaque_key(prefix: &str) -> Result<String, String> {
    let mut bytes = [0_u8; 24];
    getrandom::fill(&mut bytes)
        .map_err(|_| "Mivlet could not create a hosted computer request.".to_string())?;
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

fn require_matching_hosted_scope(
    workspace_id: &str,
    device_id: Option<&str>,
) -> Result<directory::HostedComputerScope, String> {
    let store =
        crate::store::try_global().ok_or_else(|| "Account storage unavailable.".to_string())?;
    let scope = store
        .with_conn(directory::resolve_hosted_computer_scope_for_current_user)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| {
            "Select an available hosted workspace before using its computer.".to_string()
        })?;
    if !directory::hosted_scope_matches(&scope, workspace_id, device_id) {
        return Err("The hosted computer request does not match the selected workspace.".into());
    }
    Ok(scope)
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
        .map_err(|_| "Mivlet could not fingerprint the cloud browser request.".to_string())?;
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
        .map_err(|_| "Mivlet could not fingerprint the cloud browser action.".to_string())?;
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
        .map_err(|_| "Mivlet could not fingerprint the hosted process request.".to_string())?;
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
            "computer scope: workspace {} / agent {}",
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
        action: format!("Run {} on this agent's cloud computer", proposal.argv[0]),
        mode: "full-access".into(),
        risk_level: "critical".into(),
        data_used,
        consequence: "Starts the exact displayed program inside this agent's isolated, always-on cloud computer. The program can change its workspace and access the network until it exits or is stopped.".into(),
        requested_at,
        decisions: vec!["once".into(), "deny".into()],
        confirmation_phrase: Some(HOSTED_PROCESS_CONFIRMATION.into()),
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
        action: "Open this page in the agent's cloud browser".into(),
        mode: "full-access".into(),
        risk_level: "critical".into(),
        data_used: vec![
            format!(
                "computer scope: workspace {} / agent {}",
                proposal.workspace_id, proposal.agent_id
            ),
            format!("page: {}", proposal.url),
            format!("exact request fingerprint: {fingerprint}"),
        ],
        consequence: "Loads the displayed public page from this agent's isolated cloud browser and creates a short-lived interactive takeover link. A page can observe the browser's network address and may change browser state while the session remains active.".into(),
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
            "computer scope: workspace {} / agent {}",
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
    require_matching_hosted_scope(workspace_id, Some(device_id))?;
    let before = clerk_identity::native_identity_generation_snapshot()?;
    let envelope = clerk_identity::call_convex_http_route(
        "/native/execution-capability",
        json!({
            "workspaceId": workspace_id,
            "agentId": agent_id,
            "deviceId": device_id,
            "scope": scope
        }),
    )
    .await?;
    let after = clerk_identity::native_identity_generation_snapshot()
        .map_err(|_| ACCOUNT_CHANGED_ERROR.to_string())?;
    if after != before {
        return Err(ACCOUNT_CHANGED_ERROR.into());
    }
    let _identity_guard = clerk_identity::lock_native_identity_generation(&before)?;
    let value = unwrap_success(envelope)?;
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
        .map_err(|_| "Mivlet could not initialize the hosted runner connection.".to_string())?;
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
    require_matching_hosted_scope(&workspace_id, None)?;
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
    require_matching_hosted_scope(&workspace_id, Some(&device_id))?;
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
    require_matching_hosted_scope(&draft.workspace_id, Some(&draft.device_id))?;
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
    let consumed_at = crate::execution_approvals::wall_clock_consumed_at();
    crate::execution_approvals::verify_and_consume_execution_approval(
        &crate::paths::execution_approvals_path(&app)?,
        &source_resolution.effective_request,
        &consumed_at,
    )?;
    crate::execution_approvals::verify_and_consume_execution_approval(
        &crate::paths::execution_approvals_path(&app)?,
        &resolution.effective_request,
        &consumed_at,
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
    require_matching_hosted_scope(&draft.workspace_id, Some(&draft.device_id))?;
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
            &crate::execution_approvals::wall_clock_consumed_at(),
        )?;
    }
    let resolution = crate::approvals::resolve_approval(request.resolution)?;
    if resolution.audit_entry.decision != "once" {
        return Err("Cloud browser navigation requires a fresh one-time approval.".into());
    }
    crate::execution_approvals::verify_and_consume_execution_approval(
        &crate::paths::execution_approvals_path(&app)?,
        &resolution.effective_request,
        &crate::execution_approvals::wall_clock_consumed_at(),
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
    require_matching_hosted_scope(&draft.workspace_id, Some(&draft.device_id))?;
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
    let consumed_at = crate::execution_approvals::wall_clock_consumed_at();
    crate::execution_approvals::verify_and_consume_execution_approval(
        &crate::paths::execution_approvals_path(&app)?,
        &source_resolution.effective_request,
        &consumed_at,
    )?;
    let resolution = crate::approvals::resolve_approval(request.resolution)?;
    if resolution.audit_entry.decision != "once" {
        return Err("Cloud browser actions require a fresh one-time approval.".into());
    }
    crate::execution_approvals::verify_and_consume_execution_approval(
        &crate::paths::execution_approvals_path(&app)?,
        &resolution.effective_request,
        &consumed_at,
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
    fn mismatched_hosted_drafts_are_rejected() {
        let scope = directory::HostedComputerScope {
            workspace_id: "workspace:alpha".into(),
            device_id: "device-desktop".into(),
        };
        let draft = normalize_draft(draft()).unwrap();
        assert!(directory::hosted_scope_matches(
            &scope,
            &draft.workspace_id,
            Some(&draft.device_id)
        ));
        let mut mismatched = draft;
        mismatched.workspace_id = "workspace:beta".into();
        assert!(!directory::hosted_scope_matches(
            &scope,
            &mismatched.workspace_id,
            Some(&mismatched.device_id)
        ));
        mismatched.workspace_id = "workspace:alpha".into();
        mismatched.device_id = "device-other".into();
        assert!(!directory::hosted_scope_matches(
            &scope,
            &mismatched.workspace_id,
            Some(&mismatched.device_id)
        ));
    }
}
