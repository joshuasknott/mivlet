//! Mivlet-owned tool execution boundary (Rust side).
//!
//! The TypeScript executor (see `@mivlet/connectors` `tool-executor.ts`) runs only
//! after the shell's permission gate allows it. This module is the defense-in-depth Rust
//! layer each tool call must still cross: it re-validates the approval, confines
//! file paths to the teammate's Mivlet-owned workspace, and performs the actual
//! side effects (read/write file, web-fetch). The shell NEVER spawns a process or writes files
//! from JavaScript — every consequential tool routes through these commands.
//!
//! Hard invariants:
//!   - Allowlisted native connector reads use scoped account consent, with exact
//!     argument/policy binding, without a redundant persisted user decision.
//!   - Consequential commands consume a native-minted one-time permit before
//!     the side effect. A WebView-synthesized `session`/`rule` decision is not
//!     authority. A `deny` (or missing/reshaped approval) fails closed with
//!     `approval-required` and performs nothing.
//!   - File paths are confined to the teammate's local-computer workspace (no
//!     `..` escapes or absolute escapes). Process tools execute only inside the
//!     agent's scoped isolated computer and never through the user's host shell.
//!   - Tool names are a closed set; anything else fails closed.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
mod approval_policy;
mod browser_actions;
mod files;
mod web_fetch;
#[cfg(test)]
use approval_policy::{argument_digest, canonical_json};
use approval_policy::{
    is_computer_tool, is_protected_secret_tool, require_computer_generation,
    routine_connector_read, validate_tool_name, verify_execution_permit, verify_tool_authority,
};
pub(crate) use approval_policy::{tool_policy, validate_tool_approval_binding};
pub(crate) use files::{
    bounded_output, run_read_file, run_write_file, MAX_TOOL_INPUT_BYTES, MAX_TOOL_OUTPUT_BYTES,
};
#[cfg(test)]
use web_fetch::format_web_page_source;
pub(crate) use web_fetch::run_web_fetch_egress;
#[cfg(test)]
pub(crate) use web_fetch::WEB_FETCH_MAX_READABLE_CHARACTERS;
pub(crate) use web_fetch::{
    is_forbidden_ip, is_unsafe_port, normalize_url_for_fingerprint, web_fetch_url_from_args,
};

use crate::approvals::resolve_approval;
use crate::connector_api;
use crate::models::{ApprovalResolutionRequest, ConnectorSearchRequest, APPROVAL_DECISIONS};
use crate::paths::{
    execution_approvals_path, harden_workspace_root, normalize_spaces, truncate_characters,
};

const ARGUMENT_DIGEST_PREFIX: &str = "Arguments SHA-256: ";

/// The workspace root tools operate within. The command layer resolves it from
/// the app handle (for API compat); hardened selection uses only cwd (fail-closed,
/// no app_data fallback). Pure harden fn is unit-testable with explicit input.
pub fn resolve_workspace_root(_app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let cwd = std::env::current_dir().map_err(|_| {
        "Mivlet could not determine current working directory for workspace root.".to_string()
    })?;
    harden_workspace_root(&cwd).map_err(|e| format!("Workspace root selection failed: {}", e))
}

/// The opaque request the TypeScript executor hands Rust for every tool call.
/// `approval` is the same resolution request the shell used to grant — Rust
/// re-validates it before running the tool (defense in depth).
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolExecutionRequest {
    pub tool: String,
    pub arguments: serde_json::Value,
    pub approval: ApprovalResolutionRequest,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
    /// Native generation observed before approval; never inferred at execution.
    #[serde(default)]
    pub computer_generation: Option<u64>,
    #[serde(default)]
    pub mcp_session_id: Option<String>,
    /// Retained for wire compatibility and pure helper tests. The Tauri command
    /// deliberately ignores it and resolves authority from the native app.
    #[allow(dead_code)]
    pub workspace_root: Option<String>,
}

/// The tool result returned to JavaScript: either a success payload string or an
/// error message the loop turns into a tool-role error message.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub ok: bool,
    pub output: String,
}

/// The closed set of tools Rust will execute. Anything else fails closed.
pub(crate) const SUPPORTED_TOOLS: [&str; 67] = [
    "repository-pr-read",
    "repository-pr-local",
    "repository-pr-action",
    "repository-pr-watch",
    "request-secret",
    "secret-request-status",
    "webhook-signing-install",
    "webhook-signing-status",
    "webhook-signing-verify",
    "webhook-signing-remove",
    "repository-start",
    "workspace-start",
    "command-jobs",
    "command-output",
    "command-stop",
    "command-input",
    "repository-checkpoint-list",
    "repository-checkpoint-capture",
    "repository-checkpoint-preview",
    "repository-checkpoint-restore",
    "repository-checkpoint-delete",
    "repository-recover",
    "repository-status",
    "repository-read",
    "repository-write",
    "repository-run",
    "workspace-run",
    "repository-commit",
    "repository-publish",
    "read-file",
    "write-file",
    "create-spreadsheet",
    "create-document",
    "create-presentation",
    "create-pdf",
    "run-shell",
    "web-fetch",
    "computer-artifact",
    "generate-image",
    "edit-image",
    "local-app-observe",
    "local-app-list",
    "local-browser-open",
    "local-browser-tabs",
    "local-browser-observe",
    "local-browser-navigate",
    "local-browser-activate",
    "local-browser-fill",
    "local-browser-download",
    "local-browser-upload-choices",
    "local-browser-upload",
    "local-browser-handover",
    "local-browser-click",
    "local-browser-scroll",
    "local-app-select",
    "local-app-action",
    "local-desktop-observe",
    "local-desktop-action",
    "connection-read",
    "github-read",
    "vercel-read",
    "linear-read",
    "google-drive-read",
    "gmail-read",
    "google-calendar-read",
    "search-notion",
    "search-slack",
];

