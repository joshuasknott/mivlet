    #[test]
    fn frame_validation_accepts_protocol_messages_and_rejects_logs_or_multiline() {
        assert!(valid_mcp_frame(
            r#"{"jsonrpc":"2.0","id":"one","method":"initialize","params":{}}"#
        ));
        assert!(valid_mcp_frame(
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#
        ));
        assert!(!valid_mcp_frame("server ready"));
        assert!(!valid_mcp_frame(
            "{\"jsonrpc\":\"2.0\",\"method\":\"x\"}\n{}"
        ));
        assert!(!valid_mcp_frame(
            r#"{"jsonrpc":"2.0","id":null,"result":{}}"#
        ));
    }

    #[test]
    fn renderer_frames_are_control_plane_only() {
        assert!(permitted_renderer_frame(
            r#"{"jsonrpc":"2.0","id":"list","method":"tools/list","params":{}}"#
        ));
        assert!(permitted_renderer_frame(
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#
        ));
        for method in [
            "tools/call",
            "resources/read",
            "prompts/get",
            "sampling/createMessage",
        ] {
            assert!(!permitted_renderer_frame(&format!(
                r#"{{"jsonrpc":"2.0","id":"blocked","method":"{method}","params":{{}}}}"#
            )));
        }
        assert!(!permitted_renderer_frame(
            r#"{"jsonrpc":"2.0","id":"server-request","result":{}}"#
        ));
    }

    #[test]
    fn bounded_decoder_reassembles_lines_and_discards_oversized_input() {
        let mut decoder = BoundedLineDecoder::default();
        assert!(decoder.push(b"one").is_empty());
        assert_eq!(
            decoder.push(b"\r\ntwo\n"),
            [b"one".to_vec(), b"two".to_vec()]
        );
        decoder.push(&vec![b'x'; MAX_MCP_FRAME_BYTES + 1]);
        assert!(decoder
            .push(b"discarded\nvalid\n")
            .iter()
            .any(|line| line == b"valid"));
    }

    #[test]
    fn session_ids_are_random_and_strictly_shaped() {
        let first = random_session_id().unwrap();
        let second = random_session_id().unwrap();
        assert!(valid_session_id(&first));
        assert_ne!(first, second);
        assert!(!valid_session_id("mcp-guessable"));
    }

    #[test]
    fn executable_validation_rejects_relative_paths_and_directories() {
        assert!(validate_executable("server.exe").is_err());
        assert!(validate_executable(std::env::temp_dir().to_string_lossy().as_ref()).is_err());
    }

    #[test]
    fn configuration_approval_binds_exact_secret_free_input() {
        let command = find_node();
        let configuration = McpServerConfiguration {
            workspace_id: "workspace-a".into(),
            id: "files".into(),
            display_name: "Local files".into(),
            transport: "stdio".into(),
            command: command.to_string_lossy().to_string(),
            args: vec!["--stdio".into(), "C:\\work".into()],
            endpoint: None,
            expected_revision: None,
        };
        validate_configuration_for_approval(&configuration).unwrap();
        let fingerprint = configuration_fingerprint(&configuration).unwrap();
        let approval = approval_for_configuration(
            &configuration,
            &fingerprint,
            "approval-1".into(),
            "2026-07-11T19:00:00Z".into(),
        );
        assert_eq!(approval.decisions, ["once", "deny"]);
        assert!(approval
            .data_used
            .iter()
            .all(|value| !value.contains("C:\\work")));

        let mut changed = configuration.clone();
        changed.args.push("--write".into());
        assert_ne!(
            configuration_fingerprint(&configuration).unwrap(),
            configuration_fingerprint(&changed).unwrap()
        );
        changed.args = vec!["--api-key=secret".into()];
        assert!(validate_configuration_for_approval(&changed).is_err());
    }
