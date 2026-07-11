//! Desktop OAuth and connector token boundary.
//!
//! Public clients use Authorization Code + PKCE directly. Providers requiring
//! confidential client credentials are routed through one narrowly scoped auth
//! broker. Access/refresh tokens and pending PKCE verifiers are stored only in
//! the OS credential store; the local connection file contains non-secret
//! account identity and expiry metadata.

use std::{
    collections::BTreeMap,
    fs,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;

use crate::models::{
    ConnectorAccountOption, ConnectorAccountSummary, ConnectorAuthRequest, ConnectorAuthResult,
    ConnectorCommandError,
};
use crate::paths::connector_connections_path;

const KEYRING_SERVICE: &str = "com.fable.workspace.connectors";
const OAUTH_PENDING_MAX_AGE_SECONDS: u64 = 5 * 60;

#[derive(Clone, Debug)]
pub(crate) struct OAuthProviderConfig {
    pub authorization_endpoint: String,
    /// Public PKCE: the provider's token endpoint. Brokered: `None`.
    pub token_endpoint: Option<String>,
    pub revocation_endpoint: Option<String>,
    pub userinfo_endpoint: Option<String>,
    /// Confidential broker handoff endpoint. `None` for public PKCE.
    pub handoff_endpoint: Option<String>,
    pub client_id: String,
    pub scopes: Vec<String>,
    pub brokered: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct PendingOAuth {
    connector_id: String,
    state: String,
    verifier: String,
    redirect_uri: String,
    /// Provider (public PKCE) or broker (confidential) token endpoint. For a
    /// brokered connector this is `None`: the desktop never POSTs a token code
    /// to the broker (the broker has no `/token` route); it redeems the handoff
    /// at {@link PendingOAuth::handoff_endpoint} instead.
    token_endpoint: Option<String>,
    revocation_endpoint: Option<String>,
    userinfo_endpoint: Option<String>,
    /// Confidential broker handoff redemption endpoint. `None` for public PKCE.
    /// Stored so completion does not have to re-derive it from the env var.
    handoff_endpoint: Option<String>,
    client_id: String,
    scopes: Vec<String>,
    brokered: bool,
    created_at: u64,
    /// Stable Fable account binding captured before provider egress. Legacy
    /// test/upgrade records may omit it, but production starts are always bound.
    #[serde(default)]
    fable_account_binding: Option<String>,
    #[serde(default)]
    local_workspace_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) struct StoredTokenSet {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub token_type: String,
    pub expires_at: Option<u64>,
    pub scopes: Vec<String>,
    pub revocation_endpoint: Option<String>,
    /// Public PKCE: the provider's token endpoint (used for refresh). Brokered:
    /// `None` — the desktop rotates through the broker refresh endpoint instead.
    #[serde(default)]
    pub token_endpoint: Option<String>,
    /// Confidential broker handoff endpoint, persisted so a later refresh or
    /// revoke can derive its sibling routes without re-reading the env var.
    /// `None` for public PKCE connectors.
    #[serde(default)]
    pub handoff_endpoint: Option<String>,
    pub client_id: String,
    pub brokered: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectorConnection {
    pub connector_id: String,
    pub account: ConnectorAccountSummary,
    pub status: String,
    pub scopes: Vec<String>,
    pub expires_at: Option<u64>,
    pub credential_ref: String,
    pub connected_at: String,
    pub updated_at: String,
    /// Whether this account is the one reads/actions resolve by default.
    /// Exactly one connection per `connector_id` is active; the rest are kept
    /// so the user can switch between multiple Google accounts. Defaults to
    /// `false` for legacy entries; `read_connections` repairs the collection so
    /// exactly one account per connector is active before it is used.
    #[serde(default)]
    pub is_active: bool,
}

pub(crate) trait ConnectorSecretStore: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<String>, String>;
    fn set(&self, key: &str, secret: &str) -> Result<(), String>;
    fn remove(&self, key: &str) -> Result<(), String>;
}

struct NativeConnectorSecretStore;

impl NativeConnectorSecretStore {
    fn entry(key: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(KEYRING_SERVICE, key)
            .map_err(|_| "Fable could not open the OS secure store.".to_string())
    }
}

impl ConnectorSecretStore for NativeConnectorSecretStore {
    fn get(&self, key: &str) -> Result<Option<String>, String> {
        match Self::entry(key)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("Fable could not read connector credentials.".to_string()),
        }
    }

    fn set(&self, key: &str, secret: &str) -> Result<(), String> {
        Self::entry(key)?
            .set_password(secret)
            .map_err(|_| "Fable could not store connector credentials.".to_string())
    }

    fn remove(&self, key: &str) -> Result<(), String> {
        match Self::entry(key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("Fable could not remove connector credentials.".to_string()),
        }
    }
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

fn random_urlsafe(bytes: usize) -> Result<String, ConnectorCommandError> {
    let mut value = vec![0_u8; bytes];
    getrandom::fill(&mut value).map_err(|_| {
        command_error(
            "unknown",
            "oauth",
            "Fable could not initialize a secure OAuth transaction.",
            false,
        )
    })?;
    Ok(URL_SAFE_NO_PAD.encode(value))
}

pub(crate) fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn pending_key(connector_id: &str, state: &str) -> String {
    format!("oauth-pending:{connector_id}:{state}")
}

pub(crate) fn native_connector_credential_ref(connector_id: &str, account_id: &str) -> String {
    format!("oauth-token:{connector_id}:{account_id}")
}

fn now_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Resolve and validate the configured auth broker for a confidential-client
/// provider. The broker exists ONLY for confidential-client OAuth: it owns the
/// provider client secret and performs authorization, handoff redemption, token
/// refresh, and revocation. It never proxies model calls, connector searches,
/// connector imports, or connector actions — those go directly from the desktop
/// to the provider API after native token resolution.
///
/// Fail-closed: a missing, malformed, or non-secure broker URL is a
/// `configuration-required` error, never a silent fallback. Local development
/// may use `http://127.0.0.1` or `http://[::1]`; production must use HTTPS.
///
/// `broker_url` is passed in (rather than read from the environment inline) so
/// the fail-closed checks are unit-testable without env-var races across the
/// parallel test process. Only the four OAuth paths the broker actually serves
/// are derived from the base URL, so this module can never surface a
/// model/search/import/action endpoint.
///
/// The base URL may be a bare host (`https://auth.fable.app`) or carry a path
/// prefix (`https://app.example.com/broker/`) — common for a broker mounted at a
/// route, including a Cloudflare Workers deployment exposed behind a path. A
/// trailing slash is optional; the route is built by extending the base path so
/// the prefix is always preserved.
pub(crate) fn resolve_broker_endpoints(
    connector_id: &str,
    broker_url: Option<&str>,
) -> Result<BrokerEndpoints, ConnectorCommandError> {
    let raw = broker_url.ok_or_else(|| {
        command_error(
            "configuration-required",
            connector_id,
            "This provider requires the configured Fable auth broker.",
            false,
        )
    })?;
    let broker = Url::parse(raw).map_err(|_| {
        command_error(
            "configuration-required",
            connector_id,
            "The Fable auth broker URL is invalid.",
            false,
        )
    })?;
    let loopback = broker.scheme() == "http"
        && broker
            .host_str()
            .is_some_and(|host| host == "127.0.0.1" || host == "::1");
    if broker.scheme() != "https" && !loopback {
        return Err(command_error(
            "configuration-required",
            connector_id,
            "The Fable auth broker must use HTTPS.",
            false,
        ));
    }
    Ok(BrokerEndpoints {
        authorization_endpoint: broker_route(&broker, connector_id, "authorize")?,
        handoff_endpoint: broker_route(&broker, connector_id, "handoff")?,
        refresh_endpoint: broker_route(&broker, connector_id, "refresh")?,
        revocation_endpoint: broker_route(&broker, connector_id, "revoke")?,
    })
}

/// Build a single broker OAuth route by extending the broker base path. The base
/// path keeps any prefix (e.g. `/broker/`) so a route-mounted broker — including
/// a Cloudflare Worker behind a path — resolves correctly with or without a
/// trailing slash. The closed vocabulary of segments is enforced at the call
/// sites; nothing here can invent a non-OAuth route.
fn broker_route(
    broker: &Url,
    connector_id: &str,
    segment: &str,
) -> Result<String, ConnectorCommandError> {
    let base_path = broker.path().trim_end_matches('/');
    let mut url = broker.clone();
    url.set_path(&format!("{base_path}/oauth/{connector_id}/{segment}"));
    url.set_query(None);
    url.set_fragment(None);
    // `Url::set_path` rejects cannot-be-a-base URLs, but those were already
    // rejected as a malformed broker URL above. Treat any residual failure as a
    // configuration error so the desktop never falls back to a guessed route.
    if url.path().ends_with(segment) {
        Ok(url.to_string())
    } else {
        Err(command_error(
            "configuration-required",
            connector_id,
            "Auth broker route is invalid.",
            false,
        ))
    }
}

/// The narrow, exhaustive OAuth surface the auth broker implements. These are
/// exactly the routes the broker serves: `authorize`, `handoff`, `refresh`, and
/// `revoke`. There is no `token` and no `identity` route, and no model, search,
/// import, or action endpoint ever derives from the broker base URL. Keeping
/// this as a dedicated, closed type makes the non-proxying boundary explicit
/// and testable.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct BrokerEndpoints {
    pub authorization_endpoint: String,
    pub handoff_endpoint: String,
    pub refresh_endpoint: String,
    pub revocation_endpoint: String,
}

fn provider_config(
    connector_id: &str,
    auth_mode: &str,
    scopes: Vec<String>,
) -> Result<OAuthProviderConfig, ConnectorCommandError> {
    if auth_mode == "oauth-pkce" {
        let client_id = std::env::var("FABLE_GOOGLE_OAUTH_CLIENT_ID").map_err(|_| {
            command_error(
                "configuration-required",
                connector_id,
                "Desktop OAuth client configuration is required.",
                false,
            )
        })?;
        let mut provider_scopes = vec![
            "openid".to_string(),
            "profile".to_string(),
            "email".to_string(),
        ];
        provider_scopes.extend(scopes.into_iter().map(|scope| match scope.as_str() {
            "drive.file" => "https://www.googleapis.com/auth/drive.file".to_string(),
            "drive.metadata.readonly" => {
                "https://www.googleapis.com/auth/drive.metadata.readonly".to_string()
            }
            "drive.readonly" => "https://www.googleapis.com/auth/drive.readonly".to_string(),
            "gmail.readonly" => "https://www.googleapis.com/auth/gmail.readonly".to_string(),
            "gmail.compose" => "https://www.googleapis.com/auth/gmail.compose".to_string(),
            "calendar.calendarlist.readonly" => {
                "https://www.googleapis.com/auth/calendar.calendarlist.readonly".to_string()
            }
            "calendar.events.readonly" => {
                "https://www.googleapis.com/auth/calendar.events.readonly".to_string()
            }
            "calendar.events" => "https://www.googleapis.com/auth/calendar.events".to_string(),
            _ => scope,
        }));
        return Ok(OAuthProviderConfig {
            authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth".to_string(),
            token_endpoint: Some("https://oauth2.googleapis.com/token".to_string()),
            revocation_endpoint: Some("https://oauth2.googleapis.com/revoke".to_string()),
            userinfo_endpoint: Some("https://openidconnect.googleapis.com/v1/userinfo".to_string()),
            handoff_endpoint: None,
            client_id,
            scopes: provider_scopes,
            brokered: false,
        });
    }

    let broker_url = std::env::var("FABLE_AUTH_BROKER_URL").ok();
    let endpoints = resolve_broker_endpoints(connector_id, broker_url.as_deref())?;
    Ok(OAuthProviderConfig {
        authorization_endpoint: endpoints.authorization_endpoint,
        // The broker has no `/token` route; the desktop never posts a code to it.
        token_endpoint: None,
        revocation_endpoint: Some(endpoints.revocation_endpoint),
        // The broker has no `/identity` route; the handoff response carries the
        // resolved account, so no userinfo fallback is needed.
        userinfo_endpoint: None,
        handoff_endpoint: Some(endpoints.handoff_endpoint),
        client_id: "fable-desktop".to_string(),
        scopes,
        brokered: true,
    })
}

#[cfg(test)]
fn start_with_store(
    connector_id: &str,
    redirect_uri: &str,
    config: OAuthProviderConfig,
    store: &dyn ConnectorSecretStore,
) -> Result<ConnectorAuthResult, ConnectorCommandError> {
    start_with_store_bound(connector_id, redirect_uri, config, store, None, None)
}

fn start_with_store_bound(
    connector_id: &str,
    redirect_uri: &str,
    config: OAuthProviderConfig,
    store: &dyn ConnectorSecretStore,
    fable_account_binding: Option<String>,
    local_workspace_id: Option<String>,
) -> Result<ConnectorAuthResult, ConnectorCommandError> {
    let redirect = Url::parse(redirect_uri).map_err(|_| {
        command_error(
            "invalid-request",
            connector_id,
            "OAuth redirect URL is invalid.",
            false,
        )
    })?;
    let safe_loopback = redirect.scheme() == "http"
        && redirect
            .host_str()
            .is_some_and(|host| host == "127.0.0.1" || host == "::1");
    if redirect.scheme() != "https" && !safe_loopback {
        return Err(command_error(
            "invalid-request",
            connector_id,
            "OAuth redirect must use HTTPS or a loopback IP address.",
            false,
        ));
    }
    let state = random_urlsafe(32)?;
    let verifier = random_urlsafe(64)?;
    let challenge = pkce_challenge(&verifier);
    let mut authorization = Url::parse(&config.authorization_endpoint).map_err(|_| {
        command_error(
            "configuration-required",
            connector_id,
            "OAuth endpoint is invalid.",
            false,
        )
    })?;
    authorization
        .query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &config.client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("scope", &config.scopes.join(" "))
        .append_pair("state", &state)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256");
    if !config.brokered {
        authorization
            .query_pairs_mut()
            .append_pair("access_type", "offline")
            .append_pair("prompt", "consent");
    }
    let pending = PendingOAuth {
        connector_id: connector_id.to_string(),
        state: state.clone(),
        verifier,
        redirect_uri: redirect_uri.to_string(),
        token_endpoint: config.token_endpoint,
        revocation_endpoint: config.revocation_endpoint,
        userinfo_endpoint: config.userinfo_endpoint,
        handoff_endpoint: config.handoff_endpoint,
        client_id: config.client_id,
        scopes: config.scopes,
        brokered: config.brokered,
        created_at: now_epoch(),
        fable_account_binding,
        local_workspace_id,
    };
    let encoded = serde_json::to_string(&pending).map_err(|_| {
        command_error(
            "unknown",
            connector_id,
            "Fable could not encode OAuth state.",
            false,
        )
    })?;
    store
        .set(&pending_key(connector_id, &state), &encoded)
        .map_err(|message| command_error("unknown", connector_id, &message, false))?;
    Ok(ConnectorAuthResult {
        connector_id: connector_id.to_string(),
        status: "configured".to_string(),
        authorization_url: Some(authorization.to_string()),
        account: None,
        message: "Continue authentication in the provider browser.".to_string(),
    })
}

#[derive(Deserialize)]
struct TokenResponse {
    #[serde(alias = "accessToken")]
    access_token: String,
    #[serde(alias = "refreshToken")]
    refresh_token: Option<String>,
    #[serde(alias = "tokenType")]
    token_type: Option<String>,
    #[serde(alias = "expiresIn")]
    expires_in: Option<u64>,
    scope: Option<String>,
    account: Option<ConnectorAccountSummary>,
}

/// Broker handoff redemption response. The broker returns the token set nested
/// under `tokens` plus the resolved `account`; this flattens it onto the
/// {@link TokenResponse} shape the desktop already stores.
#[derive(Deserialize)]
struct HandoffResponse {
    tokens: TokenResponse,
    account: Option<ConnectorAccountSummary>,
}

/// Derive a broker OAuth endpoint (other than the stored one) from the stored
/// endpoint by replacing its final path segment. Used when only the handoff (or
/// refresh) endpoint is persisted but a sibling route — refresh or revoke — is
/// needed for token rotation or disconnect. A malformed endpoint fails closed
/// rather than guessing a route.
fn broker_sibling_endpoint(endpoint: &str, segment: &str) -> Result<String, ConnectorCommandError> {
    let mut url = Url::parse(endpoint).map_err(|_| {
        command_error(
            "configuration-required",
            "oauth",
            "The configured broker endpoint is invalid.",
            false,
        )
    })?;
    let mut segments: Vec<String> = url
        .path_segments()
        .map(|parts| parts.map(str::to_string).collect())
        .unwrap_or_default();
    if segments.last().is_some() {
        let len = segments.len();
        segments[len - 1] = segment.to_string();
        url.path_segments_mut()
            .map_err(|_| {
                command_error(
                    "configuration-required",
                    "oauth",
                    "The configured broker endpoint cannot be resolved.",
                    false,
                )
            })?
            .clear()
            .extend(segments.iter().map(|value| value.as_str()));
        Ok(url.to_string())
    } else {
        Err(command_error(
            "configuration-required",
            "oauth",
            "The configured broker endpoint cannot be resolved.",
            false,
        ))
    }
}

fn mark_refresh_rejected(
    connector_id: &str,
    account_id: &str,
    connections: &mut [ConnectorConnection],
) {
    if let Some(connection) = connections
        .iter_mut()
        .find(|item| item.connector_id == connector_id && item.account.id == account_id)
    {
        connection.status = "expired".to_string();
        connection.updated_at = now_epoch().to_string();
    }
}

/// The redacted error shape every broker route emits on failure (mirrors
/// `BrokerErrorResponse` in `packages/connectors/.../broker-contract.ts`). Only
/// the fields the desktop needs to normalize are parsed; the body is never
/// surfaced verbatim so a malformed or hostile message cannot leak.
#[derive(Deserialize)]
struct BrokerErrorBody {
    error: Option<String>,
    message: Option<String>,
    retryable: Option<bool>,
}

/// Normalize a failed broker response into a structured connector error. The
/// broker emits a redacted `{ error, message, retryable }` body; we map its
/// error code onto the desktop's `ConnectorErrorCode` vocabulary and surface its
/// human-safe `message`. Anything we cannot parse becomes a retryable
/// `provider-unavailable` so an intermittent/unreachable broker stays
/// recoverable and understandable rather than failing silently or permanently.
async fn broker_error_from_response(
    connector_id: &str,
    operation: &str,
    response: reqwest::Response,
) -> ConnectorCommandError {
    let status = response.status().as_u16();
    let retry_after = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());
    let body: Option<BrokerErrorBody> = response.json().await.ok();
    let code = body.as_ref().and_then(|body| body.error.as_deref());
    let message = body
        .as_ref()
        .and_then(|body| body.message.as_deref())
        .filter(|message| !message.trim().is_empty())
        .map(|message| message.to_string());
    let broker_retryable = body.as_ref().and_then(|body| body.retryable);
    broker_error(
        connector_id,
        operation,
        code,
        message,
        broker_retryable,
        status,
        retry_after,
    )
}

