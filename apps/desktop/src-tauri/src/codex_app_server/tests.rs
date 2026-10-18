fn desktop_pending() -> super::PendingApproval {
    super::PendingApproval {
        kind: super::ApprovalKind::DynamicTool,
        approval_id: "native-opaque".into(),
        call_id: "provider-call".into(),
        tool: "local-desktop-observe".into(),
        arguments: serde_json::json!({}),
        desktop_claimed: false,
        desktop_capture: None,
    }
}

#[test]
fn desktop_pending_calls_bind_exact_arguments_and_cannot_be_claimed_twice() {
    let mut pending = desktop_pending();
    assert!(super::desktop_call_matches(
        &pending,
        "local-desktop-observe",
        &serde_json::json!({})
    ));
    assert!(!super::desktop_call_matches(
        &pending,
        "local-desktop-action",
        &serde_json::json!({})
    ));
    assert!(!super::desktop_call_matches(
        &pending,
        "local-desktop-observe",
        &serde_json::json!({"image":"forged"})
    ));
    pending.desktop_claimed = true;
    assert!(!super::desktop_call_matches(
        &pending,
        "local-desktop-observe",
        &serde_json::json!({})
    ));
}

#[test]
fn renderer_json_cannot_forge_rebind_or_replay_native_pixels() {
    let mut pending = desktop_pending();
    let mut response = super::CodexApprovalResult {
        call_id: "provider-call".into(),
        ok: true,
        output: "{\"imageUrl\":\"data:image/jpeg;base64,forged\"}".into(),
    };
    assert!(super::take_desktop_capture(&mut pending, &response).is_err());
    let capture = || crate::local_computer::desktop_tools::NativeDesktopCapture {
        output: "native-metadata".into(),
        png: vec![1, 2, 3],
        observation_id: "observation-a".into(),
        selection_id: "selection-a".into(),
        generation: 1,
        workspace_id: "workspace-a".into(),
        agent_id: "agent-a".into(),
        created: std::time::Instant::now(),
    };
    pending.desktop_claimed = true;
    pending.desktop_capture = Some(capture());
    assert!(super::take_desktop_capture(&mut pending, &response).is_err());
    pending.desktop_capture = Some(capture());
    response.output = "native-metadata".into();
    response.call_id = "different-call".into();
    assert!(super::take_desktop_capture(&mut pending, &response).is_err());
    response.call_id = "provider-call".into();
    assert_eq!(
        super::take_desktop_capture(&mut pending, &response)
            .unwrap()
            .unwrap()
            .png,
        vec![1, 2, 3]
    );
    assert!(super::take_desktop_capture(&mut pending, &response).is_err());
}

#[test]
fn forwards_only_public_summary_deltas() {
    let mut event = serde_json::json!({ "method": "item/reasoning/summaryTextDelta", "params": { "delta": "Checking the relevant files.", "itemId": "r1", "summaryIndex": 2 } });
    let summary = super::public_reasoning_summary(&event).unwrap();
    assert_eq!(summary["summaryIndex"], 2);
    assert_eq!(summary["text"], "Checking the relevant files.");
    event["method"] = serde_json::json!("item/reasoning/textDelta");
    assert!(super::public_reasoning_summary(&event).is_none());
    event["method"] = serde_json::json!("item/reasoning/summaryTextDelta");
    event["params"]["delta"] = serde_json::Value::Null;
    assert!(super::public_reasoning_summary(&event).is_none());
}

