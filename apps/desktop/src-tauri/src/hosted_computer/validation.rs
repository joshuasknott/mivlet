//! Input, proposal, approval, and response validation for hosted computer calls.

use super::*;
use crate::models::ApprovalRequest;
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use sha2::{Digest, Sha256};
use url::Url;

pub(super) fn valid_id(value: &str) -> bool {
    (3..=160).contains(&value.len())
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'_' | b'-' | b'.' | b':'))
        })
}

pub(super) fn opaque_key(prefix: &str) -> Result<String, String> {
    let mut bytes = [0_u8; 24];
    getrandom::fill(&mut bytes)
        .map_err(|_| "Mivlet could not create a hosted computer request.".to_string())?;
    Ok(format!("{prefix}-{}", URL_SAFE_NO_PAD.encode(bytes)))
}

pub(super) fn validate_process_id(value: &str) -> bool {
    valid_id(value) && value.len() <= 160
}

pub(super) fn normalize_cwd(value: Option<String>) -> Result<Option<String>, String> {
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

pub(super) fn normalize_draft(draft: HostedProcessDraft) -> Result<HostedProcessDraft, String> {
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

pub(super) fn normalize_browser_draft(
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

pub(super) fn validate_browser_proposal(
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

pub(super) fn browser_proposal_fingerprint(
    proposal: &HostedBrowserNavigateProposal,
) -> Result<String, String> {
    let encoded = serde_json::to_vec(proposal)
        .map_err(|_| "Mivlet could not fingerprint the cloud browser request.".to_string())?;
    Ok(format!("{:x}", Sha256::digest(encoded)))
}

pub(super) fn normalize_browser_action_draft(
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

pub(super) fn validate_browser_action_proposal(
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

pub(super) fn browser_action_fingerprint(
    proposal: &HostedBrowserActionProposal,
) -> Result<String, String> {
    let encoded = serde_json::to_vec(proposal)
        .map_err(|_| "Mivlet could not fingerprint the cloud browser action.".to_string())?;
    Ok(format!("{:x}", Sha256::digest(encoded)))
}

pub(super) fn validate_proposal(
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

pub(super) fn proposal_fingerprint(
    proposal: &HostedProcessLaunchProposal,
) -> Result<String, String> {
    let encoded = serde_json::to_vec(proposal)
        .map_err(|_| "Mivlet could not fingerprint the hosted process request.".to_string())?;
    Ok(format!("{:x}", Sha256::digest(encoded)))
}

pub(super) fn approval_for_process(
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

pub(super) fn approval_for_browser(
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

pub(super) fn approval_for_browser_action(
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

pub(super) fn validate_process_snapshot(
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

pub(super) fn normalize_browser_target(
    target: HostedBrowserTarget,
) -> Result<HostedBrowserTarget, String> {
    if !valid_id(&target.workspace_id)
        || !valid_id(&target.agent_id)
        || !valid_id(&target.device_id)
    {
        return Err("The cloud browser scope is invalid.".into());
    }
    Ok(target)
}

pub(super) fn validate_browser_snapshot(
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

pub(super) fn validate_node(
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

pub(super) fn validate_live_view_url(value: &str) -> Result<(), String> {
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
    Ok(())
}
