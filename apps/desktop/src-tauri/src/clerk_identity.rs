//! Clerk identity and session boundary for Mivlet accounts.
//!
//! This module is deliberately separate from connector OAuth and the
//! confidential auth broker. It owns the system-browser Authorization Code +
//! PKCE flow, token refresh, JWT validation, and OS-keyring storage for Mivlet's
//! app identity. React receives only secret-free external authentication facts
//! and verified display attributes. Mivlet tenancy and authorization are
//! resolved outside this provider boundary.

use std::collections::BTreeMap;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, Utc};
use futures_util::StreamExt;
use jsonwebtoken::errors::ErrorKind;
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
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
const CALLBACK_READ_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_CALLBACK_BYTES: usize = 8192;
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
    "FABLE_CLERK_ISSUER",
    "FABLE_CLERK_OAUTH_CLIENT_ID",
    "FABLE_CLERK_AUDIENCE",
    "FABLE_CLERK_AUTHORIZED_PARTY",
    "FABLE_CLERK_SCOPES",
    "FABLE_CLERK_REQUEST_ORG",
    "FABLE_CLERK_REQUIRE_ORG",
    "FABLE_CLERK_ALLOWED_ORG_IDS",
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

trait IdentitySecretStore: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<String>, String>;
    fn set(&self, key: &str, secret: &str) -> Result<(), String>;
    fn remove(&self, key: &str) -> Result<(), String>;
}

struct NativeIdentitySecretStore;

#[derive(Clone, Debug, Serialize, Deserialize)]
struct KeyringChunkManifest {
    generation: String,
    chunks: usize,
    digest: String,
}

fn split_keyring_secret(secret: &str) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut current_units = 0;
    for character in secret.chars() {
        let units = character.len_utf16();
        if current_units > 0 && current_units + units > KEYRING_CHUNK_UTF16_UNITS {
            chunks.push(std::mem::take(&mut current));
            current_units = 0;
        }
        current.push(character);
        current_units += units;
    }
    if !current.is_empty() || secret.is_empty() {
        chunks.push(current);
    }
    chunks
}

fn keyring_manifest(value: &str) -> Option<KeyringChunkManifest> {
    let encoded = value.strip_prefix(KEYRING_CHUNK_MANIFEST_PREFIX)?;
    let manifest = serde_json::from_str::<KeyringChunkManifest>(encoded).ok()?;
    let generation_valid = !manifest.generation.is_empty()
        && manifest.generation.len() <= 64
        && manifest
            .generation
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
    (generation_valid && (1..=KEYRING_MAX_CHUNKS).contains(&manifest.chunks)).then_some(manifest)
}

impl NativeIdentitySecretStore {
    fn entry(key: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(KEYRING_SERVICE, key)
            .map_err(|_| "Mivlet could not open the OS secure store.".to_string())
    }

    fn chunk_key(key: &str, generation: &str, index: usize) -> String {
        format!("{key}:chunk:{generation}:{index}")
    }

    fn read_entry(key: &str) -> Result<Option<String>, String> {
        match Self::entry(key)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("Mivlet could not read cloud identity credentials.".to_string()),
        }
    }

    fn write_entry(key: &str, secret: &str) -> Result<(), String> {
        Self::entry(key)?
            .set_password(secret)
            .map_err(|_| "Mivlet could not store cloud identity credentials.".to_string())
    }

    fn remove_entry(key: &str) -> Result<(), String> {
        match Self::entry(key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("Mivlet could not remove cloud identity credentials.".to_string()),
        }
    }

    fn remove_manifest_chunks(key: &str, manifest: &KeyringChunkManifest) -> Result<(), String> {
        for index in 0..manifest.chunks {
            Self::remove_entry(&Self::chunk_key(key, &manifest.generation, index))?;
        }
        Ok(())
    }
}

