    fn connected_source_continuation() -> McpSemanticContinuation {
        McpSemanticContinuation {
            kind: "mcp-connected-source-search",
            proposal: McpToolProposal {
                workspace_id: "workspace-authoritative".into(),
                session_id: "mcp-1234567890abcdef1234567890abcdef".into(),
                tool_name: "search".into(),
                arguments: serde_json::json!({}),
            },
            permit_id: "permit-authoritative".into(),
            workspace_id: "workspace-authoritative".into(),
            project_id: Some("project-authoritative".into()),
            query: "quarterly planning".into(),
            connection_id: "connection-authoritative".into(),
            matched_grant_ids: vec!["grant-authoritative".into()],
            degraded: true,
            degradation_reasons: vec!["connection-health-unknown-or-degraded".into()],
        }
    }

    fn valid_connected_source_result() -> Value {
        serde_json::json!({
            "content": [],
            "isError": false,
            "structuredContent": {
                "contractVersion": "fable.connected-source-search.v1",
                "query": "quarterly planning",
                "citations": [{
                    "sourceId": "  document-7  ",
                    "title": "  Planning notes  ",
                    "snippet": "  Revenue assumptions and launch milestones.  ",
                    "uri": "https://work.example.com/docs/7",
                    "provenance": "  Connected Drive  ",
                    "freshness": "  2026-07-11T20:00:00Z  "
                }],
                "nextCursor": "  page-2  "
            }
        })
    }

    #[test]
    fn connected_source_result_is_normalized_with_only_native_authority() {
        let normalized = normalize_mcp_connected_source_search(
            &valid_connected_source_result(),
            &connected_source_continuation(),
        )
        .unwrap();
        let encoded = serde_json::to_value(normalized).unwrap();

        assert_eq!(
            encoded["contractVersion"],
            "fable.connected-source-search.v1"
        );
        assert_eq!(encoded["capabilityId"], "knowledge.content.search");
        assert_eq!(encoded["query"], "quarterly planning");
        assert_eq!(encoded["scope"]["workspaceId"], "workspace-authoritative");
        assert_eq!(encoded["scope"]["projectId"], "project-authoritative");
        assert_eq!(encoded["connectionId"], "connection-authoritative");
        assert_eq!(
            encoded["matchedGrantIds"],
            serde_json::json!(["grant-authoritative"])
        );
        assert_eq!(encoded["trust"], "external-untrusted");
        assert_eq!(encoded["instructionAuthority"], "none");
        assert_eq!(encoded["degraded"], true);
        assert_eq!(
            encoded["degradationReasons"],
            serde_json::json!(["connection-health-unknown-or-degraded"])
        );
        assert_eq!(
            encoded["implementation"],
            serde_json::json!({ "kind": "mcp", "evidence": "adapter-validated" })
        );
        assert_eq!(encoded["citations"][0]["citationId"], "source-1");
        assert_eq!(encoded["citations"][0]["sourceId"], "document-7");
        assert_eq!(encoded["citations"][0]["title"], "Planning notes");
        assert_eq!(encoded["citations"][0]["trust"], "external-untrusted");
        assert_eq!(encoded["nextCursor"], "page-2");
    }

    #[test]
    fn mission_attestation_requires_a_native_observed_correlated_response() {
        let permit_id = "mcp-semantic-permit-no-response";
        mission_mcp_outcomes().lock().unwrap().remove(permit_id);
        let error = attest_mission_mcp_connected_search(AttestMissionMcpSearchRequest {
            permit_id: permit_id.into(),
        })
        .unwrap_err();
        assert!(error.contains("native-observed"));
    }

    #[test]
    fn connected_source_result_rejects_authority_and_scope_substitution() {
        for field in [
            "trust",
            "instructionAuthority",
            "scope",
            "capabilityId",
            "connectionId",
            "matchedGrantIds",
            "implementation",
            "degraded",
            "degradationReasons",
        ] {
            let mut result = valid_connected_source_result();
            result["structuredContent"][field] = serde_json::json!("server-controlled");
            assert!(
                normalize_mcp_connected_source_search(&result, &connected_source_continuation())
                    .is_err(),
                "accepted server-owned top-level field {field}"
            );
        }

        for field in [
            "citationId",
            "trust",
            "instructionAuthority",
            "connectionId",
        ] {
            let mut result = valid_connected_source_result();
            result["structuredContent"]["citations"][0][field] =
                serde_json::json!("server-controlled");
            assert!(
                normalize_mcp_connected_source_search(&result, &connected_source_continuation())
                    .is_err(),
                "accepted server-owned citation field {field}"
            );
        }
    }

    #[test]
    fn connected_source_result_fails_closed_on_mismatch_malformed_and_oversize() {
        let continuation = connected_source_continuation();
        let mut attacks = Vec::new();

        let mut wrong_version = valid_connected_source_result();
        wrong_version["structuredContent"]["contractVersion"] = serde_json::json!("v2");
        attacks.push(wrong_version);
        let mut wrong_query = valid_connected_source_result();
        wrong_query["structuredContent"]["query"] = serde_json::json!("different query");
        attacks.push(wrong_query);
        let mut unsafe_scheme = valid_connected_source_result();
        unsafe_scheme["structuredContent"]["citations"][0]["uri"] =
            serde_json::json!("javascript:alert(1)");
        attacks.push(unsafe_scheme);
        let mut credentials = valid_connected_source_result();
        credentials["structuredContent"]["citations"][0]["uri"] =
            serde_json::json!("https://user:password@work.example.com/private");
        attacks.push(credentials);
        let mut citation_authority = valid_connected_source_result();
        citation_authority["structuredContent"]["citations"][0]["sourceId"] =
            serde_json::json!("bad\nsource");
        attacks.push(citation_authority);
        let mut error = valid_connected_source_result();
        error["isError"] = serde_json::json!(true);
        attacks.push(error);
        let mut malformed_content = valid_connected_source_result();
        malformed_content["content"] = serde_json::json!([{ "type": "tool_result" }]);
        attacks.push(malformed_content);
        let mut too_many = valid_connected_source_result();
        too_many["structuredContent"]["citations"] = Value::Array(
            (0..=MAX_CONNECTED_SOURCE_CITATIONS)
                .map(|_| {
                    serde_json::json!({
                        "sourceId": "source",
                        "title": "title",
                        "snippet": "snippet",
                        "provenance": "source",
                        "freshness": "now"
                    })
                })
                .collect(),
        );
        attacks.push(too_many);
        let mut oversized = valid_connected_source_result();
        oversized["structuredContent"]["citations"][0]["snippet"] =
            Value::String("x".repeat(MAX_MCP_STRUCTURED_CHARACTERS + 1));
        attacks.push(oversized);

        for attack in attacks {
            assert!(normalize_mcp_connected_source_search(&attack, &continuation).is_err());
        }
        assert!(normalize_mcp_connected_source_search(&Value::Null, &continuation).is_err());
        assert!(normalize_mcp_connected_source_search(
            &serde_json::json!({ "content": [], "structuredContent": [] }),
            &continuation
        )
        .is_err());
    }
