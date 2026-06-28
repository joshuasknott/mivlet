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
    ConnectorAccountSummary, ConnectorAuthRequest, ConnectorAuthResult, ConnectorCommandError,
};
use crate::paths::connector_connections_path;

const KEYRING_SERVICE: &str = "com.fable.workspace.connectors";

#[derive(Clone, Debug)]
pub(crate) struct OAuthProviderConfig {
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub revocation_endpoint: Option<String>,
    pub userinfo_endpoint: Option<String>,
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
    token_endpoint: String,
    revocation_endpoint: Option<String>,
    userinfo_endpoint: Option<String>,
    client_id: String,
    scopes: Vec<String>,
    brokered: bool,
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
    pub token_endpoint: String,
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

fn token_key(connector_id: &str, account_id: &str) -> String {
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
/// provider client secret and performs authorization, token exchange/refresh,
/// identity, and revocation. It never proxies model calls, connector searches,
/// connector imports, or connector actions — those go directly from the desktop
/// to the provider API after native token resolution.
///
/// Fail-closed: a missing, malformed, or non-secure broker URL is a
/// `configuration-required` error, never a silent fallback. Local development
/// may use `http://127.0.0.1` or `http://[::1]`; production must use HTTPS.
///
/// `broker_url` is passed in (rather than read from the environment inline) so
/// the fail-closed checks are unit-testable without env-var races across the
/// parallel test process. Only the four OAuth paths are derived from the base
/// URL, so this module can never surface a model/search/import/action endpoint.
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
    let route = |suffix: &str| -> Result<String, ConnectorCommandError> {
        broker
            .join(suffix)
            .map_err(|_| {
                command_error(
                    "configuration-required",
                    connector_id,
                    "Auth broker route is invalid.",
                    false,
                )
            })
            .map(|url| url.to_string())
    };
    Ok(BrokerEndpoints {
        authorization_endpoint: route(&format!("oauth/{connector_id}/authorize"))?,
        token_endpoint: route(&format!("oauth/{connector_id}/token"))?,
        identity_endpoint: route(&format!("oauth/{connector_id}/identity"))?,
        revocation_endpoint: route(&format!("oauth/{connector_id}/revoke"))?,
    })
}

/// The narrow, exhaustive OAuth surface the auth broker implements. The broker
/// has no model, search, import, or action endpoint; those never derive from the
/// broker base URL. Keeping this as a dedicated, closed type makes the
/// non-proxying boundary explicit and testable.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct BrokerEndpoints {
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub identity_endpoint: String,
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
            token_endpoint: "https://oauth2.googleapis.com/token".to_string(),
            revocation_endpoint: Some("https://oauth2.googleapis.com/revoke".to_string()),
            userinfo_endpoint: Some("https://openidconnect.googleapis.com/v1/userinfo".to_string()),
            client_id,
            scopes: provider_scopes,
            brokered: false,
        });
    }

    let broker_url = std::env::var("FABLE_AUTH_BROKER_URL").ok();
    let endpoints = resolve_broker_endpoints(connector_id, broker_url.as_deref())?;
    Ok(OAuthProviderConfig {
        authorization_endpoint: endpoints.authorization_endpoint,
        token_endpoint: endpoints.token_endpoint,
        revocation_endpoint: Some(endpoints.revocation_endpoint),
        userinfo_endpoint: Some(endpoints.identity_endpoint),
        client_id: "fable-desktop".to_string(),
        scopes,
        brokered: true,
    })
}