/// The outcome of re-validating + running a tool against the workspace root.
///
/// `Done` covers the pure, synchronous tools (read-file/write-file/run-shell)
/// and every approval/validation failure — those are fully decided by `execute_tool`
/// and unit-tested directly. `NeedsWebFetch` is the async-only escape hatch: the
/// url is validated up front (http(s) required), but the reqwest GET is deferred
/// to the async Tauri command so the pure helper stays sync + testable (mirroring
/// the streaming backend path in `native_api.rs`).
#[derive(Debug)]
pub(crate) enum ToolOutcome {
    /// The tool is fully resolved — a ready ToolResult or a fail-closed error.
    Done(Result<ToolResult, String>),
    /// A granted web-fetch that needs the async command to issue the GET.
    NeedsWebFetch { url: String },
    NeedsConnectorRead {
        request: crate::models::ConnectorCapabilityRequest,
    },
    NeedsSemanticRead {
        workspace_id: String,
        capability_id: String,
        input: std::collections::BTreeMap<String, serde_json::Value>,
        cursor: Option<String>,
        mcp_session_id: Option<String>,
    },
    /// An authenticated, read-only Google Workspace request owned by Rust.
    NeedsGoogleRead {
        tool: String,
        arguments: serde_json::Value,
    },
}

/// Re-validate the approval and run the tool against the workspace root. Pure
/// over the explicit root so it is unit-testable; the command wrapper resolves
/// the root from the app handle and delegates here. The fs/shell tools resolve
/// synchronously (`Done`); web-fetch is validated up front and deferred to the
/// async command (`NeedsWebFetch`) so the helper stays sync + unit-testable.
#[allow(dead_code)] // pure sync entry point exercised by the tools unit tests
pub(crate) fn execute_tool(
    request: ToolExecutionRequest,
    workspace_root: &Path,
) -> Result<ToolResult, String> {
    match execute_tool_outcome(request, workspace_root) {
        ToolOutcome::Done(result) => result,
        // A granted web-fetch must reach the async command; if a caller invokes
        // the pure helper directly (e.g. a future in-process caller), surface a
        // clear contract error instead of silently dropping the GET.
        ToolOutcome::NeedsWebFetch { .. } => {
            Err("web-fetch must be executed through the async command boundary.".to_string())
        }
        ToolOutcome::NeedsConnectorRead { .. } | ToolOutcome::NeedsSemanticRead { .. } => {
            Err("connector reads must be executed through the async command boundary.".to_string())
        }
        ToolOutcome::NeedsGoogleRead { .. } => {
            Err("Google reads must be executed through the async command boundary.".to_string())
        }
    }
}

/// The pure dispatch core. Re-validates the approval + tool name, then runs the
/// fs/shell tools synchronously and validates + defers web-fetch to the command.
/// Kept separate from `execute_tool` so the command can observe `NeedsWebFetch`
/// and perform the reqwest GET itself (the pure helper never opens a socket).
pub(crate) fn execute_tool_outcome(
    request: ToolExecutionRequest,
    workspace_root: &Path,
) -> ToolOutcome {
    if let Err(error) = validate_tool_name(&request.tool) {
        return ToolOutcome::Done(Err(error));
    }

    // Capture the dispatch keys before the approval is moved into resolve_approval.
    let tool = request.tool.clone();
    let arguments = request.arguments.clone();
    let workspace_id = request.workspace_id.clone();
    let mcp_session_id = request.mcp_session_id.clone();

    // Defense in depth: re-check the WebView-supplied resolution shape. This
    // does not mint a permit. Authority is the persisted record consumed by
    // `verify_tool_authority` before this dispatch.
    let resolution = match resolve_approval(request.approval) {
        Ok(resolution) => resolution,
        Err(err) => {
            return ToolOutcome::Done(Err(format!(
                "Tool {tool} was not approved by Mivlet's approval layer: {err}"
            )));
        }
    };
    if resolution.audit_entry.decision == "deny" {
        return ToolOutcome::Done(Ok(ToolResult {
            ok: false,
            output: format!("Tool {tool} was denied."),
        }));
    }

    match tool.as_str() {
        "read-file" => ToolOutcome::Done(run_read_file(&arguments, workspace_root)),
        "write-file" => ToolOutcome::Done(run_write_file(&arguments, workspace_root)),
        "create-spreadsheet" | "create-document" | "create-presentation" | "create-pdf" => {
            ToolOutcome::Done(Err(
                "Document authoring requires the scoped native workspace boundary.".into(),
            ))
        }
        "workspace-run" => ToolOutcome::Done(Err(
            "Workspace execution requires the scoped isolated-computer boundary.".into(),
        )),
        "run-shell" => ToolOutcome::Done(Err(
            "Terminal commands require the asynchronous isolated-computer boundary.".into(),
        )),
        "web-fetch" => match web_fetch_url_from_args(&arguments) {
            Ok(url) => ToolOutcome::NeedsWebFetch { url },
            Err(error) => ToolOutcome::Done(Err(error)),
        },
        "connection-read" => match semantic_request_from_args(&arguments) {
            Ok((capability_id, input, cursor)) => match workspace_id {
                Some(workspace_id) => ToolOutcome::NeedsSemanticRead {
                    workspace_id,
                    capability_id,
                    input,
                    cursor,
                    mcp_session_id,
                },
                None => ToolOutcome::Done(Err(
                    "Semantic Connection reads require the active workspace scope.".into(),
                )),
            },
            Err(error) => ToolOutcome::Done(Err(error)),
        },
        "github-read" | "vercel-read" | "linear-read" => {
            let connector_id = tool.trim_end_matches("-read");
            match connector_request_from_args(connector_id, &arguments) {
                Ok(request) => ToolOutcome::NeedsConnectorRead { request },
                Err(error) => ToolOutcome::Done(Err(error)),
            }
        }
        "google-drive-read" | "gmail-read" | "google-calendar-read" => {
            ToolOutcome::NeedsGoogleRead { tool, arguments }
        }
        "search-notion" | "search-slack" => ToolOutcome::Done(Err(
            "connector searches must be executed through the async command boundary.".to_string(),
        )),
        "generate-image" | "edit-image" => ToolOutcome::Done(Err(
            "Image tools must be executed through the async native media boundary.".to_string(),
        )),
        other => ToolOutcome::Done(Err(format!("Tool {other} is not supported."))),
    }
}