/// Map a broker error code + status to a `ConnectorCommandError`. Factored out
/// of {@link broker_error_from_response} so unit tests can pin the mapping
/// without an HTTP round-trip.
fn broker_error(
    connector_id: &str,
    operation: &str,
    code: Option<&str>,
    message: Option<String>,
    broker_retryable: Option<bool>,
    status: u16,
    retry_after: Option<String>,
) -> ConnectorCommandError {
    let default_message = format!("The Fable auth broker {operation} was unsuccessful.");
    let human = message.unwrap_or_else(|| default_message.clone());
    let retry_after = if retry_after
        .as_deref()
        .is_some_and(|value| value.trim().is_empty())
    {
        None
    } else {
        retry_after
    };
    match code {
        // The broker is not configured for this provider. Not retryable as-is:
        // the operator must set it up before the user can connect.
        Some("configuration-required") => {
            command_error("configuration-required", connector_id, &human, false)
        }
        // Throttled. Retryable; honor the broker's Retry-After when present.
        Some("rate-limited") => ConnectorCommandError {
            code: "rate-limited".to_string(),
            connector_id: connector_id.to_string(),
            message: human,
            retryable: true,
            retry_after,
        },
        // A provider outage upstream of the broker. Retryable.
        Some("provider-unavailable") => {
            command_error("provider-unavailable", connector_id, &human, true)
        }
        // Version drift, an invalid/expired/substituted handoff or state, or a
        // malformed request: the transaction is no longer usable, so the user
        // must reconnect (needs-auth). Not retryable.
        Some("unsupported-version")
        | Some("invalid-handoff")
        | Some("expired-handoff")
        | Some("invalid-state")
        | Some("invalid-request")
        | Some("unknown-provider")
        | Some("needs-auth") => command_error("needs-auth", connector_id, &human, false),
        // No recognized code: classify by HTTP status so an unconfigured broker
        // (503) is honest and recoverable, while a malformed body still fails
        // closed without pretending success.
        None => match status {
            502..=504 => {
                command_error("provider-unavailable", connector_id, &default_message, true)
            }
            429 => ConnectorCommandError {
                code: "rate-limited".to_string(),
                connector_id: connector_id.to_string(),
                message: default_message,
                retryable: true,
                retry_after,
            },
            _ if broker_retryable.unwrap_or(false) => {
                command_error("provider-unavailable", connector_id, &default_message, true)
            }
            _ => command_error("needs-auth", connector_id, &default_message, false),
        },
        // Unknown code: fall back to the broker's own retryability hint, if any,
        // otherwise treat as a non-retryable auth failure (fail closed).
        Some(_) => {
            if broker_retryable.unwrap_or(false) {
                command_error("provider-unavailable", connector_id, &default_message, true)
            } else {
                command_error("needs-auth", connector_id, &default_message, false)
            }
        }
    }
}

/// Redeem a single-use broker handoff ticket for the token set + account. The
/// ticket is bound to the desktop state and single-use, so a replayed or
/// substituted handoff is rejected by the broker. Broker errors are normalized
/// to structured, recoverable connector codes via {@link broker_error_from_response}.
async fn redeem_handoff(
    connector_id: &str,
    handoff_endpoint: &str,
    handoff: &str,
    state: &str,
) -> Result<TokenResponse, ConnectorCommandError> {
    let response = reqwest::Client::new()
        .post(handoff_endpoint)
        .json(&serde_json::json!({
            "contractVersion": 1,
            "provider": connector_id,
            "handoff": handoff,
            "state": state,
        }))
        .send()
        .await
        .map_err(|_| {
            command_error(
                "provider-unavailable",
                connector_id,
                "The Fable auth broker could not be reached.",
                true,
            )
        })?;
    if !response.status().is_success() {
        return Err(broker_error_from_response(connector_id, "handoff", response).await);
    }
    let handoff_response: HandoffResponse = response.json().await.map_err(|_| {
        command_error(
            "provider-unavailable",
            connector_id,
            "The Fable auth broker handoff response was invalid.",
            true,
        )
    })?;
    let mut tokens = handoff_response.tokens;
    tokens.account = handoff_response.account.or(tokens.account);
    Ok(tokens)
}

struct CredentialRollback {
    credential_ref: String,
    previous_secret: Option<String>,
}

async fn prepare_with_store(
    connector_id: &str,
    callback_url: &str,
    store: &dyn ConnectorSecretStore,
    expected_account_binding: Option<&str>,
    expected_workspace_id: Option<&str>,
) -> Result<
    (
        StoredTokenSet,
        ConnectorAccountSummary,
        String,
        CredentialRollback,
        String,
    ),
    ConnectorCommandError,
> {
    let callback = Url::parse(callback_url).map_err(|_| {
        command_error(
            "invalid-request",
            connector_id,
            "OAuth callback URL is invalid.",
            false,
        )
    })?;
    let mut parameters = BTreeMap::new();
    for (key, value) in callback.query_pairs() {
        if parameters.insert(key.clone(), value).is_some() {
            return Err(command_error(
                "invalid-request",
                connector_id,
                &format!("OAuth callback contains duplicate {key} parameters."),
                false,
            ));
        }
    }
    if let Some(error) = parameters.get("error") {
        return Err(command_error("needs-auth", connector_id, error, false));
    }
    let state = parameters.get("state").ok_or_else(|| {
        command_error(
            "invalid-request",
            connector_id,
            "OAuth callback is missing state.",
            false,
        )
    })?;
    // The callback carries EITHER an authorization `code` (public PKCE, exchanged
    // directly with the provider) OR a `handoff` ticket (confidential broker flow,
    // where the broker already performed the secret exchange and the desktop
    // redeems the single-use ticket for tokens). One of the two is required.
    let code = parameters.get("code").cloned();
    let handoff = parameters.get("handoff").cloned();
    if code.is_none() && handoff.is_none() {
        return Err(command_error(
            "invalid-request",
            connector_id,
            "OAuth callback is missing a code or handoff ticket.",
            false,
        ));
    }
    let key = pending_key(connector_id, state);
    let encoded = store
        .get(&key)
        .map_err(|message| command_error("unknown", connector_id, &message, false))?
        .ok_or_else(|| {
            command_error(
                "invalid-request",
                connector_id,
                "OAuth state is unknown or expired.",
                false,
            )
        })?;
    let pending: PendingOAuth = serde_json::from_str(&encoded).map_err(|_| {
        command_error(
            "invalid-request",
            connector_id,
            "Stored OAuth state is invalid.",
            false,
        )
    })?;
    if pending.state != state.as_ref() || pending.connector_id != connector_id {
        return Err(command_error(
            "invalid-request",
            connector_id,
            "OAuth state did not match.",
            false,
        ));
    }
    if pending.fable_account_binding.as_deref() != expected_account_binding {
        store
            .remove(&key)
            .map_err(|message| command_error("unknown", connector_id, &message, false))?;
        return Err(command_error(
            "needs-auth",
            connector_id,
            "Fable account changed during connector authorization; try again.",
            false,
        ));
    }
    if pending.local_workspace_id.as_deref() != expected_workspace_id {
        store
            .remove(&key)
            .map_err(|message| command_error("unknown", connector_id, &message, false))?;
        return Err(command_error(
            "needs-auth",
            connector_id,
            "Active workspace changed during connector authorization; try again.",
            false,
        ));
    }
    if now_epoch().saturating_sub(pending.created_at) > OAUTH_PENDING_MAX_AGE_SECONDS {
        store
            .remove(&key)
            .map_err(|message| command_error("unknown", connector_id, &message, false))?;
        return Err(command_error(
            "invalid-request",
            connector_id,
            "OAuth state expired; start authorization again.",
            false,
        ));
    }
    let expected_redirect = Url::parse(&pending.redirect_uri).map_err(|_| {
        command_error(
            "invalid-request",
            connector_id,
            "Stored OAuth redirect is invalid.",
            false,
        )
    })?;
    if callback.scheme() != expected_redirect.scheme()
        || callback.host_str() != expected_redirect.host_str()
        || callback.port_or_known_default() != expected_redirect.port_or_known_default()
        || callback.path() != expected_redirect.path()
    {
        return Err(command_error(
            "invalid-request",
            connector_id,
            "OAuth callback did not match the registered redirect.",
            false,
        ));
    }

    // State and verifier values are single-use. Consume them before network
    // egress so callback replay cannot trigger a second token exchange.
    store
        .remove(&key)
        .map_err(|message| command_error("unknown", connector_id, &message, false))?;

    crate::ensure_rustls_provider();
    let response: TokenResponse = if let Some(handoff_ticket) = handoff {
        // Confidential broker flow: the broker already performed the secret-bound
        // exchange and minted a single-use handoff bound to this state. Redeem it
        // directly (not in the browser) so the token set crosses only to the
        // desktop. The handoff endpoint is the exact broker route derived from the
        // configured base URL (see {@link resolve_broker_endpoints}); it is not
        // re-derived at completion, so a stale config change mid-flight fails
        // closed rather than guessing a route.
        let handoff_endpoint = pending.handoff_endpoint.clone().ok_or_else(|| {
            command_error(
                "configuration-required",
                connector_id,
                "This provider requires the configured Fable auth broker.",
                false,
            )
        })?;
        redeem_handoff(
            connector_id,
            &handoff_endpoint,
            &handoff_ticket,
            state.as_ref(),
        )
        .await?
    } else {
        let code_value = code.expect("validated above: code or handoff present");
        // Public PKCE flow: exchange the authorization code directly with the
        // provider using the stored verifier.
        let token_endpoint = pending.token_endpoint.clone().ok_or_else(|| {
            command_error(
                "configuration-required",
                connector_id,
                "Provider token endpoint is required.",
                false,
            )
        })?;
        let response = reqwest::Client::new()
            .post(&token_endpoint)
            .form(&[
                ("grant_type", "authorization_code"),
                ("code", &code_value),
                ("client_id", pending.client_id.as_str()),
                ("redirect_uri", pending.redirect_uri.as_str()),
                ("code_verifier", pending.verifier.as_str()),
            ])
            .send()
            .await
            .map_err(|_| {
                command_error(
                    "provider-unavailable",
                    connector_id,
                    "OAuth token exchange failed.",
                    true,
                )
            })?;
        if !response.status().is_success() {
            return Err(command_error(
                "needs-auth",
                connector_id,
                "OAuth token exchange was rejected.",
                false,
            ));
        }
        response.json().await.map_err(|_| {
            command_error(
                "provider-unavailable",
                connector_id,
                "OAuth token response was invalid.",
                true,
            )
        })?
    };
    // The broker contract always returns the resolved account in the handoff
    // response, and the broker has no `/identity` route. So for a brokered
    // connector a missing account is an honest, retryable provider-unavailable
    // failure — never a reason to hit a non-existent endpoint. Public PKCE
    // connectors fall back to the provider's userinfo endpoint as before.
    let account = match (pending.brokered, response.account) {
        (_, Some(account)) => account,
        (true, None) => {
            return Err(command_error(
                "provider-unavailable",
                connector_id,
                "The auth broker did not return the connected account.",
                true,
            ));
        }
        (false, None) => {
            fetch_identity(
                connector_id,
                pending.userinfo_endpoint.as_deref(),
                &response.access_token,
            )
            .await?
        }
    };
    let credential_ref = native_connector_credential_ref(connector_id, &account.id);
    let previous_secret = store
        .get(&credential_ref)
        .map_err(|message| command_error("unknown", connector_id, &message, false))?;
    let previous = previous_secret
        .as_deref()
        .and_then(|encoded| serde_json::from_str::<StoredTokenSet>(encoded).ok());
    let granted_scopes: Vec<String> = match response.scope.as_deref() {
        Some(scope) => scope.split_whitespace().map(str::to_string).collect(),
        // Public installed-app tokens must not inherit historical grants:
        // Google's token response is the active credential's scope truth.
        None if !pending.brokered => Vec::new(),
        // Brokered providers are outside the Google installed-app path. Keep
        // their declared scope fallback for legacy broker responses that omit
        // the optional scope field.
        None => pending.scopes.clone(),
    };
    let tokens = StoredTokenSet {
        access_token: response.access_token,
        refresh_token: response
            .refresh_token
            .or_else(|| previous.and_then(|tokens| tokens.refresh_token)),
        token_type: response.token_type.unwrap_or_else(|| "Bearer".to_string()),
        expires_at: response
            .expires_in
            .map(|seconds| now_epoch().saturating_add(seconds)),
        scopes: granted_scopes,
        revocation_endpoint: pending.revocation_endpoint,
        token_endpoint: pending.token_endpoint,
        handoff_endpoint: pending.handoff_endpoint,
        client_id: pending.client_id,
        brokered: pending.brokered,
    };
    let encoded_tokens = serde_json::to_string(&tokens).map_err(|_| {
        command_error(
            "unknown",
            connector_id,
            "Fable could not encode connector tokens.",
            false,
        )
    })?;
    Ok((
        tokens,
        account,
        credential_ref.clone(),
        CredentialRollback {
            credential_ref,
            previous_secret,
        },
        encoded_tokens,
    ))
}

#[cfg(test)]
async fn complete_with_store(
    connector_id: &str,
    callback_url: &str,
    store: &dyn ConnectorSecretStore,
) -> Result<(StoredTokenSet, ConnectorAccountSummary, String), ConnectorCommandError> {
    let (tokens, account, credential_ref, _rollback, encoded_tokens) =
        prepare_with_store(connector_id, callback_url, store, None, None).await?;
    store
        .set(&credential_ref, &encoded_tokens)
        .map_err(|message| command_error("unknown", connector_id, &message, false))?;
    Ok((tokens, account, credential_ref))
}

fn rollback_credential(
    store: &dyn ConnectorSecretStore,
    rollback: CredentialRollback,
) -> Result<(), String> {
    match rollback.previous_secret {
        Some(previous) => store.set(&rollback.credential_ref, &previous),
        None => store.remove(&rollback.credential_ref),
    }
}

