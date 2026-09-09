//! Loopback OAuth callback receiver.
//!
//! Desktop OAuth needs a real redirect URI the provider or auth broker can call
//! back. We bind an ephemeral
//! `http://127.0.0.1:{port}` listener, hand that exact URI to
//! `start_auth`, and then accept a bounded number of local connections until
//! the real callback arrives. The received callback URL is forwarded to
//! `complete_auth`, which already validates state, redirect match, and consumes
//! the one-use PKCE verifier before network egress.
//!
//! Nothing in this module ever sees the access token — `complete_auth` resolves
//! the token exchange inside the credential boundary.

use std::time::Duration;

use tauri::Emitter;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use url::Url;

use crate::connector_auth::{
    complete_auth, discard_pending_auth, start_auth, OAUTH_AUTHORIZATION_WINDOW_SECONDS,
};
use crate::models::{ConnectorAuthRequest, ConnectorAuthResult, ConnectorCommandError};

/// The window of time a loopback listener waits for the provider callback before
/// the in-flight authorization attempt is considered abandoned.
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(OAUTH_AUTHORIZATION_WINDOW_SECONDS);
const CALLBACK_READ_TIMEOUT: Duration = Duration::from_secs(10);

/// Bounded limits for the deterministic single-callback HTTP/1.x parser.
/// These reject DoS, smuggling, and oversized inputs while passing all
/// legitimate browser callbacks observed in the existing flow.
const MAX_REQUEST_LINE_BYTES: usize = 2048;
const MAX_HEADER_BYTES: usize = 4096;
const MAX_HEADERS: usize = 32;
const MAX_TOTAL_HEADER_BYTES: usize = 8192;
const MAX_CALLBACK_CONNECTIONS: usize = 8;

/// Event payload emitted on the `fable://connector/auth` channel when an
/// in-flight OAuth attempt resolves. The shell re-reads connector statuses on
/// `status: "connected"` or surfaces `message` for any other outcome.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectorAuthEvent {
    pub connector_id: String,
    pub status: String,
    pub message: String,
}

fn command_error(
    code: &str,
    connector_id: &str,
    message: &str,
    retryable: bool,
) -> ConnectorCommandError {
    ConnectorCommandError {
        code: code.to_string(),
        connector_id: connector_id.to_string(),
        message: message.to_string(),
        retryable,
        retry_after: None,
    }
}

/// Open the user's default browser to an authorization URL. Best-effort: if no
/// platform opener is available the returned URL still lets the user complete
/// the flow manually (the loopback receiver listens regardless).
pub(crate) fn open_browser(authorization_url: &str) {
    // `std::process::Command` keeps the OS process launcher entirely on the
    // Rust side; no shell interpolation of the (provider-built) URL occurs.
    #[cfg(target_os = "windows")]
    let opened = std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", authorization_url])
        .spawn()
        .is_ok();
    #[cfg(target_os = "macos")]
    let opened = std::process::Command::new("open")
        .arg(authorization_url)
        .spawn()
        .is_ok();
    #[cfg(all(unix, not(target_os = "macos")))]
    let opened = std::process::Command::new("xdg-open")
        .arg(authorization_url)
        .spawn()
        .is_ok();

    #[cfg(not(any(target_os = "windows", target_os = "macos", unix)))]
    let opened = false;

    let _ = opened;
}

/// Resolve the first loopback port bound by this listener. Used so the returned
/// redirect URI is exactly the one the provider will call.
fn bound_redirect(listener: &TcpListener) -> Result<String, ConnectorCommandError> {
    let port = listener
        .local_addr()
        .map_err(|_| {
            command_error(
                "unknown",
                "oauth",
                "Mivlet could not bind a loopback OAuth listener.",
                false,
            )
        })?
        .port();
    // Google's Desktop-app loopback flow documents the redirect as the bare
    // loopback origin. Keep the random port, but do not append an application
    // path: the exact value is reused during the authorization-code exchange.
    Ok(format!("http://127.0.0.1:{port}"))
}

fn is_hex_digit(b: u8) -> bool {
    b.is_ascii_hexdigit()
}

fn contains_control(s: &str) -> bool {
    s.bytes().any(|b| b < 0x20 || b == 0x7f)
}

fn is_http_token(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|b| {
            b.is_ascii_alphanumeric()
                || matches!(
                    b,
                    b'!' | b'#'
                        | b'$'
                        | b'%'
                        | b'&'
                        | b'\''
                        | b'*'
                        | b'+'
                        | b'-'
                        | b'.'
                        | b'^'
                        | b'_'
                        | b'`'
                        | b'|'
                        | b'~'
                )
        })
}

fn is_literal_loopback_host(value: &str) -> bool {
    let value = value.trim();
    if value == "127.0.0.1" || value == "[::1]" {
        return true;
    }
    value
        .strip_prefix("127.0.0.1:")
        .or_else(|| value.strip_prefix("[::1]:"))
        .is_some_and(|port| port.parse::<u16>().is_ok())
}

fn has_valid_percent_encoding(s: &str) -> bool {
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            if i + 2 >= b.len() || !is_hex_digit(b[i + 1]) || !is_hex_digit(b[i + 2]) {
                return false;
            }
            i += 3;
        } else {
            i += 1;
        }
    }
    true
}

fn contains_encoded_delimiter_or_control(s: &str) -> bool {
    let low = s.to_ascii_lowercase();
    low.contains("%00")
        || low.contains("%0a")
        || low.contains("%0d")
        || low.contains("%1b")
        || low.contains("%0c")
        || low.contains("%09")
}

fn looks_like_oauth_callback_request(request: &[u8]) -> bool {
    let line_end = request
        .windows(2)
        .position(|window| window == b"\r\n")
        .unwrap_or(request.len());
    let Ok(request_line) = std::str::from_utf8(&request[..line_end]) else {
        return false;
    };
    let mut parts = request_line.split_ascii_whitespace();
    let _method = parts.next();
    let Some(target) = parts.next() else {
        return false;
    };
    let target = target.to_ascii_lowercase();
    let callback_path = target.starts_with("/?")
        || target.starts_with("/callback?")
        || target.contains("://127.0.0.1") && target.contains("/?")
        || target.contains("://127.0.0.1") && target.contains("/callback?")
        || target.starts_with("127.0.0.1:") && target.contains("/?")
        || target.starts_with("127.0.0.1:") && target.contains("/callback?")
        || target.contains("://[::1]") && target.contains("/?")
        || target.contains("://[::1]") && target.contains("/callback?")
        || target.starts_with("[::1]:") && target.contains("/?")
        || target.starts_with("[::1]:") && target.contains("/callback?");
    callback_path
        && target.contains("state=")
        && (target.contains("code=") || target.contains("handoff=") || target.contains("error="))
}