/// Confine a relative path under the workspace root. Rejects `..` escapes and
/// absolute paths so a tool call can never reach outside the workspace.
/// Enhanced with post-canonical containment check (when target exists) using
/// the hardened canonical root so symlink/junction escapes are also rejected.
pub fn confine_path(raw: &str, workspace_root: &Path) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("A non-empty path argument is required.".to_string());
    }
    let candidate = Path::new(trimmed);
    if candidate.is_absolute() {
        return Err("Absolute paths are not permitted; use a workspace-relative path.".to_string());
    }
    // Reject any component that escapes (parent dir, or a Windows drive prefix).
    for component in candidate.components() {
        use std::path::Component;
        match component {
            Component::Normal(_) | Component::CurDir => {}
            Component::ParentDir => {
                return Err("Parent-directory (..) escapes are not permitted.".to_string());
            }
            _ => {
                return Err("The path must be a simple workspace-relative path.".to_string());
            }
        }
    }
    let joined = workspace_root.join(candidate);

    // Hardened containment: require root itself canonicalizes cleanly, and if
    // the target exists, its canonical form must be under the root's canonical.
    // This catches symlink/junction escapes post-resolution.
    let canon_root = crate::paths::strict_canonicalize(workspace_root)
        .map_err(|e| format!("Workspace root failed canonical validation: {}", e))?;
    if crate::paths::contains_symlink(&joined) {
        return Err("Path contains a symlink or junction inside the workspace root.".to_string());
    }
    if joined.exists() {
        match std::fs::canonicalize(&joined) {
            Ok(canon_joined) => {
                if !canon_joined.starts_with(&canon_root) {
                    return Err("Path escapes the workspace root after canonicalization (possible symlink/junction traversal).".to_string());
                }
            }
            Err(_) => {
                // If canon of existing target fails, fail closed (do not allow).
                return Err("Could not canonicalize target path for containment check.".to_string());
            }
        }
    }
    Ok(joined)
}

fn require_string_argument(args: &serde_json::Value, key: &str) -> Result<String, String> {
    match args.get(key) {
        Some(serde_json::Value::String(value)) if !value.trim().is_empty() => Ok(value.clone()),
        _ => Err(format!(
            "Tool argument \"{key}\" must be a non-empty string."
        )),
    }
}

fn connector_request_from_args(
    connector_id: &str,
    arguments: &serde_json::Value,
) -> Result<crate::models::ConnectorCapabilityRequest, String> {
    let capability = require_string_argument(arguments, "capability")?;
    let input = arguments
        .get("input")
        .and_then(serde_json::Value::as_object)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .collect();
    let cursor = arguments
        .get("cursor")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    Ok(crate::models::ConnectorCapabilityRequest {
        connector_id: connector_id.to_string(),
        capability,
        input,
        cursor,
    })
}

fn semantic_request_from_args(
    arguments: &serde_json::Value,
) -> Result<
    (
        String,
        std::collections::BTreeMap<String, serde_json::Value>,
        Option<String>,
    ),
    String,
> {
    let capability_id = require_string_argument(arguments, "capability")?;
    let input = arguments
        .get("input")
        .and_then(serde_json::Value::as_object)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .collect();
    let cursor = arguments
        .get("cursor")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    Ok((capability_id, input, cursor))
}

// ---------------------------------------------------------------------------
// Tauri command wrappers.
// ---------------------------------------------------------------------------

/// Execute an approved tool call. Rust re-validates the approval, confines file
/// paths to the workspace, and performs the side effect. The shell already gated
/// the grant; this is the defense-in-depth boundary that actually runs the tool.
///
/// The command is `async` so web-fetch can issue its reqwest GET (mirroring the
/// streaming backend path in `native_api.rs`); the pure fs/shell helpers stay
/// sync and unit-testable via `execute_tool`/`execute_tool_outcome`.
#[tauri::command]
pub async fn execute_tool_call(
    app: tauri::AppHandle,
    request: ToolExecutionRequest,
    local_computers: tauri::State<'_, std::sync::Arc<crate::local_computer::LocalComputerState>>,
) -> Result<ToolResult, String> {
    let handoff = crate::background_worker::commands::foreground_fence(&request.tool)?;
    if crate::background_worker::commands::should_route(&request.tool)? {
        // The provider binding lives in this process. The worker independently
        // consumes the durable exact native permit before dispatch.
        crate::managed_runtime::check_managed_runtime_tool(
            request.approval.request.id.clone(),
            request.tool.clone(),
            request.arguments.clone(),
        )?;
        drop(handoff);
        return crate::background_worker::commands::execute(request).await;
    }
    let _handoff = handoff;
    execute_native_tool(app, request, local_computers, false).await
}

pub(crate) async fn execute_background_tool(
    app: tauri::AppHandle,
    request: ToolExecutionRequest,
    local_computers: tauri::State<'_, std::sync::Arc<crate::local_computer::LocalComputerState>>,
) -> Result<ToolResult, String> {
    if !crate::background_worker::is_worker()
        || !crate::background_worker::commands::supported(&request.tool)
    {
        return Err("Invalid native command handoff.".into());
    }
    execute_native_tool(app, request, local_computers, true).await
}

