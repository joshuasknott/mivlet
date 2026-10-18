//! Clerk identity and session boundary for Mivlet accounts.
//!
//! This module is deliberately separate from connector OAuth and the
//! confidential auth broker. It owns the system-browser Authorization Code +
//! PKCE flow, token refresh, JWT validation, and OS-keyring storage for Mivlet's
//! app identity. React receives only secret-free external authentication facts
//! and verified display attributes. Mivlet tenancy and authorization are
//! resolved outside this provider boundary.

use std::collections::BTreeMap;
use std::sync::{LazyLock, Mutex, MutexGuard};

mod attempt;
mod configuration;
mod secrets;
mod session;
pub(crate) use configuration::*;
pub(super) use secrets::*;
pub(super) use session::*;
static LOGIN_ATTEMPTS: LazyLock<attempt::Attempts> = LazyLock::new(attempt::Attempts::default);
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, Utc};
use futures_util::StreamExt;
use jsonwebtoken::errors::ErrorKind;
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::net::TcpListener;
use url::Url;

const KEYRING_SERVICE: &str = "com.fable.workspace.identity.clerk";
const SESSION_KEY: &str = "clerk-session";
const KEYRING_CHUNK_MANIFEST_PREFIX: &str = "fable-keyring-chunks-v1:";
// Windows Credential Manager limits generic credential blobs to 2,560 bytes.
// keyring encodes passwords as UTF-16 there, so keep each entry comfortably
// below that ceiling while retaining OS-secure storage on every platform.
const KEYRING_CHUNK_UTF16_UNITS: usize = 900;
const KEYRING_MAX_CHUNKS: usize = 64;
const PENDING_MAX_AGE_SECONDS: u64 = 5 * 60;
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(300);
#[allow(dead_code)] // Reserved for the focused native hosted-account adapter.
const MAX_CONVEX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const CLOCK_SKEW_SECONDS: u64 = 60;
static IDENTITY_GENERATION: Mutex<u64> = Mutex::new(0);

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct NativeIdentityGenerationSnapshot {
    pub(crate) account_binding: String,
    pub(crate) generation: u64,
}

pub(crate) struct NativeIdentityGenerationGuard {
    _guard: MutexGuard<'static, u64>,
}

const CLERK_CONFIG_KEYS: [&str; 8] = [
    "MIVLET_CLERK_ISSUER",
    "MIVLET_CLERK_OAUTH_CLIENT_ID",
    "MIVLET_CLERK_AUDIENCE",
    "MIVLET_CLERK_AUTHORIZED_PARTY",
    "MIVLET_CLERK_SCOPES",
    "MIVLET_CLERK_REQUEST_ORG",
    "MIVLET_CLERK_REQUIRE_ORG",
    "MIVLET_CLERK_ALLOWED_ORG_IDS",
];

#[derive(Debug, Clone)]
struct IdentityError {
    code: &'static str,
    message: String,
    retryable: bool,
}

fn identity_error(
    code: &'static str,
    message: impl Into<String>,
    retryable: bool,
) -> IdentityError {
    IdentityError {
        code,
        message: message.into(),
        retryable,
    }
}

fn command_message(error: IdentityError) -> String {
    let _retryable = error.retryable;
    error.message
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AccountEntryMode {
    #[default]
    SignIn,
    SignUp,
}

fn account_entry_url(
    mut authorization: Url,
    mode: AccountEntryMode,
    entry: Option<&str>,
    production: bool,
) -> Result<Url, IdentityError> {
    let Some(entry) = entry.filter(|value| !value.trim().is_empty()) else {
        if mode == AccountEntryMode::SignUp {
            return Err(identity_error(
                "configuration-required",
                "Account registration is not configured. Start the Mivlet account site and configure MIVLET_CLERK_ACCOUNT_ENTRY_URL.",
                false,
            ));
        }
        // Reuse an authenticated browser account; explicit OAuth consent still
        // confirms the account granted to this native request.
        authorization
            .query_pairs_mut()
            .append_pair("prompt", "consent");
        return Ok(authorization);
    };
    let mut entry = Url::parse(entry).map_err(|_| {
        identity_error(
            "configuration-required",
            "Account entry URL is invalid.",
            false,
        )
    })?;
    let local_dev =
        !production && entry.scheme() == "http" && entry.host_str() == Some("127.0.0.1");
    if (entry.scheme() != "https" && !local_dev)
        || entry.host_str().is_none()
        || !entry.username().is_empty()
        || entry.password().is_some()
        || entry.query().is_some()
        || entry.fragment().is_some()
        || entry.path() != "/desktop/start"
    {
        return Err(identity_error("configuration-required", "Account entry must be an HTTPS /desktop/start URL (literal loopback HTTP is allowed only in development).", false));
    }
    // The account page authenticates or explicitly reuses a browser account.
    // Requiring login here would discard that completed authentication.
    authorization
        .query_pairs_mut()
        .append_pair("prompt", "consent");
    entry
        .query_pairs_mut()
        .append_pair(
            "mode",
            if mode == AccountEntryMode::SignUp {
                "sign-up"
            } else {
                "sign-in"
            },
        )
        .append_pair("authorization_url", authorization.as_str());
    Ok(entry)
}

async fn begin_sign_in_with_store(
    store: &dyn IdentitySecretStore,
    mode: AccountEntryMode,
    attempt_id: &str,
) -> Result<IdentityStatus, IdentityError> {
    let expected_generation = *IDENTITY_GENERATION
        .lock()
        .map_err(|_| identity_error("unknown", "Account state unavailable.", false))?;
    let Some(config) = load_config()? else {
        return Ok(disabled_status());
    };
    let metadata = match discover_metadata(&config).await {
        Ok(metadata) => metadata,
        Err(error) if error.code == "offline" => {
            return Ok(IdentityStatus {
                enabled: true,
                state: "offline".to_string(),
                message: "Mivlet could not reach Clerk to start sign-in.".to_string(),
                issuer: Some(config.issuer),
                audience: Some(config.audience),
                scopes: config.scopes,
                authentication: None,
            });
        }
        Err(error) => return Err(error),
    };

    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|_| {
        identity_error(
            "unknown",
            "Mivlet could not bind a loopback identity listener.",
            false,
        )
    })?;
    let redirect_uri = bound_redirect(&listener)?;
    let state = random_urlsafe(32)?;
    let verifier = random_urlsafe(64)?;
    let challenge = pkce_challenge(&verifier);
    let mut authorization = Url::parse(&metadata.authorization_endpoint).map_err(|_| {
        identity_error(
            "configuration-required",
            "Clerk authorization endpoint is invalid.",
            false,
        )
    })?;
    authorization
        .query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &config.client_id)
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("scope", &config.scopes.join(" "))
        .append_pair("state", &state)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256");
    let entry = crate::env_compat::var_opt("MIVLET_CLERK_ACCOUNT_ENTRY_URL")
        .or_else(|| option_env!("MIVLET_CLERK_ACCOUNT_ENTRY_URL").map(str::to_owned));
    let authorization = account_entry_url(
        authorization,
        mode,
        entry.as_deref(),
        !cfg!(debug_assertions),
    )?;

    let pending = PendingClerkOAuth {
        state: state.clone(),
        verifier,
        redirect_uri: redirect_uri.clone(),
        issuer: config.issuer.clone(),
        client_id: config.client_id.clone(),
        audience: config.audience.clone(),
        authorized_party: config.authorized_party.clone(),
        scopes: config.scopes.clone(),
        token_endpoint: metadata.token_endpoint.clone(),
        jwks_uri: metadata.jwks_uri.clone(),
        userinfo_endpoint: metadata.userinfo_endpoint.clone(),
        created_at: now_epoch(),
    };
    let encoded = serde_json::to_string(&pending).map_err(|_| {
        identity_error(
            "unknown",
            "Mivlet could not encode identity OAuth state.",
            false,
        )
    })?;
    store
        .set(&pending_key(&state), &encoded)
        .map_err(|message| identity_error("unknown", message, false))?;
    let _pending_cleanup = PendingIdentityCleanup {
        store,
        key: pending_key(&state),
    };
    if let Err(error) = open_browser(authorization.as_str()) {
        let _ = store.remove(&pending_key(&state));
        return Err(error);
    }

    let callback_url = match crate::oauth_loopback::receive_loopback_callback(
        listener,
        &redirect_uri,
        CALLBACK_TIMEOUT,
    )
    .await
    {
        Ok(callback) => callback,
        Err(message) => {
            let _ = store.remove(&pending_key(&state));
            return Err(identity_error("invalid-request", message, true));
        }
    };

    complete_callback_with_store(
        store,
        &callback_url,
        Some(expected_generation),
        Some(attempt_id),
    )
    .await
}

