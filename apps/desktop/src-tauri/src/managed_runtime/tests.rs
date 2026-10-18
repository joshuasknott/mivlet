//! Managed runtime protocol and redaction regression tests.
use super::acp::{acp_approval_payload, extract_acp_models};
use super::opencode::sse_frames;
use super::runtime::{parse_grok_models, parse_opencode_models};
use super::*;

#[test]
fn parses_grok_login_and_model_output_without_account_details() {
    let (authenticated, models) = parse_grok_models(
            "You are logged in with grok.com.\nAvailable models:\n  * grok-4.6 (default)\n  - grok-4.5\n",
        );
    assert_eq!(authenticated, Some(true));
    assert_eq!(models.len(), 2);
    assert_eq!(models[0].id, "grok-4.6");
}

#[test]
fn parses_only_bounded_opencode_model_identifiers() {
    let models =
        parse_opencode_models("openai/gpt-5.5\nanthropic/claude-sonnet-4-6\nnot-a-model\n");
    assert_eq!(models.len(), 2);
    assert_eq!(models[1].id, "anthropic/claude-sonnet-4-6");
}

#[test]
fn acp_model_discovery_supports_standard_session_state() {
    let models = extract_acp_models(&json!({
        "result": {
            "models": {
                "currentModelId": "example-1",
                "availableModels": [{"modelId":"example-1","name":"Example 1"}]
            }
        }
    }));
    assert_eq!(models.len(), 1);
    assert_eq!(models[0].label, "Example 1");
}

#[test]
fn approval_payload_redacts_secret_fields() {
    let request = json!({"params":{"toolCall":{"toolCallId":"call-1","title":"Run command","kind":"execute","rawInput":{"token":"super-secret-value","command":"status"}},"options":[{"optionId":"allow-once","kind":"allow_once"},{"optionId":"reject-once","kind":"reject_once"}]}});
    let (payload, pending) = acp_approval_payload("cursor", "run-1", "7", &request, "full-access");
    let encoded = payload.to_string();
    assert!(!encoded.contains("super-secret-value"));
    assert!(encoded.contains("approve cursor action"));
    assert!(matches!(
        pending,
        Some(PendingPermission::Acp { allow_option, .. }) if allow_option == "allow-once"
    ));
}

#[test]
fn claude_sdk_response_binds_control_and_mcp_ids() {
    let response = shared_tool_response(
        "control-1",
        json!({"jsonrpc":"2.0","id":7,"result":{"content":[]}}),
    );
    assert_eq!(response["response"]["request_id"], "control-1");
    assert_eq!(response["response"]["response"]["mcp_response"]["id"], 7);
}

#[test]
fn parses_fragmented_open_code_sse_frames() {
    let mut buffer = b"data: {\"type\":\"session.status\",\"properties\":{".to_vec();
    assert!(sse_frames(&mut buffer).is_empty());
    buffer.extend_from_slice(b"\"status\":{\"type\":\"busy\"}}}\n\ndata: [DONE]\n\n");
    let events = sse_frames(&mut buffer);
    assert_eq!(events.len(), 1);
    assert_eq!(
        events[0].get("type").and_then(Value::as_str),
        Some("session.status")
    );
    assert!(buffer.is_empty());
}

#[test]
fn open_code_endpoints_encode_provider_owned_identifiers() {
    let endpoint = open_code_endpoint(
        "http://127.0.0.1:4096",
        &["permission", "permission/with spaces", "reply"],
    )
    .expect("valid endpoint");
    assert_eq!(
        endpoint,
        "http://127.0.0.1:4096/permission/permission%2Fwith%20spaces/reply"
    );
}

#[test]
fn provider_errors_are_redacted_before_crossing_the_native_boundary() {
    assert_eq!(
        safe_error_message("Authorization: Bearer secret-value", "Provider failed."),
        "[redacted]"
    );
    assert_eq!(
        safe_error_message("Request failed safely", "Provider failed."),
        "Request failed safely"
    );
}
