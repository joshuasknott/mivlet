//! Production Google Workspace provider adapters.
//!
//! This module is the only Google API egress path. OAuth credentials are read
//! through `connector_auth`, remain native, and are never serialized to the UI.

use std::{collections::BTreeMap, time::Duration};

use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use futures_util::StreamExt;
use reqwest::{header::RETRY_AFTER, Method, StatusCode, Url};
use serde_json::{json, Value};

use crate::{
    connector_auth::{authorized_tokens, authorized_tokens_for_connection, StoredTokenSet},
    models::{
        ConnectorActionRequest, ConnectorActionResult, ConnectorCommandError, ConnectorHealth,
        ConnectorImportRequest, ConnectorImportResult, ConnectorKnowledgeSource,
        ConnectorSearchItem, ConnectorSearchRequest, ConnectorSearchResult,
    },
    paths::{normalize_spaces, truncate_characters},
};

const DRIVE_API: &str = "https://www.googleapis.com/drive/v3/";
const DRIVE_UPLOAD_API: &str = "https://www.googleapis.com/upload/drive/v3/";
const GMAIL_API: &str = "https://gmail.googleapis.com/gmail/v1/";
const CALENDAR_API: &str = "https://www.googleapis.com/calendar/v3/";
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const MAX_PREVIEW_CHARACTERS: usize = 20_000;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_RETRIES: usize = 2;

const DRIVE_FILE: &str = "https://www.googleapis.com/auth/drive.file";
const DRIVE_READONLY: &str = "https://www.googleapis.com/auth/drive.readonly";
const DRIVE_METADATA: &str = "https://www.googleapis.com/auth/drive.metadata.readonly";
const GMAIL_READONLY: &str = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_COMPOSE: &str = "https://www.googleapis.com/auth/gmail.compose";
const GMAIL_SEND: &str = "https://www.googleapis.com/auth/gmail.send";
const CALENDAR_LIST: &str = "https://www.googleapis.com/auth/calendar.calendarlist.readonly";
const CALENDAR_READONLY: &str = "https://www.googleapis.com/auth/calendar.events.readonly";
const CALENDAR_EVENTS: &str = "https://www.googleapis.com/auth/calendar.events";

fn error(connector_id: &str, code: &str, message: &str, retryable: bool) -> ConnectorCommandError {
    ConnectorCommandError {
        code: code.to_string(),
        connector_id: connector_id.to_string(),
        message: message.to_string(),
        retryable,
        retry_after: None,
    }
}