async fn complete_callback_with_store(
    store: &dyn IdentitySecretStore,
    callback_url: &str,
    expected_generation: Option<u64>,
    attempt_id: Option<&str>,
) -> Result<IdentityStatus, IdentityError> {
    let callback = Url::parse(callback_url).map_err(|_| {
        identity_error(
            "invalid-request",
            "Identity callback URL is invalid.",
            false,
        )
    })?;
    let mut parameters = BTreeMap::new();
    for (key, value) in callback.query_pairs() {
        if parameters.insert(key.clone(), value).is_some() {
            return Err(identity_error(
                "invalid-request",
                format!("Identity callback contains duplicate {key} parameters."),
                false,
            ));
        }
    }
    let state = parameters.get("state").ok_or_else(|| {
        identity_error(
            "invalid-request",
            "Identity callback is missing state.",
            false,
        )
    })?;
    if let Some(error) = parameters.get("error") {
        let _ = store.remove(&pending_key(state));
        return Err(identity_error(
            "sign-in-cancelled",
            format!("Clerk sign-in did not complete: {error}."),
            false,
        ));
    }
    let code = parameters.get("code").ok_or_else(|| {
        identity_error(
            "invalid-request",
            "Identity callback is missing code.",
            false,
        )
    })?;
    let pending_key = pending_key(state);
    let encoded = store
        .get(&pending_key)
        .map_err(|message| identity_error("unknown", message, false))?
        .ok_or_else(|| {
            identity_error(
                "invalid-request",
                "Identity state is unknown or expired.",
                false,
            )
        })?;
    let pending: PendingClerkOAuth = serde_json::from_str(&encoded).map_err(|_| {
        identity_error(
            "invalid-request",
            "Stored identity state is invalid.",
            false,
        )
    })?;
    if pending.state != state.as_ref() {
        return Err(identity_error(
            "invalid-request",
            "Identity state did not match.",
            false,
        ));
    }
    if now_epoch().saturating_sub(pending.created_at) > PENDING_MAX_AGE_SECONDS {
        store
            .remove(&pending_key)
            .map_err(|message| identity_error("unknown", message, false))?;
        return Err(identity_error(
            "invalid-request",
            "Identity state expired; start sign-in again.",
            false,
        ));
    }
    let expected_redirect = Url::parse(&pending.redirect_uri).map_err(|_| {
        identity_error(
            "invalid-request",
            "Stored identity redirect is invalid.",
            false,
        )
    })?;
    if callback.scheme() != expected_redirect.scheme()
        || callback.host_str() != expected_redirect.host_str()
        || callback.port_or_known_default() != expected_redirect.port_or_known_default()
        || callback.path() != expected_redirect.path()
    {
        return Err(identity_error(
            "invalid-request",
            "Identity callback did not match the registered redirect.",
            false,
        ));
    }
    store
        .remove(&pending_key)
        .map_err(|message| identity_error("unknown", message, false))?;

    let tokens = exchange_code(&pending, code).await?;
    let config = ClerkIdentityConfig {
        issuer: pending.issuer.clone(),
        client_id: pending.client_id.clone(),
        audience: pending.audience.clone(),
        authorized_party: pending.authorized_party.clone(),
        scopes: pending.scopes.clone(),
    };
    let metadata = AuthorizationServerMetadata {
        issuer: config.issuer.clone(),
        authorization_endpoint: String::new(),
        token_endpoint: pending.token_endpoint.clone(),
        jwks_uri: pending.jwks_uri.clone(),
        userinfo_endpoint: pending.userinfo_endpoint.clone(),
    };
    let session = session_from_tokens(config.clone(), &metadata, None, tokens).await?;
    if let Some(id) = attempt_id {
        LOGIN_ATTEMPTS.commit(id, || write_session(store, &session, expected_generation))?;
    } else {
        write_session(store, &session, expected_generation)?;
    }
    Ok(session_status(
        "signed-in",
        "Mivlet cloud identity is connected.",
        &session,
    ))
}

fn validate_convex_function_path(path: &str) -> Result<(), IdentityError> {
    let valid_length = !path.is_empty() && path.len() <= 200;
    let valid_characters = path.bytes().all(|byte| {
        byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'/' | b'.' | b':')
    });
    let mut parts = path.split(':');
    let module = parts.next().unwrap_or_default();
    let function = parts.next().unwrap_or_default();
    if !valid_length
        || !valid_characters
        || module.is_empty()
        || function.is_empty()
        || parts.next().is_some()
        || module.starts_with('/')
        || module.ends_with('/')
        || module
            .split('/')
            .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return Err(identity_error(
            "invalid-request",
            "Convex function path is invalid.",
            false,
        ));
    }
    Ok(())
}