#[derive(Debug)]
struct CallbackReadError {
    error: ConnectorCommandError,
    oauth_candidate: bool,
}

#[derive(Debug, PartialEq, Eq)]
enum CallbackTargetDisposition {
    OAuth(String),
    Ignore,
}

fn classify_callback_target(
    target: String,
) -> Result<CallbackTargetDisposition, ConnectorCommandError> {
    let callback = Url::parse(&format!("http://127.0.0.1{target}")).map_err(|_| {
        command_error(
            "invalid-request",
            "oauth",
            "OAuth callback target was invalid.",
            false,
        )
    })?;
    // The bare root is the provider-compliant Desktop-app redirect. Continue
    // accepting the historical path so an already-open flow fails safely and
    // existing broker callbacks are not broken during a development restart.
    if !matches!(callback.path(), "/" | "/callback") {
        return Ok(CallbackTargetDisposition::Ignore);
    }

    let mut state = None;
    let mut code = None;
    let mut handoff = None;
    let mut error = None;
    for (key, value) in callback.query_pairs() {
        match key.as_ref() {
            "state" => state = Some(value.into_owned()),
            "code" => code = Some(value.into_owned()),
            "handoff" => handoff = Some(value.into_owned()),
            "error" => error = Some(value.into_owned()),
            _ => {}
        }
    }

    let has_oauth_signal =
        state.is_some() || code.is_some() || handoff.is_some() || error.is_some();
    if !has_oauth_signal {
        // Browsers, security software, and link scanners may probe the registered
        // redirect before the provider returns. Keep listening for the real
        // callback rather than consuming the one-shot transaction.
        return Ok(CallbackTargetDisposition::Ignore);
    }
    if state.as_deref().is_none_or(str::is_empty) {
        return Err(command_error(
            "invalid-request",
            "oauth",
            "OAuth callback is missing state.",
            false,
        ));
    }
    let result_count =
        usize::from(code.is_some()) + usize::from(handoff.is_some()) + usize::from(error.is_some());
    if result_count == 0 {
        return Err(command_error(
            "invalid-request",
            "oauth",
            "OAuth callback is missing a code, handoff ticket, or provider error.",
            false,
        ));
    }
    if result_count > 1 {
        return Err(command_error(
            "invalid-request",
            "oauth",
            "OAuth callback contains conflicting result parameters.",
            false,
        ));
    }
    if code
        .as_deref()
        .or(handoff.as_deref())
        .or(error.as_deref())
        .is_none_or(str::is_empty)
    {
        return Err(command_error(
            "invalid-request",
            "oauth",
            "OAuth callback result was empty.",
            false,
        ));
    }

    Ok(CallbackTargetDisposition::OAuth(target))
}

fn authorization_state(authorization_url: &str) -> Option<String> {
    Url::parse(authorization_url)
        .ok()?
        .query_pairs()
        .find(|(key, _)| key == "state")
        .map(|(_, value)| value.into_owned())
        .filter(|value| !value.is_empty())
}