fn required_scope_error(connector_id: &str, scopes: &[&str]) -> ConnectorCommandError {
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

fn has_any_scope(tokens: &StoredTokenSet, required: &[&str]) -> bool {
    required.iter().any(|required| {
        tokens
            .scopes
            .iter()
            .any(|granted| granted == required || granted.ends_with(&format!("/{required}")))
    })
}

fn require_scope(
    connector_id: &str,
    tokens: &StoredTokenSet,
    required: &[&str],
) -> Result<(), ConnectorCommandError> {
    has_any_scope(tokens, required)
        .then_some(())
        .ok_or_else(|| required_scope_error(connector_id, required))
}

fn api_url(base: &str, path: &str) -> Result<Url, ConnectorCommandError> {
    let resolved_base = match base {
        "https://www.googleapis.com/drive/v3/" => {
            std::env::var("FABLE_GOOGLE_DRIVE_API").unwrap_or_else(|_| base.to_string())
        }
        "https://www.googleapis.com/upload/drive/v3/" => {
            std::env::var("FABLE_GOOGLE_DRIVE_UPLOAD_API").unwrap_or_else(|_| base.to_string())
        }
        "https://gmail.googleapis.com/gmail/v1/" => {
            std::env::var("FABLE_GOOGLE_GMAIL_API").unwrap_or_else(|_| base.to_string())
        }
        "https://www.googleapis.com/calendar/v3/" => {
            std::env::var("FABLE_GOOGLE_CALENDAR_API").unwrap_or_else(|_| base.to_string())
        }
        "https://openidconnect.googleapis.com/v1/" => {
            std::env::var("FABLE_GOOGLE_OPENID_API").unwrap_or_else(|_| base.to_string())
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

fn provider_error(
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
fn new_call_id(connector_id: &str) -> String {
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
fn should_retry(method: &Method) -> bool {
    *method == Method::GET
}

/// A cooperative cancel token for an in-flight Google request. The agent's Stop
/// button (see `cancel_google_request`) flips the watch to `true`; `send`
/// aborts at the next `select!` point (during egress or backoff) and returns a
/// non-retryable error. Cancelled reads never reach the provider's retry loop,
/// and cancelled mutations never execute — the side effect is avoided, not
/// duplicated.
type CancelSender = tokio::sync::watch::Sender<bool>;

/// Registry of in-flight Google requests keyed by a Fable-assigned call id, so
/// the UI can request cancellation of a specific read/action. Mirrors the
/// streaming-backend cancel map in `native_api.rs`. Entries are removed by
/// `scoped_cancel` on completion (success, error, or panic path via drop).
static CANCEL_REGISTRY: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, CancelSender>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

/// Register a new cancel token for a Google request and return the receiver
/// `send` polls. Generating a fresh call id per request keeps cancellation
/// precise: cancelling one search never aborts another.
fn register_cancel(call_id: &str) -> tokio::sync::watch::Receiver<bool> {
    let (tx, rx) = tokio::sync::watch::channel(false);
    CANCEL_REGISTRY
        .lock()
        .expect("cancel registry poisoned")
        .insert(call_id.to_string(), tx);
    rx
}

/// Remove a call id from the registry (called when the request completes). Any
/// later cancel for that id is a no-op.
fn unregister_cancel(call_id: &str) {
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
#[tauri::command]
pub fn cancel_google_call(call_id: String) -> bool {
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

async fn send(
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

async fn read_bounded_response(
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
            "Google response exceeds Fable's safe import limit.",
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
                "Google response exceeds Fable's safe import limit.",
                false,
            ));
        }
        output.extend_from_slice(&chunk);
    }
}

/// Wait until the cancel watch reports cancellation. A small helper keeps the
/// `select!` branches readable and avoids borrowing the receiver inline.
async fn cancel_changed(rx: &mut tokio::sync::watch::Receiver<bool>) {
    if *rx.borrow() {
        return;
    }
    let _ = rx.changed().await;
}

/// Backoff between retry attempts, abortable by a cooperative cancel. Honors
/// the provider's `Retry-After` when present, otherwise exponential with a 2s
/// cap. A cancel during backoff fails fast with a cancelled error.
async fn backoff(
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

fn cancelled_error(connector_id: &str) -> ConnectorCommandError {
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
fn maybe_applied_error(connector_id: &str, method: &Method) -> ConnectorCommandError {
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

async fn send_json(
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

async fn send_raw_json(
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

fn string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

fn strings(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}

fn epoch_string() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string()
}

fn escape_drive_query(value: &str) -> String {
    value.replace('\\', "\\\\").replace('\'', "\\'")
}

fn drive_item(value: &Value) -> Result<ConnectorSearchItem, ConnectorCommandError> {
    let id = string(value, "id").ok_or_else(|| {
        error(
            "google-drive",
            "provider-unavailable",
            "Drive file has no id.",
            false,
        )
    })?;
    let name = string(value, "name").unwrap_or_else(|| "Untitled Drive item".to_string());
    let mime = string(value, "mimeType").unwrap_or_default();
    let kind = if mime == "application/vnd.google-apps.folder" {
        "folder"
    } else {
        "file"
    };
    let mut metadata = BTreeMap::from([
        ("mimeType".to_string(), mime.clone()),
        ("selected".to_string(), "true".to_string()),
    ]);
    if let Some(parents) = value.get("parents").and_then(Value::as_array) {
        metadata.insert(
            "parents".to_string(),
            parents
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(","),
        );
    }
    Ok(ConnectorSearchItem {
        id,
        connector_id: "google-drive".to_string(),
        title: name,
        kind: kind.to_string(),
        summary: if mime == "application/vnd.google-apps.folder" {
            "Google Drive folder".to_string()
        } else {
            format!("Google Drive file ({mime})")
        },
        provenance: "Google Drive · authenticated account".to_string(),
        freshness: string(value, "modifiedTime").unwrap_or_else(|| "Unknown".to_string()),
        trust: "untrusted".to_string(),
        url: string(value, "webViewLink"),
        content_preview: None,
        provider_metadata: metadata,
    })
}

fn gmail_header(value: &Value, name: &str) -> Option<String> {
    value
        .pointer("/payload/headers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|header| {
            header
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(|candidate| candidate.eq_ignore_ascii_case(name))
        })
        .and_then(|header| header.get("value"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn gmail_item(value: &Value) -> Result<ConnectorSearchItem, ConnectorCommandError> {
    let id = string(value, "id").ok_or_else(|| {
        error(
            "gmail",
            "provider-unavailable",
            "Gmail message has no id.",
            false,
        )
    })?;
    let thread_id = string(value, "threadId").unwrap_or_else(|| id.clone());
    let from = gmail_header(value, "From").unwrap_or_else(|| "Unknown sender".to_string());
    let subject = gmail_header(value, "Subject").unwrap_or_else(|| "(No subject)".to_string());
    Ok(ConnectorSearchItem {
        id,
        connector_id: "gmail".to_string(),
        title: subject,
        kind: "message".to_string(),
        summary: format!("Message from {from}"),
        provenance: "Gmail · authenticated mailbox".to_string(),
        freshness: gmail_header(value, "Date")
            .or_else(|| string(value, "internalDate"))
            .unwrap_or_else(|| "Unknown".to_string()),
        trust: "untrusted".to_string(),
        url: None,
        content_preview: string(value, "snippet")
            .map(|value| truncate_characters(&value, MAX_PREVIEW_CHARACTERS)),
        provider_metadata: BTreeMap::from([
            ("threadId".to_string(), thread_id),
            ("from".to_string(), from),
            ("labels".to_string(), strings(value, "labelIds").join(",")),
        ]),
    })
}

fn calendar_item(
    value: &Value,
    calendar_id: &str,
) -> Result<ConnectorSearchItem, ConnectorCommandError> {
    let id = string(value, "id").ok_or_else(|| {
        error(
            "google-calendar",
            "provider-unavailable",
            "Calendar resource has no id.",
            false,
        )
    })?;
    let is_calendar = value.get("summaryOverride").is_some() || value.get("accessRole").is_some();
    let title = string(value, "summaryOverride")
        .or_else(|| string(value, "summary"))
        .unwrap_or_else(|| "Untitled calendar item".to_string());
    let start = value
        .pointer("/start/dateTime")
        .or_else(|| value.pointer("/start/date"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let end = value
        .pointer("/end/dateTime")
        .or_else(|| value.pointer("/end/date"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let mut metadata = BTreeMap::from([("calendarId".to_string(), calendar_id.to_string())]);
    if let Some(start) = start.as_ref() {
        metadata.insert("start".to_string(), start.clone());
    }
    if let Some(end) = end.as_ref() {
        metadata.insert("end".to_string(), end.clone());
    }
    if let Some(status) = string(value, "status") {
        metadata.insert("status".to_string(), status);
    }
    Ok(ConnectorSearchItem {
        id,
        connector_id: "google-calendar".to_string(),
        title,
        kind: if is_calendar { "calendar" } else { "event" }.to_string(),
        summary: string(value, "description").unwrap_or_else(|| {
            if is_calendar {
                "Accessible Google calendar"
            } else {
                "Google calendar event"
            }
            .to_string()
        }),
        provenance: format!("Google Calendar · {calendar_id}"),
        freshness: start.unwrap_or_else(|| "Unknown".to_string()),
        trust: "untrusted".to_string(),
        url: string(value, "htmlLink"),
        content_preview: string(value, "description")
            .map(|value| truncate_characters(&value, MAX_PREVIEW_CHARACTERS)),
        provider_metadata: metadata,
    })
}

pub(crate) async fn search(
    app: &tauri::AppHandle,
    request: ConnectorSearchRequest,
) -> Result<ConnectorSearchResult, ConnectorCommandError> {
    search_for_connection(app, request, None).await
}

pub(crate) async fn search_for_connection(
    app: &tauri::AppHandle,
    request: ConnectorSearchRequest,
    expected_connection_id: Option<&str>,
) -> Result<ConnectorSearchResult, ConnectorCommandError> {
    let connector_id = request.connector_id.clone();
    let call_id = new_call_id(&connector_id);
    let (_, tokens) =
        authorized_tokens_for_connection(app, &connector_id, expected_connection_id).await?;
    let limit = request.limit.unwrap_or(20).clamp(1, 50);
    let query = normalize_spaces(&request.query);
    let (items, next_cursor) = match connector_id.as_str() {
        "google-drive" => {
            drive_search(&call_id, &tokens, &query, limit, request.cursor.as_deref()).await?
        }
        "gmail" => {
            gmail_search(&call_id, &tokens, &query, limit, request.cursor.as_deref()).await?
        }
        "google-calendar" => {
            calendar_search(&call_id, &tokens, &query, limit, request.cursor.as_deref()).await?
        }
        _ => {
            return Err(error(
                &connector_id,
                "configuration-required",
                "Live search is not implemented for this connector.",
                false,
            ))
        }
    };
    Ok(ConnectorSearchResult {
        connector_id,
        query,
        items,
        next_cursor,
        source: "live".to_string(),
        searched_at: epoch_string(),
    })
}

async fn drive_search(
    call_id: &str,
    tokens: &StoredTokenSet,
    query: &str,
    limit: usize,
    cursor: Option<&str>,
) -> Result<(Vec<ConnectorSearchItem>, Option<String>), ConnectorCommandError> {
    require_scope(
        "google-drive",
        tokens,
        &[DRIVE_METADATA, DRIVE_READONLY, DRIVE_FILE],
    )?;
    let mut url = api_url(DRIVE_API, "files")?;
    let q = if query.is_empty() {
        "trashed = false".to_string()
    } else {
        format!(
            "trashed = false and fullText contains '{}'",
            escape_drive_query(query)
        )
    };
    url.query_pairs_mut()
        .append_pair("q", &q)
        .append_pair("pageSize", &limit.to_string())
        .append_pair("orderBy", "modifiedTime desc")
        .append_pair(
            "fields",
            "nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink,parents,size)",
        );
    if let Some(cursor) = cursor.filter(|value| !value.is_empty()) {
        url.query_pairs_mut().append_pair("pageToken", cursor);
    }
    let response = send_json(call_id, "google-drive", tokens, Method::GET, url, None).await?;
    let items = response
        .get("files")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            error(
                "google-drive",
                "provider-unavailable",
                "Drive response is missing files.",
                false,
            )
        })?
        .iter()
        .map(drive_item)
        .collect::<Result<Vec<_>, _>>()?;
    Ok((items, string(&response, "nextPageToken")))
}

async fn gmail_search(
    call_id: &str,
    tokens: &StoredTokenSet,
    query: &str,
    limit: usize,
    cursor: Option<&str>,
) -> Result<(Vec<ConnectorSearchItem>, Option<String>), ConnectorCommandError> {
    require_scope("gmail", tokens, &[GMAIL_READONLY])?;
    let mut url = api_url(GMAIL_API, "users/me/messages")?;
    url.query_pairs_mut()
        .append_pair("maxResults", &limit.to_string());
    if !query.is_empty() {
        url.query_pairs_mut().append_pair("q", query);
    }
    if let Some(cursor) = cursor.filter(|value| !value.is_empty()) {
        url.query_pairs_mut().append_pair("pageToken", cursor);
    }
    let response = send_json(call_id, "gmail", tokens, Method::GET, url, None).await?;
    let ids = response
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut items = Vec::with_capacity(ids.len());
    for message in ids {
        let id = match string(&message, "id") {
            Some(id) => id,
            None => {
                // A malformed list entry must not abort the whole result; skip it
                // with a bounded placeholder so the user still gets the page.
                continue;
            }
        };
        let mut detail = api_url(GMAIL_API, &format!("users/me/messages/{id}"))?;
        detail
            .query_pairs_mut()
            .append_pair("format", "metadata")
            .append_pair("metadataHeaders", "Subject")
            .append_pair("metadataHeaders", "From")
            .append_pair("metadataHeaders", "Date");
        // Per-message detail failures degrade to a placeholder rather than
        // discarding the entire search page (partial-failure handling).
        match send_json(call_id, "gmail", tokens, Method::GET, detail, None).await {
            Ok(value) => match gmail_item(&value) {
                Ok(item) => items.push(item),
                Err(_) => items.push(unreadable_message_item(&id)),
            },
            Err(failure) if failure.code == "cancelled" => return Err(failure),
            Err(_) => items.push(unreadable_message_item(&id)),
        }
    }
    Ok((items, string(&response, "nextPageToken")))
}

/// A bounded placeholder for a Gmail message whose details could not be read,
/// so a single sub-fetch failure never blanks the whole search page.
fn unreadable_message_item(id: &str) -> ConnectorSearchItem {
    ConnectorSearchItem {
        id: id.to_string(),
        connector_id: "gmail".to_string(),
        title: "(message unavailable)".to_string(),
        kind: "message".to_string(),
        summary: "This message could not be read from Gmail.".to_string(),
        provenance: "Gmail · authenticated mailbox".to_string(),
        freshness: "Unknown".to_string(),
        trust: "untrusted".to_string(),
        url: None,
        content_preview: None,
        provider_metadata: BTreeMap::new(),
    }
}

async fn calendar_search(
    call_id: &str,
    tokens: &StoredTokenSet,
    query: &str,
    limit: usize,
    cursor: Option<&str>,
) -> Result<(Vec<ConnectorSearchItem>, Option<String>), ConnectorCommandError> {
    if query.is_empty() {
        require_scope("google-calendar", tokens, &[CALENDAR_LIST])?;
        let mut url = api_url(CALENDAR_API, "users/me/calendarList")?;
        url.query_pairs_mut()
            .append_pair("maxResults", &limit.to_string());
        if let Some(cursor) = cursor.filter(|value| !value.is_empty()) {
            url.query_pairs_mut().append_pair("pageToken", cursor);
        }
        let response =
            send_json(call_id, "google-calendar", tokens, Method::GET, url, None).await?;
        let items = response
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|value| calendar_item(value, string(value, "id").as_deref().unwrap_or("unknown")))
            .collect::<Result<Vec<_>, _>>()?;
        return Ok((items, string(&response, "nextPageToken")));
    }
    require_scope(
        "google-calendar",
        tokens,
        &[CALENDAR_READONLY, CALENDAR_EVENTS],
    )?;
    let mut url = api_url(CALENDAR_API, "calendars/primary/events")?;
    url.query_pairs_mut()
        .append_pair("q", query)
        .append_pair("singleEvents", "true")
        .append_pair("orderBy", "startTime")
        .append_pair("maxResults", &limit.to_string());
    if let Some(cursor) = cursor.filter(|value| !value.is_empty()) {
        url.query_pairs_mut().append_pair("pageToken", cursor);
    }
    let response = send_json(call_id, "google-calendar", tokens, Method::GET, url, None).await?;
    let items = response
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|value| calendar_item(value, "primary"))
        .collect::<Result<Vec<_>, _>>()?;
    Ok((items, string(&response, "nextPageToken")))
}

pub(crate) async fn import(
    app: &tauri::AppHandle,
    request: ConnectorImportRequest,
) -> Result<ConnectorImportResult, ConnectorCommandError> {
    let connector_id = request.connector_id.clone();
    let call_id = new_call_id(&connector_id);
    let (_, tokens) = authorized_tokens(app, &connector_id).await?;
    let preview = match connector_id.as_str() {
        "google-drive" => drive_content(&call_id, &tokens, &request.item).await?,
        "gmail" => gmail_thread_content(&call_id, &tokens, &request.item).await?,
        "google-calendar" => calendar_content(&call_id, &tokens, &request.item).await?,
        _ => {
            return Err(error(
                &connector_id,
                "configuration-required",
                "Live import is not implemented for this connector.",
                false,
            ))
        }
    };
    let source = ConnectorKnowledgeSource {
        id: format!("connector-{}-{}", connector_id, request.item.id),
        title: request.item.title,
        kind: if request.item.kind == "event" || request.item.kind == "calendar" {
            "folder".to_string()
        } else {
            "document".to_string()
        },
        connector_id,
        provenance: request.item.provenance,
        freshness: request.item.freshness,
        pinned: false,
        trust: "untrusted".to_string(),
        content_preview: Some(truncate_characters(&preview, MAX_PREVIEW_CHARACTERS)),
        imported_at: request.imported_at,
        origin: "connector-import".to_string(),
        provider_metadata: request.item.provider_metadata,
    };
    Ok(ConnectorImportResult {
        source,
        imported: true,
    })
}

async fn drive_content(
    call_id: &str,
    tokens: &StoredTokenSet,
    item: &ConnectorSearchItem,
) -> Result<String, ConnectorCommandError> {
    require_scope("google-drive", tokens, &[DRIVE_READONLY, DRIVE_FILE])?;
    let mime = item
        .provider_metadata
        .get("mimeType")
        .map(String::as_str)
        .unwrap_or("");
    let export = match mime {
        "application/vnd.google-apps.document" => Some("text/plain"),
        "application/vnd.google-apps.spreadsheet" => Some("text/csv"),
        "application/vnd.google-apps.presentation" => Some("text/plain"),
        "application/vnd.google-apps.folder" => return Ok(format!("Folder: {}", item.title)),
        _ => None,
    };
    let url = if let Some(export_mime) = export {
        let mut url = api_url(DRIVE_API, &format!("files/{}/export", item.id))?;
        url.query_pairs_mut().append_pair("mimeType", export_mime);
        url
    } else {
        let mut url = api_url(DRIVE_API, &format!("files/{}", item.id))?;
        url.query_pairs_mut().append_pair("alt", "media");
        url
    };
    // Keep the mutable binding explicit so future export parameters remain local.
    let (_, bytes) = send(
        call_id,
        "google-drive",
        tokens,
        Method::GET,
        url.clone(),
        None,
    )
    .await?;
    String::from_utf8(bytes).map_err(|_| {
        error(
            "google-drive",
            "invalid-request",
            "This Drive file is binary and cannot be imported as text.",
            false,
        )
    })
}

/// Decode a Gmail MIME part. `unreadable` accumulates a marker for any part
/// whose body fails base64 or UTF-8 decoding, so a corrupt part is surfaced to
/// the model/user rather than silently dropped (no silent data loss).
fn decode_gmail_part(
    value: &Value,
    output: &mut Vec<String>,
    attachments: &mut Vec<String>,
    unreadable: &mut Vec<String>,
) {
    if let Some(filename) = string(value, "filename").filter(|name| !name.is_empty()) {
        let mime =
            string(value, "mimeType").unwrap_or_else(|| "application/octet-stream".to_string());
        let size = value
            .pointer("/body/size")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        attachments.push(format!("{filename} ({mime}, {size} bytes)"));
    }
    if string(value, "mimeType").as_deref() == Some("text/plain") {
        if let Some(data) = value.pointer("/body/data").and_then(Value::as_str) {
            match URL_SAFE_NO_PAD.decode(data) {
                Ok(bytes) => match String::from_utf8(bytes) {
                    Ok(text) => output.push(text),
                    Err(_) => unreadable.push("[unreadable message part omitted]".to_string()),
                },
                Err(_) => unreadable.push("[unreadable message part omitted]".to_string()),
            }
        }
    }
    if let Some(parts) = value.get("parts").and_then(Value::as_array) {
        for part in parts {
            decode_gmail_part(part, output, attachments, unreadable);
        }
    }
}

async fn gmail_thread_content(
    call_id: &str,
    tokens: &StoredTokenSet,
    item: &ConnectorSearchItem,
) -> Result<String, ConnectorCommandError> {
    require_scope("gmail", tokens, &[GMAIL_READONLY])?;
    let thread_id = item
        .provider_metadata
        .get("threadId")
        .map(String::as_str)
        .unwrap_or(&item.id);
    let mut url = api_url(GMAIL_API, &format!("users/me/threads/{thread_id}"))?;
    url.query_pairs_mut().append_pair("format", "full");
    let response = send_json(call_id, "gmail", tokens, Method::GET, url, None).await?;
    let messages = response
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            error(
                "gmail",
                "provider-unavailable",
                "Gmail thread is malformed.",
                false,
            )
        })?;
    let mut rendered = Vec::new();
    for message in messages {
        let mut bodies = Vec::new();
        let mut attachments = Vec::new();
        let mut unreadable = Vec::new();
        if let Some(payload) = message.get("payload") {
            decode_gmail_part(payload, &mut bodies, &mut attachments, &mut unreadable);
        }
        if !unreadable.is_empty() {
            bodies.push(unreadable.join("\n"));
        }
        rendered.push(format!(
            "From: {}\nTo: {}\nSubject: {}\nDate: {}\n\n{}{}",
            gmail_header(message, "From").unwrap_or_default(),
            gmail_header(message, "To").unwrap_or_default(),
            gmail_header(message, "Subject").unwrap_or_default(),
            gmail_header(message, "Date").unwrap_or_default(),
            bodies.join("\n"),
            if attachments.is_empty() {
                String::new()
            } else {
                format!("\n\nAttachments: {}", attachments.join(", "))
            }
        ));
    }
    Ok(rendered.join("\n\n---\n\n"))
}

async fn calendar_content(
    call_id: &str,
    tokens: &StoredTokenSet,
    item: &ConnectorSearchItem,
) -> Result<String, ConnectorCommandError> {
    require_scope(
        "google-calendar",
        tokens,
        &[CALENDAR_READONLY, CALENDAR_EVENTS],
    )?;
    if item.kind == "calendar" {
        return serde_json::to_string_pretty(&json!({
            "id": item.id,
            "title": item.title,
            "metadata": item.provider_metadata,
        }))
        .map_err(|_| {
            error(
                "google-calendar",
                "unknown",
                "Calendar metadata could not be encoded.",
                false,
            )
        });
    }
    let calendar_id = item
        .provider_metadata
        .get("calendarId")
        .map(String::as_str)
        .unwrap_or("primary");
    let url = api_url(
        CALENDAR_API,
        &format!(
            "calendars/{}/events/{}",
            encode_segment(calendar_id),
            encode_segment(&item.id)
        ),
    )?;
    let value = send_json(call_id, "google-calendar", tokens, Method::GET, url, None).await?;
    serde_json::to_string_pretty(&value).map_err(|_| {
        error(
            "google-calendar",
            "unknown",
            "Calendar event could not be encoded.",
            false,
        )
    })
}

fn required<'a>(
    connector_id: &str,
    payload: &'a BTreeMap<String, String>,
    key: &str,
) -> Result<&'a str, ConnectorCommandError> {
    payload
        .get(key)
        .map(String::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            error(
                connector_id,
                "invalid-request",
                &format!("Action payload requires {key}."),
                false,
            )
        })
}

fn encode_segment(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

fn parse_json_field(
    connector_id: &str,
    payload: &BTreeMap<String, String>,
    key: &str,
) -> Result<Option<Value>, ConnectorCommandError> {
    payload
        .get(key)
        .filter(|value| !value.trim().is_empty())
        .map(|value| {
            serde_json::from_str(value).map_err(|_| {
                error(
                    connector_id,
                    "invalid-request",
                    &format!("Action payload field {key} must be valid JSON."),
                    false,
                )
            })
        })
        .transpose()
}

pub(crate) async fn execute_action(
    app: &tauri::AppHandle,
    action: &ConnectorActionRequest,
) -> Result<ConnectorActionResult, ConnectorCommandError> {
    let call_id = new_call_id(&action.connector_id);
    let (_, tokens) = authorized_tokens(app, &action.connector_id).await?;
    let resource_id = match action.connector_id.as_str() {
        "google-drive" => execute_drive_action(&call_id, &tokens, action).await?,
        "gmail" => execute_gmail_action(&call_id, &tokens, action).await?,
        "google-calendar" => execute_calendar_action(&call_id, &tokens, action).await?,
        _ => {
            return Err(error(
                &action.connector_id,
                "configuration-required",
                "Live actions are not implemented for this connector.",
                false,
            ))
        }
    };
    Ok(ConnectorActionResult {
        request_id: action.id.clone(),
        connector_id: action.connector_id.clone(),
        action: action.action.clone(),
        status: "completed".to_string(),
        message: "Google action completed after explicit approval.".to_string(),
        provider_resource_id: resource_id,
    })
}

async fn execute_drive_action(
    call_id: &str,
    tokens: &StoredTokenSet,
    action: &ConnectorActionRequest,
) -> Result<Option<String>, ConnectorCommandError> {
    require_scope("google-drive", tokens, &[DRIVE_FILE])?;
    let payload = &action.payload;
    let (method, url, body) = match action.action.as_str() {
        "google-drive.create-file" => {
            let mut metadata = json!({
                "name": required("google-drive", payload, "name")?,
                "mimeType": payload.get("mimeType").map(String::as_str).unwrap_or("text/plain")
            });
            if let Some(parents) = parse_json_field("google-drive", payload, "parents")? {
                metadata["parents"] = parents;
            }
            if let Some(content) = payload.get("content") {
                let mime_type = payload
                    .get("mimeType")
                    .map(String::as_str)
                    .unwrap_or("text/plain");
                let (content_type, body) = drive_multipart_body(&metadata, mime_type, content)?;
                let mut url = api_url(DRIVE_UPLOAD_API, "files")?;
                url.query_pairs_mut().append_pair("uploadType", "multipart");
                let value = send_raw_json(
                    call_id,
                    "google-drive",
                    tokens,
                    Method::POST,
                    url,
                    &content_type,
                    body,
                )
                .await?;
                return Ok(string(&value, "id"));
            }
            (Method::POST, api_url(DRIVE_API, "files")?, Some(metadata))
        }
        "google-drive.update-file" => {
            let id = required("google-drive", payload, "fileId")?;
            let content = required("google-drive", payload, "content")?;
            let mut url = api_url(DRIVE_UPLOAD_API, &format!("files/{}", encode_segment(id)))?;
            url.query_pairs_mut().append_pair("uploadType", "media");
            (Method::PATCH, url, Some(Value::String(content.to_string())))
        }
        "google-drive.move-file" => {
            let id = required("google-drive", payload, "fileId")?;
            let mut url = api_url(DRIVE_API, &format!("files/{}", encode_segment(id)))?;
            url.query_pairs_mut().append_pair(
                "addParents",
                required("google-drive", payload, "destinationFolderId")?,
            );
            if let Some(remove) = payload.get("removeParents") {
                url.query_pairs_mut().append_pair("removeParents", remove);
            }
            (Method::PATCH, url, Some(json!({})))
        }
        "google-drive.rename-file" => {
            let id = required("google-drive", payload, "fileId")?;
            (
                Method::PATCH,
                api_url(DRIVE_API, &format!("files/{}", encode_segment(id)))?,
                Some(json!({ "name": required("google-drive", payload, "name")? })),
            )
        }
        "google-drive.share-file" => {
            let id = required("google-drive", payload, "fileId")?;
            (
                Method::POST,
                api_url(
                    DRIVE_API,
                    &format!("files/{}/permissions", encode_segment(id)),
                )?,
                Some(json!({
                    "type": "user",
                    "role": payload.get("role").map(String::as_str).unwrap_or("reader"),
                    "emailAddress": required("google-drive", payload, "recipient")?
                })),
            )
        }
        "google-drive.delete-file" => {
            let id = required("google-drive", payload, "fileId")?;
            (
                Method::DELETE,
                api_url(DRIVE_API, &format!("files/{}", encode_segment(id)))?,
                None,
            )
        }
        _ => {
            return Err(error(
                "google-drive",
                "invalid-request",
                "Unsupported Drive action.",
                false,
            ))
        }
    };
    if action.action == "google-drive.update-file" {
        let content = required("google-drive", payload, "content")?;
        let value = send_raw_json(
            call_id,
            "google-drive",
            tokens,
            method,
            url,
            payload
                .get("mimeType")
                .map(String::as_str)
                .unwrap_or("text/plain"),
            content.as_bytes().to_vec(),
        )
        .await?;
        return Ok(string(&value, "id").or_else(|| payload.get("fileId").cloned()));
    }
    let value = send_json(call_id, "google-drive", tokens, method, url, body).await?;
    Ok(string(&value, "id").or_else(|| payload.get("fileId").cloned()))
}

fn drive_multipart_body(
    metadata: &Value,
    mime_type: &str,
    content: &str,
) -> Result<(String, Vec<u8>), ConnectorCommandError> {
    if mime_type.contains(['\r', '\n']) {
        return Err(error(
            "google-drive",
            "invalid-request",
            "Drive MIME type is invalid.",
            false,
        ));
    }
    let boundary = "fable-google-drive-upload";
    let metadata = serde_json::to_string(metadata).map_err(|_| {
        error(
            "google-drive",
            "invalid-request",
            "Drive metadata could not be encoded.",
            false,
        )
    })?;
    let body = format!(
        "--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{metadata}\r\n--{boundary}\r\nContent-Type: {mime_type}\r\n\r\n{content}\r\n--{boundary}--\r\n"
    );
    Ok((
        format!("multipart/related; boundary={boundary}"),
        body.into_bytes(),
    ))
}

fn safe_header(value: &str) -> Result<&str, ConnectorCommandError> {
    if value.contains('\r') || value.contains('\n') {
        Err(error(
            "gmail",
            "invalid-request",
            "Email headers cannot contain line breaks.",
            false,
        ))
    } else {
        Ok(value)
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GmailAttachmentInput {
    filename: String,
    #[serde(default = "default_attachment_mime")]
    mime_type: String,
    data_base64: String,
}

fn default_attachment_mime() -> String {
    "application/octet-stream".to_string()
}

fn build_mime(payload: &BTreeMap<String, String>) -> Result<String, ConnectorCommandError> {
    let to = safe_header(required("gmail", payload, "to")?)?;
    let subject = safe_header(required("gmail", payload, "subject")?)?;
    let mut headers = vec![format!("To: {to}"), format!("Subject: {subject}")];
    for (key, label) in [("cc", "Cc"), ("bcc", "Bcc"), ("inReplyTo", "In-Reply-To")] {
        if let Some(value) = payload.get(key).filter(|value| !value.trim().is_empty()) {
            headers.push(format!("{label}: {}", safe_header(value)?));
        }
    }
    headers.push("MIME-Version: 1.0".to_string());
    let body = payload.get("body").cloned().unwrap_or_default();
    let attachments = match payload.get("attachments") {
        Some(value) if !value.trim().is_empty() => serde_json::from_str::<Vec<GmailAttachmentInput>>(value)
            .map_err(|_| error("gmail", "invalid-request", "Email attachments must be a JSON array of filename, mimeType, and dataBase64 values.", false))?,
        _ => Vec::new(),
    };
    if attachments.is_empty() {
        headers.push("Content-Type: text/plain; charset=UTF-8".to_string());
        return Ok(format!("{}\r\n\r\n{body}", headers.join("\r\n")));
    }

    let boundary = "fable-gmail-attachment";
    headers.push(format!(
        "Content-Type: multipart/mixed; boundary={boundary}"
    ));
    let mut parts = vec![format!(
        "--{boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n{body}\r\n"
    )];
    for attachment in attachments {
        let filename = safe_header(attachment.filename.trim())?;
        let mime_type = safe_header(attachment.mime_type.trim())?;
        let decoded = STANDARD
            .decode(attachment.data_base64.trim())
            .map_err(|_| {
                error(
                    "gmail",
                    "invalid-request",
                    "Email attachment dataBase64 is invalid.",
                    false,
                )
            })?;
        let encoded = STANDARD.encode(decoded);
        parts.push(format!(
            "--{boundary}\r\nContent-Type: {mime_type}\r\nContent-Disposition: attachment; filename=\"{filename}\"\r\nContent-Transfer-Encoding: base64\r\n\r\n{encoded}\r\n"
        ));
    }
    parts.push(format!("--{boundary}--\r\n"));
    Ok(format!(
        "{}\r\n\r\n{}",
        headers.join("\r\n"),
        parts.join("")
    ))
}

async fn execute_gmail_action(
    call_id: &str,
    tokens: &StoredTokenSet,
    action: &ConnectorActionRequest,
) -> Result<Option<String>, ConnectorCommandError> {
    let payload = &action.payload;
    let (url, body) = match action.action.as_str() {
        "gmail.create-draft" => {
            require_scope("gmail", tokens, &[GMAIL_COMPOSE])?;
            let raw = URL_SAFE_NO_PAD.encode(build_mime(payload)?);
            let mut message = json!({ "raw": raw });
            if let Some(thread_id) = payload.get("threadId").filter(|value| !value.is_empty()) {
                message["threadId"] = Value::String(thread_id.clone());
            }
            (
                api_url(GMAIL_API, "users/me/drafts")?,
                json!({ "message": message }),
            )
        }
        "gmail.send" => {
            require_scope("gmail", tokens, &[GMAIL_SEND, GMAIL_COMPOSE])?;
            if let Some(draft_id) = payload.get("draftId").filter(|value| !value.is_empty()) {
                (
                    api_url(GMAIL_API, "users/me/drafts/send")?,
                    json!({ "id": draft_id }),
                )
            } else {
                let raw = URL_SAFE_NO_PAD.encode(build_mime(payload)?);
                let mut message = json!({ "raw": raw });
                if let Some(thread_id) = payload.get("threadId").filter(|value| !value.is_empty()) {
                    message["threadId"] = Value::String(thread_id.clone());
                }
                (api_url(GMAIL_API, "users/me/messages/send")?, message)
            }
        }
        _ => {
            return Err(error(
                "gmail",
                "invalid-request",
                "Unsupported Gmail action.",
                false,
            ))
        }
    };
    let value = send_json(call_id, "gmail", tokens, Method::POST, url, Some(body)).await?;
    Ok(string(&value, "id").or_else(|| {
        value
            .pointer("/message/id")
            .and_then(Value::as_str)
            .map(str::to_string)
    }))
}

fn calendar_event_body(payload: &BTreeMap<String, String>) -> Result<Value, ConnectorCommandError> {
    let mut event = json!({
        "summary": required("google-calendar", payload, "title")?,
        "start": {
            "dateTime": required("google-calendar", payload, "start")?,
            "timeZone": required("google-calendar", payload, "timezone")?
        },
        "end": {
            "dateTime": required("google-calendar", payload, "end")?,
            "timeZone": required("google-calendar", payload, "timezone")?
        }
    });
    for key in ["description", "location"] {
        if let Some(value) = payload.get(key).filter(|value| !value.trim().is_empty()) {
            event[key] = Value::String(value.clone());
        }
    }
    if let Some(attendees) = parse_json_field("google-calendar", payload, "attendees")? {
        event["attendees"] = attendees;
    }
    if let Some(recurrence) = parse_json_field("google-calendar", payload, "recurrence")? {
        event["recurrence"] = recurrence;
    }
    Ok(event)
}

async fn execute_calendar_action(
    call_id: &str,
    tokens: &StoredTokenSet,
    action: &ConnectorActionRequest,
) -> Result<Option<String>, ConnectorCommandError> {
    require_scope("google-calendar", tokens, &[CALENDAR_EVENTS])?;
    let payload = &action.payload;
    let calendar_id = required("google-calendar", payload, "calendarId")?;
    let (method, mut url, body) = match action.action.as_str() {
        "google-calendar.create-draft" => (
            Method::POST,
            api_url(
                CALENDAR_API,
                &format!("calendars/{}/events", encode_segment(calendar_id)),
            )?,
            Some(calendar_event_body(payload)?),
        ),
        "google-calendar.update-draft" => (
            Method::PATCH,
            api_url(
                CALENDAR_API,
                &format!(
                    "calendars/{}/events/{}",
                    encode_segment(calendar_id),
                    encode_segment(required("google-calendar", payload, "eventId")?)
                ),
            )?,
            Some(calendar_event_body(payload)?),
        ),
        "google-calendar.delete-event" => (
            Method::DELETE,
            api_url(
                CALENDAR_API,
                &format!(
                    "calendars/{}/events/{}",
                    encode_segment(calendar_id),
                    encode_segment(required("google-calendar", payload, "eventId")?)
                ),
            )?,
            None,
        ),
        "google-calendar.cancel-event" => (
            Method::PATCH,
            api_url(
                CALENDAR_API,
                &format!(
                    "calendars/{}/events/{}",
                    encode_segment(calendar_id),
                    encode_segment(required("google-calendar", payload, "eventId")?)
                ),
            )?,
            Some(json!({ "status": "cancelled" })),
        ),
        _ => {
            return Err(error(
                "google-calendar",
                "invalid-request",
                "Unsupported Calendar action.",
                false,
            ))
        }
    };
    if payload
        .get("notifyAttendees")
        .is_some_and(|value| value == "true")
    {
        url.query_pairs_mut().append_pair("sendUpdates", "all");
    } else {
        url.query_pairs_mut().append_pair("sendUpdates", "none");
    }
    let value = send_json(call_id, "google-calendar", tokens, method, url, body).await?;
    Ok(string(&value, "id").or_else(|| payload.get("eventId").cloned()))
}

/// Live health probe for Google connectors. A successful userinfo read is a
/// healthy connection; a normalized provider error maps to degraded/error.
pub(crate) async fn probe_health(app: &tauri::AppHandle, connector_id: &str) -> ConnectorHealth {
    let call_id = new_call_id(connector_id);
    let checked_at = epoch_string();
    let tokens = match authorized_tokens(app, connector_id).await {
        Ok(pair) => pair.1,
        Err(failure) => {
            return ConnectorHealth {
                state: if failure.retryable {
                    "degraded".to_string()
                } else {
                    "error".to_string()
                },
                summary: failure.message,
                checked_at,
                retry_after: failure.retry_after,
            }
        }
    };
    let url = match api_url("https://openidconnect.googleapis.com/v1/", "userinfo") {
        Ok(url) => url,
        Err(failure) => {
            return ConnectorHealth {
                state: "error".to_string(),
                summary: failure.message,
                checked_at,
                retry_after: None,
            }
        }
    };
    match send_json(&call_id, connector_id, &tokens, Method::GET, url, None).await {
        Ok(value) => {
            let email = string(&value, "email");
            let name = string(&value, "name").or_else(|| email.clone());
            ConnectorHealth {
                state: "healthy".to_string(),
                summary: match name.as_deref() {
                    Some(label) => format!("Connected as {label}."),
                    None => "Connected; Google identity verified.".to_string(),
                },
                checked_at,
                retry_after: None,
            }
        }
        Err(failure) => ConnectorHealth {
            state: if failure.retryable {
                "degraded".to_string()
            } else {
                "error".to_string()
            },
            summary: failure.message,
            checked_at,
            retry_after: failure.retry_after,
        },
    }
}

/// Read-only Google capabilities exposed to the native model tool runtime.
pub(crate) async fn execute_read_tool(
    app: &tauri::AppHandle,
    tool: &str,
    arguments: &Value,
) -> Result<String, ConnectorCommandError> {
    let object = arguments.as_object().ok_or_else(|| {
        error(
            "google",
            "invalid-request",
            "Google tool arguments must be an object.",
            false,
        )
    })?;
    let operation = object
        .get("operation")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            error(
                "google",
                "invalid-request",
                "Google tool operation is required.",
                false,
            )
        })?;
    let connector_id = match tool {
        "google-drive-read" => "google-drive",
        "gmail-read" => "gmail",
        "google-calendar-read" => "google-calendar",
        _ => {
            return Err(error(
                "google",
                "invalid-request",
                "Unknown Google read tool.",
                false,
            ))
        }
    };
    let call_id = new_call_id(connector_id);
    let value = run_read_operation(app, &call_id, connector_id, operation, object).await?;
    let encoded = serde_json::to_string(&value).map_err(|_| {
        error(
            connector_id,
            "unknown",
            "Google result could not be encoded.",
            false,
        )
    })?;
    if encoded.chars().count() > MAX_PREVIEW_CHARACTERS {
        return serde_json::to_string(&json!({
            "truncated": true,
            "contentPreview": truncate_characters(&encoded, MAX_PREVIEW_CHARACTERS),
        }))
        .map_err(|_| {
            error(
                connector_id,
                "unknown",
                "Google result could not be bounded.",
                false,
            )
        });
    }
    Ok(encoded)
}

/// Resolve a single read operation against Google. Kept separate so the
/// public tool entry can own the cancel scope while this owns the (connector,
/// operation) fan-out. `call_id` threads the cancel token into every egress.
async fn run_read_operation(
    app: &tauri::AppHandle,
    call_id: &str,
    connector_id: &str,
    operation: &str,
    object: &serde_json::Map<String, Value>,
) -> Result<Value, ConnectorCommandError> {
    let (_connection, tokens) = authorized_tokens(app, connector_id).await?;
    let value = match (connector_id, operation) {
        ("google-drive", "search") => {
            let query = object.get("query").and_then(Value::as_str).unwrap_or("");
            let (items, cursor) = drive_search(
                call_id,
                &tokens,
                query,
                20,
                object.get("cursor").and_then(Value::as_str),
            )
            .await?;
            json!({ "items": items, "nextCursor": cursor })
        }
        ("google-drive", "metadata") => {
            require_scope(
                connector_id,
                &tokens,
                &[DRIVE_METADATA, DRIVE_READONLY, DRIVE_FILE],
            )?;
            let file_id = object
                .get("fileId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    error(
                        connector_id,
                        "invalid-request",
                        "fileId is required.",
                        false,
                    )
                })?;
            let mut url = api_url(DRIVE_API, &format!("files/{}", encode_segment(file_id)))?;
            url.query_pairs_mut().append_pair("fields", "id,name,mimeType,modifiedTime,webViewLink,parents,size,owners(displayName,emailAddress)");
            send_json(call_id, connector_id, &tokens, Method::GET, url, None).await?
        }
        ("google-drive", "children") => {
            require_scope(
                connector_id,
                &tokens,
                &[DRIVE_METADATA, DRIVE_READONLY, DRIVE_FILE],
            )?;
            let folder_id = object
                .get("folderId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    error(
                        connector_id,
                        "invalid-request",
                        "folderId is required.",
                        false,
                    )
                })?;
            let limit = object
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(50)
                .clamp(1, 50);
            let mut url = api_url(DRIVE_API, "files")?;
            url.query_pairs_mut()
                .append_pair(
                    "q",
                    &format!(
                        "'{}' in parents and trashed = false",
                        escape_drive_query(folder_id)
                    ),
                )
                .append_pair("pageSize", &limit.to_string())
                .append_pair("orderBy", "folder,name")
                .append_pair(
                    "fields",
                    "nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink,parents,size)",
                );
            if let Some(cursor) = object.get("cursor").and_then(Value::as_str) {
                url.query_pairs_mut().append_pair("pageToken", cursor);
            }
            let response =
                send_json(call_id, connector_id, &tokens, Method::GET, url, None).await?;
            let items = response
                .get("files")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    error(
                        connector_id,
                        "provider-unavailable",
                        "Drive response is missing files.",
                        false,
                    )
                })?
                .iter()
                .map(drive_item)
                .collect::<Result<Vec<_>, _>>()?;
            json!({ "items": items, "nextCursor": string(&response, "nextPageToken") })
        }
        ("gmail", "search") => {
            let query = object.get("query").and_then(Value::as_str).unwrap_or("");
            let (items, cursor) = gmail_search(
                call_id,
                &tokens,
                query,
                20,
                object.get("cursor").and_then(Value::as_str),
            )
            .await?;
            json!({ "items": items, "nextCursor": cursor })
        }
        ("gmail", "message") => {
            require_scope(connector_id, &tokens, &[GMAIL_READONLY])?;
            let id = object
                .get("messageId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    error(
                        connector_id,
                        "invalid-request",
                        "messageId is required.",
                        false,
                    )
                })?;
            let mut url = api_url(
                GMAIL_API,
                &format!("users/me/messages/{}", encode_segment(id)),
            )?;
            url.query_pairs_mut().append_pair("format", "full");
            send_json(call_id, connector_id, &tokens, Method::GET, url, None).await?
        }
        ("gmail", "thread") => {
            require_scope(connector_id, &tokens, &[GMAIL_READONLY])?;
            let id = object
                .get("threadId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    error(
                        connector_id,
                        "invalid-request",
                        "threadId is required.",
                        false,
                    )
                })?;
            let mut url = api_url(
                GMAIL_API,
                &format!("users/me/threads/{}", encode_segment(id)),
            )?;
            url.query_pairs_mut().append_pair("format", "full");
            send_json(call_id, connector_id, &tokens, Method::GET, url, None).await?
        }
        ("google-calendar", "calendars") => {
            require_scope(connector_id, &tokens, &[CALENDAR_LIST])?;
            let mut url = api_url(CALENDAR_API, "users/me/calendarList")?;
            if let Some(cursor) = object.get("cursor").and_then(Value::as_str) {
                url.query_pairs_mut().append_pair("pageToken", cursor);
            }
            url.query_pairs_mut().append_pair("maxResults", "50");
            send_json(call_id, connector_id, &tokens, Method::GET, url, None).await?
        }
        ("google-calendar", "events") => {
            require_scope(connector_id, &tokens, &[CALENDAR_READONLY, CALENDAR_EVENTS])?;
            let calendar = object
                .get("calendarId")
                .and_then(Value::as_str)
                .unwrap_or("primary");
            let mut url = api_url(
                CALENDAR_API,
                &format!("calendars/{}/events", encode_segment(calendar)),
            )?;
            for key in ["q", "timeMin", "timeMax", "pageToken"] {
                if let Some(value) = object.get(key).and_then(Value::as_str) {
                    url.query_pairs_mut().append_pair(key, value);
                }
            }
            url.query_pairs_mut()
                .append_pair("singleEvents", "true")
                .append_pair("orderBy", "startTime");
            send_json(call_id, connector_id, &tokens, Method::GET, url, None).await?
        }
        ("google-calendar", "event") => {
            require_scope(connector_id, &tokens, &[CALENDAR_READONLY, CALENDAR_EVENTS])?;
            let calendar = object
                .get("calendarId")
                .and_then(Value::as_str)
                .unwrap_or("primary");
            let event = object
                .get("eventId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    error(
                        connector_id,
                        "invalid-request",
                        "eventId is required.",
                        false,
                    )
                })?;
            let url = api_url(
                CALENDAR_API,
                &format!(
                    "calendars/{}/events/{}",
                    encode_segment(calendar),
                    encode_segment(event)
                ),
            )?;
            send_json(call_id, connector_id, &tokens, Method::GET, url, None).await?
        }
        ("google-calendar", "freebusy") => {
            require_scope(connector_id, &tokens, &[CALENDAR_READONLY, CALENDAR_EVENTS])?;
            let time_min = object
                .get("timeMin")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    error(
                        connector_id,
                        "invalid-request",
                        "timeMin is required.",
                        false,
                    )
                })?;
            let time_max = object
                .get("timeMax")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    error(
                        connector_id,
                        "invalid-request",
                        "timeMax is required.",
                        false,
                    )
                })?;
            let calendars = object
                .get("calendarIds")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    error(
                        connector_id,
                        "invalid-request",
                        "calendarIds is required.",
                        false,
                    )
                })?;
            let items = calendars
                .iter()
                .filter_map(Value::as_str)
                .map(|id| json!({ "id": id }))
                .collect::<Vec<_>>();
            let url = api_url(CALENDAR_API, "freeBusy")?;
            send_json(
                call_id,
                connector_id,
                &tokens,
                Method::POST,
                url,
                Some(json!({ "timeMin": time_min, "timeMax": time_max, "items": items })),
            )
            .await?
        }
        _ => {
            return Err(error(
                connector_id,
                "invalid-request",
                "Unsupported Google read operation.",
                false,
            ))
        }
    };
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::oneshot;

    async fn mock_response(
        status: &str,
        body: &str,
        delay_ms: u64,
    ) -> (Url, oneshot::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let status = status.to_string();
        let body = body.to_string();
        let (request_tx, request_rx) = oneshot::channel();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buffer = vec![0_u8; 16 * 1024];
            let read = stream.read(&mut buffer).await.unwrap();
            let request = String::from_utf8_lossy(&buffer[..read]).to_string();
            let _ = request_tx.send(request);
            if delay_ms > 0 {
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            }
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes()).await;
        });
        (
            Url::parse(&format!("http://{address}/google-contract")).unwrap(),
            request_rx,
        )
    }

    fn tokens(scopes: &[&str]) -> StoredTokenSet {
        StoredTokenSet {
            access_token: "test-token".to_string(),
            refresh_token: Some("test-refresh".to_string()),
            token_type: "Bearer".to_string(),
            expires_at: None,
            scopes: scopes.iter().map(|scope| scope.to_string()).collect(),
            revocation_endpoint: None,
            token_endpoint: Some("https://example.invalid/token".to_string()),
            handoff_endpoint: None,
            client_id: "test-client".to_string(),
            brokered: false,
        }
    }

    #[test]
    fn partial_scopes_never_claim_ungranted_access() {
        let tokens = tokens(&[GMAIL_READONLY]);
        assert!(require_scope("gmail", &tokens, &[GMAIL_READONLY]).is_ok());
        assert_eq!(
            require_scope("gmail", &tokens, &[GMAIL_COMPOSE])
                .expect_err("compose must be missing")
                .code,
            "permission-denied"
        );
    }

    #[test]
    fn provider_errors_normalize_rate_limit_missing_and_expiry() {
        assert_eq!(
            provider_error("gmail", StatusCode::UNAUTHORIZED, None).code,
            "expired-auth"
        );
        assert_eq!(
            provider_error("gmail", StatusCode::NOT_FOUND, None).code,
            "not-found"
        );
        let limited = provider_error("gmail", StatusCode::TOO_MANY_REQUESTS, Some("3".into()));
        assert_eq!(limited.code, "rate-limited");
        assert!(limited.retryable);
        assert_eq!(limited.retry_after.as_deref(), Some("3"));
    }

    #[test]
    fn drive_query_escapes_provider_syntax() {
        assert_eq!(escape_drive_query("Josh's \\ file"), "Josh\\'s \\\\ file");
    }

    #[test]
    fn gmail_normalization_rejects_malformed_messages() {
        let malformed = json!({ "threadId": "thread-1" });
        assert_eq!(
            gmail_item(&malformed).expect_err("id required").code,
            "provider-unavailable"
        );
    }

    #[test]
    fn gmail_mime_rejects_header_injection_and_maps_replies() {
        let injected = BTreeMap::from([
            (
                "to".to_string(),
                "victim@example.com\r\nBcc: attacker@example.com".to_string(),
            ),
            ("subject".to_string(), "Hello".to_string()),
        ]);
        assert!(build_mime(&injected).is_err());
        let reply = BTreeMap::from([
            ("to".to_string(), "person@example.com".to_string()),
            ("subject".to_string(), "Re: Hello".to_string()),
            ("body".to_string(), "Reply".to_string()),
            ("inReplyTo".to_string(), "<message@example.com>".to_string()),
        ]);
        assert!(build_mime(&reply).unwrap().contains("In-Reply-To"));
    }

    #[test]
    fn calendar_request_maps_attendees_recurrence_and_timezone() {
        let payload = BTreeMap::from([
            ("title".to_string(), "Planning".to_string()),
            ("start".to_string(), "2026-07-01T10:00:00+01:00".to_string()),
            ("end".to_string(), "2026-07-01T10:30:00+01:00".to_string()),
            ("timezone".to_string(), "Europe/London".to_string()),
            (
                "attendees".to_string(),
                "[{\"email\":\"person@example.com\"}]".to_string(),
            ),
            (
                "recurrence".to_string(),
                "[\"RRULE:FREQ=WEEKLY\"]".to_string(),
            ),
        ]);
        let event = calendar_event_body(&payload).unwrap();
        assert_eq!(
            event.pointer("/start/timeZone").and_then(Value::as_str),
            Some("Europe/London")
        );
        assert_eq!(
            event.pointer("/attendees/0/email").and_then(Value::as_str),
            Some("person@example.com")
        );
    }

    #[tokio::test]
    async fn mocked_http_contract_sends_auth_and_exact_write_body() {
        let (url, request) = mock_response("200 OK", r#"{"id":"created"}"#, 0).await;
        let value = send_json(
            "write-contract",
            "google-drive",
            &tokens(&[DRIVE_FILE]),
            Method::POST,
            url,
            Some(json!({ "name": "Roadmap", "parents": ["folder-1"] })),
        )
        .await
        .unwrap();
        assert_eq!(value.get("id").and_then(Value::as_str), Some("created"));
        let request = request.await.unwrap();
        assert!(request.starts_with("POST /google-contract HTTP/1.1"));
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: bearer test-token"));
        assert!(request.contains(r#"{"name":"Roadmap","parents":["folder-1"]}"#));
    }

    #[tokio::test]
    async fn mocked_http_contract_rejects_malformed_and_honors_cancellation() {
        let (bad_url, _) = mock_response("200 OK", "not-json", 0).await;
        let malformed = send_json(
            "malformed-contract",
            "gmail",
            &tokens(&[GMAIL_READONLY]),
            Method::GET,
            bad_url,
            None,
        )
        .await
        .expect_err("malformed JSON must fail");
        assert_eq!(malformed.code, "provider-unavailable");

        let call_id = "cancel-contract";
        let (slow_url, _) = mock_response("200 OK", r#"{"messages":[]}"#, 500).await;
        let gmail_tokens = tokens(&[GMAIL_READONLY]);
        let request = send_json(call_id, "gmail", &gmail_tokens, Method::GET, slow_url, None);
        tokio::pin!(request);
        tokio::select! {
            result = &mut request => panic!("request finished before cancellation: {result:?}"),
            _ = tokio::time::sleep(Duration::from_millis(25)) => {}
        }
        assert!(cancel_google_request(call_id));
        let cancelled = request.await.expect_err("cancelled request must fail");
        assert_eq!(cancelled.code, "cancelled");
    }

    static ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    #[test]
    fn test_has_any_scope_suffix_matching() {
        let t = tokens(&["https://www.googleapis.com/auth/drive.readonly"]);
        assert!(has_any_scope(&t, &["drive.readonly"]));
        assert!(!has_any_scope(&t, &["drive.file"]));
    }

    #[tokio::test]
    async fn test_drive_search_pagination() {
        let _lock = ENV_LOCK.lock().await;
        let (url, request_rx) =
            mock_response("200 OK", r#"{"files":[],"nextPageToken":"drive-next"}"#, 0).await;

        std::env::set_var("FABLE_GOOGLE_DRIVE_API", url.to_string());

        let drive_tokens = tokens(&[DRIVE_READONLY]);
        let (_, next_cursor) = drive_search(
            "test-call",
            &drive_tokens,
            "query",
            20,
            Some("drive-cursor"),
        )
        .await
        .unwrap();

        std::env::remove_var("FABLE_GOOGLE_DRIVE_API");

        assert_eq!(next_cursor, Some("drive-next".to_string()));

        let request = request_rx.await.unwrap();
        assert!(request.contains("pageToken=drive-cursor"));
    }

    #[tokio::test]
    async fn test_gmail_search_pagination() {
        let _lock = ENV_LOCK.lock().await;
        let (url, request_rx) = mock_response(
            "200 OK",
            r#"{"messages":[],"nextPageToken":"gmail-next"}"#,
            0,
        )
        .await;

        std::env::set_var("FABLE_GOOGLE_GMAIL_API", url.to_string());

        let gmail_tokens = tokens(&[GMAIL_READONLY]);
        let (_, next_cursor) = gmail_search(
            "test-call",
            &gmail_tokens,
            "query",
            20,
            Some("gmail-cursor"),
        )
        .await
        .unwrap();

        std::env::remove_var("FABLE_GOOGLE_GMAIL_API");

        assert_eq!(next_cursor, Some("gmail-next".to_string()));

        let request = request_rx.await.unwrap();
        assert!(request.contains("pageToken=gmail-cursor"));
    }

    #[tokio::test]
    async fn test_calendar_search_pagination() {
        let _lock = ENV_LOCK.lock().await;
        let (url, request_rx) =
            mock_response("200 OK", r#"{"items":[],"nextPageToken":"cal-next"}"#, 0).await;

        std::env::set_var("FABLE_GOOGLE_CALENDAR_API", url.to_string());

        let cal_tokens = tokens(&[CALENDAR_READONLY]);
        let (_, next_cursor) =
            calendar_search("test-call", &cal_tokens, "my query", 20, Some("cal-cursor"))
                .await
                .unwrap();

        std::env::remove_var("FABLE_GOOGLE_CALENDAR_API");

        assert_eq!(next_cursor, Some("cal-next".to_string()));

        let request = request_rx.await.unwrap();
        assert!(request.contains("pageToken=cal-cursor"));
    }

    #[tokio::test]
    async fn test_gmail_search_partial_failure() {
        let _lock = ENV_LOCK.lock().await;
        let (url, _request_rx) = mock_response(
            "200 OK",
            r#"{"messages":[{"id":"msg-123","threadId":"thread-123"}],"nextPageToken":"gmail-next"}"#,
            0,
        )
        .await;

        std::env::set_var("FABLE_GOOGLE_GMAIL_API", url.to_string());

        let gmail_tokens = tokens(&[GMAIL_READONLY]);
        let (items, next_cursor) = gmail_search("test-call", &gmail_tokens, "query", 20, None)
            .await
            .unwrap();

        std::env::remove_var("FABLE_GOOGLE_GMAIL_API");

        assert_eq!(next_cursor, Some("gmail-next".to_string()));
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "msg-123");
        assert_eq!(items[0].title, "(message unavailable)");
        assert_eq!(
            items[0].summary,
            "This message could not be read from Gmail."
        );
    }

    #[test]
    fn test_safe_user_facing_errors() {
        let err = provider_error("google-drive", StatusCode::BAD_REQUEST, None);
        assert_eq!(err.message, "Google rejected the request.");
        assert_eq!(err.code, "invalid-request");

        // Ensure no private credentials or secrets are leaked
        let secret = "my-secret-oauth-token-12345";
        let err_unauthorized = provider_error("gmail", StatusCode::UNAUTHORIZED, None);
        assert!(!err_unauthorized.message.contains(secret));
        assert_eq!(err_unauthorized.code, "expired-auth");
    }

    #[test]
    #[ignore = "requires deliberate FABLE_GOOGLE_LIVE_TEST credentials and provider account"]
    fn live_google_contract_is_opt_in() {
        assert!(std::env::var("FABLE_GOOGLE_LIVE_TEST").is_ok());
    }
}
