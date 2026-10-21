//! Native approval policy and exact argument binding.
//!
//! This module owns the closed tool registry, approval policy, argument
//! fingerprints, and native permit consumption used by the dispatcher.

use std::path::Path;

use sha2::{Digest, Sha256};

use crate::execution_approvals::verify_and_consume_execution_approval;
use crate::paths::{normalize_spaces, truncate_characters};

use super::{
    normalize_url_for_fingerprint, ToolExecutionRequest, ARGUMENT_DIGEST_PREFIX, SUPPORTED_TOOLS,
};

/// Reject tool names outside the closed registry.
pub(super) fn require_computer_generation(request: &ToolExecutionRequest) -> Result<u64, String> {
    request.computer_generation.filter(|generation| *generation > 0 && *generation <= 9_007_199_254_740_991)
        .ok_or_else(|| "Refresh this computer before requesting a tool action; its control generation is missing or invalid.".into())
}

pub(super) fn validate_tool_name(tool: &str) -> Result<(), String> {
    if SUPPORTED_TOOLS.contains(&tool) {
        Ok(())
    } else {
        Err(format!("Tool {tool} is not in Mivlet's tool registry."))
    }
}

pub(crate) fn tool_policy(tool: &str) -> Option<(&'static str, &'static str)> {
    match tool {
        "repository-pr-read" => Some(("read-only", "low")),
        "repository-pr-local" | "repository-pr-watch" => Some(("full-access", "high")),
        "repository-pr-action" => Some(("full-access", "critical")),
        "request-secret" | "webhook-signing-install" | "webhook-signing-remove" => {
            Some(("full-access", "high"))
        }
        "secret-request-status" | "webhook-signing-status" | "webhook-signing-verify" => {
            Some(("read-only", "low"))
        }
        "repository-checkpoint-list" | "repository-checkpoint-preview" => {
            Some(("read-only", "low"))
        }
        "repository-checkpoint-capture" => Some(("full-access", "high")),
        "repository-checkpoint-restore" | "repository-checkpoint-delete" => {
            Some(("full-access", "critical"))
        }
        "repository-status" | "repository-read" | "command-jobs" | "command-output" => {
            Some(("read-only", "low"))
        }
        "command-stop" | "command-input" => Some(("full-access", "high")),
        "repository-write" | "repository-commit" => Some(("full-access", "high")),
        "repository-run" | "repository-start" | "repository-publish" | "workspace-run"
        | "workspace-start" => Some(("full-access", "critical")),
        "workspace-inspect" => Some(("read-only", "low")),
        "agent-create" | "agent-update" | "project-create" | "project-team-update" => {
            Some(("full-access", "high"))
        }
        "agent-delete" => Some(("full-access", "critical")),
        "repository-recover" => Some(("full-access", "high")),
        "read-file" => Some(("read-only", "low")),
        "write-file" => Some(("full-access", "high")),
        "create-spreadsheet" | "create-document" | "create-presentation" | "create-pdf" => {
            Some(("full-access", "high"))
        }
        "run-shell" => Some(("full-access", "critical")),
        "web-fetch" => Some(("read-only", "medium")),
        "local-app-list" => Some(("read-only", "low")),
        "local-browser-open" => Some(("full-access", "high")),
        "local-browser-navigate" | "local-browser-activate" | "local-browser-handover" => {
            Some(("full-access", "high"))
        }
        "local-browser-click"
        | "local-browser-scroll"
        | "local-browser-fill"
        | "local-browser-download"
        | "local-browser-upload" => Some(("full-access", "critical")),
        "local-browser-tabs" | "local-browser-observe" | "local-browser-upload-choices" => {
            Some(("read-only", "medium"))
        }
        "local-app-select" => Some(("read-only", "medium")),
        "local-app-observe" | "local-desktop-observe" => Some(("read-only", "medium")),
        "local-app-action" | "local-desktop-action" => Some(("full-access", "critical")),
        "computer-artifact" => Some(("read-only", "low")),
        "generate-image" | "edit-image" => Some(("full-access", "high")),
        "cloud-browser" | "cloud-browser-action" => Some(("full-access", "critical")),
        "connection-read" | "github-read" | "vercel-read" | "linear-read" => {
            Some(("read-only", "medium"))
        }
        "google-drive-read" => Some(("read-only", "low")),
        "gmail-read" => Some(("read-only", "medium")),
        "google-calendar-read" => Some(("read-only", "low")),
        "search-notion" | "search-slack" => Some(("read-only", "low")),
        _ => None,
    }
}

