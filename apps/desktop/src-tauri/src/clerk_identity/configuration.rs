//! Clerk configuration, wire models and status projections.

use super::*;

#[derive(Clone, Debug)]
pub(super) struct ClerkIdentityConfig {
    pub(super) issuer: String,
    pub(super) client_id: String,
    pub(super) audience: String,
    pub(super) authorized_party: Option<String>,
    pub(super) scopes: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ConvexFunctionType {
    Query,
    Mutation,
    Action,
}

#[allow(dead_code)] // Reserved for the focused native hosted-account adapter.
impl ConvexFunctionType {
    pub(super) fn endpoint(self) -> &'static str {
        match self {
            Self::Query => "query",
            Self::Mutation => "mutation",
            Self::Action => "action",
        }
    }
}

#[allow(dead_code)] // Constructed only by focused native adapters, never IPC.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConvexIdentityCallRequest {
    pub(crate) function_type: ConvexFunctionType,
    pub(crate) function_path: String,
    pub(crate) args: Value,
}

#[allow(dead_code)]
#[derive(Serialize)]
pub(super) struct ConvexFunctionBody<'a> {
    pub(super) path: &'a str,
    pub(super) args: &'a Value,
    pub(super) format: &'static str,
}

#[derive(Clone, Debug, Deserialize)]
pub(super) struct AuthorizationServerMetadata {
    pub(super) issuer: String,
    pub(super) authorization_endpoint: String,
    pub(super) token_endpoint: String,
    pub(super) jwks_uri: String,
    pub(super) userinfo_endpoint: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub(super) struct Jwks {
    pub(super) keys: Vec<Jwk>,
}

#[derive(Clone, Debug, Deserialize)]
pub(super) struct Jwk {
    pub(super) kid: Option<String>,
    pub(super) kty: String,
    pub(super) alg: Option<String>,
    pub(super) n: String,
    pub(super) e: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
pub(super) enum AudienceClaim {
    One(String),
    Many(Vec<String>),
}

impl AudienceClaim {
    pub(super) fn contains(&self, expected: &str) -> bool {
        match self {
            AudienceClaim::One(value) => value == expected,
            AudienceClaim::Many(values) => values.iter().any(|value| value == expected),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
pub(super) struct TokenClaims {
    pub(super) iss: String,
    pub(super) sub: String,
    #[serde(default)]
    pub(super) aud: Option<AudienceClaim>,
    pub(super) exp: u64,
    #[serde(default)]
    pub(super) nbf: Option<u64>,
    #[serde(default)]
    pub(super) iat: Option<u64>,
    #[serde(default)]
    pub(super) azp: Option<String>,
    #[serde(default)]
    pub(super) sid: Option<String>,
    #[serde(default)]
    pub(super) jti: Option<String>,
    #[serde(default)]
    pub(super) email: Option<String>,
    #[serde(default)]
    pub(super) email_verified: Option<bool>,
    #[serde(default)]
    pub(super) name: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub(super) struct TokenResponse {
    pub(super) access_token: String,
    #[serde(default)]
    pub(super) id_token: Option<String>,
    #[serde(default)]
    pub(super) refresh_token: Option<String>,
    #[serde(default)]
    pub(super) token_type: Option<String>,
    #[serde(default)]
    pub(super) expires_in: Option<u64>,
    #[serde(default)]
    pub(super) scope: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub(super) struct UserInfoResponse {
    #[serde(default)]
    pub(super) sub: Option<String>,
    #[serde(default)]
    pub(super) email: Option<String>,
    #[serde(default)]
    pub(super) email_verified: Option<bool>,
    #[serde(default)]
    pub(super) name: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct VerifiedIdentityAttribute {
    pub(super) kind: String,
    pub(super) normalized_value_hash: String,
    pub(super) verified_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct VerifiedAccountDisplayAttributes {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) email: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountAuthenticationFacts {
    pub(super) provider: String,
    pub(super) normalized_issuer: String,
    pub(super) subject: String,
    pub(super) authentication_event_ref: String,
    pub(super) session_ref: String,
    pub(super) authenticated_at: String,
    pub(super) expires_at: String,
    pub(super) verified_attributes: Vec<VerifiedIdentityAttribute>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) verified_display_attributes: Option<VerifiedAccountDisplayAttributes>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IdentityStatus {
    pub(crate) enabled: bool,
    pub(crate) state: String,
    pub(crate) message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) issuer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) audience: Option<String>,
    pub(super) scopes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) authentication: Option<AccountAuthenticationFacts>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LegacyIdentitySummary {
    pub(super) user_id: String,
    #[serde(default)]
    pub(super) display_name: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct StoredSession {
    pub(super) access_token: String,
    pub(super) refresh_token: Option<String>,
    pub(super) token_type: String,
    pub(super) expires_at: u64,
    pub(super) scopes: Vec<String>,
    pub(super) issuer: String,
    pub(super) audience: String,
    pub(super) client_id: String,
    pub(super) authorized_party: Option<String>,
    #[serde(default)]
    pub(super) authentication: Option<AccountAuthenticationFacts>,
    #[serde(default, rename = "identity", skip_serializing)]
    pub(super) legacy_identity: Option<LegacyIdentitySummary>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct PendingClerkOAuth {
    pub(super) state: String,
    pub(super) verifier: String,
    pub(super) redirect_uri: String,
    pub(super) issuer: String,
    pub(super) client_id: String,
    pub(super) audience: String,
    pub(super) authorized_party: Option<String>,
    pub(super) scopes: Vec<String>,
    pub(super) token_endpoint: String,
    pub(super) jwks_uri: String,
    pub(super) userinfo_endpoint: Option<String>,
    pub(super) created_at: u64,
}

pub(super) fn now_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub(super) fn epoch_to_iso(epoch: u64) -> Option<String> {
    DateTime::<Utc>::from_timestamp(epoch as i64, 0).map(|dt| dt.to_rfc3339())
}

pub(super) fn random_urlsafe(bytes: usize) -> Result<String, IdentityError> {
    let mut value = vec![0_u8; bytes];
    getrandom::fill(&mut value).map_err(|_| {
        identity_error(
            "unknown",
            "Mivlet could not initialize a secure identity transaction.",
            false,
        )
    })?;
    Ok(URL_SAFE_NO_PAD.encode(value))
}

pub(super) fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

pub(super) fn pending_key(state: &str) -> String {
    format!("clerk-pending:{state}")
}

pub(super) fn normalize_issuer(raw: &str) -> Result<String, IdentityError> {
    let mut url = Url::parse(raw).map_err(|_| {
        identity_error(
            "configuration-required",
            "Clerk issuer URL is invalid.",
            false,
        )
    })?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        return Err(identity_error(
            "configuration-required",
            "Clerk issuer must be an HTTPS origin without credentials, path, query, or fragment.",
            false,
        ));
    }
    let path = url.path().trim_end_matches('/').to_string();
    url.set_path(&path);
    Ok(url.to_string())
}

pub(super) fn split_env_list(value: Option<String>) -> Vec<String> {
    value
        .unwrap_or_default()
        .split([',', ' '])
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string)
        .collect()
}

pub(super) fn load_config_from(
    production: bool,
    get: impl Fn(&str) -> Option<String>,
) -> Result<Option<ClerkIdentityConfig>, IdentityError> {
    let values = CLERK_CONFIG_KEYS
        .into_iter()
        .map(|key| (key, get(key)))
        .collect::<BTreeMap<_, _>>();
    let configured = values.values().any(|value| {
        value
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
    });
    if !configured {
        return Ok(None);
    }
    for legacy_key in [
        "MIVLET_CLERK_REQUEST_ORG",
        "MIVLET_CLERK_REQUIRE_ORG",
        "MIVLET_CLERK_ALLOWED_ORG_IDS",
    ] {
        if values
            .get(legacy_key)
            .and_then(|value| value.as_deref())
            .is_some_and(|value| !value.trim().is_empty())
        {
            return Err(identity_error(
                "configuration-required",
                format!(
                    "{legacy_key} is obsolete; Clerk Organizations cannot configure Mivlet tenancy."
                ),
                false,
            ));
        }
    }
    let issuer = values
        .get("MIVLET_CLERK_ISSUER")
        .and_then(|value| value.clone())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            identity_error(
                "configuration-required",
                "Clerk issuer is required to enable Mivlet cloud identity.",
                false,
            )
        })?;
    let client_id = values
        .get("MIVLET_CLERK_OAUTH_CLIENT_ID")
        .and_then(|value| value.clone())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            identity_error(
                "configuration-required",
                "Clerk OAuth client id is required to enable Mivlet cloud identity.",
                false,
            )
        })?;
    let client_id = client_id.trim().to_string();
    if client_id.is_empty() {
        return Err(identity_error(
            "configuration-required",
            "Clerk OAuth client id is empty.",
            false,
        ));
    }
    let issuer = normalize_issuer(&issuer)?;
    let audience = values
        .get("MIVLET_CLERK_AUDIENCE")
        .and_then(|value| value.clone())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| (!production).then(|| client_id.clone()))
        .ok_or_else(|| {
            identity_error(
                "configuration-required",
                "Clerk audience must be explicit in production.",
                false,
            )
        })?;
    let mut scopes = split_env_list(
        values
            .get("MIVLET_CLERK_SCOPES")
            .and_then(|value| value.clone()),
    );
    if scopes.is_empty() {
        scopes = vec!["openid".into(), "profile".into(), "email".into()];
    }
    // A desktop session must be renewable after the access token expires.
    for required in ["openid", "profile", "email", "offline_access"] {
        if !scopes.iter().any(|scope| scope == required) {
            scopes.push(required.to_string());
        }
    }
    let authorized_party = values
        .get("MIVLET_CLERK_AUTHORIZED_PARTY")
        .and_then(|value| value.clone())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    Ok(Some(ClerkIdentityConfig {
        issuer,
        client_id,
        audience,
        authorized_party,
        scopes,
    }))
}

pub(super) fn load_config() -> Result<Option<ClerkIdentityConfig>, IdentityError> {
    load_config_with_packaged(!cfg!(debug_assertions), crate::env_compat::var_opt, |key| {
        // Public OAuth client settings only. Never embed credentials or tokens.
        match key {
            "MIVLET_CLERK_ISSUER" => {
                option_env!("MIVLET_CLERK_ISSUER").or(option_env!("FABLE_CLERK_ISSUER"))
            }
            "MIVLET_CLERK_OAUTH_CLIENT_ID" => option_env!("MIVLET_CLERK_OAUTH_CLIENT_ID")
                .or(option_env!("FABLE_CLERK_OAUTH_CLIENT_ID")),
            "MIVLET_CLERK_AUDIENCE" => {
                option_env!("MIVLET_CLERK_AUDIENCE").or(option_env!("FABLE_CLERK_AUDIENCE"))
            }
            "MIVLET_CLERK_AUTHORIZED_PARTY" => option_env!("MIVLET_CLERK_AUTHORIZED_PARTY")
                .or(option_env!("FABLE_CLERK_AUTHORIZED_PARTY")),
            "MIVLET_CLERK_SCOPES" => {
                option_env!("MIVLET_CLERK_SCOPES").or(option_env!("FABLE_CLERK_SCOPES"))
            }
            _ => None,
        }
        .map(str::to_owned)
    })
}

pub(super) fn load_config_with_packaged(
    production: bool,
    runtime: impl Fn(&str) -> Option<String>,
    packaged: impl Fn(&str) -> Option<String>,
) -> Result<Option<ClerkIdentityConfig>, IdentityError> {
    // A runtime override must be complete: do not mix separate identity services.
    let has_override = CLERK_CONFIG_KEYS
        .iter()
        .any(|key| runtime(key).is_some_and(|value| !value.trim().is_empty()));
    load_config_from(production, |key| {
        if has_override {
            runtime(key)
        } else {
            packaged(key)
        }
    })
}

pub(super) fn load_convex_url_from(raw: Option<String>) -> Result<Url, IdentityError> {
    let raw = raw
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            identity_error(
                "configuration-required",
                "Mivlet Convex URL is required for authenticated hosted calls.",
                false,
            )
        })?;
    let mut url = Url::parse(&raw).map_err(|_| {
        identity_error(
            "configuration-required",
            "Mivlet Convex URL is invalid.",
            false,
        )
    })?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        return Err(identity_error(
            "configuration-required",
            "Mivlet Convex URL must be an HTTPS deployment origin without credentials, path, query, or fragment.",
            false,
        ));
    }
    url.set_path("");
    Ok(url)
}