/// Pure, deterministic, bounded HTTP/1.x request parser for the loopback
/// OAuth callback. Accepts a single GET with either origin-form or a
/// proxy-compatible absolute-form target whose authority exactly matches the
/// literal loopback Host header. Rejects all attack cases enumerated in the
/// requirements using strict CRLF, size caps, and explicit
/// framing/encoding/duplicate checks. Returns a normalized origin-form target
/// so callback URL construction and complete_auth remain unchanged.
fn parse_callback_target(request: &[u8]) -> Result<String, ConnectorCommandError> {
    // Locate end of headers; reject partial/incomplete before any further work.
    let Some(header_end) = request.windows(4).position(|w| w == b"\r\n\r\n") else {
        return Err(command_error(
            "invalid-request",
            "oauth",
            "OAuth callback request was incomplete or malformed.",
            false,
        ));
    };
    if header_end > MAX_TOTAL_HEADER_BYTES {
        return Err(command_error(
            "invalid-request",
            "oauth",
            "OAuth callback request was too large.",
            false,
        ));
    }
    let header_section = &request[..header_end + 2];

    // Strict CRLF line extraction; bare CR or LF is CRLF confusion / smuggling.
    let mut lines: Vec<&str> = Vec::new();
    let mut start = 0usize;
    let mut idx = 0usize;
    while idx < header_section.len() {
        if idx + 1 < header_section.len()
            && header_section[idx] == b'\r'
            && header_section[idx + 1] == b'\n'
        {
            let line_bytes = &header_section[start..idx];
            let line = std::str::from_utf8(line_bytes).map_err(|_| {
                command_error(
                    "invalid-request",
                    "oauth",
                    "OAuth callback request was not valid UTF-8.",
                    false,
                )
            })?;
            lines.push(line);
            idx += 2;
            start = idx;
            continue;
        }
        if header_section[idx] == b'\r' || header_section[idx] == b'\n' {
            return Err(command_error(
                "invalid-request",
                "oauth",
                "OAuth callback used ambiguous line endings.",
                false,
            ));
        }
        idx += 1;
    }
    // header_end +2 + strict CRLF scan guarantees full consumption or early
    // ambiguous-line error. No dangling data possible here; remove prior
    // unreachable 'incomplete' branch (was dead + misleading).
    if lines.is_empty() {
        return Err(command_error(
            "invalid-request",
            "oauth",
            "OAuth callback request was malformed.",
            false,
        ));
    }

    // Request line: method SP target SP version
    let request_line = lines[0];
    if request_line.len() > MAX_REQUEST_LINE_BYTES {
        return Err(command_error(
            "invalid-request",
            "oauth",
            "OAuth callback request line was too long.",
            false,
        ));
    }
    if request_line.is_empty() {
        return Err(command_error(
            "invalid-request",
            "oauth",
            "OAuth callback request was malformed.",
            false,
        ));
    }
    // Require exactly two SP separators (reject tabs, extra ws, missing).
    if request_line.matches(' ').count() != 2 {
        return Err(command_error(
            "invalid-request",
            "oauth",
            "OAuth callback request line was malformed.",
            false,
        ));
    }
    let mut sp_iter = request_line.splitn(3, ' ');
    let method = sp_iter.next().unwrap_or("");
    let raw_target = sp_iter.next().unwrap_or("");
    let version = sp_iter.next().unwrap_or("");
    if method != "GET" {
        return Err(command_error(
            "invalid-request",
            "oauth",
            "OAuth callback must use GET.",
            false,
        ));
    }
    if version != "HTTP/1.0" && version != "HTTP/1.1" {
        return Err(command_error(
            "invalid-request",
            "oauth",
            "OAuth callback used invalid HTTP version.",
            false,
        ));
    }
    if raw_target.is_empty() {
        return Err(command_error(
            "invalid-request",
            "oauth",
            "OAuth callback request was malformed.",
            false,
        ));
    }
    let (target, absolute_authority) = if raw_target.starts_with('/') && raw_target != "*" {
        (raw_target.to_string(), None)
    } else {
        let proxy_compatible =
            raw_target.starts_with("127.0.0.1:") || raw_target.starts_with("[::1]:");
        let absolute = url::Url::parse(raw_target)
            .or_else(|_| {
                proxy_compatible
                    .then(|| url::Url::parse(&format!("http://{raw_target}")))
                    .transpose()
                    .and_then(|value| value.ok_or(url::ParseError::RelativeUrlWithoutBase))
            })
            .map_err(|_| {
                command_error(
                    "invalid-request",
                    "oauth",
                    "OAuth callback request-target was invalid.",
                    false,
                )
            })?;
        let host = absolute.host_str().unwrap_or_default();
        if absolute.scheme() != "http"
            || !absolute.username().is_empty()
            || absolute.password().is_some()
            || !matches!(host, "127.0.0.1" | "::1")
        {
            return Err(command_error(
                "invalid-request",
                "oauth",
                "OAuth callback absolute request-target must use local HTTP.",
                false,
            ));
        }
        let authority = match absolute.port() {
            Some(port) if host == "::1" => format!("[::1]:{port}"),
            Some(port) => format!("{host}:{port}"),
            None if host == "::1" => "[::1]".to_string(),
            None => host.to_string(),
        };
        let mut normalized = absolute.path().to_string();
        if normalized.is_empty() {
            normalized.push('/');
        }
        if let Some(query) = absolute.query() {
            normalized.push('?');
            normalized.push_str(query);
        }
        (normalized, Some(authority))
    };
    if target.contains('#') || raw_target.contains('#') {
        return Err(command_error(
            "invalid-request",
            "oauth",
            "OAuth callback request-target must not contain a fragment.",
            false,
        ));
    }
    if contains_control(&target) {
        return Err(command_error(
            "invalid-request",
            "oauth",
            "OAuth callback request contained control characters.",
            false,
        ));
    }
    if !has_valid_percent_encoding(&target) {
        return Err(command_error(
            "invalid-request",
            "oauth",
            "OAuth callback request contained invalid percent-encoding.",
            false,
        ));
    }
    if contains_encoded_delimiter_or_control(&target) {
        return Err(command_error(
            "invalid-request",
            "oauth",
            "OAuth callback request contained encoded delimiters or control characters.",
            false,
        ));
    }

    // Duplicate security-sensitive query params (state/code/handoff/error are
    // security relevant; complete_with_store also rejects all dups but we fail
    // closed early).
    if let Some(qi) = target.find('?') {
        let query = &target[qi + 1..];
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        for pair in query.split('&') {
            if pair.is_empty() {
                continue;
            }
            let key = if let Some(eq) = pair.find('=') {
                &pair[..eq]
            } else {
                pair
            };
            let key_l = key.to_ascii_lowercase();
            if ["state", "code", "handoff", "error"].contains(&key_l.as_str())
                && !seen.insert(key_l)
            {
                return Err(command_error(
                    "invalid-request",
                    "oauth",
                    "OAuth callback contains duplicate parameters.",
                    false,
                ));
            }
        }
    }

    // Headers: count, bounds, controls, encoded bads, framing, Host enforcement.
    let mut header_count = 0usize;
    let mut host: Option<&str> = None;
    let mut has_content_length = false;
    let mut content_length: Option<usize> = None;
    let mut has_transfer_encoding = false;
    for &line in &lines[1..] {
        if line.is_empty() {
            // blank line from \r\n\r\n
            continue;
        }
        if line.len() > MAX_HEADER_BYTES {
            return Err(command_error(
                "invalid-request",
                "oauth",
                "OAuth callback header was too long.",
                false,
            ));
        }
        header_count += 1;
        if header_count > MAX_HEADERS {
            return Err(command_error(
                "invalid-request",
                "oauth",
                "OAuth callback had too many headers.",
                false,
            ));
        }
        let colon_pos = match line.find(':') {
            Some(p) => p,
            None => {
                return Err(command_error(
                    "invalid-request",
                    "oauth",
                    "OAuth callback header was malformed.",
                    false,
                ))
            }
        };
        let name = &line[..colon_pos];
        let value = &line[colon_pos + 1..].trim_start();
        if !is_http_token(name) {
            return Err(command_error(
                "invalid-request",
                "oauth",
                "OAuth callback header was malformed.",
                false,
            ));
        }
        if contains_control(name) || contains_control(value) {
            return Err(command_error(
                "invalid-request",
                "oauth",
                "OAuth callback header contained control characters.",
                false,
            ));
        }
        if contains_encoded_delimiter_or_control(name)
            || contains_encoded_delimiter_or_control(value)
        {
            return Err(command_error(
                "invalid-request",
                "oauth",
                "OAuth callback header contained encoded delimiters or control characters.",
                false,
            ));
        }
        let name_lower = name.trim().to_ascii_lowercase();
        if name_lower == "host" {
            if host.is_some() {
                return Err(command_error(
                    "invalid-request",
                    "oauth",
                    "OAuth callback had duplicate Host header.",
                    false,
                ));
            }
            host = Some(value);
        }
        if name_lower == "content-length" {
            if has_content_length {
                return Err(command_error(
                    "invalid-request",
                    "oauth",
                    "OAuth callback had duplicate Content-Length headers.",
                    false,
                ));
            }
            has_content_length = true;
            match value.parse::<usize>() {
                Ok(len) => content_length = Some(len),
                Err(_) => {
                    return Err(command_error(
                        "invalid-request",
                        "oauth",
                        "OAuth callback had invalid Content-Length.",
                        false,
                    ))
                }
            }
        }
        if name_lower == "transfer-encoding" {
            if has_transfer_encoding {
                return Err(command_error(
                    "invalid-request",
                    "oauth",
                    "OAuth callback had duplicate Transfer-Encoding headers.",
                    false,
                ));
            }
            has_transfer_encoding = true;
        }
    }

    // Ambiguous framing or bodies are rejected for this GET callback path.
    if has_content_length && has_transfer_encoding {
        return Err(command_error(
            "invalid-request",
            "oauth",
            "OAuth callback used ambiguous message framing.",
            false,
        ));
    }
    if has_transfer_encoding || (has_content_length && content_length.unwrap_or(0) > 0) {
        return Err(command_error(
            "invalid-request",
            "oauth",
            "OAuth callback must not include a message body.",
            false,
        ));
    }
    if !request[header_end + 4..].is_empty() {
        return Err(command_error(
            "invalid-request",
            "oauth",
            "OAuth callback must contain exactly one header-only request.",
            false,
        ));
    }

    // Enforce literal loopback listener Host expectations (127.0.0.1 or ::1
    // forms) where applicable. HTTP/1.1 requires Host; HTTP/1.0 does not.
    // If Host is present for either, it must be a literal loopback (preserves
    // the intent while not changing error surfaces for legacy 1.0 no-Host
    // callbacks that the prior minimal parser would have forwarded).
    let is_http11 = version == "HTTP/1.1";
    if let Some(h) = host {
        if !is_literal_loopback_host(h) {
            return Err(command_error(
                "invalid-request",
                "oauth",
                "OAuth callback Host header must use a literal loopback address.",
                false,
            ));
        }
        if absolute_authority
            .as_deref()
            .is_some_and(|authority| !h.eq_ignore_ascii_case(authority))
        {
            return Err(command_error(
                "invalid-request",
                "oauth",
                "OAuth callback absolute request-target did not match the Host header.",
                false,
            ));
        }
    } else if is_http11 {
        return Err(command_error(
            "invalid-request",
            "oauth",
            "OAuth callback request was missing Host header.",
            false,
        ));
    }
    // For HTTP/1.0 with no Host: allowed (matches prior parser behavior and
    // does not alter error surfaces on valid/invalid 1.0 paths).

    Ok(target)
}

