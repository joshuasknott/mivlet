//! Loopback OAuth callback receiver.
//!
//! Desktop OAuth needs a real redirect URI the provider or auth broker can call
//! back. We bind an ephemeral
//! `http://127.0.0.1:{port}/callback` listener, hand that exact URI to
//! `start_auth`, and then accept a single callback. The received callback URL
//! is forwarded to `complete_auth`, which already validates state, redirect
//! match, and consumes the one-use PKCE verifier before network egress.
//!
//! Nothing in this module ever sees the access token — `complete_auth` resolves
//! the token exchange inside the credential boundary.

use std::time::Duration;

use tauri::Emitter;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::connector_auth::{complete_auth, start_auth};
use crate::models::{ConnectorAuthRequest, ConnectorAuthResult, ConnectorCommandError};

/// The window of time a loopback listener waits for the provider callback before
/// the in-flight authorization attempt is considered abandoned.
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(300);
const CALLBACK_READ_TIMEOUT: Duration = Duration::from_secs(10);

/// Bounded limits for the deterministic single-callback HTTP/1.x parser.
/// These reject DoS, smuggling, and oversized inputs while passing all
/// legitimate browser callbacks observed in the existing flow.
const MAX_REQUEST_LINE_BYTES: usize = 2048;
const MAX_HEADER_BYTES: usize = 1024;
const MAX_HEADERS: usize = 32;
const MAX_TOTAL_HEADER_BYTES: usize = 8192;

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
fn open_browser(authorization_url: &str) {
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
                "Fable could not bind a loopback OAuth listener.",
                false,
            )
        })?
        .port();
    Ok(format!("http://127.0.0.1:{port}/callback"))
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

/// Pure, deterministic, bounded HTTP/1.x request parser for the loopback
/// OAuth callback. Accepts only a single GET with origin-form target and
/// literal loopback Host (127.0.0.1 or ::1 forms). Rejects all attack cases
/// enumerated in the requirements using strict CRLF, size caps, and
/// explicit framing/encoding/duplicate checks. Returns the target verbatim
/// for valid cases so that callback URL construction and complete_auth
/// contract remain unchanged.
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
    let target = sp_iter.next().unwrap_or("");
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
    if target.is_empty() {
        return Err(command_error(
            "invalid-request",
            "oauth",
            "OAuth callback request was malformed.",
            false,
        ));
    }
    // origin-form only; reject absolute-form, *, etc. (empty already handled as malformed)
    if !target.starts_with('/') || target.contains("://") || target == "*" {
        return Err(command_error(
            "invalid-request",
            "oauth",
            "OAuth callback request-target must be origin-form.",
            false,
        ));
    }
    if target.contains('#') {
        return Err(command_error(
            "invalid-request",
            "oauth",
            "OAuth callback request-target must not contain a fragment.",
            false,
        ));
    }
    if contains_control(target) {
        return Err(command_error(
            "invalid-request",
            "oauth",
            "OAuth callback request contained control characters.",
            false,
        ));
    }
    if !has_valid_percent_encoding(target) {
        return Err(command_error(
            "invalid-request",
            "oauth",
            "OAuth callback request contained invalid percent-encoding.",
            false,
        ));
    }
    if contains_encoded_delimiter_or_control(target) {
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

    Ok(target.to_string())
}

/// Read the HTTP request from the loopback socket using bounded accumulation
/// until the header terminator or size limit. Delegates to the pure parser
/// so unit tests can drive the same logic with byte slices.
async fn read_callback_target(
    stream: &mut tokio::net::TcpStream,
) -> Result<String, ConnectorCommandError> {
    let mut buffer = Vec::with_capacity(8192);
    let mut tmp = [0u8; 1024];
    // Bound each read after accept so a client cannot hold the single callback
    // socket open indefinitely with a partial request.
    const MAX_READ_ITERS: usize = 16;
    for _ in 0..MAX_READ_ITERS {
        if buffer.len() > MAX_TOTAL_HEADER_BYTES {
            return Err(command_error(
                "invalid-request",
                "oauth",
                "OAuth callback request was too large.",
                false,
            ));
        }
        let n = tokio::time::timeout(CALLBACK_READ_TIMEOUT, stream.read(&mut tmp))
            .await
            .map_err(|_| {
                command_error(
                    "invalid-request",
                    "oauth",
                    "OAuth callback request timed out.",
                    false,
                )
            })?
            .map_err(|_| {
                command_error("unknown", "oauth", "OAuth callback was unreadable.", false)
            })?;
        if n == 0 {
            break;
        }
        buffer.extend_from_slice(&tmp[..n]);
        if buffer.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }
    parse_callback_target(&buffer)
}

fn callback_page(status: &str, message: &str) -> String {
    // Minimal static HTML; no reflection of provider-supplied content beyond a
    // status word. Keep it inert so a hostile callback cannot inject markup.
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>Fable</title>\
         <style>body{{font-family:system-ui;padding:2rem;max-width:32rem;margin:auto}}</style>\
         </head><body><h1>{status}</h1><p>{message}</p>\
         <p>You can close this tab and return to Fable.</p></body></html>"
    )
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
    identity: crate::clerk_identity::NativeIdentityGenerationSnapshot,
) -> Result<ConnectorAuthResult, ConnectorCommandError> {
    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|_| {
        command_error(
            "unknown",
            connector_id,
            "Fable could not bind a loopback OAuth listener.",
            false,
        )
    })?;
    let redirect_uri = bound_redirect(&listener)?;

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
        &identity,
    )?;
    let authorization_url = started.authorization_url.clone().unwrap_or_default();
    open_browser(&authorization_url);

    // Accept exactly one callback within the timeout window.
    let accept = tokio::time::timeout(CALLBACK_TIMEOUT, listener.accept()).await;
    let (mut stream, _) = match accept {
        Ok(Ok(pair)) => pair,
        Ok(Err(_)) => {
            let message = "Fable could not accept the OAuth callback.".to_string();
            emit_auth_event(app, connector_id, "error", &message);
            return Err(command_error("unknown", connector_id, &message, true));
        }
        Err(_) => {
            let message = "OAuth authorization timed out; try connecting again.".to_string();
            emit_auth_event(app, connector_id, "error", &message);
            return Err(command_error("unknown", connector_id, &message, true));
        }
    };

    let target = read_callback_target(&mut stream).await?;
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
            "Finishing the connection in Fable…",
        ),
    };
    let _ = stream
        .write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n{}",
                callback_page(page_status, page_message)
            )
            .as_bytes(),
        )
        .await;
    let _ = stream.shutdown().await;

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
        &identity,
    )
    .await;

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
    fn callback_page_never_reflects_untrusted_input() {
        let page = callback_page("ok", "done");
        // The page is a fixed template; provider-supplied content never reaches it.
        assert!(page.contains("ok"));
        assert!(!page.contains("<script>"));
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
            // Absolute-form targets rejected
            (
                b"GET http://127.0.0.1:1/callback?code=1&state=2 HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n".to_vec(),
                Err("origin-form"),
            ),
            (
                b"GET https://evil.example/cb?code=1&state=2 HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n".to_vec(),
                Err("origin-form"),
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
            "Y".repeat(2000)
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
}
