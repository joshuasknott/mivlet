//! Connector authentication regression tests.

use super::*;
use crate::authorized_scope::{resolve, AuthorizedCommandScope, ScopeAccess};
use crate::store::vault::{MasterKey, Vault};
use crate::store::Store;
use std::{
    fs,
    sync::{Arc, Mutex},
};
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

#[test]
fn google_client_configuration_survives_restart_and_is_client_scoped() {
    let store = MemoryStore::default();
    let provisioned =
        google_secret_with_store("gmail", "client-a", Some("test-secret".into()), &store).unwrap();
    assert_eq!(provisioned.as_deref(), Some("test-secret"));
    assert_eq!(
        google_secret_with_store("google-drive", "client-a", None, &store).unwrap(),
        provisioned
    );
    assert_eq!(
        google_secret_with_store("gmail", "client-b", None, &store)
            .unwrap_err()
            .code,
        "configuration-required"
    );
}

#[test]
fn token_exchange_errors_are_actionable_without_echoing_provider_details() {
    assert!(token_exchange_rejection_message(Some("invalid_grant"))
        .contains("authorization code or PKCE verifier"));
    assert!(
        token_exchange_rejection_message(Some("invalid_client")).contains("desktop OAuth client")
    );
    assert_eq!(
        token_exchange_rejection_message(Some("secret-bearing-provider-detail")),
        "OAuth token exchange was rejected."
    );
}

fn authorized_test_scope(durable: &Store) -> AuthorizedCommandScope {
    durable
        .transaction(|tx| resolve(tx, None, None, ScopeAccess::Write))
        .unwrap()
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
        client_id: "mivlet-desktop".to_string(),
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
    assert_eq!(
        query.get("prompt").map(|value| value.as_ref()),
        Some("consent select_account")
    );
    assert!(!query.contains_key("include_granted_scopes"));
    let pending = store.get(&pending_key("fixture", state)).unwrap().unwrap();
    let pending: PendingOAuth = serde_json::from_str(&pending).unwrap();
    let expected_challenge = pkce_challenge(&pending.verifier);
    assert_eq!(
        query.get("code_challenge").map(|value| value.as_ref()),
        Some(expected_challenge.as_str())
    );
    assert!(!result
        .authorization_url
        .unwrap()
        .contains(&pending.verifier));
}