/// Read the HTTP request from the loopback socket using bounded accumulation
/// until the header terminator or size limit. Delegates to the pure parser
/// so unit tests can drive the same logic with byte slices.
async fn read_callback_target(
    stream: &mut tokio::net::TcpStream,
) -> Result<String, CallbackReadError> {
    let mut buffer = Vec::with_capacity(8192);
    let mut tmp = [0u8; 1024];
    // Bound each read after accept so a client cannot hold the single callback
    // socket open indefinitely with a partial request.
    const MAX_READ_ITERS: usize = 16;
    for _ in 0..MAX_READ_ITERS {
        if buffer.len() > MAX_TOTAL_HEADER_BYTES {
            return Err(CallbackReadError {
                oauth_candidate: looks_like_oauth_callback_request(&buffer),
                error: command_error(
                    "invalid-request",
                    "oauth",
                    "OAuth callback request was too large.",
                    false,
                ),
            });
        }
        let n = tokio::time::timeout(CALLBACK_READ_TIMEOUT, stream.read(&mut tmp))
            .await
            .map_err(|_| CallbackReadError {
                oauth_candidate: looks_like_oauth_callback_request(&buffer),
                error: command_error(
                    "invalid-request",
                    "oauth",
                    "OAuth callback request timed out.",
                    false,
                ),
            })?
            .map_err(|_| CallbackReadError {
                oauth_candidate: looks_like_oauth_callback_request(&buffer),
                error: command_error("unknown", "oauth", "OAuth callback was unreadable.", false),
            })?;
        if n == 0 {
            break;
        }
        buffer.extend_from_slice(&tmp[..n]);
        if buffer.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }
    parse_callback_target(&buffer).map_err(|error| CallbackReadError {
        oauth_candidate: looks_like_oauth_callback_request(&buffer),
        error,
    })
}

fn callback_page(status: &str, message: &str) -> String {
    // Minimal static HTML; no reflection of provider-supplied content beyond a
    // status word. Keep it inert so a hostile callback cannot inject markup.
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>Mivlet</title>\
         <link rel=\"icon\" href=\"data:,\">\
         <style>body{{font-family:system-ui;padding:2rem;max-width:32rem;margin:auto}}</style>\
         </head><body><h1>{status}</h1><p>{message}</p>\
         <p>You can close this tab and return to Mivlet.</p></body></html>"
    )
}

async fn acknowledge_callback(stream: &mut tokio::net::TcpStream, status: &str, message: &str) {
    let page = callback_page(status, message);
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{page}",
        page.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

async fn acknowledge_ignored_request(stream: &mut tokio::net::TcpStream) {
    let _ = stream
        .write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        .await;
    let _ = stream.shutdown().await;
}

async fn accept_valid_callback(
    listener: &TcpListener,
) -> Result<(tokio::net::TcpStream, String), ConnectorCommandError> {
    let deadline = tokio::time::Instant::now() + CALLBACK_TIMEOUT;
    for _ in 0..MAX_CALLBACK_CONNECTIONS {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        let accepted = tokio::time::timeout(remaining, listener.accept()).await;
        let (mut stream, _) = match accepted {
            Err(_) => {
                return Err(command_error(
                    "unknown",
                    "oauth",
                    "OAuth authorization timed out; try connecting again.",
                    true,
                ));
            }
            Ok(Err(_)) => {
                return Err(command_error(
                    "unknown",
                    "oauth",
                    "Mivlet could not accept the OAuth callback.",
                    true,
                ));
            }
            Ok(Ok(pair)) => pair,
        };
        match read_callback_target(&mut stream).await {
            Ok(target) => match classify_callback_target(target) {
                Ok(CallbackTargetDisposition::OAuth(target)) => return Ok((stream, target)),
                Ok(CallbackTargetDisposition::Ignore) => {
                    acknowledge_ignored_request(&mut stream).await;
                }
                Err(error) => {
                    acknowledge_callback(
                        &mut stream,
                        "Authorization incomplete",
                        "Mivlet rejected the local callback. Return to Mivlet for details.",
                    )
                    .await;
                    return Err(error);
                }
            },
            Err(read_error) if read_error.oauth_candidate => {
                acknowledge_callback(
                    &mut stream,
                    "Authorization incomplete",
                    "Mivlet rejected the local callback. Return to Mivlet for details.",
                )
                .await;
                return Err(read_error.error);
            }
            Err(_) => {
                acknowledge_ignored_request(&mut stream).await;
            }
        }
    }
    Err(command_error(
        "invalid-request",
        "oauth",
        "Mivlet did not receive a valid OAuth callback.",
        false,
    ))
}

/// Bind the shared hardened desktop OAuth receiver. Callers build their
/// authorization request only after receiving this exact redirect URI.
pub(crate) async fn bind_loopback_callback() -> Result<(TcpListener, String), String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|_| "Mivlet could not bind a loopback OAuth listener.".to_string())?;
    let redirect_uri = bound_redirect(&listener).map_err(|error| error.message)?;
    Ok((listener, redirect_uri))
}

