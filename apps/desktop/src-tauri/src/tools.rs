//! Fable-owned tool execution boundary (Rust side).
//!
//! The TypeScript executor (see `@fable/connectors` `tool-executor.ts`) runs only
//! after the shell grants an approval. This module is the defense-in-depth Rust
//! layer each tool call must still cross: it re-validates the approval, confines
//! file paths to the teammate's Fable-owned workspace, and performs the actual
//! side effects (read/write file, web-fetch). The shell NEVER spawns a process or writes files
//! from JavaScript — every consequential tool routes through these commands.
//!
//! Hard invariants:
//!   - Every command re-checks its own approval before the side effect. A granted
//!     `once`/`session`/`rule` decision is honored; a `deny` (or missing/reshaped
//!     approval) fails closed with `approval-required` and performs nothing.
//!   - File paths are confined to the teammate's local-computer workspace (no
//!     `..` escapes or absolute escapes). Host shell execution fails closed;
//!     process tools require an isolated computer backend.
//!   - Tool names are a closed set; anything else fails closed.

use std::net::{IpAddr, Ipv6Addr};
use std::path::{Path, PathBuf};
use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderValue};
use serde::{Deserialize, Serialize};
use url::Url;

use crate::approvals::resolve_approval;
use crate::connector_api;
use crate::execution_approvals::verify_and_consume_execution_approval;
use crate::models::{ApprovalResolutionRequest, ConnectorSearchRequest, APPROVAL_DECISIONS};
use crate::paths::{
    execution_approvals_path, harden_workspace_root, normalize_spaces, truncate_characters,
};

