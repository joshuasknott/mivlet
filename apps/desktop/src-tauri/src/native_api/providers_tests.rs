use super::*;

#[test]
fn additional_profiles_have_exact_native_routes_and_bounded_verification() {
    for (id, base) in [
        (
            "alibaba",
            "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        ),
        ("moonshot", "https://api.moonshot.ai/v1"),
        ("zai", "https://api.z.ai/api/paas/v4"),
        ("groq", "https://api.groq.com/openai/v1"),
        ("together", "https://api.together.ai/v1"),
        ("fireworks", "https://api.fireworks.ai/inference/v1"),
        ("cerebras", "https://api.cerebras.ai/v1"),
        ("mistral", "https://api.mistral.ai/v1"),
        ("openrouter", "https://openrouter.ai/api/v1"),
        ("nvidia", "https://integrate.api.nvidia.com/v1"),
        ("siliconflow", "https://api.siliconflow.com/v1"),
        ("cohere", "https://api.cohere.ai/compatibility/v1"),
    ] {
        assert!(NATIVE_PROVIDER_IDS.contains(&id));
        assert_eq!(endpoint_for(id), format!("{base}/chat/completions"));
        let body = credential_verification_body(id).unwrap().unwrap();
        assert_eq!(
            body["model"],
            crate::backends::native_verification_model(id).unwrap()
        );
        assert_eq!(body["max_tokens"], 16);
        assert_eq!(body["stream"], false);
        assert!(body.get("tools").is_none());
        assert_eq!(
            auth_header_for(id, "fixture-key"),
            ("Authorization".into(), "Bearer fixture-key".into())
        );
        let mut stale = serde_json::json!({"model": body["model"], "reasoning_effort": "high"});
        assert!(shape_provider_egress_body(id, &mut stale).is_err());
    }
    assert!(credential_verification_body("openai").unwrap().is_none());
    assert!(endpoint_for("unknown-provider").is_empty());
}

#[test]
fn vendor_options_apply_at_the_shared_native_egress_boundary() {
    for id in ["deepseek", "moonshot", "zai"] {
        let mut body = serde_json::json!({"model": "fixture"});
        shape_provider_egress_body(id, &mut body).unwrap();
        assert_eq!(body["thinking"]["type"], "disabled");
    }
    let mut qwen = serde_json::json!({"model": "qwen-plus"});
    shape_provider_egress_body("alibaba", &mut qwen).unwrap();
    assert_eq!(qwen["enable_thinking"], false);
    let mut unsafe_thinking = serde_json::json!({"enable_thinking": true});
    assert!(shape_provider_egress_body("alibaba", &mut unsafe_thinking).is_err());
    let mut router = serde_json::json!({"model": "openai/gpt-4.1"});
    shape_provider_egress_body("openrouter", &mut router).unwrap();
    assert_eq!(router["provider"]["require_parameters"], true);
}

#[test]
fn alibaba_credentials_bind_keys_to_official_regional_workspace_endpoints() {
    for base in [
        "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        "https://dashscope-us.aliyuncs.com/compatible-mode/v1",
        "https://workspace-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
        "https://workspace-123.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
        "https://workspace-123.cn-hongkong.maas.aliyuncs.com/compatible-mode/v1",
        "https://workspace-123.ap-northeast-1.maas.aliyuncs.com/compatible-mode/v1",
    ] {
        let secret =
            serde_json::json!({"version": 1, "baseUrl": base, "apiKey": "fixture-key"}).to_string();
        validate_native_credential("alibaba", &secret).unwrap();
        let connection = resolve_provider_connection("alibaba", &secret, "qwen-plus").unwrap();
        assert_eq!(connection.chat_endpoint, format!("{base}/chat/completions"));
        assert_eq!(connection.models_endpoint, Some(format!("{base}/models")));
        assert_eq!(
            connection.auth_header,
            Some(("Authorization".into(), "Bearer fixture-key".into()))
        );
    }
    for base in [
        "https://attacker.example/compatible-mode/v1",
        "https://dashscope-intl.aliyuncs.com.attacker.example/compatible-mode/v1",
        "http://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        "https://user:pass@dashscope-intl.aliyuncs.com/compatible-mode/v1",
        "https://dashscope-intl.aliyuncs.com:444/compatible-mode/v1",
        "https://dashscope-intl.aliyuncs.com/compatible-mode/v1?redirect=evil",
        "https://dashscope-intl.aliyuncs.com/compatible-mode/v1#fragment",
        "https://dashscope-intl.aliyuncs.com/arbitrary-path",
        "https://a.b.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    ] {
        assert!(normalize_alibaba_base_url(base).is_err(), "{base}");
    }
    assert!(parse_alibaba_credential(
        r#"{"version":1,"baseUrl":"https://example.com","apiKey":"fixture-key"}"#
    )
    .err()
    .unwrap()
    .find("fixture-key")
    .is_none());
}

#[test]
fn public_catalogues_and_error_bodies_do_not_establish_verified_model_access() {
    assert!(!verification_response_valid(
        &serde_json::json!({"data":[{"id":"fixture-model"}]})
    ));
    assert!(!verification_response_valid(
        &serde_json::json!({"error":{"message":"invalid key"}})
    ));
    assert!(verification_response_valid(&serde_json::json!({
        "choices":[{"message":{"role":"assistant","content":"OK"},"finish_reason":"stop"}]
    })));
    assert!(verification_response_valid(&serde_json::json!({
        "choices":[{"message":{"role":"assistant","content":""},"finish_reason":"length"}]
    })));
}

#[test]
fn cohere_discovery_preserves_chat_models_and_pagination_only() {
    let body = serde_json::json!({
        "models": [
            {"name":"command-a-03-2025","endpoints":["chat"],"is_deprecated":false},
            {"name":"embed-v4.0","endpoints":["embed"]},
            {"name":"old-command","endpoints":["chat"],"is_deprecated":true}
        ], "next_page_token":"next"
    });
    let models = parse_models_body("cohere", &body);
    assert_eq!(models.len(), 1);
    assert_eq!(models[0].id, "command-a-03-2025");
    assert_eq!(discovery_cursor("cohere", &body).as_deref(), Some("next"));
    let together = parse_models_body(
        "together",
        &serde_json::json!([{"id":"chat-model"}, {"id":"embed-model"}]),
    );
    assert_eq!(together.len(), 1);
}
