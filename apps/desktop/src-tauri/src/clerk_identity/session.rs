//! Session persistence, token validation and OAuth transport for Clerk.

use super::*;

pub(super) fn read_session(
    store: &dyn IdentitySecretStore,
) -> Result<Option<StoredSession>, IdentityError> {
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

pub(super) fn write_session(
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

pub(super) fn clear_session(store: &dyn IdentitySecretStore) -> Result<(), IdentityError> {
    clear_session_if_current(store, None)
}

pub(super) fn clear_session_if_current(
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

pub(super) fn sign_out_with_store(
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

pub(super) fn session_matches_config(
    session: &StoredSession,
    config: &ClerkIdentityConfig,
) -> bool {
    session.issuer.trim_end_matches('/') == config.issuer.trim_end_matches('/')
        && session.client_id == config.client_id
        && session.audience == config.audience
        && session.authorized_party == config.authorized_party
}

pub(super) fn validate_url(endpoint: &str, label: &str) -> Result<(), IdentityError> {
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

pub(super) async fn discover_metadata(
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

pub(super) async fn fetch_jwks(jwks_uri: &str) -> Result<Jwks, IdentityError> {
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
pub(super) fn validate_claims(
    claims: &TokenClaims,
    config: &ClerkIdentityConfig,
    now: u64,
) -> Result<(), IdentityError> {
    validate_claims_for_use(claims, config, now, true)
}

pub(super) fn validate_claims_for_use(
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

pub(super) fn decoding_key_for(
    header_kid: Option<&str>,
    jwks: &Jwks,
) -> Result<DecodingKey, IdentityError> {
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

pub(super) fn token_claim_shape_error(claims: &Value, audience_required: bool) -> Option<String> {
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

pub(super) fn validate_jwt_with_jwks(
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

pub(super) fn opaque_reference(kind: &str, value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    format!("{kind}:{}", URL_SAFE_NO_PAD.encode(digest))
}

pub(super) fn normalized_value_hash(value: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(value.trim().to_lowercase().as_bytes()))
}

pub(super) fn authentication_from_claims(
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

pub(super) fn merge_userinfo(
    authentication: &mut AccountAuthenticationFacts,
    userinfo: UserInfoResponse,
) {
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

pub(super) async fn fetch_userinfo(endpoint: &str, access_token: &str) -> Option<UserInfoResponse> {
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

pub(super) fn open_browser(authorization_url: &str) -> Result<(), IdentityError> {
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

pub(super) fn bound_redirect(listener: &TcpListener) -> Result<String, IdentityError> {
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

pub(super) async fn exchange_code(
    pending: &PendingClerkOAuth,
    code: &str,
) -> Result<TokenResponse, IdentityError> {
    crate::ensure_rustls_provider();
    let response = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| identity_error("unknown", "Could not prepare account connection.", true))?
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

pub(super) async fn refresh_tokens(
    config: &ClerkIdentityConfig,
    token_endpoint: &str,
    refresh_token: &str,
) -> Result<TokenResponse, IdentityError> {
    crate::ensure_rustls_provider();
    let response = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| identity_error("unknown", "Could not prepare account connection.", true))?
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

pub(super) fn exchange_rejection(status: reqwest::StatusCode) -> IdentityError {
    identity_error(
        "invalid-token",
        format!(
            "Clerk rejected the identity exchange (HTTP {}); start sign-in again.",
            status.as_u16()
        ),
        status.is_server_error() || status == reqwest::StatusCode::TOO_MANY_REQUESTS,
    )
}

pub(super) fn refresh_rejection(status: reqwest::StatusCode) -> IdentityError {
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

pub(super) async fn session_from_tokens(
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

pub(super) async fn status_with_store(
    store: &dyn IdentitySecretStore,
) -> Result<IdentityStatus, IdentityError> {
    static REFRESH: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _refresh = REFRESH.lock().await;
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