#[test]
fn forwards_provider_web_search_as_untrusted_non_approval_activity() {
    let started = serde_json::json!({
        "method": "item/started",
        "params": { "item": {
            "type": "webSearch",
            "id": "search-1",
            "query": "current release",
            "action": { "type": "search", "query": "current release" }
        }}
    });
    let event = super::public_web_search_event(&started).unwrap();
    assert_eq!(event["type"], "provider-tool");
    assert_eq!(event["tool"], "web-search");
    assert_eq!(event["status"], "running");
    assert!(event.get("approval").is_none());

    let completed = serde_json::json!({
        "method": "item/completed",
        "params": { "item": {
            "type": "webSearch",
            "id": "search-1",
            "query": "current release",
            "action": { "type": "search", "query": "current release" },
            "results": [{ "title": "Release notes", "url": "https://example.com/release" }]
        }}
    });
    let event = super::public_web_search_event(&completed).unwrap();
    assert_eq!(event["status"], "succeeded");
    let output: serde_json::Value =
        serde_json::from_str(event["output"].as_str().unwrap()).unwrap();
    assert_eq!(output["untrusted"], true);
    assert_eq!(output["results"][0]["url"], "https://example.com/release");

    let non_search = serde_json::json!({
        "method": "item/completed",
        "params": { "item": { "type": "agentMessage", "id": "m1", "text": "done" }}
    });
    assert!(super::public_web_search_event(&non_search).is_none());
}

#[test]
fn server_tool_request_ids_do_not_collide_with_client_responses() {
    for id in [1, 2, 3] {
        assert!(!super::is_rpc_response(
            &serde_json::json!({"id":id,"method":"item/tool/call","params":{"tool":"gmail-read"}}),
            id
        ));
        assert!(super::is_rpc_response(
            &serde_json::json!({"id":id,"result":{}}),
            id
        ));
        assert!(super::is_rpc_response(
            &serde_json::json!({"id":id,"error":{"message":"failed"}}),
            id
        ));
    }
}
use super::{
    build_additional_context, chatgpt_login_details, codex_candidates_from, find_codex_executable,
    model_fast_mode, thread_start_request, turn_start_request, validated_codex_auth_url,
    CodexCliStatus, CodexServiceTier, CodexTurnStartRequest,
};
use serde_json::json;

#[test]
fn approval_responses_preserve_rpc_id_types() {
    assert_eq!(super::approval_rpc_id("42"), json!(42));
    assert_eq!(super::approval_rpc_id("\"42\""), json!("42"));
}

#[test]
fn desktop_tool_response_accepts_the_camel_case_wire_contract() {
    let response: super::CodexApprovalResponseRequest = serde_json::from_value(json!({
        "requestId": "run-1", "approvalRequestId": "42",
        "result": { "callId": "gmail-1", "ok": true, "output": "{\"items\":[]}" }
    }))
    .unwrap();
    assert_eq!(response.result.call_id, "gmail-1");
    assert!(response.result.ok);
}