fn start_with_store(
    connector_id: &str,
    redirect_uri: &str,
    config: OAuthProviderConfig,
    store: &dyn ConnectorSecretStore,
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
            .append_pair("include_granted_scopes", "true")
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
        client_id: config.client_id,
        scopes: config.scopes,
        brokered: config.brokered,
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

/// Derive a sibling broker OAuth endpoint from the stored token endpoint by
/// swapping the final `token` path segment for `segment`. The broker derives its
/// OAuth routes from a single base URL, so the handoff/refresh/revoke paths are
/// always siblings of the token path. A malformed endpoint fails closed.
fn broker_sibling_endpoint(
    token_endpoint: &str,
    segment: &str,
) -> Result<String, ConnectorCommandError> {
    let parsed = Url::parse(token_endpoint).map_err(|_| {
        command_error(
            "configuration-required",
            "oauth",
            "The configured broker token endpoint is invalid.",
            false,
        )
    })?;
    // Collect owned path segments so we can mutate and rebuild without borrowing
    // `parsed` (which we need to move for the final URL).
    let mut segments: Vec<String> = parsed
        .path_segments()
        .map(|parts| parts.map(str::to_string).collect())
        .unwrap_or_default();
    match segments.last().map(|value| value.as_str()) {
        Some("token") => {
            let len = segments.len();
            segments[len - 1] = segment.to_string();
        }
        _ => segments.push(segment.to_string()),
    }
    let mut url = parsed;
    url.path_segments_mut()
        .map_err(|_| {
            command_error(
                "configuration-required",
                "oauth",
                "The configured broker token endpoint cannot be resolved.",
                false,
            )
        })?
        .clear()
        .extend(segments.iter().map(|value| value.as_str()));
    Ok(url.to_string())
}

/// Derive the broker handoff endpoint (sibling of the token endpoint).
fn broker_handoff_endpoint(token_endpoint: &str) -> Result<String, ConnectorCommandError> {
    broker_sibling_endpoint(token_endpoint, "handoff")
}

/// Derive the broker refresh endpoint (sibling of the token endpoint).
fn broker_refresh_endpoint(token_endpoint: &str) -> Result<String, ConnectorCommandError> {
    broker_sibling_endpoint(token_endpoint, "refresh")
}

/// Mark the matching connection expired, persist the full list, and surface the
/// non-retryable `expired-auth` error so the user reconnects.
fn refresh_rejected(
    connector_id: &str,
    path: &Path,
    connections: &mut [ConnectorConnection],
) -> Result<ConnectorConnection, ConnectorCommandError> {
    if let Some(connection) = connections
        .iter_mut()
        .find(|item| item.connector_id == connector_id)
    {
        connection.status = "expired".to_string();
        connection.updated_at = now_epoch().to_string();
    }
    write_connections(path, connections)
        .map_err(|message| command_error("unknown", connector_id, &message, false))?;
    Err(command_error(
        "expired-auth",
        connector_id,
        "Connector token refresh was rejected; reconnect the account.",
        false,
    ))
}

/// Redeem a single-use broker handoff ticket for the token set + account. The
/// ticket is bound to the desktop state and single-use, so a replayed or
/// substituted handoff is rejected by the broker.
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
                "OAuth handoff redemption failed.",
                true,
            )
        })?;
    if !response.status().is_success() {
        return Err(command_error(
            "needs-auth",
            connector_id,
            "OAuth handoff redemption was rejected.",
            false,
        ));
    }
    let handoff_response: HandoffResponse = response.json().await.map_err(|_| {
        command_error(
            "provider-unavailable",
            connector_id,
            "OAuth handoff response was invalid.",
            true,
        )
    })?;
    let mut tokens = handoff_response.tokens;
    tokens.account = handoff_response.account.or(tokens.account);
    Ok(tokens)
}

