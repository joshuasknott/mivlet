//! Clerk identity and session boundary for Fable accounts.
//!
//! This module is deliberately separate from connector OAuth and the
//! confidential auth broker. It owns the system-browser Authorization Code +
//! PKCE flow, token refresh, JWT validation, and OS-keyring storage for Fable's
//! app identity. React receives only secret-free external authentication facts
//! and verified display attributes. Fable tenancy and authorization are
//! resolved outside this provider boundary.

use std::collections::BTreeMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, Utc};
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use url::Url;

const KEYRING_SERVICE: &str = "com.fable.workspace.identity.clerk";
const SESSION_KEY: &str = "clerk-session";
const PENDING_MAX_AGE_SECONDS: u64 = 5 * 60;
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(300);
const CALLBACK_READ_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_CALLBACK_BYTES: usize = 8192;
const CLOCK_SKEW_SECONDS: u64 = 60;

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

trait IdentitySecretStore: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<String>, String>;
    fn set(&self, key: &str, secret: &str) -> Result<(), String>;
    fn remove(&self, key: &str) -> Result<(), String>;
}

struct NativeIdentitySecretStore;

impl NativeIdentitySecretStore {
    fn entry(key: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(KEYRING_SERVICE, key)
            .map_err(|_| "Fable could not open the OS secure store.".to_string())
    }
}

impl IdentitySecretStore for NativeIdentitySecretStore {
    fn get(&self, key: &str) -> Result<Option<String>, String> {
        match Self::entry(key)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("Fable could not read cloud identity credentials.".to_string()),
        }
    }

    fn set(&self, key: &str, secret: &str) -> Result<(), String> {
        Self::entry(key)?
            .set_password(secret)
            .map_err(|_| "Fable could not store cloud identity credentials.".to_string())
    }

    fn remove(&self, key: &str) -> Result<(), String> {
        match Self::entry(key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("Fable could not remove cloud identity credentials.".to_string()),
        }
    }
}