#[allow(dead_code)]
async fn authenticated_session_with_store(
    store: &dyn IdentitySecretStore,
) -> Result<(StoredSession, u64), IdentityError> {
    let status = status_with_store(store).await?;
    if status.state != "signed-in" {
        let code = match status.state.as_str() {
            "offline" => "offline",
            "revoked" => "revoked",
            "signed-out" => "expired",
            _ => "invalid-token",
        };
        return Err(identity_error(code, status.message, code == "offline"));
    }
    let generation = IDENTITY_GENERATION
        .lock()
        .map_err(|_| identity_error("unknown", "Identity state unavailable.", false))?;
    let session = read_session(store)?.ok_or_else(|| {
        identity_error(
            "expired",
            "Mivlet account session is unavailable; sign in again.",
            false,
        )
    })?;
    if session.expires_at <= now_epoch() {
        return Err(identity_error(
            "expired",
            "Mivlet account session expired; sign in again.",
            false,
        ));
    }
    Ok((session, *generation))
}

#[allow(dead_code)]
async fn read_limited_json(response: reqwest::Response) -> Result<Value, IdentityError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_CONVEX_RESPONSE_BYTES as u64)
    {
        return Err(identity_error(
            "invalid-response",
            "Convex response exceeded Mivlet's size limit.",
            false,
        ));
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| {
            identity_error(
                "offline",
                "Mivlet lost the Convex response connection.",
                true,
            )
        })?;
        if bytes.len().saturating_add(chunk.len()) > MAX_CONVEX_RESPONSE_BYTES {
            return Err(identity_error(
                "invalid-response",
                "Convex response exceeded Mivlet's size limit.",
                false,
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| {
        identity_error(
            "invalid-response",
            "Convex returned an invalid JSON response.",
            false,
        )
    })
}

#[allow(dead_code)]
async fn call_convex_with_store(
    store: &dyn IdentitySecretStore,
    request: ConvexIdentityCallRequest,
) -> Result<Value, IdentityError> {
    let mut endpoint = load_convex_url()?;
    validate_convex_function_path(&request.function_path)?;
    if !request.args.is_object() {
        return Err(identity_error(
            "invalid-request",
            "Convex function arguments must be an object.",
            false,
        ));
    }
    let (session, expected_generation) = authenticated_session_with_store(store).await?;
    endpoint.set_path(&format!("/api/{}", request.function_type.endpoint()));
    crate::ensure_rustls_provider();
    let response = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| {
            identity_error(
                "unknown",
                "Mivlet could not initialize the authenticated Convex request.",
                false,
            )
        })?
        .post(endpoint)
        .bearer_auth(&session.access_token)
        .json(&ConvexFunctionBody {
            path: &request.function_path,
            args: &request.args,
            format: "json",
        })
        .send()
        .await
        .map_err(|_| {
            identity_error(
                "offline",
                "Mivlet could not reach the hosted workspace service.",
                true,
            )
        })?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        clear_session_if_current(store, Some(expected_generation))?;
        return Err(identity_error(
            "revoked",
            "The hosted service rejected the Mivlet account session; sign in again.",
            false,
        ));
    }
    if !response.status().is_success() {
        return Err(identity_error(
            "hosted-request-failed",
            format!(
                "The hosted workspace service rejected the request (HTTP {}).",
                response.status().as_u16()
            ),
            response.status().is_server_error(),
        ));
    }
    let result = read_limited_json(response).await?;
    let generation = IDENTITY_GENERATION
        .lock()
        .map_err(|_| identity_error("unknown", "Identity state unavailable.", false))?;
    if *generation != expected_generation {
        return Err(identity_error(
            "expired",
            "Account changed during the hosted request.",
            false,
        ));
    }
    Ok(result)
}

/// Credential-bearing Convex transport for focused native account/workspace
/// adapters. This intentionally is not a Tauri command: renderer code must
/// never choose arbitrary hosted functions under the user's account session.
#[allow(dead_code)]
pub(crate) async fn call_convex(request: ConvexIdentityCallRequest) -> Result<Value, String> {
    call_convex_with_store(&NativeIdentitySecretStore, request)
        .await
        .map_err(command_message)
}

async fn call_convex_http_route_with_store(
    store: &dyn IdentitySecretStore,
    path: &str,
    args: Value,
) -> Result<Value, IdentityError> {
    validate_convex_http_path(path)?;
    if !args.is_object() {
        return Err(identity_error(
            "invalid-request",
            "Convex function arguments must be an object.",
            false,
        ));
    }
    let mut endpoint = load_convex_site_url()?;
    let (session, expected_generation) = authenticated_session_with_store(store).await?;
    endpoint.set_path(path);
    crate::ensure_rustls_provider();
    let response = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| {
            identity_error(
                "unknown",
                "Mivlet could not initialize the authenticated Convex request.",
                false,
            )
        })?
        .post(endpoint)
        .bearer_auth(&session.access_token)
        .header(reqwest::header::ACCEPT, "application/json")
        .json(&args)
        .send()
        .await
        .map_err(|_| {
            identity_error(
                "offline",
                "Mivlet could not reach the hosted workspace service.",
                true,
            )
        })?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        clear_session_if_current(store, Some(expected_generation))?;
        return Err(identity_error(
            "revoked",
            "The hosted service rejected the Mivlet account session; sign in again.",
            false,
        ));
    }
    if !response.status().is_success() {
        return Err(identity_error(
            "hosted-request-failed",
            format!(
                "The hosted workspace service rejected the request (HTTP {}).",
                response.status().as_u16()
            ),
            response.status().is_server_error(),
        ));
    }
    let result = read_limited_json(response).await?;
    let generation = IDENTITY_GENERATION
        .lock()
        .map_err(|_| identity_error("unknown", "Identity state unavailable.", false))?;
    if *generation != expected_generation {
        return Err(identity_error(
            "expired",
            "Account changed during the hosted request.",
            false,
        ));
    }
    Ok(result)
}

/// Native-only Convex HTTP route. Renderer code must never choose hosted
/// functions under the user's account session.
#[allow(dead_code)]
pub(crate) async fn call_convex_http_route(path: &str, args: Value) -> Result<Value, String> {
    call_convex_http_route_with_store(&NativeIdentitySecretStore, path, args)
        .await
        .map_err(command_message)
}

