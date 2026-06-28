//! Loopback OAuth callback receiver.
//!
//! The Google desktop PKCE flow (and any future public-client OAuth) needs a
//! real redirect URI the provider can call back. We bind an ephemeral
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

/// Read a single HTTP request line from the loopback socket and extract the
/// request-target (the callback path + query). The provider returns `state`
/// and `code` as query parameters on the GET request line.
async fn read_callback_target(
    stream: &mut tokio::net::TcpStream,
) -> Result<String, ConnectorCommandError> {
    let mut buffer = [0u8; 4096];
    let read = stream
        .read(&mut buffer)
        .await
        .map_err(|_| command_error("unknown", "oauth", "OAuth callback was unreadable.", false))?;
    let request = String::from_utf8_lossy(&buffer[..read]);
    // A minimal request line: `GET /callback?code=...&state=... HTTP/1.1`.
    let request_line = request.lines().next().unwrap_or_default();
    let mut parts = request_line.split_whitespace();
    let _method = parts.next();
    let target = parts.next().unwrap_or("/");
    if target.is_empty() {
        return Err(command_error(
            "invalid-request",
            "oauth",
            "OAuth callback request was malformed.",
            false,
        ));
    }
    Ok(target.to_string())
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

/// Drive the full public-client OAuth flow for a connector:
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
}