/// Accept one callback through the shared bounded parser, acknowledge the
/// browser with inert HTML, and return the complete loopback URL.
pub(crate) async fn accept_loopback_callback(
    listener: TcpListener,
    redirect_uri: &str,
) -> Result<String, String> {
    let (mut stream, target) = accept_valid_callback(&listener)
        .await
        .map_err(|error| error.message)?;
    let callback_origin = redirect_uri
        .strip_suffix("/callback")
        .unwrap_or(redirect_uri);
    let callback_url = format!("{callback_origin}{target}");
    let (page_status, page_message) = if callback_url.contains("error=") {
        (
            "Authorization incomplete",
            "The provider did not grant access.",
        )
    } else {
        (
            "Authorization received",
            "Finishing the connection in Mivlet...",
        )
    };
    acknowledge_callback(&mut stream, page_status, page_message).await;
    Ok(callback_url)
}

/// Drive the full loopback OAuth flow for a connector:
/// 1. bind a loopback listener and derive its redirect URI,
/// 2. start the OAuth transaction (writes PKCE verifier to secure storage),
/// 3. open the browser to the authorization URL,
/// 4. accept one callback, build the full callback URL, and complete the flow,
/// 5. emit a resolution event so the shell can refresh connector state.
pub(crate) async fn run_loopback_oauth(
    app: &tauri::AppHandle,
    connector_id: &str,
    auth_mode: &str,
    scopes: Vec<String>,
    request: ConnectorAuthRequest,
    scope: crate::authorized_scope::AuthorizedCommandScope,
) -> Result<ConnectorAuthResult, ConnectorCommandError> {
    let (listener, redirect_uri) = bind_loopback_callback()
        .await
        .map_err(|message| command_error("unknown", connector_id, &message, false))?;
    let redirect_uri = connector_redirect(&redirect_uri, auth_mode);

    // Start the OAuth transaction with the real, bound loopback redirect URI.
    // `start_auth` stores the PKCE verifier + pending state in secure storage.
    let started = start_auth(
        connector_id,
        auth_mode,
        scopes,
        ConnectorAuthRequest {
            redirect_uri: Some(redirect_uri.clone()),
            callback_url: request.callback_url.clone(),
            requested_scopes: request.requested_scopes.clone(),
            connector_id: connector_id.to_string(),
        },
        &scope,
    )?;
    let authorization_url = started.authorization_url.clone().unwrap_or_default();
    let pending_state = authorization_state(&authorization_url).ok_or_else(|| {
        command_error(
            "unknown",
            connector_id,
            "Mivlet could not retain the pending OAuth state.",
            false,
        )
    })?;
    open_browser(&authorization_url);

    let (mut stream, target) = match accept_valid_callback(&listener).await {
        Ok(callback) => callback,
        Err(error) => {
            let _ = discard_pending_auth(connector_id, &pending_state);
            emit_auth_event(app, connector_id, "error", &error.message);
            return Err(ConnectorCommandError {
                connector_id: connector_id.to_string(),
                ..error
            });
        }
    };
    let callback_origin = redirect_uri
        .strip_suffix("/callback")
        .unwrap_or(&redirect_uri);
    let callback_url = format!("{callback_origin}{target}");

    // Acknowledge the browser tab with a static status page.
    let (page_status, page_message) = match callback_url.contains("error=") {
        true => (
            "Authorization incomplete",
            "The provider did not grant access.",
        ),
        false => (
            "Authorization received",
            "Finishing the connection in Mivlet…",
        ),
    };
    acknowledge_callback(&mut stream, page_status, page_message).await;

    // Complete the flow inside the credential boundary. `complete_auth` validates
    // state + redirect match, consumes the verifier, exchanges the code, stores
    // the token set, and persists the non-secret connection record.
    let result = complete_auth(
        app,
        connector_id,
        ConnectorAuthRequest {
            redirect_uri: Some(redirect_uri),
            callback_url: Some(callback_url),
            requested_scopes: request.requested_scopes,
            connector_id: connector_id.to_string(),
        },
        &scope,
    )
    .await;
    // Completion consumes the state before provider egress. This idempotent
    // cleanup also covers validation errors so abandoned verifiers do not
    // accumulate in the OS credential store.
    let _ = discard_pending_auth(connector_id, &pending_state);

    match result {
        Ok(auth) => {
            emit_auth_event(app, connector_id, &auth.status, &auth.message);
            Ok(auth)
        }
        Err(error) => {
            emit_auth_event(app, connector_id, "error", &error.message);
            Err(error)
        }
    }
}

fn connector_redirect(origin: &str, auth_mode: &str) -> String {
    if matches!(auth_mode, "oauth-broker" | "provider-installation") {
        format!("{}/callback", origin.trim_end_matches('/'))
    } else {
        origin.to_string()
    }
}