/// Existing connector account consent covers only these closed read adapters.
/// Semantic grants, arbitrary MCP calls and every mutation retain exact permits.
pub(super) fn routine_connector_read(tool: &str) -> bool {
    matches!(
        tool,
        "google-drive-read"
            | "gmail-read"
            | "google-calendar-read"
            | "github-read"
            | "vercel-read"
            | "linear-read"
            | "search-notion"
            | "search-slack"
    )
}

pub(super) fn verify_tool_authority(
    path: &Path,
    request: &ToolExecutionRequest,
) -> Result<(), String> {
    crate::managed_runtime::check_managed_runtime_tool(
        request.approval.request.id.clone(),
        request.tool.clone(),
        request.arguments.clone(),
    )?;
    verify_execution_permit(path, request)
}

pub(super) fn verify_execution_permit(
    path: &Path,
    request: &ToolExecutionRequest,
) -> Result<(), String> {
    if is_computer_tool(&request.tool) {
        validate_computer_approval_binding(request)?;
    } else {
        validate_tool_approval_binding(
            &request.tool,
            &request.arguments,
            &request.approval.request,
        )?;
    }
    if routine_connector_read(&request.tool) {
        if request.approval.decision != "once" {
            return Err("Connector read was denied or has an invalid decision.".into());
        }
        return Ok(());
    }
    if matches!(request.approval.decision.as_str(), "session" | "rule") {
        return Err(
            "Execution blocked: standing session/rule decisions cannot authorize this effect."
                .into(),
        );
    }
    verify_and_consume_execution_approval(
        path,
        &request.approval.request,
        &crate::execution_approvals::wall_clock_consumed_at(),
    )
}

pub(super) fn is_computer_tool(tool: &str) -> bool {
    if is_protected_secret_tool(tool) {
        return true;
    }
    if tool.starts_with("repository-") || tool.starts_with("command-") || tool == "workspace-start"
    {
        return true;
    }
    matches!(
        tool,
        "run-shell"
            | "workspace-run"
            | "read-file"
            | "write-file"
            | "create-spreadsheet"
            | "create-document"
            | "create-presentation"
            | "create-pdf"
            | "computer-artifact"
            | "generate-image"
            | "edit-image"
            | "local-app-observe"
            | "local-app-list"
            | "local-browser-open"
            | "local-browser-tabs"
            | "local-browser-observe"
            | "local-browser-navigate"
            | "local-browser-activate"
            | "local-browser-fill"
            | "local-browser-download"
            | "local-browser-upload-choices"
            | "local-browser-upload"
            | "local-browser-handover"
            | "local-browser-click"
            | "local-browser-scroll"
            | "local-app-select"
            | "local-app-action"
            | "local-desktop-observe"
            | "local-desktop-action"
    )
}

pub(super) fn is_protected_secret_tool(tool: &str) -> bool {
    matches!(
        tool,
        "request-secret"
            | "secret-request-status"
            | "webhook-signing-install"
            | "webhook-signing-status"
            | "webhook-signing-verify"
            | "webhook-signing-remove"
    )
}

