//! Fable-owned tool execution boundary (Rust side).
//!
//! The TypeScript executor (see `@fable/connectors` `tool-executor.ts`) runs only
//! after the shell grants an approval. This module is the defense-in-depth Rust
//! layer each tool call must still cross: it re-validates the approval, confines
//! file paths to the workspace, and performs the actual side effects (read/write
//! file, run-shell, web-fetch). The shell NEVER spawns a process or writes files
//! from JavaScript — every consequential tool routes through these commands.
//!
//! Hard invariants:
//!   - Every command re-checks its own approval before the side effect. A granted
//!     `once`/`session`/`rule` decision is honored; a `deny` (or missing/reshaped
//!     approval) fails closed with `approval-required` and performs nothing.
//!   - File paths are confined to the workspace root (no `..` escapes, no absolute
//!     escapes). `run-shell` executes in the workspace root.
//!   - Tool names are a closed set; anything else fails closed.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::approvals::resolve_approval;
use crate::models::{ApprovalResolutionRequest, APPROVAL_DECISIONS};

/// The workspace root tools operate within. The command layer resolves it from
/// the app handle; the pure helpers below take an explicit root so they are
/// unit-testable without a live Tauri runtime.
pub(crate) fn resolve_workspace_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let cwd = std::env::current_dir()
        .or_else(|_| {
            app.path()
                .app_data_dir()
                .map_err(|_| "Fable could not resolve the workspace root.".to_string())
        })
        .map_err(|_| "Fable could not resolve the workspace root.".to_string())?;
    Ok(cwd)
}

/// The opaque request the TypeScript executor hands Rust for every tool call.
/// `approval` is the same resolution request the shell used to grant — Rust
/// re-validates it before running the tool (defense in depth).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolExecutionRequest {
    pub tool: String,
    pub arguments: serde_json::Value,
    pub approval: ApprovalResolutionRequest,
    pub workspace_root: Option<String>,
}

/// The tool result returned to JavaScript: either a success payload string or an
/// error message the loop turns into a tool-role error message.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub ok: bool,
    pub output: String,
}

