use super::*;

mod dispatch_tests {
    use super::*;
    #[test]
    fn identity_dispatch_never_waits_or_runs_after_change_or_expiry() {
        let generation = Mutex::new(7);
        let called = std::cell::Cell::new(0);
        let operation = || {
            called.set(called.get() + 1);
            Ok(())
        };
        assert!(try_identity_dispatch(&generation, 6, now_epoch() + 60, operation).is_err());
        assert!(
            try_identity_dispatch(&generation, 7, now_epoch().saturating_sub(1), operation)
                .is_err()
        );
        let guard = generation.lock().unwrap();
        assert!(try_identity_dispatch(&generation, 7, now_epoch() + 60, operation).is_err());
        assert_eq!(called.get(), 0);
        drop(guard);
        assert!(try_identity_dispatch(&generation, 7, now_epoch() + 60, operation).is_ok());
        assert_eq!(called.get(), 1);
    }

    #[test]
    fn generation_guard_can_be_held_without_releasing_the_fence() {
        let held = IDENTITY_GENERATION.lock().unwrap();
        let _guard = NativeIdentityGenerationGuard { _guard: held };
        assert!(IDENTITY_GENERATION.try_lock().is_err());
    }

    #[test]
    fn identity_poll_treats_busy_as_retryable_then_accepts_current_generation() {
        let generation = Mutex::new(7);
        let held = generation.lock().unwrap();
        assert_eq!(
            poll_identity_dispatch(&generation, 7, now_epoch() + 60),
            Ok(false)
        );
        drop(held);
        assert_eq!(
            poll_identity_dispatch(&generation, 7, now_epoch() + 60),
            Ok(true)
        );
    }

    #[test]
    fn identity_poll_rechecks_changed_generation_after_busy() {
        let generation = Mutex::new(7);
        let held = generation.lock().unwrap();
        assert_eq!(
            poll_identity_dispatch(&generation, 7, now_epoch() + 60),
            Ok(false)
        );
        drop(held);
        *generation.lock().unwrap() = 8;
        assert!(poll_identity_dispatch(&generation, 7, now_epoch() + 60).is_err());
    }

    #[test]
    fn identity_poll_rejects_expiry_even_while_generation_is_busy() {
        let generation = Mutex::new(7);
        let held = generation.lock().unwrap();
        assert!(poll_identity_dispatch(&generation, 7, now_epoch().saturating_sub(1)).is_err());
        drop(held);
    }

    #[test]
    fn identity_poll_rejects_a_poisoned_generation_mutex() {
        use std::sync::Arc;
        let generation = Arc::new(Mutex::new(7));
        let poisoned = Arc::clone(&generation);
        let _ = std::thread::spawn(move || {
            let _guard = poisoned.lock().unwrap();
            panic!("poison identity generation for the focused poll test");
        })
        .join();
        assert!(poll_identity_dispatch(&generation, 7, now_epoch() + 60).is_err());
    }

    #[test]
    fn generation_change_waits_until_fenced_commit_finishes() {
        use std::sync::{atomic::AtomicBool, atomic::Ordering, Arc, Barrier};
        use std::thread;
        use tempfile::tempdir;

        let held = IDENTITY_GENERATION.lock().unwrap();
        let before = *held;
        let guard = NativeIdentityGenerationGuard { _guard: held };
        let started = Arc::new(AtomicBool::new(false));
        let changed = Arc::new(AtomicBool::new(false));
        let committed = Arc::new(AtomicBool::new(false));
        let barrier = Arc::new(Barrier::new(2));
        let writer_started = Arc::clone(&started);
        let writer_changed = Arc::clone(&changed);
        let writer_barrier = Arc::clone(&barrier);
        let directory = tempdir().unwrap();
        let permit_path = directory.path().join("execution-approvals.json");
        let writer = thread::spawn(move || {
            writer_barrier.wait();
            writer_started.store(true, Ordering::Release);
            let mut generation = IDENTITY_GENERATION.lock().unwrap();
            *generation = before.wrapping_add(1);
            writer_changed.store(true, Ordering::Release);
        });

        barrier.wait();
        for _ in 0..1_000 {
            if started.load(Ordering::Acquire) {
                break;
            }
            thread::yield_now();
        }
        assert!(!changed.load(Ordering::Acquire));

        let request = crate::models::ApprovalRequest {
            id: "fenced-approval".into(),
            service: "test".into(),
            action: "write".into(),
            mode: "standard".into(),
            risk_level: "low".into(),
            data_used: vec!["path".into()],
            consequence: "A bounded test write.".into(),
            requested_at: "2026-10-08T12:00:00Z".into(),
            decisions: vec!["once".into()],
            confirmation_phrase: None,
        };
        let response = crate::models::ApprovalResolutionResponse {
            persisted: true,
            audit_entry: crate::models::ApprovalAuditEntry {
                id: "fenced-audit".into(),
                request_id: request.id.clone(),
                decision: "once".into(),
                decided_at: "2026-10-08T12:00:01Z".into(),
                note: "fenced".into(),
            },
            effective_request: request,
            dismissed: true,
            grant: None,
        };
        crate::execution_approvals::record_execution_decision(&permit_path, &response).unwrap();
        committed.store(true, Ordering::Release);
        drop(guard);
        writer.join().unwrap();
        assert!(committed.load(Ordering::Acquire));
        assert!(changed.load(Ordering::Acquire));
        assert!(std::fs::read_to_string(permit_path)
            .unwrap()
            .contains("fenced-approval"));

        *IDENTITY_GENERATION.lock().unwrap() = before;
    }
}