fn persist_credential_after_guard<G>(
    store: &dyn ConnectorSecretStore,
    connector_id: &str,
    credential_ref: &str,
    encoded_tokens: &str,
    before_commit: impl FnOnce() -> Result<G, ConnectorCommandError>,
) -> Result<G, ConnectorCommandError> {
    let guard = before_commit()?;
    store
        .set(credential_ref, encoded_tokens)
        .map_err(|message| command_error("unknown", connector_id, &message, false))?;
    Ok(guard)
}

fn finish_metadata_commit(
    result: Result<(), String>,
    store: &dyn ConnectorSecretStore,
    rollback: CredentialRollback,
) -> Result<(), String> {
    if let Err(error) = result {
        return match rollback_credential(store, rollback) {
            Ok(()) => Err(error),
            Err(_) => Err(
                "Fable could not save connector state or restore the prior credential; reconnect this provider."
                    .into(),
            ),
        };
    }
    Ok(())
}

async fn fetch_identity(
    connector_id: &str,
    endpoint: Option<&str>,
    access_token: &str,
) -> Result<ConnectorAccountSummary, ConnectorCommandError> {
    let endpoint = endpoint.ok_or_else(|| {
        command_error(
            "provider-unavailable",
            connector_id,
            "Provider account identity is unavailable.",
            false,
        )
    })?;
    crate::ensure_rustls_provider();
    let response = reqwest::Client::new()
        .get(endpoint)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|_| {
            command_error(
                "provider-unavailable",
                connector_id,
                "Provider identity request failed.",
                true,
            )
        })?;
    if !response.status().is_success() {
        return Err(command_error(
            "needs-auth",
            connector_id,
            "Provider identity request was rejected.",
            false,
        ));
    }
    let value: serde_json::Value = response.json().await.map_err(|_| {
        command_error(
            "provider-unavailable",
            connector_id,
            "Provider identity response was invalid.",
            true,
        )
    })?;
    let id = ["id", "sub", "user_id", "team_id"]
        .iter()
        .find_map(|key| value.get(*key).and_then(|value| value.as_str()))
        .ok_or_else(|| {
            command_error(
                "provider-unavailable",
                connector_id,
                "Provider identity has no stable id.",
                false,
            )
        })?;
    let email = value
        .get("email")
        .and_then(|value| value.as_str())
        .map(str::to_string);
    let display_name = ["name", "login", "email"]
        .iter()
        .find_map(|key| value.get(*key).and_then(|value| value.as_str()))
        .unwrap_or(id)
        .to_string();
    Ok(ConnectorAccountSummary {
        id: id.to_string(),
        display_name,
        handle: value
            .get("login")
            .and_then(|value| value.as_str())
            .map(str::to_string),
        email,
        workspace: value
            .get("team_name")
            .and_then(|value| value.as_str())
            .map(str::to_string),
        avatar_url: value
            .get("picture")
            .or_else(|| value.get("avatar_url"))
            .and_then(|value| value.as_str())
            .map(str::to_string),
    })
}

pub(crate) fn read_connections(path: &Path) -> Result<Vec<ConnectorConnection>, String> {
    if let Some(connections) = crate::store::read_document(path)? {
        return Ok(connections);
    }
    if !path.exists() {
        return Ok(Vec::new());
    }
    let contents = fs::read_to_string(path)
        .map_err(|_| "Fable could not read connector state.".to_string())?;
    if contents.trim().is_empty() {
        return Ok(Vec::new());
    }
    let mut connections: Vec<ConnectorConnection> = serde_json::from_str(&contents)
        .map_err(|_| "Fable could not parse connector state.".to_string())?;
    normalize_active_accounts(&mut connections);
    Ok(connections)
}

fn normalize_active_accounts(connections: &mut [ConnectorConnection]) {
    let mut connector_ids = connections
        .iter()
        .map(|connection| connection.connector_id.clone())
        .collect::<Vec<_>>();
    connector_ids.sort();
    connector_ids.dedup();
    for connector_id in connector_ids {
        let matching = connections
            .iter()
            .enumerate()
            .filter(|(_, connection)| connection.connector_id == connector_id)
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        let active = matching
            .iter()
            .copied()
            .filter(|index| connections[*index].is_active)
            .collect::<Vec<_>>();
        let selected = active
            .first()
            .copied()
            .or_else(|| matching.first().copied());
        for index in matching {
            connections[index].is_active = Some(index) == selected;
        }
    }
}

pub(crate) fn write_connections(
    path: &Path,
    connections: &[ConnectorConnection],
) -> Result<(), String> {
    if crate::store::write_document(path, &connections)? {
        return Ok(());
    }
    let encoded = serde_json::to_vec_pretty(connections)
        .map_err(|_| "Fable could not encode connector state.".to_string())?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, encoded)
        .map_err(|_| "Fable could not save connector state.".to_string())?;
    fs::rename(&temporary, path).map_err(|_| "Fable could not commit connector state.".to_string())
}

/// Resolve the *active* connection for a connector. With multi-account
/// support several accounts may be connected; reads/actions resolve against the
/// one flagged active. Falls back to the first connection if none is flagged
/// (legacy files / invariant drift) so an account never becomes unreachable.
fn selected_connection_id(path: &Path, connector_id: &str) -> Option<String> {
    let identity = crate::clerk_identity::native_identity_generation_snapshot().ok()?;
    let scope = crate::authorized_scope::command_scope(
        Some(crate::store::repos::scope::DEFAULT_WORKSPACE_ID.to_string()),
        None,
        crate::authorized_scope::ScopeAccess::Write,
    )
    .ok()?;
    let _guard = crate::clerk_identity::lock_native_identity_generation(&identity).ok()?;
    let durable_store = crate::store::try_global()?;
    let existing = durable_store
        .with_conn(|tx| crate::store::repos::connection_selection::get(tx, &scope, connector_id))
        .ok()?;
    if let Some(selection) = existing {
        return Some(selection.connection_id);
    }

    let connections = read_connections(path).ok()?;
    let compatibility_active = connections
        .iter()
        .find(|connection| connection.connector_id == connector_id && connection.is_active)
        .or_else(|| {
            connections
                .iter()
                .find(|connection| connection.connector_id == connector_id)
        })?;
    let record = canonical_connection_for_refresh(
        durable_store,
        &scope,
        connector_id,
        &compatibility_active.account.id,
    )
    .ok()?;
    if record.lifecycle != "authorized"
        || record.authorization_state != "authorized"
        || record.credential_state != "available"
    {
        return None;
    }
    durable_store
        .transaction(|tx| {
            crate::store::repos::connection_selection::select(
                tx,
                durable_store,
                &scope,
                connector_id,
                &record.id,
                None,
                &now_epoch().to_string(),
            )
        })
        .ok()
        .map(|selection| selection.connection_id)
}

pub(crate) fn connection_for(path: &Path, connector_id: &str) -> Option<ConnectorConnection> {
    let selected = selected_connection_id(path, connector_id)?;
    read_connections(path).ok()?.into_iter().find(|connection| {
        connection.connector_id == connector_id
            && derive_native_connection_id(
                crate::store::repos::scope::DEFAULT_WORKSPACE_ID,
                connector_id,
                &connection.account.id,
            ) == selected
    })
}

pub(crate) fn usable_connection(path: &Path, connector_id: &str) -> Option<ConnectorConnection> {
    let connection = connection_for(path, connector_id)?;
    let identity = crate::clerk_identity::native_identity_generation_snapshot().ok()?;
    let scope = crate::authorized_scope::command_scope(
        Some(crate::store::repos::scope::DEFAULT_WORKSPACE_ID.to_string()),
        None,
        crate::authorized_scope::ScopeAccess::Read,
    )
    .ok()?;
    let _guard = crate::clerk_identity::lock_native_identity_generation(&identity).ok()?;
    let durable_store = crate::store::try_global()?;
    let canonical = canonical_connection_for_refresh(
        durable_store,
        &scope,
        connector_id,
        &connection.account.id,
    )
    .ok()?;
    if canonical.lifecycle != "authorized"
        || canonical.authorization_state != "authorized"
        || canonical.credential_state != "available"
    {
        return None;
    }
    NativeConnectorSecretStore
        .get(&connection.credential_ref)
        .ok()
        .flatten()
        .map(|_| connection)
}

pub(crate) fn start_auth(
    connector_id: &str,
    auth_mode: &str,
    scopes: Vec<String>,
    request: ConnectorAuthRequest,
    identity: &crate::clerk_identity::NativeIdentityGenerationSnapshot,
    scope: &crate::authorized_scope::AuthorizedCommandScope,
) -> Result<ConnectorAuthResult, ConnectorCommandError> {
    let redirect = request.redirect_uri.ok_or_else(|| {
        command_error(
            "invalid-request",
            connector_id,
            "OAuth redirect URL is required.",
            false,
        )
    })?;
    let config = provider_config(connector_id, auth_mode, scopes)?;
    start_with_store_bound(
        connector_id,
        &redirect,
        config,
        &NativeConnectorSecretStore,
        Some(identity.account_binding.clone()),
        Some(scope.data.workspace_id().to_string()),
    )
}

pub(crate) async fn complete_auth(
    app: &tauri::AppHandle,
    connector_id: &str,
    request: ConnectorAuthRequest,
    identity: &crate::clerk_identity::NativeIdentityGenerationSnapshot,
    scope: &crate::authorized_scope::AuthorizedCommandScope,
) -> Result<ConnectorAuthResult, ConnectorCommandError> {
    let callback = request.callback_url.ok_or_else(|| {
        command_error(
            "invalid-request",
            connector_id,
            "OAuth callback URL is required.",
            false,
        )
    })?;
    let secret_store = NativeConnectorSecretStore;
    let prepared = prepare_with_store(
        connector_id,
        &callback,
        &secret_store,
        Some(&identity.account_binding),
        Some(scope.data.workspace_id()),
    )
    .await?;
    commit_prepared_auth(app, connector_id, identity, scope, &secret_store, prepared)
}

fn commit_prepared_auth(
    app: &tauri::AppHandle,
    connector_id: &str,
    identity: &crate::clerk_identity::NativeIdentityGenerationSnapshot,
    scope: &crate::authorized_scope::AuthorizedCommandScope,
    secret_store: &dyn ConnectorSecretStore,
    prepared: (
        StoredTokenSet,
        ConnectorAccountSummary,
        String,
        CredentialRollback,
        String,
    ),
) -> Result<ConnectorAuthResult, ConnectorCommandError> {
    let path = connector_connections_path(app)
        .map_err(|message| command_error("unknown", connector_id, &message, false))?;
    let durable_store = crate::store::try_global().ok_or_else(|| {
        command_error(
            "unknown",
            connector_id,
            "Fable's encrypted store is not initialized.",
            false,
        )
    })?;
    commit_prepared_auth_state(
        &path,
        durable_store,
        connector_id,
        scope,
        secret_store,
        prepared,
        || {
            crate::clerk_identity::lock_native_identity_generation(identity)
                .map_err(|message| command_error("needs-auth", connector_id, &message, false))
        },
    )
}

fn commit_prepared_auth_state<G>(
    path: &Path,
    durable_store: &crate::store::Store,
    connector_id: &str,
    scope: &crate::authorized_scope::AuthorizedCommandScope,
    secret_store: &dyn ConnectorSecretStore,
    prepared: (
        StoredTokenSet,
        ConnectorAccountSummary,
        String,
        CredentialRollback,
        String,
    ),
    before_commit: impl FnOnce() -> Result<G, ConnectorCommandError>,
) -> Result<ConnectorAuthResult, ConnectorCommandError> {
    let (tokens, account, credential_ref, rollback, encoded_tokens) = prepared;
    let _commit_guard = persist_credential_after_guard(
        secret_store,
        connector_id,
        &credential_ref,
        &encoded_tokens,
        before_commit,
    )?;
    let timestamp = now_epoch().to_string();
    let connection = ConnectorConnection {
        connector_id: connector_id.to_string(),
        account: account.clone(),
        status: "connected".to_string(),
        scopes: tokens.scopes,
        expires_at: tokens.expires_at,
        credential_ref,
        connected_at: timestamp.clone(),
        updated_at: timestamp.clone(),
        is_active: true,
    };
    let previous_connections = match read_connections(path) {
        Ok(connections) => connections,
        Err(error) => {
            return finish_metadata_commit(Err(error), secret_store, rollback)
                .map(|_| unreachable!())
                .map_err(|message| command_error("unknown", connector_id, &message, false));
        }
    };
    let mut connections = previous_connections.clone();
    let mut replaced = false;
    for existing in connections.iter_mut() {
        if existing.connector_id == connector_id {
            existing.is_active = false;
            if existing.account.id == account.id {
                *existing = connection.clone();
                replaced = true;
            }
        }
    }
    if !replaced {
        connections.insert(0, connection);
    }
    promote_single_active(&mut connections, connector_id);
    if let Err(error) = write_connections(path, &connections) {
        return finish_metadata_commit(Err(error), secret_store, rollback)
            .map(|_| unreachable!())
            .map_err(|message| command_error("unknown", connector_id, &message, false));
    }

    let canonical_result = durable_store.transaction(|tx| {
        let id = derive_native_connection_id(scope.data.workspace_id(), connector_id, &account.id);
        let existing = crate::store::repos::connection_record::get(tx, durable_store, scope, &id)?;
        let expected_revision = existing.as_ref().map(|record| record.revision);
        let health_state = existing
            .as_ref()
            .map(|record| record.health_state.as_str())
            .unwrap_or("unknown");
        let saved = crate::store::repos::connection_record::upsert_native_connector(
            tx,
            durable_store,
            scope,
            crate::store::repos::connection_record::NativeConnectorConnectionWrite {
                connector_definition_key: connector_id,
                external_account_id: &account.id,
                display_name: &account.display_name,
                lifecycle: "authorized",
                authorization_state: "authorized",
                health_state,
                credential_state: "available",
                expected_revision,
                updated_at: &timestamp,
            },
        )?;
        let selection = crate::store::repos::connection_selection::get(tx, scope, connector_id)?;
        crate::store::repos::connection_selection::select(
            tx,
            durable_store,
            scope,
            connector_id,
            &saved.id,
            selection.as_ref().map(|value| value.revision),
            &timestamp,
        )?;
        Ok(())
    });
    if let Err(error) = canonical_result {
        let metadata_restored = write_connections(path, &previous_connections).is_ok();
        let credential_restored = rollback_credential(secret_store, rollback).is_ok();
        return if metadata_restored && credential_restored {
            Err(command_error(
                "unknown",
                connector_id,
                &error.to_string(),
                false,
            ))
        } else {
            Err(command_error(
                "unknown",
                connector_id,
                "Fable could not finish or fully restore connector authorization; reconnect this provider.",
                false,
            ))
        };
    }
    Ok(ConnectorAuthResult {
        connector_id: connector_id.to_string(),
        status: "connected".to_string(),
        authorization_url: None,
        account: Some(safe_account_projection(
            &account,
            connector_id,
            scope.data.workspace_id(),
        )),
        message: "Connector account authenticated.".to_string(),
    })
}

/// Enforce the "exactly one active account per connector" invariant. If no
/// account is active (e.g. a legacy file where the field defaulted), promote
/// the first one for the connector. Other connectors are untouched.
fn promote_single_active(connections: &mut [ConnectorConnection], connector_id: &str) {
    let has_active = connections
        .iter()
        .any(|connection| connection.connector_id == connector_id && connection.is_active);
    if has_active {
        return;
    }
    for connection in connections.iter_mut() {
        if connection.connector_id == connector_id {
            connection.is_active = true;
            break;
        }
    }
}

/// All stored accounts for a connector (active first), so the UI can render an
/// account switcher. Token secrets never leave the credential boundary; only
/// the non-secret account summaries are returned.
#[cfg(test)]
pub(crate) fn accounts_for_connector(
    path: &Path,
    connector_id: &str,
    workspace_id: &str,
) -> Vec<ConnectorAccountOption> {
    let Ok(connections) = read_connections(path) else {
        return Vec::new();
    };
    account_options_from_connections(&connections, connector_id, workspace_id)
}

