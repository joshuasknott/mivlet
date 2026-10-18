//! Desktop OAuth and connector token boundary.
//!
//! Public clients use Authorization Code + PKCE directly. Providers requiring
//! confidential client credentials are routed through one narrowly scoped auth
//! broker. Access/refresh tokens and pending PKCE verifiers are stored only in
//! the OS credential store; the local connection file contains non-secret
//! account identity and expiry metadata.
//!
//! Brokered connectors keep a desktop S256 verifier in the keyring and prove it
//! at handoff redeem. The broker does not forward that challenge to the
//! provider; it mints its own PKCE pair for providers that require it.

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

mod accounts;
mod configuration;
mod oauth_flow;
mod refresh;
mod secrets;
#[cfg(test)]
pub(crate) use accounts::accounts_for_connector;
pub(crate) use accounts::{
    account_options_from_connections, derive_native_connection_id, promote_single_active,
    read_connections, safe_account_projection, write_connections, ConnectorConnection,
};
pub(crate) use configuration::{
    auth_broker_url, google_oauth_client_id, google_oauth_client_secret, google_secret_with_store,
    provider_config, provision_connector_configuration, resolve_broker_endpoints, BrokerEndpoints,
    OAuthProviderConfig,
};
#[cfg(test)]
pub(crate) use oauth_flow::start_with_store;
pub(crate) use oauth_flow::{
    broker_sibling_endpoint, start_with_store_bound, token_exchange_rejection_message,
    HandoffResponse, OAuthErrorResponse, TokenResponse,
};
pub(crate) use refresh::{
    canonical_connection_for_refresh, canonical_credential_binding, commit_refresh_rejection,
    commit_refresh_success, refresh_authorization_context,
};
pub(crate) use secrets::{ConnectorSecretStore, NativeConnectorSecretStore};

pub(crate) const OAUTH_AUTHORIZATION_WINDOW_SECONDS: u64 = 15 * 60;

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
    /// Installation-local workspace assertion captured before provider egress.
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
            "Mivlet could not initialize a secure OAuth transaction.",
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

fn discard_pending_with_store(
    connector_id: &str,
    state: &str,
    store: &dyn ConnectorSecretStore,
) -> Result<(), String> {
    store.remove(&pending_key(connector_id, state))
}

