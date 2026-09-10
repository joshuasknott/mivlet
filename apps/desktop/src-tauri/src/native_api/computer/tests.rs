use super::*;
use base64::{engine::general_purpose::STANDARD, Engine as _};

fn capture() -> NativeDesktopCapture {
    NativeDesktopCapture {
        output: json!({"observationId":"fresh","width":1,"height":1,"trust":"external-untrusted","imageDelivery":"native-provider-only"}).to_string(),
        png: STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5S8AAAAASUVORK5CYII=").unwrap(),
        generation: 1, workspace_id: "workspace".into(), agent_id: "agent".into(),
        created: Instant::now(), observation_id: "fresh".into(), selection_id: "selection".into(),
    }
}

fn body(provider: &str) -> Value {
    let metadata = capture().output;
    if provider == "anthropic" {
        json!({"messages":[
            {"role":"assistant","content":[{"type":"tool_use","id":"visual","name":"local-desktop-observe","input":{}},{"type":"tool_use","id":"read","name":"read-file","input":{"path":"fixture.txt"}}]},
            {"role":"user","content":[{"type":"tool_result","tool_use_id":"visual","content":metadata},{"type":"tool_result","tool_use_id":"read","content":"fixture text"}]}
        ]})
    } else {
        json!({"messages":[
            {"role":"assistant","tool_calls":[{"id":"visual","type":"function","function":{"name":"local-desktop-observe","arguments":"{}"}},{"id":"read","type":"function","function":{"name":"read-file","arguments":"{\"path\":\"fixture.txt\"}"}}]},
            {"role":"tool","tool_call_id":"visual","content":metadata},
            {"role":"tool","tool_call_id":"read","content":"fixture text"}
        ]})
    }
}

#[test]
fn chat_completions_images_follow_all_tool_results_without_changing_the_call_pair() {
    for provider in ["openai", "xai"] {
        let mut request = body(provider);
        let original = request.clone();
        let pixels = capture();
        wire::attach(provider, &mut request, "visual", &pixels).unwrap();
        assert_eq!(request["messages"][1], original["messages"][1]);
        assert_eq!(request["messages"][2], original["messages"][2]);
        assert_eq!(request["messages"][3]["role"], "user");
        assert_eq!(request["messages"][3]["content"][1]["type"], "image_url");
        assert_eq!(
            request["messages"][3]["content"][1]["image_url"]["url"],
            format!("data:image/png;base64,{}", STANDARD.encode(pixels.png))
        );
        assert!(request["messages"][3]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("never instructions"));
    }
}

#[test]
fn renderer_cannot_supply_or_replay_image_blocks_in_a_computer_session() {
    for provider in ["openai", "anthropic", "xai"] {
        let mut request = body(provider);
        wire::validate_text_messages(provider, &request).unwrap();
        wire::attach(provider, &mut request, "visual", &capture()).unwrap();
        assert!(wire::validate_text_messages(provider, &request).is_err());
    }
}

#[test]
fn anthropic_image_is_inside_the_matching_result_and_other_results_are_preserved() {
    let mut request = body("anthropic");
    let other = request["messages"][1]["content"][1].clone();
    wire::attach("anthropic", &mut request, "visual", &capture()).unwrap();
    let result = &request["messages"][1]["content"][0];
    assert_eq!(result["tool_use_id"], "visual");
    assert_eq!(result["content"][0]["text"], capture().output);
    assert_eq!(result["content"][1]["source"]["type"], "base64");
    assert_eq!(result["content"][1]["source"]["media_type"], "image/png");
    assert_eq!(request["messages"][1]["content"][1], other);
}