#[tauri::command]
pub async fn identity_status(_app: tauri::AppHandle) -> Result<IdentityStatus, String> {
    native_identity_status().await
}

pub(crate) async fn native_identity_status() -> Result<IdentityStatus, String> {
    tokio::time::timeout(
        Duration::from_secs(45),
        status_with_store(&NativeIdentitySecretStore),
    )
    .await
    .map_err(|_| {
        "Account verification took too long. Check your connection and try again.".to_string()
    })?
    .map_err(command_message)
}

/// Refresh before the synchronous admission fence expires. Admission still
/// rejects an expired session while refresh is unavailable or in progress.
pub(crate) async fn renew_native_identity_if_due() {
    if read_session(&NativeIdentitySecretStore)
        .ok()
        .flatten()
        .is_some_and(|session| session.expires_at <= now_epoch().saturating_add(60))
    {
        let _ = tokio::time::timeout(Duration::from_secs(20), native_identity_status()).await;
    }
}

fn account_binding_for_authentication(authentication: &AccountAuthenticationFacts) -> String {
    let mut digest = Sha256::new();
    digest.update(b"fable.account-workspace.bootstrap.v1\0");
    digest.update(authentication.normalized_issuer.as_bytes());
    digest.update(b"\0");
    digest.update(authentication.subject.as_bytes());
    format!("bootstrap_{}", URL_SAFE_NO_PAD.encode(digest.finalize()))
}

pub(crate) fn native_identity_generation_snapshot(
) -> Result<NativeIdentityGenerationSnapshot, String> {
    native_identity_snapshot_with_expiry().map(|(snapshot, _)| snapshot)
}

fn native_identity_snapshot_with_expiry() -> Result<(NativeIdentityGenerationSnapshot, u64), String>
{
    let generation = IDENTITY_GENERATION
        .lock()
        .map_err(|_| "Mivlet account state is unavailable.".to_string())?;
    let session = read_session(&NativeIdentitySecretStore)
        .map_err(command_message)?
        .ok_or_else(|| "Mivlet account session is unavailable; sign in again.".to_string())?;
    if session.expires_at <= now_epoch()
        || !load_config()
            .map_err(command_message)?
            .is_some_and(|config| session_matches_config(&session, &config))
    {
        return Err("Mivlet account session expired or changed; sign in again.".into());
    }
    let authentication = session.authentication.ok_or_else(|| {
        "Mivlet account identity facts are unavailable; sign in again.".to_string()
    })?;
    Ok((
        NativeIdentityGenerationSnapshot {
            account_binding: account_binding_for_authentication(&authentication),
            generation: *generation,
        },
        session.expires_at,
    ))
}

pub(crate) struct NativeIdentityDispatch {
    snapshot: NativeIdentityGenerationSnapshot,
    expires_at: u64,
}
impl NativeIdentityDispatch {
    pub(crate) fn capture() -> Result<Self, String> {
        let (snapshot, expires_at) = native_identity_snapshot_with_expiry()?;
        Ok(Self {
            snapshot,
            expires_at,
        })
    }
    pub(crate) fn account_binding(&self) -> &str {
        &self.snapshot.account_binding
    }
    /// Only cached generation/expiry checks here: never read secrets or wait
    /// on an identity mutation while a native Stop/dispatch lock is held.
    pub(crate) fn with_current<T>(
        &self,
        operation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        try_identity_dispatch(
            &IDENTITY_GENERATION,
            self.snapshot.generation,
            self.expires_at,
            operation,
        )
    }
}
fn try_identity_dispatch<T>(
    generation: &Mutex<u64>,
    expected: u64,
    expires_at: u64,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let guard = generation
        .try_lock()
        .map_err(|_| "Account identity changed or is busy; no new browser input was dispatched.")?;
    if *guard != expected || expires_at <= now_epoch() {
        return Err(
            "Account identity expired or changed; no new browser input was dispatched.".into(),
        );
    }
    operation()
}

#[cfg(test)]
mod dispatch_tests {
    use super::*;
    #[test]
    fn identity_dispatch_never_waits_or_runs_after_change_or_expiry() {
        let generation = Mutex::new(7);
        let called = std::cell::Cell::new(0);
        let operation = || {
            called.set(called.get() + 1);
            Ok(())
        };
        assert!(try_identity_dispatch(&generation, 6, now_epoch() + 60, operation).is_err());
        assert!(
            try_identity_dispatch(&generation, 7, now_epoch().saturating_sub(1), operation)
                .is_err()
        );
        let guard = generation.lock().unwrap();
        assert!(try_identity_dispatch(&generation, 7, now_epoch() + 60, operation).is_err());
        assert_eq!(called.get(), 0);
        drop(guard);
        assert!(try_identity_dispatch(&generation, 7, now_epoch() + 60, operation).is_ok());
        assert_eq!(called.get(), 1);
    }

    #[test]
    fn generation_guard_can_be_held_without_releasing_the_fence() {
        let held = IDENTITY_GENERATION.lock().unwrap();
        let _guard = NativeIdentityGenerationGuard { _guard: held };
        assert!(IDENTITY_GENERATION.try_lock().is_err());
    }

    #[test]
    fn generation_change_waits_until_fenced_commit_finishes() {
        use std::sync::{atomic::AtomicBool, atomic::Ordering, Arc, Barrier};
        use std::thread;
        use tempfile::tempdir;

        let held = IDENTITY_GENERATION.lock().unwrap();
        let before = *held;
        let guard = NativeIdentityGenerationGuard { _guard: held };
        let started = Arc::new(AtomicBool::new(false));
        let changed = Arc::new(AtomicBool::new(false));
        let committed = Arc::new(AtomicBool::new(false));
        let barrier = Arc::new(Barrier::new(2));
        let writer_started = Arc::clone(&started);
        let writer_changed = Arc::clone(&changed);
        let writer_barrier = Arc::clone(&barrier);
        let directory = tempdir().unwrap();
        let permit_path = directory.path().join("execution-approvals.json");
        let writer = thread::spawn(move || {
            writer_barrier.wait();
            writer_started.store(true, Ordering::Release);
            let mut generation = IDENTITY_GENERATION.lock().unwrap();
            *generation = before.wrapping_add(1);
            writer_changed.store(true, Ordering::Release);
        });

        barrier.wait();
        for _ in 0..1_000 {
            if started.load(Ordering::Acquire) {
                break;
            }
            thread::yield_now();
        }
        assert!(!changed.load(Ordering::Acquire));

        let request = crate::models::ApprovalRequest {
            id: "fenced-approval".into(),
            service: "test".into(),
            action: "write".into(),
            mode: "standard".into(),
            risk_level: "low".into(),
            data_used: vec!["path".into()],
            consequence: "A bounded test write.".into(),
            requested_at: "2026-10-08T12:00:00Z".into(),
            decisions: vec!["once".into()],
            confirmation_phrase: None,
        };
        let response = crate::models::ApprovalResolutionResponse {
            persisted: true,
            audit_entry: crate::models::ApprovalAuditEntry {
                id: "fenced-audit".into(),
                request_id: request.id.clone(),
                decision: "once".into(),
                decided_at: "2026-10-08T12:00:01Z".into(),
                note: "fenced".into(),
            },
            effective_request: request,
            dismissed: true,
            grant: None,
        };
        crate::execution_approvals::record_execution_decision(&permit_path, &response).unwrap();
        committed.store(true, Ordering::Release);
        drop(guard);
        writer.join().unwrap();
        assert!(committed.load(Ordering::Acquire));
        assert!(changed.load(Ordering::Acquire));
        assert!(std::fs::read_to_string(permit_path)
            .unwrap()
            .contains("fenced-approval"));

        *IDENTITY_GENERATION.lock().unwrap() = before;
    }
}