pub(crate) fn account_options_from_connections(
    connections: &[ConnectorConnection],
    connector_id: &str,
    workspace_id: &str,
) -> Vec<ConnectorAccountOption> {
    let mut matching: Vec<&ConnectorConnection> = connections
        .iter()
        .filter(|connection| connection.connector_id == connector_id)
        .collect();
    // Stable sort so the active account sorts to the front.
    matching.sort_by_key(|connection| !connection.is_active);
    matching
        .into_iter()
        .map(|connection| {
            let connection_id =
                derive_native_connection_id(workspace_id, connector_id, &connection.account.id);
            ConnectorAccountOption {
                account: safe_account_projection(&connection.account, connector_id, workspace_id),
                connection_id,
                active: connection.is_active,
                lifecycle: match connection.status.as_str() {
                    "connected" => "authorized",
                    "expired" => "refresh-required",
                    _ => "pending-authorization",
                }
                .into(),
                authorization_state: match connection.status.as_str() {
                    "connected" => "authorized",
                    "expired" => "expired",
                    _ => "pending",
                }
                .into(),
                health_state: "unknown".into(),
                credential_custody: "os-secure-store".into(),
                credential_state: match connection.status.as_str() {
                    "connected" => "available",
                    "expired" => "refresh-required",
                    _ => "unknown",
                }
                .into(),
            }
        })
        .collect()
}

pub(crate) fn safe_account_projection(
    account: &ConnectorAccountSummary,
    connector_id: &str,
    workspace_id: &str,
) -> ConnectorAccountSummary {
    ConnectorAccountSummary {
        id: derive_native_connection_id(workspace_id, connector_id, &account.id),
        display_name: account.display_name.clone(),
        handle: account.handle.clone(),
        email: account.email.clone(),
        workspace: account.workspace.clone(),
        avatar_url: account.avatar_url.clone(),
    }
}

/// Derive the stable Fable identity used by both the compatibility runtime and
/// the durable Connection migration. Keeping this in one native boundary
/// prevents a storage backfill from minting identities the selector cannot
/// later resolve.
pub(crate) fn derive_native_connection_id(
    workspace_id: &str,
    connector_id: &str,
    account_id: &str,
) -> String {
    let mut digest = Sha256::new();
    digest.update(b"fable.connection.native-connector.v1\0");
    for value in [workspace_id, connector_id, account_id] {
        digest.update(value.as_bytes());
        digest.update(b"\0");
    }
    format!("connection_{}", URL_SAFE_NO_PAD.encode(digest.finalize()))
}

/// Select the workspace-bound Fable Connection for `connector_id`. Provider
/// account ids are compatibility metadata and are never accepted as authority.
pub(crate) fn switch_active_connection(
    path: &Path,
    connector_id: &str,
    workspace_id: &str,
    requested_connection_id: &str,
) -> Result<ConnectorAccountSummary, ConnectorCommandError> {
    let mut connections = read_connections(path)
        .map_err(|message| command_error("unknown", connector_id, &message, false))?;
    let mut found: Option<ConnectorAccountSummary> = None;
    let mut saw_connector = false;
    for connection in connections.iter_mut() {
        if connection.connector_id != connector_id {
            continue;
        }
        saw_connector = true;
        let matches =
            derive_native_connection_id(workspace_id, connector_id, &connection.account.id)
                == requested_connection_id;
        connection.is_active = matches;
        connection.updated_at = now_epoch().to_string();
        if matches {
            found = Some(connection.account.clone());
        }
    }
    if !saw_connector {
        return Err(command_error(
            "needs-auth",
            connector_id,
            "Connector is not authenticated.",
            false,
        ));
    }
    let account = found.ok_or_else(|| {
        command_error(
            "not-found",
            connector_id,
            "The selected account is not connected.",
            false,
        )
    })?;
    promote_single_active(&mut connections, connector_id);
    write_connections(path, &connections)
        .map_err(|message| command_error("unknown", connector_id, &message, false))?;
    Ok(account)
}

pub(crate) async fn disconnect(
    app: &tauri::AppHandle,
    connector_id: &str,
    identity: &crate::clerk_identity::NativeIdentityGenerationSnapshot,
    scope: &crate::authorized_scope::AuthorizedCommandScope,
) -> Result<(), ConnectorCommandError> {
    let path = connector_connections_path(app)
        .map_err(|message| command_error("unknown", connector_id, &message, false))?;
    let durable_store = crate::store::try_global().ok_or_else(|| {
        command_error(
            "unknown",
            connector_id,
            "Fable's encrypted store is not initialized.",
            false,
        )
    })?;
    let _ = selected_connection_id(&path, connector_id);
    disconnect_with_store_and_path(
        connector_id,
        &NativeConnectorSecretStore,
        &path,
        durable_store,
        scope,
        || {
            crate::clerk_identity::lock_native_identity_generation(identity)
                .map_err(|message| command_error("needs-auth", connector_id, &message, false))
        },
    )
    .await
}

#[derive(Clone)]
struct PreparedDisconnect {
    connection: ConnectorConnection,
    previous_connections: Vec<ConnectorConnection>,
    previous_secret: Option<String>,
}

fn prepare_disconnect(
    connector_id: &str,
    store: &dyn ConnectorSecretStore,
    path: &Path,
    durable_store: &crate::store::Store,
    scope: &crate::authorized_scope::AuthorizedCommandScope,
) -> Result<Option<PreparedDisconnect>, ConnectorCommandError> {
    let previous_connections = read_connections(path)
        .map_err(|message| command_error("unknown", connector_id, &message, false))?;
    let selection = durable_store
        .with_conn(|tx| crate::store::repos::connection_selection::get(tx, scope, connector_id))
        .map_err(|error| command_error("unknown", connector_id, &error.to_string(), false))?;
    let active = selection.and_then(|selection| {
        previous_connections
            .iter()
            .find(|item| {
                item.connector_id == connector_id
                    && derive_native_connection_id(
                        scope.data.workspace_id(),
                        connector_id,
                        &item.account.id,
                    ) == selection.connection_id
            })
            .cloned()
    });
    let Some(connection) = active else {
        return Ok(None);
    };
    let previous_secret = store
        .get(&connection.credential_ref)
        .map_err(|message| command_error("unknown", connector_id, &message, false))?;
    Ok(Some(PreparedDisconnect {
        connection,
        previous_connections,
        previous_secret,
    }))
}

fn same_connection_snapshot(left: &[ConnectorConnection], right: &[ConnectorConnection]) -> bool {
    serde_json::to_vec(left).ok() == serde_json::to_vec(right).ok()
}

fn commit_prepared_disconnect<G>(
    connector_id: &str,
    store: &dyn ConnectorSecretStore,
    path: &Path,
    durable_store: &crate::store::Store,
    scope: &crate::authorized_scope::AuthorizedCommandScope,
    prepared: &PreparedDisconnect,
    before_commit: impl FnOnce() -> Result<G, ConnectorCommandError>,
) -> Result<(), ConnectorCommandError> {
    let _commit_guard = before_commit()?;
    let current_connections = read_connections(path)
        .map_err(|message| command_error("unknown", connector_id, &message, false))?;
    if !same_connection_snapshot(&current_connections, &prepared.previous_connections) {
        return Err(command_error(
            "conflict",
            connector_id,
            "Connector state changed before disconnect could be saved.",
            true,
        ));
    }
    let current_secret = store
        .get(&prepared.connection.credential_ref)
        .map_err(|message| command_error("unknown", connector_id, &message, false))?;
    if current_secret != prepared.previous_secret {
        return Err(command_error(
            "conflict",
            connector_id,
            "Connector credentials changed before disconnect could be saved.",
            true,
        ));
    }
    store
        .remove(&prepared.connection.credential_ref)
        .map_err(|message| command_error("unknown", connector_id, &message, false))?;
    let rollback = CredentialRollback {
        credential_ref: prepared.connection.credential_ref.clone(),
        previous_secret: prepared.previous_secret.clone(),
    };
    let mut connections = current_connections;
    connections.retain(|item| {
        !(item.connector_id == connector_id && item.account.id == prepared.connection.account.id)
    });
    promote_single_active(&mut connections, connector_id);
    if let Err(error) = write_connections(path, &connections) {
        return finish_metadata_commit(Err(error), store, rollback)
            .map(|_| unreachable!())
            .map_err(|message| command_error("unknown", connector_id, &message, false));
    }
    let canonical_result = durable_store.transaction(|tx| {
        let id = derive_native_connection_id(
            scope.data.workspace_id(),
            connector_id,
            &prepared.connection.account.id,
        );
        let existing = crate::store::repos::connection_record::get(tx, durable_store, scope, &id)?
            .ok_or_else(|| {
                crate::store::StoreError::Invalid("Connection is unavailable.".into())
            })?;
        crate::store::repos::connection_record::transition_native_connector(
            tx,
            durable_store,
            scope,
            &id,
            existing.revision,
            "disconnected",
            "revoked",
            "offline",
            "revoked",
            &now_epoch().to_string(),
        )?;
        if let Some(selection) =
            crate::store::repos::connection_selection::get(tx, scope, connector_id)?
        {
            if selection.connection_id == id {
                if let Some(next) = connections.iter().find(|connection| {
                    connection.connector_id == connector_id && connection.is_active
                }) {
                    let next_id = derive_native_connection_id(
                        scope.data.workspace_id(),
                        connector_id,
                        &next.account.id,
                    );
                    crate::store::repos::connection_selection::select(
                        tx,
                        durable_store,
                        scope,
                        connector_id,
                        &next_id,
                        Some(selection.revision),
                        &now_epoch().to_string(),
                    )?;
                } else {
                    crate::store::repos::connection_selection::clear(
                        tx,
                        scope,
                        connector_id,
                        selection.revision,
                    )?;
                }
            }
        }
        Ok(())
    });
    if let Err(error) = canonical_result {
        let metadata_restored = write_connections(path, &prepared.previous_connections).is_ok();
        let credential_restored = rollback_credential(store, rollback).is_ok();
        return if metadata_restored && credential_restored {
            Err(command_error(
                "unknown",
                connector_id,
                &error.to_string(),
                false,
            ))
        } else {
            Err(command_error(
                "unknown",
                connector_id,
                "Fable could not finish or fully restore connector disconnect; reconnect this provider.",
                false,
            ))
        };
    }
    Ok(())
}

async fn revoke_prepared_credential(connector_id: &str, encoded: Option<&str>) {
    let Some(tokens) = encoded.and_then(|value| serde_json::from_str::<StoredTokenSet>(value).ok())
    else {
        return;
    };
    let Some(endpoint) = tokens.revocation_endpoint else {
        return;
    };
    let token_value = tokens
        .refresh_token
        .clone()
        .unwrap_or_else(|| tokens.access_token.clone());
    let hint = if tokens.refresh_token.is_some() {
        "refresh_token"
    } else {
        "access_token"
    };
    crate::ensure_rustls_provider();
    if tokens.brokered {
        let _ = reqwest::Client::new()
            .post(endpoint)
            .json(&serde_json::json!({
                "contractVersion": 1,
                "provider": connector_id,
                "token": token_value,
                "tokenTypeHint": hint,
            }))
            .send()
            .await;
    } else {
        let _ = reqwest::Client::new()
            .post(endpoint)
            .form(&[("token", token_value.as_str())])
            .send()
            .await;
    }
}

async fn disconnect_with_store_and_path<G>(
    connector_id: &str,
    store: &dyn ConnectorSecretStore,
    path: &Path,
    durable_store: &crate::store::Store,
    scope: &crate::authorized_scope::AuthorizedCommandScope,
    before_commit: impl FnOnce() -> Result<G, ConnectorCommandError>,
) -> Result<(), ConnectorCommandError> {
    let Some(prepared) = prepare_disconnect(connector_id, store, path, durable_store, scope)?
    else {
        return Ok(());
    };
    commit_prepared_disconnect(
        connector_id,
        store,
        path,
        durable_store,
        scope,
        &prepared,
        before_commit,
    )?;
    revoke_prepared_credential(connector_id, prepared.previous_secret.as_deref()).await;
    Ok(())
}

fn refresh_authorization_context(
    connector_id: &str,
) -> Result<
    (
        crate::clerk_identity::NativeIdentityGenerationSnapshot,
        crate::authorized_scope::AuthorizedCommandScope,
        &'static crate::store::Store,
    ),
    ConnectorCommandError,
> {
    let identity = crate::clerk_identity::native_identity_generation_snapshot()
        .map_err(|message| command_error("needs-auth", connector_id, &message, false))?;
    let scope = crate::authorized_scope::command_scope(
        Some(crate::store::repos::scope::DEFAULT_WORKSPACE_ID.to_string()),
        None,
        crate::authorized_scope::ScopeAccess::Write,
    )
    .map_err(|message| command_error("invalid-request", connector_id, &message, false))?;
    let durable_store = crate::store::try_global().ok_or_else(|| {
        command_error(
            "unknown",
            connector_id,
            "Fable's encrypted store is not initialized.",
            false,
        )
    })?;
    Ok((identity, scope, durable_store))
}

fn canonical_connection_for_refresh(
    store: &crate::store::Store,
    scope: &crate::authorized_scope::AuthorizedCommandScope,
    connector_id: &str,
    provider_account_id: &str,
) -> Result<crate::store::repos::connection_record::SafeConnectionRecord, ConnectorCommandError> {
    let id =
        derive_native_connection_id(scope.data.workspace_id(), connector_id, provider_account_id);
    let record = store
        .with_conn(|tx| crate::store::repos::connection_record::get(tx, store, scope, &id))
        .map_err(|error| command_error("unknown", connector_id, &error.to_string(), false))?
        .ok_or_else(|| {
            command_error(
                "needs-auth",
                connector_id,
                "Canonical Connection authorization is unavailable.",
                false,
            )
        })?;
    let authorized = record.lifecycle == "authorized"
        && record.authorization_state == "authorized"
        && record.credential_state == "available";
    let refreshable = record.lifecycle == "refresh-required"
        && record.authorization_state == "expired"
        && record.credential_state == "refresh-required";
    if record.connector_definition_key != connector_id || (!authorized && !refreshable) {
        return Err(command_error(
            "needs-auth",
            connector_id,
            "Canonical Connection authorization must be recovered before use.",
            false,
        ));
    }
    Ok(record)
}

fn verify_refresh_snapshot(
    connector_id: &str,
    store: &dyn ConnectorSecretStore,
    path: &Path,
    previous_connections: &[ConnectorConnection],
    credential_ref: &str,
    previous_secret: &str,
) -> Result<(), ConnectorCommandError> {
    let current_connections = read_connections(path)
        .map_err(|message| command_error("unknown", connector_id, &message, false))?;
    let current_secret = store
        .get(credential_ref)
        .map_err(|message| command_error("unknown", connector_id, &message, false))?;
    if !same_connection_snapshot(&current_connections, previous_connections)
        || current_secret.as_deref() != Some(previous_secret)
    {
        return Err(command_error(
            "conflict",
            connector_id,
            "Connector state changed before refresh could be saved.",
            true,
        ));
    }
    Ok(())
}

fn transition_refreshed_canonical(
    durable_store: &crate::store::Store,
    scope: &crate::authorized_scope::AuthorizedCommandScope,
    connector_id: &str,
    account_id: &str,
    expected_revision: i64,
    previous_health_state: &str,
    lifecycle: &str,
    authorization_state: &str,
    health_state: Option<&str>,
    credential_state: &str,
    updated_at: &str,
) -> crate::store::Result<()> {
    durable_store.transaction(|tx| {
        let id = derive_native_connection_id(scope.data.workspace_id(), connector_id, account_id);
        crate::store::repos::connection_record::transition_native_connector(
            tx,
            durable_store,
            scope,
            &id,
            expected_revision,
            lifecycle,
            authorization_state,
            health_state.unwrap_or(previous_health_state),
            credential_state,
            updated_at,
        )?;
        Ok(())
    })
}

fn commit_refresh_success<G>(
    connector_id: &str,
    store: &dyn ConnectorSecretStore,
    path: &Path,
    durable_store: &crate::store::Store,
    scope: &crate::authorized_scope::AuthorizedCommandScope,
    previous_connections: &[ConnectorConnection],
    previous_secret: &str,
    canonical_revision: i64,
    canonical_health_state: &str,
    updated_connection: ConnectorConnection,
    updated_secret: &str,
    before_commit: impl FnOnce() -> Result<G, ConnectorCommandError>,
) -> Result<ConnectorConnection, ConnectorCommandError> {
    let _guard = before_commit()?;
    verify_refresh_snapshot(
        connector_id,
        store,
        path,
        previous_connections,
        &updated_connection.credential_ref,
        previous_secret,
    )?;
    store
        .set(&updated_connection.credential_ref, updated_secret)
        .map_err(|message| command_error("unknown", connector_id, &message, false))?;
    let rollback = CredentialRollback {
        credential_ref: updated_connection.credential_ref.clone(),
        previous_secret: Some(previous_secret.to_string()),
    };
    let mut updated_connections = previous_connections.to_vec();
    let Some(target) = updated_connections.iter_mut().find(|connection| {
        connection.connector_id == connector_id
            && connection.account.id == updated_connection.account.id
    }) else {
        let _ = rollback_credential(store, rollback);
        return Err(command_error(
            "conflict",
            connector_id,
            "Connector state changed before refresh could be saved.",
            true,
        ));
    };
    *target = updated_connection.clone();
    if let Err(error) = write_connections(path, &updated_connections) {
        return finish_metadata_commit(Err(error), store, rollback)
            .map(|_| unreachable!())
            .map_err(|message| command_error("unknown", connector_id, &message, false));
    }
    let canonical = transition_refreshed_canonical(
        durable_store,
        scope,
        connector_id,
        &updated_connection.account.id,
        canonical_revision,
        canonical_health_state,
        "authorized",
        "authorized",
        None,
        "available",
        &updated_connection.updated_at,
    );
    if let Err(error) = canonical {
        let metadata_restored = write_connections(path, previous_connections).is_ok();
        let credential_restored = rollback_credential(store, rollback).is_ok();
        return if metadata_restored && credential_restored {
            Err(command_error(
                "unknown",
                connector_id,
                &error.to_string(),
                false,
            ))
        } else {
            Err(command_error(
                "unknown",
                connector_id,
                "Fable could not finish or fully restore connector refresh; reconnect this provider.",
                false,
            ))
        };
    }
    Ok(updated_connection)
}