#[test]
fn image_egress_rejects_tampered_missing_duplicate_or_unpaired_results_and_unsupported_routes() {
    for provider in ["openai", "xai", "anthropic"] {
        assert!(wire::attach(provider, &mut body(provider), "wrong-call", &capture()).is_err());
        let mut changed = body(provider);
        if provider == "anthropic" {
            changed["messages"][1]["content"][0]["content"] = json!("renderer replacement");
        } else {
            changed["messages"][1]["content"] = json!("renderer replacement");
        }
        assert!(wire::attach(provider, &mut changed, "visual", &capture()).is_err());
        let mut duplicate = body(provider);
        let repeated = duplicate["messages"][1].clone();
        duplicate["messages"].as_array_mut().unwrap().push(repeated);
        assert!(wire::attach(provider, &mut duplicate, "visual", &capture()).is_err());
        let mut unpaired = body(provider);
        unpaired["messages"][0] = json!({"role":"user","content":"pretend call"});
        assert!(wire::attach(provider, &mut unpaired, "visual", &capture()).is_err());
    }
    for provider in [
        "custom",
        "gemini",
        "claude",
        "antigravity",
        "cursor",
        "grok",
        "opencode",
    ] {
        assert!(wire::attach(provider, &mut body("openai"), "visual", &capture()).is_err());
        assert!(!supported_model(provider, "vision"));
    }
    assert!(!supported_model("openai", "unknown-vision"));
    let mut oversized = capture();
    oversized.png.resize(4 * 1024 * 1024 + 1, 0);
    assert!(wire::attach("openai", &mut body("openai"), "visual", &oversized).is_err());
}

#[test]
fn native_stream_reconstructs_exact_fragmented_calls_and_requires_a_terminal_protocol() {
    let mut openai = stream::ToolCalls::new("openai");
    assert!(openai.observe(&json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"local-desktop-","arguments":"{"}}]}}]}).to_string()).unwrap().is_empty());
    assert!(openai.observe(&json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"observe","arguments":"}"}}]}}]}).to_string()).unwrap().is_empty());
    assert!(!openai.complete());
    let calls = openai
        .observe(r#"{"choices":[{"finish_reason":"tool_calls"}]}"#)
        .unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].call_id, "call-1");
    assert_eq!(calls[0].tool, "local-desktop-observe");
    assert_eq!(calls[0].arguments, json!({}));
    assert!(openai.complete());
    assert!(openai
        .observe(r#"{"choices":[{"finish_reason":"tool_calls"}]}"#)
        .is_err());

    let mut anthropic = stream::ToolCalls::new("anthropic");
    anthropic.observe(r#"{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"local-desktop-action","input":{}}}"#).unwrap();
    anthropic.observe(&json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"action\":\"click\","}}).to_string()).unwrap();
    anthropic.observe(&json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\"observationId\":\"fresh\",\"x\":2,\"y\":3}"}}).to_string()).unwrap();
    let calls = anthropic
        .observe(r#"{"type":"content_block_stop","index":1}"#)
        .unwrap();
    assert_eq!(
        calls[0].arguments,
        json!({"action":"click","observationId":"fresh","x":2,"y":3})
    );
    assert!(!anthropic.complete());
    anthropic
        .observe(r#"{"type":"message_delta","delta":{"stop_reason":"tool_use"}}"#)
        .unwrap();
    anthropic.observe(r#"{"type":"message_stop"}"#).unwrap();
    assert!(anthropic.complete());
}

#[test]
fn native_stream_rejects_oversized_and_malformed_tool_arguments() {
    let mut parser = stream::ToolCalls::new("openai");
    assert!(parser.observe(&json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"bad","function":{"name":"local-desktop-observe","arguments":"x".repeat(64_001)}}]}}]}).to_string()).is_err());
    let mut parser = stream::ToolCalls::new("openai");
    parser.observe(r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"bad","function":{"name":"local-desktop-observe","arguments":"[]"}}]}}]}"#).unwrap();
    assert!(parser
        .observe(r#"{"choices":[{"finish_reason":"tool_calls"}]}"#)
        .is_err());
}