pub(super) fn validate_computer_approval_binding(
    request: &ToolExecutionRequest,
) -> Result<(), String> {
    let generation = require_computer_generation(request)?;
    let workspace_id = request
        .workspace_id
        .as_deref()
        .ok_or_else(|| "Computer approval requires its exact workspace.".to_string())?;
    let agent_id = request
        .agent_id
        .as_deref()
        .ok_or_else(|| "Computer approval requires its exact agent.".to_string())?;
    let expected = [
        format!("Computer workspace: {workspace_id}"),
        format!("Computer agent: {agent_id}"),
        format!("Computer generation: {generation}"),
    ];
    let mut argument_approval = request.approval.request.clone();
    if !argument_approval.data_used.ends_with(&expected) {
        return Err("Computer scope or control changed after this action was approved. Request a fresh approval.".into());
    }
    argument_approval
        .data_used
        .truncate(argument_approval.data_used.len() - expected.len());
    validate_tool_approval_binding(&request.tool, &request.arguments, &argument_approval)
    // verify_tool_authority consumes the original complete approval, retaining
    // these exact scope/generation fields in the native permit fingerprint.
}

/// Bind an approval to the exact registered tool policy and argument preview.
/// This prevents approving one path/command and substituting another at the
/// final Rust dispatch boundary.
pub(crate) fn validate_tool_approval_binding(
    tool: &str,
    arguments: &serde_json::Value,
    approval: &crate::models::ApprovalRequest,
) -> Result<(), String> {
    let (required_mode, required_risk) =
        tool_policy(tool).ok_or_else(|| format!("Tool {tool} has no execution policy."))?;
    if approval.mode != required_mode || approval.risk_level != required_risk {
        return Err(format!(
            "Tool {tool} approval does not match its required permission policy."
        ));
    }
    let effect = crate::permission_policy::effect_for_tool(tool)
        .ok_or_else(|| format!("Tool {tool} has no permission effect."))?;
    crate::permission_policy::ensure_permission_allowed(
        &approval.mode,
        None,
        effect,
        &approval.risk_level,
    )?;
    if approval.action.split_whitespace().next() != Some(tool) {
        return Err(format!(
            "Tool {tool} approval is bound to a different action."
        ));
    }
    let expected = approval_argument_previews(tool, arguments)?;
    let mut approved = approval
        .data_used
        .iter()
        .map(|value| truncate_characters(&normalize_spaces(value), 240))
        .collect::<std::collections::BTreeSet<_>>();
    if tool_requires_argument_digest(tool) {
        let digest_entries = approved
            .iter()
            .filter(|value| value.starts_with(ARGUMENT_DIGEST_PREFIX))
            .cloned()
            .collect::<Vec<_>>();
        let expected_digest = argument_digest(arguments)?;
        if digest_entries.as_slice() != [expected_digest] {
            return Err(format!(
                "Tool {tool} arguments changed after the approval preview."
            ));
        }
        approved.remove(&digest_entries[0]);
    }
    if expected != approved {
        return Err(format!(
            "Tool {tool} arguments changed after the approval preview."
        ));
    }
    Ok(())
}

/// Tools whose approval must bind the complete argument object. Small
/// human-readable previews remain useful for display, but repository,
/// command, browser and secret operations also carry a canonical digest so a
/// long or nested payload cannot be substituted after approval.
pub(super) fn tool_requires_argument_digest(tool: &str) -> bool {
    matches!(
        tool,
        "create-spreadsheet"
            | "create-document"
            | "create-presentation"
            | "create-pdf"
            | "workspace-run"
            | "workspace-start"
            | "workspace-inspect"
            | "agent-create"
            | "agent-update"
            | "agent-delete"
            | "project-create"
            | "project-team-update"
    ) || tool.starts_with("repository-")
        || tool.starts_with("local-browser-")
        || tool.starts_with("command-")
        || is_protected_secret_tool(tool)
}

