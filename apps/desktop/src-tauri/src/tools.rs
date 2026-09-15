//! Mivlet-owned tool execution boundary (Rust side).
//!
//! The TypeScript executor (see `@fable/connectors` `tool-executor.ts`) runs only
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
//!     agent's Docker/WSL computer and never through the user's host shell.
//!   - Tool names are a closed set; anything else fails closed.

use std::net::{IpAddr, Ipv6Addr};
use std::path::{Path, PathBuf};
use std::time::Duration;

use dom_smoothie::{Config as ReadabilityConfig, Readability, TextMode};
use reqwest::header::{HeaderMap, HeaderValue};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;

use crate::approvals::resolve_approval;
use crate::connector_api;
use crate::execution_approvals::verify_and_consume_execution_approval;
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
#[derive(Deserialize)]
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
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub ok: bool,
    pub output: String,
}

/// The closed set of tools Rust will execute. Anything else fails closed.
pub(crate) const SUPPORTED_TOOLS: [&str; 25] = [
    "read-file",
    "write-file",
    "create-spreadsheet",
    "create-document",
    "run-shell",
    "web-fetch",
    "computer-artifact",
    "generate-image",
    "edit-image",
    "local-app-observe",
    "local-app-list",
    "local-app-select",
    "local-app-action",
    "local-desktop-observe",
    "local-desktop-action",
    "connection-read",
    "github-read",
    "plugin-read",
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
        "create-spreadsheet" | "create-document" => ToolOutcome::Done(Err(
            "Office authoring requires the scoped native workspace boundary.".into(),
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
        "plugin-read" => {
            let connector_id = arguments
                .get("connectorId")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            if !crate::token_plugins::IDS.contains(&connector_id) {
                return ToolOutcome::Done(Err("This plugin is not registered.".into()));
            }
            match connector_request_from_args(connector_id, &arguments) {
                Ok(request) => ToolOutcome::NeedsConnectorRead { request },
                Err(error) => ToolOutcome::Done(Err(error)),
            }
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

/// Reject tool names outside the closed registry.
fn require_computer_generation(request: &ToolExecutionRequest) -> Result<u64, String> {
    request.computer_generation.filter(|generation| *generation > 0 && *generation <= 9_007_199_254_740_991)
        .ok_or_else(|| "Refresh this computer before requesting a tool action; its control generation is missing or invalid.".into())
}

fn validate_tool_name(tool: &str) -> Result<(), String> {
    if SUPPORTED_TOOLS.contains(&tool) {
        Ok(())
    } else {
        Err(format!("Tool {tool} is not in Mivlet's tool registry."))
    }
}

pub(crate) fn tool_policy(tool: &str) -> Option<(&'static str, &'static str)> {
    match tool {
        "read-file" => Some(("read-only", "low")),
        "write-file" => Some(("full-access", "high")),
        "create-spreadsheet" | "create-document" => Some(("full-access", "high")),
        "run-shell" => Some(("full-access", "critical")),
        "web-fetch" => Some(("read-only", "medium")),
        "local-app-list" => Some(("read-only", "low")),
        "local-app-select" => Some(("read-only", "medium")),
        "local-app-observe" | "local-desktop-observe" => Some(("read-only", "medium")),
        "local-app-action" | "local-desktop-action" => Some(("full-access", "critical")),
        "computer-artifact" => Some(("read-only", "low")),
        "generate-image" | "edit-image" => Some(("full-access", "high")),
        "cloud-browser" | "cloud-browser-action" => Some(("full-access", "critical")),
        "connection-read" | "github-read" | "vercel-read" | "linear-read" | "plugin-read" => {
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
fn routine_connector_read(tool: &str) -> bool {
    matches!(
        tool,
        "google-drive-read"
            | "gmail-read"
            | "google-calendar-read"
            | "github-read"
            | "plugin-read"
            | "vercel-read"
            | "linear-read"
            | "search-notion"
            | "search-slack"
    )
}

fn verify_tool_authority(path: &Path, request: &ToolExecutionRequest) -> Result<(), String> {
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

fn is_computer_tool(tool: &str) -> bool {
    matches!(
        tool,
        "run-shell"
            | "read-file"
            | "write-file"
            | "create-spreadsheet"
            | "create-document"
            | "computer-artifact"
            | "generate-image"
            | "edit-image"
            | "local-app-observe"
            | "local-app-list"
            | "local-app-select"
            | "local-app-action"
            | "local-desktop-observe"
            | "local-desktop-action"
    )
}

fn validate_computer_approval_binding(request: &ToolExecutionRequest) -> Result<(), String> {
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
    if matches!(tool, "create-spreadsheet" | "create-document") {
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

fn approval_argument_previews(
    tool: &str,
    arguments: &serde_json::Value,
) -> Result<std::collections::BTreeSet<String>, String> {
    let object = arguments.as_object().ok_or_else(|| {
        format!("Tool {tool} arguments must be an object at the execution boundary.")
    })?;
    Ok(object
        .iter()
        .take(16)
        .map(|(key, value)| {
            let raw_rendered = value
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| value.to_string());
            let rendered = if tool == "web-fetch" && key == "url" {
                normalize_url_for_fingerprint(&raw_rendered).unwrap_or(raw_rendered)
            } else if matches!(tool, "cloud-browser") && key == "url" {
                crate::hosted_computer::normalize_public_https_url(&raw_rendered)
                    .or_else(|_| crate::local_computer::normalize_user_navigation(&raw_rendered))
                    .unwrap_or(raw_rendered)
            } else {
                raw_rendered
            };
            truncate_characters(&normalize_spaces(&format!("{key}: {rendered}")), 240)
        })
        .collect::<std::collections::BTreeSet<_>>())
}

fn argument_digest(arguments: &serde_json::Value) -> Result<String, String> {
    Ok(format!(
        "{ARGUMENT_DIGEST_PREFIX}{}",
        hex::encode(Sha256::digest(canonical_json(arguments)?.as_bytes()))
    ))
}

fn canonical_json(value: &serde_json::Value) -> Result<String, String> {
    match value {
        serde_json::Value::Object(object) => {
            let mut keys = object.keys().collect::<Vec<_>>();
            keys.sort_unstable();
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
        _ => serde_json::to_string(value)
            .map_err(|_| "Tool arguments could not be canonicalized.".to_string()),
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

/// Maximum bytes returned by `read-file` / `run-shell` stdout. Larger output
/// is truncated with an explicit marker so a caller can never mistake a partial
/// result for a complete one (mirrors native_api's MAX_STREAM_RESPONSE_BYTES
/// philosophy, sized for tool output). 1 MiB is generous for source files and
/// bounded enough to prevent runaway-buffer OOM.
pub(crate) const MAX_TOOL_OUTPUT_BYTES: usize = 1024 * 1024;

/// Maximum bytes accepted by `write-file` content. Bounds the on-disk write so
/// a tool call cannot exhaust workspace storage in a single call.
pub(crate) const MAX_TOOL_INPUT_BYTES: usize = 8 * 1024 * 1024;

/// Truncate a byte buffer to `max_bytes`, appending a clear truncation marker so
/// a partial result is never silently treated as complete. Returns the marker
/// text appended to the (possibly-truncated) lossy-UTF-8 string.
pub(crate) fn bounded_output(bytes: &[u8], max_bytes: usize) -> String {
    if bytes.len() <= max_bytes {
        return String::from_utf8_lossy(bytes).into_owned();
    }
    let head = &bytes[..max_bytes];
    format!(
        "{}\n\n[truncated: output exceeded {} bytes]",
        String::from_utf8_lossy(head),
        max_bytes
    )
}

// ---------------------------------------------------------------------------
// web-fetch SSRF / outbound policy (fail-closed). All checks before or at
// egress; approval fingerprint binds the *normalized* URL; redirects and DNS
// are re-validated on every hop.
// ---------------------------------------------------------------------------

/// Max redirects followed for web-fetch (explicit, small to bound).
pub(crate) const WEB_FETCH_MAX_REDIRECTS: usize = 5;

/// Max wall time for an entire web-fetch including redirects/DNS.
pub(crate) const WEB_FETCH_TIMEOUT_SECS: u64 = 30;

/// Max body bytes (decompressed) returned/copied for web-fetch. Matches other
/// tool output bounds to avoid OOM or unbounded buffers.
pub(crate) const WEB_FETCH_MAX_BODY_BYTES: usize = MAX_TOOL_OUTPUT_BYTES;

/// Leave room for source metadata and the agent loop's truncation marker.
pub(crate) const WEB_FETCH_MAX_READABLE_CHARACTERS: usize = 56_000;

/// Return a canonical fingerprint form for a web-fetch URL (strips default
/// ports and credentials). Used so approval binds the normalized request.
pub(crate) fn normalize_url_for_fingerprint(raw: &str) -> Option<String> {
    let mut url = Url::parse(raw).ok()?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return None;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    if let Some(port) = url.port() {
        if (url.scheme() == "http" && port == 80) || (url.scheme() == "https" && port == 443) {
            let _ = url.set_port(None);
        }
    }
    Some(url.to_string())
}

/// Parse + basic structural validation for a web-fetch target (scheme, creds,
/// host presence, port policy, hostname aliases, IP-literal blocks). Does not
/// perform DNS (see resolve_and_check_host for domain hostname DNS results).
pub(crate) fn parse_and_validate_fetch_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|e| format!("web-fetch requires a valid URL: {}", e))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("web-fetch requires an http(s) URL.".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("web-fetch does not allow embedded credentials.".to_string());
    }
    if url.host().is_none() {
        return Err("web-fetch requires a host.".to_string());
    }
    if let Some(port) = url.port() {
        if is_unsafe_port(port) {
            return Err("web-fetch to an unsafe port is not permitted.".to_string());
        }
    }
    // Hostname validation (localhost aliases) at parse for early fail-closed
    // and pure-test coverage. Complements IP-literal checks + DNS result
    // validation in resolve_and_check_host (every hop / redirect).
    if let Some(h) = url.host_str() {
        if is_forbidden_hostname(h) {
            return Err(
                "web-fetch blocked: target is a loopback, private, reserved, link-local, multicast, unspecified, or cloud-metadata address.".to_string(),
            );
        }
    }
    // IP literals are checked at parse time (covers alt encodings because the
    // Url parser + Host::Ipv* yields the semantic address).
    if let Some(host) = url.host() {
        match host {
            url::Host::Ipv4(ip) => {
                if is_forbidden_ip(IpAddr::V4(ip)) {
                    return Err(
                        "web-fetch blocked: target is a loopback, private, reserved, link-local, multicast, unspecified, or cloud-metadata address.".to_string(),
                    );
                }
            }
            url::Host::Ipv6(ip) => {
                if is_forbidden_ip(IpAddr::V6(ip)) {
                    return Err(
                        "web-fetch blocked: target is a loopback, private, reserved, link-local, multicast, unspecified, or cloud-metadata address.".to_string(),
                    );
                }
            }
            url::Host::Domain(_) => {}
        }
    }
    Ok(url)
}

pub(crate) fn is_unsafe_port(port: u16) -> bool {
    // Common unsafe/internal ports (ssh, smtp, smb, dbs, etc.). Standard web
    // ports and developer ports are intentionally not listed here.
    matches!(
        port,
        22 | 23
            | 25
            | 53
            | 110
            | 135
            | 139
            | 143
            | 445
            | 465
            | 587
            | 993
            | 995
            | 1433
            | 1521
            | 2049
            | 2379
            | 3306
            | 3389
            | 5432
            | 5672
            | 6379
            | 7001
            | 8001
            | 8081
            | 8444
            | 9001
    )
}

/// Returns true for IPs that must never be reachable via web-fetch (fail-closed
/// SSRF policy). Covers IPv4/IPv6 loopback, private, reserved (TEST-NET,
/// benchmark, IETF etc.), link-local, multicast, unspecified, plus common
/// cloud instance metadata endpoints.
pub(crate) fn is_forbidden_ip(ip: IpAddr) -> bool {
    if is_cloud_metadata_ip(ip) {
        return true;
    }
    match ip {
        IpAddr::V4(v4) => {
            v4.is_unspecified()
                || v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_multicast()
                || v4.is_broadcast()
                || v4.octets()[0] >= 240
                || is_reserved_v4(v4)
        }
        IpAddr::V6(v6) => {
            v6.is_unspecified()
                || v6.is_loopback()
                || is_ipv6_link_local(&v6)
                || is_ipv6_unique_local(&v6)
                || v6.is_multicast()
                || v6
                    .to_ipv4_mapped()
                    .is_some_and(|v4| is_forbidden_ip(IpAddr::V4(v4)))
        }
    }
}

fn is_cloud_metadata_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            // AWS, GCP, Azure, DigitalOcean, etc.
            o == [169, 254, 169, 254]
                // Alibaba Cloud
                || o == [100, 100, 100, 200]
                // packet metadata sometimes on 169.254.169.254
                || (o[0] == 169 && o[1] == 254 && o[2] == 169)
        }
        IpAddr::V6(_) => false,
    }
}

/// Additional reserved ranges per IANA (not covered by is_private / link_local etc.).
/// Includes TEST-NET-* documentation ranges and benchmark. Called from
/// is_forbidden_ip to satisfy objective "reserved".
fn is_reserved_v4(v4: std::net::Ipv4Addr) -> bool {
    let o = v4.octets();
    // TEST-NET-1 (RFC 5737)
    (o[0] == 192 && o[1] == 0 && o[2] == 2)
        // TEST-NET-2
        || (o[0] == 198 && o[1] == 51 && o[2] == 100)
        // TEST-NET-3
        || (o[0] == 203 && o[1] == 0 && o[2] == 113)
        // Benchmarking (198.18.0.0/15, RFC 2544)
        || (o[0] == 198 && (o[1] == 18 || o[1] == 19))
        // IETF protocol assignments (192.0.0.0/24)
        || (o[0] == 192 && o[1] == 0 && o[2] == 0)
}

fn is_ipv6_link_local(v6: &Ipv6Addr) -> bool {
    let s = v6.segments();
    (s[0] & 0xffc0) == 0xfe80
}

fn is_ipv6_unique_local(v6: &Ipv6Addr) -> bool {
    let s = v6.segments();
    (s[0] & 0xfe00) == 0xfc00
}

/// Hostname-level blocks for well-known localhost / loopback aliases.
/// Called from parse_and_validate_fetch_url (before DNS) so that pure unit
/// tests can exercise "localhost aliases" rejections without network, and
/// to satisfy fail-closed hostname validation in the objective.
fn is_forbidden_hostname(host: &str) -> bool {
    let h = host.to_ascii_lowercase();
    h == "localhost"
        || h == "local"
        || h == "localhost.localdomain"
        || h == "ip6-localhost"
        || h == "ip6-loopback"
        || h.ends_with(".localhost")
        || h.ends_with(".local")
}

async fn resolve_and_check_host(
    host: &str,
    port: u16,
) -> Result<Vec<std::net::SocketAddr>, String> {
    // Resolve once, reject the whole answer if any address is forbidden, then
    // pin this exact answer set into reqwest. Checking DNS and subsequently
    // allowing the HTTP client to resolve again would leave a rebinding race.
    let addrs = tokio::net::lookup_host((host, port))
        .await
        .map_err(|_| "DNS resolution failed for web-fetch target".to_string())?
        .collect::<Vec<_>>();
    if addrs.is_empty() {
        return Err("DNS resolution returned no addresses for web-fetch target".to_string());
    }
    for sa in &addrs {
        if is_forbidden_ip(sa.ip()) {
            return Err(
                "web-fetch blocked: target resolves to a loopback, private, reserved, link-local, multicast, unspecified, or cloud-metadata address (DNS rebinding protection).".to_string(),
            );
        }
    }
    Ok(addrs)
}

/// Read a response incrementally with a hard cap. `Response::bytes()` would
/// materialize an untrusted body before checking its length.
async fn read_bounded_text(
    mut response: reqwest::Response,
    max_bytes: usize,
) -> Result<String, String> {
    if let Some(len) = response.content_length() {
        if len > max_bytes as u64 {
            return Err("web-fetch blocked: response body too large".to_string());
        }
    }
    let mut bytes =
        Vec::with_capacity(response.content_length().unwrap_or(0).min(max_bytes as u64) as usize);
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("web-fetch body read error: {}", e))?
    {
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Err("web-fetch blocked: response body too large".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

pub(crate) fn is_supported_response_type(content_type: &str) -> bool {
    if content_type.trim().is_empty() {
        return true; // unspecified; try as text
    }
    let t = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if t.starts_with("image/")
        || t.starts_with("audio/")
        || t.starts_with("video/")
        || t == "application/octet-stream"
        || t == "application/pdf"
        || t == "application/zip"
    {
        return false;
    }
    true
}

fn redact_for_error(raw: &str) -> String {
    // Never echo full target URLs or credentials in error surfaces that may
    // be returned to the agent loop / history.
    if raw.contains("://") || raw.contains('@') {
        "connection or policy error".to_string()
    } else {
        // keep short actionable without secrets
        raw.chars().take(120).collect()
    }
}

pub(crate) fn run_read_file(
    arguments: &serde_json::Value,
    workspace_root: &Path,
) -> Result<ToolResult, String> {
    let path = require_string_argument(arguments, "path")?;
    let confined = confine_path(&path, workspace_root)?;
    // Read raw bytes and bound the result so a very large file cannot OOM the
    // process. Reading one extra byte lets us detect truncation precisely.
    let mut file = std::fs::File::open(&confined).map_err(|_| format!("File not found: {path}"))?;
    let mut buf = Vec::new();
    std::io::Read::read_to_end(
        &mut std::io::Read::take(&mut file, (MAX_TOOL_OUTPUT_BYTES + 1) as u64),
        &mut buf,
    )
    .map_err(|err| err.to_string())?;
    Ok(ToolResult {
        ok: true,
        output: bounded_output(&buf, MAX_TOOL_OUTPUT_BYTES),
    })
}

pub(crate) fn run_write_file(
    arguments: &serde_json::Value,
    workspace_root: &Path,
) -> Result<ToolResult, String> {
    let path = require_string_argument(arguments, "path")?;
    let content = require_string_argument(arguments, "content")?;
    // Bound the input before touching disk.
    if content.len() > MAX_TOOL_INPUT_BYTES {
        return Err(format!(
            "write-file content is too large ({} bytes; max {} bytes).",
            content.len(),
            MAX_TOOL_INPUT_BYTES
        ));
    }
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WebPageSourceResult {
    trust: &'static str,
    instruction_authority: &'static str,
    citation_id: String,
    title: String,
    final_uri: String,
    fetched_at: String,
    media_type: String,
    extraction: &'static str,
    truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    byline: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    site_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    published_time: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    modified_time: Option<String>,
    content: String,
}

fn bounded_readable_content(content: &str) -> (String, bool) {
    let mut chars = content.chars();
    let bounded: String = chars
        .by_ref()
        .take(WEB_FETCH_MAX_READABLE_CHARACTERS)
        .collect();
    (bounded, chars.next().is_some())
}

fn web_citation_id(final_uri: &str) -> String {
    let digest = Sha256::digest(final_uri.as_bytes());
    format!("web-{}", &hex::encode(digest)[..16])
}

/// Convert an HTTP response into a traceable, explicitly untrusted source
/// envelope before it enters model context. HTML is reduced to the main readable
/// article; text/JSON responses retain their original text representation.
fn format_web_page_source(
    body: &str,
    final_url: &Url,
    content_type: &str,
    fetched_at: &str,
) -> String {
    let mut citation_url = final_url.clone();
    citation_url.set_fragment(None);
    let final_uri = normalize_url_for_fingerprint(citation_url.as_str())
        .unwrap_or_else(|| citation_url.to_string());
    let media_type = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let is_html = matches!(media_type.as_str(), "text/html" | "application/xhtml+xml")
        || (media_type.is_empty() && body.trim_start().starts_with('<'));

    let mut title = final_url.host_str().unwrap_or("Web page").to_string();
    let mut byline = None;
    let mut site_name = None;
    let mut published_time = None;
    let mut modified_time = None;
    let mut extraction = "plain-text";
    let readable = if is_html {
        let config = ReadabilityConfig {
            text_mode: TextMode::Markdown,
            ..Default::default()
        };
        let parsed = Readability::new(body, Some(final_uri.as_str()), Some(config))
            .and_then(|mut readability| readability.parse());
        match parsed {
            Ok(article) if !article.text_content.trim().is_empty() => {
                if !article.title.trim().is_empty() {
                    title = article.title.trim().to_string();
                }
                byline = article.byline.filter(|value| !value.trim().is_empty());
                site_name = article.site_name.filter(|value| !value.trim().is_empty());
                published_time = article
                    .published_time
                    .filter(|value| !value.trim().is_empty());
                modified_time = article
                    .modified_time
                    .filter(|value| !value.trim().is_empty());
                extraction = "readability";
                article.text_content.to_string()
            }
            _ => body.to_string(),
        }
    } else {
        body.to_string()
    };
    let (content, truncated) = bounded_readable_content(readable.trim());
    let result = WebPageSourceResult {
        trust: "untrusted",
        instruction_authority: "none",
        citation_id: web_citation_id(&final_uri),
        title,
        final_uri,
        fetched_at: fetched_at.to_string(),
        media_type: if media_type.is_empty() {
            "text/plain".to_string()
        } else {
            media_type
        },
        extraction,
        truncated,
        byline,
        site_name,
        published_time,
        modified_time,
        content,
    };
    serde_json::to_string(&result)
        .unwrap_or_else(|_| "{\"trust\":\"untrusted\",\"instructionAuthority\":\"none\",\"content\":\"Mivlet could not encode the fetched page.\"}".to_string())
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
}

/// Validate and extract the web-fetch url argument. Requires a non-empty
/// http(s) string; stronger structural policy (no creds, no bad ports, IP
/// literal blocks for forbidden ranges) runs here for early fail-closed before
/// NeedsWebFetch decision. Full hostname DNS + redirect revalidation happens
/// at the async egress boundary.
pub(crate) fn web_fetch_url_from_args(arguments: &serde_json::Value) -> Result<String, String> {
    let url = require_string_argument(arguments, "url")?;
    // Syntax + creds + port + IP-literal policy (DNS for domains deferred).
    let _ = parse_and_validate_fetch_url(&url)?;
    Ok(url)
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
    if let Err(error) = verify_tool_authority(&execution_approvals_path(&app)?, &request) {
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
    if matches!(tool.as_str(), "create-spreadsheet" | "create-document") {
        let workspace_id = request
            .workspace_id
            .clone()
            .ok_or_else(|| "Office authoring requires an active workspace.".to_string())?;
        let agent_id = request
            .agent_id
            .clone()
            .ok_or_else(|| "Office authoring requires a saved agent.".to_string())?;
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
        .map_err(|_| "The Office authoring task stopped unexpectedly.".to_string())?;
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
                message: "Office authoring completed",
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
            let result = if crate::token_plugins::IDS.contains(&request.connector_id.as_str()) {
                crate::token_plugins::read(&app, request).await
            } else {
                connector_api::read_capability(&app, request).await
            }
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
        "read-file" | "write-file" | "create-spreadsheet" | "create-document" => "path",
        "run-shell" => "command",
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

/// Issue the approved web-fetch GET with full SSRF protection:
/// - revalidate normalized syntax (creds/malformed/non-http already rejected)
/// - DNS resolve + forbidden IP check for every hostname hop
/// - manual redirect following (none() policy) with re-validation + count limit
/// - timeout, bounded body (1 MiB), no decompression (identity encoding) to close abuse vector
/// - unsupported content types rejected
/// - all errors redacted (no raw target URLs leak into results/audit)
///
/// Cancellation is preserved via timeout + cooperative tokio points (agent run
/// can drop the future on cancel).
async fn run_web_fetch_egress(url: &str) -> Result<ToolResult, String> {
    // Re-validate (syntax/creds/port/ip-lit) immediately before egress.
    let initial =
        parse_and_validate_fetch_url(url).map_err(|e| format!("web-fetch blocked: {}", e))?;

    crate::ensure_rustls_provider();
    let mut default_headers = HeaderMap::new();
    default_headers.insert(
        reqwest::header::ACCEPT_ENCODING,
        HeaderValue::from_static("identity"),
    );
    let mut current = initial;
    let mut redirects = 0usize;

    // Overall timeout guard for the whole fetch incl. DNS/redirects.
    let fetch_fut = async {
        loop {
            // Re-check host for current hop (hostname DNS or IP literal).
            let mut client_builder = reqwest::Client::builder()
                .timeout(Duration::from_secs(WEB_FETCH_TIMEOUT_SECS))
                .user_agent("Fable/0.1 (web-fetch)")
                // Manual redirects ensure every destination gets a fresh
                // policy check and pinned DNS answer.
                .redirect(reqwest::redirect::Policy::none())
                .default_headers(default_headers.clone());
            if let Some(host) = current.host() {
                match host {
                    url::Host::Domain(d) => {
                        let port = current.port().unwrap_or_else(|| {
                            if current.scheme() == "https" {
                                443
                            } else {
                                80
                            }
                        });
                        let addrs = resolve_and_check_host(d, port).await?;
                        client_builder = client_builder.resolve_to_addrs(d, &addrs);
                    }
                    url::Host::Ipv4(ip) => {
                        if is_forbidden_ip(IpAddr::V4(ip)) {
                            return Err(
                                "web-fetch blocked: target is a loopback, private, reserved, link-local, multicast, unspecified, or cloud-metadata address.".to_string()
                            );
                        }
                    }
                    url::Host::Ipv6(ip) => {
                        if is_forbidden_ip(IpAddr::V6(ip)) {
                            return Err(
                                "web-fetch blocked: target is a loopback, private, reserved, link-local, multicast, unspecified, or cloud-metadata address.".to_string()
                            );
                        }
                    }
                }
            }
            if let Some(p) = current.port() {
                if is_unsafe_port(p) {
                    return Err("web-fetch blocked: unsafe port".to_string());
                }
            }

            let client = client_builder
                .build()
                .map_err(|_| "web-fetch client initialization failed".to_string())?;

            // Issue request with the validated DNS answer pinned into this
            // per-hop client (and with automatic redirects disabled).
            let resp_res = client.get(current.clone()).send().await;
            let resp = match resp_res {
                Ok(r) => r,
                Err(e) => {
                    return Err(format!(
                        "web-fetch transport error: {}",
                        redact_for_error(&e.to_string())
                    ));
                }
            };

            let status = resp.status().as_u16();
            if resp.status().is_redirection() {
                redirects += 1;
                if redirects > WEB_FETCH_MAX_REDIRECTS {
                    return Err("web-fetch blocked: excessive redirects".to_string());
                }
                let loc = match resp.headers().get(reqwest::header::LOCATION) {
                    Some(v) => match v.to_str() {
                        Ok(s) => s.to_string(),
                        Err(_) => return Err("web-fetch blocked: invalid redirect".to_string()),
                    },
                    None => return Ok(WebFetchOutcome::status(status).into_tool_result()),
                };
                let next = current
                    .join(&loc)
                    .map_err(|_| "web-fetch blocked: unresolvable redirect target".to_string())?;
                // Validate redirect target syntax/creds before following.
                let _ = parse_and_validate_fetch_url(next.as_str())
                    .map_err(|e| format!("web-fetch blocked by redirect: {}", e))?;
                if !next.username().is_empty() || next.password().is_some() {
                    return Err(
                        "web-fetch blocked: redirect target contains credentials".to_string()
                    );
                }
                current = next;
                continue;
            }

            if !resp.status().is_success() {
                return Ok(WebFetchOutcome::status(status).into_tool_result());
            }

            // Supported type?
            let ct = resp
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string();
            if !is_supported_response_type(&ct) {
                return Err("web-fetch blocked: unsupported response type".to_string());
            }

            // Bounded read (protects size + decomp expansion).
            let body = read_bounded_text(resp, WEB_FETCH_MAX_BODY_BYTES).await?;
            let fetched_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
            let source = format_web_page_source(&body, &current, &ct, &fetched_at);
            return Ok(WebFetchOutcome::success(status, source).into_tool_result());
        }
    };

    match tokio::time::timeout(Duration::from_secs(WEB_FETCH_TIMEOUT_SECS), fetch_fut).await {
        Ok(Ok(result)) => Ok(result),
        Ok(Err(msg)) => {
            Ok(WebFetchOutcome::transport_error(&redact_for_error(&msg)).into_tool_result())
        }
        Err(_) => Ok(WebFetchOutcome::transport_error("web-fetch timed out").into_tool_result()),
    }
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
mod connector_authority_tests {
    use super::*;
    use serde_json::json;

    fn request(tool: &str) -> ToolExecutionRequest {
        let (mode, risk) = tool_policy(tool).unwrap_or(("full-access", "critical"));
        let now = crate::execution_approvals::wall_clock_consumed_at();
        serde_json::from_value(json!({
            "tool": tool, "arguments": {"query": "test"}, "approval": {
                "decision": "once", "decidedAt": now, "request": {
                    "id": "connector-test", "service": "Mivlet", "action": tool,
                    "mode": mode, "riskLevel": risk, "dataUsed": ["query: test"],
                    "consequence": "Read data", "requestedAt": now, "decisions": ["once", "deny"]
                }
            }
        }))
        .unwrap()
    }

    fn persist_permit(path: &Path, request: &ToolExecutionRequest) {
        crate::execution_approvals::record_execution_decision(
            path,
            &crate::models::ApprovalResolutionResponse {
                persisted: true,
                audit_entry: crate::models::ApprovalAuditEntry {
                    id: format!("permit-{}", request.approval.request.id),
                    request_id: request.approval.request.id.clone(),
                    decision: request.approval.decision.clone(),
                    decided_at: request.approval.decided_at.clone(),
                    note: "approved".into(),
                },
                effective_request: request.approval.request.clone(),
                dismissed: true,
                grant: None,
            },
        )
        .unwrap();
    }

    fn decided_at_offset(seconds: i64) -> String {
        (chrono::Utc::now() + chrono::Duration::seconds(seconds))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }

    #[test]
    fn fetched_html_becomes_readable_traceable_untrusted_evidence() {
        let url = Url::parse("https://example.com/article?edition=uk#section").unwrap();
        let paragraph =
            "Mivlet keeps the useful article text and removes navigation noise. ".repeat(8);
        let html = format!(
            "<html><head><title>A useful page</title><meta name=\"author\" content=\"Ada Example\"></head><body><nav>Menu noise</nav><main><article><h1>A useful page</h1><p>{paragraph}</p></article></main><script>ignore_me()</script></body></html>"
        );

        let output = format_web_page_source(
            &html,
            &url,
            "text/html; charset=utf-8",
            "2026-09-07T12:00:00Z",
        );
        let source: serde_json::Value = serde_json::from_str(&output).unwrap();

        assert_eq!(source["trust"], "untrusted");
        assert_eq!(source["instructionAuthority"], "none");
        assert_eq!(source["title"], "A useful page");
        assert_eq!(source["finalUri"], "https://example.com/article?edition=uk");
        assert_eq!(source["fetchedAt"], "2026-09-07T12:00:00Z");
        assert_eq!(source["mediaType"], "text/html");
        assert_eq!(source["extraction"], "readability");
        assert!(source["citationId"]
            .as_str()
            .is_some_and(|id| id.starts_with("web-") && id.len() == 20));
        assert!(source["content"]
            .as_str()
            .unwrap()
            .contains("useful article text"));
        assert!(!source["content"].as_str().unwrap().contains("ignore_me"));
    }

    #[test]
    fn fetched_text_is_bounded_and_keeps_a_stable_source_identity() {
        let url = Url::parse("https://example.com/data.txt").unwrap();
        let body = "x".repeat(WEB_FETCH_MAX_READABLE_CHARACTERS + 12);
        let first = format_web_page_source(&body, &url, "text/plain", "2026-09-07T12:00:00Z");
        let second =
            format_web_page_source("different body", &url, "text/plain", "2026-09-07T12:01:00Z");
        let first: serde_json::Value = serde_json::from_str(&first).unwrap();
        let second: serde_json::Value = serde_json::from_str(&second).unwrap();

        assert_eq!(first["citationId"], second["citationId"]);
        assert_eq!(first["extraction"], "plain-text");
        assert_eq!(first["truncated"], true);
        assert_eq!(
            first["content"].as_str().unwrap().chars().count(),
            WEB_FETCH_MAX_READABLE_CHARACTERS
        );
    }

    #[test]
    fn computer_tools_require_an_explicit_representable_generation() {
        let mut request = request("run-shell");
        assert!(require_computer_generation(&request).is_err());
        request.computer_generation = Some(0);
        assert!(require_computer_generation(&request).is_err());
        request.computer_generation = Some(u64::MAX);
        assert!(require_computer_generation(&request).is_err());
        request.computer_generation = Some(42);
        assert_eq!(require_computer_generation(&request).unwrap(), 42);
        assert!(is_computer_tool("create-spreadsheet"));
        assert!(is_computer_tool("create-document"));
        assert!(is_computer_tool("generate-image"));
        assert!(is_computer_tool("edit-image"));
    }

    #[test]
    fn office_approval_binds_full_canonical_payload_beyond_the_bounded_preview() {
        let mut approved = request("create-document");
        let long_text = format!("{}original tail", "x".repeat(300));
        approved.arguments = json!({
            "path": "reports/summary.docx",
            "title": "Summary",
            "blocks": [{ "type": "paragraph", "text": long_text }]
        });
        let mut data_used = approval_argument_previews("create-document", &approved.arguments)
            .unwrap()
            .into_iter()
            .collect::<Vec<_>>();
        data_used.push(argument_digest(&approved.arguments).unwrap());
        approved.approval.request.data_used = data_used;

        validate_tool_approval_binding(
            "create-document",
            &approved.arguments,
            &approved.approval.request,
        )
        .unwrap();

        let original_previews =
            approval_argument_previews("create-document", &approved.arguments).unwrap();
        approved.arguments["blocks"][0]["text"] =
            json!(format!("{}substituted tail", "x".repeat(300)));
        assert_eq!(
            original_previews,
            approval_argument_previews("create-document", &approved.arguments).unwrap()
        );
        assert!(validate_tool_approval_binding(
            "create-document",
            &approved.arguments,
            &approved.approval.request,
        )
        .is_err());

        approved.arguments["blocks"][0]["text"] = json!("alpha beta");
        assert_eq!(
            argument_digest(&approved.arguments).unwrap(),
            "Arguments SHA-256: e579a996abaf540431f607ca6f2c8ed746867ec36cc698f58ba4fd728c6c44a4"
        );
        let whitespace_previews =
            approval_argument_previews("create-document", &approved.arguments).unwrap();
        approved.approval.request.data_used = whitespace_previews
            .iter()
            .cloned()
            .chain(std::iter::once(
                argument_digest(&approved.arguments).unwrap(),
            ))
            .collect();
        validate_tool_approval_binding(
            "create-document",
            &approved.arguments,
            &approved.approval.request,
        )
        .unwrap();
        approved.arguments["blocks"][0]["text"] = json!("alpha  beta");
        assert_eq!(
            whitespace_previews,
            approval_argument_previews("create-document", &approved.arguments).unwrap()
        );
        assert!(validate_tool_approval_binding(
            "create-document",
            &approved.arguments,
            &approved.approval.request,
        )
        .is_err());
    }

    #[test]
    fn image_tool_permit_binds_model_options_scope_and_is_single_use() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("approvals.json");
        let mut approved = request("generate-image");
        approved.arguments = json!({
            "prompt": "A quiet workspace",
            "model": "gpt-image-2",
            "size": "1024x1024",
            "quality": "medium",
            "title": "Workspace"
        });
        approved.workspace_id = Some("workspace-one".into());
        approved.agent_id = Some("agent-one".into());
        approved.computer_generation = Some(7);
        approved.approval.request.action = "generate-image exact request".into();
        approved.approval.request.data_used = vec![
            "model: gpt-image-2".into(),
            "prompt: A quiet workspace".into(),
            "quality: medium".into(),
            "size: 1024x1024".into(),
            "title: Workspace".into(),
            "Computer workspace: workspace-one".into(),
            "Computer agent: agent-one".into(),
            "Computer generation: 7".into(),
        ];
        let response = crate::models::ApprovalResolutionResponse {
            persisted: true,
            audit_entry: crate::models::ApprovalAuditEntry {
                id: "image-permit-test".into(),
                request_id: approved.approval.request.id.clone(),
                decision: "once".into(),
                decided_at: approved.approval.decided_at.clone(),
                note: "approved".into(),
            },
            effective_request: approved.approval.request.clone(),
            dismissed: true,
            grant: None,
        };
        crate::execution_approvals::record_execution_decision(&path, &response).unwrap();

        approved.arguments["model"] = json!("gpt-5");
        assert!(verify_tool_authority(&path, &approved).is_err());
        approved.arguments["model"] = json!("gpt-image-2");
        verify_tool_authority(&path, &approved).unwrap();
        assert!(verify_tool_authority(&path, &approved).is_err());
    }

    #[test]
    fn computer_approval_scope_and_generation_are_bound_to_the_original_single_use_permit() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("approvals.json");
        let mut approved = request("run-shell");
        approved.workspace_id = Some("workspace-one".into());
        approved.agent_id = Some("agent-one".into());
        approved.computer_generation = Some(4);
        approved.approval.request.data_used.extend([
            "Computer workspace: workspace-one".into(),
            "Computer agent: agent-one".into(),
            "Computer generation: 4".into(),
        ]);
        let response = crate::models::ApprovalResolutionResponse {
            persisted: true,
            audit_entry: crate::models::ApprovalAuditEntry {
                id: "computer-scope-test".into(),
                request_id: approved.approval.request.id.clone(),
                decision: "once".into(),
                decided_at: approved.approval.decided_at.clone(),
                note: "approved".into(),
            },
            effective_request: approved.approval.request.clone(),
            dismissed: true,
            grant: None,
        };
        crate::execution_approvals::record_execution_decision(&path, &response).unwrap();
        approved.agent_id = Some("agent-two".into());
        assert!(verify_tool_authority(&path, &approved).is_err());
        approved.agent_id = Some("agent-one".into());
        approved.workspace_id = Some("workspace-two".into());
        assert!(verify_tool_authority(&path, &approved).is_err());
        approved.workspace_id = Some("workspace-one".into());
        approved.computer_generation = Some(5);
        assert!(verify_tool_authority(&path, &approved).is_err());
        // Rewriting the matching suffix cannot rebind the saved native permit.
        *approved.approval.request.data_used.last_mut().unwrap() = "Computer generation: 5".into();
        assert!(verify_tool_authority(&path, &approved).is_err());
        approved.computer_generation = Some(4);
        *approved.approval.request.data_used.last_mut().unwrap() = "Computer generation: 4".into();
        verify_tool_authority(&path, &approved).unwrap();
        assert!(verify_tool_authority(&path, &approved).is_err());
    }

    #[test]
    fn native_connector_reads_do_not_require_a_persisted_user_prompt() {
        let path = std::env::temp_dir()
            .join(format!("fable-no-read-permits-{}", std::process::id()))
            .join("missing.json");
        for tool in [
            "gmail-read",
            "google-drive-read",
            "google-calendar-read",
            "github-read",
            "vercel-read",
            "linear-read",
            "search-notion",
            "search-slack",
        ] {
            verify_tool_authority(&path, &request(tool)).expect(tool);
        }
        assert!(
            !path.exists(),
            "Read consent must not fabricate a user decision record"
        );
        for tool in [
            "write-file",
            "run-shell",
            "connection-read",
            "web-fetch",
            "connector-call",
        ] {
            assert!(
                verify_tool_authority(&path, &request(tool)).is_err(),
                "{tool} must retain its permit boundary"
            );
        }
    }

    #[test]
    fn read_consent_rejects_changed_arguments_policy_and_denial() {
        let path = Path::new("unused-read-permit.json");
        let mut changed = request("gmail-read");
        changed.arguments = json!({"query": "different"});
        assert!(verify_tool_authority(path, &changed).is_err());
        let mut denied = request("gmail-read");
        denied.approval.decision = "deny".into();
        assert!(verify_tool_authority(path, &denied).is_err());
        let mut downgraded = request("gmail-read");
        downgraded.approval.request.risk_level = "low".into();
        assert!(verify_tool_authority(path, &downgraded).is_err());
    }

    #[test]
    fn tool_authority_rejects_stale_permits_against_wall_clock_consume_time() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("approvals.json");
        let mut approved = request("web-fetch");
        let decided_at =
            decided_at_offset(-(crate::execution_approvals::EXECUTION_APPROVAL_TTL_SECONDS + 1));
        approved.approval.decided_at = decided_at.clone();
        approved.approval.request.requested_at = decided_at;
        persist_permit(&path, &approved);
        let error = verify_tool_authority(&path, &approved)
            .expect_err("reusing decided_at as consumed_at would keep this permit inside the TTL");
        assert!(
            error.contains("stale"),
            "expected the freshness fence, got {error}"
        );
    }

    #[test]
    fn tool_authority_records_wall_clock_consume_time_not_decided_at() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("approvals.json");
        let mut approved = request("web-fetch");
        let decided_at = decided_at_offset(-30);
        approved.approval.decided_at = decided_at.clone();
        approved.approval.request.requested_at = decided_at.clone();
        persist_permit(&path, &approved);
        verify_tool_authority(&path, &approved).expect("permit within the TTL consumes");
        let records: Vec<serde_json::Value> =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let consumed = records[0]["consumedAt"]
            .as_str()
            .expect("consume must persist wall-clock time");
        assert_ne!(
            consumed, decided_at,
            "production consume must not reuse decided_at as consumed_at"
        );
    }

    #[test]
    fn webview_synthesized_once_without_a_native_permit_cannot_execute() {
        let path = std::env::temp_dir().join(format!(
            "fable-webview-mint-{}-{}",
            std::process::id(),
            "missing.json"
        ));
        let _ = std::fs::remove_file(&path);
        let mut forged = request("web-fetch");
        forged.approval.decision = "once".into();
        let error = verify_tool_authority(&path, &forged)
            .expect_err("WebView JSON is not a minted permit");
        assert!(
            error.contains("no persisted user approval"),
            "expected a missing native permit, got {error}"
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn standing_session_or_rule_decision_cannot_authorize_execution() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("approvals.json");
        for decision in ["session", "rule"] {
            let mut approved = request("web-fetch");
            approved.approval.decision = decision.into();
            persist_permit(&path, &approved);
            let error = verify_tool_authority(&path, &approved).expect_err(decision);
            assert!(
                error.contains("standing session/rule"),
                "expected standing-grant refusal, got {error}"
            );
            // The native permit must remain unconsumed so a later once-resolution
            // can still use the user decision recorded by resolve_approval_request.
            crate::execution_approvals::verify_and_consume_execution_approval(
                &path,
                &approved.approval.request,
                &crate::execution_approvals::wall_clock_consumed_at(),
            )
            .unwrap_or_else(|_| panic!("{decision} permit must remain consumable after refusal"));
        }
    }
}