async fn execute_native_tool(
    app: tauri::AppHandle,
    request: ToolExecutionRequest,
    local_computers: tauri::State<'_, std::sync::Arc<crate::local_computer::LocalComputerState>>,
    provider_binding_checked: bool,
) -> Result<ToolResult, String> {
    let tool = request.tool.clone();
    let arguments = request.arguments.clone();
    let request_id = request.approval.request.id.clone();
    let decided_at = request.approval.decided_at.clone();
    let (mode, risk) = tool_policy(&tool).unwrap_or(("read-only", "low"));
    // Audit records the *attempt*; it observes the boundary and never grants
    // authority. Recording is best-effort and never blocks execution.
    audit_tool_attempt(
        &tool,
        &arguments,
        &request_id,
        mode,
        risk,
        &decided_at,
        None,
    );
    if let Err(error) = validate_tool_name(&tool) {
        audit_tool_outcome(
            ToolOutcomeAudit {
                tool: &tool,
                request_id: &request_id,
                mode,
                risk,
                status: "rejected",
                error_code: "unknown-tool",
                message: &error,
            },
            None,
        );
        return Err(error);
    }
    if let Err(error) = crate::execution_control::ensure_active_execution_allowed() {
        audit_tool_outcome(
            ToolOutcomeAudit {
                tool: &tool,
                request_id: &request_id,
                mode,
                risk,
                status: "blocked",
                error_code: "execution-paused",
                message: &error,
            },
            None,
        );
        return Err(error);
    }
    let authority = if provider_binding_checked {
        verify_execution_permit(&execution_approvals_path(&app)?, &request)
    } else {
        verify_tool_authority(&execution_approvals_path(&app)?, &request)
    };
    if let Err(error) = authority {
        audit_tool_outcome(
            ToolOutcomeAudit {
                tool: &tool,
                request_id: &request_id,
                mode,
                risk,
                status: "blocked",
                error_code: "approval-binding",
                message: &error,
            },
            None,
        );
        return Err(error);
    }
    if routine_connector_read(&tool) {
        // Match the requested workspace against native account authority before
        // the provider resolves its selected connection, credentials and scopes.
        crate::authorized_scope::command_scope(
            request.workspace_id.clone(),
            None,
            crate::authorized_scope::ScopeAccess::Read,
        )?;
    }
    let computer_generation = if is_computer_tool(&tool) {
        let generation = require_computer_generation(&request)?;
        local_computers.validate_target(
            request
                .workspace_id
                .as_deref()
                .ok_or_else(|| "Computer tools require an active workspace.".to_string())?,
            request
                .agent_id
                .as_deref()
                .ok_or_else(|| "Computer tools require a saved agent.".to_string())?,
        )?;
        generation
    } else {
        0
    };
    if is_protected_secret_tool(&tool) {
        let workspace = request
            .workspace_id
            .clone()
            .ok_or("Protected requests require a workspace.")?;
        let agent = request
            .agent_id
            .clone()
            .ok_or("Protected requests require a saved agent.")?;
        let computers = local_computers.inner().clone();
        let output = tauri::async_runtime::spawn_blocking(move || {
            crate::protected_secrets::execute(
                &computers,
                &workspace,
                &agent,
                computer_generation,
                &request_id,
                &tool,
                arguments,
            )
        })
        .await
        .map_err(|_| {
            "Protected operation interrupted. Inspect status; do not replay the reference."
        })??;
        return Ok(ToolResult {
            ok: true,
            output: output.to_string(),
        });
    }
    if tool.starts_with("repository-")
        || tool.starts_with("command-")
        || matches!(tool.as_str(), "workspace-run" | "workspace-start")
    {
        let workspace = request
            .workspace_id
            .clone()
            .ok_or("Code tools require a workspace.")?;
        let agent = request
            .agent_id
            .clone()
            .ok_or("Code tools require a saved agent.")?;
        let computers = local_computers.inner().clone();
        let operation_tool = tool.clone();
        let operation_request = request_id.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            if operation_tool.starts_with("command-") {
                crate::local_computer::command_jobs::execute(
                    &computers,
                    &workspace,
                    &agent,
                    computer_generation,
                    &operation_tool,
                    arguments,
                )
            } else if operation_tool == "workspace-start" {
                crate::local_computer::workspace_execution::start(
                    &computers,
                    &workspace,
                    &agent,
                    computer_generation,
                    arguments,
                )
            } else if operation_tool == "workspace-run" {
                crate::local_computer::workspace_execution::execute(
                    &computers,
                    &workspace,
                    &agent,
                    computer_generation,
                    arguments,
                )
            } else {
                crate::local_computer::coding::execute(
                    &computers,
                    &workspace,
                    &agent,
                    computer_generation,
                    &operation_tool,
                    arguments,
                    &operation_request,
                )
            }
        })
        .await
        .map_err(|_| {
            "Code operation stopped unexpectedly. Inspect its outcome before retrying.".to_string()
        })
        .and_then(|result| result);
        audit_tool_outcome(
            ToolOutcomeAudit {
                tool: &tool,
                request_id: &request_id,
                mode,
                risk,
                status: if result.is_ok() { "ok" } else { "failed" },
                error_code: if result.is_ok() { "" } else { "code-operation" },
                message: "Code operation completed; inspect its receipt for command exit status",
            },
            None,
        );
        return result.map(|output| ToolResult { ok: true, output });
    }
    if matches!(tool.as_str(), "generate-image" | "edit-image") {
        let workspace_id = request
            .workspace_id
            .clone()
            .ok_or_else(|| "Image tools require an active workspace.".to_string())?;
        let agent_id = request
            .agent_id
            .clone()
            .ok_or_else(|| "Image tools require a saved agent.".to_string())?;
        let result = crate::media_images::execute_image_tool(
            &tool,
            arguments,
            local_computers.inner().clone(),
            workspace_id,
            agent_id,
            computer_generation,
        )
        .await
        .and_then(|artifact| {
            serde_json::to_string(&artifact)
                .map_err(|_| "The generated image artifact receipt is invalid.".to_string())
        });
        audit_tool_outcome(
            ToolOutcomeAudit {
                tool: &tool,
                request_id: &request_id,
                mode,
                risk,
                status: if result.is_ok() { "ok" } else { "failed" },
                error_code: if result.is_ok() {
                    ""
                } else {
                    "image-operation"
                },
                message: "Image operation completed",
            },
            None,
        );
        return result.map(|output| ToolResult { ok: true, output });
    }
    if matches!(
        tool.as_str(),
        "local-browser-tabs" | "local-browser-observe"
    ) {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Observation {
            tab_ref: String,
            origin: String,
        }
        let observation = if tool == "local-browser-observe" {
            let value: Observation = serde_json::from_value(arguments).map_err(|_| {
                "Use an exact tabRef and HTTP(S) origin from the current browser tab list."
            })?;
            if value.tab_ref.len() != 48
                || !value.tab_ref.bytes().all(|byte| byte.is_ascii_hexdigit())
                || value.origin.len() > 2048
            {
                return Err("Invalid browser tab reference or origin.".into());
            }
            Some(value)
        } else {
            if arguments != serde_json::json!({}) {
                return Err("Browser tab discovery takes no arguments.".into());
            }
            None
        };
        let workspace = request
            .workspace_id
            .clone()
            .ok_or("Browser reads require a workspace.")?;
        let agent = request
            .agent_id
            .clone()
            .ok_or("Browser reads require an agent.")?;
        let computers = local_computers.inner().clone();
        let output = tauri::async_runtime::spawn_blocking(move || {
            crate::local_computer::browser::read(
                &computers,
                &workspace,
                &agent,
                computer_generation,
                observation
                    .as_ref()
                    .map(|value| (value.tab_ref.as_str(), value.origin.as_str())),
            )
        })
        .await
        .map_err(|_| "The browser observation stopped unexpectedly.")??;
        return Ok(ToolResult { ok: true, output });
    }
    if tool == "local-browser-scroll" {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Scroll {
            scroll_ref: String,
            origin: String,
            direction: String,
        }
        let value: Scroll = serde_json::from_value(arguments).map_err(|_| "Invalid browser scroll: use the observed scrollRef, exact origin and up/down direction. No browser input was dispatched.")?;
        if value.scroll_ref.len() != 48
            || !value
                .scroll_ref
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            || value.origin.len() > 2048
            || !matches!(value.direction.as_str(), "up" | "down")
        {
            return Err("Invalid browser scroll scope. No browser input was dispatched.".into());
        }
        let workspace = request
            .workspace_id
            .clone()
            .ok_or("Browser input requires a workspace.")?;
        let agent = request
            .agent_id
            .clone()
            .ok_or("Browser input requires an agent.")?;
        let computers = local_computers.inner().clone();
        let output = tauri::async_runtime::spawn_blocking(move || {
            crate::local_computer::browser::scroll(
                &computers,
                &workspace,
                &agent,
                computer_generation,
                &value.scroll_ref,
                &value.origin,
                &value.direction,
            )
        })
        .await
        .map_err(|_| "Browser scroll outcome is uncertain. Do not replay it.")??;
        return Ok(ToolResult { ok: true, output });
    }
    if tool == "local-browser-click" {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Click {
            control_ref: String,
            origin: String,
            name: String,
        }
        let value: Click = serde_json::from_value(arguments).map_err(|_| "Invalid browser input: use the observed controlRef, exact origin and name. No browser input was dispatched.")?;
        if value.control_ref.len() != 48
            || !value
                .control_ref
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            || value.origin.len() > 2048
            || value.name.trim().is_empty()
            || value.name.chars().count() > 200
            || value.name.chars().any(char::is_control)
            || crate::secret_redaction::looks_secret(&value.name)
        {
            return Err("Invalid browser input scope. No browser input was dispatched.".into());
        }
        let workspace = request
            .workspace_id
            .clone()
            .ok_or("Browser input requires a workspace.")?;
        let agent = request
            .agent_id
            .clone()
            .ok_or("Browser input requires an agent.")?;
        let computers = local_computers.inner().clone();
        let output = tauri::async_runtime::spawn_blocking(move || {
            crate::local_computer::browser::click(
                &computers,
                &workspace,
                &agent,
                computer_generation,
                &value.control_ref,
                &value.origin,
                &value.name,
            )
        })
        .await
        .map_err(|_| "Browser click outcome is uncertain. Do not replay it.")??;
        return Ok(ToolResult { ok: true, output });
    }
    if browser_actions::supported(&tool) {
        return browser_actions::execute(
            &tool,
            arguments,
            local_computers.inner().clone(),
            request
                .workspace_id
                .clone()
                .ok_or("Browser actions require a workspace.")?,
            request
                .agent_id
                .clone()
                .ok_or("Browser actions require an agent.")?,
            computer_generation,
        )
        .await;
    }
    if tool == "local-browser-navigate" {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Navigation {
            navigation_ref: String,
            origin: String,
            url: String,
        }
        let value: Navigation = serde_json::from_value(arguments).map_err(|_| {
            "Use a current navigationRef, its exact source origin and an HTTP(S) destination URL."
        })?;
        if value.navigation_ref.len() != 48
            || !value
                .navigation_ref
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            || value.origin.len() > 2048
            || value.url.len() > 2048
        {
            return Err("Invalid browser navigation scope.".into());
        }
        let workspace = request
            .workspace_id
            .clone()
            .ok_or("Browser navigation requires a workspace.")?;
        let agent = request
            .agent_id
            .clone()
            .ok_or("Browser navigation requires an agent.")?;
        let computers = local_computers.inner().clone();
        let output = tauri::async_runtime::spawn_blocking(move || crate::local_computer::browser::navigate(&computers, &workspace, &agent, computer_generation, &value.navigation_ref, &value.origin, &value.url)).await.map_err(|_| "Browser navigation stopped unexpectedly. Its outcome may be uncertain; do not replay it.")??;
        return Ok(ToolResult { ok: true, output });
    }
    if tool == "local-browser-open" {
        if arguments != serde_json::json!({"deliveryMode":"foreground"}) {
            return Err("Opening a browser requires explicit deliveryMode foreground under the normal approval policy.".into());
        }
        let workspace = request
            .workspace_id
            .clone()
            .ok_or("Browser opening requires a workspace.")?;
        let agent = request
            .agent_id
            .clone()
            .ok_or("Browser opening requires an agent.")?;
        let computers = local_computers.inner().clone();
        let output = tauri::async_runtime::spawn_blocking(move || {
            crate::local_computer::browser::open(
                &computers,
                &workspace,
                &agent,
                computer_generation,
                &request_id,
            )
        })
        .await
        .map_err(|_| "The owned browser stopped unexpectedly.")??;
        return Ok(ToolResult { ok: true, output });
    }
    if matches!(tool.as_str(), "local-app-list" | "local-app-select") {
        let workspace = request
            .workspace_id
            .clone()
            .ok_or("Application tools require a workspace.")?;
        let agent = request
            .agent_id
            .clone()
            .ok_or("Application tools require an agent.")?;
        let computers = local_computers.inner().clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            if tool == "local-app-list" {
                if arguments != serde_json::json!({}) {
                    return Err("Application discovery takes no arguments.".into());
                }
                crate::local_computer::control::list_app_windows(
                    &computers,
                    &workspace,
                    &agent,
                    computer_generation,
                )
            } else {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct Selection {
                    window_id: String,
                    #[serde(default)]
                    delivery_mode: crate::local_computer::control::DeliveryMode,
                }
                let selection: Selection = serde_json::from_value(arguments)
                    .map_err(|_| "Select a windowId from the current application list.")?;
                let selected = crate::local_computer::control::select_app_window(
                    &computers,
                    &workspace,
                    &agent,
                    computer_generation,
                    &selection.window_id,
                    selection.delivery_mode,
                    &request_id,
                )?;
                serde_json::to_string(&selected)
                    .map_err(|_| "The application selection result is invalid.".into())
            }
        })
        .await
        .map_err(|_| "Application selection stopped unexpectedly.")?;
        return result.map(|output| ToolResult { ok: true, output });
    }
    if matches!(tool.as_str(), "local-app-observe" | "local-app-action") {
        let workspace_id = request
            .workspace_id
            .clone()
            .ok_or("Application tools require a workspace.")?;
        let agent_id = request
            .agent_id
            .clone()
            .ok_or("Application tools require an agent.")?;
        let action = if tool == "local-app-action" {
            Some(crate::local_computer::desktop_tools::parse_action(
                arguments.clone(),
                false,
            )?)
        } else {
            None
        };
        let computers = local_computers.inner().clone();
        crate::local_computer::desktop_tools::prepare(
            computers.clone(),
            &workspace_id,
            &agent_id,
            computer_generation,
        )
        .await?;
        let result = tauri::async_runtime::spawn_blocking(move || {
            if tool == "local-app-observe" {
                if arguments != serde_json::json!({}) {
                    return Err("Application observation takes no arguments.".into());
                }
                crate::local_computer::desktop_tools::observe_app(
                    &computers,
                    &workspace_id,
                    &agent_id,
                    computer_generation,
                )
            } else {
                crate::local_computer::desktop_tools::act(
                    &computers,
                    &workspace_id,
                    &agent_id,
                    computer_generation,
                    action.expect("application action was parsed before native preparation"),
                )
            }
        })
        .await
        .map_err(|_| "The application tool stopped unexpectedly.")?;
        return result.map(|output| ToolResult { ok: true, output });
    }
    if matches!(
        tool.as_str(),
        "local-desktop-observe" | "local-desktop-action"
    ) {
        let workspace_id = request
            .workspace_id
            .clone()
            .ok_or("Desktop tools require a workspace.")?;
        let agent_id = request
            .agent_id
            .clone()
            .ok_or("Desktop tools require an agent.")?;
        let action = if tool == "local-desktop-action" {
            Some(crate::local_computer::desktop_tools::parse_action(
                arguments.clone(),
                true,
            )?)
        } else {
            None
        };
        enum ImageClaim {
            Codex(crate::codex_app_server::DesktopToolClaim),
            Api(crate::native_api::computer::DesktopToolClaim),
        }
        let claim = if request_id.starts_with("api-visual-") {
            ImageClaim::Api(crate::native_api::computer::claim_desktop_tool(
                &request_id,
                &tool,
                &arguments,
                &workspace_id,
                &agent_id,
                computer_generation,
            )?)
        } else {
            ImageClaim::Codex(crate::codex_app_server::claim_desktop_tool(
                &request_id,
                &tool,
                &arguments,
                &workspace_id,
                &agent_id,
                computer_generation,
            )?)
        };
        let computers = local_computers.inner().clone();
        crate::local_computer::desktop_tools::prepare(
            computers.clone(),
            &workspace_id,
            &agent_id,
            computer_generation,
        )
        .await?;
        let result = tauri::async_runtime::spawn_blocking(move || {
            if tool == "local-desktop-observe" {
                if let ImageClaim::Api(claim) = &claim {
                    claim.check()?;
                }
                if arguments != serde_json::json!({}) {
                    return Err("Desktop observation takes no arguments.".into());
                }
                let capture = crate::local_computer::desktop_tools::observe(
                    &computers,
                    &workspace_id,
                    &agent_id,
                    computer_generation,
                )?;
                match claim {
                    ImageClaim::Codex(claim) => {
                        crate::codex_app_server::retain_desktop_capture(claim, capture)
                    }
                    ImageClaim::Api(claim) => {
                        crate::native_api::computer::retain_desktop_capture(claim, capture)
                    }
                }
            } else {
                if let ImageClaim::Api(claim) = &claim {
                    claim.check()?;
                }
                let result = crate::local_computer::desktop_tools::act(
                    &computers,
                    &workspace_id,
                    &agent_id,
                    computer_generation,
                    action.expect("desktop action was parsed before native preparation"),
                );
                if let ImageClaim::Api(claim) = &claim {
                    claim.check()?;
                }
                result
            }
        })
        .await
        .map_err(|_| "The desktop tool stopped unexpectedly.".to_string())?;
        return result.map(|output| ToolResult { ok: true, output });
    }
    if tool == "computer-artifact" {
        let workspace_id = request
            .workspace_id
            .clone()
            .ok_or_else(|| "Computer tools require an active workspace.".to_string())?;
        let agent_id = request
            .agent_id
            .clone()
            .ok_or_else(|| "Computer tools require a saved agent.".to_string())?;
        let computers = local_computers.inner().clone();
        let result = {
            let path = require_string_argument(&arguments, "path")?;
            let title = arguments
                .get("title")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned);
            tauri::async_runtime::spawn_blocking(move || {
                crate::local_computer::artifacts::publish_artifact(
                    &computers,
                    &workspace_id,
                    &agent_id,
                    computer_generation,
                    &path,
                    title.as_deref(),
                )
                .and_then(|result| {
                    serde_json::to_string(&result)
                        .map_err(|_| "The computer artifact receipt is invalid.".to_string())
                })
            })
            .await
            .map_err(|_| "The computer artifact task stopped unexpectedly.".to_string())?
        };
        audit_tool_outcome(
            ToolOutcomeAudit {
                tool: &tool,
                request_id: &request_id,
                mode,
                risk,
                status: if result.is_ok() { "ok" } else { "failed" },
                error_code: if result.is_ok() {
                    ""
                } else {
                    "computer-operation"
                },
                message: "Computer operation completed",
            },
            None,
        );
        return result.map(|output| ToolResult { ok: true, output });
    }
    if matches!(
        tool.as_str(),
        "create-spreadsheet" | "create-document" | "create-presentation" | "create-pdf"
    ) {
        let workspace_id = request
            .workspace_id
            .clone()
            .ok_or_else(|| "Document authoring requires an active workspace.".to_string())?;
        let agent_id = request
            .agent_id
            .clone()
            .ok_or_else(|| "Document authoring requires a saved agent.".to_string())?;
        let computers = local_computers.inner().clone();
        let operation_tool = tool.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            let ticket =
                computers.begin_agent_operation(&workspace_id, &agent_id, computer_generation)?;
            let root = computers.tool_workspace_root(&workspace_id, &agent_id)?;
            let prepared = crate::local_computer::office_authoring::prepare(
                &operation_tool,
                &arguments,
                &root,
            )?;
            ticket.commit(|| prepared.commit())
        })
        .await
        .map_err(|_| "The Document authoring task stopped unexpectedly.".to_string())?;
        audit_tool_outcome(
            ToolOutcomeAudit {
                tool: &tool,
                request_id: &request_id,
                mode,
                risk,
                status: if result.is_ok() { "ok" } else { "failed" },
                error_code: if result.is_ok() {
                    ""
                } else {
                    "office-authoring"
                },
                message: "Document authoring completed",
            },
            None,
        );
        return result;
    }
    if request.tool == "search-notion" || request.tool == "search-slack" {
        let connector_id = if request.tool == "search-notion" {
            "notion"
        } else {
            "slack"
        };
        let query = request
            .arguments
            .get("query")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string();
        let limit = request
            .arguments
            .get("limit")
            .and_then(serde_json::Value::as_u64)
            .map(|value| value.min(50) as usize);
        let cursor = request
            .arguments
            .get("cursor")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        let result = crate::collaboration_connectors::search(
            &app,
            ConnectorSearchRequest {
                connector_id: connector_id.to_string(),
                query,
                limit,
                cursor,
            },
        )
        .await
        .map_err(|error| {
            audit_tool_outcome(
                ToolOutcomeAudit {
                    tool: &tool,
                    request_id: &request_id,
                    mode,
                    risk,
                    status: "failed",
                    error_code: "connector",
                    message: &error.message,
                },
                None,
            );
            error.message
        })?;
        let output = serde_json::to_string(&result)
            .map_err(|_| "Mivlet could not encode connector results.".to_string())?;
        audit_tool_outcome(
            ToolOutcomeAudit {
                tool: &tool,
                request_id: &request_id,
                mode,
                risk,
                status: "ok",
                error_code: "",
                message: &format!("{tool} executed"),
            },
            None,
        );
        return Ok(ToolResult { ok: true, output });
    }
    // The caller may never select a filesystem path. File tools resolve an
    // opaque workspace/agent scope through the native local-computer state;
    // no browser profile, host path, or sibling teammate directory crosses IPC.
    let outcome = if matches!(tool.as_str(), "read-file" | "write-file") {
        let workspace_id = request
            .workspace_id
            .clone()
            .ok_or_else(|| "File tools require an active workspace.".to_string())?;
        let agent_id = request
            .agent_id
            .clone()
            .ok_or_else(|| "File tools require an active agent.".to_string())?;
        ToolOutcome::Done(local_computers.with_agent_files(
            &workspace_id,
            &agent_id,
            computer_generation,
            |root| match execute_tool_outcome(request, root) {
                ToolOutcome::Done(result) => result,
                _ => Err("The local file operation is unsupported.".into()),
            },
        ))
    } else {
        execute_tool_outcome(request, &resolve_workspace_root(&app)?)
    };
    let result = match outcome {
        ToolOutcome::Done(result) => result,
        ToolOutcome::NeedsWebFetch { url, .. } => run_web_fetch_egress(&url).await,
        ToolOutcome::NeedsConnectorRead { request } => {
            let result = connector_api::read_capability(&app, request)
                .await
                .map_err(|error| error.message)?;
            serde_json::to_string(&result)
                .map(|output| ToolResult { ok: true, output })
                .map_err(|_| "Mivlet could not encode the connector result.".to_string())
        }
        ToolOutcome::NeedsSemanticRead {
            workspace_id,
            capability_id,
            input,
            cursor,
            mcp_session_id,
        } => {
            let output = if let Some(session_id) = mcp_session_id {
                let continuation = crate::mcp_process::prepare_semantic_capability_call(
                    workspace_id,
                    session_id,
                    capability_id,
                    input,
                    cursor,
                )?;
                serde_json::to_string(&continuation)
            } else {
                let result = crate::capability_registry::read(
                    &app,
                    workspace_id,
                    None,
                    capability_id,
                    input,
                    cursor,
                )
                .await
                .map_err(|error| error.message)?;
                serde_json::to_string(&result)
            };
            output
                .map(|output| ToolResult { ok: true, output })
                .map_err(|_| "Mivlet could not encode the capability result.".to_string())
        }
        ToolOutcome::NeedsGoogleRead { tool, arguments } => {
            crate::google::execute_read_tool(&app, &tool, &arguments)
                .await
                .map(|output| ToolResult { ok: true, output })
                .map_err(|error| error.message)
        }
    };
    match &result {
        Ok(tool_result) if tool_result.ok => {
            audit_tool_outcome(
                ToolOutcomeAudit {
                    tool: &tool,
                    request_id: &request_id,
                    mode,
                    risk,
                    status: "ok",
                    error_code: "",
                    message: &format!("{tool} executed"),
                },
                None,
            );
        }
        Ok(tool_result) => {
            audit_tool_outcome(
                ToolOutcomeAudit {
                    tool: &tool,
                    request_id: &request_id,
                    mode,
                    risk,
                    status: "failed",
                    error_code: "tool",
                    message: &tool_result.output,
                },
                None,
            );
        }
        Err(message) => {
            audit_tool_outcome(
                ToolOutcomeAudit {
                    tool: &tool,
                    request_id: &request_id,
                    mode,
                    risk,
                    status: "failed",
                    error_code: "tool",
                    message,
                },
                None,
            );
        }
    }
    result
}