impl IdentitySecretStore for NativeIdentitySecretStore {
    fn get(&self, key: &str) -> Result<Option<String>, String> {
        let Some(value) = Self::read_entry(key)? else {
            return Ok(None);
        };
        let Some(manifest) = keyring_manifest(&value) else {
            return Ok(Some(value));
        };
        let mut secret = String::new();
        for index in 0..manifest.chunks {
            let chunk = Self::read_entry(&Self::chunk_key(key, &manifest.generation, index))?
                .ok_or_else(|| "Mivlet cloud identity credentials were incomplete.".to_string())?;
            secret.push_str(&chunk);
        }
        let digest = URL_SAFE_NO_PAD.encode(Sha256::digest(secret.as_bytes()));
        if digest != manifest.digest {
            return Err("Mivlet cloud identity credentials failed integrity checking.".to_string());
        }
        Ok(Some(secret))
    }

    fn set(&self, key: &str, secret: &str) -> Result<(), String> {
        let previous_manifest = Self::read_entry(key)?.as_deref().and_then(keyring_manifest);
        let chunks = split_keyring_secret(secret);
        if chunks.len() == 1 {
            Self::write_entry(key, &chunks[0])?;
        } else {
            if chunks.len() > KEYRING_MAX_CHUNKS {
                return Err(
                    "Mivlet cloud identity credentials were unexpectedly large.".to_string()
                );
            }
            let generation = random_urlsafe(12).map_err(|error| error.message)?;
            let manifest = KeyringChunkManifest {
                generation: generation.clone(),
                chunks: chunks.len(),
                digest: URL_SAFE_NO_PAD.encode(Sha256::digest(secret.as_bytes())),
            };
            for (index, chunk) in chunks.iter().enumerate() {
                if let Err(error) =
                    Self::write_entry(&Self::chunk_key(key, &generation, index), chunk)
                {
                    for cleanup_index in 0..index {
                        let _ =
                            Self::remove_entry(&Self::chunk_key(key, &generation, cleanup_index));
                    }
                    return Err(error);
                }
            }
            let encoded = serde_json::to_string(&manifest)
                .map_err(|_| "Mivlet could not encode cloud identity storage.".to_string())?;
            if let Err(error) =
                Self::write_entry(key, &format!("{KEYRING_CHUNK_MANIFEST_PREFIX}{encoded}"))
            {
                let _ = Self::remove_manifest_chunks(key, &manifest);
                return Err(error);
            }
        }
        if let Some(previous) = previous_manifest {
            let _ = Self::remove_manifest_chunks(key, &previous);
        }
        Ok(())
    }

