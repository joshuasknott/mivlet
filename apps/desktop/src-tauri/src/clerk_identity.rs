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
#[path = "clerk_identity/tests.rs"]
mod tests;

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