fn emit_auth_event(app: &tauri::AppHandle, connector_id: &str, status: &str, message: &str) {
    let _ = app.emit(
        "fable://connector/auth",
        ConnectorAuthEvent {
            connector_id: connector_id.to_string(),
            status: status.to_string(),
            message: message.to_string(),
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connector_callback_matches_public_and_broker_contracts() {
        assert_eq!(
            connector_redirect("http://127.0.0.1:43123", "oauth-pkce"),
            "http://127.0.0.1:43123"
        );
        for auth_mode in ["oauth-broker", "provider-installation"] {
            assert_eq!(
                connector_redirect("http://127.0.0.1:43123", auth_mode),
                "http://127.0.0.1:43123/callback"
            );
        }
    }

    #[test]
    fn callback_page_never_reflects_untrusted_input() {
        let page = callback_page("ok", "done");
        // The page is a fixed template; provider-supplied content never reaches it.
        assert!(page.contains("ok"));
        assert!(!page.contains("<script>"));
        assert!(page.contains("rel=\"icon\" href=\"data:,\""));
    }

    #[test]
    fn callback_target_classification_ignores_browser_housekeeping() {
        assert_eq!(
            classify_callback_target("/favicon.ico".to_string()).unwrap(),
            CallbackTargetDisposition::Ignore
        );
        assert_eq!(
            classify_callback_target("/callback".to_string()).unwrap(),
            CallbackTargetDisposition::Ignore
        );
        assert_eq!(
            classify_callback_target("/".to_string()).unwrap(),
            CallbackTargetDisposition::Ignore
        );
        assert!(matches!(
            classify_callback_target("/?state=s&code=c".to_string()).unwrap(),
            CallbackTargetDisposition::OAuth(_)
        ));
        assert!(matches!(
            classify_callback_target("/callback?state=s&code=c".to_string()).unwrap(),
            CallbackTargetDisposition::OAuth(_)
        ));
        assert!(matches!(
            classify_callback_target("/callback?state=s&handoff=h".to_string()).unwrap(),
            CallbackTargetDisposition::OAuth(_)
        ));
        assert!(matches!(
            classify_callback_target("/callback?state=s&error=access_denied".to_string()).unwrap(),
            CallbackTargetDisposition::OAuth(_)
        ));

        let missing_state = classify_callback_target("/callback?code=c".to_string()).unwrap_err();
        assert!(missing_state.message.contains("missing state"));
        let conflicting =
            classify_callback_target("/callback?state=s&code=c&error=denied".to_string())
                .unwrap_err();
        assert!(conflicting.message.contains("conflicting"));
    }

    #[test]
    fn authorization_state_is_extracted_without_exposing_it() {
        assert_eq!(
            authorization_state("https://provider.example/auth?state=opaque&code_challenge=x")
                .as_deref(),
            Some("opaque")
        );
        assert!(authorization_state("https://provider.example/auth").is_none());
    }

    #[test]
    fn callback_and_pending_state_share_the_full_authorization_window() {
        assert_eq!(
            CALLBACK_TIMEOUT.as_secs(),
            OAUTH_AUTHORIZATION_WINDOW_SECONDS
        );
        assert_eq!(CALLBACK_TIMEOUT, Duration::from_secs(15 * 60));
    }

    #[tokio::test]
    async fn bound_redirect_uses_google_desktop_loopback_form() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        assert_eq!(
            bound_redirect(&listener).unwrap(),
            format!("http://127.0.0.1:{port}")
        );
    }

    #[test]
    fn parse_callback_target_is_table_driven_for_attacks_and_valid() {
        // Table-driven cases covering: request smuggling (via post-first \r\n\r\n),
        // CRLF confusion (bare LF), duplicate security-sensitive params,
        // encoded delimiters/controls, timeout/partial reads (truncated before terminator),
        // oversized request lines/headers, excessive headers, bodies, ambiguous framing,
        // malformed lines, absolute targets, invalid versions, controls, fragments,
        // bad percent, non-GET, missing/bad Host, and the valid browser callback case.
        // Each drives the real parse_callback_target (the shipped parser) directly.
        let cases: Vec<(Vec<u8>, Result<&'static str, &'static str>)> = vec![
            // Valid browser callback (realistic; note Host matches listener 127.0.0.1)
            (
                b"GET /callback?code=4/P7q7W91a-oMsCeLvIaQm6bTrgtp7&state=xyz1234567890 HTTP/1.1\r\nHost: 127.0.0.1:54321\r\nUser-Agent: Mozilla/5.0 (Windows)\r\nAccept: text/html,application/xhtml+xml\r\nAccept-Language: en-US\r\n\r\n".to_vec(),
                Ok("/callback?code=4/P7q7W91a-oMsCeLvIaQm6bTrgtp7&state=xyz1234567890"),
            ),
            // Google includes granted scopes as URL-valued query parameters.
            // `://` in the query does not make an origin-form target absolute.
            (
                b"GET /callback?state=xyz1234567890&code=4/valid&scope=https://www.googleapis.com/auth/drive.file HTTP/1.1\r\nHost: 127.0.0.1:54321\r\n\r\n".to_vec(),
                Ok("/callback?state=xyz1234567890&code=4/valid&scope=https://www.googleapis.com/auth/drive.file"),
            ),
            // IPv6 literal Host form (preserves dev behavior for ::1)
            (
                b"GET /callback?code=c&state=s HTTP/1.1\r\nHost: [::1]:12345\r\n\r\n".to_vec(),
                Ok("/callback?code=c&state=s"),
            ),
            // Positive HTTP/1.0 cases (Host optional per spec; exercises the
            // 1.0 relaxation so old no-Host 1.0 paths are not newly rejected
            // with different errors).
            (
                b"GET /callback?code=c1&state=s1 HTTP/1.0\r\n\r\n".to_vec(),
                Ok("/callback?code=c1&state=s1"),
            ),
            (
                b"GET /callback?code=c2&state=s2 HTTP/1.0\r\nHost: 127.0.0.1:9\r\n\r\n".to_vec(),
                Ok("/callback?code=c2&state=s2"),
            ),
            // 1.0 + bad (non-literal-loopback) Host: if Host present we still enforce, even for 1.0
            (
                b"GET /callback?code=1&state=2 HTTP/1.0\r\nHost: evil.com:1\r\n\r\n".to_vec(),
                Err("literal loopback address"),
            ),
            // Only GET accepted
            (
                b"POST /callback?code=x&state=s HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n".to_vec(),
                Err("must use GET"),
            ),
            // Malformed request lines
            (
                b"GET/callback?code=1&state=2 HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n".to_vec(),
                Err("malformed"),
            ),
            (
                b"GET  HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n".to_vec(),
                Err("malformed"),
            ),
            (
                b"GET /cb HTTP/1.1 extra\r\nHost: 127.0.0.1:1\r\n\r\n".to_vec(),
                Err("malformed"),
            ),
            // A proxy-compatible absolute-form loopback target is normalized
            // only when it matches the literal Host header exactly.
            (
                b"GET http://127.0.0.1:1/callback?code=1&state=2 HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n".to_vec(),
                Ok("/callback?code=1&state=2"),
            ),
            (
                b"GET https://evil.example/cb?code=1&state=2 HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n".to_vec(),
                Err("local HTTP"),
            ),
            (
                b"GET http://127.0.0.1:2/callback?code=1&state=2 HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n".to_vec(),
                Err("match the Host header"),
            ),
            (
                b"GET 127.0.0.1:1/callback?code=1&state=2 HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n".to_vec(),
                Ok("/callback?code=1&state=2"),
            ),
            // Invalid HTTP version
            (
                b"GET /callback?code=1&state=2 HTTP/2.0\r\nHost: 127.0.0.1:1\r\n\r\n".to_vec(),
                Err("invalid HTTP version"),
            ),
            (
                b"GET /callback?code=1&state=2 HTTP/1.1.1\r\nHost: 127.0.0.1:1\r\n\r\n".to_vec(),
                Err("invalid HTTP version"),
            ),
            // Control characters (bare in line)
            (
                b"GET /callback?code=1\x00state=2 HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n".to_vec(),
                Err("control characters"),
            ),
            // Fragment rejected
            (
                b"GET /callback?code=1&state=2#frag HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n".to_vec(),
                Err("fragment"),
            ),
            // Invalid percent encoding
            (
                b"GET /callback?code=%zz&state=2 HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n".to_vec(),
                Err("invalid percent-encoding"),
            ),
            (
                b"GET /callback?code=1%2&state=2 HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n".to_vec(),
                Err("invalid percent-encoding"),
            ),
            // Duplicate security-sensitive query parameters
            (
                b"GET /callback?code=1&state=2&state=3 HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n".to_vec(),
                Err("duplicate parameters"),
            ),
            (
                b"GET /callback?state=aa&code=x&code=y HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n".to_vec(),
                Err("duplicate"),
            ),
            (
                b"GET /callback?error=e1&error=e2&state=s HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n".to_vec(),
                Err("duplicate"),
            ),
            // Mixed-case duplicate security-sensitive params (drives + proves case-insensitive fix;
            // would have been accepted by case-sensitive check before the fix).
            (
                b"GET /callback?state=1&State=2 HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n".to_vec(),
                Err("duplicate"),
            ),
            (
                b"GET /callback?code=a&Code=b HTTP/1.0\r\n\r\n".to_vec(),
                Err("duplicate"),
            ),
            // Encoded delimiters / controls (CRLF smuggling via encoding)
            (
                b"GET /callback?code=1%0a%0dfoo&state=2 HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n".to_vec(),
                Err("encoded delimiters"),
            ),
            (
                b"GET /callback?x=1%00&state=2 HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n".to_vec(),
                Err("encoded delimiters"),
            ),
            // Oversized request line
            (
                format!(
                    "GET /callback?state={} HTTP/1.1\r\nHost: 127.0.0.1:12345\r\n\r\n",
                    "X".repeat(3000)
                )
                .into_bytes(),
                Err("too long"),
            ),
            // Partial reads / timeout-like (no full terminator after headers)
            (
                b"GET /callback?code=1&state=2 HTTP/1.1\r\nHost: 127.0.0.1:12345\r\nUser-Agent: x".to_vec(),
                Err("incomplete or malformed"),
            ),
            (
                b"GET /callback?code=1&state=2 HTTP/1.1\r\nHost: 127.0.0.1:12345".to_vec(),
                Err("incomplete"),
            ),
            // Missing Host header
            (
                b"GET /callback?code=1&state=2 HTTP/1.1\r\n\r\n".to_vec(),
                Err("missing Host header"),
            ),
            // Non-loopback / bad Host (rejects e.g. SSRF style or DNS rebinding attempts at header level)
            (
                b"GET /callback?code=1&state=2 HTTP/1.1\r\nHost: evil.com:12345\r\n\r\n".to_vec(),
                Err("literal loopback address"),
            ),
            (
                b"GET /callback?code=1&state=2 HTTP/1.1\r\nHost: 10.0.0.5:9\r\n\r\n".to_vec(),
                Err("loopback"),
            ),
            (
                b"GET /callback?code=1&state=2 HTTP/1.1\r\nHost: localhost:1234\r\n\r\n".to_vec(),
                Err("loopback"),
            ),
            // Bodies rejected
            (
                b"GET /callback?code=1&state=2 HTTP/1.1\r\nHost: 127.0.0.1:1\r\nContent-Length: 10\r\n\r\n1234567890".to_vec(),
                Err("must not include a message body"),
            ),
            (
                b"GET /callback?code=1&state=2 HTTP/1.1\r\nHost: 127.0.0.1:1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n".to_vec(),
                Err("body"),
            ),
            // Ambiguous framing (CL + TE)
            (
                b"GET /callback?code=1&state=2 HTTP/1.1\r\nHost: 127.0.0.1:1\r\nContent-Length: 0\r\nTransfer-Encoding: identity\r\n\r\n".to_vec(),
                Err("ambiguous message framing"),
            ),
            // CRLF confusion / smuggling (bare LF terminates early or confuses)
            (
                b"GET /callback?code=1&state=2 HTTP/1.1\nHost: 127.0.0.1:1\r\n\r\n".to_vec(),
                Err("ambiguous line endings"),
            ),
            (
                b"GET /callback?code=1&state=2 HTTP/1.1\r\nHost: 127.0.0.1:1\nX-Bar: z\r\n\r\n".to_vec(),
                Err("ambiguous line endings"),
            ),
            // Pipelined/smuggled bytes after the header-only callback are rejected.
            (
                b"GET /callback?code=good&state=good HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\nGET /smuggle?code=bad HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n".to_vec(),
                Err("exactly one"),
            ),
            // Duplicate framing headers are rejected even when values agree.
            (
                b"GET /callback?code=1&state=2 HTTP/1.1\r\nHost: 127.0.0.1:1\r\nContent-Length: 0\r\nContent-Length: 0\r\n\r\n".to_vec(),
                Err("duplicate Content-Length"),
            ),
            // Oversized total headers (via many small)
            // (constructed below to exceed MAX without huge literal)
        ];

        for (input, expected) in &cases {
            let res = parse_callback_target(input);
            match expected {
                Ok(exp_target) => {
                    let got = res.expect("valid case must parse");
                    assert_eq!(got, *exp_target, "target must match verbatim for valid");
                }
                Err(substr) => {
                    let err = res.expect_err("attack must be rejected");
                    assert_eq!(err.code, "invalid-request");
                    assert!(
                        err.message.to_lowercase().contains(&substr.to_lowercase()),
                        "error message {:?} must contain {:?}",
                        err.message,
                        substr
                    );
                }
            }
        }

        // Oversized total + excessive headers: build dynamically
        let mut many_headers =
            String::from("GET /callback?code=1&state=2 HTTP/1.1\r\nHost: 127.0.0.1:12345\r\n");
        for i in 0..100 {
            many_headers.push_str(&format!("X-Hdr-{}: value{}\r\n", i, i));
        }
        many_headers.push_str("\r\n");
        let res = parse_callback_target(many_headers.as_bytes());
        let err = res.expect_err("excessive headers");
        assert_eq!(err.code, "invalid-request");
        assert!(err.message.contains("too many headers"));

        // Another oversized via total bytes (long header value)
        let long_header = format!(
            "GET /callback?state=ok HTTP/1.1\r\nHost: 127.0.0.1:1\r\nX-Long: {}\r\n\r\n",
            "Y".repeat(5000)
        );
        let res = parse_callback_target(long_header.as_bytes());
        let err = res.expect_err("oversized header");
        assert_eq!(err.code, "invalid-request");
        assert!(err.message.contains("too long") || err.message.contains("too large"));
    }

    #[test]
    fn parse_callback_target_rejects_oversized_request_line() {
        let long = format!(
            "GET /callback?state={} HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n",
            "Z".repeat(4096)
        );
        let err = parse_callback_target(long.as_bytes()).expect_err("line too long");
        assert_eq!(err.code, "invalid-request");
        assert!(err.message.contains("too long"));
    }

    #[test]
    fn parse_callback_target_accepts_a_bounded_chrome_cookie_header() {
        let request = format!(
            "GET /callback?code=ok&state=ok HTTP/1.1\r\nHost: 127.0.0.1:1\r\nCookie: session={}\r\n\r\n",
            "c".repeat(1900)
        );
        assert_eq!(
            parse_callback_target(request.as_bytes()).unwrap(),
            "/callback?code=ok&state=ok"
        );
    }

    #[test]
    fn live_shaped_chrome_google_callback_passes_parser_and_semantics() {
        let request = format!(
            concat!(
                "GET /callback?state={}&iss=https%3A%2F%2Faccounts.google.com&code={}",
                "&scope=email+profile+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.file+openid",
                "&authuser=0&prompt=consent HTTP/1.1\r\n",
                "Host: 127.0.0.1:54321\r\n",
                "Connection: keep-alive\r\n",
                "sec-ch-ua: \"Chromium\";v=\"136\", \"Not.A/Brand\";v=\"99\"\r\n",
                "sec-ch-ua-mobile: ?0\r\n",
                "sec-ch-ua-platform: \"Windows\"\r\n",
                "Upgrade-Insecure-Requests: 1\r\n",
                "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/136 Safari/537.36\r\n",
                "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8\r\n",
                "Sec-Fetch-Site: cross-site\r\n",
                "Sec-Fetch-Mode: navigate\r\n",
                "Sec-Fetch-User: ?1\r\n",
                "Sec-Fetch-Dest: document\r\n",
                "Accept-Encoding: gzip, deflate, br, zstd\r\n",
                "Accept-Language: en-GB,en;q=0.9\r\n",
                "Cookie: session={}\r\n\r\n"
            ),
            "s".repeat(43),
            "c".repeat(73),
            "v".repeat(1970)
        );
        let target = parse_callback_target(request.as_bytes()).unwrap();
        assert!(matches!(
            classify_callback_target(target).unwrap(),
            CallbackTargetDisposition::OAuth(_)
        ));
    }

    async fn send_request(port: u16, request: String) -> String {
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();
        response
    }

    #[tokio::test]
    async fn callback_receiver_ignores_an_invalid_connection_before_the_browser_callback() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let receiver = tokio::spawn(async move { accept_valid_callback(&listener).await });

        let mut invalid = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        invalid
            .write_all(
                format!("GET invalid-target HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n").as_bytes(),
            )
            .await
            .unwrap();
        invalid.shutdown().await.unwrap();

        let mut valid = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        valid
            .write_all(
                format!("GET /?code=ok&state=ok HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n")
                    .as_bytes(),
            )
            .await
            .unwrap();
        valid.shutdown().await.unwrap();

        let (_, target) = receiver.await.unwrap().unwrap();
        assert_eq!(target, "/?code=ok&state=ok");
    }

    #[tokio::test]
    async fn callback_receiver_ignores_probe_and_favicon_before_real_callback() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let receiver = tokio::spawn(async move { accept_valid_callback(&listener).await });

        let probe = send_request(
            port,
            format!("GET /callback HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n"),
        )
        .await;
        assert!(probe.starts_with("HTTP/1.1 204 No Content"));
        let favicon = send_request(
            port,
            format!("GET /favicon.ico HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n"),
        )
        .await;
        assert!(favicon.starts_with("HTTP/1.1 204 No Content"));

        let mut valid = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        valid
            .write_all(
                format!(
                    "GET /callback?code=ok&state=ok HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n"
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        valid.shutdown().await.unwrap();

        let (_, target) = receiver.await.unwrap().unwrap();
        assert_eq!(target, "/callback?code=ok&state=ok");
    }

    #[tokio::test]
    async fn callback_receiver_preserves_the_primary_callback_parser_error() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let receiver = tokio::spawn(async move { accept_valid_callback(&listener).await });
        let request = format!(
            "GET /callback?code=ok&state=ok HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nCookie: session={}\r\n\r\n",
            "c".repeat(5000)
        );

        let response = send_request(port, request).await;
        let error = receiver.await.unwrap().unwrap_err();

        assert!(response.contains("Authorization incomplete"));
        assert!(error.message.contains("header was too long"));
        assert!(!error.message.contains("missing state"));
    }
}