    fn remove(&self, key: &str) -> Result<(), String> {
        let manifest = Self::read_entry(key)?.as_deref().and_then(keyring_manifest);
        if let Some(manifest) = manifest {
            Self::remove_manifest_chunks(key, &manifest)?;
        }
        Self::remove_entry(key)
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

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ConvexFunctionType {
    Query,
    Mutation,
    Action,
}

#[allow(dead_code)] // Reserved for the focused native hosted-account adapter.
impl ConvexFunctionType {
    fn endpoint(self) -> &'static str {
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
struct ConvexFunctionBody<'a> {
    path: &'a str,
    args: &'a Value,
    format: &'static str,
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
    #[serde(default)]
    aud: Option<AudienceClaim>,
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
    pub(crate) enabled: bool,
    pub(crate) state: String,
    pub(crate) message: String,
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
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct StoredSession {
    access_token: String,
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
            "Mivlet could not initialize a secure identity transaction.",
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

fn split_env_list(value: Option<String>) -> Vec<String> {
    value
        .unwrap_or_default()
        .split([',', ' '])
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string)
        .collect()
}

fn load_config_from(
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
        "FABLE_CLERK_REQUEST_ORG",
        "FABLE_CLERK_REQUIRE_ORG",
        "FABLE_CLERK_ALLOWED_ORG_IDS",
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
        .get("FABLE_CLERK_ISSUER")
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
        .get("FABLE_CLERK_OAUTH_CLIENT_ID")
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
        .get("FABLE_CLERK_AUDIENCE")
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
            .get("FABLE_CLERK_SCOPES")
            .and_then(|value| value.clone()),
    );
    if scopes.is_empty() {
        scopes = vec!["openid".into(), "profile".into(), "email".into()];
    }
    for required in ["openid", "profile", "email"] {
        if !scopes.iter().any(|scope| scope == required) {
            scopes.push(required.to_string());
        }
    }
    let authorized_party = values
        .get("FABLE_CLERK_AUTHORIZED_PARTY")
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

fn load_config() -> Result<Option<ClerkIdentityConfig>, IdentityError> {
    load_config_with_packaged(
        !cfg!(debug_assertions),
        |key| std::env::var(key).ok(),
        |key| {
            // Public OAuth client settings only. Never embed credentials or tokens.
            match key {
                "FABLE_CLERK_ISSUER" => option_env!("FABLE_CLERK_ISSUER"),
                "FABLE_CLERK_OAUTH_CLIENT_ID" => option_env!("FABLE_CLERK_OAUTH_CLIENT_ID"),
                "FABLE_CLERK_AUDIENCE" => option_env!("FABLE_CLERK_AUDIENCE"),
                "FABLE_CLERK_AUTHORIZED_PARTY" => option_env!("FABLE_CLERK_AUTHORIZED_PARTY"),
                "FABLE_CLERK_SCOPES" => option_env!("FABLE_CLERK_SCOPES"),
                _ => None,
            }
            .map(str::to_owned)
        },
    )
}

fn load_config_with_packaged(
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

fn load_convex_url_from(raw: Option<String>) -> Result<Url, IdentityError> {
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

fn load_convex_site_url_from(raw: Option<String>) -> Result<Url, IdentityError> {
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

fn load_convex_site_url() -> Result<Url, IdentityError> {
    load_convex_site_url_from(std::env::var("FABLE_CONVEX_URL").ok())
}

fn validate_convex_http_path(path: &str) -> Result<(), IdentityError> {
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
fn load_convex_url() -> Result<Url, IdentityError> {
    load_convex_url_from(std::env::var("FABLE_CONVEX_URL").ok())
}

fn disabled_status() -> IdentityStatus {
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

fn signed_out_status(config: &ClerkIdentityConfig) -> IdentityStatus {
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
            "Stored Mivlet cloud identity is invalid; sign in again.",
            false,
        )
    })
}

fn write_session(
    store: &dyn IdentitySecretStore,
    session: &StoredSession,
    expected_generation: Option<u64>,
) -> Result<(), IdentityError> {
    let encoded = serde_json::to_string(session).map_err(|_| {
        identity_error(
            "unknown",
            "Mivlet could not encode cloud identity credentials.",
            false,
        )
    })?;
    let mut generation = IDENTITY_GENERATION
        .lock()
        .map_err(|_| identity_error("unknown", "Mivlet account state is unavailable.", false))?;
    if expected_generation.is_some_and(|expected| expected != *generation) {
        return Err(identity_error(
            "expired",
            "This account operation was superseded. Sign in again.",
            false,
        ));
    }
    store
        .set(SESSION_KEY, &encoded)
        .map_err(|message| identity_error("unknown", message, false))?;
    *generation = generation.wrapping_add(1);
    Ok(())
}

fn clear_session(store: &dyn IdentitySecretStore) -> Result<(), IdentityError> {
    clear_session_if_current(store, None)
}

fn clear_session_if_current(
    store: &dyn IdentitySecretStore,
    expected: Option<u64>,
) -> Result<(), IdentityError> {
    let mut generation = IDENTITY_GENERATION
        .lock()
        .map_err(|_| identity_error("unknown", "Mivlet account state is unavailable.", false))?;
    if expected.is_some_and(|expected| expected != *generation) {
        return Err(identity_error(
            "expired",
            "This account operation was superseded.",
            false,
        ));
    }
    store
        .remove(SESSION_KEY)
        .map_err(|message| identity_error("unknown", message, false))?;
    *generation = generation.wrapping_add(1);
    Ok(())
}

fn sign_out_with_store(
    store: &dyn IdentitySecretStore,
    load: impl FnOnce() -> Result<Option<ClerkIdentityConfig>, IdentityError>,
) -> Result<IdentityStatus, IdentityError> {
    clear_session(store)?;
    let config = load()?;
    Ok(match config {
        Some(config) => signed_out_status(&config),
        None => disabled_status(),
    })
}

fn session_matches_config(session: &StoredSession, config: &ClerkIdentityConfig) -> bool {
    session.issuer.trim_end_matches('/') == config.issuer.trim_end_matches('/')
        && session.client_id == config.client_id
        && session.audience == config.audience
        && session.authorized_party == config.authorized_party
}

fn validate_url(endpoint: &str, label: &str) -> Result<(), IdentityError> {
    let url = Url::parse(endpoint).map_err(|_| {
        identity_error(
            "configuration-required",
            format!("Clerk {label} endpoint is invalid."),
            false,
        )
    })?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(identity_error(
            "configuration-required",
            format!(
                "Clerk {label} endpoint must be HTTPS and must not contain credentials or a fragment."
            ),
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
                "Mivlet could not initialize Clerk discovery.",
                false,
            )
        })?
        .get(url)
        .send()
        .await
        .map_err(|_| {
            identity_error(
                "offline",
                "Mivlet could not reach Clerk identity metadata.",
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
                "Mivlet could not initialize Clerk JWKS fetch.",
                false,
            )
        })?
        .get(jwks_uri)
        .send()
        .await
        .map_err(|_| {
            identity_error(
                "offline",
                "Mivlet could not reach Clerk signing keys.",
                true,
            )
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

#[cfg(test)]
fn validate_claims(
    claims: &TokenClaims,
    config: &ClerkIdentityConfig,
    now: u64,
) -> Result<(), IdentityError> {
    validate_claims_for_use(claims, config, now, true)
}

fn validate_claims_for_use(
    claims: &TokenClaims,
    config: &ClerkIdentityConfig,
    now: u64,
    audience_required: bool,
) -> Result<(), IdentityError> {
    if claims.sub.trim().is_empty() {
        return Err(identity_error(
            "invalid-token",
            "Clerk token subject was missing.",
            false,
        ));
    }
    if claims.iss.trim_end_matches('/') != config.issuer.trim_end_matches('/') {
        return Err(identity_error(
            "invalid-token",
            "Clerk token issuer did not match configuration.",
            false,
        ));
    }
    match &claims.aud {
        Some(audience) if audience.contains(&config.audience) => {}
        Some(_) => {
            return Err(identity_error(
                "invalid-token",
                "Clerk token audience did not match configuration.",
                false,
            ));
        }
        None if audience_required => {
            return Err(identity_error(
                "invalid-token",
                "Clerk identity token audience was missing.",
                false,
            ));
        }
        None => {}
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
            "expired",
            "Mivlet cloud identity expired; sign in again.",
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
    let header_kid = header_kid.ok_or_else(|| {
        identity_error(
            "invalid-token",
            "Clerk token did not identify a signing key.",
            false,
        )
    })?;
    let key = jwks
        .keys
        .iter()
        .find(|key| {
            key.kty == "RSA"
                && key.alg.as_deref().unwrap_or("RS256") == "RS256"
                && key.kid.as_deref() == Some(header_kid)
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

fn token_claim_shape_error(claims: &Value, audience_required: bool) -> Option<String> {
    let object = claims.as_object()?;
    for field in ["iss", "sub"] {
        match object.get(field) {
            Some(value) if value.is_string() => {}
            Some(_) => return Some(format!("the `{field}` claim was not a string")),
            None => return Some(format!("the required `{field}` claim was missing")),
        }
    }
    match object.get("aud") {
        Some(Value::String(_)) => {}
        Some(Value::Array(values)) if values.iter().all(Value::is_string) => {}
        Some(_) => return Some("the `aud` claim was not a string or string array".to_string()),
        None if audience_required => {
            return Some("the required `aud` claim was missing".to_string());
        }
        None => {}
    }
    match object.get("exp") {
        Some(value) if value.as_u64().is_some() => {}
        Some(_) => return Some("the `exp` claim was not an unsigned timestamp".to_string()),
        None => return Some("the required `exp` claim was missing".to_string()),
    }
    for field in ["nbf", "iat"] {
        if object
            .get(field)
            .is_some_and(|value| !value.is_null() && value.as_u64().is_none())
        {
            return Some(format!("the `{field}` claim was not an unsigned timestamp"));
        }
    }
    for field in ["azp", "sid", "jti", "email", "name"] {
        if object
            .get(field)
            .is_some_and(|value| !value.is_null() && !value.is_string())
        {
            return Some(format!("the `{field}` claim was not a string"));
        }
    }
    if object
        .get("email_verified")
        .is_some_and(|value| !value.is_null() && !value.is_boolean())
    {
        return Some("the `email_verified` claim was not a boolean".to_string());
    }
    None
}

fn validate_jwt_with_jwks(
    token: &str,
    config: &ClerkIdentityConfig,
    jwks: &Jwks,
    audience_required: bool,
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
    let data = decode::<Value>(token, &key, &validation).map_err(|error| {
        let reason = match error.kind() {
            ErrorKind::InvalidSignature => "signature did not match Clerk's signing key",
            ErrorKind::Json(_) | ErrorKind::MissingRequiredClaim(_) => "claims were not valid JSON",
            ErrorKind::Base64(_) | ErrorKind::Utf8(_) | ErrorKind::InvalidToken => {
                "encoding was not a valid JWT"
            }
            _ => "cryptographic validation failed",
        };
        identity_error(
            "invalid-token",
            format!("Clerk token validation failed because its {reason}."),
            false,
        )
    })?;
    if !data.claims.is_object() {
        return Err(identity_error(
            "invalid-token",
            "Clerk token claims were not a JSON object.",
            false,
        ));
    }
    if let Some(reason) = token_claim_shape_error(&data.claims, audience_required) {
        return Err(identity_error(
            "invalid-token",
            format!("Clerk token claims were invalid because {reason}."),
            false,
        ));
    }
    let claims = serde_json::from_value::<TokenClaims>(data.claims).map_err(|_| {
        identity_error(
            "invalid-token",
            "Clerk token claims used unsupported field types.",
            false,
        )
    })?;
    validate_claims_for_use(&claims, config, now_epoch(), audience_required)?;
    Ok(claims)
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
            "Mivlet could not open the system browser for cloud sign-in.",
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
                "Mivlet could not bind a loopback identity listener.",
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
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>Mivlet</title>\
         <style>body{{font-family:system-ui;padding:2rem;max-width:32rem;margin:auto}}</style>\
         </head><body><h1>{status}</h1><p>{message}</p>\
         <p>You can close this tab and return to Mivlet.</p></body></html>"
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
                "Mivlet could not reach Clerk to finish sign-in.",
                true,
            )
        })?;
    if !response.status().is_success() {
        return Err(exchange_rejection(response.status()));
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
                "Mivlet could not reach Clerk to refresh cloud identity.",
                true,
            )
        })?;
    if !response.status().is_success() {
        return Err(refresh_rejection(response.status()));
    }
    response.json().await.map_err(|_| {
        identity_error(
            "invalid-token",
            "Clerk refresh response was invalid.",
            false,
        )
    })
}

fn exchange_rejection(status: reqwest::StatusCode) -> IdentityError {
    identity_error(
        "invalid-token",
        format!(
            "Clerk rejected the identity exchange (HTTP {}); start sign-in again.",
            status.as_u16()
        ),
        status.is_server_error() || status == reqwest::StatusCode::TOO_MANY_REQUESTS,
    )
}

fn refresh_rejection(status: reqwest::StatusCode) -> IdentityError {
    if matches!(
        status,
        reqwest::StatusCode::BAD_REQUEST
            | reqwest::StatusCode::UNAUTHORIZED
            | reqwest::StatusCode::FORBIDDEN
    ) {
        return identity_error(
            "revoked",
            "Mivlet account session was revoked; sign in again.",
            false,
        );
    }
    identity_error(
        "provider-error",
        format!(
            "Clerk could not refresh the Mivlet account session (HTTP {}).",
            status.as_u16()
        ),
        status.is_server_error() || status == reqwest::StatusCode::TOO_MANY_REQUESTS,
    )
}

async fn session_from_tokens(
    config: ClerkIdentityConfig,
    metadata: &AuthorizationServerMetadata,
    current: Option<StoredSession>,
    tokens: TokenResponse,
) -> Result<StoredSession, IdentityError> {
    if !tokens
        .token_type
        .as_deref()
        .unwrap_or("Bearer")
        .eq_ignore_ascii_case("bearer")
    {
        return Err(identity_error(
            "invalid-token",
            "Clerk returned an unsupported token type.",
            false,
        ));
    }
    let jwks = fetch_jwks(&metadata.jwks_uri).await?;
    let oauth_access_claims = validate_jwt_with_jwks(&tokens.access_token, &config, &jwks, false)
        .map_err(|error| {
        identity_error(
            error.code,
            format!("Clerk access token was rejected: {}", error.message),
            error.retryable,
        )
    })?;
    let id_token = tokens.id_token.ok_or_else(|| {
        identity_error(
            "invalid-token",
            "Clerk did not return the required OpenID identity token.",
            false,
        )
    })?;
    let id_claims = validate_jwt_with_jwks(&id_token, &config, &jwks, true).map_err(|error| {
        identity_error(
            error.code,
            format!("Clerk ID token was rejected: {}", error.message),
            error.retryable,
        )
    })?;
    if id_claims.sub != oauth_access_claims.sub {
        return Err(identity_error(
            "invalid-token",
            "Clerk access and identity tokens named different subjects.",
            false,
        ));
    }
    if let Some(previous_subject) = current.as_ref().and_then(|session| {
        session
            .authentication
            .as_ref()
            .map(|authentication| authentication.subject.as_str())
            .or_else(|| {
                session
                    .legacy_identity
                    .as_ref()
                    .map(|identity| identity.user_id.as_str())
            })
    }) {
        if previous_subject != id_claims.sub {
            return Err(identity_error(
                "invalid-token",
                "Clerk refresh changed the authenticated subject; recover the account session.",
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
        .unwrap_or(id_claims.exp)
        .min(id_claims.exp);
    let mut authentication =
        authentication_from_claims(&id_claims, &config.issuer, &id_token, expires_at);
    if let Some(userinfo_endpoint) = &metadata.userinfo_endpoint {
        if let Some(userinfo) = fetch_userinfo(userinfo_endpoint, &tokens.access_token).await {
            merge_userinfo(&mut authentication, userinfo);
        }
    }
    Ok(StoredSession {
        access_token: id_token.clone(),
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
    let expected_generation = *IDENTITY_GENERATION
        .lock()
        .map_err(|_| identity_error("unknown", "Account state unavailable.", false))?;
    let Some(config) = load_config()? else {
        return Ok(disabled_status());
    };
    let session = match read_session(store) {
        Ok(session) => session,
        Err(error) if error.code == "revoked" => {
            clear_session_if_current(store, Some(expected_generation))?;
            return Ok(status_from_error(&config, &error));
        }
        Err(error) => return Err(error),
    };
    let Some(mut session) = session else {
        return Ok(signed_out_status(&config));
    };
    if !session_matches_config(&session, &config) {
        clear_session_if_current(store, Some(expected_generation))?;
        return Ok(status_from_error(
            &config,
            &identity_error(
                "configuration-required",
                "Stored Mivlet identity does not match the active Clerk configuration; sign in again.",
                false,
            ),
        ));
    }
    let metadata = match discover_metadata(&config).await {
        Ok(metadata) => metadata,
        Err(error) if error.code == "offline" => {
            return Ok(session_status(
                "offline",
                "Mivlet could not refresh the account session while offline.",
                &session,
            ));
        }
        Err(error) => return Err(error),
    };
    if session.expires_at > now_epoch().saturating_add(60) {
        let jwks = match fetch_jwks(&metadata.jwks_uri).await {
            Ok(jwks) => jwks,
            Err(error) if error.code == "offline" => {
                return Ok(session_status(
                    "offline",
                    "Mivlet could not verify the account session while offline.",
                    &session,
                ));
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
        match validate_jwt_with_jwks(&session.access_token, &active_config, &jwks, true) {
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
                    write_session(store, &session, Some(expected_generation))?;
                }
                return Ok(session_status(
                    "signed-in",
                    "Mivlet cloud identity is connected.",
                    &session,
                ));
            }
            Err(error) if error.code == "expired" => {}
            Err(error) if error.code == "invalid-token" => {
                clear_session_if_current(store, Some(expected_generation))?;
                return Ok(status_from_error(&config, &error));
            }
            Err(error) => return Err(error),
        }
    }
    let Some(refresh_token) = session.refresh_token.clone() else {
        clear_session_if_current(store, Some(expected_generation))?;
        return Ok(status_from_error(
            &config,
            &identity_error(
                "expired",
                "Mivlet cloud identity expired; sign in again.",
                false,
            ),
        ));
    };
    let tokens = match refresh_tokens(&config, &metadata.token_endpoint, &refresh_token).await {
        Ok(tokens) => tokens,
        Err(error) if error.code == "offline" => {
            return Ok(session_status(
                "offline",
                "Mivlet could not refresh the account session while offline.",
                &session,
            ));
        }
        Err(error) if error.code == "revoked" => {
            clear_session_if_current(store, Some(expected_generation))?;
            return Ok(status_from_error(&config, &error));
        }
        Err(error) => return Err(error),
    };
    let refreshed =
        match session_from_tokens(config.clone(), &metadata, Some(session), tokens).await {
            Ok(session) => session,
            Err(error) if error.code == "invalid-token" || error.code == "expired" => {
                clear_session_if_current(store, Some(expected_generation))?;
                return Ok(status_from_error(&config, &error));
            }
            Err(error) => return Err(error),
        };
    write_session(store, &refreshed, Some(expected_generation))?;
    Ok(session_status(
        "signed-in",
        "Mivlet cloud identity refreshed.",
        &refreshed,
    ))
}

async fn begin_sign_in_with_store(
    store: &dyn IdentitySecretStore,
    prompt: &str,
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
        .append_pair("code_challenge_method", "S256")
        .append_pair("prompt", prompt);

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
                "Mivlet could not accept the identity callback.",
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
                callback_page(page_status, "Finishing in Mivlet.")
            )
            .as_bytes(),
        )
        .await;
    let _ = stream.shutdown().await;

    complete_callback_with_store(store, &callback_url, Some(expected_generation)).await
}

async fn complete_callback_with_store(
    store: &dyn IdentitySecretStore,
    callback_url: &str,
    expected_generation: Option<u64>,
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
    write_session(store, &session, expected_generation)?;
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
    status_with_store(&NativeIdentitySecretStore)
        .await
        .map_err(command_message)
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
    Ok(NativeIdentityGenerationSnapshot {
        account_binding: account_binding_for_authentication(&authentication),
        generation: *generation,
    })
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
    let session = read_session(&NativeIdentitySecretStore).map_err(command_message)?;
    let current_binding = session
        .and_then(|session| session.authentication)
        .map(|authentication| account_binding_for_authentication(&authentication));
    if current_binding.as_deref() != Some(expected.account_binding.as_str()) {
        return Err("Mivlet account changed during the request. Please try again.".into());
    }
    Ok(NativeIdentityGenerationGuard { _guard: guard })
}

#[tauri::command]
pub async fn identity_begin_sign_in(app: tauri::AppHandle) -> Result<IdentityStatus, String> {
    if crate::account_session::binding().is_ok() {
        return identity_sign_out(app).await;
    }
    let result = begin_sign_in_with_store(&NativeIdentitySecretStore, "consent")
        .await
        .map_err(command_message)?;
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
    identity_begin_sign_in(app).await
}

#[tauri::command]
pub async fn identity_refresh(_app: tauri::AppHandle) -> Result<IdentityStatus, String> {
    status_with_store(&NativeIdentitySecretStore)
        .await
        .map_err(command_message)
}

#[tauri::command]
pub async fn identity_sign_out(app: tauri::AppHandle) -> Result<IdentityStatus, String> {
    // Configuration may have become invalid since sign-in. Local credential
    // removal must still happen before reporting that diagnostic.
    let status =
        sign_out_with_store(&NativeIdentitySecretStore, load_config).map_err(command_message)?;
    crate::account_session::restart(app).await;
    Ok(status)
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
            audience: "fable-desktop".to_string(),
            authorized_party: Some("client_123".to_string()),
            scopes: vec!["openid".into(), "profile".into(), "email".into()],
        }
    }

    fn test_claims() -> TokenClaims {
        TokenClaims {
            iss: "https://issuer.example".to_string(),
            sub: "user_123".to_string(),
            aud: Some(AudienceClaim::One("fable-desktop".to_string())),
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
            ("FABLE_CLERK_ISSUER", "https://issuer.example"),
            ("FABLE_CLERK_OAUTH_CLIENT_ID", "client_123"),
            ("FABLE_CLERK_AUDIENCE", "fable-desktop"),
        ]);
        let config = load_config_with_packaged(true, |_| None, |key| packaged.get(key).cloned())
            .unwrap()
            .unwrap();
        assert_eq!(config.audience, "fable-desktop");
        let error = load_config_with_packaged(
            true,
            |key| (key == "FABLE_CLERK_ISSUER").then(|| "https://override.example".to_string()),
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
            ("FABLE_CLERK_ISSUER", "https://issuer.example"),
            ("FABLE_CLERK_OAUTH_CLIENT_ID", "client_123"),
        ]);
        let error = load_config_from(true, |key| incomplete.get(key).cloned()).unwrap_err();
        assert_eq!(error.code, "configuration-required");
        assert_eq!(
            error.message,
            "Clerk audience must be explicit in production."
        );

        let complete = config_values(&[
            ("FABLE_CLERK_ISSUER", "https://issuer.example"),
            ("FABLE_CLERK_OAUTH_CLIENT_ID", "client_123"),
            ("FABLE_CLERK_AUDIENCE", "fable-desktop"),
        ]);
        let config = load_config_from(true, |key| complete.get(key).cloned())
            .unwrap()
            .unwrap();
        assert_eq!(config.audience, "fable-desktop");
        assert_eq!(config.authorized_party, None);
    }

    #[test]
    fn partial_or_obsolete_clerk_configuration_fails_closed() {
        let partial = config_values(&[("FABLE_CLERK_AUDIENCE", "fable-desktop")]);
        assert_eq!(
            load_config_from(false, |key| partial.get(key).cloned())
                .unwrap_err()
                .message,
            "Clerk issuer is required to enable Mivlet cloud identity."
        );

        let obsolete = config_values(&[
            ("FABLE_CLERK_ISSUER", "https://issuer.example"),
            ("FABLE_CLERK_OAUTH_CLIENT_ID", "client_123"),
            ("FABLE_CLERK_REQUIRE_ORG", "true"),
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