pub(crate) fn lock_native_identity_generation(
    expected: &NativeIdentityGenerationSnapshot,
) -> Result<NativeIdentityGenerationGuard, String> {
    let guard = IDENTITY_GENERATION
        .lock()
        .map_err(|_| "Mivlet account state is unavailable.".to_string())?;
    if *guard != expected.generation {
        return Err("Mivlet account changed during the request. Please try again.".into());
    }
    let session = read_session(&NativeIdentitySecretStore)
        .map_err(command_message)?
        .ok_or_else(|| "Mivlet account session is unavailable; sign in again.".to_string())?;
    if session.expires_at <= now_epoch() {
        return Err("Mivlet account session expired or changed; sign in again.".into());
    }
    let current_binding = session
        .authentication
        .map(|authentication| account_binding_for_authentication(&authentication));
    if current_binding.as_deref() != Some(expected.account_binding.as_str()) {
        return Err("Mivlet account changed during the request. Please try again.".into());
    }
    Ok(NativeIdentityGenerationGuard { _guard: guard })
}

// Dropping a cancelled/expired future also removes its single-use PKCE secret.
struct PendingIdentityCleanup<'a> {
    store: &'a dyn IdentitySecretStore,
    key: String,
}
impl Drop for PendingIdentityCleanup<'_> {
    fn drop(&mut self) {
        let _ = self.store.remove(&self.key);
    }
}

#[tauri::command]
pub fn identity_prepare_sign_in() -> Result<String, String> {
    LOGIN_ATTEMPTS.prepare(random_urlsafe(32).map_err(command_message)?)
}

#[tauri::command]
pub fn identity_cancel_sign_in(attempt_id: String) -> Result<bool, String> {
    LOGIN_ATTEMPTS.cancel(&attempt_id)
}

#[tauri::command]
pub async fn identity_begin_sign_in(
    app: tauri::AppHandle,
    mode: Option<AccountEntryMode>,
    attempt_id: String,
) -> Result<IdentityStatus, String> {
    let mut cancelled = LOGIN_ATTEMPTS.start(&attempt_id)?;
    // A loaded account must never turn a Log in click into an implicit logout.
    if crate::account_session::binding().is_ok() {
        LOGIN_ATTEMPTS.finish(&attempt_id);
        return native_identity_status().await;
    }
    let result = tokio::select! {
        biased;
        _ = cancelled.changed() => Err("Sign-in cancelled. You can log in or create an account.".to_string()),
        result = tokio::time::timeout(Duration::from_secs(360), begin_sign_in_with_store(&NativeIdentitySecretStore, mode.unwrap_or_default(), &attempt_id)) => {
            result.map_err(|_| "Sign-in took too long. Please try again.".to_string()).and_then(|value| value.map_err(command_message))
        }
    };
    LOGIN_ATTEMPTS.finish(&attempt_id);
    let result = result?;
    if result.authentication.is_some() && matches!(result.state.as_str(), "signed-in" | "offline") {
        crate::account_session::restart(app).await;
    }
    Ok(result)
}

#[tauri::command]
pub async fn identity_begin_recovery(app: tauri::AppHandle) -> Result<IdentityStatus, String> {
    if crate::account_session::binding().is_ok() {
        return identity_sign_out(app).await;
    }
    clear_session(&NativeIdentitySecretStore).map_err(command_message)?;
    identity_begin_sign_in(
        app,
        Some(AccountEntryMode::SignIn),
        identity_prepare_sign_in()?,
    )
    .await
}

#[tauri::command]
pub async fn identity_refresh(_app: tauri::AppHandle) -> Result<IdentityStatus, String> {
    tokio::time::timeout(
        Duration::from_secs(45),
        status_with_store(&NativeIdentitySecretStore),
    )
    .await
    .map_err(|_| {
        "Account verification took too long. Check your connection and try again.".to_string()
    })?
    .map_err(command_message)
}

#[tauri::command]
pub async fn identity_sign_out(app: tauri::AppHandle) -> Result<IdentityStatus, String> {
    crate::background_worker::revoke().await;
    // Configuration may have become invalid since sign-in. Local credential
    // removal must still happen before reporting that diagnostic.
    let status =
        sign_out_with_store(&NativeIdentitySecretStore, load_config).map_err(command_message)?;
    crate::account_session::restart(app).await;
    Ok(status)
}