fn commit_refresh_rejection<G>(
    connector_id: &str,
    store: &dyn ConnectorSecretStore,
    path: &Path,
    durable_store: &crate::store::Store,
    scope: &crate::authorized_scope::AuthorizedCommandScope,
    previous_connections: &[ConnectorConnection],
    previous_secret: &str,
    account_id: &str,
    canonical_revision: i64,
    canonical_health_state: &str,
    before_commit: impl FnOnce() -> Result<G, ConnectorCommandError>,
) -> Result<ConnectorConnection, ConnectorCommandError> {
    let _guard = before_commit()?;
    verify_refresh_snapshot(
        connector_id,
        store,
        path,
        previous_connections,
        &previous_connections
            .iter()
            .find(|connection| {
                connection.connector_id == connector_id && connection.account.id == account_id
            })
            .ok_or_else(|| {
                command_error(
                    "conflict",
                    connector_id,
                    "Connector state changed before refresh could be saved.",
                    true,
                )
            })?
            .credential_ref,
        previous_secret,
    )?;
    let mut rejected = previous_connections.to_vec();
    mark_refresh_rejected(connector_id, account_id, &mut rejected);
    write_connections(path, &rejected)
        .map_err(|message| command_error("unknown", connector_id, &message, false))?;
    let updated_at = rejected
        .iter()
        .find(|connection| {
            connection.connector_id == connector_id && connection.account.id == account_id
        })
        .map(|connection| connection.updated_at.as_str())
        .unwrap_or("0");
    if let Err(error) = transition_refreshed_canonical(
        durable_store,
        scope,
        connector_id,
        account_id,
        canonical_revision,
        canonical_health_state,
        "refresh-required",
        "expired",
        Some("unhealthy"),
        "refresh-required",
        updated_at,
    ) {
        return if write_connections(path, previous_connections).is_ok() {
            Err(command_error(
                "unknown",
                connector_id,
                &error.to_string(),
                false,
            ))
        } else {
            Err(command_error(
                "unknown",
                connector_id,
                "Fable could not finish or fully restore rejected connector refresh; reconnect this provider.",
                false,
            ))
        };
    }
    Err(command_error(
        "expired-auth",
        connector_id,
        "Connector token refresh was rejected; reconnect the account.",
        false,
    ))
}

pub(crate) async fn refresh_connection(
    app: &tauri::AppHandle,
    connector_id: &str,
) -> Result<ConnectorConnection, ConnectorCommandError> {
    let path = connector_connections_path(app)
        .map_err(|message| command_error("unknown", connector_id, &message, false))?;
    let connections = read_connections(&path)
        .map_err(|message| command_error("unknown", connector_id, &message, false))?;
    let (identity, scope, durable_store) = refresh_authorization_context(connector_id)?;
    let _ = selected_connection_id(&path, connector_id);
    let selection = durable_store
        .with_conn(|tx| crate::store::repos::connection_selection::get(tx, &scope, connector_id))
        .map_err(|error| command_error("unknown", connector_id, &error.to_string(), false))?
        .ok_or_else(|| {
            command_error(
                "needs-auth",
                connector_id,
                "Active Connection selection is unavailable.",
                false,
            )
        })?;
    let active_index = connections.iter().position(|connection| {
        connection.connector_id == connector_id
            && derive_native_connection_id(
                scope.data.workspace_id(),
                connector_id,
                &connection.account.id,
            ) == selection.connection_id
    });
    let active_index = active_index.ok_or_else(|| {
        command_error(
            "needs-auth",
            connector_id,
            "Connector is not authenticated.",
            false,
        )
    })?;
    let mut connection = connections[active_index].clone();
    let secret_store = NativeConnectorSecretStore;
    let encoded = secret_store
        .get(&connection.credential_ref)
        .map_err(|message| command_error("unknown", connector_id, &message, false))?
        .ok_or_else(|| {
            command_error(
                "needs-auth",
                connector_id,
                "Connector credentials are missing.",
                false,
            )
        })?;
    let mut tokens: StoredTokenSet = serde_json::from_str(&encoded).map_err(|_| {
        command_error(
            "needs-auth",
            connector_id,
            "Connector credentials are invalid.",
            false,
        )
    })?;
    let canonical = canonical_connection_for_refresh(
        durable_store,
        &scope,
        connector_id,
        &connection.account.id,
    )?;
    if tokens.expires_at.is_none()
        || tokens
            .expires_at
            .is_some_and(|expires_at| expires_at > now_epoch() + 60)
    {
        let _guard = crate::clerk_identity::lock_native_identity_generation(&identity)
            .map_err(|message| command_error("needs-auth", connector_id, &message, false))?;
        let current = canonical_connection_for_refresh(
            durable_store,
            &scope,
            connector_id,
            &connection.account.id,
        )?;
        if current.revision != canonical.revision
            || current.lifecycle != "authorized"
            || current.authorization_state != "authorized"
            || current.credential_state != "available"
        {
            return Err(command_error(
                "conflict",
                connector_id,
                "Canonical Connection authorization changed before use.",
                true,
            ));
        }
        return Ok(connection.clone());
    }
    let refresh_token = tokens.refresh_token.clone().ok_or_else(|| {
        command_error(
            "expired-auth",
            connector_id,
            "Connector authentication expired.",
            false,
        )
    })?;
    crate::ensure_rustls_provider();
    let refreshed: TokenResponse = if tokens.brokered {
        // Confidential broker flow: rotate through the broker's refresh endpoint,
        // which alone holds the client secret. The refresh endpoint is a sibling
        // of the stored handoff endpoint (both derive from the same broker base),
        // so it is derived here rather than re-read from the env var. The broker
        // returns tokens nested under `tokens`; flatten onto TokenResponse.
        let handoff_endpoint = tokens.handoff_endpoint.clone().ok_or_else(|| {
            command_error(
                "configuration-required",
                connector_id,
                "This provider requires the configured Fable auth broker.",
                false,
            )
        })?;
        let refresh_endpoint = broker_sibling_endpoint(&handoff_endpoint, "refresh")?;
        let response = reqwest::Client::new()
            .post(&refresh_endpoint)
            .json(&serde_json::json!({
                "contractVersion": 1,
                "provider": connector_id,
                "refreshToken": refresh_token,
            }))
            .send()
            .await
            .map_err(|_| {
                command_error(
                    "provider-unavailable",
                    connector_id,
                    "The Fable auth broker could not be reached.",
                    true,
                )
            })?;
        if !response.status().is_success() {
            let error = broker_error_from_response(connector_id, "refresh", response).await;
            // A definitive auth failure (revoked/invalid token) expires the
            // connection so the user reconnects. A transient broker outage
            // (provider-unavailable / rate-limited) is surfaced as-is so a
            // temporary broker problem does not permanently disconnect an
            // otherwise-valid account.
            if error.code == "needs-auth" || error.code == "configuration-required" {
                return commit_refresh_rejection(
                    connector_id,
                    &secret_store,
                    &path,
                    durable_store,
                    &scope,
                    &connections,
                    &encoded,
                    &connection.account.id,
                    canonical.revision,
                    &canonical.health_state,
                    || {
                        crate::clerk_identity::lock_native_identity_generation(&identity).map_err(
                            |message| command_error("needs-auth", connector_id, &message, false),
                        )
                    },
                );
            }
            return Err(error);
        }
        let refreshed: HandoffResponse = response.json().await.map_err(|_| {
            command_error(
                "provider-unavailable",
                connector_id,
                "The Fable auth broker refresh response was invalid.",
                true,
            )
        })?;
        let mut tokens = refreshed.tokens;
        tokens.account = refreshed.account.or(tokens.account);
        tokens
    } else {
        // Public PKCE flow: rotate directly with the provider.
        let token_endpoint = tokens.token_endpoint.clone().ok_or_else(|| {
            command_error(
                "configuration-required",
                connector_id,
                "Provider token endpoint is required.",
                false,
            )
        })?;
        let response = reqwest::Client::new()
            .post(&token_endpoint)
            .form(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh_token.as_str()),
                ("client_id", tokens.client_id.as_str()),
            ])
            .send()
            .await
            .map_err(|_| {
                command_error(
                    "provider-unavailable",
                    connector_id,
                    "Token refresh failed.",
                    true,
                )
            })?;
        if !response.status().is_success() {
            return commit_refresh_rejection(
                connector_id,
                &secret_store,
                &path,
                durable_store,
                &scope,
                &connections,
                &encoded,
                &connection.account.id,
                canonical.revision,
                &canonical.health_state,
                || {
                    crate::clerk_identity::lock_native_identity_generation(&identity).map_err(
                        |message| command_error("needs-auth", connector_id, &message, false),
                    )
                },
            );
        }
        response.json().await.map_err(|_| {
            command_error(
                "provider-unavailable",
                connector_id,
                "Token refresh response was invalid.",
                true,
            )
        })?
    };
    tokens.access_token = refreshed.access_token;
    if refreshed.refresh_token.is_some() {
        tokens.refresh_token = refreshed.refresh_token;
    }
    tokens.token_type = refreshed.token_type.unwrap_or(tokens.token_type);
    tokens.expires_at = refreshed
        .expires_in
        .map(|seconds| now_epoch().saturating_add(seconds));
    if let Some(scopes) = refreshed.scope {
        tokens.scopes = scopes.split_whitespace().map(str::to_string).collect();
    } else if !tokens.brokered {
        // A public installed-app refresh without a scope field proves no
        // active grants. Preserve the refresh token, but fail closed for all
        // scope-gated operations until Google returns scope truth again.
        tokens.scopes.clear();
    }
    let updated_secret = serde_json::to_string(&tokens).map_err(|_| {
        command_error(
            "unknown",
            connector_id,
            "Fable could not encode refreshed tokens.",
            false,
        )
    })?;
    connection.status = "connected".to_string();
    connection.scopes = tokens.scopes;
    connection.expires_at = tokens.expires_at;
    connection.updated_at = now_epoch().to_string();
    commit_refresh_success(
        connector_id,
        &secret_store,
        &path,
        durable_store,
        &scope,
        &connections,
        &encoded,
        canonical.revision,
        &canonical.health_state,
        connection,
        &updated_secret,
        || {
            crate::clerk_identity::lock_native_identity_generation(&identity)
                .map_err(|message| command_error("needs-auth", connector_id, &message, false))
        },
    )
}

/// Return a usable token set to native provider code. Tokens remain inside
/// Rust and are refreshed before use; no Tauri command exposes this value.
pub(crate) async fn authorized_tokens(
    app: &tauri::AppHandle,
    connector_id: &str,
) -> Result<(ConnectorConnection, StoredTokenSet), ConnectorCommandError> {
    let connection = refresh_connection(app, connector_id).await?;
    let encoded = NativeConnectorSecretStore
        .get(&connection.credential_ref)
        .map_err(|message| command_error("unknown", connector_id, &message, false))?
        .ok_or_else(|| {
            command_error(
                "needs-auth",
                connector_id,
                "Connector credentials are missing.",
                false,
            )
        })?;
    let tokens = serde_json::from_str::<StoredTokenSet>(&encoded).map_err(|_| {
        command_error(
            "needs-auth",
            connector_id,
            "Connector credentials are invalid.",
            false,
        )
    })?;
    if tokens.access_token.trim().is_empty() {
        return Err(command_error(
            "needs-auth",
            connector_id,
            "Connector credentials are invalid.",
            false,
        ));
    }
    Ok((connection, tokens))
}

/// Resolve a usable provider access token without exposing it across the Tauri boundary.
/// Expiring credentials are refreshed and persisted in the OS credential store first.
pub(crate) async fn provider_access_token(
    app: &tauri::AppHandle,
    connector_id: &str,
) -> Result<String, ConnectorCommandError> {
    let (_, tokens) = authorized_tokens(app, connector_id).await?;
    Ok(tokens.access_token)
}