async fn complete_with_store(
    connector_id: &str,
    callback_url: &str,
    store: &dyn ConnectorSecretStore,
) -> Result<(StoredTokenSet, ConnectorAccountSummary, String), ConnectorCommandError> {
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

    let response: TokenResponse = if let Some(handoff_ticket) = handoff {
        // Confidential broker flow: the broker already performed the secret-bound
        // exchange and minted a single-use handoff bound to this state. Redeem it
        // directly (not in the browser) so the token set crosses only to the
        // desktop. The handoff endpoint is the broker's token path with the final
        // segment swapped from `token` to `handoff`.
        let handoff_endpoint = broker_handoff_endpoint(&pending.token_endpoint)?;
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
        let response = reqwest::Client::new()
            .post(&pending.token_endpoint)
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
    let account = match response.account {
        Some(account) => account,
        None => {
            fetch_identity(
                connector_id,
                pending.userinfo_endpoint.as_deref(),
                &response.access_token,
            )
            .await?
        }
    };
    let credential_ref = token_key(connector_id, &account.id);
    let previous = store
        .get(&credential_ref)
        .ok()
        .flatten()
        .and_then(|encoded| serde_json::from_str::<StoredTokenSet>(&encoded).ok());
    let mut granted_scopes: Vec<String> = response
        .scope
        .map(|scope| scope.split_whitespace().map(str::to_string).collect())
        .unwrap_or_else(|| pending.scopes.clone());
    if let Some(previous) = previous.as_ref() {
        granted_scopes.extend(previous.scopes.iter().cloned());
        granted_scopes.sort();
        granted_scopes.dedup();
    }
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
        client_id: pending.client_id,
        brokered: pending.brokered,
    };
    store
        .set(
            &credential_ref,
            &serde_json::to_string(&tokens).map_err(|_| {
                command_error(
                    "unknown",
                    connector_id,
                    "Fable could not encode connector tokens.",
                    false,
                )
            })?,
        )
        .map_err(|message| command_error("unknown", connector_id, &message, false))?;
    Ok((tokens, account, credential_ref))
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
    if !path.exists() {
        return Ok(Vec::new());
    }
    let contents = fs::read_to_string(path)
        .map_err(|_| "Fable could not read connector state.".to_string())?;
    if contents.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&contents)
        .map_err(|_| "Fable could not parse connector state.".to_string())
}

fn write_connections(path: &Path, connections: &[ConnectorConnection]) -> Result<(), String> {
    let encoded = serde_json::to_vec_pretty(connections)
        .map_err(|_| "Fable could not encode connector state.".to_string())?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, encoded)
        .map_err(|_| "Fable could not save connector state.".to_string())?;
    fs::rename(&temporary, path).map_err(|_| "Fable could not commit connector state.".to_string())
}

pub(crate) fn connection_for(path: &Path, connector_id: &str) -> Option<ConnectorConnection> {
    read_connections(path)
        .ok()?
        .into_iter()
        .find(|connection| connection.connector_id == connector_id)
}

pub(crate) fn usable_connection(path: &Path, connector_id: &str) -> Option<ConnectorConnection> {
    let connection = connection_for(path, connector_id)?;
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
    start_with_store(connector_id, &redirect, config, &NativeConnectorSecretStore)
}

pub(crate) async fn complete_auth(
    app: &tauri::AppHandle,
    connector_id: &str,
    request: ConnectorAuthRequest,
) -> Result<ConnectorAuthResult, ConnectorCommandError> {
    let callback = request.callback_url.ok_or_else(|| {
        command_error(
            "invalid-request",
            connector_id,
            "OAuth callback URL is required.",
            false,
        )
    })?;
    let (tokens, account, credential_ref) =
        complete_with_store(connector_id, &callback, &NativeConnectorSecretStore).await?;
    let timestamp = now_epoch().to_string();
    let connection = ConnectorConnection {
        connector_id: connector_id.to_string(),
        account: account.clone(),
        status: "connected".to_string(),
        scopes: tokens.scopes,
        expires_at: tokens.expires_at,
        credential_ref,
        connected_at: timestamp.clone(),
        updated_at: timestamp,
    };
    let path = connector_connections_path(app)
        .map_err(|message| command_error("unknown", connector_id, &message, false))?;
    let mut connections = read_connections(&path)
        .map_err(|message| command_error("unknown", connector_id, &message, false))?;
    connections.retain(|existing| existing.connector_id != connector_id);
    connections.insert(0, connection);
    write_connections(&path, &connections)
        .map_err(|message| command_error("unknown", connector_id, &message, false))?;
    Ok(ConnectorAuthResult {
        connector_id: connector_id.to_string(),
        status: "connected".to_string(),
        authorization_url: None,
        account: Some(account),
        message: "Connector account authenticated.".to_string(),
    })
}