/// Record a tool execution attempt (observation only, best-effort).
///
/// `store` threads an explicit store for the testable seam; passing `None`
/// routes through the process-global store (the production path).
pub(crate) fn audit_tool_attempt(
    tool: &str,
    arguments: &serde_json::Value,
    request_id: &str,
    mode: &str,
    risk: &str,
    decided_at: &str,
    store: Option<&crate::store::Store>,
) {
    let category = if tool == "web-fetch" {
        crate::action_history::categories::WEB_ACTION
    } else {
        crate::action_history::categories::TOOL_ACTION
    };
    let preview = preview_tool_arguments(tool, arguments);
    let recorder = crate::action_history::Recorder::new(category, "tool", tool, "attempted")
        .actor("system")
        .mode(mode)
        .risk(risk)
        .correlation(request_id)
        .summary(&format!("{tool} {preview}"))
        .detail(serde_json::json!({
            "tool": tool,
            "preview": preview,
            "decidedAt": decided_at,
        }));
    record_audit(recorder, store);
}

/// Inputs for recording a tool execution outcome. Bundled into a struct so the
/// recorder helper stays under clippy's argument-count limit.
pub(crate) struct ToolOutcomeAudit<'a> {
    pub tool: &'a str,
    pub request_id: &'a str,
    pub mode: &'a str,
    pub risk: &'a str,
    pub status: &'a str,
    pub error_code: &'a str,
    pub message: &'a str,
}