/// Resolve a usable access token entirely inside the Rust/keyring boundary.
/// Callers receive it only in Rust; no Tauri command exposes this function.
pub(crate) async fn access_token(
    app: &tauri::AppHandle,
    connector_id: &str,
) -> Result<(ConnectorConnection, String), ConnectorCommandError> {
    let (connection, tokens) = authorized_tokens(app, connector_id).await?;
    Ok((connection, tokens.access_token))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authorized_scope::{resolve, ScopeAccess};
    use crate::store::repos::workspace_directory::{
        clear_current_internal_user, set_current_internal_user,
    };
    use crate::store::vault::{MasterKey, Vault};
    use crate::store::Store;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[derive(Default)]
    struct MemoryStore(Mutex<BTreeMap<String, String>>);
    impl ConnectorSecretStore for MemoryStore {
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

    fn fixture_config() -> OAuthProviderConfig {
        OAuthProviderConfig {
            authorization_endpoint: "https://provider.example/authorize".to_string(),
            token_endpoint: Some("https://provider.example/token".to_string()),
            revocation_endpoint: None,
            userinfo_endpoint: None,
            handoff_endpoint: None,
            client_id: "desktop-client".to_string(),
            scopes: vec!["items.read".to_string()],
            brokered: false,
        }
    }

    /// A brokered (confidential) provider config like the one `provider_config`
    /// builds for GitHub/Notion/Slack/Linear/Vercel: the handoff endpoint is set
    /// and there is no token/identity endpoint, because the broker serves none.
    fn brokered_config(handoff_endpoint: &str) -> OAuthProviderConfig {
        OAuthProviderConfig {
            authorization_endpoint: "https://broker.example/oauth/github/authorize".to_string(),
            token_endpoint: None,
            revocation_endpoint: Some("https://broker.example/oauth/github/revoke".to_string()),
            userinfo_endpoint: None,
            handoff_endpoint: Some(handoff_endpoint.to_string()),
            client_id: "fable-desktop".to_string(),
            scopes: vec!["items.read".to_string()],
            brokered: true,
        }
    }

    async fn mock_json_server(body: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request).await;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });
        format!("http://{address}/token")
    }

    #[test]
    fn pkce_is_s256_urlsafe_without_padding() {
        let challenge = pkce_challenge("verifier");
        assert!(!challenge.contains('='));
        assert_eq!(challenge, "iMnq5o6zALKXGivsnlom_0F5_WYda32GHkxlV7mq7hQ");
    }

    #[test]
    fn oauth_start_persists_verifier_only_in_secret_store() {
        let store = MemoryStore::default();
        let result = start_with_store(
            "fixture",
            "http://127.0.0.1:43123/callback",
            fixture_config(),
            &store,
        )
        .expect("start");
        let authorization = Url::parse(result.authorization_url.as_deref().unwrap()).unwrap();
        let query = authorization.query_pairs().collect::<BTreeMap<_, _>>();
        let state = query.get("state").unwrap();
        assert_eq!(
            query
                .get("code_challenge_method")
                .map(|value| value.as_ref()),
            Some("S256")
        );
        assert_eq!(
            query.get("access_type").map(|value| value.as_ref()),
            Some("offline")
        );
        assert!(!query.contains_key("include_granted_scopes"));
        let pending = store.get(&pending_key("fixture", state)).unwrap().unwrap();
        assert!(pending.contains("\"verifier\""));
        assert!(!result.authorization_url.unwrap().contains("verifier"));
    }

    #[test]
    fn oauth_start_rejects_non_loopback_plain_http() {
        let store = MemoryStore::default();
        let error = start_with_store(
            "fixture",
            "http://example.com/callback",
            fixture_config(),
            &store,
        )
        .unwrap_err();
        assert_eq!(error.code, "invalid-request");
    }

    #[test]
    fn connection_metadata_never_serializes_tokens() {
        let path = std::env::temp_dir().join(format!(
            "fable-connector-connections-{}.json",
            std::process::id()
        ));
        let _ = fs::remove_file(&path);
        let connection = ConnectorConnection {
            connector_id: "fixture".to_string(),
            account: ConnectorAccountSummary {
                id: "account-1".to_string(),
                display_name: "Fixture".to_string(),
                handle: None,
                email: None,
                workspace: None,
                avatar_url: None,
            },
            status: "connected".to_string(),
            scopes: vec!["items.read".to_string()],
            expires_at: Some(123),
            credential_ref: "oauth-token:fixture:account-1".to_string(),
            connected_at: "1".to_string(),
            updated_at: "1".to_string(),
            is_active: true,
        };
        write_connections(&path, &[connection]).expect("write");
        let disk = fs::read_to_string(&path).expect("read");
        assert!(!disk.contains("access_token"));
        assert!(!disk.contains("refresh_token"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn metadata_failure_restores_previous_or_removes_new_credential() {
        let path = std::env::temp_dir()
            .join(format!("fable-missing-parent-{}", std::process::id()))
            .join("connector-connections.json");
        let _ = fs::remove_dir_all(path.parent().unwrap());
        let connection = ConnectorConnection {
            connector_id: "fixture".into(),
            account: ConnectorAccountSummary {
                id: "account-1".into(),
                display_name: "Fixture".into(),
                handle: None,
                email: None,
                workspace: None,
                avatar_url: None,
            },
            status: "connected".into(),
            scopes: vec![],
            expires_at: None,
            credential_ref: "oauth-token:fixture:account-1".into(),
            connected_at: "1".into(),
            updated_at: "1".into(),
            is_active: true,
        };

        let store = MemoryStore::default();
        let existing_ref = "oauth-token:fixture:account-1";
        store.set(existing_ref, "old-secret").unwrap();
        store.set(existing_ref, "new-secret").unwrap();
        let error = finish_metadata_commit(
            write_connections(&path, std::slice::from_ref(&connection)),
            &store,
            CredentialRollback {
                credential_ref: existing_ref.into(),
                previous_secret: Some("old-secret".into()),
            },
        )
        .unwrap_err();
        assert_eq!(
            store.get(existing_ref).unwrap().as_deref(),
            Some("old-secret")
        );
        assert!(!error.contains("old-secret"));
        assert!(!error.contains("new-secret"));

        let new_ref = "oauth-token:fixture:account-2";
        store.set(new_ref, "brand-new-secret").unwrap();
        let error = finish_metadata_commit(
            write_connections(&path, &[connection]),
            &store,
            CredentialRollback {
                credential_ref: new_ref.into(),
                previous_secret: None,
            },
        )
        .unwrap_err();
        assert!(store.get(new_ref).unwrap().is_none());
        assert!(!error.contains("brand-new-secret"));
    }

    #[tokio::test]
    async fn oauth_callback_requires_the_exact_state_and_redirect() {
        let store = MemoryStore::default();
        let result = start_with_store(
            "fixture",
            "http://127.0.0.1:43123/callback",
            fixture_config(),
            &store,
        )
        .expect("start");
        let authorization = Url::parse(result.authorization_url.as_deref().unwrap()).unwrap();
        let query = authorization.query_pairs().collect::<BTreeMap<_, _>>();
        let state = query.get("state").unwrap();

        let unknown = complete_with_store(
            "fixture",
            "http://127.0.0.1:43123/callback?code=code&state=wrong",
            &store,
        )
        .await
        .expect_err("unknown state");
        assert_eq!(unknown.code, "invalid-request");

        let wrong_redirect = complete_with_store(
            "fixture",
            &format!("http://127.0.0.1:43123/other?code=code&state={state}"),
            &store,
        )
        .await
        .expect_err("redirect mismatch");
        assert_eq!(wrong_redirect.code, "invalid-request");
    }

    #[tokio::test]
    async fn connector_oauth_is_bound_to_the_fable_account_that_started_it() {
        let store = MemoryStore::default();
        let started = start_with_store_bound(
            "fixture",
            "http://127.0.0.1:43123/callback",
            fixture_config(),
            &store,
            Some("account-binding-a".into()),
            Some("workspace-a".into()),
        )
        .unwrap();
        let authorization = Url::parse(started.authorization_url.as_deref().unwrap()).unwrap();
        let state = authorization
            .query_pairs()
            .find(|(key, _)| key == "state")
            .unwrap()
            .1
            .into_owned();
        let callback = format!("http://127.0.0.1:43123/callback?code=code&state={state}");

        let error = prepare_with_store(
            "fixture",
            &callback,
            &store,
            Some("account-binding-b"),
            Some("workspace-a"),
        )
        .await
        .err()
        .unwrap();
        assert_eq!(error.code, "needs-auth");
        assert!(store
            .get(&pending_key("fixture", &state))
            .unwrap()
            .is_none());
        assert!(store
            .get(&native_connector_credential_ref("fixture", "account-1"))
            .unwrap()
            .is_none());

        let started = start_with_store_bound(
            "fixture",
            "http://127.0.0.1:43123/callback",
            fixture_config(),
            &store,
            Some("account-binding-a".into()),
            Some("workspace-a".into()),
        )
        .unwrap();
        let authorization = Url::parse(started.authorization_url.as_deref().unwrap()).unwrap();
        let state = authorization
            .query_pairs()
            .find(|(key, _)| key == "state")
            .unwrap()
            .1
            .into_owned();
        let callback = format!("http://127.0.0.1:43123/callback?code=code&state={state}");
        let error = prepare_with_store(
            "fixture",
            &callback,
            &store,
            Some("account-binding-a"),
            Some("workspace-b"),
        )
        .await
        .err()
        .unwrap();
        assert_eq!(error.code, "needs-auth");
        assert!(store
            .get(&pending_key("fixture", &state))
            .unwrap()
            .is_none());
    }

    #[test]
    fn failed_generation_guard_writes_no_connector_credential() {
        let store = MemoryStore::default();
        let credential_ref = "oauth-token:fixture:account-1";
        store.set(credential_ref, "old-secret").unwrap();
        let error = persist_credential_after_guard(
            &store,
            "fixture",
            credential_ref,
            "new-secret",
            || -> Result<(), ConnectorCommandError> {
                Err(command_error(
                    "needs-auth",
                    "fixture",
                    "Fable account changed during the request. Please try again.",
                    false,
                ))
            },
        )
        .unwrap_err();
        assert_eq!(error.code, "needs-auth");
        assert_eq!(
            store.get(credential_ref).unwrap().as_deref(),
            Some("old-secret")
        );
        assert!(!error.message.contains("old-secret"));
        assert!(!error.message.contains("new-secret"));
    }

    #[test]
    fn canonical_auth_commit_succeeds_and_stale_scope_restores_prior_stores() {
        let durable =
            Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap();
        let scope = durable
            .transaction(|tx| {
                tx.execute(
                    "INSERT INTO fable_internal_user_mirror(internal_user_id,status,revision,updated_at) VALUES('user-a','active',1,'t')",
                    [],
                )?;
                set_current_internal_user(tx, "user-a", "t")?;
                resolve(tx, Some("default"), None, ScopeAccess::Write)
            })
            .unwrap();
        let path = std::env::temp_dir().join(format!(
            "fable-canonical-auth-commit-{}.json",
            std::process::id()
        ));
        let _ = fs::remove_file(&path);
        let secrets = MemoryStore::default();
        let prepared = |account_id: &str| {
            let credential_ref = native_connector_credential_ref("gmail", account_id);
            let tokens = StoredTokenSet {
                access_token: format!("access-{account_id}"),
                refresh_token: Some(format!("refresh-{account_id}")),
                token_type: "Bearer".into(),
                expires_at: None,
                scopes: vec!["gmail.readonly".into()],
                revocation_endpoint: None,
                token_endpoint: None,
                handoff_endpoint: None,
                client_id: "desktop-client".into(),
                brokered: false,
            };
            let encoded = serde_json::to_string(&tokens).unwrap();
            (
                tokens,
                ConnectorAccountSummary {
                    id: account_id.into(),
                    display_name: format!("Account {account_id}"),
                    handle: None,
                    email: None,
                    workspace: None,
                    avatar_url: None,
                },
                credential_ref.clone(),
                CredentialRollback {
                    credential_ref,
                    previous_secret: None,
                },
                encoded,
            )
        };

        let result = commit_prepared_auth_state(
            &path,
            &durable,
            "gmail",
            &scope,
            &secrets,
            prepared("account-1"),
            || Ok(()),
        )
        .unwrap();
        let result_connection_id = result.account.as_ref().unwrap().id.clone();
        assert!(result_connection_id.starts_with("connection_"));
        assert_eq!(read_connections(&path).unwrap().len(), 1);
        assert_eq!(
            durable
                .with_conn(|tx| crate::store::repos::connection_record::list(tx, &durable, &scope))
                .unwrap()
                .len(),
            1
        );
        let selection = durable
            .with_conn(|tx| crate::store::repos::connection_selection::get(tx, &scope, "gmail"))
            .unwrap()
            .unwrap();
        assert_eq!(selection.connection_id, result_connection_id);

        durable
            .transaction(|tx| clear_current_internal_user(tx))
            .unwrap();
        let error = commit_prepared_auth_state(
            &path,
            &durable,
            "gmail",
            &scope,
            &secrets,
            prepared("account-2"),
            || Ok(()),
        )
        .unwrap_err();
        let connections = read_connections(&path).unwrap();
        assert_eq!(connections.len(), 1);
        assert_eq!(connections[0].account.id, "account-1");
        assert!(secrets
            .get(&native_connector_credential_ref("gmail", "account-2"))
            .unwrap()
            .is_none());
        assert!(!error.message.contains("access-account-2"));
        assert!(!error.message.contains("refresh-account-2"));
        let selection_after_failure = durable
            .with_conn(|tx| crate::store::repos::connection_selection::get(tx, &scope, "gmail"));
        assert!(selection_after_failure.is_err());
        let _ = fs::remove_file(path);
    }

    #[tokio::test]
    async fn public_pkce_reauth_preserves_refresh_token_without_merging_historical_scopes() {
        let store = MemoryStore::default();
        let token_endpoint = mock_json_server(
            r#"{"access_token":"new-access","token_type":"Bearer","expires_in":3600,"scope":"items.write","account":{"id":"account-1","displayName":"Test account","email":"test@example.com"}}"#,
        )
        .await;
        let mut config = fixture_config();
        config.token_endpoint = Some(token_endpoint);
        config.scopes = vec!["items.write".to_string()];
        let started =
            start_with_store("fixture", "http://127.0.0.1:43123/callback", config, &store).unwrap();
        let authorization = Url::parse(started.authorization_url.as_deref().unwrap()).unwrap();
        let state = authorization
            .query_pairs()
            .find(|(key, _)| key == "state")
            .unwrap()
            .1
            .into_owned();
        let existing = StoredTokenSet {
            access_token: "old-access".to_string(),
            refresh_token: Some("keep-refresh".to_string()),
            token_type: "Bearer".to_string(),
            expires_at: None,
            scopes: vec!["items.read".to_string()],
            revocation_endpoint: None,
            token_endpoint: Some("https://example.invalid/token".to_string()),
            handoff_endpoint: None,
            client_id: "desktop-client".to_string(),
            brokered: false,
        };
        store
            .set(
                &native_connector_credential_ref("fixture", "account-1"),
                &serde_json::to_string(&existing).unwrap(),
            )
            .unwrap();
        let callback = format!("http://127.0.0.1:43123/callback?code=code&state={state}");
        let (tokens, account, _) = complete_with_store("fixture", &callback, &store)
            .await
            .unwrap();
        assert_eq!(account.id, "account-1");
        assert_eq!(tokens.refresh_token.as_deref(), Some("keep-refresh"));
        assert_eq!(tokens.scopes, vec!["items.write"]);
        assert!(store
            .get(&pending_key("fixture", &state))
            .unwrap()
            .is_none());
        assert_eq!(
            complete_with_store("fixture", &callback, &store)
                .await
                .unwrap_err()
                .code,
            "invalid-request"
        );
    }

    #[tokio::test]
    async fn public_pkce_completion_without_scope_records_no_active_grants() {
        let store = MemoryStore::default();
        let token_endpoint = mock_json_server(
            r#"{"access_token":"new-access","refresh_token":"new-refresh","token_type":"Bearer","expires_in":3600,"account":{"id":"account-1","displayName":"Test account","email":"test@example.com"}}"#,
        )
        .await;
        let mut config = fixture_config();
        config.token_endpoint = Some(token_endpoint);
        config.scopes = vec!["items.read".to_string()];
        let started =
            start_with_store("fixture", "http://127.0.0.1:43123/callback", config, &store).unwrap();
        let authorization = Url::parse(started.authorization_url.as_deref().unwrap()).unwrap();
        let state = authorization
            .query_pairs()
            .find(|(key, _)| key == "state")
            .unwrap()
            .1
            .into_owned();
        let callback = format!("http://127.0.0.1:43123/callback?code=code&state={state}");
        let (tokens, account, credential_ref) = complete_with_store("fixture", &callback, &store)
            .await
            .unwrap();

        assert_eq!(account.id, "account-1");
        assert_eq!(tokens.refresh_token.as_deref(), Some("new-refresh"));
        assert!(tokens.scopes.is_empty());
        let stored = store.get(&credential_ref).unwrap().unwrap();
        let stored_tokens: StoredTokenSet = serde_json::from_str(&stored).unwrap();
        assert!(stored_tokens.scopes.is_empty());
    }

    #[tokio::test]
    async fn oauth_pending_state_expires_before_token_egress() {
        let store = MemoryStore::default();
        let started = start_with_store(
            "fixture",
            "http://127.0.0.1:43123/callback",
            fixture_config(),
            &store,
        )
        .unwrap();
        let authorization = Url::parse(started.authorization_url.as_deref().unwrap()).unwrap();
        let state = authorization
            .query_pairs()
            .find(|(key, _)| key == "state")
            .unwrap()
            .1
            .into_owned();
        let key = pending_key("fixture", &state);
        let mut pending: PendingOAuth =
            serde_json::from_str(&store.get(&key).unwrap().unwrap()).unwrap();
        pending.created_at = 0;
        store
            .set(&key, &serde_json::to_string(&pending).unwrap())
            .unwrap();
        let error = complete_with_store(
            "fixture",
            &format!("http://127.0.0.1:43123/callback?code=code&state={state}"),
            &store,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "invalid-request");
        assert!(error.message.contains("expired"));
        assert!(store.get(&key).unwrap().is_none());
    }

    #[test]
    fn multiple_accounts_have_one_explicit_active_selection() {
        let path =
            std::env::temp_dir().join(format!("fable-google-accounts-{}.json", std::process::id()));
        let _ = fs::remove_file(&path);
        let connection = |id: &str, active: bool| ConnectorConnection {
            connector_id: "gmail".to_string(),
            account: ConnectorAccountSummary {
                id: id.to_string(),
                display_name: id.to_string(),
                handle: None,
                email: Some(format!("{id}@example.com")),
                workspace: None,
                avatar_url: None,
            },
            status: "connected".to_string(),
            scopes: vec!["gmail.readonly".to_string()],
            expires_at: None,
            credential_ref: format!("oauth-token:gmail:{id}"),
            connected_at: "1".to_string(),
            updated_at: "1".to_string(),
            is_active: active,
        };
        write_connections(
            &path,
            &[connection("first", true), connection("second", true)],
        )
        .unwrap();
        let accounts = accounts_for_connector(&path, "gmail", "workspace-a");
        assert_eq!(accounts.iter().filter(|option| option.active).count(), 1);
        assert_eq!(accounts[0].account.id, accounts[0].connection_id);
        assert!(accounts[0].connection_id.starts_with("connection_"));
        assert!(!accounts[0].connection_id.contains("first"));
        assert_ne!(
            accounts[0].connection_id,
            accounts_for_connector(&path, "gmail", "workspace-b")[0].connection_id
        );
        let second = accounts
            .iter()
            .find(|option| option.account.display_name == "second")
            .unwrap()
            .connection_id
            .clone();
        assert!(switch_active_connection(&path, "gmail", "workspace-a", "second").is_err());
        switch_active_connection(&path, "gmail", "workspace-a", &second).unwrap();
        let accounts = accounts_for_connector(&path, "gmail", "workspace-a");
        assert_eq!(accounts.iter().filter(|option| option.active).count(), 1);
        assert_eq!(accounts[0].account.id, accounts[0].connection_id);
        assert!(!serde_json::to_string(&accounts)
            .unwrap()
            .contains("\"id\":\"first\""));
        assert!(!serde_json::to_string(&accounts)
            .unwrap()
            .contains("\"id\":\"second\""));
        assert_eq!(accounts[0].lifecycle, "authorized");
        assert_eq!(accounts[0].authorization_state, "authorized");
        assert_eq!(accounts[0].health_state, "unknown");
        assert_eq!(accounts[0].credential_custody, "os-secure-store");
        assert_eq!(accounts[0].credential_state, "available");
        let _ = fs::remove_file(path);
    }

    // -------------------------------------------------------------------------
    // Auth broker endpoint resolution (confidential OAuth only).
    //
    // The broker serves exactly four OAuth routes: `authorize`, `handoff`,
    // `refresh`, `revoke`. There is NO `/token` and NO `/identity` route. The
    // desktop derives those four from the configured base URL only, so it can
    // never surface a model/search/import/action endpoint. A missing, malformed,
    // or non-secure (non-loopback http) base URL fails closed with
    // `configuration-required` — never a silent fallback.
    //
    // The base URL may be a bare host (https://auth.fable.app), a Cloudflare
    // Workers host (https://fable-broker.workers.dev), or a path-prefixed route
    // (https://app.example.com/broker/). All resolve correctly with or without a
    // trailing slash.
    // -------------------------------------------------------------------------

    #[test]
    fn broker_resolver_fails_closed_when_no_url_is_configured() {
        let error = resolve_broker_endpoints("github", None).expect_err("missing broker");
        assert_eq!(error.code, "configuration-required");
        assert_eq!(error.connector_id, "github");
        assert!(!error.retryable);
    }

    #[test]
    fn broker_resolver_fails_closed_for_non_loopback_plain_http() {
        let error =
            resolve_broker_endpoints("slack", Some("http://broker.example/oauth/slack/authorize"))
                .expect_err("plain http must fail");
        assert_eq!(error.code, "configuration-required");
    }

    #[test]
    fn broker_resolver_fails_closed_for_a_malformed_url() {
        let error =
            resolve_broker_endpoints("notion", Some("not a url at all")).expect_err("malformed");
        assert_eq!(error.code, "configuration-required");
    }

    #[test]
    fn broker_resolver_derives_only_the_four_routes_the_broker_serves() {
        // The desktop must match the broker contract exactly: authorize, handoff,
        // refresh, revoke. No `/token`, no `/identity` (the broker has neither).
        let endpoints =
            resolve_broker_endpoints("github", Some("https://auth.fable.app/")).expect("https ok");
        assert_eq!(
            endpoints.authorization_endpoint,
            "https://auth.fable.app/oauth/github/authorize"
        );
        assert_eq!(
            endpoints.handoff_endpoint,
            "https://auth.fable.app/oauth/github/handoff"
        );
        assert_eq!(
            endpoints.refresh_endpoint,
            "https://auth.fable.app/oauth/github/refresh"
        );
        assert_eq!(
            endpoints.revocation_endpoint,
            "https://auth.fable.app/oauth/github/revoke"
        );
        let serialized = serde_json::to_string(&endpoints).expect("serialize");
        assert!(!serialized.contains("/token"));
        assert!(!serialized.contains("/identity"));
    }

    #[test]
    fn broker_resolver_accepts_a_cloudflare_workers_url() {
        // A workers.dev host resolves the same four routes; no token/identity.
        let endpoints =
            resolve_broker_endpoints("linear", Some("https://fable-broker.example.workers.dev"))
                .expect("workers.dev ok");
        assert_eq!(
            endpoints.handoff_endpoint,
            "https://fable-broker.example.workers.dev/oauth/linear/handoff"
        );
        assert_eq!(
            endpoints.refresh_endpoint,
            "https://fable-broker.example.workers.dev/oauth/linear/refresh"
        );
    }

    #[test]
    fn broker_resolver_preserves_a_path_prefix_with_or_without_trailing_slash() {
        // A broker mounted behind a route prefix (common for a CF Worker exposed
        // under a path) must keep that prefix for every derived route.
        let prefixed = resolve_broker_endpoints("notion", Some("https://app.example.com/broker/"))
            .expect("prefixed ok");
        assert_eq!(
            prefixed.handoff_endpoint,
            "https://app.example.com/broker/oauth/notion/handoff"
        );
        assert_eq!(
            prefixed.revocation_endpoint,
            "https://app.example.com/broker/oauth/notion/revoke"
        );
        let no_slash = resolve_broker_endpoints("notion", Some("https://app.example.com/broker"))
            .expect("no trailing slash ok");
        assert_eq!(no_slash.handoff_endpoint, prefixed.handoff_endpoint);
        assert_eq!(no_slash.refresh_endpoint, prefixed.refresh_endpoint);
    }

    #[test]
    fn broker_resolver_accepts_a_loopback_url_for_local_development() {
        let endpoints = resolve_broker_endpoints("linear", Some("http://127.0.0.1:8788/"))
            .expect("loopback ok");
        assert_eq!(
            endpoints.handoff_endpoint,
            "http://127.0.0.1:8788/oauth/linear/handoff"
        );
    }

    #[test]
    fn broker_resolver_derives_no_model_search_import_or_action_endpoint() {
        // The non-proxying boundary is structural: only four OAuth paths are
        // derivable. Anything else would let the broker become a connector or
        // model proxy, which the contract forbids.
        let endpoints =
            resolve_broker_endpoints("notion", Some("https://auth.fable.app/")).expect("ok");
        let serialized = serde_json::to_string(&endpoints).expect("serialize");
        assert!(!serialized.contains("/search"));
        assert!(!serialized.contains("/import"));
        assert!(!serialized.contains("/action"));
        assert!(!serialized.contains("/execute"));
        assert!(!serialized.contains("/model"));
        assert!(!serialized.contains("/chat"));
        assert!(!serialized.contains("/completions"));
        assert!(!serialized.contains("/messages"));
    }

    // -------------------------------------------------------------------------
    // Broker sibling-endpoint derivation (refresh/revoke from the stored handoff).
    //
    // Only the handoff endpoint is persisted on a brokered connection; refresh
    // and revoke are derived as siblings by replacing the final path segment.
    // A malformed or path-less endpoint fails closed rather than guessing a route.
    // -------------------------------------------------------------------------

    #[test]
    fn broker_refresh_and_revoke_are_siblings_of_the_stored_handoff_endpoint() {
        let handoff = "https://auth.fable.app/oauth/github/handoff";
        assert_eq!(
            broker_sibling_endpoint(handoff, "refresh").unwrap(),
            "https://auth.fable.app/oauth/github/refresh"
        );
        assert_eq!(
            broker_sibling_endpoint(handoff, "revoke").unwrap(),
            "https://auth.fable.app/oauth/github/revoke"
        );
    }

    #[test]
    fn broker_sibling_endpoint_preserves_a_path_prefix_and_loopback_port() {
        assert_eq!(
            broker_sibling_endpoint(
                "https://app.example.com/broker/oauth/notion/handoff",
                "refresh"
            )
            .unwrap(),
            "https://app.example.com/broker/oauth/notion/refresh"
        );
        assert_eq!(
            broker_sibling_endpoint("http://127.0.0.1:8788/oauth/linear/handoff", "refresh")
                .unwrap(),
            "http://127.0.0.1:8788/oauth/linear/refresh"
        );
    }

    #[test]
    fn broker_sibling_endpoint_fails_closed_for_a_malformed_url() {
        let error = broker_sibling_endpoint("not a url", "refresh").expect_err("malformed");
        assert_eq!(error.code, "configuration-required");
    }

    // -------------------------------------------------------------------------
    // Broker error normalization (unavailable ⇒ recoverable & understandable).
    //
    // The broker emits a redacted `{ error, message, retryable }` body on failure.
    // The desktop maps it onto its own connector error vocabulary so a transient
    // outage stays retryable, a throttled request honors Retry-After, and a
    // definitive auth/version/handoff failure fails closed honestly. A body the
    // desktop cannot parse is classified by HTTP status, never silently success.
    // -------------------------------------------------------------------------

    #[test]
    fn broker_error_maps_configuration_required_non_retryable() {
        let error = broker_error(
            "github",
            "handoff",
            Some("configuration-required"),
            Some("Broker is not configured.".to_string()),
            Some(false),
            503,
            None,
        );
        assert_eq!(error.code, "configuration-required");
        assert!(!error.retryable);
        assert_eq!(error.message, "Broker is not configured.");
    }

    #[test]
    fn broker_error_maps_rate_limited_retryable_with_retry_after() {
        let error = broker_error(
            "github",
            "handoff",
            Some("rate-limited"),
            None,
            Some(true),
            429,
            Some("30".to_string()),
        );
        assert_eq!(error.code, "rate-limited");
        assert!(error.retryable);
        assert_eq!(error.retry_after.as_deref(), Some("30"));
    }

    #[test]
    fn broker_error_maps_provider_unavailable_retryable() {
        let error = broker_error(
            "slack",
            "refresh",
            Some("provider-unavailable"),
            None,
            Some(true),
            502,
            None,
        );
        assert_eq!(error.code, "provider-unavailable");
        assert!(error.retryable);
    }

    #[test]
    fn broker_error_maps_handoff_and_version_failures_to_needs_auth() {
        for code in [
            "expired-handoff",
            "invalid-handoff",
            "invalid-state",
            "unsupported-version",
            "invalid-request",
        ] {
            let error = broker_error(
                "github",
                "handoff",
                Some(code),
                None,
                Some(false),
                400,
                None,
            );
            assert_eq!(
                error.code, "needs-auth",
                "code {code} should map to needs-auth"
            );
            assert!(!error.retryable);
        }
    }

    #[test]
    fn broker_error_classifies_unparseable_body_by_status() {
        // An unconfigured/unreachable broker returns 503 with no JSON body.
        let unavailable = broker_error("github", "handoff", None, None, None, 503, None);
        assert_eq!(unavailable.code, "provider-unavailable");
        assert!(unavailable.retryable);
        // A throttled broker returns 429 with an unparseable body.
        let throttled = broker_error("github", "handoff", None, None, None, 429, None);
        assert_eq!(throttled.code, "rate-limited");
        assert!(throttled.retryable);
    }

    // -------------------------------------------------------------------------
    // Brokered completion against a mocked broker (confidential flow, end-to-end).
    //
    // These exercise the real `complete_with_store` handoff path against an
    // in-process HTTP broker mock: the desktop must never report a connector
    // connected when auth cannot complete, must normalize broker errors to
    // recoverable codes, and must store tokens + consume state on the happy path.
    //
    // The mock speaks the broker's real response shapes (mirrors `Broker*Response`
    // and `BrokerErrorResponse` in `packages/connectors/.../broker-contract.ts`).
    // -------------------------------------------------------------------------

    /// A scripted broker mock bound to an ephemeral loopback port. It responds to
    /// every request with the configured status + body, recording the request so
    /// tests can assert the desktop posted to the right route with the right body.
    struct BrokerMock {
        address: std::net::SocketAddr,
        requests: Arc<Mutex<Vec<String>>>,
    }

    impl BrokerMock {
        /// Start a mock returning `status` + `body` for every request. The body
        /// is captured by move so each test owns its own scripted response.
        async fn start(status: u16, body: String, retry_after: Option<&'static str>) -> BrokerMock {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let requests = Arc::new(Mutex::new(Vec::new()));
            let recorded = requests.clone();
            tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = [0_u8; 8192];
                let read = stream.read(&mut request).await.unwrap();
                recorded
                    .lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&request[..read]).to_string());
                let mut response = format!(
                    "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
                    body.len()
                );
                if let Some(value) = retry_after {
                    response.push_str(&format!("Retry-After: {value}\r\n"));
                }
                response.push_str("\r\n");
                response.push_str(&body);
                stream.write_all(response.as_bytes()).await.unwrap();
            });
            BrokerMock { address, requests }
        }

        fn handoff_url(&self) -> String {
            format!("http://{}/oauth/github/handoff", self.address)
        }

        fn take_request(&self) -> String {
            self.requests.lock().unwrap().remove(0)
        }
    }

    /// Build an in-flight brokered pending state by starting the OAuth flow, then
    /// return the state + redirect so a test can drive completion with a callback.
    fn start_brokered_flow(store: &MemoryStore, handoff_endpoint: &str) -> String {
        let started = start_with_store(
            "github",
            "http://127.0.0.1:43123/callback",
            brokered_config(handoff_endpoint),
            store,
        )
        .expect("start brokered");
        let authorization = Url::parse(started.authorization_url.as_deref().unwrap()).unwrap();
        authorization
            .query_pairs()
            .find(|(key, _)| key == "state")
            .unwrap()
            .1
            .into_owned()
    }

    #[tokio::test]
    async fn brokered_completion_normalizes_an_unavailable_broker_to_provider_unavailable() {
        // The broker is reachable but reports configuration-required (503). The
        // desktop must NOT report connected; it surfaces a non-retryable
        // configuration-required so the operator knows to set the broker up.
        let store = MemoryStore::default();
        let body = r#"{"contractVersion":1,"error":"configuration-required","message":"Broker is not configured for this provider.","retryable":false}"#;
        let broker = BrokerMock::start(503, body.to_string(), None).await;
        let state = start_brokered_flow(&store, &broker.handoff_url());
        let callback = format!("http://127.0.0.1:43123/callback?handoff=ticket&state={state}");
        let error = complete_with_store("github", &callback, &store)
            .await
            .expect_err("must not connect when broker is unavailable");
        assert_eq!(error.code, "configuration-required");
        assert!(!error.retryable);
        // The desktop never stored a token and the connection is not live.
        assert!(store
            .get(&native_connector_credential_ref("github", "any"))
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn brokered_completion_normalizes_a_rate_limited_broker() {
        let store = MemoryStore::default();
        let body = r#"{"contractVersion":1,"error":"rate-limited","message":"Too many requests.","retryable":true}"#;
        let broker = BrokerMock::start(429, body.to_string(), Some("30")).await;
        let state = start_brokered_flow(&store, &broker.handoff_url());
        let callback = format!("http://127.0.0.1:43123/callback?handoff=ticket&state={state}");
        let error = complete_with_store("github", &callback, &store)
            .await
            .expect_err("must not connect when broker throttles");
        assert_eq!(error.code, "rate-limited");
        assert!(error.retryable);
        assert_eq!(error.retry_after.as_deref(), Some("30"));
    }

    #[tokio::test]
    async fn brokered_completion_treats_an_expired_handoff_as_needs_auth() {
        let store = MemoryStore::default();
        let body = r#"{"contractVersion":1,"error":"expired-handoff","message":"Handoff expired.","retryable":false}"#;
        let broker = BrokerMock::start(400, body.to_string(), None).await;
        let state = start_brokered_flow(&store, &broker.handoff_url());
        let callback = format!("http://127.0.0.1:43123/callback?handoff=ticket&state={state}");
        let error = complete_with_store("github", &callback, &store)
            .await
            .expect_err("expired handoff must not connect");
        assert_eq!(error.code, "needs-auth");
        assert!(!error.retryable);
    }

    #[tokio::test]
    async fn brokered_completion_is_unreachable_broker_is_provider_unavailable() {
        // No broker listening at all: connection refused. The desktop must surface
        // a retryable provider-unavailable, never pretending success.
        let store = MemoryStore::default();
        // An unset port on loopback that nothing binds: connection refused.
        let dead_handoff = "http://127.0.0.1:1/oauth/github/handoff";
        let state = start_brokered_flow(&store, dead_handoff);
        let callback = format!("http://127.0.0.1:43123/callback?handoff=ticket&state={state}");
        let error = complete_with_store("github", &callback, &store)
            .await
            .expect_err("dead broker must not connect");
        assert_eq!(error.code, "provider-unavailable");
        assert!(error.retryable);
    }

    #[tokio::test]
    async fn brokered_completion_succeeds_and_stores_tokens_on_the_happy_path() {
        // The broker returns the contract's handoff-redemption shape: tokens +
        // account nested. The desktop stores the token set in the secret store,
        // resolves the account from the response (no /identity call), reports
        // connected, and consumes the single-use state.
        let store = MemoryStore::default();
        let body = r#"{"contractVersion":1,"tokens":{"accessToken":"gho_access","refreshToken":"gho_refresh","tokenType":"Bearer","expiresIn":3600,"scope":"items.read"},"account":{"id":"octocat","displayName":"The Octocat","handle":"octocat"}}"#;
        let broker = BrokerMock::start(200, body.to_string(), None).await;
        let handoff_url = broker.handoff_url();
        let state = start_brokered_flow(&store, &handoff_url);
        let callback = format!("http://127.0.0.1:43123/callback?handoff=ticket&state={state}");

        let (tokens, account, credential_ref) = complete_with_store("github", &callback, &store)
            .await
            .expect("happy path connects");
        assert_eq!(account.id, "octocat");
        assert_eq!(account.handle.as_deref(), Some("octocat"));
        assert_eq!(tokens.access_token, "gho_access");
        assert_eq!(tokens.refresh_token.as_deref(), Some("gho_refresh"));
        assert!(tokens.brokered);
        // The persisted token set carries the handoff endpoint so a later
        // refresh/revoke can derive its sibling routes.
        assert_eq!(
            tokens.handoff_endpoint.as_deref(),
            Some(handoff_url.as_str())
        );
        assert!(tokens.token_endpoint.is_none());

        // The token set is persisted in the secret store under the credential ref.
        let stored = store.get(&credential_ref).unwrap().unwrap();
        assert!(stored.contains("gho_access"));
        // The single-use state was consumed: replaying the callback fails closed.
        assert!(store.get(&pending_key("github", &state)).unwrap().is_none());
        let replay = complete_with_store("github", &callback, &store)
            .await
            .expect_err("replay must fail");
        assert_eq!(replay.code, "invalid-request");

        // The desktop posted the contract-shaped body to the handoff route.
        let request = broker.take_request();
        assert!(request.starts_with("POST /oauth/github/handoff"));
        assert!(request.contains("\"contractVersion\":1"));
        assert!(request.contains("\"provider\":\"github\""));
        assert!(request.contains("\"handoff\":\"ticket\""));
        assert!(request.contains(&format!("\"state\":\"{state}\"")));
    }

    #[tokio::test]
    async fn brokered_completion_with_missing_account_is_provider_unavailable() {
        // The broker contract always returns `account`; if it omits it, the
        // desktop does NOT fall back to a non-existent /identity route — it fails
        // honestly with a retryable provider-unavailable.
        let store = MemoryStore::default();
        let body = r#"{"contractVersion":1,"tokens":{"accessToken":"gho_access","tokenType":"Bearer","expiresIn":3600,"scope":"items.read"}}"#;
        let broker = BrokerMock::start(200, body.to_string(), None).await;
        let state = start_brokered_flow(&store, &broker.handoff_url());
        let callback = format!("http://127.0.0.1:43123/callback?handoff=ticket&state={state}");
        let error = complete_with_store("github", &callback, &store)
            .await
            .expect_err("missing account must not connect");
        assert_eq!(error.code, "provider-unavailable");
        assert!(error.retryable);
    }

    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn test_provider_config_pkce_missing_env_fails_closed() {
        let _lock = ENV_LOCK.lock().unwrap();

        let old_val = std::env::var("FABLE_GOOGLE_OAUTH_CLIENT_ID").ok();
        std::env::remove_var("FABLE_GOOGLE_OAUTH_CLIENT_ID");

        let result = provider_config("google-drive", "oauth-pkce", vec![]);

        if let Some(val) = old_val {
            std::env::set_var("FABLE_GOOGLE_OAUTH_CLIENT_ID", val);
        }

        let err = result.expect_err("should fail when client id is missing");
        assert_eq!(err.code, "configuration-required");
        assert_eq!(err.connector_id, "google-drive");
        assert!(!err.retryable);
    }

    #[tokio::test]
    async fn test_disconnect_public_pkce_revocation() {
        let store = MemoryStore::default();
        let durable =
            Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap();
        let scope = durable
            .transaction(|tx| {
                tx.execute(
                    "INSERT INTO fable_internal_user_mirror(internal_user_id,status,revision,updated_at) VALUES('user-a','active',1,'t')",
                    [],
                )?;
                set_current_internal_user(tx, "user-a", "t")?;
                resolve(tx, Some("default"), None, ScopeAccess::Write)
            })
            .unwrap();
        let path =
            std::env::temp_dir().join(format!("fable-disconnect-test-{}.json", std::process::id()));
        let _ = fs::remove_file(&path);

        // Spin up a mock server for the revocation endpoint
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (request_tx, request_rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 4096];
            let read = stream.read(&mut request).await.unwrap();
            request_tx
                .send(String::from_utf8_lossy(&request[..read]).to_string())
                .unwrap();

            let response = "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
            stream.write_all(response.as_bytes()).await.unwrap();
        });

        let revoke_url = format!("http://{address}/revoke");
        let token_set = StoredTokenSet {
            access_token: "google-access-token-123".to_string(),
            refresh_token: Some("google-refresh-token-456".to_string()),
            token_type: "Bearer".to_string(),
            expires_at: None,
            scopes: vec!["drive.readonly".to_string()],
            revocation_endpoint: Some(revoke_url),
            token_endpoint: None,
            handoff_endpoint: None,
            client_id: "google-client-id".to_string(),
            brokered: false, // public PKCE
        };

        let cred_ref = "oauth-token:google-drive:acc-123";
        let encoded = serde_json::to_string(&token_set).unwrap();
        commit_prepared_auth_state(
            &path,
            &durable,
            "google-drive",
            &scope,
            &store,
            (
                token_set,
                ConnectorAccountSummary {
                    id: "acc-123".to_string(),
                    display_name: "Test User".to_string(),
                    handle: None,
                    email: Some("user@example.com".to_string()),
                    workspace: None,
                    avatar_url: None,
                },
                cred_ref.to_string(),
                CredentialRollback {
                    credential_ref: cred_ref.to_string(),
                    previous_secret: None,
                },
                encoded,
            ),
            || Ok(()),
        )
        .unwrap();

        // Disconnect
        disconnect_with_store_and_path("google-drive", &store, &path, &durable, &scope, || Ok(()))
            .await
            .unwrap();

        // Check token removed from secret store
        assert!(store.get(cred_ref).unwrap().is_none());

        // Check connection file is empty/does not contain this account
        let connections = read_connections(&path).unwrap();
        assert!(connections.is_empty());
        let canonical = durable
            .with_conn(|tx| crate::store::repos::connection_record::list(tx, &durable, &scope))
            .unwrap();
        assert_eq!(canonical[0].lifecycle, "disconnected");
        assert_eq!(canonical[0].authorization_state, "revoked");
        assert_eq!(canonical[0].credential_state, "revoked");
        assert!(durable
            .with_conn(|tx| {
                crate::store::repos::connection_selection::get(tx, &scope, "google-drive")
            })
            .unwrap()
            .is_none());

        // Verify the mock server received the expected form POST request
        let request = request_rx.await.unwrap();
        assert!(request.starts_with("POST /revoke"));
        let request_lower = request.to_ascii_lowercase();
        assert!(request_lower.contains("content-type: application/x-www-form-urlencoded"));
        assert!(request_lower.contains("token=google-refresh-token-456"));

        let _ = fs::remove_file(path);
    }

    #[test]
    fn canonical_disconnect_failure_restores_credential_and_metadata() {
        let store = MemoryStore::default();
        let durable =
            Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap();
        let scope = durable
            .transaction(|tx| {
                tx.execute(
                    "INSERT INTO fable_internal_user_mirror(internal_user_id,status,revision,updated_at) VALUES('user-a','active',1,'t')",
                    [],
                )?;
                set_current_internal_user(tx, "user-a", "t")?;
                resolve(tx, Some("default"), None, ScopeAccess::Write)
            })
            .unwrap();
        let path = std::env::temp_dir().join(format!(
            "fable-disconnect-rollback-test-{}.json",
            std::process::id()
        ));
        let _ = fs::remove_file(&path);
        let credential_ref = native_connector_credential_ref("gmail", "account-1");
        let tokens = StoredTokenSet {
            access_token: "rollback-access-secret".into(),
            refresh_token: Some("rollback-refresh-secret".into()),
            token_type: "Bearer".into(),
            expires_at: None,
            scopes: vec!["gmail.readonly".into()],
            revocation_endpoint: None,
            token_endpoint: None,
            handoff_endpoint: None,
            client_id: "desktop-client".into(),
            brokered: false,
        };
        let encoded = serde_json::to_string(&tokens).unwrap();
        commit_prepared_auth_state(
            &path,
            &durable,
            "gmail",
            &scope,
            &store,
            (
                tokens,
                ConnectorAccountSummary {
                    id: "account-1".into(),
                    display_name: "Account one".into(),
                    handle: None,
                    email: None,
                    workspace: None,
                    avatar_url: None,
                },
                credential_ref.clone(),
                CredentialRollback {
                    credential_ref: credential_ref.clone(),
                    previous_secret: None,
                },
                encoded.clone(),
            ),
            || Ok(()),
        )
        .unwrap();
        let prepared = prepare_disconnect("gmail", &store, &path, &durable, &scope)
            .unwrap()
            .unwrap();
        let guard_error =
            commit_prepared_disconnect("gmail", &store, &path, &durable, &scope, &prepared, || {
                Err::<(), _>(command_error(
                    "needs-auth",
                    "gmail",
                    "Identity changed before disconnect.",
                    false,
                ))
            })
            .unwrap_err();
        assert_eq!(guard_error.code, "needs-auth");
        assert_eq!(
            store.get(&credential_ref).unwrap().as_deref(),
            Some(encoded.as_str())
        );
        assert_eq!(read_connections(&path).unwrap().len(), 1);
        store.set(&credential_ref, "newer-secret").unwrap();
        let conflict =
            commit_prepared_disconnect("gmail", &store, &path, &durable, &scope, &prepared, || {
                Ok(())
            })
            .unwrap_err();
        assert_eq!(conflict.code, "conflict");
        assert_eq!(
            store.get(&credential_ref).unwrap().as_deref(),
            Some("newer-secret")
        );
        assert_eq!(read_connections(&path).unwrap().len(), 1);
        store.set(&credential_ref, &encoded).unwrap();
        durable
            .transaction(|tx| clear_current_internal_user(tx))
            .unwrap();

        let error =
            commit_prepared_disconnect("gmail", &store, &path, &durable, &scope, &prepared, || {
                Ok(())
            })
            .unwrap_err();

        assert_eq!(
            store.get(&credential_ref).unwrap().as_deref(),
            Some(encoded.as_str())
        );
        let connections = read_connections(&path).unwrap();
        assert_eq!(connections.len(), 1);
        assert_eq!(connections[0].account.id, "account-1");
        assert!(!error.message.contains("rollback-access-secret"));
        assert!(!error.message.contains("rollback-refresh-secret"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn canonical_refresh_success_and_rejection_are_coherent_and_reversible() {
        let store = MemoryStore::default();
        let durable =
            Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap();
        let scope = durable
            .transaction(|tx| {
                tx.execute(
                    "INSERT INTO fable_internal_user_mirror(internal_user_id,status,revision,updated_at) VALUES('user-a','active',1,'t')",
                    [],
                )?;
                set_current_internal_user(tx, "user-a", "t")?;
                resolve(tx, Some("default"), None, ScopeAccess::Write)
            })
            .unwrap();
        let path = std::env::temp_dir().join(format!(
            "fable-canonical-refresh-test-{}.json",
            std::process::id()
        ));
        let _ = fs::remove_file(&path);
        let credential_ref = native_connector_credential_ref("gmail", "account-1");
        let old_tokens = StoredTokenSet {
            access_token: "old-refresh-access".into(),
            refresh_token: Some("stable-refresh-token".into()),
            token_type: "Bearer".into(),
            expires_at: Some(1),
            scopes: vec!["gmail.readonly".into()],
            revocation_endpoint: None,
            token_endpoint: None,
            handoff_endpoint: None,
            client_id: "desktop-client".into(),
            brokered: false,
        };
        let old_encoded = serde_json::to_string(&old_tokens).unwrap();
        commit_prepared_auth_state(
            &path,
            &durable,
            "gmail",
            &scope,
            &store,
            (
                old_tokens,
                ConnectorAccountSummary {
                    id: "account-1".into(),
                    display_name: "Account one".into(),
                    handle: None,
                    email: None,
                    workspace: None,
                    avatar_url: None,
                },
                credential_ref.clone(),
                CredentialRollback {
                    credential_ref: credential_ref.clone(),
                    previous_secret: None,
                },
                old_encoded.clone(),
            ),
            || Ok(()),
        )
        .unwrap();
        let previous_connections = read_connections(&path).unwrap();
        let canonical_before =
            canonical_connection_for_refresh(&durable, &scope, "gmail", "account-1").unwrap();
        let mut updated_connection = previous_connections[0].clone();
        updated_connection.expires_at = Some(now_epoch() + 3600);
        updated_connection.updated_at = now_epoch().to_string();
        let new_tokens = StoredTokenSet {
            access_token: "new-refresh-access".into(),
            refresh_token: Some("stable-refresh-token".into()),
            token_type: "Bearer".into(),
            expires_at: updated_connection.expires_at,
            scopes: vec!["gmail.readonly".into()],
            revocation_endpoint: None,
            token_endpoint: None,
            handoff_endpoint: None,
            client_id: "desktop-client".into(),
            brokered: false,
        };
        let new_encoded = serde_json::to_string(&new_tokens).unwrap();
        durable
            .transaction(|tx| {
                crate::store::repos::connection_record::transition_native_connector(
                    tx,
                    &durable,
                    &scope,
                    &canonical_before.id,
                    canonical_before.revision,
                    "authorized",
                    "authorized",
                    "degraded",
                    "available",
                    "health-raced",
                )?;
                Ok(())
            })
            .unwrap();
        let stale = commit_refresh_success(
            "gmail",
            &store,
            &path,
            &durable,
            &scope,
            &previous_connections,
            &old_encoded,
            canonical_before.revision,
            &canonical_before.health_state,
            updated_connection.clone(),
            &new_encoded,
            || Ok(()),
        )
        .unwrap_err();
        assert_eq!(stale.code, "unknown");
        assert_eq!(
            store.get(&credential_ref).unwrap().as_deref(),
            Some(old_encoded.as_str())
        );
        assert_eq!(read_connections(&path).unwrap()[0].expires_at, Some(1));
        let canonical_current =
            canonical_connection_for_refresh(&durable, &scope, "gmail", "account-1").unwrap();
        commit_refresh_success(
            "gmail",
            &store,
            &path,
            &durable,
            &scope,
            &previous_connections,
            &old_encoded,
            canonical_current.revision,
            &canonical_current.health_state,
            updated_connection,
            &new_encoded,
            || Ok(()),
        )
        .unwrap();
        assert_eq!(
            store.get(&credential_ref).unwrap().as_deref(),
            Some(new_encoded.as_str())
        );
        let refreshed_connections = read_connections(&path).unwrap();
        let canonical_after =
            canonical_connection_for_refresh(&durable, &scope, "gmail", "account-1").unwrap();

        durable
            .transaction(|tx| clear_current_internal_user(tx))
            .unwrap();
        let rollback_error = commit_refresh_rejection(
            "gmail",
            &store,
            &path,
            &durable,
            &scope,
            &refreshed_connections,
            &new_encoded,
            "account-1",
            canonical_after.revision,
            &canonical_after.health_state,
            || Ok(()),
        )
        .unwrap_err();
        assert_eq!(rollback_error.code, "unknown");
        assert_eq!(read_connections(&path).unwrap()[0].status, "connected");
        assert_eq!(
            store.get(&credential_ref).unwrap().as_deref(),
            Some(new_encoded.as_str())
        );

        durable
            .transaction(|tx| set_current_internal_user(tx, "user-a", "t2"))
            .unwrap();
        let rejected = commit_refresh_rejection(
            "gmail",
            &store,
            &path,
            &durable,
            &scope,
            &refreshed_connections,
            &new_encoded,
            "account-1",
            canonical_after.revision,
            &canonical_after.health_state,
            || Ok(()),
        )
        .unwrap_err();
        assert_eq!(rejected.code, "expired-auth");
        assert_eq!(read_connections(&path).unwrap()[0].status, "expired");
        let canonical = durable
            .with_conn(|tx| crate::store::repos::connection_record::list(tx, &durable, &scope))
            .unwrap();
        assert_eq!(canonical[0].lifecycle, "refresh-required");
        assert_eq!(canonical[0].authorization_state, "expired");
        assert_eq!(canonical[0].health_state, "unhealthy");
        assert_eq!(canonical[0].credential_state, "refresh-required");
        assert!(!rollback_error.message.contains("old-refresh-access"));
        assert!(!rollback_error.message.contains("new-refresh-access"));
        let _ = fs::remove_file(path);
    }
}