#[cfg(test)]
mod tests {
    #[test]
    fn account_entry_preserves_mode_without_repeating_authentication() {
        let authorize = url::Url::parse(
            "https://clerk.example/oauth/authorize?state=fixture&code_challenge=fixture",
        )
        .unwrap();
        let login = super::account_entry_url(
            authorize.clone(),
            super::AccountEntryMode::SignIn,
            None,
            true,
        )
        .unwrap();
        assert_eq!(
            login
                .query_pairs()
                .find(|(key, _)| key == "prompt")
                .unwrap()
                .1,
            "consent"
        );
        assert!(super::account_entry_url(
            authorize.clone(),
            super::AccountEntryMode::SignUp,
            None,
            true
        )
        .is_err());
        for (mode, expected) in [
            (super::AccountEntryMode::SignIn, "sign-in"),
            (super::AccountEntryMode::SignUp, "sign-up"),
        ] {
            let entry = super::account_entry_url(
                authorize.clone(),
                mode,
                Some("https://accounts.example/desktop/start"),
                true,
            )
            .unwrap();
            let params: std::collections::BTreeMap<_, _> =
                entry.query_pairs().into_owned().collect();
            assert_eq!(params["mode"], expected);
            let continuation = url::Url::parse(&params["authorization_url"]).unwrap();
            assert_eq!(
                continuation
                    .query_pairs()
                    .find(|(key, _)| key == "prompt")
                    .unwrap()
                    .1,
                "consent"
            );
            assert!(continuation
                .as_str()
                .contains("state=fixture&code_challenge=fixture"));
        }
        assert!(super::account_entry_url(
            authorize.clone(),
            super::AccountEntryMode::SignUp,
            Some("http://127.0.0.1:1421/desktop/start"),
            false
        )
        .is_ok());
        for bad in [
            "http://127.0.0.1:1421/desktop/start",
            "https://user@accounts.example/desktop/start",
            "https://accounts.example/desktop/start?next=evil",
            "https://accounts.example/sign-up",
        ] {
            assert!(super::account_entry_url(
                authorize.clone(),
                super::AccountEntryMode::SignUp,
                Some(bad),
                true
            )
            .is_err());
        }
    }
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct MemoryStore(Mutex<BTreeMap<String, String>>);

    impl IdentitySecretStore for MemoryStore {
        fn get(&self, key: &str) -> Result<Option<String>, String> {
            Ok(self.0.lock().unwrap().get(key).cloned())
        }

        fn set(&self, key: &str, secret: &str) -> Result<(), String> {
            self.0
                .lock()
                .unwrap()
                .insert(key.to_string(), secret.to_string());
            Ok(())
        }

        fn remove(&self, key: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(key);
            Ok(())
        }
    }

    #[test]
    fn late_oauth_and_refresh_cannot_restore_a_signed_out_identity() {
        let store = MemoryStore::default();
        let session: StoredSession = serde_json::from_value(serde_json::json!({
            "access_token":"fixture", "refresh_token":null, "token_type":"Bearer", "expires_at":1,
            "scopes":[], "issuer":"https://issuer.example", "audience":"fixture", "client_id":"fixture", "authorized_party":null
        })).unwrap();
        let expected = *IDENTITY_GENERATION.lock().unwrap();
        clear_session(&store).unwrap();
        assert!(write_session(&store, &session, Some(expected)).is_err());
        assert!(store.get(SESSION_KEY).unwrap().is_none());
        assert!(clear_session_if_current(&store, Some(expected)).is_err());
    }

    #[test]
    fn local_account_namespace_is_bound_to_verified_issuer_and_subject() {
        let mut claims = test_claims();
        let a = authentication_from_claims(&claims, "https://issuer.example", "fixture", 1);
        claims.sub = "second-account".into();
        let b = authentication_from_claims(&claims, "https://issuer.example", "fixture", 1);
        let c = authentication_from_claims(&claims, "https://other-issuer.example", "fixture", 1);
        assert_ne!(
            account_binding_for_authentication(&a),
            account_binding_for_authentication(&b)
        );
        assert_ne!(
            account_binding_for_authentication(&b),
            account_binding_for_authentication(&c)
        );
    }

    #[test]
    fn session_clear_advances_native_identity_generation() {
        let store = MemoryStore::default();
        let before = *IDENTITY_GENERATION.lock().unwrap();
        clear_session(&store).unwrap();
        let after = *IDENTITY_GENERATION.lock().unwrap();
        assert_ne!(after, before);
    }

    fn test_config() -> ClerkIdentityConfig {
        ClerkIdentityConfig {
            issuer: "https://issuer.example".to_string(),
            client_id: "client_123".to_string(),
            audience: "mivlet-desktop".to_string(),
            authorized_party: Some("client_123".to_string()),
            scopes: vec!["openid".into(), "profile".into(), "email".into()],
        }
    }

    fn test_claims() -> TokenClaims {
        TokenClaims {
            iss: "https://issuer.example".to_string(),
            sub: "user_123".to_string(),
            aud: Some(AudienceClaim::One("mivlet-desktop".to_string())),
            exp: now_epoch() + 3600,
            nbf: Some(now_epoch() - 5),
            iat: Some(now_epoch() - 5),
            azp: Some("client_123".to_string()),
            sid: Some("session_123".to_string()),
            jti: Some("authentication_123".to_string()),
            email: Some("user@example.com".to_string()),
            email_verified: Some(true),
            name: Some("User One".to_string()),
        }
    }

    fn config_values(entries: &[(&str, &str)]) -> BTreeMap<String, String> {
        entries
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect()
    }

    #[test]
    fn secure_store_chunks_round_trip_with_windows_safe_bounds() {
        let secret = format!("{}{}{}", "a".repeat(901), "🦀", "b".repeat(901));
        let chunks = split_keyring_secret(&secret);
        assert!(chunks.len() >= 3);
        assert!(chunks
            .iter()
            .all(|chunk| chunk.encode_utf16().count() <= KEYRING_CHUNK_UTF16_UNITS));
        assert_eq!(chunks.concat(), secret);
    }

    #[test]
    fn secure_store_manifest_rejects_unbounded_or_unsafe_chunk_keys() {
        let valid = KeyringChunkManifest {
            generation: "safe_generation-1".to_string(),
            chunks: 3,
            digest: "digest".to_string(),
        };
        let encoded = format!(
            "{KEYRING_CHUNK_MANIFEST_PREFIX}{}",
            serde_json::to_string(&valid).unwrap()
        );
        assert_eq!(keyring_manifest(&encoded).unwrap().chunks, 3);

        let unsafe_generation = encoded.replace("safe_generation-1", "../unsafe");
        assert!(keyring_manifest(&unsafe_generation).is_none());
        let too_many = encoded.replace("\"chunks\":3", "\"chunks\":65");
        assert!(keyring_manifest(&too_many).is_none());
    }

    #[test]
    fn packaged_identity_works_without_launch_environment_and_rejects_partial_overrides() {
        let packaged = config_values(&[
            ("MIVLET_CLERK_ISSUER", "https://issuer.example"),
            ("MIVLET_CLERK_OAUTH_CLIENT_ID", "client_123"),
            ("MIVLET_CLERK_AUDIENCE", "mivlet-desktop"),
        ]);
        let config = load_config_with_packaged(true, |_| None, |key| packaged.get(key).cloned())
            .unwrap()
            .unwrap();
        assert_eq!(config.audience, "mivlet-desktop");
        let error = load_config_with_packaged(
            true,
            |key| (key == "MIVLET_CLERK_ISSUER").then(|| "https://override.example".to_string()),
            |key| packaged.get(key).cloned(),
        )
        .unwrap_err();
        assert_eq!(error.code, "configuration-required");
        assert!(load_config_with_packaged(true, |_| None, |_| None)
            .unwrap()
            .is_none());
    }