#[test]
fn mivlet_turns_are_ephemeral_with_separate_instructions_and_history() {
    let request: CodexTurnStartRequest = serde_json::from_value(json!({
            "requestId": "request-test",
            "providerId": "codex",
            "threadId": "legacy-provider-thread",
            "request": { "model": "test-model", "reasoningEffort": "high", "messages": [
                { "role": "system", "content": "Keep priorities clear." },
                { "role": "user", "content": "My project is called Elm." },
                { "role": "assistant", "content": "I will use Elm." },
                { "role": "user", "content": "What is its name?" }
            ], "tools": [{ "name": "google-drive-read", "description": "Read connected Drive", "parameters": "{\"type\":\"object\",\"properties\":{\"input\":{\"anyOf\":[{\"type\":\"object\",\"properties\":{\"action\":{\"type\":\"string\",\"enum\":[\"click\"]}},\"required\":[\"action\"],\"additionalProperties\":false}]}},\"required\":[\"input\"],\"additionalProperties\":false}" }], "maxTokens": 2048 },
            "options": { "contextPrefix": "Quoted knowledge", "permissionMode": "trusted-scope" }
        }))
        .unwrap();
    let thread = thread_start_request(&request, true);
    assert_eq!(
        thread["params"]["config"]["features"]["image_generation"],
        true
    );
    let without_images = thread_start_request(&request, false);
    assert_eq!(
        without_images["params"]["config"]["features"]["image_generation"],
        false
    );
    assert!(without_images["params"]["developerInstructions"]
        .as_str()
        .unwrap()
        .contains("Image generation and delivery are unavailable"));
    assert_eq!(thread["method"], "thread/start");
    assert_eq!(thread["params"]["ephemeral"], true);
    assert_eq!(thread["params"]["config"]["features"]["shell_tool"], false);
    assert_eq!(thread["params"]["config"]["forced_login_method"], "chatgpt");
    assert_eq!(
        thread["params"]["config"]["memories"]["use_memories"],
        false
    );
    assert_eq!(thread["params"]["config"]["project_doc_max_bytes"], 0);
    assert_eq!(thread["params"]["config"]["web_search"], "live");
    assert_eq!(thread["params"]["dynamicTools"][0]["type"], "function");
    assert_eq!(
        thread["params"]["dynamicTools"][0]["name"],
        "google-drive-read"
    );
    assert_eq!(
        thread["params"]["dynamicTools"][0]["inputSchema"]["type"],
        "object"
    );
    assert_eq!(
        thread["params"]["dynamicTools"][0]["inputSchema"]["properties"]["input"]["anyOf"][0]
            ["properties"]["action"]["enum"][0],
        "click"
    );
    assert_eq!(
        thread["params"]["developerInstructions"],
        format!(
            "Keep priorities clear.\n\n{}",
            crate::codex_images::instructions(true)
        )
    );
    assert!(thread["params"].get("threadId").is_none());
    let context = build_additional_context(&request).unwrap();
    let turn = turn_start_request("ephemeral-thread", &request, &[], context);
    assert_eq!(turn["params"]["effort"], "high");
    assert_eq!(turn["params"]["serviceTier"], "default");
    let mut fast_request = request.clone();
    fast_request.request.service_tier = Some(CodexServiceTier::Fast);
    let fast_turn = turn_start_request("ephemeral-thread", &fast_request, &[], Default::default());
    assert_eq!(fast_turn["params"]["serviceTier"], "fast");
    assert_eq!(fast_turn["params"]["effort"], "high");
    assert_eq!(turn["params"]["input"][0]["text"], "What is its name?");
    assert_eq!(
        turn["params"]["additionalContext"]["mivlet-conversation-0001-of-0001"]["kind"],
        "untrusted"
    );
    let history = turn["params"]["additionalContext"]["mivlet-conversation-0001-of-0001"]["value"]
        .as_str()
        .unwrap();
    assert!(history.contains("My project is called Elm."));
    assert!(history.contains("I will use Elm."));
    assert!(!history.contains("Keep priorities clear."));
    assert!(!history.contains("What is its name?"));
    assert_eq!(
        turn["params"]["additionalContext"]["mivlet-context-0001-of-0001"]["value"],
        "Quoted knowledge"
    );
    assert_eq!(turn["params"]["approvalPolicy"], "on-request");
}

#[test]
fn fast_mode_requires_advertised_runtime_support() {
    assert_eq!(
        model_fast_mode(&json!({"serviceTiers": [{"id":"fast"}]})),
        Some(json!({"serviceTier":"fast"}))
    );
    assert_eq!(
        model_fast_mode(&json!({"additionalSpeedTiers": ["priority"]})),
        Some(json!({"serviceTier":"priority"}))
    );
    assert_eq!(
        model_fast_mode(&json!({"serviceTiers": [{"id":"default"}, {"id":"ultrafast"}]})),
        None
    );
    assert_eq!(model_fast_mode(&json!({"model":"reasoner"})), None);
    assert!(serde_json::from_value::<CodexServiceTier>(json!("unexpected")).is_err());
}

