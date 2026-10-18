//! Google request policy, bounded transport, and cancellation custody.
//!
//! All network calls stay behind this module so retry and cancellation semantics
//! remain reviewable independently of Drive, Gmail, and Calendar operations.

use std::time::Duration;

use futures_util::StreamExt;
use reqwest::{header::RETRY_AFTER, Method, StatusCode, Url};
use serde_json::Value;

use crate::{connector_auth::StoredTokenSet, models::ConnectorCommandError};

use super::{MAX_RESPONSE_BYTES, MAX_RETRIES, REQUEST_TIMEOUT};

pub(super) fn error(
    connector_id: &str,
    code: &str,
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

pub(super) fn required_scope_error(connector_id: &str, scopes: &[&str]) -> ConnectorCommandError {
    error(
        connector_id,
        "permission-denied",
        &format!(
            "This operation needs additional Google authorization: {}.",
            scopes.join(" or ")
        ),
        false,
    )
}

pub(super) fn has_any_scope(tokens: &StoredTokenSet, required: &[&str]) -> bool {
    required.iter().any(|required| {
        tokens
            .scopes
            .iter()
            .any(|granted| granted == required || granted.ends_with(&format!("/{required}")))
            || (tokens
                .scopes
                .iter()
                .any(|granted| granted == "https://www.googleapis.com/auth/drive")
                && required.starts_with("https://www.googleapis.com/auth/drive"))
    })
}

pub(super) fn require_scope(
    connector_id: &str,
    tokens: &StoredTokenSet,
    required: &[&str],
) -> Result<(), ConnectorCommandError> {
    has_any_scope(tokens, required)
        .then_some(())
        .ok_or_else(|| required_scope_error(connector_id, required))
}

pub(super) fn api_url(base: &str, path: &str) -> Result<Url, ConnectorCommandError> {
    let resolved_base = match base {
        "https://www.googleapis.com/drive/v3/" => {
            crate::env_compat::var_named("MIVLET_GOOGLE_DRIVE_API")
                .unwrap_or_else(|_| base.to_string())
        }
        "https://www.googleapis.com/upload/drive/v3/" => {
            crate::env_compat::var_named("MIVLET_GOOGLE_DRIVE_UPLOAD_API")
                .unwrap_or_else(|_| base.to_string())
        }
        "https://gmail.googleapis.com/gmail/v1/" => {
            crate::env_compat::var_named("MIVLET_GOOGLE_GMAIL_API")
                .unwrap_or_else(|_| base.to_string())
        }
        "https://www.googleapis.com/calendar/v3/" => {
            crate::env_compat::var_named("MIVLET_GOOGLE_CALENDAR_API")
                .unwrap_or_else(|_| base.to_string())
        }
        "https://openidconnect.googleapis.com/v1/" => {
            crate::env_compat::var_named("MIVLET_GOOGLE_OPENID_API")
                .unwrap_or_else(|_| base.to_string())
        }
        _ => base.to_string(),
    };
    Url::parse(&resolved_base)
        .and_then(|base_url| base_url.join(path))
        .map_err(|_| {
            error(
                "google",
                "invalid-request",
                "Google API URL is invalid.",
                false,
            )
        })
}

pub(super) fn provider_error(
    connector_id: &str,
    status: StatusCode,
    retry_after: Option<String>,
) -> ConnectorCommandError {
    let (code, message, retryable) = match status.as_u16() {
        400 => ("invalid-request", "Google rejected the request.", false),
        401 => (
            "expired-auth",
            "Google authorization expired; reconnect the account.",
            false,
        ),
        403 => (
            "permission-denied",
            "Google did not grant the permission required for this operation.",
            false,
        ),
        404 => (
            "not-found",
            "The requested Google resource was not found.",
            false,
        ),
        409 | 412 => (
            "invalid-request",
            "The Google resource changed; refresh it before trying again.",
            false,
        ),
        429 => (
            "rate-limited",
            "Google rate-limited the request. Try again later.",
            true,
        ),
        500..=599 => (
            "provider-unavailable",
            "Google is temporarily unavailable.",
            true,
        ),
        _ => ("unknown", "The Google request failed.", false),
    };
    ConnectorCommandError {
        code: code.to_string(),
        connector_id: connector_id.to_string(),
        message: message.to_string(),
        retryable,
        retry_after,
    }
}

/// Generate a fresh, unique call id for a Google request. The id is opaque and
/// only used to target cancellation; it embeds the connector so logs/cancel
/// commands stay human-readable while a process-wide counter guarantees
/// uniqueness across concurrent requests.
pub(super) fn new_call_id(connector_id: &str) -> String {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("{connector_id}-{n}")
}

/// Decide whether a failed request is *safe* to retry. Read-only requests
/// (GET) are idempotent, so a transient 429/5xx or a transport error may be
/// retried. Mutations (POST/PATCH/DELETE) are NOT idempotent at Google: a 5xx
/// returned after the provider accepted the side effect would otherwise be
/// re-issued and duplicate it (a second sent email, a second created file, a
/// second calendar event). The contract therefore retries reads only, and
/// surfaces mutation failures immediately so the user can verify the result
/// before choosing to retry. This is the idempotency boundary for Google
/// mutations: "retries cannot duplicate mutations".
pub(super) fn should_retry(method: &Method) -> bool {
    *method == Method::GET
}

/// A cooperative cancel token for an in-flight Google request. The agent's Stop
/// button (see `cancel_google_request`) flips the watch to `true`; `send`
/// aborts at the next `select!` point (during egress or backoff) and returns a
/// non-retryable error. Cancelled reads never reach the provider's retry loop,
/// and cancelled mutations never execute — the side effect is avoided, not
/// duplicated.
type CancelSender = tokio::sync::watch::Sender<bool>;

/// Registry of in-flight Google requests keyed by a Mivlet-assigned call id, so
/// the UI can request cancellation of a specific read/action. Mirrors the
/// streaming-backend cancel map in `native_api.rs`. Entries are removed by
/// `scoped_cancel` on completion (success, error, or panic path via drop).
static CANCEL_REGISTRY: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, CancelSender>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

/// Register a new cancel token for a Google request and return the receiver
/// `send` polls. Generating a fresh call id per request keeps cancellation
/// precise: cancelling one search never aborts another.
pub(super) fn register_cancel(call_id: &str) -> tokio::sync::watch::Receiver<bool> {
    let (tx, rx) = tokio::sync::watch::channel(false);
    CANCEL_REGISTRY
        .lock()
        .expect("cancel registry poisoned")
        .insert(call_id.to_string(), tx);
    rx
}

/// Remove a call id from the registry (called when the request completes). Any
/// later cancel for that id is a no-op.
pub(super) fn unregister_cancel(call_id: &str) {
    CANCEL_REGISTRY
        .lock()
        .expect("cancel registry poisoned")
        .remove(call_id);
}

/// Flip a registered request's cancel flag to `true`. Returns `false` if no
/// in-flight request matches the id (already completed or unknown).
pub(crate) fn cancel_google_request(call_id: &str) -> bool {
    CANCEL_REGISTRY
        .lock()
        .expect("cancel registry poisoned")
        .get(call_id)
        .is_some_and(|sender| sender.send(true).is_ok())
}

/// Cooperative cancel for an in-flight Google read or mutation. The agent's
/// Stop button invokes this with the call id of the request it wants to abort;
/// the in-flight `send`/`backoff` then fails fast with a cancelled error and
/// the mutation is abandoned (never duplicated). Unknown/already-completed ids
/// are a no-op.
pub(super) fn cancel_google_call(call_id: String) -> bool {
    cancel_google_request(&call_id)
}

/// RAII handle for a registered cancel token. Creating it inserts the call id
/// into the registry; dropping it (on every exit path, including early `?`
/// returns and panics) removes the entry so a stale id can never leak. The
/// guard also lends the receiver `send` polls for cooperative cancellation.
struct CancelGuard {
    call_id: String,
    rx: tokio::sync::watch::Receiver<bool>,
}

impl CancelGuard {
    fn new(call_id: String) -> Self {
        let rx = register_cancel(&call_id);
        Self { call_id, rx }
    }

    fn receiver(&mut self) -> &mut tokio::sync::watch::Receiver<bool> {
        &mut self.rx
    }
}

impl Drop for CancelGuard {
    fn drop(&mut self) {
        unregister_cancel(&self.call_id);
    }
}

pub(super) async fn send(
    call_id: &str,
    connector_id: &str,
    tokens: &StoredTokenSet,
    method: Method,
    url: Url,
    body: Option<Value>,
) -> Result<(StatusCode, Vec<u8>), ConnectorCommandError> {
    crate::ensure_rustls_provider();
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|_| {
            error(
                connector_id,
                "provider-unavailable",
                "Google client setup failed.",
                true,
            )
        })?;
    let mut guard = CancelGuard::new(call_id.to_string());
    let cancel_rx = guard.receiver();
    let retryable = should_retry(&method);
    for attempt in 0..=MAX_RETRIES {
        let mut request = client
            .request(method.clone(), url.clone())
            .bearer_auth(&tokens.access_token);
        if let Some(body) = body.as_ref() {
            request = request.json(body);
        }
        // Honor a cooperative cancel during egress. A mutation cancelled here
        // is abandoned (never executed); a read cancelled here is abandoned
        // (never retried).
        let response = tokio::select! {
            biased;
            _ = cancel_changed(cancel_rx) => {
                return Err(cancelled_error(connector_id));
            }
            send_result = request.send() => match send_result {
                Ok(response) => response,
                Err(_) => {
                    if !retryable {
                        // Transport failure on a mutation: the request may have
                        // reached Google. Surface immediately rather than retry.
                        return Err(maybe_applied_error(connector_id, &method));
                    }
                    if attempt == MAX_RETRIES {
                        return Err(error(
                            connector_id,
                            "provider-unavailable",
                            "Google could not be reached.",
                            true,
                        ));
                    }
                    backoff(connector_id, attempt, None, cancel_rx).await?;
                    continue;
                }
            },
        };
        let status = response.status();
        let retry_after = response
            .headers()
            .get(RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        if !status.is_success() {
            let mapped = provider_error(connector_id, status, retry_after);
            // Only reads retry. Mutations surface immediately: a 5xx/429 after
            // the provider may have applied the change must NOT be re-issued.
            if retryable && mapped.retryable && attempt < MAX_RETRIES {
                backoff(
                    connector_id,
                    attempt,
                    mapped.retry_after.as_deref(),
                    cancel_rx,
                )
                .await?;
                continue;
            }
            if !retryable && mapped.retryable {
                return Err(maybe_applied_error(connector_id, &method));
            }
            return Err(mapped);
        }
        let bytes = read_bounded_response(connector_id, response, cancel_rx).await?;
        return Ok((status, bytes));
    }
    Err(error(
        connector_id,
        "provider-unavailable",
        "Google request retries were exhausted.",
        true,
    ))
}

pub(super) async fn read_bounded_response(
    connector_id: &str,
    response: reqwest::Response,
    cancel_rx: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<Vec<u8>, ConnectorCommandError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(error(
            connector_id,
            "response-too-large",
            "Google response exceeds Mivlet's safe import limit.",
            false,
        ));
    }
    let mut output = Vec::new();
    let mut stream = response.bytes_stream();
    loop {
        let next = tokio::select! {
            biased;
            _ = cancel_changed(cancel_rx) => return Err(cancelled_error(connector_id)),
            next = stream.next() => next,
        };
        let Some(chunk) = next else {
            return Ok(output);
        };
        let chunk = chunk.map_err(|_| {
            error(
                connector_id,
                "provider-unavailable",
                "Google returned an unreadable response.",
                true,
            )
        })?;
        if output.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err(error(
                connector_id,
                "response-too-large",
                "Google response exceeds Mivlet's safe import limit.",
                false,
            ));
        }
        output.extend_from_slice(&chunk);
    }
}