pub(super) fn load_convex_site_url_from(raw: Option<String>) -> Result<Url, IdentityError> {
    let mut url = load_convex_url_from(raw)?;
    let host = url.host_str().unwrap_or_default().to_string();
    if let Some(deployment) = host.strip_suffix(".convex.cloud") {
        url.set_host(Some(&format!("{deployment}.convex.site")))
            .map_err(|_| {
                identity_error(
                    "configuration-required",
                    "Mivlet Convex HTTP origin is invalid.",
                    false,
                )
            })?;
    } else if !host.ends_with(".convex.site") {
        return Err(identity_error(
            "configuration-required",
            "Mivlet Convex HTTP origin is required for native hosted calls.",
            false,
        ));
    }
    Ok(url)
}

pub(super) fn load_convex_site_url() -> Result<Url, IdentityError> {
    load_convex_site_url_from(crate::env_compat::var_opt("MIVLET_CONVEX_URL"))
}

pub(super) fn validate_convex_http_path(path: &str) -> Result<(), IdentityError> {
    if !path.starts_with("/native/")
        || path.len() > 160
        || path.ends_with('/')
        || path.contains("//")
        || !path[1..]
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'_'))
    {
        return Err(identity_error(
            "invalid-request",
            "Convex HTTP path is invalid.",
            false,
        ));
    }
    Ok(())
}