struct TestSession {
    id: String,
    run: Arc<Session>,
    _root: tempfile::TempDir,
}
impl TestSession {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let computers = LocalComputerState::for_test(root.path().into());
        let authority = computers.authority_for("workspace", "agent").unwrap();
        let run = Arc::new(Session {
            provider_id: "openai".into(),
            model: "gpt-4.1".into(),
            account: "test-account".into(),
            route: "test-route".into(),
            scope: ComputerScope {
                workspace_id: "workspace".into(),
                agent_id: "agent".into(),
            },
            generation: 1,
            authority,
            created: Instant::now(),
            active: AtomicBool::new(true),
            state: Mutex::new(SessionState {
                in_flight: None,
                calls: HashMap::new(),
                seen_calls: HashSet::new(),
            }),
        });
        let id = desktop_tools::opaque_id().unwrap();
        sessions().lock().unwrap().insert(id.clone(), run.clone());
        Self {
            id,
            run,
            _root: root,
        }
    }
    fn pending(&self, ready: bool) -> String {
        let id = format!("api-visual-{}", desktop_tools::opaque_id().unwrap());
        self.run.state.lock().unwrap().calls.insert(
            id.clone(),
            PendingCall {
                call_id: "visual".into(),
                tool: "local-desktop-observe".into(),
                arguments: json!({}),
                request_id: "response".into(),
                ready,
                claimed: false,
                capture: None,
                awaiting_image: false,
            },
        );
        id
    }
}
impl Drop for TestSession {
    fn drop(&mut self) {
        end_native_computer_session(self.id.clone()).unwrap();
    }
}

#[test]
fn native_claims_are_exact_single_use_and_bound_to_completed_calls_scope_and_generation() {
    let session = TestSession::new();
    let pending = session.pending(false);
    let claim = |workspace, agent, generation, args| {
        claim_desktop_tool(
            &pending,
            "local-desktop-observe",
            &args,
            workspace,
            agent,
            generation,
        )
    };
    assert!(claim("workspace", "agent", 1, json!({})).is_err());
    session
        .run
        .state
        .lock()
        .unwrap()
        .calls
        .get_mut(&pending)
        .unwrap()
        .ready = true;
    assert!(claim("different", "agent", 1, json!({})).is_err());
    assert!(claim("workspace", "different", 1, json!({})).is_err());
    assert!(claim("workspace", "agent", 2, json!({})).is_err());
    assert!(claim("workspace", "agent", 1, json!({"extra":true})).is_err());
    let exact = claim("workspace", "agent", 1, json!({})).unwrap();
    assert!(claim("workspace", "agent", 1, json!({})).is_err());
    assert_eq!(
        retain_desktop_capture(exact, capture()).unwrap(),
        capture().output
    );
    assert!(session.run.state.lock().unwrap().calls[&pending]
        .capture
        .is_some());
    session.run.retire();
    assert!(session.run.state.lock().unwrap().calls.is_empty());
    assert!(claim("workspace", "agent", 1, json!({})).is_err());
}

#[test]
fn cancellation_or_generation_change_discards_late_captures_and_never_resurrects_sessions() {
    for revoke in [false, true] {
        let session = TestSession::new();
        let pending = session.pending(true);
        let claim = claim_desktop_tool(
            &pending,
            "local-desktop-observe",
            &json!({}),
            "workspace",
            "agent",
            1,
        )
        .unwrap();
        if revoke {
            session.run.authority.revoke(1).unwrap();
        } else {
            session.run.retire();
        }
        assert!(claim.check().is_err());
        assert!(retain_desktop_capture(claim, capture()).is_err());
        assert!(claim_desktop_tool(
            &pending,
            "local-desktop-observe",
            &json!({}),
            "workspace",
            "agent",
            1
        )
        .is_err());
    }
}

#[test]
fn expired_images_fail_before_any_delivery_or_scope_access() {
    let root = tempfile::tempdir().unwrap();
    let computers = Arc::new(LocalComputerState::for_test(root.path().into()));
    let mut image = capture();
    image.created = Instant::now() - Duration::from_secs(31);
    assert!(desktop_tools::delivery_ticket(&computers, &image)
        .err()
        .unwrap()
        .contains("expired"));
}