pub(crate) fn discard_pending_auth(connector_id: &str, state: &str) -> Result<(), String> {
    discard_pending_with_store(connector_id, state, &NativeConnectorSecretStore)
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

// Broker endpoint construction lives in `configuration`.

/// Build a single broker OAuth route by extending the broker base path. The base
/// path keeps any prefix (e.g. `/broker/`) so a route-mounted broker — including
/// a Cloudflare Worker behind a path — resolves correctly with or without a
/// trailing slash. The closed vocabulary of segments is enforced at the call
/// sites; nothing here can invent a non-OAuth route.
// Connector configuration is implemented in `configuration`.

// Public client and broker configuration lives in `configuration`.

// Provider-specific endpoint configuration lives in `configuration`.

// Google client-secret provisioning lives in `configuration`.

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
    let default_message = format!("The Mivlet auth broker {operation} was unsuccessful.");
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
    code_verifier: &str,
) -> Result<TokenResponse, ConnectorCommandError> {
    let response = reqwest::Client::new()
        .post(handoff_endpoint)
        .json(&serde_json::json!({
            "contractVersion": 1,
            "provider": connector_id,
            "handoff": handoff,
            "state": state,
            "codeVerifier": code_verifier,
        }))
        .send()
        .await
        .map_err(|_| {
            command_error(
                "provider-unavailable",
                connector_id,
                "The Mivlet auth broker could not be reached.",
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
            "The Mivlet auth broker handoff response was invalid.",
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
    if now_epoch().saturating_sub(pending.created_at) > OAUTH_AUTHORIZATION_WINDOW_SECONDS {
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
                "This provider requires the configured Mivlet auth broker.",
                false,
            )
        })?;
        redeem_handoff(
            connector_id,
            &handoff_endpoint,
            &handoff_ticket,
            state.as_ref(),
            pending.verifier.as_str(),
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
        let client_secret = google_oauth_client_secret(connector_id, &pending.client_id)?;
        let mut form = vec![
            ("grant_type", "authorization_code"),
            ("code", code_value.as_ref()),
            ("client_id", pending.client_id.as_str()),
            ("redirect_uri", pending.redirect_uri.as_str()),
            ("code_verifier", pending.verifier.as_str()),
        ];
        if let Some(secret) = client_secret.as_deref() {
            form.push(("client_secret", secret));
        }
        let response = reqwest::Client::new()
            .post(&token_endpoint)
            .form(&form)
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
            // Provider error payloads may contain sensitive or attacker-controlled
            // detail. Parse only the standard error code and map an allowlisted
            // set to actionable local messages; never retain or surface the body.
            let provider_error = response
                .json::<OAuthErrorResponse>()
                .await
                .ok()
                .and_then(|payload| payload.error);
            return Err(command_error(
                "needs-auth",
                connector_id,
                token_exchange_rejection_message(provider_error.as_deref()),
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
            "Mivlet could not encode connector tokens.",
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
        prepare_with_store(connector_id, callback_url, store, None).await?;
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
                "Mivlet could not save connector state or restore the prior credential; reconnect this provider."
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

/// Resolve the *active* connection for a connector. With multi-account
/// support several accounts may be connected; reads/actions resolve against the
/// one flagged active. Falls back to the first connection if none is flagged
/// (legacy files / invariant drift) so an account never becomes unreachable.
fn selected_connection_id_for_scope(
    path: &Path,
    connector_id: &str,
    scope: &crate::authorized_scope::AuthorizedCommandScope,
) -> Option<String> {
    let durable_store = crate::store::try_global()?;
    let existing = durable_store
        .with_conn(|tx| crate::store::repos::connection_selection::get(tx, scope, connector_id))
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
        scope,
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
                scope,
                connector_id,
                &record.id,
                None,
                &now_epoch().to_string(),
            )
        })
        .ok()
        .map(|selection| selection.connection_id)
}

pub(crate) fn connection_for_scope(
    path: &Path,
    connector_id: &str,
    scope: &crate::authorized_scope::AuthorizedCommandScope,
) -> Option<ConnectorConnection> {
    let selected = selected_connection_id_for_scope(path, connector_id, scope)?;
    read_connections(path).ok()?.into_iter().find(|connection| {
        connection.connector_id == connector_id
            && derive_native_connection_id(
                scope.data.workspace_id(),
                connector_id,
                &connection.account.id,
            ) == selected
    })
}

pub(crate) fn connection_for(path: &Path, connector_id: &str) -> Option<ConnectorConnection> {
    let scope =
        crate::authorized_scope::active_command_scope(crate::authorized_scope::ScopeAccess::Read)
            .ok()?;
    connection_for_scope(path, connector_id, &scope)
}

pub(crate) fn usable_connection(path: &Path, connector_id: &str) -> Option<ConnectorConnection> {
    let scope =
        crate::authorized_scope::active_command_scope(crate::authorized_scope::ScopeAccess::Read)
            .ok()?;
    usable_connection_for_scope(path, connector_id, &scope)
}

pub(crate) fn usable_connection_for_scope(
    path: &Path,
    connector_id: &str,
    scope: &crate::authorized_scope::AuthorizedCommandScope,
) -> Option<ConnectorConnection> {
    let mut connection = connection_for_scope(path, connector_id, scope)?;
    let durable_store = crate::store::try_global()?;
    let canonical = canonical_connection_for_refresh(
        durable_store,
        scope,
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
    connection.credential_ref =
        canonical_credential_binding(durable_store, scope, connector_id, &connection.account.id)
            .ok()?;
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
        Some(scope.data.workspace_id().to_string()),
    )
}

pub(crate) async fn complete_auth(
    app: &tauri::AppHandle,
    connector_id: &str,
    request: ConnectorAuthRequest,
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
        Some(scope.data.workspace_id()),
    )
    .await?;
    commit_prepared_auth(app, connector_id, scope, &secret_store, prepared)
}

fn commit_prepared_auth(
    app: &tauri::AppHandle,
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
) -> Result<ConnectorAuthResult, ConnectorCommandError> {
    let path = connector_connections_path(app)
        .map_err(|message| command_error("unknown", connector_id, &message, false))?;
    let durable_store = crate::store::try_global().ok_or_else(|| {
        command_error(
            "unknown",
            connector_id,
            "Mivlet's encrypted store is not initialized.",
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
        || Ok(()),
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
    let canonical_connection = connections
        .iter()
        .find(|candidate| {
            candidate.connector_id == connector_id && candidate.account.id == account.id
        })
        .cloned()
        .ok_or_else(|| {
            command_error(
                "unknown",
                connector_id,
                "Connector metadata could not be prepared.",
                false,
            )
        })?;
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
        crate::capability_registry::persist_native_discovery_evidence(
            tx,
            scope,
            &canonical_connection,
            &saved,
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
                "Mivlet could not finish or fully restore connector authorization; reconnect this provider.",
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

/// Select the workspace-bound Mivlet Connection for `connector_id`. Provider
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
    scope: &crate::authorized_scope::AuthorizedCommandScope,
) -> Result<(), ConnectorCommandError> {
    let path = connector_connections_path(app)
        .map_err(|message| command_error("unknown", connector_id, &message, false))?;
    let durable_store = crate::store::try_global().ok_or_else(|| {
        command_error(
            "unknown",
            connector_id,
            "Mivlet's encrypted store is not initialized.",
            false,
        )
    })?;
    let _ = selected_connection_id_for_scope(&path, connector_id, scope);
    disconnect_with_store_and_path(
        connector_id,
        &NativeConnectorSecretStore,
        &path,
        durable_store,
        scope,
        || Ok(()),
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
    let Some(mut connection) = active else {
        return Ok(None);
    };
    connection.credential_ref =
        canonical_credential_binding(durable_store, scope, connector_id, &connection.account.id)?;
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
    left == right
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
                "Mivlet could not finish or fully restore connector disconnect; reconnect this provider.",
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

pub(crate) async fn refresh_connection(
    app: &tauri::AppHandle,
    connector_id: &str,
) -> Result<ConnectorConnection, ConnectorCommandError> {
    refresh_connection_for_connection(app, connector_id, None).await
}

async fn refresh_connection_for_connection(
    app: &tauri::AppHandle,
    connector_id: &str,
    expected_connection_id: Option<&str>,
) -> Result<ConnectorConnection, ConnectorCommandError> {
    let path = connector_connections_path(app)
        .map_err(|message| command_error("unknown", connector_id, &message, false))?;
    let connections = read_connections(&path)
        .map_err(|message| command_error("unknown", connector_id, &message, false))?;
    let (scope, durable_store) = refresh_authorization_context(connector_id)?;
    let _ = selected_connection_id_for_scope(&path, connector_id, &scope);
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
    if expected_connection_id.is_some_and(|expected| selection.connection_id != expected) {
        return Err(command_error(
            "conflict",
            connector_id,
            "Active Connection changed before provider access.",
            true,
        ));
    }
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
    let canonical = canonical_connection_for_refresh(
        durable_store,
        &scope,
        connector_id,
        &connection.account.id,
    )?;
    connection.credential_ref =
        canonical_credential_binding(durable_store, &scope, connector_id, &connection.account.id)?;
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
    if tokens.expires_at.is_none()
        || tokens
            .expires_at
            .is_some_and(|expires_at| expires_at > now_epoch() + 60)
    {
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
                "This provider requires the configured Mivlet auth broker.",
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
                    "The Mivlet auth broker could not be reached.",
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
                    || Ok(()),
                );
            }
            return Err(error);
        }
        let refreshed: HandoffResponse = response.json().await.map_err(|_| {
            command_error(
                "provider-unavailable",
                connector_id,
                "The Mivlet auth broker refresh response was invalid.",
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
        let client_secret = google_oauth_client_secret(connector_id, &tokens.client_id)?;
        let mut form = vec![
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token.as_str()),
            ("client_id", tokens.client_id.as_str()),
        ];
        if let Some(secret) = client_secret.as_deref() {
            form.push(("client_secret", secret));
        }
        let response = reqwest::Client::new()
            .post(&token_endpoint)
            .form(&form)
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
                || Ok(()),
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
            "Mivlet could not encode refreshed tokens.",
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
        || Ok(()),
    )
}

/// Return a usable token set to native provider code. Tokens remain inside
/// Rust and are refreshed before use; no Tauri command exposes this value.
pub(crate) async fn authorized_tokens(
    app: &tauri::AppHandle,
    connector_id: &str,
) -> Result<(ConnectorConnection, StoredTokenSet), ConnectorCommandError> {
    authorized_tokens_for_connection(app, connector_id, None).await
}

pub(crate) async fn authorized_tokens_for_connection(
    app: &tauri::AppHandle,
    connector_id: &str,
    expected_connection_id: Option<&str>,
) -> Result<(ConnectorConnection, StoredTokenSet), ConnectorCommandError> {
    let connection =
        refresh_connection_for_connection(app, connector_id, expected_connection_id).await?;
    if let Some(expected) = expected_connection_id {
        let scope = crate::authorized_scope::active_command_scope(
            crate::authorized_scope::ScopeAccess::Read,
        )
        .map_err(|message| command_error("invalid-request", connector_id, &message, false))?;
        require_expected_connection(
            scope.data.workspace_id(),
            connector_id,
            &connection.account.id,
            expected,
        )?;
    }
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
    provider_access_token_for_connection(app, connector_id, None).await
}

pub(crate) async fn provider_access_token_for_connection(
    app: &tauri::AppHandle,
    connector_id: &str,
    expected_connection_id: Option<&str>,
) -> Result<String, ConnectorCommandError> {
    let (_connection, tokens) =
        authorized_tokens_for_connection(app, connector_id, expected_connection_id).await?;
    Ok(tokens.access_token)
}

fn require_expected_connection(
    workspace_id: &str,
    connector_id: &str,
    provider_account_id: &str,
    expected_connection_id: &str,
) -> Result<(), ConnectorCommandError> {
    let actual = derive_native_connection_id(workspace_id, connector_id, provider_account_id);
    if actual != expected_connection_id {
        return Err(command_error(
            "conflict",
            connector_id,
            "Active Connection changed before provider access.",
            true,
        ));
    }
    Ok(())
}

/// Resolve a usable access token entirely inside the Rust/keyring boundary.
/// Callers receive it only in Rust; no Tauri command exposes this function.
pub(crate) async fn access_token(
    app: &tauri::AppHandle,
    connector_id: &str,
) -> Result<(ConnectorConnection, String), ConnectorCommandError> {
    access_token_for_connection(app, connector_id, None).await
}

pub(crate) async fn access_token_for_connection(
    app: &tauri::AppHandle,
    connector_id: &str,
    expected_connection_id: Option<&str>,
) -> Result<(ConnectorConnection, String), ConnectorCommandError> {
    let (connection, tokens) =
        authorized_tokens_for_connection(app, connector_id, expected_connection_id).await?;
    Ok((connection, tokens.access_token))
}

#[cfg(test)]
mod tests;