    #[test]
    fn enabled_production_config_requires_explicit_security_fields() {
        let incomplete = config_values(&[
            ("MIVLET_CLERK_ISSUER", "https://issuer.example"),
            ("MIVLET_CLERK_OAUTH_CLIENT_ID", "client_123"),
        ]);
        let error = load_config_from(true, |key| incomplete.get(key).cloned()).unwrap_err();
        assert_eq!(error.code, "configuration-required");
        assert_eq!(
            error.message,
            "Clerk audience must be explicit in production."
        );

        let complete = config_values(&[
            ("MIVLET_CLERK_ISSUER", "https://issuer.example"),
            ("MIVLET_CLERK_OAUTH_CLIENT_ID", "client_123"),
            ("MIVLET_CLERK_AUDIENCE", "mivlet-desktop"),
        ]);
        let config = load_config_from(true, |key| complete.get(key).cloned())
            .unwrap()
            .unwrap();
        assert_eq!(config.audience, "mivlet-desktop");
        assert_eq!(config.authorized_party, None);
        assert!(config.scopes.iter().any(|scope| scope == "offline_access"));
    }

    #[test]
    fn partial_or_obsolete_clerk_configuration_fails_closed() {
        let partial = config_values(&[("MIVLET_CLERK_AUDIENCE", "mivlet-desktop")]);
        assert_eq!(
            load_config_from(false, |key| partial.get(key).cloned())
                .unwrap_err()
                .message,
            "Clerk issuer is required to enable Mivlet cloud identity."
        );

        let obsolete = config_values(&[
            ("MIVLET_CLERK_ISSUER", "https://issuer.example"),
            ("MIVLET_CLERK_OAUTH_CLIENT_ID", "client_123"),
            ("MIVLET_CLERK_REQUIRE_ORG", "true"),
        ]);
        assert!(load_config_from(false, |key| obsolete.get(key).cloned())
            .unwrap_err()
            .message
            .contains("Clerk Organizations cannot configure Mivlet tenancy"));
    }

    #[test]
    fn configured_session_must_match_active_security_configuration() {
        let config = test_config();
        let mut session = StoredSession {
            access_token: "access_secret".to_string(),
            refresh_token: None,
            token_type: "Bearer".to_string(),
            expires_at: now_epoch() + 3600,
            scopes: config.scopes.clone(),
            issuer: config.issuer.clone(),
            audience: config.audience.clone(),
            client_id: config.client_id.clone(),
            authorized_party: config.authorized_party.clone(),
            authentication: None,
            legacy_identity: None,
        };
        assert!(session_matches_config(&session, &config));
        session.audience = "stale-audience".to_string();
        assert!(!session_matches_config(&session, &config));
    }

    #[test]
    fn claim_validation_rejects_wrong_issuer_audience_and_azp() {
        let config = test_config();
        let now = now_epoch();

        let mut wrong_issuer = test_claims();
        wrong_issuer.iss = "https://evil.example".to_string();
        assert_eq!(
            validate_claims(&wrong_issuer, &config, now)
                .unwrap_err()
                .code,
            "invalid-token"
        );

        let mut wrong_audience = test_claims();
        wrong_audience.aud = Some(AudienceClaim::One("other".to_string()));
        assert_eq!(
            validate_claims(&wrong_audience, &config, now)
                .unwrap_err()
                .message,
            "Clerk token audience did not match configuration."
        );

        let mut wrong_azp = test_claims();
        wrong_azp.azp = Some("other-client".to_string());
        assert_eq!(
            validate_claims(&wrong_azp, &config, now)
                .unwrap_err()
                .message,
            "Clerk token authorized party did not match configuration."
        );

        let mut missing_subject = test_claims();
        missing_subject.sub = "  ".to_string();
        assert_eq!(
            validate_claims(&missing_subject, &config, now)
                .unwrap_err()
                .message,
            "Clerk token subject was missing."
        );
    }

    #[test]
    fn oauth_access_token_may_omit_audience_but_identity_token_may_not() {
        let config = ClerkIdentityConfig {
            authorized_party: None,
            ..test_config()
        };
        let now = now_epoch();
        let mut claims = test_claims();
        claims.aud = None;
        claims.azp = None;

        validate_claims_for_use(&claims, &config, now, false).unwrap();
        assert_eq!(
            validate_claims_for_use(&claims, &config, now, true)
                .unwrap_err()
                .message,
            "Clerk identity token audience was missing."
        );
    }

    #[test]
    fn jwt_key_selection_requires_an_explicit_matching_kid() {
        let error = decoding_key_for(None, &Jwks { keys: Vec::new() })
            .err()
            .expect("missing kid must fail");
        assert_eq!(error.message, "Clerk token did not identify a signing key.");
    }

    #[test]
    fn claim_validation_rejects_expired_and_future_tokens() {
        let config = test_config();
        let now = now_epoch();

        let mut expired = test_claims();
        expired.exp = now - 120;
        assert_eq!(
            validate_claims(&expired, &config, now).unwrap_err().code,
            "expired"
        );

        let mut future = test_claims();
        future.nbf = Some(now + 120);
        assert_eq!(
            validate_claims(&future, &config, now).unwrap_err().code,
            "invalid-token"
        );
    }

    #[test]
    fn organization_claims_neither_grant_nor_block_authentication() {
        let now = now_epoch();
        let claims_without_organization = test_claims();
        let claims_with_organization: TokenClaims = serde_json::from_value(serde_json::json!({
            "iss": "https://issuer.example",
            "sub": "user_123",
            "aud": "mivlet-desktop",
            "exp": now + 3600,
            "iat": now - 5,
            "azp": "client_123",
            "sid": "session_123",
            "jti": "authentication_123",
            "email": "user@example.com",
            "email_verified": true,
            "name": "User One",
            "org_id": "org_untrusted",
            "org_name": "Untrusted organization",
            "org_slug": "untrusted",
            "org_role": "owner"
        }))
        .unwrap();

        validate_claims(&claims_without_organization, &test_config(), now).unwrap();
        validate_claims(&claims_with_organization, &test_config(), now).unwrap();

        let facts = authentication_from_claims(
            &claims_with_organization,
            "https://issuer.example",
            "access_secret",
            now + 3600,
        );
        let serialized = serde_json::to_string(&facts).unwrap();
        assert!(!serialized.contains("org_untrusted"));
        assert!(!serialized.contains("organization"));
        assert!(!serialized.contains("\"role\""));
    }