#[derive(Clone, Debug)]
struct ClerkIdentityConfig {
    issuer: String,
    client_id: String,
    audience: String,
    authorized_party: Option<String>,
    scopes: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
struct AuthorizationServerMetadata {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
    jwks_uri: String,
    userinfo_endpoint: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
struct Jwks {
    keys: Vec<Jwk>,
}

#[derive(Clone, Debug, Deserialize)]
struct Jwk {
    kid: Option<String>,
    kty: String,
    alg: Option<String>,
    n: String,
    e: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
enum AudienceClaim {
    One(String),
    Many(Vec<String>),
}

impl AudienceClaim {
    fn contains(&self, expected: &str) -> bool {
        match self {
            AudienceClaim::One(value) => value == expected,
            AudienceClaim::Many(values) => values.iter().any(|value| value == expected),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
struct TokenClaims {
    iss: String,
    sub: String,
    aud: AudienceClaim,
    exp: u64,
    #[serde(default)]
    nbf: Option<u64>,
    #[serde(default)]
    iat: Option<u64>,
    #[serde(default)]
    azp: Option<String>,
    #[serde(default)]
    sid: Option<String>,
    #[serde(default)]
    jti: Option<String>,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    email_verified: Option<bool>,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    id_token: Option<String>,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    token_type: Option<String>,
    #[serde(default)]
    expires_in: Option<u64>,
    #[serde(default)]
    scope: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
struct UserInfoResponse {
    #[serde(default)]
    sub: Option<String>,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    email_verified: Option<bool>,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VerifiedIdentityAttribute {
    kind: String,
    normalized_value_hash: String,
    verified_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VerifiedAccountDisplayAttributes {
    #[serde(skip_serializing_if = "Option::is_none")]
    display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    email: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountAuthenticationFacts {
    provider: String,
    normalized_issuer: String,
    subject: String,
    authentication_event_ref: String,
    session_ref: String,
    authenticated_at: String,
    expires_at: String,
    verified_attributes: Vec<VerifiedIdentityAttribute>,
    #[serde(skip_serializing_if = "Option::is_none")]
    verified_display_attributes: Option<VerifiedAccountDisplayAttributes>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IdentityStatus {
    enabled: bool,
    state: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    issuer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    audience: Option<String>,
    scopes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    authentication: Option<AccountAuthenticationFacts>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyIdentitySummary {
    user_id: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    email: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct StoredSession {
    access_token: String,
    id_token: Option<String>,
    refresh_token: Option<String>,
    token_type: String,
    expires_at: u64,
    scopes: Vec<String>,
    issuer: String,
    audience: String,
    client_id: String,
    authorized_party: Option<String>,
    #[serde(default)]
    authentication: Option<AccountAuthenticationFacts>,
    #[serde(default, rename = "identity", skip_serializing)]
    legacy_identity: Option<LegacyIdentitySummary>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct PendingClerkOAuth {
    state: String,
    verifier: String,
    redirect_uri: String,
    issuer: String,
    client_id: String,
    audience: String,
    authorized_party: Option<String>,
    scopes: Vec<String>,
    token_endpoint: String,
    jwks_uri: String,
    userinfo_endpoint: Option<String>,
    created_at: u64,
}

fn now_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn epoch_to_iso(epoch: u64) -> Option<String> {
    DateTime::<Utc>::from_timestamp(epoch as i64, 0).map(|dt| dt.to_rfc3339())
}

fn random_urlsafe(bytes: usize) -> Result<String, IdentityError> {
    let mut value = vec![0_u8; bytes];
    getrandom::fill(&mut value).map_err(|_| {
        identity_error(
            "unknown",
            "Fable could not initialize a secure identity transaction.",
            false,
        )
    })?;
    Ok(URL_SAFE_NO_PAD.encode(value))
}

fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn pending_key(state: &str) -> String {
    format!("clerk-pending:{state}")
}

fn normalize_issuer(raw: &str) -> Result<String, IdentityError> {
    let mut url = Url::parse(raw).map_err(|_| {
        identity_error(
            "configuration-required",
            "Clerk issuer URL is invalid.",
            false,
        )
    })?;
    if url.scheme() != "https" {
        return Err(identity_error(
            "configuration-required",
            "Clerk issuer must use HTTPS.",
            false,
        ));
    }
    url.set_query(None);
    url.set_fragment(None);
    let path = url.path().trim_end_matches('/').to_string();
    url.set_path(&path);
    Ok(url.to_string())
}

fn split_env_list(value: Option<String>) -> Vec<String> {
    value
        .unwrap_or_default()
        .split([',', ' '])
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string)
        .collect()
}

fn load_config() -> Result<Option<ClerkIdentityConfig>, IdentityError> {
    let issuer = std::env::var("FABLE_CLERK_ISSUER").ok();
    let client_id = std::env::var("FABLE_CLERK_OAUTH_CLIENT_ID").ok();
    if issuer.is_none() && client_id.is_none() {
        return Ok(None);
    }
    let issuer = issuer.ok_or_else(|| {
        identity_error(
            "configuration-required",
            "Clerk issuer is required to enable Fable cloud identity.",
            false,
        )
    })?;
    let client_id = client_id.ok_or_else(|| {
        identity_error(
            "configuration-required",
            "Clerk OAuth client id is required to enable Fable cloud identity.",
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
    let audience = std::env::var("FABLE_CLERK_AUDIENCE")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| client_id.clone());
    let mut scopes = split_env_list(std::env::var("FABLE_CLERK_SCOPES").ok());
    if scopes.is_empty() {
        scopes = vec!["openid".into(), "profile".into(), "email".into()];
    }
    for required in ["openid", "profile", "email"] {
        if !scopes.iter().any(|scope| scope == required) {
            scopes.push(required.to_string());
        }
    }
    let authorized_party = std::env::var("FABLE_CLERK_AUTHORIZED_PARTY")
        .ok()
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

fn disabled_status() -> IdentityStatus {
    IdentityStatus {
        enabled: false,
        state: "disabled".to_string(),
        message: "Fable account setup is not configured.".to_string(),
        issuer: None,
        audience: None,
        scopes: Vec::new(),
        authentication: None,
    }
}

fn signed_out_status(config: &ClerkIdentityConfig) -> IdentityStatus {
    IdentityStatus {
        enabled: true,
        state: "signed-out".to_string(),
        message: "Fable cloud identity is signed out; local workspace features remain available."
            .to_string(),
        issuer: Some(config.issuer.clone()),
        audience: Some(config.audience.clone()),
        scopes: config.scopes.clone(),
        authentication: None,
    }
}

fn session_status(
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

fn status_from_error(config: &ClerkIdentityConfig, error: &IdentityError) -> IdentityStatus {
    IdentityStatus {
        enabled: true,
        state: if error.code == "revoked" {
            "revoked"
        } else {
            "error"
        }
        .to_string(),
        message: error.message.clone(),
        issuer: Some(config.issuer.clone()),
        audience: Some(config.audience.clone()),
        scopes: config.scopes.clone(),
        authentication: None,
    }
}

fn read_session(store: &dyn IdentitySecretStore) -> Result<Option<StoredSession>, IdentityError> {
    let Some(encoded) = store
        .get(SESSION_KEY)
        .map_err(|message| identity_error("unknown", message, false))?
    else {
        return Ok(None);
    };
    serde_json::from_str(&encoded).map(Some).map_err(|_| {
        identity_error(
            "revoked",
            "Stored Fable cloud identity is invalid; sign in again.",
            false,
        )
    })
}

fn write_session(
    store: &dyn IdentitySecretStore,
    session: &StoredSession,
) -> Result<(), IdentityError> {
    let encoded = serde_json::to_string(session).map_err(|_| {
        identity_error(
            "unknown",
            "Fable could not encode cloud identity credentials.",
            false,
        )
    })?;
    store
        .set(SESSION_KEY, &encoded)
        .map_err(|message| identity_error("unknown", message, false))
}

fn clear_session(store: &dyn IdentitySecretStore) -> Result<(), IdentityError> {
    store
        .remove(SESSION_KEY)
        .map_err(|message| identity_error("unknown", message, false))
}

fn validate_url(endpoint: &str, label: &str) -> Result<(), IdentityError> {
    let url = Url::parse(endpoint).map_err(|_| {
        identity_error(
            "configuration-required",
            format!("Clerk {label} endpoint is invalid."),
            false,
        )
    })?;
    if url.scheme() != "https" {
        return Err(identity_error(
            "configuration-required",
            format!("Clerk {label} endpoint must use HTTPS."),
            false,
        ));
    }
    Ok(())
}

async fn discover_metadata(
    config: &ClerkIdentityConfig,
) -> Result<AuthorizationServerMetadata, IdentityError> {
    crate::ensure_rustls_provider();
    let url = format!(
        "{}/.well-known/oauth-authorization-server",
        config.issuer.trim_end_matches('/')
    );
    let response = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| {
            identity_error(
                "unknown",
                "Fable could not initialize Clerk discovery.",
                false,
            )
        })?
        .get(url)
        .send()
        .await
        .map_err(|_| {
            identity_error(
                "offline",
                "Fable could not reach Clerk identity metadata.",
                true,
            )
        })?;
    if !response.status().is_success() {
        return Err(identity_error(
            "configuration-required",
            "Clerk identity metadata was rejected.",
            false,
        ));
    }
    let metadata: AuthorizationServerMetadata = response.json().await.map_err(|_| {
        identity_error(
            "configuration-required",
            "Clerk identity metadata was invalid.",
            false,
        )
    })?;
    if metadata.issuer.trim_end_matches('/') != config.issuer.trim_end_matches('/') {
        return Err(identity_error(
            "configuration-required",
            "Clerk issuer metadata did not match configuration.",
            false,
        ));
    }
    validate_url(&metadata.authorization_endpoint, "authorization")?;
    validate_url(&metadata.token_endpoint, "token")?;
    validate_url(&metadata.jwks_uri, "JWKS")?;
    if let Some(userinfo) = &metadata.userinfo_endpoint {
        validate_url(userinfo, "userinfo")?;
    }
    Ok(metadata)
}

async fn fetch_jwks(jwks_uri: &str) -> Result<Jwks, IdentityError> {
    crate::ensure_rustls_provider();
    let response = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| {
            identity_error(
                "unknown",
                "Fable could not initialize Clerk JWKS fetch.",
                false,
            )
        })?
        .get(jwks_uri)
        .send()
        .await
        .map_err(|_| {
            identity_error("offline", "Fable could not reach Clerk signing keys.", true)
        })?;
    if !response.status().is_success() {
        return Err(identity_error(
            "configuration-required",
            "Clerk signing keys were rejected.",
            false,
        ));
    }
    response.json().await.map_err(|_| {
        identity_error(
            "configuration-required",
            "Clerk signing keys were invalid.",
            false,
        )
    })
}

fn validate_claims(
    claims: &TokenClaims,
    config: &ClerkIdentityConfig,
    now: u64,
) -> Result<(), IdentityError> {
    if claims.iss.trim_end_matches('/') != config.issuer.trim_end_matches('/') {
        return Err(identity_error(
            "invalid-token",
            "Clerk token issuer did not match configuration.",
            false,
        ));
    }
    if !claims.aud.contains(&config.audience) {
        return Err(identity_error(
            "invalid-token",
            "Clerk token audience did not match configuration.",
            false,
        ));
    }
    if let Some(expected_azp) = &config.authorized_party {
        if claims.azp.as_deref() != Some(expected_azp.as_str()) {
            return Err(identity_error(
                "invalid-token",
                "Clerk token authorized party did not match configuration.",
                false,
            ));
        }
    } else if let Some(azp) = &claims.azp {
        if azp != &config.client_id {
            return Err(identity_error(
                "invalid-token",
                "Clerk token authorized party did not match the OAuth client.",
                false,
            ));
        }
    }
    if claims.exp <= now.saturating_sub(CLOCK_SKEW_SECONDS) {
        return Err(identity_error(
            "revoked",
            "Fable cloud identity expired; sign in again.",
            false,
        ));
    }
    if claims
        .nbf
        .is_some_and(|nbf| nbf > now.saturating_add(CLOCK_SKEW_SECONDS))
    {
        return Err(identity_error(
            "invalid-token",
            "Clerk token is not valid yet.",
            false,
        ));
    }
    if claims
        .iat
        .is_some_and(|iat| iat > now.saturating_add(CLOCK_SKEW_SECONDS))
    {
        return Err(identity_error(
            "invalid-token",
            "Clerk token was issued in the future.",
            false,
        ));
    }
    Ok(())
}

fn decoding_key_for(header_kid: Option<&str>, jwks: &Jwks) -> Result<DecodingKey, IdentityError> {
    let key = jwks
        .keys
        .iter()
        .find(|key| {
            key.kty == "RSA"
                && key.alg.as_deref().unwrap_or("RS256") == "RS256"
                && header_kid.is_none_or(|kid| key.kid.as_deref() == Some(kid))
        })
        .ok_or_else(|| {
            identity_error(
                "invalid-token",
                "No Clerk signing key matched the token.",
                false,
            )
        })?;
    DecodingKey::from_rsa_components(&key.n, &key.e).map_err(|_| {
        identity_error(
            "invalid-token",
            "Clerk signing key could not verify the token.",
            false,
        )
    })
}

fn validate_jwt_with_jwks(
    token: &str,
    config: &ClerkIdentityConfig,
    jwks: &Jwks,
) -> Result<TokenClaims, IdentityError> {
    let header = decode_header(token)
        .map_err(|_| identity_error("invalid-token", "Clerk token header was invalid.", false))?;
    if header.alg != Algorithm::RS256 {
        return Err(identity_error(
            "invalid-token",
            "Clerk token used an unexpected signing algorithm.",
            false,
        ));
    }
    let key = decoding_key_for(header.kid.as_deref(), jwks)?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.validate_aud = false;
    validation.validate_exp = false;
    validation.validate_nbf = false;
    validation.required_spec_claims.clear();
    let data = decode::<TokenClaims>(token, &key, &validation).map_err(|_| {
        identity_error(
            "invalid-token",
            "Clerk token signature or shape was invalid.",
            false,
        )
    })?;
    validate_claims(&data.claims, config, now_epoch())?;
    Ok(data.claims)
}

fn opaque_reference(kind: &str, value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    format!("{kind}:{}", URL_SAFE_NO_PAD.encode(digest))
}

fn normalized_value_hash(value: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(value.trim().to_lowercase().as_bytes()))
}

fn authentication_from_claims(
    claims: &TokenClaims,
    issuer: &str,
    access_token: &str,
    expires_at: u64,
) -> AccountAuthenticationFacts {
    let authenticated_epoch = claims.iat.unwrap_or_else(now_epoch);
    let authenticated_at = epoch_to_iso(authenticated_epoch)
        .unwrap_or_else(|| DateTime::<Utc>::from(UNIX_EPOCH).to_rfc3339());
    let expires_at =
        epoch_to_iso(expires_at).unwrap_or_else(|| DateTime::<Utc>::from(UNIX_EPOCH).to_rfc3339());
    let verified_email = claims
        .email_verified
        .unwrap_or(false)
        .then(|| claims.email.clone())
        .flatten();
    let verified_attributes = verified_email
        .as_deref()
        .map(|email| {
            vec![VerifiedIdentityAttribute {
                kind: "email".to_string(),
                normalized_value_hash: normalized_value_hash(email),
                verified_at: authenticated_at.clone(),
            }]
        })
        .unwrap_or_default();
    let verified_display_attributes = if claims.name.is_some() || verified_email.is_some() {
        Some(VerifiedAccountDisplayAttributes {
            display_name: claims.name.clone(),
            email: verified_email,
        })
    } else {
        None
    };
    AccountAuthenticationFacts {
        provider: "clerk".to_string(),
        normalized_issuer: issuer.to_string(),
        subject: claims.sub.clone(),
        authentication_event_ref: opaque_reference(
            "clerk-authentication",
            claims.jti.as_deref().unwrap_or(access_token),
        ),
        session_ref: opaque_reference(
            "clerk-session",
            claims.sid.as_deref().unwrap_or(access_token),
        ),
        authenticated_at,
        expires_at,
        verified_attributes,
        verified_display_attributes,
    }
}

fn merge_userinfo(authentication: &mut AccountAuthenticationFacts, userinfo: UserInfoResponse) {
    if userinfo
        .sub
        .as_deref()
        .is_some_and(|sub| sub != authentication.subject)
    {
        return;
    }
    let display = authentication.verified_display_attributes.get_or_insert(
        VerifiedAccountDisplayAttributes {
            display_name: None,
            email: None,
        },
    );
    if display.display_name.is_none() {
        display.display_name = userinfo.name;
    }
    if userinfo.email_verified.unwrap_or(false) {
        if let Some(email) = userinfo.email {
            if display.email.is_none() {
                display.email = Some(email.clone());
            }
            if !authentication
                .verified_attributes
                .iter()
                .any(|attribute| attribute.kind == "email")
            {
                authentication
                    .verified_attributes
                    .push(VerifiedIdentityAttribute {
                        kind: "email".to_string(),
                        normalized_value_hash: normalized_value_hash(&email),
                        verified_at: authentication.authenticated_at.clone(),
                    });
            }
        }
    }
    if display.display_name.is_none() && display.email.is_none() {
        authentication.verified_display_attributes = None;
    }
}

async fn fetch_userinfo(endpoint: &str, access_token: &str) -> Option<UserInfoResponse> {
    crate::ensure_rustls_provider();
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(15))
        .build()
        .ok()?
        .get(endpoint)
        .bearer_auth(access_token)
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()
}

fn open_browser(authorization_url: &str) -> Result<(), IdentityError> {
    #[cfg(target_os = "windows")]
    let opened = std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", authorization_url])
        .spawn()
        .is_ok();
    #[cfg(target_os = "macos")]
    let opened = std::process::Command::new("open")
        .arg(authorization_url)
        .spawn()
        .is_ok();
    #[cfg(all(unix, not(target_os = "macos")))]
    let opened = std::process::Command::new("xdg-open")
        .arg(authorization_url)
        .spawn()
        .is_ok();
    #[cfg(not(any(target_os = "windows", target_os = "macos", unix)))]
    let opened = false;
    if opened {
        Ok(())
    } else {
        Err(identity_error(
            "unknown",
            "Fable could not open the system browser for cloud sign-in.",
            true,
        ))
    }
}

fn bound_redirect(listener: &TcpListener) -> Result<String, IdentityError> {
    let port = listener
        .local_addr()
        .map_err(|_| {
            identity_error(
                "unknown",
                "Fable could not bind a loopback identity listener.",
                false,
            )
        })?
        .port();
    Ok(format!("http://127.0.0.1:{port}/callback"))
}

fn is_literal_loopback_host(value: &str) -> bool {
    let value = value.trim();
    value == "127.0.0.1"
        || value
            .strip_prefix("127.0.0.1:")
            .is_some_and(|port| port.parse::<u16>().is_ok())
}

fn parse_callback_target(request: &[u8]) -> Result<String, IdentityError> {
    let Some(header_end) = request.windows(4).position(|window| window == b"\r\n\r\n") else {
        return Err(identity_error(
            "invalid-request",
            "Identity callback request was incomplete.",
            false,
        ));
    };
    if header_end > MAX_CALLBACK_BYTES {
        return Err(identity_error(
            "invalid-request",
            "Identity callback request was too large.",
            false,
        ));
    }
    if !request[header_end + 4..].is_empty() {
        return Err(identity_error(
            "invalid-request",
            "Identity callback must contain a single header-only request.",
            false,
        ));
    }
    let text = std::str::from_utf8(&request[..header_end]).map_err(|_| {
        identity_error(
            "invalid-request",
            "Identity callback request was not valid UTF-8.",
            false,
        )
    })?;
    if text.contains('\n') && !text.contains("\r\n") {
        return Err(identity_error(
            "invalid-request",
            "Identity callback used ambiguous line endings.",
            false,
        ));
    }
    let mut lines = text.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split(' ');
    let method = parts.next().unwrap_or_default();
    let target = parts.next().unwrap_or_default();
    let version = parts.next().unwrap_or_default();
    if method != "GET" || parts.next().is_some() {
        return Err(identity_error(
            "invalid-request",
            "Identity callback must use a single GET request.",
            false,
        ));
    }
    if version != "HTTP/1.1" && version != "HTTP/1.0" {
        return Err(identity_error(
            "invalid-request",
            "Identity callback used an invalid HTTP version.",
            false,
        ));
    }
    if !(target == "/callback" || target.starts_with("/callback?"))
        || target.contains("://")
        || target.contains('#')
    {
        return Err(identity_error(
            "invalid-request",
            "Identity callback target did not match the registered redirect.",
            false,
        ));
    }
    let mut host: Option<String> = None;
    for line in lines {
        if line.is_empty() {
            continue;
        }
        if line.bytes().any(|byte| byte < 0x20 || byte == 0x7f) {
            return Err(identity_error(
                "invalid-request",
                "Identity callback header contained control characters.",
                false,
            ));
        }
        let Some((name, value)) = line.split_once(':') else {
            return Err(identity_error(
                "invalid-request",
                "Identity callback header was malformed.",
                false,
            ));
        };
        if name.eq_ignore_ascii_case("host") {
            if host.is_some() {
                return Err(identity_error(
                    "invalid-request",
                    "Identity callback had duplicate Host headers.",
                    false,
                ));
            }
            host = Some(value.trim().to_string());
        }
        if name.eq_ignore_ascii_case("content-length") && value.trim() != "0" {
            return Err(identity_error(
                "invalid-request",
                "Identity callback must not include a request body.",
                false,
            ));
        }
        if name.eq_ignore_ascii_case("transfer-encoding") {
            return Err(identity_error(
                "invalid-request",
                "Identity callback must not use request body framing.",
                false,
            ));
        }
    }
    if version == "HTTP/1.1" && host.is_none() {
        return Err(identity_error(
            "invalid-request",
            "Identity callback was missing Host.",
            false,
        ));
    }
    if host
        .as_deref()
        .is_some_and(|host| !is_literal_loopback_host(host))
    {
        return Err(identity_error(
            "invalid-request",
            "Identity callback Host must be literal loopback.",
            false,
        ));
    }
    Ok(target.to_string())
}

async fn read_callback_target(stream: &mut TcpStream) -> Result<String, IdentityError> {
    let mut buffer = Vec::with_capacity(MAX_CALLBACK_BYTES);
    let mut tmp = [0_u8; 1024];
    for _ in 0..16 {
        let n = tokio::time::timeout(CALLBACK_READ_TIMEOUT, stream.read(&mut tmp))
            .await
            .map_err(|_| {
                identity_error(
                    "invalid-request",
                    "Identity callback request timed out.",
                    false,
                )
            })?
            .map_err(|_| identity_error("unknown", "Identity callback was unreadable.", false))?;
        if n == 0 {
            break;
        }
        buffer.extend_from_slice(&tmp[..n]);
        if buffer.len() > MAX_CALLBACK_BYTES {
            return Err(identity_error(
                "invalid-request",
                "Identity callback request was too large.",
                false,
            ));
        }
        if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    parse_callback_target(&buffer)
}

fn callback_page(status: &str, message: &str) -> String {
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>Fable</title>\
         <style>body{{font-family:system-ui;padding:2rem;max-width:32rem;margin:auto}}</style>\
         </head><body><h1>{status}</h1><p>{message}</p>\
         <p>You can close this tab and return to Fable.</p></body></html>"
    )
}

async fn exchange_code(
    pending: &PendingClerkOAuth,
    code: &str,
) -> Result<TokenResponse, IdentityError> {
    crate::ensure_rustls_provider();
    let response = reqwest::Client::new()
        .post(&pending.token_endpoint)
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("client_id", pending.client_id.as_str()),
            ("redirect_uri", pending.redirect_uri.as_str()),
            ("code_verifier", pending.verifier.as_str()),
        ])
        .send()
        .await
        .map_err(|_| {
            identity_error(
                "offline",
                "Fable could not reach Clerk to finish sign-in.",
                true,
            )
        })?;
    if !response.status().is_success() {
        return Err(identity_error(
            "revoked",
            "Clerk rejected the identity exchange; sign in again.",
            false,
        ));
    }
    response.json().await.map_err(|_| {
        identity_error(
            "invalid-token",
            "Clerk identity token response was invalid.",
            false,
        )
    })
}

async fn refresh_tokens(
    config: &ClerkIdentityConfig,
    token_endpoint: &str,
    refresh_token: &str,
) -> Result<TokenResponse, IdentityError> {
    crate::ensure_rustls_provider();
    let response = reqwest::Client::new()
        .post(token_endpoint)
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", config.client_id.as_str()),
        ])
        .send()
        .await
        .map_err(|_| {
            identity_error(
                "offline",
                "Fable could not reach Clerk to refresh cloud identity.",
                true,
            )
        })?;
    if !response.status().is_success() {
        return Err(identity_error(
            "revoked",
            "Fable cloud identity was revoked or expired; sign in again.",
            false,
        ));
    }
    response.json().await.map_err(|_| {
        identity_error(
            "invalid-token",
            "Clerk refresh response was invalid.",
            false,
        )
    })
}

async fn session_from_tokens(
    config: ClerkIdentityConfig,
    metadata: &AuthorizationServerMetadata,
    current: Option<StoredSession>,
    tokens: TokenResponse,
) -> Result<StoredSession, IdentityError> {
    let jwks = fetch_jwks(&metadata.jwks_uri).await?;
    let access_claims = validate_jwt_with_jwks(&tokens.access_token, &config, &jwks)?;
    if let Some(id_token) = &tokens.id_token {
        let id_claims = validate_jwt_with_jwks(id_token, &config, &jwks)?;
        if id_claims.sub != access_claims.sub {
            return Err(identity_error(
                "invalid-token",
                "Clerk access and identity tokens named different subjects.",
                false,
            ));
        }
    }
    let mut scopes = tokens
        .scope
        .as_deref()
        .map(|scope| {
            scope
                .split_whitespace()
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .filter(|values| !values.is_empty())
        .unwrap_or_else(|| config.scopes.clone());
    scopes.sort();
    scopes.dedup();
    let expires_at = tokens
        .expires_in
        .map(|seconds| now_epoch().saturating_add(seconds))
        .unwrap_or(access_claims.exp)
        .min(access_claims.exp);
    let mut authentication = authentication_from_claims(
        &access_claims,
        &config.issuer,
        &tokens.access_token,
        expires_at,
    );
    if let Some(userinfo_endpoint) = &metadata.userinfo_endpoint {
        if let Some(userinfo) = fetch_userinfo(userinfo_endpoint, &tokens.access_token).await {
            merge_userinfo(&mut authentication, userinfo);
        }
    }
    Ok(StoredSession {
        access_token: tokens.access_token,
        id_token: tokens.id_token.or_else(|| {
            current
                .as_ref()
                .and_then(|session| session.id_token.clone())
        }),
        refresh_token: tokens
            .refresh_token
            .or_else(|| current.and_then(|session| session.refresh_token)),
        token_type: tokens.token_type.unwrap_or_else(|| "Bearer".to_string()),
        expires_at,
        scopes,
        issuer: config.issuer,
        audience: config.audience,
        client_id: config.client_id,
        authorized_party: config.authorized_party,
        authentication: Some(authentication),
        legacy_identity: None,
    })
}

async fn status_with_store(
    store: &dyn IdentitySecretStore,
) -> Result<IdentityStatus, IdentityError> {
    let Some(config) = load_config()? else {
        return Ok(disabled_status());
    };
    let Some(mut session) = read_session(store)? else {
        return Ok(signed_out_status(&config));
    };
    let metadata = match discover_metadata(&config).await {
        Ok(metadata) => metadata,
        Err(error) if error.code == "offline" => {
            return Ok(session_status(
                "offline",
                "Fable cloud identity could not refresh while offline; local workspace features remain available.",
                &session,
            ))
        }
        Err(error) => return Err(error),
    };
    if session.expires_at > now_epoch().saturating_add(60) {
        let jwks = match fetch_jwks(&metadata.jwks_uri).await {
            Ok(jwks) => jwks,
            Err(error) if error.code == "offline" => {
                return Ok(session_status(
                    "offline",
                    "Fable cloud identity could not be verified while offline; local workspace features remain available.",
                    &session,
                ))
            }
            Err(error) => return Err(error),
        };
        let active_config = ClerkIdentityConfig {
            issuer: session.issuer.clone(),
            client_id: session.client_id.clone(),
            audience: session.audience.clone(),
            authorized_party: session.authorized_party.clone(),
            scopes: session.scopes.clone(),
        };
        match validate_jwt_with_jwks(&session.access_token, &active_config, &jwks) {
            Ok(claims) => {
                if session.authentication.is_none() {
                    let mut authentication = authentication_from_claims(
                        &claims,
                        &session.issuer,
                        &session.access_token,
                        session.expires_at,
                    );
                    if let Some(legacy) = session
                        .legacy_identity
                        .as_ref()
                        .filter(|legacy| legacy.user_id == claims.sub)
                    {
                        let display = authentication.verified_display_attributes.get_or_insert(
                            VerifiedAccountDisplayAttributes {
                                display_name: None,
                                email: None,
                            },
                        );
                        if display.display_name.is_none() {
                            display.display_name = legacy.display_name.clone();
                        }
                    }
                    session.authentication = Some(authentication);
                    session.legacy_identity = None;
                    write_session(store, &session)?;
                }
                return Ok(session_status(
                    "signed-in",
                    "Fable cloud identity is connected.",
                    &session,
                ));
            }
            Err(error) if error.code == "revoked" => {}
            Err(error) => return Err(error),
        }
    }
    let Some(refresh_token) = session.refresh_token.clone() else {
        clear_session(store)?;
        return Ok(status_from_error(
            &config,
            &identity_error(
                "revoked",
                "Fable cloud identity expired; sign in again.",
                false,
            ),
        ));
    };
    let tokens = match refresh_tokens(&config, &metadata.token_endpoint, &refresh_token).await {
        Ok(tokens) => tokens,
        Err(error) if error.code == "offline" => {
            return Ok(session_status(
                "offline",
                "Fable cloud identity could not refresh while offline; local workspace features remain available.",
                &session,
            ))
        }
        Err(error) if error.code == "revoked" => {
            clear_session(store)?;
            return Ok(status_from_error(&config, &error));
        }
        Err(error) => return Err(error),
    };
    let refreshed = session_from_tokens(config.clone(), &metadata, Some(session), tokens).await?;
    write_session(store, &refreshed)?;
    Ok(session_status(
        "signed-in",
        "Fable cloud identity refreshed.",
        &refreshed,
    ))
}

async fn begin_sign_in_with_store(
    store: &dyn IdentitySecretStore,
) -> Result<IdentityStatus, IdentityError> {
    let Some(config) = load_config()? else {
        return Ok(disabled_status());
    };
    let metadata = match discover_metadata(&config).await {
        Ok(metadata) => metadata,
        Err(error) if error.code == "offline" => {
            return Ok(IdentityStatus {
                enabled: true,
                state: "offline".to_string(),
                message: "Fable could not reach Clerk to start sign-in.".to_string(),
                issuer: Some(config.issuer),
                audience: Some(config.audience),
                scopes: config.scopes,
                authentication: None,
            })
        }
        Err(error) => return Err(error),
    };

    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|_| {
        identity_error(
            "unknown",
            "Fable could not bind a loopback identity listener.",
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
        .append_pair("code_challenge_method", "S256")
        .append_pair("prompt", "consent");

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
            "Fable could not encode identity OAuth state.",
            false,
        )
    })?;
    store
        .set(&pending_key(&state), &encoded)
        .map_err(|message| identity_error("unknown", message, false))?;
    if let Err(error) = open_browser(authorization.as_str()) {
        let _ = store.remove(&pending_key(&state));
        return Err(error);
    }

    let accept = tokio::time::timeout(CALLBACK_TIMEOUT, listener.accept()).await;
    let (mut stream, _) = match accept {
        Ok(Ok(pair)) => pair,
        Ok(Err(_)) => {
            let _ = store.remove(&pending_key(&state));
            return Err(identity_error(
                "unknown",
                "Fable could not accept the identity callback.",
                true,
            ));
        }
        Err(_) => {
            let _ = store.remove(&pending_key(&state));
            return Err(identity_error(
                "invalid-request",
                "Cloud sign-in timed out; try again.",
                true,
            ));
        }
    };

    let target = match read_callback_target(&mut stream).await {
        Ok(target) => target,
        Err(error) => {
            let _ = store.remove(&pending_key(&state));
            return Err(error);
        }
    };
    let callback_origin = redirect_uri
        .strip_suffix("/callback")
        .unwrap_or(&redirect_uri);
    let callback_url = format!("{callback_origin}{target}");
    let page_status = if callback_url.contains("error=") {
        "Sign-in incomplete"
    } else {
        "Sign-in received"
    };
    let _ = stream
        .write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n{}",
                callback_page(page_status, "Finishing in Fable.")
            )
            .as_bytes(),
        )
        .await;
    let _ = stream.shutdown().await;

    complete_callback_with_store(store, &callback_url).await
}

async fn complete_callback_with_store(
    store: &dyn IdentitySecretStore,
    callback_url: &str,
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
            "revoked",
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
    write_session(store, &session)?;
    Ok(session_status(
        "signed-in",
        "Fable cloud identity is connected.",
        &session,
    ))
}

#[tauri::command]
pub async fn identity_status(_app: tauri::AppHandle) -> Result<IdentityStatus, String> {
    status_with_store(&NativeIdentitySecretStore)
        .await
        .map_err(command_message)
}

#[tauri::command]
pub async fn identity_begin_sign_in(_app: tauri::AppHandle) -> Result<IdentityStatus, String> {
    begin_sign_in_with_store(&NativeIdentitySecretStore)
        .await
        .map_err(command_message)
}

#[tauri::command]
pub async fn identity_refresh(_app: tauri::AppHandle) -> Result<IdentityStatus, String> {
    status_with_store(&NativeIdentitySecretStore)
        .await
        .map_err(command_message)
}

#[tauri::command]
pub async fn identity_sign_out(_app: tauri::AppHandle) -> Result<IdentityStatus, String> {
    let config = load_config().map_err(command_message)?;
    clear_session(&NativeIdentitySecretStore).map_err(command_message)?;
    Ok(match config {
        Some(config) => signed_out_status(&config),
        None => disabled_status(),
    })
}

#[cfg(test)]
mod tests {
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

    fn test_config() -> ClerkIdentityConfig {
        ClerkIdentityConfig {
            issuer: "https://issuer.example".to_string(),
            client_id: "client_123".to_string(),
            audience: "fable-desktop".to_string(),
            authorized_party: Some("client_123".to_string()),
            scopes: vec!["openid".into(), "profile".into(), "email".into()],
        }
    }

    fn test_claims() -> TokenClaims {
        TokenClaims {
            iss: "https://issuer.example".to_string(),
            sub: "user_123".to_string(),
            aud: AudienceClaim::One("fable-desktop".to_string()),
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
        wrong_audience.aud = AudienceClaim::One("other".to_string());
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
    }

    #[test]
    fn claim_validation_rejects_expired_and_future_tokens() {
        let config = test_config();
        let now = now_epoch();

        let mut expired = test_claims();
        expired.exp = now - 120;
        assert_eq!(
            validate_claims(&expired, &config, now).unwrap_err().code,
            "revoked"
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
            "aud": "fable-desktop",
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

    #[test]
    fn callback_parser_accepts_only_loopback_get_callback() {
        let valid = b"GET /callback?code=c&state=s HTTP/1.1\r\nHost: 127.0.0.1:34567\r\n\r\n";
        assert_eq!(
            parse_callback_target(valid).unwrap(),
            "/callback?code=c&state=s"
        );

        let bad_host = b"GET /callback?code=c&state=s HTTP/1.1\r\nHost: localhost:34567\r\n\r\n";
        assert_eq!(
            parse_callback_target(bad_host).unwrap_err().code,
            "invalid-request"
        );

        let smuggled = b"GET /callback?code=c&state=s HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\nGET /other HTTP/1.1\r\n\r\n";
        assert_eq!(
            parse_callback_target(smuggled).unwrap_err().message,
            "Identity callback must contain a single header-only request."
        );

        let wrong_path = b"GET /callbackevil?code=c&state=s HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n";
        assert_eq!(
            parse_callback_target(wrong_path).unwrap_err().message,
            "Identity callback target did not match the registered redirect."
        );

        let framed_body = b"GET /callback?code=c&state=s HTTP/1.1\r\nHost: 127.0.0.1:1\r\nTransfer-Encoding: chunked\r\n\r\n";
        assert_eq!(
            parse_callback_target(framed_body).unwrap_err().message,
            "Identity callback must not use request body framing."
        );
    }

    #[tokio::test]
    async fn callback_error_removes_pending_state() {
        let store = MemoryStore::default();
        let key = pending_key("state_1");
        store.set(&key, "pending verifier").unwrap();

        let error = complete_callback_with_store(
            &store,
            "http://127.0.0.1:1234/callback?state=state_1&error=access_denied",
        )
        .await
        .unwrap_err();

        assert_eq!(error.code, "revoked");
        assert!(store.get(&key).unwrap().is_none());
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
            id_token: Some("id_secret".to_string()),
            refresh_token: Some("refresh_secret".to_string()),
            token_type: "Bearer".to_string(),
            expires_at: now_epoch() + 3600,
            scopes: vec!["openid".to_string()],
            issuer: "https://issuer.example".to_string(),
            audience: "fable-desktop".to_string(),
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
            "audience": "fable-desktop",
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
        assert_eq!(legacy_identity.email.as_deref(), Some("user@example.com"));

        let claims = test_claims();
        session.authentication = Some(authentication_from_claims(
            &claims,
            &session.issuer,
            &session.access_token,
            session.expires_at,
        ));
        session.legacy_identity = None;
        write_session(&store, &session).unwrap();

        let rewritten = store.get(SESSION_KEY).unwrap().unwrap();
        assert!(!rewritten.contains("org_obsolete"));
        assert!(!rewritten.contains("organization"));
        assert!(!rewritten.contains("\"identity\""));
        assert!(rewritten.contains("\"authentication\""));
    }

    #[test]
    fn memory_store_removes_session_on_sign_out_path() {
        let store = MemoryStore::default();
        store.set(SESSION_KEY, "value").unwrap();
        clear_session(&store).unwrap();
        assert!(store.get(SESSION_KEY).unwrap().is_none());
    }
}