#[test]
fn additional_context_chunks_reconstruct_exact_utf8_content_in_key_order() {
    let prior = format!(
        "BEGIN:{}:MIDDLE:{}:END",
        "🙂".repeat(900),
        "z".repeat(4_000)
    );
    let prefix = format!("PREFIX-BEGIN:{}:PREFIX-END", "é".repeat(2_000));
    let request: CodexTurnStartRequest = serde_json::from_value(json!({
        "requestId": "request-context-chunks",
        "providerId": "codex",
        "request": { "model": "test-model", "messages": [
            { "role": "user", "content": prior },
            { "role": "assistant", "content": "Acknowledged exactly." },
            { "role": "user", "content": "Repeat the markers." }
        ], "tools": [], "maxTokens": 2048 },
        "options": { "contextPrefix": prefix }
    }))
    .unwrap();

    let context = build_additional_context(&request).unwrap();
    let reconstruct = |stem: &str| {
        context
            .iter()
            .filter(|(key, _)| key.starts_with(stem))
            .map(|(_, entry)| {
                let value = entry["value"].as_str().unwrap();
                assert!(value.len() <= super::CODEX_CONTEXT_CHUNK_MAX_UTF8_BYTES);
                assert_eq!(entry["kind"], "untrusted");
                value
            })
            .collect::<String>()
    };
    let expected_history = serde_json::to_string(&vec![
        json!({ "role": "user", "content": prior }),
        json!({ "role": "assistant", "content": "Acknowledged exactly." }),
    ])
    .unwrap();
    assert_eq!(reconstruct("mivlet-conversation-"), expected_history);
    assert_eq!(reconstruct("mivlet-context-"), prefix);
    assert!(context.len() > 2);
}

#[test]
fn oversized_codex_history_is_rejected_without_partial_context() {
    let request: CodexTurnStartRequest = serde_json::from_value(json!({
        "requestId": "request-context-limit",
        "providerId": "codex",
        "request": { "model": "test-model", "messages": [
            { "role": "user", "content": "x".repeat(super::CODEX_HISTORY_MAX_UTF8_BYTES) },
            { "role": "user", "content": "Continue." }
        ], "tools": [], "maxTokens": 2048 },
        "options": {}
    }))
    .unwrap();
    let error = build_additional_context(&request).unwrap_err();
    assert!(error.contains("did not omit or summarize"));
}

#[test]
fn user_images_are_staged_for_one_turn_and_deleted_with_the_guard() {
    use base64::Engine as _;

    let png = base64::engine::general_purpose::STANDARD
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
            .unwrap();
    let request: CodexTurnStartRequest = serde_json::from_value(json!({
            "requestId": "request-image",
            "providerId": "codex",
            "request": { "model": "test-model", "messages": [{
                "role": "user",
                "content": "Describe this image.",
                "images": [{
                    "id": "image-1",
                    "name": "pixel.png",
                    "mediaType": "image/png",
                    "sizeBytes": png.len(),
                    "width": 1,
                    "height": 1,
                    "dataUrl": format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&png))
                }]
            }], "tools": [], "maxTokens": 256 },
            "options": {}
        }))
        .unwrap();
    let runtime = tempfile::tempdir().unwrap();
    let (guard, paths) = super::stage_codex_user_images(runtime.path(), &request).unwrap();
    assert_eq!(paths.len(), 1);
    assert_eq!(std::fs::read(&paths[0]).unwrap(), png);
    let turn = turn_start_request(
        "thread-image",
        &request,
        &paths,
        build_additional_context(&request).unwrap(),
    );
    assert_eq!(turn["params"]["input"][1]["type"], "localImage");
    assert_eq!(turn["params"]["input"][1]["detail"], "high");
    let staged_path = paths[0].clone();
    drop(guard);
    assert!(!staged_path.exists());
}