/// Record the final tool execution outcome (observation only, best-effort).
///
/// `store` threads an explicit store for the testable seam; passing `None`
/// routes through the process-global store (the production path).
pub(crate) fn audit_tool_outcome(audit: ToolOutcomeAudit<'_>, store: Option<&crate::store::Store>) {
    let category = if audit.tool == "web-fetch" {
        crate::action_history::categories::WEB_ACTION
    } else {
        crate::action_history::categories::TOOL_ACTION
    };
    let recorder = crate::action_history::Recorder::new(category, "tool", audit.tool, audit.status)
        .actor("system")
        .mode(audit.mode)
        .risk(audit.risk)
        .correlation(audit.request_id)
        .error(audit.error_code)
        .summary(&format!("{}: {}", audit.tool, audit.message));
    record_audit(recorder, store);
}

/// Dispatch a recorder to either the explicit store (testable seam) or the
/// process-global store (production path). Observation only, best-effort.
fn record_audit(recorder: crate::action_history::Recorder, store: Option<&crate::store::Store>) {
    match store {
        Some(store) => {
            recorder.record_into(store);
        }
        None => {
            recorder.record();
        }
    }
}

/// Build a short, non-secret preview of the tool arguments. Never returns raw
/// file content, env values, or command payloads beyond a bounded prefix.
fn preview_tool_arguments(tool: &str, arguments: &serde_json::Value) -> String {
    let pick = match tool {
        "read-file"
        | "write-file"
        | "create-spreadsheet"
        | "create-document"
        | "create-presentation"
        | "create-pdf" => "path",
        "run-shell" | "workspace-run" => "command",
        "web-fetch" => "url",
        "generate-image" | "edit-image" => "title",
        _ => "query",
    };
    let value = arguments
        .get(pick)
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    if value.is_empty() {
        return String::new();
    }
    // Bounded preview only; never the full content/command body.
    let bounded: String = value.chars().take(80).collect();
    bounded
}

/// Whether the resolution honors an approving decision (once/session/rule/modify).
/// Used only to clarify the deny invariant in tests; re-exported for clarity.
#[allow(dead_code)]
pub(crate) fn is_denied(decision: &str) -> bool {
    decision == "deny"
}

#[allow(dead_code)]
pub(crate) fn approving_decisions() -> &'static [&'static str] {
    &APPROVAL_DECISIONS[..APPROVAL_DECISIONS.len().saturating_sub(1)]
}

#[cfg(test)]
mod tests;
