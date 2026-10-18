//! OAuth transaction setup and pending-state persistence.

use serde::Deserialize;
use url::Url;

use crate::models::{ConnectorAuthResult, ConnectorCommandError};

use super::{
    command_error, now_epoch, pending_key, pkce_challenge, random_urlsafe, ConnectorSecretStore,
    OAuthProviderConfig, PendingOAuth,
};

#[cfg(test)]
pub(super) fn start_with_store(
    connector_id: &str,
    redirect_uri: &str,
    config: OAuthProviderConfig,
    store: &dyn ConnectorSecretStore,
) -> Result<ConnectorAuthResult, ConnectorCommandError> {
    start_with_store_bound(connector_id, redirect_uri, config, store, None)
}

pub(super) fn start_with_store_bound(
    connector_id: &str,
    redirect_uri: &str,
    config: OAuthProviderConfig,
    store: &dyn ConnectorSecretStore,
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
            .append_pair("prompt", "consent select_account");
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
        local_workspace_id,
    };
    let encoded = serde_json::to_string(&pending).map_err(|_| {
        command_error(
            "unknown",
            connector_id,
            "Mivlet could not encode OAuth state.",
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
pub(super) struct TokenResponse {
    #[serde(alias = "accessToken")]
    pub(super) access_token: String,
    #[serde(alias = "refreshToken")]
    pub(super) refresh_token: Option<String>,
    #[serde(alias = "tokenType")]
    pub(super) token_type: Option<String>,
    #[serde(alias = "expiresIn")]
    pub(super) expires_in: Option<u64>,
    pub(super) scope: Option<String>,
    pub(super) account: Option<crate::models::ConnectorAccountSummary>,
}

#[derive(Deserialize)]
pub(super) struct OAuthErrorResponse {
    pub(super) error: Option<String>,
}

pub(super) fn token_exchange_rejection_message(provider_error: Option<&str>) -> &'static str {
    match provider_error {
        Some("invalid_grant") => {
            "OAuth token exchange was rejected: the authorization code or PKCE verifier was invalid (invalid_grant)."
        }
        Some("invalid_client") => {
            "OAuth token exchange was rejected: the desktop OAuth client was invalid (invalid_client)."
        }
        Some("redirect_uri_mismatch") => {
            "OAuth token exchange was rejected: the loopback redirect did not match (redirect_uri_mismatch)."
        }
        Some("invalid_request") => {
            "OAuth token exchange was rejected because the provider considered the request invalid (invalid_request)."
        }
        _ => "OAuth token exchange was rejected.",
    }
}

#[derive(Deserialize)]
pub(super) struct HandoffResponse {
    pub(super) tokens: TokenResponse,
    pub(super) account: Option<crate::models::ConnectorAccountSummary>,
}

pub(super) fn broker_sibling_endpoint(
    endpoint: &str,
    segment: &str,
) -> Result<String, ConnectorCommandError> {
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