/// Wait until the cancel watch reports cancellation. A small helper keeps the
/// `select!` branches readable and avoids borrowing the receiver inline.
pub(super) async fn cancel_changed(rx: &mut tokio::sync::watch::Receiver<bool>) {
    if *rx.borrow() {
        return;
    }
    let _ = rx.changed().await;
}

/// Backoff between retry attempts, abortable by a cooperative cancel. Honors
/// the provider's `Retry-After` when present, otherwise exponential with a 2s
/// cap. A cancel during backoff fails fast with a cancelled error.
pub(super) async fn backoff(
    connector_id: &str,
    attempt: usize,
    retry_after: Option<&str>,
    cancel_rx: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<(), ConnectorCommandError> {
    let delay = retry_after
        .and_then(|value| value.parse::<u64>().ok())
        .map(Duration::from_secs)
        .unwrap_or_else(|| Duration::from_millis(150 * 2_u64.pow(attempt as u32)))
        .min(Duration::from_secs(2));
    tokio::select! {
        biased;
        _ = cancel_changed(cancel_rx) => Err(cancelled_error(connector_id)),
        _ = tokio::time::sleep(delay) => Ok(()),
    }
}

pub(super) fn cancelled_error(connector_id: &str) -> ConnectorCommandError {
    error(
        connector_id,
        "cancelled",
        "The Google request was cancelled.",
        false,
    )
}

/// A mutation (POST/PATCH/DELETE) failed with a transport error or a retriable
/// status. Because Google may already have applied the side effect, we do NOT
/// retry; we tell the user to verify the outcome before trying again. This is
/// the core guard against duplicated sends/creates/deletes.
pub(super) fn maybe_applied_error(connector_id: &str, method: &Method) -> ConnectorCommandError {
    let action = match *method {
        Method::POST => "created",
        Method::PATCH | Method::PUT => "updated",
        Method::DELETE => "deleted",
        _ => "changed",
    };
    error(
        connector_id,
        "provider-unavailable",
        &format!(
            "Google reported a transient failure after a {action} request. The change may already have been applied — verify the result in Google before retrying."
        ),
        false,
    )
}

pub(super) async fn send_json(
    call_id: &str,
    connector_id: &str,
    tokens: &StoredTokenSet,
    method: Method,
    url: Url,
    body: Option<Value>,
) -> Result<Value, ConnectorCommandError> {
    let (_, bytes) = send(call_id, connector_id, tokens, method, url, body).await?;
    if bytes.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_slice(&bytes).map_err(|_| {
        error(
            connector_id,
            "provider-unavailable",
            "Google returned malformed JSON.",
            false,
        )
    })
}

pub(super) async fn send_raw_json(
    call_id: &str,
    connector_id: &str,
    tokens: &StoredTokenSet,
    method: Method,
    url: Url,
    content_type: &str,
    body: Vec<u8>,
) -> Result<Value, ConnectorCommandError> {
    crate::ensure_rustls_provider();
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| {
            error(
                connector_id,
                "provider-unavailable",
                "Google client setup failed.",
                true,
            )
        })?;
    let mut guard = CancelGuard::new(call_id.to_string());
    let cancel_rx = guard.receiver();
    let response = tokio::select! {
        biased;
        _ = cancel_changed(cancel_rx) => return Err(cancelled_error(connector_id)),
        result = client
            .request(method.clone(), url)
            .bearer_auth(&tokens.access_token)
            .header("Content-Type", content_type)
            .body(body)
            .send() => result.map_err(|_| maybe_applied_error(connector_id, &method))?,
    };
    if !response.status().is_success() {
        let mapped = provider_error(
            connector_id,
            response.status(),
            response
                .headers()
                .get(RETRY_AFTER)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string),
        );
        return if mapped.retryable {
            Err(maybe_applied_error(connector_id, &method))
        } else {
            Err(mapped)
        };
    }
    let bytes = read_bounded_response(connector_id, response, cancel_rx).await?;
    if bytes.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_slice(&bytes).map_err(|_| {
        error(
            connector_id,
            "provider-unavailable",
            "Google returned malformed JSON.",
            false,
        )
    })
}