#[allow(dead_code)]
pub(super) fn load_convex_url() -> Result<Url, IdentityError> {
    load_convex_url_from(crate::env_compat::var_opt("MIVLET_CONVEX_URL"))
}

pub(super) fn disabled_status() -> IdentityStatus {
    IdentityStatus {
        enabled: false,
        state: "disabled".to_string(),
        message: "Mivlet account setup is not configured.".to_string(),
        issuer: None,
        audience: None,
        scopes: Vec::new(),
        authentication: None,
    }
}

pub(super) fn signed_out_status(config: &ClerkIdentityConfig) -> IdentityStatus {
    IdentityStatus {
        enabled: true,
        state: "signed-out".to_string(),
        message: "Mivlet account is signed out; sign in to continue.".to_string(),
        issuer: Some(config.issuer.clone()),
        audience: Some(config.audience.clone()),
        scopes: config.scopes.clone(),
        authentication: None,
    }
}

pub(super) fn session_status(
    state: &str,
    message: impl Into<String>,
    session: &StoredSession,
) -> IdentityStatus {
    IdentityStatus {
        enabled: true,
        state: state.to_string(),
        message: message.into(),
        issuer: Some(session.issuer.clone()),
        audience: Some(session.audience.clone()),
        scopes: session.scopes.clone(),
        authentication: session.authentication.clone(),
    }
}

pub(super) fn status_from_error(
    config: &ClerkIdentityConfig,
    error: &IdentityError,
) -> IdentityStatus {
    IdentityStatus {
        enabled: true,
        state: match error.code {
            "expired" => "expired",
            "revoked" => "revoked",
            "offline" => "offline",
            _ => "error",
        }
        .to_string(),
        message: error.message.clone(),
        issuer: Some(config.issuer.clone()),
        audience: Some(config.audience.clone()),
        scopes: config.scopes.clone(),
        authentication: None,
    }
}