    #[tokio::test]
    async fn callback_error_removes_pending_state() {
        let store = MemoryStore::default();
        let key = pending_key("state_1");
        store.set(&key, "pending verifier").unwrap();

        let error = complete_callback_with_store(
            &store,
            "http://127.0.0.1:1234/callback?state=state_1&error=access_denied",
            None,
            None,
        )
        .await
        .unwrap_err();

        assert_eq!(error.code, "sign-in-cancelled");
        assert!(store.get(&key).unwrap().is_none());
    }

    #[test]
    fn oauth_rejections_only_classify_session_failures_as_revoked() {
        assert_eq!(
            exchange_rejection(reqwest::StatusCode::BAD_REQUEST).code,
            "invalid-token"
        );
        assert_eq!(
            refresh_rejection(reqwest::StatusCode::BAD_REQUEST).code,
            "revoked"
        );
        let transient = refresh_rejection(reqwest::StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(transient.code, "provider-error");
        assert!(transient.retryable);
    }

    #[test]
    fn status_response_never_contains_stored_tokens() {
        let claims = test_claims();
        let authentication = authentication_from_claims(
            &claims,
            "https://issuer.example",
            "access_secret",
            claims.exp,
        );
        let session = StoredSession {
            access_token: "access_secret".to_string(),
            refresh_token: Some("refresh_secret".to_string()),
            token_type: "Bearer".to_string(),
            expires_at: now_epoch() + 3600,
            scopes: vec!["openid".to_string()],
            issuer: "https://issuer.example".to_string(),
            audience: "mivlet-desktop".to_string(),
            client_id: "client_123".to_string(),
            authorized_party: Some("client_123".to_string()),
            authentication: Some(authentication),
            legacy_identity: None,
        };
        let status = session_status("signed-in", "connected", &session);
        let serialized = serde_json::to_string(&status).unwrap();
        assert!(!serialized.contains("access_secret"));
        assert!(!serialized.contains("refresh_secret"));
        assert!(!serialized.contains("id_secret"));
        assert!(!serialized.contains("session_123"));
        assert!(!serialized.contains("authentication_123"));
        assert!(serialized.contains("clerk-session:"));
        assert!(serialized.contains("clerk-authentication:"));
        assert!(serialized.contains("user@example.com"));
    }

    #[test]
    fn expiry_and_revocation_have_distinct_secret_free_states() {
        let config = test_config();
        let expired = status_from_error(
            &config,
            &identity_error("expired", "Session expired; sign in again.", false),
        );
        let revoked = status_from_error(
            &config,
            &identity_error("revoked", "Session revoked; sign in again.", false),
        );
        assert_eq!(expired.state, "expired");
        assert_eq!(revoked.state, "revoked");
        assert!(expired.authentication.is_none());
        assert!(revoked.authentication.is_none());
    }

    #[test]
    fn convex_boundary_rejects_untrusted_destinations_paths_and_token_fields() {
        assert!(load_convex_url_from(Some("https://example.convex.cloud".into())).is_ok());
        assert_eq!(
            load_convex_site_url_from(Some("https://example.convex.cloud".into()))
                .unwrap()
                .as_str(),
            "https://example.convex.site/"
        );
        assert!(validate_convex_http_path("/native/execution-capability").is_ok());
        for invalid in [
            "/api/action",
            "/native",
            "/native/",
            "/native/../execution-capability",
            "hostedExecution:requestExecutionCapability",
        ] {
            assert!(
                validate_convex_http_path(invalid).is_err(),
                "accepted {invalid}"
            );
        }
        for invalid in [
            "http://example.convex.cloud",
            "https://user:secret@example.convex.cloud",
            "https://example.convex.cloud/untrusted",
            "https://example.convex.cloud?redirect=elsewhere",
        ] {
            assert!(load_convex_url_from(Some(invalid.into())).is_err());
        }

        assert!(validate_convex_function_path("workspace:bootstrap").is_ok());
        assert!(validate_convex_function_path("sync/pull:listAfter").is_ok());
        for invalid in [
            "",
            "workspace",
            "../workspace:bootstrap",
            "workspace:run:again",
        ] {
            assert!(validate_convex_function_path(invalid).is_err());
        }

        let injected = serde_json::json!({
            "functionType": "query",
            "functionPath": "viewer:get",
            "args": {},
            "accessToken": "renderer_secret"
        });
        assert!(serde_json::from_value::<ConvexIdentityCallRequest>(injected).is_err());
    }

    #[test]
    fn legacy_session_org_display_fields_are_ignored_and_removed_on_rewrite() {
        let store = MemoryStore::default();
        let legacy = serde_json::json!({
            "access_token": "access_secret",
            "id_token": "id_secret",
            "refresh_token": "refresh_secret",
            "token_type": "Bearer",
            "expires_at": now_epoch() + 3600,
            "scopes": ["openid", "profile", "email"],
            "issuer": "https://issuer.example",
            "audience": "mivlet-desktop",
            "client_id": "client_123",
            "authorized_party": "client_123",
            "identity": {
                "userId": "user_123",
                "displayName": "User One",
                "email": "user@example.com",
                "organization": {
                    "id": "org_obsolete",
                    "name": "Obsolete organization",
                    "slug": "obsolete",
                    "role": "owner"
                }
            }
        })
        .to_string();
        store.set(SESSION_KEY, &legacy).unwrap();

        let mut session = read_session(&store).unwrap().unwrap();
        let legacy_identity = session.legacy_identity.as_ref().unwrap();
        assert_eq!(legacy_identity.user_id, "user_123");

        let claims = test_claims();
        session.authentication = Some(authentication_from_claims(
            &claims,
            &session.issuer,
            &session.access_token,
            session.expires_at,
        ));
        session.legacy_identity = None;
        write_session(&store, &session, None).unwrap();

        let rewritten = store.get(SESSION_KEY).unwrap().unwrap();
        assert!(!rewritten.contains("org_obsolete"));
        assert!(!rewritten.contains("organization"));
        assert!(!rewritten.contains("\"identity\""));
        assert!(rewritten.contains("\"authentication\""));
    }

    #[test]
    fn sign_out_removes_session_even_when_configuration_is_invalid() {
        let store = MemoryStore::default();
        store.set(SESSION_KEY, "value").unwrap();
        let result = sign_out_with_store(&store, || {
            Err(identity_error(
                "configuration-required",
                "invalid production configuration",
                false,
            ))
        });
        assert_eq!(result.unwrap_err().code, "configuration-required");
        assert!(store.get(SESSION_KEY).unwrap().is_none());
    }
}