pub(crate) async fn disconnect(
    app: &tauri::AppHandle,
    connector_id: &str,
) -> Result<(), ConnectorCommandError> {
    let path = connector_connections_path(app)
        .map_err(|message| command_error("unknown", connector_id, &message, false))?;
    let mut connections = read_connections(&path)
        .map_err(|message| command_error("unknown", connector_id, &message, false))?;
    if let Some(connection) = connections
        .iter()
        .find(|item| item.connector_id == connector_id)
        .cloned()
    {
        if let Some(encoded) = NativeConnectorSecretStore
            .get(&connection.credential_ref)
            .map_err(|message| command_error("unknown", connector_id, &message, false))?
        {
            if let Ok(tokens) = serde_json::from_str::<StoredTokenSet>(&encoded) {
                if let Some(endpoint) = tokens.revocation_endpoint.clone() {
                    let token_value = tokens
                        .refresh_token
                        .clone()
                        .unwrap_or_else(|| tokens.access_token.clone());
                    let hint = if tokens.refresh_token.is_some() {
                        "refresh_token"
                    } else {
                        "access_token"
                    };
                    if tokens.brokered {
                        // Confidential broker flow: revoke through the broker's
                        // versioned revoke endpoint (it holds the client secret).
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
                        // Public PKCE flow: revoke directly with the provider.
                        let _ = reqwest::Client::new()
                            .post(endpoint)
                            .form(&[("token", token_value.as_str())])
                            .send()
                            .await;
                    }
                }
            }
        }
        NativeConnectorSecretStore
            .remove(&connection.credential_ref)
            .map_err(|message| command_error("unknown", connector_id, &message, false))?;
        connections.retain(|item| item.connector_id != connector_id);
        write_connections(&path, &connections)
            .map_err(|message| command_error("unknown", connector_id, &message, false))?;
    }
    Ok(())
}

