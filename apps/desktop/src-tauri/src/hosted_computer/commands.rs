//! Tauri command owners for hosted computer and browser operations.

use super::*;
use crate::clerk_identity::{self, ConvexFunctionType};
use chrono::{SecondsFormat, Utc};
use reqwest::Method;
use serde_json::{json, Value};

pub(super) async fn hosted_computer_status_impl(
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

pub(super) async fn hosted_computer_provision_impl(
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

pub(super) fn hosted_process_prepare_impl(
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

pub(super) async fn hosted_process_launch_impl(
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

pub(super) async fn hosted_process_status_impl(
    target: HostedProcessTarget,
) -> Result<HostedProcessSnapshot, String> {
    fetch_process_snapshot(Method::GET, &target, &[]).await
}

pub(super) async fn hosted_process_kill_impl(
    target: HostedProcessTarget,
) -> Result<HostedProcessSnapshot, String> {
    fetch_process_snapshot(Method::POST, &target, &["kill"]).await
}

pub(super) fn hosted_browser_prepare_impl(
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

pub(super) async fn hosted_browser_navigate_impl(
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
    Ok(retain_live_view_for_frontend(
        snapshot,
        &proposal.workspace_id,
        &proposal.agent_id,
        &proposal.device_id,
    ))
}

pub(super) fn hosted_browser_action_prepare_impl(
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

pub(super) async fn hosted_browser_action_impl(
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
    Ok(retain_live_view_for_frontend(
        snapshot,
        &proposal.workspace_id,
        &proposal.agent_id,
        &proposal.device_id,
    ))
}

pub(super) async fn hosted_browser_snapshot_impl(
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
    Ok(retain_live_view_for_frontend(
        snapshot,
        &target.workspace_id,
        &target.agent_id,
        &target.device_id,
    ))
}

pub(super) fn hosted_browser_open_live_view_impl(
    target: HostedBrowserTarget,
) -> Result<(), String> {
    let url = live_view_url_for_open(target)?;
    crate::oauth_loopback::open_browser(&url);
    Ok(())
}