/// The workspace root tools operate within. The command layer resolves it from
/// the app handle (for API compat); hardened selection uses only cwd (fail-closed,
/// no app_data fallback). Pure harden fn is unit-testable with explicit input.
pub fn resolve_workspace_root(_app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let cwd = std::env::current_dir().map_err(|_| {
        "Fable could not determine current working directory for workspace root.".to_string()
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
    pub project_id: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub mcp_session_id: Option<String>,
    #[serde(default)]
    pub mission_worker_tool_execution:
        Option<crate::mission_workers::NativeWorkerToolExecutionBinding>,
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
pub(crate) const SUPPORTED_TOOLS: [&str; 16] = [
    "read-file",
    "write-file",
    "run-shell",
    "web-fetch",
    "local-browser",
    "local-browser-observe",
    "local-browser-action",
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
        project_id: Option<String>,
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
    let project_id = request.project_id.clone();
    let mcp_session_id = request.mcp_session_id.clone();

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
        "connection-read" => match semantic_request_from_args(&arguments) {
            Ok((capability_id, input, cursor)) => match workspace_id {
                Some(workspace_id) => ToolOutcome::NeedsSemanticRead {
                    workspace_id,
                    project_id,
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

fn tool_policy(tool: &str) -> Option<(&'static str, &'static str)> {
    match tool {
        "read-file" => Some(("read-only", "low")),
        "write-file" => Some(("full-access", "high")),
        "run-shell" => Some(("full-access", "critical")),
        "web-fetch" => Some(("read-only", "medium")),
        "local-browser" => Some(("full-access", "critical")),
        "local-browser-observe" => Some(("read-only", "medium")),
        "local-browser-action" => Some(("full-access", "critical")),
        "cloud-browser"
        | "cloud-browser-action"
        | "cloud-process-schedule"
        | "cloud-process-schedule-cancel"
        | "cloud-process-schedule-pause"
        | "cloud-process-schedule-resume"
        | "cloud-agent-routine"
        | "cloud-agent-routine-cancel"
        | "cloud-agent-routine-pause"
        | "cloud-agent-routine-resume" => Some(("full-access", "critical")),
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
    let object = arguments.as_object().ok_or_else(|| {
        format!("Tool {tool} arguments must be an object at the execution boundary.")
    })?;
    let expected = object
        .iter()
        .take(16)
        .map(|(key, value)| {
            let raw_rendered = value
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| value.to_string());
            let rendered = if tool == "web-fetch" && key == "url" {
                normalize_url_for_fingerprint(&raw_rendered).unwrap_or(raw_rendered)
            } else if matches!(tool, "cloud-browser" | "local-browser") && key == "url" {
                crate::hosted_computer::normalize_public_https_url(&raw_rendered)
                    .or_else(|_| crate::local_computer::normalize_user_navigation(&raw_rendered))
                    .unwrap_or(raw_rendered)
            } else {
                raw_rendered
            };
            truncate_characters(&normalize_spaces(&format!("{key}: {rendered}")), 240)
        })
        .collect::<std::collections::BTreeSet<_>>();
    let approved = approval
        .data_used
        .iter()
        .map(|value| truncate_characters(&normalize_spaces(value), 240))
        .collect::<std::collections::BTreeSet<_>>();
    if expected != approved {
        return Err(format!(
            "Tool {tool} arguments changed after the approval preview."
        ));
    }
    Ok(())
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

/// Drain a child stream to EOF while retaining at most `cap` bytes. Draining
/// beyond the retained prefix is required so a verbose child cannot block on a
/// full pipe. The caller passes `max + 1` so truncation remains detectable.
fn drain_stream(mut stream: impl std::io::Read, cap: usize) -> std::io::Result<Vec<u8>> {
    let mut retained = Vec::with_capacity(cap);
    let mut chunk = [0_u8; 16 * 1024];
    loop {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        let remaining = cap.saturating_sub(retained.len());
        if remaining > 0 {
            retained.extend_from_slice(&chunk[..read.min(remaining)]);
        }
    }
    Ok(retained)
}

pub(crate) fn run_shell(
    arguments: &serde_json::Value,
    workspace_root: &Path,
) -> Result<ToolResult, String> {
    let command = require_string_argument(arguments, "command")?;
    if command.trim().is_empty() {
        return Err("Tool argument \"command\" must be a non-empty string.".to_string());
    }
    // Run via the platform shell in the workspace root. Output is captured.
    #[cfg(target_os = "windows")]
    let (program, flag) = ("cmd", "/C");
    #[cfg(not(target_os = "windows"))]
    let (program, flag) = ("sh", "-c");

    let mut child = std::process::Command::new(program)
        .arg(flag)
        .arg(&command)
        .current_dir(workspace_root)
        // Pipe stdout/stderr so we can read them incrementally and bound them,
        // rather than buffering the entire output to completion in memory.
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|err| err.to_string())?;

    // Drain stdout and stderr concurrently while the child runs. Waiting before
    // draining can deadlock once either OS pipe buffer fills.
    let cap = MAX_TOOL_OUTPUT_BYTES + 1;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Shell stdout pipe was unavailable.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Shell stderr pipe was unavailable.".to_string())?;
    let stdout_reader = std::thread::spawn(move || drain_stream(stdout, cap));
    let stderr_reader = std::thread::spawn(move || drain_stream(stderr, cap));
    let status = child.wait().map_err(|err| err.to_string())?;
    let stdout_bytes = stdout_reader
        .join()
        .map_err(|_| "Shell stdout reader panicked.".to_string())?
        .map_err(|err| err.to_string())?;
    let stderr_bytes = stderr_reader
        .join()
        .map_err(|_| "Shell stderr reader panicked.".to_string())?
        .map_err(|err| err.to_string())?;

    let stdout = bounded_output(&stdout_bytes, MAX_TOOL_OUTPUT_BYTES);
    let stderr = bounded_output(&stderr_bytes, MAX_TOOL_OUTPUT_BYTES);
    if !status.success() {
        return Err(format!(
            "Shell command failed (exit code {}): {}",
            status.code().unwrap_or(-1),
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
    let mission_binding = request.mission_worker_tool_execution.clone();
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
    if let Err(error) = validate_tool_approval_binding(&tool, &arguments, &request.approval.request)
    {
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
    if tool == "run-shell" {
        let error = "Local terminal execution is off until an isolated container or VM backend is available. Set up the optional cloud computer to run commands safely.".to_string();
        audit_tool_outcome(
            ToolOutcomeAudit {
                tool: &tool,
                request_id: &request_id,
                mode,
                risk,
                status: "blocked",
                error_code: "isolation-unavailable",
                message: &error,
            },
            None,
        );
        return Err(error);
    }
    let mission_preflight = if tool == "connection-read" {
        if let Some(binding) = mission_binding.as_ref() {
            let (capability_id, input, _) = semantic_request_from_args(&arguments)?;
            let workspace_id = request.workspace_id.as_deref().ok_or_else(|| {
                "Mission connected-source search requires its workspace scope.".to_string()
            })?;
            Some(crate::mission_workers::preflight_native_connected_search(
                binding,
                &request_id,
                workspace_id,
                request.project_id.as_deref(),
                &capability_id,
                &input,
            )?)
        } else {
            None
        }
    } else if mission_binding.is_some() {
        return Err("Mission tool evidence currently supports only connection-read.".into());
    } else {
        None
    };
    if let Some(crate::mission_workers::NativeWorkerToolPreflight::AlreadyRecorded(result)) =
        mission_preflight.as_ref()
    {
        return serde_json::to_string(result)
            .map(|output| ToolResult { ok: true, output })
            .map_err(|_| "Fable could not encode the mission tool replay.".to_string());
    }
    if let Err(error) = verify_and_consume_execution_approval(
        &execution_approvals_path(&app)?,
        &request.approval.request,
        &decided_at,
    ) {
        audit_tool_outcome(
            ToolOutcomeAudit {
                tool: &tool,
                request_id: &request_id,
                mode,
                risk,
                status: "blocked",
                error_code: "permit",
                message: &error,
            },
            None,
        );
        return Err(error);
    }
    if tool == "local-browser" {
        let workspace_id = request
            .workspace_id
            .clone()
            .ok_or_else(|| "The local browser requires an active workspace.".to_string())?;
        let agent_id = request
            .agent_id
            .clone()
            .ok_or_else(|| "The local browser requires an active teammate.".to_string())?;
        let url = require_string_argument(&arguments, "url")?;
        let result = local_computers
            .inner()
            .clone()
            .navigate_for_agent(workspace_id, agent_id, url)
            .await
            .inspect_err(|error| {
                audit_tool_outcome(
                    ToolOutcomeAudit {
                        tool: &tool,
                        request_id: &request_id,
                        mode,
                        risk,
                        status: "failed",
                        error_code: "local-browser",
                        message: error,
                    },
                    None,
                );
            })?;
        let output = serde_json::to_string(&result)
            .map_err(|_| "Fable could not encode the local browser result.".to_string())?;
        audit_tool_outcome(
            ToolOutcomeAudit {
                tool: &tool,
                request_id: &request_id,
                mode,
                risk,
                status: "ok",
                error_code: "",
                message: "local-browser executed",
            },
            None,
        );
        return Ok(ToolResult { ok: true, output });
    }
    if tool == "local-browser-observe" {
        let workspace_id = request
            .workspace_id
            .clone()
            .ok_or_else(|| "Local browser observation requires an active workspace.".to_string())?;
        let agent_id = request
            .agent_id
            .clone()
            .ok_or_else(|| "Local browser observation requires an active teammate.".to_string())?;
        let result = local_computers
            .inner()
            .clone()
            .observe_for_agent(workspace_id, agent_id)
            .await
            .inspect_err(|error| {
                audit_tool_outcome(
                    ToolOutcomeAudit {
                        tool: &tool,
                        request_id: &request_id,
                        mode,
                        risk,
                        status: "failed",
                        error_code: "local-browser-observe",
                        message: error,
                    },
                    None,
                );
            })?;
        let output = serde_json::to_string(&result)
            .map_err(|_| "Fable could not encode the local browser observation.".to_string())?;
        audit_tool_outcome(
            ToolOutcomeAudit {
                tool: &tool,
                request_id: &request_id,
                mode,
                risk,
                status: "ok",
                error_code: "",
                message: "local-browser-observe executed",
            },
            None,
        );
        return Ok(ToolResult { ok: true, output });
    }
    if tool == "local-browser-action" {
        let workspace_id = request
            .workspace_id
            .clone()
            .ok_or_else(|| "Local browser actions require an active workspace.".to_string())?;
        let agent_id = request
            .agent_id
            .clone()
            .ok_or_else(|| "Local browser actions require an active teammate.".to_string())?;
        let action = require_string_argument(&arguments, "action")?;
        if !matches!(action.as_str(), "click" | "fill" | "press") {
            return Err("The local browser action must be click, fill, or press.".into());
        }
        let observation_id = require_string_argument(&arguments, "observationId")?;
        let element_ref = require_string_argument(&arguments, "elementRef")?;
        let control_role = require_string_argument(&arguments, "controlRole")?;
        let control_name = require_string_argument(&arguments, "controlName")?;
        let value = arguments
            .get("value")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        let key = arguments
            .get("key")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        let result = local_computers
            .inner()
            .clone()
            .act_for_agent(
                workspace_id,
                agent_id,
                observation_id,
                element_ref,
                control_role,
                control_name,
                action,
                value,
                key,
            )
            .await
            .inspect_err(|error| {
                audit_tool_outcome(
                    ToolOutcomeAudit {
                        tool: &tool,
                        request_id: &request_id,
                        mode,
                        risk,
                        status: "failed",
                        error_code: "local-browser-action",
                        message: error,
                    },
                    None,
                );
            })?;
        let output = serde_json::to_string(&result)
            .map_err(|_| "Fable could not encode the local browser action result.".to_string())?;
        audit_tool_outcome(
            ToolOutcomeAudit {
                tool: &tool,
                request_id: &request_id,
                mode,
                risk,
                status: "ok",
                error_code: "",
                message: "local-browser-action executed",
            },
            None,
        );
        return Ok(ToolResult { ok: true, output });
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
            .map_err(|_| "Fable could not encode connector results.".to_string())?;
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
    let root = if matches!(tool.as_str(), "read-file" | "write-file") {
        let workspace_id = request
            .workspace_id
            .as_deref()
            .ok_or_else(|| "File tools require an active workspace.".to_string())?;
        let agent_id = request
            .agent_id
            .as_deref()
            .ok_or_else(|| "File tools require an active teammate.".to_string())?;
        local_computers.tool_workspace_root(workspace_id, agent_id)?
    } else {
        // Non-file tools do not use this path, but the pure dispatcher retains
        // an explicit root for compatibility and unit testing.
        resolve_workspace_root(&app)?
    };
    let outcome = execute_tool_outcome(request, &root);
    let result = match outcome {
        ToolOutcome::Done(result) => result,
        ToolOutcome::NeedsWebFetch { url, .. } => run_web_fetch_egress(&url).await,
        ToolOutcome::NeedsConnectorRead { request } => {
            let result = connector_api::read_capability(&app, request)
                .await
                .map_err(|error| error.message)?;
            serde_json::to_string(&result)
                .map(|output| ToolResult { ok: true, output })
                .map_err(|_| "Fable could not encode the connector result.".to_string())
        }
        ToolOutcome::NeedsSemanticRead {
            workspace_id,
            project_id,
            capability_id,
            input,
            cursor,
            mcp_session_id,
        } => {
            let output = if let Some(session_id) = mcp_session_id {
                let continuation = match mission_preflight.as_ref() {
                    Some(crate::mission_workers::NativeWorkerToolPreflight::Execute(authority)) => {
                        crate::mcp_process::prepare_mission_semantic_capability_call(
                            workspace_id,
                            project_id,
                            session_id,
                            capability_id,
                            input,
                            cursor,
                            authority.clone(),
                        )?
                    }
                    _ => crate::mcp_process::prepare_semantic_capability_call(
                        workspace_id,
                        project_id,
                        session_id,
                        capability_id,
                        input,
                        cursor,
                    )?,
                };
                serde_json::to_string(&continuation)
            } else {
                let result = match mission_preflight.as_ref() {
                    Some(crate::mission_workers::NativeWorkerToolPreflight::Execute(authority)) => {
                        crate::capability_registry::read_with_exact_grant(
                            &app,
                            workspace_id,
                            project_id,
                            capability_id,
                            input,
                            cursor,
                            Some(authority.capability_grant_id()),
                        )
                        .await
                    }
                    _ => {
                        crate::capability_registry::read(
                            &app,
                            workspace_id,
                            project_id,
                            capability_id,
                            input,
                            cursor,
                        )
                        .await
                    }
                }
                .map_err(|error| error.message)?;
                if let Some(crate::mission_workers::NativeWorkerToolPreflight::Execute(authority)) =
                    mission_preflight.as_ref()
                {
                    let normalized = serde_json::to_value(&result).map_err(|_| {
                        "Fable could not encode the mission capability result.".to_string()
                    })?;
                    crate::mission_workers::settle_native_connected_search(
                        authority, normalized, "native",
                    )?;
                }
                serde_json::to_string(&result)
            };
            output
                .map(|output| ToolResult { ok: true, output })
                .map_err(|_| "Fable could not encode the capability result.".to_string())
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
        "read-file" | "write-file" => "path",
        "run-shell" => "command",
        "web-fetch" => "url",
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
            return Ok(WebFetchOutcome::success(status, body).into_tool_result());
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