/// The closed set of tools Rust will execute. Anything else fails closed.
pub(crate) const SUPPORTED_TOOLS: [&str; 4] = ["read-file", "write-file", "run-shell", "web-fetch"];

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

    // Defense in depth: re-resolve the approval exactly as the shell did. A deny
    // (or an invalid/reshaped approval) fails closed here too — never executes.
    let resolution = match resolve_approval(request.approval) {
        Ok(resolution) => resolution,
        Err(err) => {
            return ToolOutcome::Done(Err(format!(
                "Tool {tool} was not approved by Fable's approval layer: {err}"
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
        "run-shell" => ToolOutcome::Done(run_shell(&arguments, workspace_root)),
        "web-fetch" => match web_fetch_url_from_args(&arguments) {
            Ok(url) => ToolOutcome::NeedsWebFetch { url },
            Err(error) => ToolOutcome::Done(Err(error)),
        },
        other => ToolOutcome::Done(Err(format!("Tool {other} is not supported."))),
    }
}

/// Reject tool names outside the closed registry.
fn validate_tool_name(tool: &str) -> Result<(), String> {
    if SUPPORTED_TOOLS.contains(&tool) {
        Ok(())
    } else {
        Err(format!("Tool {tool} is not in Fable's tool registry."))
    }
}

/// Confine a relative path under the workspace root. Rejects `..` escapes and
/// absolute paths so a tool call can never reach outside the workspace.
pub(crate) fn confine_path(raw: &str, workspace_root: &Path) -> Result<PathBuf, String> {
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
    Ok(workspace_root.join(candidate))
}

fn require_string_argument(args: &serde_json::Value, key: &str) -> Result<String, String> {
    match args.get(key) {
        Some(serde_json::Value::String(value)) if !value.trim().is_empty() => Ok(value.clone()),
        _ => Err(format!(
            "Tool argument \"{key}\" must be a non-empty string."
        )),
    }
}

fn run_read_file(
    arguments: &serde_json::Value,
    workspace_root: &Path,
) -> Result<ToolResult, String> {
    let path = require_string_argument(arguments, "path")?;
    let confined = confine_path(&path, workspace_root)?;
    match std::fs::read_to_string(&confined) {
        Ok(content) => Ok(ToolResult {
            ok: true,
            output: content,
        }),
        Err(_) => Err(format!("File not found: {path}")),
    }
}

fn run_write_file(
    arguments: &serde_json::Value,
    workspace_root: &Path,
) -> Result<ToolResult, String> {
    let path = require_string_argument(arguments, "path")?;
    let content = require_string_argument(arguments, "content")?;
    let confined = confine_path(&path, workspace_root)?;
    if let Some(parent) = confined.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    std::fs::write(&confined, &content).map_err(|err| err.to_string())?;
    Ok(ToolResult {
        ok: true,
        output: format!("Wrote {} bytes to {path}.", content.len()),
    })
}

fn run_shell(arguments: &serde_json::Value, workspace_root: &Path) -> Result<ToolResult, String> {
    let command = require_string_argument(arguments, "command")?;
    if command.trim().is_empty() {
        return Err("Tool argument \"command\" must be a non-empty string.".to_string());
    }
    // Run via the platform shell in the workspace root. Output is captured.
    #[cfg(target_os = "windows")]
    let (program, flag) = ("cmd", "/C");
    #[cfg(not(target_os = "windows"))]
    let (program, flag) = ("sh", "-c");

    let output = std::process::Command::new(program)
        .arg(flag)
        .arg(&command)
        .current_dir(workspace_root)
        .output()
        .map_err(|err| err.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() {
        return Err(format!(
            "Shell command failed (exit code {}): {}",
            output.status.code().unwrap_or(-1),
            if stderr.trim().is_empty() {
                stdout.trim()
            } else {
                &stderr
            }
        ));
    }
    Ok(ToolResult {
        ok: true,
        output: stdout,
    })
}

/// The outcome shape the pure web-fetch layer returns to the async command.
/// Keeping it pure (no reqwest) lets the command compose it after the GET, and
/// lets tests pin the 2xx/non-2xx/transport contract without a live socket —
/// the same shape as the streaming backend path in `native_api.rs`.
#[derive(Debug)]
pub(crate) enum WebFetchOutcome {
    /// A successful fetch: the response body text (2xx only).
    Success { body: String },
    /// A completed request with a non-2xx status (fail closed: no phantom body).
    NonSuccess { status: u16 },
    /// The request never completed (DNS/TLS/connection failure, etc.).
    TransportError { message: String },
}

impl WebFetchOutcome {
    /// Build a success outcome from a 2xx status + body.
    pub(crate) fn success(_status: u16, body: String) -> Self {
        Self::Success { body }
    }

    /// Classify a response status: 2xx → success, else fail-closed non-success.
    pub(crate) fn status(status: u16) -> Self {
        if (200..300).contains(&status) {
            Self::Success {
                body: String::new(),
            }
        } else {
            Self::NonSuccess { status }
        }
    }

    /// Build a transport-error outcome from an error message.
    pub(crate) fn transport_error(message: &str) -> Self {
        Self::TransportError {
            message: message.to_string(),
        }
    }

    /// Turn a success outcome into a ToolResult (ok=true with the body).
    pub(crate) fn into_tool_result(self) -> ToolResult {
        match self {
            Self::Success { body } => ToolResult {
                ok: true,
                output: body,
            },
            // Non-2xx and transport failures are surfaced as a failure result so
            // the loop records a tool-role error message and continues.
            Self::NonSuccess { status } => ToolResult {
                ok: false,
                output: format!("web-fetch failed with status {status}."),
            },
            Self::TransportError { message } => ToolResult {
                ok: false,
                output: format!("web-fetch transport error: {message}"),
            },
        }
    }

    /// The failure output for a non-success/transport outcome (test helper).
    #[cfg(test)]
    pub(crate) fn into_tool_result_err(self) -> String {
        self.into_tool_result().output
    }
}

/// Validate and extract the web-fetch url argument. Requires a non-empty
/// `http://`/`https://` string and returns it; anything else fails closed
/// *before* any network egress (the scheme is defense-in-depth re-validated at
/// the boundary, mirroring today's approval + url re-check).
pub(crate) fn web_fetch_url_from_args(arguments: &serde_json::Value) -> Result<String, String> {
    let url = require_string_argument(arguments, "url")?;
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("web-fetch requires an http(s) URL.".to_string());
    }
    Ok(url)
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
) -> Result<ToolResult, String> {
    let root = match request.workspace_root.as_deref() {
        Some(explicit) => PathBuf::from(explicit),
        None => resolve_workspace_root(&app)?,
    };
    match execute_tool_outcome(request, &root) {
        ToolOutcome::Done(result) => result,
        ToolOutcome::NeedsWebFetch { url, .. } => run_web_fetch_egress(&url).await,
    }
}

/// Issue the approved web-fetch GET and classify the response into the pure
/// `WebFetchOutcome` shape. Network I/O itself is not unit-tested (matching the
/// streaming backend path); the 2xx/non-2xx/transport contract is pinned by the
/// `WebFetchOutcome` tests.
async fn run_web_fetch_egress(url: &str) -> Result<ToolResult, String> {
    // Defense in depth: re-validate the scheme at the boundary, immediately
    // before egress, so a reshaped request can never reach a non-http(s) URL.
    web_fetch_url_from_args(&serde_json::json!({ "url": url }))?;
    let client = reqwest::Client::new();
    let response = match client.get(url).send().await {
        Ok(response) => response,
        Err(err) => {
            return Ok(WebFetchOutcome::transport_error(&err.to_string()).into_tool_result());
        }
    };
    let status = response.status().as_u16();
    if !response.status().is_success() {
        return Ok(WebFetchOutcome::status(status).into_tool_result());
    }
    let body = response
        .text()
        .await
        .map_err(|err| format!("web-fetch could not read the response body: {err}"))?;
    Ok(WebFetchOutcome::success(status, body).into_tool_result())
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