#[test]
fn abandoned_oauth_state_is_removed_idempotently() {
    let store = MemoryStore::default();
    let result = start_with_store(
        "fixture",
        "http://127.0.0.1:43123/callback",
        fixture_config(),
        &store,
    )
    .expect("start");
    let state = Url::parse(result.authorization_url.as_deref().unwrap())
        .unwrap()
        .query_pairs()
        .find(|(key, _)| key == "state")
        .unwrap()
        .1
        .into_owned();
    let key = pending_key("fixture", &state);
    assert!(store.get(&key).unwrap().is_some());

    discard_pending_with_store("fixture", &state, &store).unwrap();
    discard_pending_with_store("fixture", &state, &store).unwrap();

    assert!(store.get(&key).unwrap().is_none());
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
        "mivlet-connector-connections-{}.json",
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
        .join(format!("mivlet-missing-parent-{}", std::process::id()))
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
async fn connector_oauth_is_bound_to_the_installation_workspace_that_started_it() {
    let store = MemoryStore::default();
    let started = start_with_store_bound(
        "fixture",
        "http://127.0.0.1:43123/callback",
        fixture_config(),
        &store,
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

    let error = prepare_with_store("fixture", &callback, &store, Some("workspace-b"))
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
            Err::<(), _>(command_error(
                "needs-auth",
                "fixture",
                "Installation state changed during the request. Please try again.",
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
fn canonical_auth_commit_succeeds_and_failed_guard_restores_prior_stores() {
    let durable =
        Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap();
    let scope = authorized_test_scope(&durable);
    let path = std::env::temp_dir().join(format!(
        "mivlet-canonical-auth-commit-{}.json",
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

    let error = commit_prepared_auth_state(
        &path,
        &durable,
        "gmail",
        &scope,
        &secrets,
        prepared("account-2"),
        || {
            Err::<(), _>(command_error(
                "unknown",
                "gmail",
                "Installation state changed before commit.",
                false,
            ))
        },
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
        .with_conn(|tx| crate::store::repos::connection_selection::get(tx, &scope, "gmail"))
        .unwrap()
        .unwrap();
    assert_eq!(selection_after_failure.connection_id, result_connection_id);
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
    let path = std::env::temp_dir().join(format!(
        "mivlet-google-accounts-{}.json",
        std::process::id()
    ));
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

#[test]
fn provider_access_binding_accepts_only_the_resolved_connection() {
    let expected = derive_native_connection_id("workspace-a", "github", "account-a");
    assert!(require_expected_connection("workspace-a", "github", "account-a", &expected).is_ok());
    let error =
        require_expected_connection("workspace-a", "github", "account-b", &expected).unwrap_err();
    assert_eq!(error.code, "conflict");
    assert!(error.retryable);
    assert!(!error.message.contains("account-a"));
    assert!(!error.message.contains("account-b"));
    assert!(require_expected_connection("workspace-b", "github", "account-a", &expected).is_err());
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
// The base URL may be a bare host (https://auth.mivlet.app), a Cloudflare
// Workers host (https://mivlet-broker.workers.dev), or a path-prefixed route
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
        resolve_broker_endpoints("github", Some("https://auth.mivlet.app/")).expect("https ok");
    assert_eq!(
        endpoints.authorization_endpoint,
        "https://auth.mivlet.app/oauth/github/authorize"
    );
    assert_eq!(
        endpoints.handoff_endpoint,
        "https://auth.mivlet.app/oauth/github/handoff"
    );
    assert_eq!(
        endpoints.refresh_endpoint,
        "https://auth.mivlet.app/oauth/github/refresh"
    );
    assert_eq!(
        endpoints.revocation_endpoint,
        "https://auth.mivlet.app/oauth/github/revoke"
    );
    let serialized = serde_json::to_string(&endpoints).expect("serialize");
    assert!(!serialized.contains("/token"));
    assert!(!serialized.contains("/identity"));
}

#[test]
fn broker_resolver_accepts_a_cloudflare_workers_url() {
    // A workers.dev host resolves the same four routes; no token/identity.
    let endpoints =
        resolve_broker_endpoints("linear", Some("https://mivlet-broker.example.workers.dev"))
            .expect("workers.dev ok");
    assert_eq!(
        endpoints.handoff_endpoint,
        "https://mivlet-broker.example.workers.dev/oauth/linear/handoff"
    );
    assert_eq!(
        endpoints.refresh_endpoint,
        "https://mivlet-broker.example.workers.dev/oauth/linear/refresh"
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
    let endpoints =
        resolve_broker_endpoints("linear", Some("http://127.0.0.1:8788/")).expect("loopback ok");
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
        resolve_broker_endpoints("notion", Some("https://auth.mivlet.app/")).expect("ok");
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
    let handoff = "https://auth.mivlet.app/oauth/github/handoff";
    assert_eq!(
        broker_sibling_endpoint(handoff, "refresh").unwrap(),
        "https://auth.mivlet.app/oauth/github/refresh"
    );
    assert_eq!(
        broker_sibling_endpoint(handoff, "revoke").unwrap(),
        "https://auth.mivlet.app/oauth/github/revoke"
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
        broker_sibling_endpoint("http://127.0.0.1:8788/oauth/linear/handoff", "refresh").unwrap(),
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
    let pending: PendingOAuth =
        serde_json::from_str(&store.get(&pending_key("github", &state)).unwrap().unwrap()).unwrap();
    let verifier = pending.verifier.clone();
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
    assert!(request.contains(&format!("\"codeVerifier\":\"{verifier}\"")));
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

    let old_val = std::env::var("MIVLET_GOOGLE_OAUTH_CLIENT_ID").ok();
    let old_legacy = std::env::var("FABLE_GOOGLE_OAUTH_CLIENT_ID").ok();
    std::env::remove_var("MIVLET_GOOGLE_OAUTH_CLIENT_ID");
    std::env::remove_var("FABLE_GOOGLE_OAUTH_CLIENT_ID");

    let result = provider_config("google-drive", "oauth-pkce", vec![]);

    if let Some(val) = old_val {
        std::env::set_var("MIVLET_GOOGLE_OAUTH_CLIENT_ID", val);
    }
    if let Some(val) = old_legacy {
        std::env::set_var("FABLE_GOOGLE_OAUTH_CLIENT_ID", val);
    }

    let err = result.expect_err("should fail when client id is missing");
    assert_eq!(err.code, "configuration-required");
    assert_eq!(err.connector_id, "google-drive");
    assert!(!err.retryable);
}

#[test]
fn test_provider_config_pkce_missing_client_secret_fails_closed() {
    let _lock = ENV_LOCK.lock().unwrap();

    let old_id = std::env::var("MIVLET_GOOGLE_OAUTH_CLIENT_ID").ok();
    let old_secret = std::env::var("MIVLET_GOOGLE_OAUTH_CLIENT_SECRET").ok();
    let old_legacy_secret = std::env::var("FABLE_GOOGLE_OAUTH_CLIENT_SECRET").ok();
    std::env::set_var(
        "MIVLET_GOOGLE_OAUTH_CLIENT_ID",
        "google-desktop-client.apps.googleusercontent.com",
    );
    std::env::remove_var("MIVLET_GOOGLE_OAUTH_CLIENT_SECRET");
    std::env::remove_var("FABLE_GOOGLE_OAUTH_CLIENT_SECRET");

    let result = provider_config("google-drive", "oauth-pkce", vec![]);

    match old_id {
        Some(value) => std::env::set_var("MIVLET_GOOGLE_OAUTH_CLIENT_ID", value),
        None => std::env::remove_var("MIVLET_GOOGLE_OAUTH_CLIENT_ID"),
    }
    if let Some(value) = old_secret {
        std::env::set_var("MIVLET_GOOGLE_OAUTH_CLIENT_SECRET", value);
    }
    if let Some(value) = old_legacy_secret {
        std::env::set_var("FABLE_GOOGLE_OAUTH_CLIENT_SECRET", value);
    }

    let err = result.expect_err("should fail when client secret is missing");
    assert_eq!(err.code, "configuration-required");
    assert!(err.message.contains("client secret"));
    assert!(!err.retryable);
}

#[tokio::test]
async fn test_disconnect_public_pkce_revocation() {
    let store = MemoryStore::default();
    let durable =
        Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap();
    let scope = authorized_test_scope(&durable);
    let path = std::env::temp_dir().join(format!(
        "mivlet-disconnect-test-{}.json",
        std::process::id()
    ));
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
    let mut compatibility = read_connections(&path).unwrap();
    compatibility[0].credential_ref = "oauth-token:google-drive:stale-legacy-ref".into();
    write_connections(&path, &compatibility).unwrap();

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
    let scope = authorized_test_scope(&durable);
    let path = std::env::temp_dir().join(format!(
        "mivlet-disconnect-rollback-test-{}.json",
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
    let error =
        commit_prepared_disconnect("gmail", &store, &path, &durable, &scope, &prepared, || {
            Err::<(), _>(command_error(
                "unknown",
                "gmail",
                "Installation state changed before disconnect.",
                false,
            ))
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
    let scope = authorized_test_scope(&durable);
    let path = std::env::temp_dir().join(format!(
        "mivlet-canonical-refresh-test-{}.json",
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
    let mut previous_connections = read_connections(&path).unwrap();
    previous_connections[0].credential_ref = "oauth-token:gmail:stale-legacy-ref".into();
    write_connections(&path, &previous_connections).unwrap();
    let canonical_before =
        canonical_connection_for_refresh(&durable, &scope, "gmail", "account-1").unwrap();
    let mut updated_connection = previous_connections[0].clone();
    updated_connection.credential_ref =
        canonical_credential_binding(&durable, &scope, "gmail", "account-1").unwrap();
    assert_eq!(updated_connection.credential_ref, credential_ref);
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
    assert_eq!(refreshed_connections[0].credential_ref, credential_ref);
    let canonical_after =
        canonical_connection_for_refresh(&durable, &scope, "gmail", "account-1").unwrap();

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
        || {
            Err::<(), _>(command_error(
                "unknown",
                "gmail",
                "Installation state changed before refresh rejection.",
                false,
            ))
        },
    )
    .unwrap_err();
    assert_eq!(rollback_error.code, "unknown");
    assert_eq!(read_connections(&path).unwrap()[0].status, "connected");
    assert_eq!(
        store.get(&credential_ref).unwrap().as_deref(),
        Some(new_encoded.as_str())
    );

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