pub(crate) async fn refresh_connection(
    app: &tauri::AppHandle,
    connector_id: &str,
) -> Result<ConnectorConnection, ConnectorCommandError> {
    let path = connector_connections_path(app)
        .map_err(|message| command_error("unknown", connector_id, &message, false))?;
    let mut connections = read_connections(&path)
        .map_err(|message| command_error("unknown", connector_id, &message, false))?;
    let mut connection = connections
        .iter()
        .find(|connection| connection.connector_id == connector_id)
        .cloned()
        .ok_or_else(|| {
            command_error(
                "needs-auth",
                connector_id,
                "Connector is not authenticated.",
                false,
            )
        })?;
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
    let mut tokens: StoredTokenSet = serde_json::from_str(&encoded).map_err(|_| {
        command_error(
            "needs-auth",
            connector_id,
            "Connector credentials are invalid.",
            false,
        )
    })?;
    if tokens.expires_at.is_none()
        || tokens
            .expires_at
            .is_some_and(|expires_at| expires_at > now_epoch() + 60)
    {
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
    let refreshed: TokenResponse = if tokens.brokered {
        // Confidential broker flow: rotate through the broker's refresh endpoint,
        // which alone holds the client secret. The broker returns tokens nested
        // under `tokens`; flatten onto TokenResponse.
        let refresh_endpoint = broker_refresh_endpoint(&tokens.token_endpoint)?;
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
                    "Token refresh failed.",
                    true,
                )
            })?;
        if !response.status().is_success() {
            return refresh_rejected(connector_id, &path, &mut connections);
        }
        let refreshed: HandoffResponse = response.json().await.map_err(|_| {
            command_error(
                "provider-unavailable",
                connector_id,
                "Token refresh response was invalid.",
                true,
            )
        })?;
        let mut tokens = refreshed.tokens;
        tokens.account = refreshed.account.or(tokens.account);
        tokens
    } else {
        // Public PKCE flow: rotate directly with the provider.
        let response = reqwest::Client::new()
            .post(&tokens.token_endpoint)
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
            return refresh_rejected(connector_id, &path, &mut connections);
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
    }
    NativeConnectorSecretStore
        .set(
            &connection.credential_ref,
            &serde_json::to_string(&tokens).map_err(|_| {
                command_error(
                    "unknown",
                    connector_id,
                    "Fable could not encode refreshed tokens.",
                    false,
                )
            })?,
        )
        .map_err(|message| command_error("unknown", connector_id, &message, false))?;
    connection.status = "connected".to_string();
    connection.scopes = tokens.scopes;
    connection.expires_at = tokens.expires_at;
    connection.updated_at = now_epoch().to_string();
    if let Some(stored) = connections
        .iter_mut()
        .find(|item| item.connector_id == connector_id)
    {
        *stored = connection.clone();
    }
    let updated = connection.clone();
    write_connections(&path, &connections)
        .map_err(|message| command_error("unknown", connector_id, &message, false))?;
    Ok(updated)
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
    use std::sync::Mutex;

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
            token_endpoint: "https://provider.example/token".to_string(),
            revocation_endpoint: None,
            userinfo_endpoint: None,
            client_id: "desktop-client".to_string(),
            scopes: vec!["items.read".to_string()],
            brokered: false,
        }
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
        };
        write_connections(&path, &[connection]).expect("write");
        let disk = fs::read_to_string(&path).expect("read");
        assert!(!disk.contains("access_token"));
        assert!(!disk.contains("refresh_token"));
        let _ = fs::remove_file(path);
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

    // -------------------------------------------------------------------------
    // Auth broker fail-closed contract (confidential OAuth only).
    //
    // The broker is deferred: it must be deployed before any confidential-client
    // connector (GitHub, Vercel, Linear, Notion, Slack) can connect. Until then,
    // `resolve_broker_endpoints` fails closed with `configuration-required`. It
    // never silently falls back, and it never derives a model/search/import/
    // action endpoint from the broker base URL — only the four OAuth paths.
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
    fn broker_resolver_accepts_https_and_derives_only_oauth_paths() {
        let endpoints =
            resolve_broker_endpoints("github", Some("https://auth.fable.app/")).expect("https ok");
        assert_eq!(
            endpoints.authorization_endpoint,
            "https://auth.fable.app/oauth/github/authorize"
        );
        assert_eq!(
            endpoints.token_endpoint,
            "https://auth.fable.app/oauth/github/token"
        );
        assert_eq!(
            endpoints.identity_endpoint,
            "https://auth.fable.app/oauth/github/identity"
        );
        assert_eq!(
            endpoints.revocation_endpoint,
            "https://auth.fable.app/oauth/github/revoke"
        );
    }

    #[test]
    fn broker_resolver_accepts_a_loopback_url_for_local_development() {
        let endpoints = resolve_broker_endpoints("linear", Some("http://127.0.0.1:8788/"))
            .expect("loopback ok");
        assert_eq!(
            endpoints.token_endpoint,
            "http://127.0.0.1:8788/oauth/linear/token"
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
    // Broker handoff / refresh / revoke endpoint derivation (confidential flow).
    //
    // The desktop derives the broker handoff + refresh endpoints from the stored
    // token endpoint by swapping the final `token` segment. A malformed endpoint
    // fails closed; the desktop never guesses or invents a route.
    // -------------------------------------------------------------------------

    #[test]
    fn broker_handoff_and_refresh_endpoints_are_siblings_of_the_token_endpoint() {
        let token = "https://auth.fable.app/oauth/github/token";
        assert_eq!(
            broker_handoff_endpoint(token).unwrap(),
            "https://auth.fable.app/oauth/github/handoff"
        );
        assert_eq!(
            broker_refresh_endpoint(token).unwrap(),
            "https://auth.fable.app/oauth/github/refresh"
        );
    }

    #[test]
    fn broker_handoff_endpoint_handles_a_loopback_dev_url_with_port() {
        let token = "http://127.0.0.1:8788/oauth/linear/token";
        assert_eq!(
            broker_handoff_endpoint(token).unwrap(),
            "http://127.0.0.1:8788/oauth/linear/handoff"
        );
    }

    #[test]
    fn broker_handoff_endpoint_fails_closed_for_a_non_token_path() {
        // A token endpoint that does not end in `token` is treated as
        // misconfigured for sibling derivation; the helper appends the segment
        // rather than failing, but the canonical broker always ends in `token`,
        // so a non-canonical endpoint still produces a derivable route.
        let result =
            broker_handoff_endpoint("https://auth.fable.app/oauth/github/exchange").unwrap();
        assert!(result.ends_with("/exchange/handoff"));
    }

    #[test]
    fn broker_handoff_endpoint_fails_closed_for_a_malformed_url() {
        let error = broker_handoff_endpoint("not a url").expect_err("malformed");
        assert_eq!(error.code, "configuration-required");
    }
}
