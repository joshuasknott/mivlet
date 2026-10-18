use super::*;

mod transport_policy_tests {
    use super::*;

    #[test]
    fn retries_only_rate_limits_and_provider_failures() {
        assert!(retryable_status(reqwest::StatusCode::TOO_MANY_REQUESTS));
        assert!(retryable_status(reqwest::StatusCode::BAD_GATEWAY));
        assert!(!retryable_status(reqwest::StatusCode::BAD_REQUEST));
        assert!(!retryable_status(reqwest::StatusCode::UNAUTHORIZED));
    }

    #[test]
    fn terminal_observation_requires_one_clean_compatible_stop() {
        let mut observation = OpenAiCompatibleTerminalObservation::default();
        observation.observe(r#"{"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}"#);
        assert!(!observation.clean_stop());
        observation.observe(r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#);
        observation.observe(r#"{"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":1}}"#);
        assert!(observation.clean_stop());
        observation.observe(r#"{"error":{"message":"late failure"}}"#);
        assert!(!observation.clean_stop());
        let mut late_content =
            OpenAiCompatibleTerminalObservation::new_for_provider("openai", false);
        late_content.observe(r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#);
        late_content.observe(r#"{"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":1}}"#);
        late_content.observe(r#"{"choices":[{"delta":{"content":"late"}}]}"#);
        assert!(!late_content.clean_stop());
        let mut early_usage =
            OpenAiCompatibleTerminalObservation::new_for_provider("openai", false);
        early_usage.observe(r#"{"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}"#);
        early_usage.observe(r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#);
        assert!(!early_usage.clean_stop());
    }

    #[test]
    fn terminal_observation_captures_one_bounded_native_text_output() {
        let mut observation = OpenAiCompatibleTerminalObservation::new_for_provider("openai", true);
        observation.observe(r#"{"choices":[{"delta":{"content":"Hello "}}]}"#);
        observation
            .observe(r#"{"choices":[{"delta":{"content":"world"},"finish_reason":"stop"}]}"#);
        observation.observe(r#"{"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2}}"#);
        assert!(observation.clean_stop());
        assert_eq!(observation.output, "Hello world");
        let mut empty = OpenAiCompatibleTerminalObservation::new_for_provider("openai", true);
        empty.observe(r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#);
        empty.observe(r#"{"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":0}}"#);
        assert!(!empty.clean_stop());
    }

    #[test]
    fn anthropic_terminal_observation_requires_start_delta_usage_and_stop() {
        let mut observation = AnthropicTerminalObservation::new(true);
        observation.observe(r#"{"type":"message_start","message":{"usage":{"input_tokens":7}}}"#);
        observation.observe(
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
        );
        observation.observe(
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}"#,
        );
        observation.observe(r#"{"type":"content_block_stop","index":0}"#);
        observation.observe(
            r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}"#,
        );
        observation.observe(r#"{"type":"message_stop"}"#);
        assert!(observation.clean_stop());
        assert_eq!(observation.output, "Hello");
        assert_eq!(observation.usage, Some((7, 2)));

        let mut tool = AnthropicTerminalObservation::new(false);
        tool.observe(r#"{"type":"message_start","message":{"usage":{"input_tokens":1}}}"#);
        tool.observe(
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call","name":"write"}}"#,
        );
        tool.observe(
            r#"{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":1}}"#,
        );
        tool.observe(r#"{"type":"message_stop"}"#);
        assert!(!tool.clean_stop());

        let mut unordered = AnthropicTerminalObservation::new(true);
        unordered.observe(r#"{"type":"message_start","message":{"usage":{"input_tokens":1}}}"#);
        unordered.observe(
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Skipped start"}}"#,
        );
        unordered.observe(
            r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}"#,
        );
        unordered.observe(r#"{"type":"message_stop"}"#);
        assert!(!unordered.clean_stop());
    }

    #[test]
    fn gemini_terminal_observation_requires_exact_stop_and_final_usage() {
        let mut observation = GeminiTerminalObservation::new(true);
        observation.observe(r#"{"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}"#);
        observation.observe(
            r#"{"candidates":[{"content":{"parts":[{"text":" world"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":2}}"#,
        );
        assert!(observation.clean_stop());
        assert_eq!(observation.output, "Hello world");
        assert_eq!(observation.usage, Some((7, 2)));

        let mut tool = GeminiTerminalObservation::new(false);
        tool.observe(
            r#"{"candidates":[{"content":{"parts":[{"functionCall":{"name":"write","args":{}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1}}"#,
        );
        assert!(!tool.clean_stop());

        let mut unknown = GeminiTerminalObservation::new(false);
        unknown.observe(r#"{"modelVersion":"gemini-test"}"#);
        assert!(!unknown.clean_stop());
    }

    #[test]
    fn streaming_statuses_distinguish_auth_entitlement_rate_limit_and_provider_failure() {
        use reqwest::StatusCode;

        assert_eq!(
            status_error_code(StatusCode::UNAUTHORIZED),
            "authentication"
        );
        assert_eq!(status_error_code(StatusCode::FORBIDDEN), "entitlement");
        assert_eq!(
            status_error_code(StatusCode::PAYMENT_REQUIRED),
            "entitlement"
        );
        assert_eq!(
            status_error_code(StatusCode::TOO_MANY_REQUESTS),
            "rate-limited"
        );
        assert_eq!(
            status_error_code(StatusCode::SERVICE_UNAVAILABLE),
            "provider-unavailable"
        );
    }

    #[test]
    fn gemini_stream_endpoint_is_bound_to_the_selected_model() {
        let endpoint = endpoint_for_model("gemini", "gemini-2.5-pro").expect("endpoint");
        assert!(endpoint.contains("/models/gemini-2.5-pro:streamGenerateContent"));
        assert!(endpoint.ends_with("alt=sse"));
        assert!(endpoint_for_model("gemini", "../escape?key=secret").is_err());
    }

    #[test]
    fn gemini_is_admitted_to_egress_discovery_and_verification() {
        assert!(NATIVE_PROVIDER_IDS.contains(&"gemini"));
        assert_eq!(
            auth_header_for("gemini", "test-key"),
            ("x-goog-api-key".to_string(), "test-key".to_string())
        );
        assert!(endpoint_for("gemini").contains("generativelanguage.googleapis.com"));
        assert_eq!(
            missing_key_message("gemini"),
            "Add a Gemini API key to connect."
        );
        assert_eq!(
            missing_key_message("anthropic"),
            "Add an anthropic API key to connect."
        );
    }

    #[test]
    fn models_endpoints_point_at_each_provider_list_route() {
        assert_eq!(
            models_endpoint_for("openai").unwrap(),
            "https://api.openai.com/v1/models"
        );
        assert_eq!(
            models_endpoint_for("anthropic").unwrap(),
            "https://api.anthropic.com/v1/models"
        );
        assert!(models_endpoint_for("gemini")
            .unwrap()
            .ends_with("/v1beta/models"));
        assert_eq!(
            models_endpoint_for("xai").unwrap(),
            "https://api.x.ai/v1/models"
        );
        assert_eq!(
            models_endpoint_for("openrouter").unwrap(),
            "https://openrouter.ai/api/v1/models"
        );
        assert!(models_endpoint_for("unknown").is_err());
    }

    #[test]
    fn native_allowlist_and_fixed_profile_table_are_complete_and_unique() {
        let native: HashSet<&str> = NATIVE_PROVIDER_IDS.iter().copied().collect();
        assert_eq!(native.len(), NATIVE_PROVIDER_IDS.len());
        let profiled: HashSet<&str> = OPENAI_COMPAT_PROFILES
            .iter()
            .map(|profile| profile.id)
            .collect();
        assert_eq!(profiled.len(), OPENAI_COMPAT_PROFILES.len());
        let expected_profiled: HashSet<&str> = native
            .iter()
            .copied()
            .filter(|id| !matches!(*id, "anthropic" | "gemini" | "custom"))
            .collect();
        assert_eq!(profiled, expected_profiled);
    }

    fn custom_secret(base_url: &str, api_key: Option<&str>) -> String {
        let mut value = serde_json::json!({
            "version": 1,
            "kind": "openai-compatible",
            "baseUrl": base_url,
            "modelId": "example-chat",
        });
        if let Some(api_key) = api_key {
            value["apiKey"] = serde_json::Value::String(api_key.to_string());
        }
        serde_json::to_string(&value).unwrap()
    }

    #[test]
    fn custom_provider_appends_routes_and_uses_optional_bearer_auth() {
        let with_key = custom_secret("https://models.example.com/v1/", Some("secret-key"));
        let connection = resolve_provider_connection("custom", &with_key, "example-chat").unwrap();
        assert_eq!(
            connection.chat_endpoint,
            "https://models.example.com/v1/chat/completions"
        );
        assert!(connection.models_endpoint.is_none());
        assert_eq!(
            connection.auth_header,
            Some(("Authorization".to_string(), "Bearer secret-key".to_string()))
        );

        let without_key = custom_secret("https://models.example.com/v1", None);
        let connection =
            resolve_provider_connection("custom", &without_key, "example-chat").unwrap();
        assert!(connection.auth_header.is_none());
        assert!(resolve_provider_connection("custom", &without_key, "other-model").is_err());
    }

    #[test]
    fn custom_provider_verification_reports_configured_without_claiming_egress() {
        let result =
            configured_custom_provider_result(&custom_secret("http://127.0.0.1:17778/v1", None))
                .unwrap();
        assert_eq!(result.provider_id, "custom");
        assert_eq!(result.outcome, "configured");
        assert!(result
            .message
            .as_deref()
            .is_some_and(|message| message.contains("when you send a message")));
    }

    #[test]
    fn custom_provider_http_is_limited_to_exact_loopback_hosts() {
        for allowed in [
            "http://localhost:8000/v1",
            "http://127.0.0.1:8000/v1",
            "http://127.42.0.7:8000/v1",
            "http://[::1]:8000/v1",
        ] {
            assert!(
                parse_custom_provider_credential(&custom_secret(allowed, None)).is_ok(),
                "{allowed} should be accepted"
            );
        }

        for rejected in [
            "http://example.com/v1",
            "http://10.0.0.8/v1",
            "http://localhost.evil.example/v1",
            "http://127.0.0.1.evil.example/v1",
            "http://user@localhost:8000/v1",
        ] {
            assert!(
                parse_custom_provider_credential(&custom_secret(rejected, None)).is_err(),
                "{rejected} should be rejected"
            );
        }
    }

    #[test]
    fn custom_provider_rejects_unsafe_url_components_and_non_exact_json() {
        for rejected in [
            "ftp://models.example.com/v1",
            "https://user:pass@models.example.com/v1",
            "https://models.example.com/v1?token=secret",
            "https://models.example.com/v1#fragment",
        ] {
            assert!(parse_custom_provider_credential(&custom_secret(rejected, None)).is_err());
        }

        let extra_field = r#"{"version":1,"kind":"openai-compatible","baseUrl":"https://models.example.com/v1","modelId":"example-chat","extra":true}"#;
        assert!(parse_custom_provider_credential(extra_field).is_err());
        let wrong_version = r#"{"version":2,"kind":"openai-compatible","baseUrl":"https://models.example.com/v1","modelId":"example-chat"}"#;
        assert!(parse_custom_provider_credential(wrong_version).is_err());
        let wrong_kind = r#"{"version":1,"kind":"anthropic","baseUrl":"https://models.example.com/v1","modelId":"example-chat"}"#;
        assert!(parse_custom_provider_credential(wrong_kind).is_err());
        let null_key = r#"{"version":1,"kind":"openai-compatible","baseUrl":"https://models.example.com/v1","modelId":"example-chat","apiKey":null}"#;
        assert!(parse_custom_provider_credential(null_key).is_err());
        let missing_model =
            r#"{"version":1,"kind":"openai-compatible","baseUrl":"https://models.example.com/v1"}"#;
        assert!(parse_custom_provider_credential(missing_model).is_err());
        assert!(parse_custom_provider_credential("not-json").is_err());
    }

    #[test]
    fn parses_openai_style_data_array_into_ids() {
        let body = serde_json::json!({
            "data": [
                { "id": "gpt-5" },
                { "id": "gpt-4.1" },
                { "id": "" },
                { "other": "ignored" }
            ]
        });
        let models = parse_models_body("openai", &body);
        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["gpt-5", "gpt-4.1"]);
        assert!(models.iter().all(|m| m.available));
    }

    #[test]
    fn openrouter_profile_uses_bearer_auth_and_documented_endpoints() {
        assert_eq!(
            endpoint_for("openrouter"),
            "https://openrouter.ai/api/v1/chat/completions"
        );
        assert_eq!(
            models_endpoint_for("openrouter").unwrap(),
            "https://openrouter.ai/api/v1/models"
        );
        assert_eq!(
            auth_header_for("openrouter", "sk-test"),
            ("Authorization".to_string(), "Bearer sk-test".to_string())
        );
        assert!(extra_headers("openrouter").is_empty());
        assert!(
            resolve_provider_connection("openrouter", "sk-test", "openai/gpt-4.1")
                .unwrap()
                .auth_header
                .is_some()
        );
    }

    fn openrouter_model(id: &str, overrides: serde_json::Value) -> serde_json::Value {
        let mut model = serde_json::json!({
            "id": id,
            "canonical_slug": id,
            "name": "Fixture Model",
            "context_length": 200_000,
            "architecture": { "input_modalities": ["text"], "output_modalities": ["text"] },
            "supported_parameters": ["max_tokens", "tools", "tool_choice", "structured_outputs", "reasoning_effort"],
            "top_provider": { "max_completion_tokens": 32_768, "is_moderated": false },
        });
        if let Some(object) = model.as_object_mut() {
            for (key, value) in overrides.as_object().expect("overrides must be an object") {
                object.insert(key.clone(), value.clone());
            }
        }
        model
    }

    #[test]
    fn openrouter_discovery_maps_bounded_capabilities_from_provider_metadata() {
        let body = serde_json::json!({
            "data": [
                openrouter_model("anthropic/claude-sonnet-4.6", serde_json::json!({
                    "reasoning": { "mandatory": false, "default_enabled": true, "supported_efforts": ["max", "high", "medium", "low"], "default_effort": "medium" },
                    "architecture": { "input_modalities": ["text", "image"], "output_modalities": ["text"] },
                })),
                openrouter_model("deepseek/deepseek-chat:free", serde_json::json!({
                    "supported_parameters": ["max_tokens", "reasoning_effort", "reasoning"],
                    "reasoning": { "mandatory": false, "default_enabled": true, "supported_efforts": null },
                })),
                openrouter_model("mystery/unlisted", serde_json::json!({
                    "supported_parameters": ["max_tokens"],
                    "context_length": null,
                })),
            ]
        });
        let models = parse_models_body("openrouter", &body);
        assert_eq!(models.len(), 3);

        let capable = models
            .iter()
            .find(|model| model.id == "anthropic/claude-sonnet-4.6")
            .unwrap();
        assert_eq!(capable.label.as_deref(), Some("Fixture Model"));
        let capabilities = capable.capabilities.as_ref().unwrap();
        assert_eq!(capabilities["streaming"], true);
        assert_eq!(capabilities["contextWindow"], 200_000);
        assert_eq!(capabilities["tools"], true);
        assert_eq!(capabilities["structuredOutput"], true);
        assert_eq!(capabilities["reasoning"], true);
        // Image input is documented for this model, but the Mivlet route has no
        // verified image-egress protocol: vision is never advertised.
        assert!(capabilities.get("vision").is_none());
        let reasoning = capable.reasoning.as_ref().unwrap();
        assert_eq!(
            reasoning["supportedEfforts"],
            serde_json::json!(["max", "high", "medium", "low"])
        );
        assert_eq!(reasoning["defaultEffort"], "medium");

        // A null effort allowlist means "all gateway efforts accepted"; Mivlet
        // does not advertise a level list it could not validate, so reasoning
        // stays entirely unknown for this model.
        let unrestricted = models
            .iter()
            .find(|model| model.id == "deepseek/deepseek-chat:free")
            .unwrap();
        assert!(unrestricted.reasoning.is_none());
        assert!(unrestricted
            .capabilities
            .as_ref()
            .unwrap()
            .get("reasoning")
            .is_none());

        // Unknown metadata stays unknown: only streaming is claimed.
        let unknown = models
            .iter()
            .find(|model| model.id == "mystery/unlisted")
            .unwrap();
        assert_eq!(
            unknown.capabilities.as_ref().unwrap(),
            &serde_json::json!({ "streaming": true })
        );
        assert!(unknown.reasoning.is_none());
    }

    #[test]
    fn openrouter_discovery_rejects_unstable_aliases_and_non_chat_output_rows() {
        let body = serde_json::json!({
            "data": [
                // "Latest alias" rows resolve to a different model over time.
                openrouter_model("~openai/gpt-sol-latest", serde_json::json!({
                    "alias_target": { "name": "OpenAI: GPT Sol", "slug": "openai/gpt-5.6-sol" },
                })),
                openrouter_model("openai/gpt-sol-latest", serde_json::json!({
                    "alias_target": { "name": "OpenAI: GPT Sol", "slug": "openai/gpt-5.6-sol" },
                })),
                // Image-output rows have no chat-completions route.
                openrouter_model("openai/gpt-image-1", serde_json::json!({
                    "architecture": { "input_modalities": ["text"], "output_modalities": ["image"] },
                })),
                // Embedding rows are filtered by the generation-model markers.
                openrouter_model("openai/text-embedding-3-large", serde_json::json!({
                    "architecture": { "input_modalities": ["text"], "output_modalities": ["embeddings"] },
                })),
                openrouter_model("openai/gpt-4.1", serde_json::json!({})),
            ]
        });
        let models = parse_models_body("openrouter", &body);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "openai/gpt-4.1");
    }

    #[test]
    fn openrouter_tools_require_both_tool_parameters_and_reasoning_requires_effort_parameter() {
        let body = serde_json::json!({
            "data": [
                openrouter_model("provider/tools-only", serde_json::json!({
                    "supported_parameters": ["max_tokens", "tools"],
                })),
                openrouter_model("provider/tool-choice-only", serde_json::json!({
                    "supported_parameters": ["max_tokens", "tool_choice"],
                })),
                openrouter_model("provider/reasoning-no-param", serde_json::json!({
                    "supported_parameters": ["max_tokens", "tools", "tool_choice"],
                    "reasoning": { "mandatory": false, "supported_efforts": ["high", "low"], "default_effort": "low" },
                })),
                openrouter_model("provider/out-of-bound-context", serde_json::json!({
                    "context_length": 20_000_000,
                })),
            ]
        });
        let models = parse_models_body("openrouter", &body);
        let by_id: std::collections::HashMap<&str, &DiscoveredModel> = models
            .iter()
            .map(|model| (model.id.as_str(), model))
            .collect();
        assert_eq!(
            by_id["provider/tools-only"]
                .capabilities
                .as_ref()
                .unwrap()
                .get("tools"),
            None
        );
        assert_eq!(
            by_id["provider/tool-choice-only"]
                .capabilities
                .as_ref()
                .unwrap()
                .get("tools"),
            None
        );
        // Reasoning requires the `reasoning_effort` parameter in addition to
        // the reasoning object; without it no effort levels are advertised.
        assert_eq!(by_id["provider/reasoning-no-param"].reasoning, None);
        assert_eq!(
            by_id["provider/reasoning-no-param"]
                .capabilities
                .as_ref()
                .unwrap()
                .get("reasoning"),
            None
        );
        // Out-of-bound context metadata is dropped, not trusted.
        assert_eq!(
            by_id["provider/out-of-bound-context"]
                .capabilities
                .as_ref()
                .unwrap()
                .get("contextWindow"),
            None
        );
    }

    #[test]
    fn openrouter_discovery_cursor_follows_only_bounded_offset_links() {
        let with_offset =
            serde_json::json!({ "links": { "next": "/api/v1/models?offset=500&limit=500" } });
        assert_eq!(
            discovery_cursor("openrouter", &with_offset).as_deref(),
            Some("500")
        );
        let bare_offset = serde_json::json!({ "links": { "next": "?offset=100" } });
        assert_eq!(
            discovery_cursor("openrouter", &bare_offset).as_deref(),
            Some("100")
        );
        for hostile in [
            serde_json::json!({ "links": { "next": "https://evil.example/models?offset=500" } }),
            serde_json::json!({ "links": { "next": "/api/v1/models?offset=abc" } }),
            serde_json::json!({ "links": { "next": null } }),
            serde_json::json!({ "links": {} }),
            serde_json::json!({}),
        ] {
            assert_eq!(discovery_cursor("openrouter", &hostile), None);
        }
    }

    #[test]
    fn parses_gemini_models_name_prefix_and_generation_filter() {
        let body = serde_json::json!({
            "models": [
                { "name": "models/gemini-2.5-pro", "supportedGenerationMethods": ["generateContent", "streamGenerateContent"] },
                { "name": "models/text-embedding-004", "supportedGenerationMethods": ["embedContent"] },
                { "name": "models/gemini-3.5-flash" }
            ]
        });
        let models = parse_models_body("gemini", &body);
        // Embedding-only models are not surfaced as runnable generation models.
        let by_id: std::collections::HashMap<&str, bool> = models
            .iter()
            .map(|m| (m.id.as_str(), m.available))
            .collect();
        assert!(by_id["gemini-2.5-pro"]);
        // Missing capability metadata is not proof that the model supports
        // generation. Unknown models fail closed until the provider declares
        // generateContent support.
        assert!(!by_id.contains_key("gemini-3.5-flash"));
        assert!(!by_id.contains_key("text-embedding-004"));
    }

    #[test]
    fn discovery_caps_a_pathologically_large_response() {
        let mut data = Vec::new();
        for i in 0..(MAX_DISCOVERED_MODELS + 50) {
            data.push(serde_json::json!({ "id": format!("m-{i}") }));
        }
        let body = serde_json::json!({ "data": data });
        let models = parse_models_body("openai", &body);
        assert_eq!(models.len(), MAX_DISCOVERED_MODELS);
    }

    #[test]
    fn verify_maps_http_status_to_outcome_vocabulary() {
        use crate::models::BACKEND_VERIFY_OUTCOMES;
        use reqwest::StatusCode;

        let cases = [
            (StatusCode::OK, "ready"),
            (StatusCode::CREATED, "ready"),
            (StatusCode::NO_CONTENT, "ready"),
            (StatusCode::UNAUTHORIZED, "auth-failed"),
            (StatusCode::FORBIDDEN, "auth-failed"),
            (StatusCode::NOT_FOUND, "unsupported"),
            (StatusCode::METHOD_NOT_ALLOWED, "unsupported"),
            (StatusCode::NOT_IMPLEMENTED, "unsupported"),
            (StatusCode::TOO_MANY_REQUESTS, "failed"),
            (StatusCode::BAD_GATEWAY, "failed"),
            (StatusCode::INTERNAL_SERVER_ERROR, "failed"),
        ];
        for (status, expected) in cases {
            let outcome = verify_outcome_for_status(status);
            assert_eq!(
                outcome, expected,
                "status {status} should map to {expected}"
            );
            // Every emitted outcome must be in the controlled vocabulary.
            assert!(
                BACKEND_VERIFY_OUTCOMES.contains(&outcome),
                "outcome {outcome} is not in BACKEND_VERIFY_OUTCOMES"
            );
        }
    }

    #[test]
    fn missing_key_message_directs_the_user_to_add_a_key() {
        // A missing key is a configuration-state gap, not a provider rejection.
        // The copy must never imply the key was "rejected" or "invalid".
        for provider_id in NATIVE_PROVIDER_IDS {
            let message = missing_key_message(provider_id);
            assert!(
                message.starts_with("Add") || message.starts_with("Connect"),
                "missing-credential message should direct the user to connect: {message}"
            );
            assert!(
                message.to_ascii_lowercase().contains(provider_id),
                "missing-key message should name the provider: {message}"
            );
            assert!(
                !message.to_lowercase().contains("reject"),
                "missing-key message must not say 'rejected': {message}"
            );
            assert!(
                !message.to_lowercase().contains("invalid"),
                "missing-key message must not say 'invalid': {message}"
            );
        }
    }

    #[test]
    fn normalize_sse_line_drops_control_fields_comments_blanks_and_done() {
        assert!(normalize_sse_line("").is_none());
        assert!(normalize_sse_line("   ").is_none());
        assert!(normalize_sse_line(": comment heartbeat").is_none());
        assert!(normalize_sse_line("event: message_start").is_none());
        assert!(normalize_sse_line("id: event-1").is_none());
        assert!(normalize_sse_line("retry: 1000").is_none());
        assert!(normalize_sse_line("data: [DONE]").is_none());
        assert!(normalize_sse_line("data:[DONE]").is_none());
        assert!(normalize_sse_line("DATA:  foo ").is_some());
        let p = normalize_sse_line("data: {\"a\":1}").unwrap();
        assert!(p.contains("{\"a\":1}"));
        assert_eq!(normalize_sse_line("bare").unwrap(), "bare");
        assert!(normalize_sse_line("data: ").is_none());
    }

    #[test]
    fn retry_after_supports_variants_and_bounds() {
        // Directly exercises the shipped pure retry_after_ms (used by real retry_after)
        let d1 = retry_after_ms(Some("5"), 0);
        assert!((5000..=30000).contains(&d1));
        let d2 = retry_after_ms(Some("120"), 1);
        assert!(d2 <= 30000);
        let d3 = retry_after_ms(Some("Fri, 31 Dec 1999 23:59:59 GMT"), 0);
        assert!((1..=30000).contains(&d3));
        let d4 = retry_after_ms(Some("bad"), 2);
        assert!(d4 <= 30000);
    }

    #[test]
    fn retry_after_real_wrapper_exercised_with_response() {
        // Drives the exact header lookup + to_str + delegate logic used by the real retry_after wrapper.
        // Constructs HeaderMap (public) and calls the shared header_to_retry that the shipped wrapper uses.
        // This exercises the wrapper's core code path without needing external http crate name.
        let mut hm = reqwest::header::HeaderMap::new();
        hm.insert(reqwest::header::RETRY_AFTER, "4".parse().unwrap());
        let d1 = header_to_retry(hm.get(reqwest::header::RETRY_AFTER), 0);
        assert!(d1.as_millis() >= 4000 && d1.as_millis() <= 30000);

        // leading digits case ("120sec")
        let mut hm2 = reqwest::header::HeaderMap::new();
        hm2.insert(reqwest::header::RETRY_AFTER, "120sec".parse().unwrap());
        let d2 = header_to_retry(hm2.get(reqwest::header::RETRY_AFTER), 1);
        assert!(d2.as_millis() <= 30000);
    }

    #[test]
    fn parse_models_handles_malformed_missing_gen_cap_pagination_and_bounds() {
        let bad = serde_json::json!({"data": [ {"id": "ok"}, {"no": "id"}, null, {"id": ""} ] });
        let ms = parse_models_body("openai", &bad);
        assert_eq!(ms.len(), 1);

        let gem = serde_json::json!({"models": [
            {"name": "models/good", "supportedGenerationMethods": ["generateContent"]},
            {"name": "models/nogen"}
        ]});
        let ms = parse_models_body("gemini", &gem);
        assert_eq!(ms.len(), 1);
        assert_eq!(ms[0].id, "good");

        let mut big = vec![];
        for i in 0..(MAX_DISCOVERED_MODELS + 100) {
            big.push(serde_json::json!({"id": format!("m{}", i)}));
        }
        let b = serde_json::json!({"data": big});
        assert_eq!(parse_models_body("openai", &b).len(), MAX_DISCOVERED_MODELS);
    }

    #[test]
    fn discovery_cursor_variants_and_pagination_cycle_bounds() {
        let g = serde_json::json!({"nextPageToken": "tok123"});
        assert_eq!(discovery_cursor("gemini", &g).as_deref(), Some("tok123"));

        let o = serde_json::json!({"has_more": true, "last_id": "idZ"});
        assert_eq!(discovery_cursor("openai", &o).as_deref(), Some("idZ"));

        let no = serde_json::json!({"has_more": false});
        assert!(discovery_cursor("openai", &no).is_none());

        let e = serde_json::json!({"has_more": true, "last_id": ""});
        assert!(discovery_cursor("anthropic", &e).is_none());
    }

    #[test]
    fn is_generation_filters_non_gen_and_unknown() {
        assert!(is_generation_model(
            "openai",
            &serde_json::json!({}),
            "gpt-5"
        ));
        assert!(!is_generation_model(
            "openai",
            &serde_json::json!({}),
            "text-embedding-ada"
        ));
        assert!(!is_generation_model(
            "openai",
            &serde_json::json!({}),
            "dall-e-3"
        ));
        assert!(is_generation_model(
            "gemini",
            &serde_json::json!({"supportedGenerationMethods":["generateContent"]}),
            "x"
        ));
        assert!(!is_generation_model("gemini", &serde_json::json!({}), "x"));
    }

    #[test]
    fn strict_sse_framing_carries_split_utf8_and_crlf_boundaries() {
        let encoded = "data: {\"text\":\"café\"}\r\n".as_bytes();
        let split = encoded.iter().position(|byte| *byte == 0xc3).unwrap() + 1;
        let mut buffer = Vec::new();
        buffer.extend_from_slice(&encoded[..split]);
        assert!(drain_strict_sse_lines(&mut buffer, false)
            .unwrap()
            .is_empty());
        buffer.extend_from_slice(&encoded[split..]);
        assert_eq!(
            drain_strict_sse_lines(&mut buffer, false).unwrap(),
            vec!["data: {\"text\":\"café\"}"]
        );
        let mut invalid = vec![b'd', 0xff, b'\n'];
        assert!(drain_strict_sse_lines(&mut invalid, false).is_err());
    }

    #[test]
    fn bounded_stream_and_max_constants() {
        // Drives the shipped > MAX check via the helper used in stream_backend buffer.
        let mut acc: usize = MAX_STREAM_RESPONSE_BYTES - 5;
        let mut b = Vec::new();
        let big = vec![b'x'; 10];
        assert!(accumulate_and_check_bound(&mut acc, &mut b, &big));
    }

    #[test]
    fn accumulate_drives_real_size_check_and_buffer_path() {
        // Directly exercises the shipped accumulate_and_check_bound byte path.
        // used inside stream_backend_completion's bytes loop.
        let mut bytes_acc: usize = 0;
        let mut buf = Vec::new();
        let small = b"data: hello\r\n";
        assert!(!accumulate_and_check_bound(&mut bytes_acc, &mut buf, small));
        assert!(bytes_acc > 0);
        assert!(buf.starts_with(b"data: hello"));

        // Now cross the limit with a huge chunk (simulates large SSE payload chunk)
        let mut big_acc: usize = MAX_STREAM_RESPONSE_BYTES - 10;
        let mut big_buf = Vec::new();
        let huge = vec![b'x'; 100];
        let exceeded = accumulate_and_check_bound(&mut big_acc, &mut big_buf, &huge);
        assert!(exceeded);
    }

    #[test]
    fn cancel_backend_completion_and_map_exercised() {
        // Drive the SHIPPED cancel_backend_completion success path (map remove + sender.send(true) -> Ok(true))
        // plus the rx.changed() used in stream_backend_completion's select.
        let id = "test-cancel-map-success".to_string();
        let (tx, mut rx) = tokio::sync::watch::channel(false);
        {
            let mut map = cancel_map().lock().unwrap();
            map.insert(id.clone(), tx);
        }
        let res = cancel_backend_completion(id);
        assert_eq!(res, Ok(true));
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let _ = rx.changed().await;
            assert!(*rx.borrow());
        });
    }
}

#[cfg(test)]
mod deepseek_egress_tests {
    use super::*;

    /// The documented DeepSeek stream shape (api-docs.deepseek.com
    /// /api/create-chat-completion): the last content chunk carries an empty
    /// delta, a non-null finish_reason, and the usage statistics together.
    /// "no separate usage-only chunk is emitted".
    #[test]
    fn deepseek_terminal_observation_accepts_usage_riding_the_terminal_chunk() {
        let mut observation =
            OpenAiCompatibleTerminalObservation::new_for_provider("deepseek", true);
        observation.observe(r#"{"choices":[{"delta":{"role":"assistant","content":"Hello "}}]}"#);
        observation.observe(r#"{"choices":[{"delta":{"content":"world"},"finish_reason":null}]}"#);
        observation.observe(
            r#"{"choices":[{"delta":{"content":"","role":null},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":2,"total_tokens":9}}"#,
        );
        assert!(observation.clean_stop());
        assert_eq!(observation.output, "Hello world");
        assert_eq!(observation.usage, Some((7, 2)));
    }

    #[test]
    fn shared_observation_still_rejects_usage_before_any_finish_for_other_providers() {
        let mut early = OpenAiCompatibleTerminalObservation::new_for_provider("openai", false);
        early.observe(r#"{"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}"#);
        early.observe(r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#);
        assert!(!early.clean_stop());

        // A non-deepseek provider must not accept the usage-riding-terminal shape.
        let mut rides = OpenAiCompatibleTerminalObservation::new_for_provider("openai", false);
        rides.observe(
            r#"{"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}"#,
        );
        assert!(!rides.clean_stop());
    }

    #[test]
    fn deepseek_profile_serves_documented_endpoints_and_bearer_auth() {
        assert_eq!(
            endpoint_for("deepseek"),
            "https://api.deepseek.com/chat/completions"
        );
        assert_eq!(
            models_endpoint_for("deepseek").unwrap(),
            "https://api.deepseek.com/models"
        );
        assert_eq!(
            auth_header_for("deepseek", "sk-fixture"),
            ("Authorization".to_string(), "Bearer sk-fixture".to_string())
        );
        assert!(openai_compat_profile("deepseek").is_some());
        assert!(openai_compat_profile("deepseek").unwrap().auth_required);
    }

    #[test]
    fn deepseek_egress_rejects_thinking_options_and_forces_non_thinking_mode() {
        let mut with_effort = serde_json::json!({
            "model": "deepseek-flash",
            "reasoning_effort": "high",
        });
        assert!(shape_deepseek_egress_body(&mut with_effort).is_err());

        let mut thinking_enabled = serde_json::json!({
            "model": "deepseek-flash",
            "thinking": { "type": "enabled" },
        });
        assert!(shape_deepseek_egress_body(&mut thinking_enabled).is_err());

        let mut plain = serde_json::json!({ "model": "deepseek-flash" });
        shape_deepseek_egress_body(&mut plain).unwrap();
        assert_eq!(plain["thinking"], serde_json::json!({ "type": "disabled" }));

        let mut already_disabled = serde_json::json!({
            "model": "deepseek-flash",
            "thinking": { "type": "disabled" },
        });
        shape_deepseek_egress_body(&mut already_disabled).unwrap();
        assert_eq!(
            already_disabled["thinking"],
            serde_json::json!({ "type": "disabled" })
        );
    }

    #[test]
    fn deepseek_missing_key_message_names_the_provider_without_rejection_copy() {
        let message = missing_key_message("deepseek");
        assert!(message.starts_with("Add a DeepSeek API key"));
        assert!(message.to_lowercase().contains("deepseek"));
        assert!(!message.to_lowercase().contains("reject"));
        assert!(!message.to_lowercase().contains("invalid"));
    }

    #[test]
    fn deepseek_discovery_parses_the_documented_list_models_shape() {
        let body = serde_json::json!({
            "object": "list",
            "data": [
                { "id": "deepseek-flash", "object": "model", "owned_by": "deepseek" },
                { "id": "deepseek-v4-pro", "object": "model", "owned_by": "deepseek" },
            ]
        });
        let models = parse_models_body("deepseek", &body);
        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["deepseek-flash", "deepseek-v4-pro"]);
        assert!(models.iter().all(|m| m.available));
    }
}

#[cfg(test)]
mod openrouter_accounting_tests {
    use super::*;

    fn terminal_usage(reason: &str, content: &str) -> String {
        serde_json::json!({
            "choices": [{"index": 0, "delta": {"content": content, "role": "assistant"}, "finish_reason": reason}],
            "usage": {"prompt_tokens": 7, "completion_tokens": 2}
        }).to_string()
    }

    fn finished(provider: &str) -> OpenAiCompatibleTerminalObservation {
        let mut observed = OpenAiCompatibleTerminalObservation::new_for_provider(provider, true);
        observed.observe(r#"{"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}"#);
        observed.observe(r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#);
        observed
    }

    #[test]
    fn accepts_documented_openrouter_accounting_frame() {
        let mut observed = finished("openrouter");
        observed.observe(&terminal_usage("stop", ""));
        assert!(observed.clean_stop());
        assert_eq!(observed.output, "Hello");
        assert_eq!(observed.usage, Some((7, 2)));
        observed.observe(&terminal_usage("stop", ""));
        assert!(
            !observed.clean_stop(),
            "duplicate accounting frame must fail"
        );
    }

    #[test]
    fn accounting_exception_rejects_content_conflicts_and_other_providers() {
        for (provider, reason, content) in [
            ("openrouter", "stop", "late"),
            ("openrouter", "length", ""),
            ("openai", "stop", ""),
        ] {
            let mut observed = finished(provider);
            observed.observe(&terminal_usage(reason, content));
            assert!(!observed.clean_stop());
        }
        let mut early = OpenAiCompatibleTerminalObservation::new_for_provider("openrouter", true);
        early.observe(&terminal_usage("stop", ""));
        assert!(!early.clean_stop());
        let mut no_usage = finished("openrouter");
        no_usage.observe(r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#);
        assert!(!no_usage.clean_stop());
    }
}
