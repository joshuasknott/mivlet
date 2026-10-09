    fn find_node() -> PathBuf {
        let executable = if cfg!(windows) { "node.exe" } else { "node" };
        std::env::var_os("PATH")
            .into_iter()
            .flat_map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
            .map(|directory| directory.join(executable))
            .find(|candidate| candidate.is_file())
            .expect("the workspace requires Node.js on PATH")
    }

    #[tokio::test]
    async fn queued_dispatch_rejects_a_changed_connection_and_native_session_closure() {
        let node = validate_executable(find_node().to_string_lossy().as_ref()).unwrap();
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mcp-stdio-server.mjs");
        let child = spawn_mcp_child(&node, &[fixture.to_string_lossy().to_string()], Path::new(env!("CARGO_MANIFEST_DIR"))).unwrap();
        let id = random_session_id().unwrap();
        process_map().lock().unwrap().insert(id.clone(), McpChild {
            child, stdin: None, workspace_id: "workspace-local".into(), owner_subject: "account-test".into(),
            connection_id: "connection-current".into(), connection_revision: 2, initialized: true,
            discovery_current: true, stop: SessionStop::new(),
        });
        let mut queued = QueuedMcpFrame {
            frame: r#"{"jsonrpc":"2.0","id":"call","method":"tools/call","params":{"name":"echo","arguments":{"text":"never dispatched"}}}"#.into(),
            connection_id: "connection-current".into(), connection_revision: 1,
        };
        let stale = require_stdio_dispatch(&id, &queued);
        queued.connection_revision = 2;
        process_map().lock().unwrap().get(&id).unwrap().stop.close();
        let stopped = require_stdio_dispatch(&id, &queued);
        let mut process = process_map().lock().unwrap().remove(&id).unwrap();
        process.child.kill().await.unwrap();
        assert!(stale.unwrap_err().contains("queued MCP Connection changed"));
        assert!(stopped.unwrap_err().contains("MCP session was closed"));
        assert!(require_stdio_dispatch(&id, &queued).unwrap_err().contains("MCP session is closed"));
    }

    #[tokio::test]
    async fn real_stdio_child_discovers_calls_and_closes() {
        let node = validate_executable(find_node().to_string_lossy().as_ref()).unwrap();
        let fixture =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mcp-stdio-server.mjs");
        let cwd = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let mut child =
            spawn_mcp_child(&node, &[fixture.to_string_lossy().to_string()], &cwd).unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let mut lines = BufReader::new(stdout).lines();
        let session_id = "mcp-fixturesemantic00000000000000000";
        mark_discovery_changed(session_id);

        for (request, initialized) in [
            r#"{"jsonrpc":"2.0","id":"init","method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"Mivlet","version":"0.1.0"}}}"#,
            r#"{"jsonrpc":"2.0","id":"list","method":"tools/list","params":{}}"#,
            r#"{"jsonrpc":"2.0","id":"resources","method":"resources/list","params":{}}"#,
            r#"{"jsonrpc":"2.0","id":"call","method":"tools/call","params":{"name":"echo","arguments":{"text":"hello"}}}"#,
        ]
        .into_iter()
        .zip([false, true, true, true])
        {
            register_discovery_request(session_id, request, initialized).unwrap();
            stdin.write_all(request.as_bytes()).await.unwrap();
            stdin.write_all(b"\n").await.unwrap();
            stdin.flush().await.unwrap();
            let response = timeout(Duration::from_secs(5), lines.next_line())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert!(valid_mcp_frame(&response));
            observe_discovery_frame(session_id, &response);
            let value: Value = serde_json::from_str(&response).unwrap();
            assert_eq!(value.get("error"), None);
        }
        let discovered_tools = vec![
            "echo".into(),
            "search_work".into(),
            "slow".into(),
            "change_tools".into(),
            "crash".into(),
        ];
        let discovered_resources = vec!["fixture://planning-notes".into()];
        verify_discovery_proof(session_id, &discovered_tools, &discovered_resources).unwrap();
        stdin
            .write_all(
                br#"{"jsonrpc":"2.0","id":"slow","method":"tools/call","params":{"name":"slow","arguments":{}}}"#,
            )
            .await
            .unwrap();
        stdin.write_all(b"\n").await.unwrap();
        stdin
            .write_all(
                br#"{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":"slow","reason":"test cancellation"}}"#,
            )
            .await
            .unwrap();
        stdin.write_all(b"\n").await.unwrap();
        stdin
            .write_all(br#"{"jsonrpc":"2.0","id":"ping","method":"ping","params":{}}"#)
            .await
            .unwrap();
        stdin.write_all(b"\n").await.unwrap();
        stdin.flush().await.unwrap();
        let response = timeout(Duration::from_secs(1), lines.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let response: Value = serde_json::from_str(&response).unwrap();
        assert_eq!(response["id"], "ping");

        stdin
            .write_all(
                br#"{"jsonrpc":"2.0","id":"change","method":"tools/call","params":{"name":"change_tools","arguments":{}}}"#,
            )
            .await
            .unwrap();
        stdin.write_all(b"\n").await.unwrap();
        stdin.flush().await.unwrap();
        let notification = timeout(Duration::from_secs(1), lines.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&notification).unwrap()["method"],
            "notifications/tools/list_changed"
        );
        observe_discovery_frame(session_id, &notification);
        assert!(
            verify_discovery_proof(session_id, &discovered_tools, &discovered_resources).is_err()
        );
        let change_response = timeout(Duration::from_secs(1), lines.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&change_response).unwrap()["id"],
            "change"
        );

        drop(stdin);
        let status = timeout(Duration::from_secs(5), child.wait())
            .await
            .unwrap()
            .unwrap();
        assert!(status.success());
        mark_discovery_changed(session_id);
    }

    #[tokio::test]
    async fn real_stdio_child_failure_is_detected_and_a_fresh_process_restarts() {
        let node = validate_executable(find_node().to_string_lossy().as_ref()).unwrap();
        let fixture =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mcp-stdio-server.mjs");
        let cwd = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let mut failed =
            spawn_mcp_child(&node, &[fixture.to_string_lossy().to_string()], &cwd).unwrap();
        let mut failed_stdin = failed.stdin.take().unwrap();
        failed_stdin
            .write_all(
                br#"{"jsonrpc":"2.0","id":"crash","method":"tools/call","params":{"name":"crash","arguments":{}}}"#,
            )
            .await
            .unwrap();
        failed_stdin.write_all(b"\n").await.unwrap();
        failed_stdin.flush().await.unwrap();
        let status = timeout(Duration::from_secs(5), failed.wait())
            .await
            .unwrap()
            .unwrap();
        assert!(!status.success());

        let mut restarted =
            spawn_mcp_child(&node, &[fixture.to_string_lossy().to_string()], &cwd).unwrap();
        let mut stdin = restarted.stdin.take().unwrap();
        let stdout = restarted.stdout.take().unwrap();
        let mut lines = BufReader::new(stdout).lines();
        stdin
            .write_all(
                br#"{"jsonrpc":"2.0","id":"init-after-crash","method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"Mivlet","version":"0.1.0"}}}"#,
            )
            .await
            .unwrap();
        stdin.write_all(b"\n").await.unwrap();
        stdin.flush().await.unwrap();
        let response = timeout(Duration::from_secs(5), lines.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(valid_mcp_frame(&response));
        let response: Value = serde_json::from_str(&response).unwrap();
        assert_eq!(response["id"], "init-after-crash");
        drop(stdin);
        let status = timeout(Duration::from_secs(5), restarted.wait())
            .await
            .unwrap()
            .unwrap();
        assert!(status.success());
    }

    #[test]
    fn every_session_requires_fresh_discovery_before_tool_execution() {
        assert!(require_current_session_discovery(false).is_err());
        assert!(require_current_session_discovery(true).is_ok());
    }

    #[test]
    fn initialization_requires_the_exact_successful_protocol_response() {
        let session = "mcp-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        mark_discovery_changed(session);
        let request = r#"{"jsonrpc":"2.0","id":"init-1","method":"initialize","params":{"protocolVersion":"2025-11-25"}}"#;
        register_discovery_request(session, request, false).unwrap();
        assert!(register_discovery_request(session, request, false).is_err());
        assert!(register_discovery_request(
            session,
            r#"{"jsonrpc":"2.0","id":"list-early","method":"tools/list","params":{}}"#,
            false,
        )
        .is_err());

        let valid = serde_json::json!({
            "jsonrpc": "2.0",
            "id": "init-1",
            "result": {
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "fixture", "version": "1.0" }
            }
        });
        let valid = valid.as_object().unwrap();
        assert!(successful_initialize_response(valid, "\"init-1\""));
        let wrong_protocol = serde_json::json!({
            "jsonrpc": "2.0",
            "id": "init-1",
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "serverInfo": { "name": "fixture", "version": "1.0" }
            }
        });
        assert!(!successful_initialize_response(
            wrong_protocol.as_object().unwrap(),
            "\"init-1\""
        ));
        let rejected = serde_json::json!({
            "jsonrpc": "2.0",
            "id": "init-1",
            "error": { "code": -32602, "message": "rejected" }
        });
        assert!(!successful_initialize_response(
            rejected.as_object().unwrap(),
            "\"init-1\""
        ));
        mark_discovery_changed(session);
    }

    #[test]
    fn discovery_proof_tracks_exact_pages_and_list_change_invalidation() {
        let session = "mcp-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        mark_discovery_changed(session);
        register_discovery_request(
            session,
            r#"{"jsonrpc":"2.0","id":"tools-1","method":"tools/list","params":{}}"#,
            true,
        )
        .unwrap();
        observe_discovery_frame(
            session,
            r#"{"jsonrpc":"2.0","id":"tools-1","result":{"tools":[{"name":"read"}],"nextCursor":"page-2"}}"#,
        );
        assert!(verify_discovery_proof(session, &["read".into()], &[]).is_err());
        assert!(register_discovery_request(
            session,
            r#"{"jsonrpc":"2.0","id":"tools-bad","method":"tools/list","params":{"cursor":"wrong"}}"#,
            true,
        )
        .is_err());
        register_discovery_request(
            session,
            r#"{"jsonrpc":"2.0","id":"tools-2","method":"tools/list","params":{"cursor":"page-2"}}"#,
            true,
        )
        .unwrap();
        observe_discovery_frame(
            session,
            r#"{"jsonrpc":"2.0","id":"tools-2","result":{"tools":[{"name":"write"}]}}"#,
        );
        assert!(verify_discovery_proof(session, &["write".into(), "read".into()], &[]).is_ok());
        assert!(verify_discovery_proof(session, &["forged".into()], &[]).is_err());
        observe_discovery_frame(
            session,
            r#"{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}"#,
        );
        assert!(verify_discovery_proof(session, &["read".into()], &[]).is_err());
        mark_discovery_changed(session);
    }

    #[test]
    fn tool_approval_is_secret_free_and_arguments_reject_credentials() {
        let proposal = McpToolProposal {
            operation: McpOperation::Tool,
            workspace_id: "workspace-a".into(),
            session_id: "mcp-1234567890abcdef1234567890abcdef".into(),
            tool_name: "read".into(),
            arguments: serde_json::json!({
                "path": "safe.txt",
                "request": {
                    "callbackUrl": "https://api.example.com/hook?token=private-value&case=1#secret-fragment",
                    "body": "private-body",
                    "message": "Please send the report to the finance team."
                }
            }),
        };
        validate_mcp_tool_name(&proposal.tool_name).unwrap();
        validate_mcp_arguments(&proposal.arguments).unwrap();
        let approval = approval_for_tool_proposal(
            &proposal,
            &ToolProposalContext {
                connection_id: "connection-mcp".into(),
                connection_revision: 4,
                transport: "stdio".into(),
                arguments_fingerprint: "arguments-fingerprint".into(),
                proposal_fingerprint: "fingerprint-only".into(),
            },
            "approval-1".into(),
            "2026-07-11T20:00:00Z".into(),
        );
        let encoded = serde_json::to_string(&approval).unwrap();
        assert!(encoded.contains("fingerprint-only"));
        assert!(encoded.contains("argument fields"));
        assert!(encoded.contains("request.callbackUrl"));
        assert!(encoded.contains("request.body"));
        assert!(encoded.contains("validated arguments"));
        assert!(encoded.contains("safe.txt"));
        assert!(encoded.contains("https://api.example.com"));
        assert!(encoded.contains("https://api.example.com/hook?case=1"));
        assert!(encoded.contains("private-body"));
        assert!(encoded.contains("Please send the report to the finance team."));
        assert!(!encoded.contains("private-value"));
        assert!(!encoded.contains("secret-fragment"));
        assert!(validate_mcp_arguments(&serde_json::json!({ "apiKey": "secret" })).is_err());
        assert!(validate_mcp_arguments(
            &serde_json::json!({ "url": "https://user:pass@example.com/private" })
        )
        .is_err());
        assert!(validate_mcp_arguments(&serde_json::json!(["not-an-object"])).is_err());
    }

    #[test]
    fn mcp_argument_preview_bounds_unicode_and_marks_omitted_content() {
        let mut arguments = serde_json::Map::new();
        arguments.insert("message".into(), Value::String("🙂".repeat(5_000)));
        for index in 0..(MAX_MCP_PREVIEW_ITEMS + 2) {
            arguments.insert(format!("field{index}"), Value::String(index.to_string()));
        }
        let (_, _, rendered) = safe_mcp_argument_preview(&Value::Object(arguments));
        assert!(rendered.chars().count() <= MAX_MCP_PREVIEW_CHARS + 1);
        assert!(rendered.contains("[additional fields omitted]") || rendered.ends_with('…'));
    }

    #[test]
    fn resource_operations_bind_a_single_uri_without_tool_or_direct_file_authority() {
        let mut proposal = McpToolProposal {
            operation: McpOperation::Resource,
            workspace_id: "workspace-a".into(), session_id: "mcp-1234567890abcdef1234567890abcdef".into(),
            tool_name: "resources/read".into(), arguments: serde_json::json!({"uri":"file:///server-owned/brief"}),
        };
        assert_eq!(resource_uri_for_proposal(&proposal).unwrap(), Some("file:///server-owned/brief"));
        assert!(!routine_official_read(&proposal).unwrap());
        let approval = approval_for_tool_proposal(
            &proposal,
            &ToolProposalContext {
                connection_id: "connection-mcp".into(),
                connection_revision: 4,
                transport: "streamable-http".into(),
                arguments_fingerprint: "arguments-fingerprint".into(),
                proposal_fingerprint: "exact-fingerprint".into(),
            },
            "approval-one".into(),
            "now".into(),
        );
        assert_eq!(approval.mode, "read-only");
        assert_eq!(approval.service, "MCP resources");
        assert!(approval.confirmation_phrase.is_none());
        proposal.arguments["extra"] = Value::Bool(true);
        assert!(resource_uri_for_proposal(&proposal).is_err());
        proposal.arguments = serde_json::json!({"uri":"https://user:secret@example.com/data"});
        assert!(resource_uri_for_proposal(&proposal).is_err());
        proposal.arguments = serde_json::json!({"uri":"note://brief"});
        proposal.tool_name = "arbitrary-tool".into();
        assert!(resource_uri_for_proposal(&proposal).is_err());
        let legacy: McpToolProposal = serde_json::from_value(serde_json::json!({"workspaceId":"w","sessionId":"s","toolName":"read","arguments":{}})).unwrap();
        assert!(legacy.operation == McpOperation::Tool);
        assert!(serde_json::from_value::<McpToolProposal>(serde_json::json!({"workspaceId":"w","sessionId":"s","toolName":"read","arguments":{},"hostPath":"C:/private"})).is_err());
    }

    #[test]
    fn correlated_response_consumes_pending_audit_without_result_content() {
        let session = "mcp-1234567890abcdef1234567890abcdef";
        let request = "native-mcp-tool-1";
        pending_audits().lock().unwrap().insert(
            pending_audit_key(session, request),
            PendingMcpAudit {
                tool_name: "read".into(),
                connection_id: "connection-mcp".into(),
                actor: "user-a".into(),
            },
        );
        audit_mcp_response(
            session,
            r#"{"jsonrpc":"2.0","id":"native-mcp-tool-1","result":{"content":[{"type":"text","text":"private"}]}}"#,
        );
        assert!(pending_audits()
            .lock()
            .unwrap()
            .get(&pending_audit_key(session, request))
            .is_none());
        assert!(is_mcp_response_for(
            r#"{"jsonrpc":"2.0","id":"native-mcp-tool-1","result":{}}"#,
            "native-mcp-tool-1"
        ));
        assert!(!is_mcp_response_for(
            r#"{"jsonrpc":"2.0","id":"native-mcp-tool-1","method":"sampling/createMessage"}"#,
            "native-mcp-tool-1"
        ));
    }
