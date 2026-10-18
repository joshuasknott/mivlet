//! Connector OAuth endpoint and client configuration.

use serde::Serialize;
use url::Url;

use super::{command_error, ConnectorSecretStore, NativeConnectorSecretStore};

#[derive(Clone, Debug)]
pub(super) struct OAuthProviderConfig {
    pub authorization_endpoint: String,
    pub token_endpoint: Option<String>,
    pub revocation_endpoint: Option<String>,
    pub userinfo_endpoint: Option<String>,
    pub handoff_endpoint: Option<String>,
    pub client_id: String,
    pub scopes: Vec<String>,
    pub brokered: bool,
}

/// The exhaustive OAuth surface the auth broker implements.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(super) struct BrokerEndpoints {
    pub authorization_endpoint: String,
    pub handoff_endpoint: String,
    pub refresh_endpoint: String,
    pub revocation_endpoint: String,
}

pub(super) fn resolve_broker_endpoints(
    connector_id: &str,
    broker_url: Option<&str>,
) -> Result<BrokerEndpoints, crate::models::ConnectorCommandError> {
    let raw = broker_url.ok_or_else(|| {
        command_error(
            "configuration-required",
            connector_id,
            "This provider requires the configured Mivlet auth broker.",
            false,
        )
    })?;
    let broker = Url::parse(raw).map_err(|_| {
        command_error(
            "configuration-required",
            connector_id,
            "The Mivlet auth broker URL is invalid.",
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
            "The Mivlet auth broker must use HTTPS.",
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

fn broker_route(
    broker: &Url,
    connector_id: &str,
    segment: &str,
) -> Result<String, crate::models::ConnectorCommandError> {
    let base_path = broker.path().trim_end_matches('/');
    let mut url = broker.clone();
    url.set_path(&format!("{base_path}/oauth/{connector_id}/{segment}"));
    url.set_query(None);
    url.set_fragment(None);
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

pub(super) fn provision_connector_configuration() -> Result<(), String> {
    if let (Some(client_id), Ok(secret)) = (
        google_oauth_client_id(),
        crate::env_compat::var_named("MIVLET_GOOGLE_OAUTH_CLIENT_SECRET"),
    ) {
        if !secret.trim().is_empty() {
            NativeConnectorSecretStore
                .set(&format!("oauth-client-secret:google:{client_id}"), &secret)?;
        }
    }
    Ok(())
}

pub(super) fn google_oauth_client_id() -> Option<String> {
    public_configuration(
        "MIVLET_GOOGLE_OAUTH_CLIENT_ID",
        option_env!("MIVLET_GOOGLE_OAUTH_CLIENT_ID")
            .or(option_env!("FABLE_GOOGLE_OAUTH_CLIENT_ID")),
    )
}

pub(super) fn auth_broker_url() -> Option<String> {
    public_configuration(
        "MIVLET_AUTH_BROKER_URL",
        option_env!("MIVLET_AUTH_BROKER_URL").or(option_env!("FABLE_AUTH_BROKER_URL")),
    )
}

fn public_configuration(key: &str, compiled: Option<&str>) -> Option<String> {
    let compiled = if cfg!(test) { None } else { compiled };
    crate::env_compat::var_opt(key)
        .or_else(|| compiled.map(str::to_owned))
        .filter(|value| !value.trim().is_empty())
}

pub(super) fn provider_config(
    connector_id: &str,
    auth_mode: &str,
    scopes: Vec<String>,
) -> Result<OAuthProviderConfig, crate::models::ConnectorCommandError> {
    if auth_mode == "oauth-pkce" {
        let client_id = google_oauth_client_id().ok_or_else(|| {
            command_error(
                "configuration-required",
                connector_id,
                "Desktop OAuth client configuration is required.",
                false,
            )
        })?;
        google_oauth_client_secret(connector_id, &client_id)?;
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
    let endpoints = resolve_broker_endpoints(connector_id, auth_broker_url().as_deref())?;
    Ok(OAuthProviderConfig {
        authorization_endpoint: endpoints.authorization_endpoint,
        token_endpoint: None,
        revocation_endpoint: Some(endpoints.revocation_endpoint),
        userinfo_endpoint: None,
        handoff_endpoint: Some(endpoints.handoff_endpoint),
        client_id: "mivlet-desktop".to_string(),
        scopes,
        brokered: true,
    })
}

pub(super) fn google_oauth_client_secret(
    connector_id: &str,
    client_id: &str,
) -> Result<Option<String>, crate::models::ConnectorCommandError> {
    if !matches!(connector_id, "google-drive" | "gmail" | "google-calendar") {
        return Ok(None);
    }
    let environment_secret = if google_oauth_client_id().as_deref() == Some(client_id) {
        crate::env_compat::var_named("MIVLET_GOOGLE_OAUTH_CLIENT_SECRET")
            .ok()
            .filter(|secret| !secret.trim().is_empty())
    } else {
        None
    };
    if cfg!(test) {
        return environment_secret.map(Some).ok_or_else(|| {
            command_error(
                "configuration-required",
                connector_id,
                "Google Desktop OAuth client secret configuration is required.",
                false,
            )
        });
    }
    google_secret_with_store(
        connector_id,
        client_id,
        environment_secret,
        &NativeConnectorSecretStore,
    )
}

pub(super) fn google_secret_with_store(
    connector_id: &str,
    client_id: &str,
    environment_secret: Option<String>,
    store: &dyn ConnectorSecretStore,
) -> Result<Option<String>, crate::models::ConnectorCommandError> {
    let key = format!("oauth-client-secret:google:{client_id}");
    let storage_error = |_| {
        command_error(
            "credential-store-unavailable",
            connector_id,
            "Mivlet could not access Google sign-in configuration in secure storage.",
            true,
        )
    };
    if let Some(secret) = environment_secret {
        store.set(&key, &secret).map_err(storage_error)?;
        return Ok(Some(secret));
    }
    store
        .get(&key)
        .map_err(storage_error)?
        .filter(|secret| !secret.trim().is_empty())
        .map(Some)
        .ok_or_else(|| {
            command_error(
                "configuration-required",
                connector_id,
                "Google sign-in needs client configuration in this installation's secure storage.",
                false,
            )
        })
}