#[test]
fn user_image_staging_rejects_mismatched_format_dimensions_and_history() {
    use base64::Engine as _;

    let png = base64::engine::general_purpose::STANDARD
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
            .unwrap();
    let payload = base64::engine::general_purpose::STANDARD.encode(&png);
    let make_request = |media_type: &str, width: u32, historical: bool| {
        let mut messages = Vec::new();
        if historical {
            messages.push(json!({
                "role": "user", "content": "Earlier", "images": [{
                    "id": "image-1", "name": "pixel.png", "mediaType": "image/png",
                    "sizeBytes": png.len(), "width": 1, "height": 1,
                    "dataUrl": format!("data:image/png;base64,{payload}")
                }]
            }));
        }
        messages.push(json!({
                "role": "user", "content": "Current", "images": if historical { json!([]) } else { json!([{
                    "id": "image-1", "name": "pixel.png", "mediaType": media_type,
                    "sizeBytes": png.len(), "width": width, "height": 1,
                    "dataUrl": format!("data:{media_type};base64,{payload}")
                }]) }
            }));
        serde_json::from_value::<CodexTurnStartRequest>(json!({
                "requestId": "request-image", "providerId": "codex",
                "request": { "model": "test-model", "messages": messages, "tools": [], "maxTokens": 256 },
                "options": {}
            })).unwrap()
    };
    let runtime = tempfile::tempdir().unwrap();
    assert!(
        super::stage_codex_user_images(runtime.path(), &make_request("image/jpeg", 1, false))
            .is_err()
    );
    assert!(
        super::stage_codex_user_images(runtime.path(), &make_request("image/png", 2, false))
            .is_err()
    );
    assert!(
        super::stage_codex_user_images(runtime.path(), &make_request("image/png", 1, true))
            .is_err()
    );
}

#[test]
fn cli_status_shape_never_contains_token_fields() {
    let status = CodexCliStatus {
        installed: false,
        authenticated: false,
        auth_method: None,
        version: None,
        message: Some("missing".to_string()),
    };
    let encoded = serde_json::to_string(&status).expect("status serializes");
    assert!(!encoded.contains("token"));
    assert!(!encoded.contains("authToken"));
    assert!(!encoded.contains("executablePath"));
}

#[cfg(windows)]
#[test]
fn desktop_install_is_discovered_without_path_inheritance() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let binary = directory
        .path()
        .join("OpenAI")
        .join("Codex")
        .join("bin")
        .join("desktop-build")
        .join("codex.exe");
    std::fs::create_dir_all(binary.parent().expect("binary parent"))
        .expect("create desktop bin directory");
    std::fs::write(&binary, b"test binary").expect("write desktop binary");

    let candidates = codex_candidates_from(None, None, Some(directory.path().to_path_buf()));
    assert!(candidates.contains(&binary));
}

#[test]
fn executable_detection_is_optional_for_tests() {
    let _ = find_codex_executable();
}

#[test]
fn chatgpt_browser_login_accepts_only_official_https_hosts() {
    assert!(validated_codex_auth_url("https://chatgpt.com/auth?state=opaque").is_ok());
    assert!(validated_codex_auth_url("https://auth.openai.com/codex").is_ok());
    for value in [
        "http://chatgpt.com/auth",
        "https://chatgpt.com.evil.example/auth",
        "https://user@chatgpt.com/auth",
        "file:///tmp/auth",
    ] {
        assert!(validated_codex_auth_url(value).is_err(), "{value}");
    }
}

#[test]
fn chatgpt_browser_login_parses_only_managed_chatgpt_results() {
    let (login_id, auth_url) = chatgpt_login_details(&json!({
        "id": 2,
        "result": {
            "type": "chatgpt",
            "loginId": "login-123",
            "authUrl": "https://chatgpt.com/auth?state=opaque"
        }
    }))
    .unwrap();
    assert_eq!(login_id, "login-123");
    assert!(auth_url.starts_with("https://chatgpt.com/auth"));
    assert!(chatgpt_login_details(&json!({
        "id": 2,
        "result": {
            "type": "chatgptAuthTokens",
            "loginId": "login-123",
            "authUrl": "https://chatgpt.com/auth"
        }
    }))
    .is_err());
}