pub(super) fn approval_argument_previews(
    tool: &str,
    arguments: &serde_json::Value,
) -> Result<std::collections::BTreeSet<String>, String> {
    let object = arguments.as_object().ok_or_else(|| {
        format!("Tool {tool} arguments must be an object at the execution boundary.")
    })?;
    let mut entries = object.iter().collect::<Vec<_>>();
    entries.sort_unstable_by(|(left, _), (right, _)| left.encode_utf16().cmp(right.encode_utf16()));
    entries
        .into_iter()
        .take(16)
        .map(|(key, value)| {
            let raw_rendered = match value.as_str() {
                Some(text) => text.to_string(),
                None => canonical_json(value)?,
            };
            let rendered = if tool == "web-fetch" && key == "url" {
                normalize_url_for_fingerprint(&raw_rendered).unwrap_or(raw_rendered)
            } else if matches!(tool, "cloud-browser") && key == "url" {
                crate::hosted_computer::normalize_public_https_url(&raw_rendered)
                    .or_else(|_| crate::local_computer::normalize_user_navigation(&raw_rendered))
                    .unwrap_or(raw_rendered)
            } else {
                raw_rendered
            };
            Ok(truncate_characters(
                &normalize_spaces(&format!("{key}: {rendered}")),
                240,
            ))
        })
        .collect::<Result<std::collections::BTreeSet<_>, String>>()
}

pub(super) fn argument_digest(arguments: &serde_json::Value) -> Result<String, String> {
    Ok(format!(
        "{ARGUMENT_DIGEST_PREFIX}{}",
        hex::encode(Sha256::digest(canonical_json(arguments)?.as_bytes()))
    ))
}

/// Stable idempotency fingerprint for a native tool name and its parsed
/// arguments. The canonical JSON form makes equivalent whitespace/order
/// representations replay the same receipt while binding the registered tool.
pub(crate) fn tool_arguments_fingerprint(
    tool: &str,
    arguments: &serde_json::Value,
) -> Result<String, String> {
    let canonical = canonical_json(arguments)?;
    Ok(hex::encode(Sha256::digest(
        format!("{tool}:{canonical}").as_bytes(),
    )))
}

pub(super) fn canonical_json(value: &serde_json::Value) -> Result<String, String> {
    match value {
        serde_json::Value::Object(object) => {
            let mut keys = object.keys().collect::<Vec<_>>();
            // JSON.stringify enumerates index properties first, even after
            // canonicalValue inserts keys sorted by JavaScript UTF-16 order.
            let index = |key: &str| {
                key.parse::<u32>()
                    .ok()
                    .filter(|index| *index < u32::MAX && index.to_string() == key)
            };
            keys.sort_unstable_by(|left, right| match (index(left), index(right)) {
                (Some(left), Some(right)) => left.cmp(&right),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => left.encode_utf16().cmp(right.encode_utf16()),
            });
            let mut output = String::from("{");
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(
                    &serde_json::to_string(key)
                        .map_err(|_| "Tool arguments could not be canonicalized.".to_string())?,
                );
                output.push(':');
                output.push_str(&canonical_json(&object[key])?);
            }
            output.push('}');
            Ok(output)
        }
        serde_json::Value::Array(values) => {
            let values = values
                .iter()
                .map(canonical_json)
                .collect::<Result<Vec<_>, _>>()?;
            Ok(format!("[{}]", values.join(",")))
        }
        serde_json::Value::Number(number) => {
            // Never collapse distinct native integers into one JS fingerprint.
            if number
                .as_i64()
                .is_some_and(|value| value.unsigned_abs() > 9_007_199_254_740_991)
                || number
                    .as_u64()
                    .is_some_and(|value| value > 9_007_199_254_740_991)
            {
                return Err("Tool argument integer exceeds the exact JavaScript range.".into());
            }
            let value = number
                .as_f64()
                .filter(|value| value.is_finite())
                .ok_or("Invalid tool argument number.")?;
            Ok(ryu_js::Buffer::new().format(value).to_string())
        }
        _ => serde_json::to_string(value)
            .map_err(|_| "Tool arguments could not be canonicalized.".to_string()),
    }
}