#[test]
fn account_entry_preserves_mode_without_repeating_authentication() {
    let authorize = url::Url::parse(
        "https://clerk.example/oauth/authorize?state=fixture&code_challenge=fixture",
    )
    .unwrap();
    let login = super::account_entry_url(
        authorize.clone(),
        super::AccountEntryMode::SignIn,
        None,
        true,
    )
    .unwrap();
    assert_eq!(
        login
            .query_pairs()
            .find(|(key, _)| key == "prompt")
            .unwrap()
            .1,
        "consent"
    );
    assert!(super::account_entry_url(
        authorize.clone(),
        super::AccountEntryMode::SignUp,
        None,
        true
    )
    .is_err());
    for (mode, expected) in [
        (super::AccountEntryMode::SignIn, "sign-in"),
        (super::AccountEntryMode::SignUp, "sign-up"),
    ] {
        let entry = super::account_entry_url(
            authorize.clone(),
            mode,
            Some("https://accounts.example/desktop/start"),
            true,
        )
        .unwrap();
        let params: std::collections::BTreeMap<_, _> = entry.query_pairs().into_owned().collect();
        assert_eq!(params["mode"], expected);
        let continuation = url::Url::parse(&params["authorization_url"]).unwrap();
        assert_eq!(
            continuation
                .query_pairs()
                .find(|(key, _)| key == "prompt")
                .unwrap()
                .1,
            "consent"
        );
        assert!(continuation
            .as_str()
            .contains("state=fixture&code_challenge=fixture"));
    }
    assert!(super::account_entry_url(
        authorize.clone(),
        super::AccountEntryMode::SignUp,
        Some("http://127.0.0.1:1421/desktop/start"),
        false
    )
    .is_ok());
    for bad in [
        "http://127.0.0.1:1421/desktop/start",
        "https://user@accounts.example/desktop/start",
        "https://accounts.example/desktop/start?next=evil",
        "https://accounts.example/sign-up",
    ] {
        assert!(super::account_entry_url(
            authorize.clone(),
            super::AccountEntryMode::SignUp,
            Some(bad),
            true
        )
        .is_err());
    }
}
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
        audience: "mivlet-desktop".to_string(),
        authorized_party: Some("client_123".to_string()),
        scopes: vec!["openid".into(), "profile".into(), "email".into()],
    }
}

fn test_claims() -> TokenClaims {
    TokenClaims {
        iss: "https://issuer.example".to_string(),
        sub: "user_123".to_string(),
        aud: Some(AudienceClaim::One("mivlet-desktop".to_string())),
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
        ("MIVLET_CLERK_ISSUER", "https://issuer.example"),
        ("MIVLET_CLERK_OAUTH_CLIENT_ID", "client_123"),
        ("MIVLET_CLERK_AUDIENCE", "mivlet-desktop"),
    ]);
    let config = load_config_with_packaged(true, |_| None, |key| packaged.get(key).cloned())
        .unwrap()
        .unwrap();
    assert_eq!(config.audience, "mivlet-desktop");
    let error = load_config_with_packaged(
        true,
        |key| (key == "MIVLET_CLERK_ISSUER").then(|| "https://override.example".to_string()),
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
        ("MIVLET_CLERK_ISSUER", "https://issuer.example"),
        ("MIVLET_CLERK_OAUTH_CLIENT_ID", "client_123"),
    ]);
    let error = load_config_from(true, |key| incomplete.get(key).cloned()).unwrap_err();
    assert_eq!(error.code, "configuration-required");
    assert_eq!(
        error.message,
        "Clerk audience must be explicit in production."
    );

    let complete = config_values(&[
        ("MIVLET_CLERK_ISSUER", "https://issuer.example"),
        ("MIVLET_CLERK_OAUTH_CLIENT_ID", "client_123"),
        ("MIVLET_CLERK_AUDIENCE", "mivlet-desktop"),
    ]);
    let config = load_config_from(true, |key| complete.get(key).cloned())
        .unwrap()
        .unwrap();
    assert_eq!(config.audience, "mivlet-desktop");
    assert_eq!(config.authorized_party, None);
    assert!(config.scopes.iter().any(|scope| scope == "offline_access"));
}

#[test]
fn partial_or_obsolete_clerk_configuration_fails_closed() {
    let partial = config_values(&[("MIVLET_CLERK_AUDIENCE", "mivlet-desktop")]);
    assert_eq!(
        load_config_from(false, |key| partial.get(key).cloned())
            .unwrap_err()
            .message,
        "Clerk issuer is required to enable Mivlet cloud identity."
    );

    let obsolete = config_values(&[
        ("MIVLET_CLERK_ISSUER", "https://issuer.example"),
        ("MIVLET_CLERK_OAUTH_CLIENT_ID", "client_123"),
        ("MIVLET_CLERK_REQUIRE_ORG", "true"),
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
        "aud": "mivlet-desktop",
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

#[tokio::test]
async fn callback_error_removes_pending_state() {
    let store = MemoryStore::default();
    let key = pending_key("state_1");
    store.set(&key, "pending verifier").unwrap();

    let error = complete_callback_with_store(
        &store,
        "http://127.0.0.1:1234/callback?state=state_1&error=access_denied",
        None,
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
        audience: "mivlet-desktop".to_string(),
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
        "audience": "mivlet-desktop",
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
