    #[test]
    fn remote_endpoint_policy_is_https_public_and_credential_free() {
        assert_eq!(
            validate_remote_endpoint("https://example.com:443/mcp?tenant=a")
                .unwrap()
                .as_str(),
            "https://example.com/mcp?tenant=a"
        );
        for endpoint in [
            "http://example.com/mcp",
            "https://user:pass@example.com/mcp",
            "https://localhost/mcp",
            "https://127.0.0.1/mcp",
            "https://169.254.169.254/mcp",
            "https://example.com:22/mcp",
            "https://example.com/mcp#secret",
            "https://example.com/mcp?access_token=secret",
        ] {
            assert!(validate_remote_endpoint(endpoint).is_err(), "{endpoint}");
        }
    }

    #[test]
    fn remote_sse_parser_accepts_only_bounded_json_rpc_data_events() {
        let parsed = parse_remote_sse(
            b": keepalive\nid: 1\nretry: 500\ndata: {\"jsonrpc\":\"2.0\",\"id\":\"one\",\"result\":{}}\n\n",
            true,
        )
        .unwrap();
        assert_eq!(parsed.frames.len(), 1);
        assert!(valid_mcp_frame(&parsed.frames[0]));
        assert_eq!(parsed.last_event_id.as_deref(), Some("1"));
        assert_eq!(parsed.retry_after_ms, 500);
        let primed = parse_remote_sse(b"id: cursor-1\ndata: \n\n", false).unwrap();
        assert!(primed.frames.is_empty());
        assert_eq!(primed.last_event_id.as_deref(), Some("cursor-1"));
        assert!(parse_remote_sse(b"data: server ready\n\n", true).is_err());
        assert!(parse_remote_sse(b"event: ping\n\n", true).is_err());
        assert!(parse_remote_sse(b"id: bad\tvalue\n\n", false).is_err());
    }

    #[test]
    fn oauth_metadata_candidates_follow_mcp_discovery_order() {
        let endpoint = validate_remote_endpoint("https://example.com/public/mcp").unwrap();
        assert_eq!(
            protected_resource_metadata_candidates(&endpoint)
                .into_iter()
                .map(|url| url.to_string())
                .collect::<Vec<_>>(),
            [
                "https://example.com/.well-known/oauth-protected-resource/public/mcp",
                "https://example.com/.well-known/oauth-protected-resource",
            ]
        );
        let issuer = validate_remote_endpoint("https://auth.example.com/tenant").unwrap();
        assert_eq!(
            authorization_metadata_candidates(&issuer)
                .into_iter()
                .map(|url| url.to_string())
                .collect::<Vec<_>>(),
            [
                "https://auth.example.com/.well-known/oauth-authorization-server/tenant",
                "https://auth.example.com/.well-known/openid-configuration/tenant",
                "https://auth.example.com/tenant/.well-known/openid-configuration",
            ]
        );
    }

    #[test]
    fn oauth_metadata_requires_exact_resource_issuer_and_s256() {
        let endpoint = validate_remote_endpoint("https://example.com/mcp").unwrap();
        let protected = serde_json::json!({
            "resource": "https://example.com/mcp",
            "authorization_servers": ["https://auth.example.com/tenant"],
            "scopes_supported": ["files:write", "files:read", "files:read"]
        });
        let (servers, scopes) = parse_protected_resource_metadata(&endpoint, &protected).unwrap();
        assert_eq!(scopes, ["files:read", "files:write"]);
        let metadata = serde_json::json!({
            "issuer": "https://auth.example.com/tenant",
            "authorization_endpoint": "https://auth.example.com/authorize",
            "token_endpoint": "https://auth.example.com/token",
            "revocation_endpoint": "https://auth.example.com/revoke",
            "code_challenge_methods_supported": ["S256"],
            "response_types_supported": ["code"],
            "grant_types_supported": ["authorization_code"],
            "client_id_metadata_document_supported": true
        });
        let discovery =
            parse_authorization_server_metadata(&servers[0], scopes, &metadata).unwrap();
        assert_eq!(discovery.summary.pkce_method, "S256");
        assert!(discovery.summary.client_id_metadata_document_supported);
        assert_eq!(
            discovery.authorization_endpoint.as_str(),
            "https://auth.example.com/authorize"
        );
        assert_eq!(
            discovery.token_endpoint.as_str(),
            "https://auth.example.com/token"
        );
        assert_eq!(
            discovery.revocation_endpoint.as_ref().map(Url::as_str),
            Some("https://auth.example.com/revoke")
        );
        let mut wrong_resource = protected.clone();
        wrong_resource["resource"] = Value::String("https://other.example.com/mcp".into());
        assert!(parse_protected_resource_metadata(&endpoint, &wrong_resource).is_err());
        let mut no_pkce = metadata;
        no_pkce["code_challenge_methods_supported"] = serde_json::json!(["plain"]);
        assert!(parse_authorization_server_metadata(&servers[0], vec![], &no_pkce).is_err());
    }

    #[test]
    fn oauth_client_registration_order_prefers_operator_control_then_interoperability() {
        let pre_registered = select_client_registration_from_availability(true, true, true);
        assert_eq!(pre_registered.strategy, "pre-registered");
        assert_eq!(pre_registered.status, "selected");

        let metadata_document = select_client_registration_from_availability(false, true, true);
        assert_eq!(metadata_document.strategy, "client-id-metadata-document");

        let dynamic = select_client_registration_from_availability(false, false, true);
        assert_eq!(dynamic.strategy, "dynamic-client-registration");

        let manual = select_client_registration_from_availability(false, false, false);
        assert_eq!(manual.strategy, "manual-client-information");
        assert_eq!(manual.status, "configuration-required");
    }

    #[test]
    fn oauth_dynamic_registration_accepts_only_the_exact_public_client_contract() {
        let redirect = "http://127.0.0.1:49152/callback";
        let valid = serde_json::json!({
            "client_id": "public-client-1",
            "application_type": "native",
            "redirect_uris": [redirect],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none"
        });
        assert_eq!(
            validate_dynamic_client_response(&valid, redirect).unwrap(),
            "public-client-1"
        );

        let mut confidential = valid.clone();
        confidential["client_secret"] = Value::String("must-not-cross".into());
        assert!(validate_dynamic_client_response(&confidential, redirect).is_err());

        let mut wrong_redirect = valid.clone();
        wrong_redirect["redirect_uris"] = serde_json::json!(["http://127.0.0.1:60000/callback"]);
        assert!(validate_dynamic_client_response(&wrong_redirect, redirect).is_err());

        let mut implicit_secret_auth = valid;
        implicit_secret_auth
            .as_object_mut()
            .unwrap()
            .remove("token_endpoint_auth_method");
        assert!(validate_dynamic_client_response(&implicit_secret_auth, redirect).is_err());

        let document_url =
            validate_remote_endpoint("https://fable.example.com/oauth/client.json").unwrap();
        let document = serde_json::json!({
            "client_id": document_url.as_str(),
            "redirect_uris": ["http://127.0.0.1/callback"],
            "grant_types": ["authorization_code"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none"
        });
        validate_client_metadata_document(&document, &document_url, redirect).unwrap();
        let mut wrong_document = document;
        wrong_document["redirect_uris"] = serde_json::json!(["https://fable.example.com/callback"]);
        assert!(
            validate_client_metadata_document(&wrong_document, &document_url, redirect).is_err()
        );
    }

    #[test]
    fn oauth_callback_and_token_contract_fail_closed_without_exposing_secrets() {
        let redirect = "http://127.0.0.1:49152/callback";
        let callback = format!("{redirect}?code=opaque-code&state=expected-state");
        assert_eq!(
            authorization_code_from_callback(&callback, redirect, "expected-state").unwrap(),
            "opaque-code"
        );
        assert!(authorization_code_from_callback(&callback, redirect, "other-state").is_err());
        assert!(authorization_code_from_callback(
            "http://127.0.0.1:50000/callback?code=x&state=expected-state",
            redirect,
            "expected-state"
        )
        .is_err());

        let token_endpoint = validate_remote_endpoint("https://auth.example.com/token").unwrap();
        let resource = validate_remote_endpoint("https://mcp.example.com/rpc").unwrap();
        let valid = serde_json::json!({
            "access_token": "access-value",
            "refresh_token": "refresh-value",
            "token_type": "Bearer",
            "expires_in": 3600,
            "scope": "files:read"
        });
        let tokens = parse_mcp_token_response(
            &valid,
            &["files:read".into()],
            &token_endpoint,
            "public-client",
            &resource,
        )
        .unwrap();
        assert_eq!(tokens.scopes, ["files:read"]);
        assert_eq!(tokens.token_endpoint, token_endpoint.as_str());

        let mut confidential_method = valid.clone();
        confidential_method["token_type"] = Value::String("MAC".into());
        assert!(parse_mcp_token_response(
            &confidential_method,
            &[],
            &token_endpoint,
            "public-client",
            &resource
        )
        .is_err());
        let mut unbounded = valid;
        unbounded["expires_in"] = Value::from(0);
        assert!(parse_mcp_token_response(
            &unbounded,
            &[],
            &token_endpoint,
            "public-client",
            &resource
        )
        .is_err());
        let widened = serde_json::json!({
            "access_token": "access-value",
            "token_type": "Bearer",
            "expires_in": 3600,
            "scope": "files:read files:write"
        });
        assert!(parse_mcp_token_response(
            &widened,
            &["files:read".into()],
            &token_endpoint,
            "public-client",
            &resource
        )
        .is_err());
    }

    #[test]
    fn bearer_challenge_is_bounded_exact_and_secret_free() {
        let challenge = parse_bearer_challenge(
            r#"Bearer resource_metadata="https://example.com/auth/resource", scope="files:write files:read files:read""#,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            challenge.resource_metadata.as_str(),
            "https://example.com/auth/resource"
        );
        assert_eq!(challenge.scopes, ["files:read", "files:write"]);
        assert!(parse_bearer_challenge("Basic realm=\"tools\"")
            .unwrap()
            .is_none());
        assert!(parse_bearer_challenge(
            r#"Bearer resource_metadata="https://example.com/one", resource_metadata="https://example.com/two""#
        )
        .is_err());
        assert!(
            parse_bearer_challenge(r#"Bearer resource_metadata="http://127.0.0.1/private""#)
                .is_err()
        );
        assert!(parse_bearer_challenge(
            r#"Bearer resource_metadata="https://example.com/mcp?access_token=secret""#
        )
        .is_err());
    }
