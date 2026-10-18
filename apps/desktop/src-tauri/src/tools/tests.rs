//! Native tool approval and boundary regression tests.

use super::*;
use serde_json::json;

fn request(tool: &str) -> ToolExecutionRequest {
    let (mode, risk) = tool_policy(tool).unwrap_or(("full-access", "critical"));
    let now = crate::execution_approvals::wall_clock_consumed_at();
    serde_json::from_value(json!({
        "tool": tool, "arguments": {"query": "test"}, "approval": {
            "decision": "once", "decidedAt": now, "request": {
                "id": "connector-test", "service": "Mivlet", "action": tool,
                "mode": mode, "riskLevel": risk, "dataUsed": ["query: test"],
                "consequence": "Read data", "requestedAt": now, "decisions": ["once", "deny"]
            }
        }
    }))
    .unwrap()
}

fn persist_permit(path: &Path, request: &ToolExecutionRequest) {
    crate::execution_approvals::record_execution_decision(
        path,
        &crate::models::ApprovalResolutionResponse {
            persisted: true,
            audit_entry: crate::models::ApprovalAuditEntry {
                id: format!("permit-{}", request.approval.request.id),
                request_id: request.approval.request.id.clone(),
                decision: request.approval.decision.clone(),
                decided_at: request.approval.decided_at.clone(),
                note: "approved".into(),
            },
            effective_request: request.approval.request.clone(),
            dismissed: true,
            grant: None,
        },
    )
    .unwrap();
}

#[test]
fn browser_approval_binds_the_full_payload_beyond_bounded_previews() {
    let mut approved = request("local-browser-activate");
    approved.arguments = serde_json::json!({"activationRef":"a".repeat(48), "origin":format!("https://{}.example", "x".repeat(260))});
    approved.approval.request.data_used =
        approval_argument_previews(&approved.tool, &approved.arguments)
            .unwrap()
            .into_iter()
            .collect();
    approved
        .approval
        .request
        .data_used
        .push(argument_digest(&approved.arguments).unwrap());
    validate_tool_approval_binding(
        &approved.tool,
        &approved.arguments,
        &approved.approval.request,
    )
    .unwrap();
    let mut changed = approved.arguments.clone();
    changed["origin"] = format!("https://{}.different", "x".repeat(260)).into();
    assert!(
        validate_tool_approval_binding(&approved.tool, &changed, &approved.approval.request)
            .is_err()
    );
}

#[test]
fn browser_transfer_permits_bind_exact_payload_scope_freshness_and_consume_once() {
    for (tool, arguments, changes) in [
        (
            "local-browser-upload",
            json!({"uploadRef":"a".repeat(48),"origin":"https://example.test","name":"Upload report","artifactId":format!("artifact-{}","b".repeat(64))}),
            vec![
                ("artifactId", json!(format!("artifact-{}", "c".repeat(64)))),
                ("origin", json!("https://other.test")),
                ("name", json!("Other file field")),
                ("uploadRef", json!("d".repeat(48))),
            ],
        ),
        (
            "local-browser-download",
            json!({"downloadRef":"a".repeat(48),"origin":"https://example.test","name":"Download report","url":"https://example.test/report.csv","fileName":"report.csv","timeoutSeconds":8}),
            vec![
                ("downloadRef", json!("d".repeat(48))),
                ("origin", json!("https://other.test")),
                ("name", json!("Other download")),
                ("url", json!("https://example.test/other.csv")),
                ("fileName", json!("other.csv")),
                ("timeoutSeconds", json!(9)),
            ],
        ),
    ] {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("transfer-permits.json");
        let mut approved = request(tool);
        approved.arguments = arguments;
        approved.workspace_id = Some("workspace".into());
        approved.agent_id = Some("agent".into());
        approved.computer_generation = Some(7);
        approved.approval.request.data_used =
            approval_argument_previews(&approved.tool, &approved.arguments)
                .unwrap()
                .into_iter()
                .collect();
        approved.approval.request.data_used.extend([
            argument_digest(&approved.arguments).unwrap(),
            "Computer workspace: workspace".into(),
            "Computer agent: agent".into(),
            "Computer generation: 7".into(),
        ]);
        persist_permit(&path, &approved);
        for (key, value) in changes {
            let mut changed: ToolExecutionRequest =
                serde_json::from_value(serde_json::to_value(&approved).unwrap()).unwrap();
            changed.arguments[key] = value;
            assert!(verify_execution_permit(&path, &changed).is_err());
        }
        let mut wrong_generation: ToolExecutionRequest =
            serde_json::from_value(serde_json::to_value(&approved).unwrap()).unwrap();
        wrong_generation.computer_generation = Some(8);
        assert!(verify_execution_permit(&path, &wrong_generation).is_err());
        verify_execution_permit(&path, &approved).unwrap();
        assert!(verify_execution_permit(&path, &approved).is_err());

        let stale_path = root.path().join("stale-transfer-permits.json");
        let stale_time =
            decided_at_offset(-(crate::execution_approvals::EXECUTION_APPROVAL_TTL_SECONDS + 1));
        approved.approval.decided_at = stale_time.clone();
        approved.approval.request.requested_at = stale_time;
        persist_permit(&stale_path, &approved);
        assert!(verify_execution_permit(&stale_path, &approved).is_err());
    }
}

#[test]
fn native_handoff_round_trip_cannot_forge_change_or_reuse_a_permit() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("permits.json");
    let mut approved = request("workspace-start");
    approved.arguments = json!({"command":"node server.js","inputs":["server.js"],"network":false,"timeoutSeconds":60});
    approved.workspace_id = Some("workspace".into());
    approved.agent_id = Some("agent".into());
    approved.computer_generation = Some(7);
    approved.approval.request.data_used =
        approval_argument_previews(&approved.tool, &approved.arguments)
            .unwrap()
            .into_iter()
            .collect();
    approved.approval.request.data_used.extend([
        argument_digest(&approved.arguments).unwrap(),
        "Computer workspace: workspace".into(),
        "Computer agent: agent".into(),
        "Computer generation: 7".into(),
    ]);
    let encoded = serde_json::to_vec(&approved).unwrap();
    let mut received: ToolExecutionRequest = serde_json::from_slice(&encoded).unwrap();
    assert!(verify_execution_permit(&path, &received).is_err());
    persist_permit(&path, &approved);
    received.arguments["network"] = json!(true);
    assert!(verify_execution_permit(&path, &received).is_err());
    received = serde_json::from_slice(&encoded).unwrap();
    verify_execution_permit(&path, &received).unwrap();
    assert!(verify_execution_permit(&path, &received).is_err());
}

#[test]
fn repository_permits_bind_full_payload_scope_generation_and_consume_once() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("permits.json");
    let mut approved = request("repository-run");
    approved.arguments = json!({"repositoryId":"repo", "command":format!("{}true", "echo x; ".repeat(60)), "network":false, "timeoutSeconds":30});
    approved.workspace_id = Some("workspace".into());
    approved.agent_id = Some("agent".into());
    approved.computer_generation = Some(7);
    approved.approval.request.data_used =
        approval_argument_previews("repository-run", &approved.arguments)
            .unwrap()
            .into_iter()
            .collect();
    approved.approval.request.data_used.extend([
        argument_digest(&approved.arguments).unwrap(),
        "Computer workspace: workspace".into(),
        "Computer agent: agent".into(),
        "Computer generation: 7".into(),
    ]);
    persist_permit(&path, &approved);
    let original = approved.arguments.clone();
    approved.arguments["command"] = json!(format!("{}false", "echo x; ".repeat(60)));
    assert!(verify_tool_authority(&path, &approved).is_err());
    approved.arguments = original;
    approved.computer_generation = Some(8);
    assert!(verify_tool_authority(&path, &approved).is_err());
    approved.computer_generation = Some(7);
    approved.agent_id = Some("different-agent".into());
    assert!(verify_tool_authority(&path, &approved).is_err());
    approved.agent_id = Some("agent".into());
    verify_tool_authority(&path, &approved).unwrap();
    assert!(verify_tool_authority(&path, &approved).is_err());
}

#[test]
fn pull_request_permit_binds_target_payload_scope_and_consumes_once() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("permits.json");
    let mut approved = request("repository-pr-action");
    approved.arguments = json!({"repositoryId":"repo", "number":7, "action":"review", "remote":"https://github.com/example/repository.git", "expectedHead":"a".repeat(40), "headBranch":"mivlet/task", "baseSha":"b".repeat(40), "baseBranch":"main", "event":"COMMENT", "body":"long review ".repeat(80), "comments":[{"path":"sum.js", "line":2, "side":"RIGHT", "body":"Check overflow"}]});
    approved.workspace_id = Some("workspace".into());
    approved.agent_id = Some("agent".into());
    approved.computer_generation = Some(7);
    approved.approval.request.data_used =
        approval_argument_previews("repository-pr-action", &approved.arguments)
            .unwrap()
            .into_iter()
            .collect();
    approved.approval.request.data_used.extend([
        argument_digest(&approved.arguments).unwrap(),
        "Computer workspace: workspace".into(),
        "Computer agent: agent".into(),
        "Computer generation: 7".into(),
    ]);
    persist_permit(&path, &approved);
    let original = approved.arguments.clone();
    for (key, value) in original.as_object().unwrap() {
        approved.arguments = original.clone();
        approved.arguments[key] = if let Some(text) = value.as_str() {
            json!(format!("{text}changed"))
        } else if let Some(number) = value.as_u64() {
            json!(number + 1)
        } else {
            json!([])
        };
        assert!(
            verify_tool_authority(&path, &approved).is_err(),
            "substituted {key}"
        );
    }
    approved.arguments = original;
    approved.workspace_id = Some("other-workspace".into());
    assert!(verify_tool_authority(&path, &approved).is_err());
    approved.workspace_id = Some("workspace".into());
    approved.computer_generation = Some(8);
    assert!(verify_tool_authority(&path, &approved).is_err());
    approved.computer_generation = Some(7);
    verify_tool_authority(&path, &approved).unwrap();
    assert!(verify_tool_authority(&path, &approved).is_err());
}

#[test]
fn native_command_lifecycle_permits_bind_lifetime_target_and_generation() {
    for (tool, arguments, changes) in [
        (
            "repository-start",
            json!({"repositoryId":"repo", "command":"node server.js", "network":false, "timeoutSeconds":600}),
            vec![
                ("command", json!("node other.js")),
                ("repositoryId", json!("other")),
                ("network", json!(true)),
                ("timeoutSeconds", json!(601)),
            ],
        ),
        (
            "workspace-start",
            json!({"command":"node server.js", "inputs":["server.js"], "network":false, "timeoutSeconds":600}),
            vec![
                ("inputs", json!(["other.js"])),
                ("timeoutSeconds", json!(601)),
            ],
        ),
        (
            "command-stop",
            json!({"jobId":"job", "jobGeneration":7}),
            vec![("jobId", json!("other")), ("jobGeneration", json!(8))],
        ),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("permits.json");
        let mut approved = request(tool);
        approved.arguments = arguments.clone();
        approved.workspace_id = Some("workspace".into());
        approved.agent_id = Some("agent".into());
        approved.computer_generation = Some(7);
        approved.approval.request.data_used = approval_argument_previews(tool, &arguments)
            .unwrap()
            .into_iter()
            .collect();
        approved.approval.request.data_used.extend([
            argument_digest(&arguments).unwrap(),
            "Computer workspace: workspace".into(),
            "Computer agent: agent".into(),
            "Computer generation: 7".into(),
        ]);
        persist_permit(&path, &approved);
        for (field, value) in changes {
            approved.arguments = arguments.clone();
            approved.arguments[field] = value;
            assert!(
                verify_tool_authority(&path, &approved).is_err(),
                "{tool}/{field}"
            );
        }
        approved.arguments = arguments;
        verify_tool_authority(&path, &approved).unwrap();
        assert!(
            verify_tool_authority(&path, &approved).is_err(),
            "single-use {tool}"
        );
    }
}

#[test]
fn checkpoint_restore_permit_binds_every_hash_request_scope_and_is_single_use() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("checkpoint-permits.json");
    let mut approved = request("repository-checkpoint-restore");
    approved.arguments = json!({"repositoryId":"copy", "checkpointId":"saved", "expectedTree":"current", "expectedCheckpointTree":"checkpoint-tree", "expectedOutput":"output", "expectedHead":"head"});
    approved.workspace_id = Some("workspace".into());
    approved.agent_id = Some("agent".into());
    approved.computer_generation = Some(7);
    approved.approval.request.data_used =
        approval_argument_previews(&approved.tool, &approved.arguments)
            .unwrap()
            .into_iter()
            .collect();
    approved.approval.request.data_used.extend([
        argument_digest(&approved.arguments).unwrap(),
        "Computer workspace: workspace".into(),
        "Computer agent: agent".into(),
        "Computer generation: 7".into(),
    ]);
    persist_permit(&path, &approved);
    for field in [
        "repositoryId",
        "checkpointId",
        "expectedTree",
        "expectedCheckpointTree",
        "expectedOutput",
        "expectedHead",
    ] {
        let original = approved.arguments[field].clone();
        approved.arguments[field] = json!("substituted");
        assert!(
            verify_tool_authority(&path, &approved).is_err(),
            "accepted substituted {field}"
        );
        approved.arguments[field] = original;
    }
    let id = approved.approval.request.id.clone();
    approved.approval.request.id = "another-request".into();
    assert!(verify_tool_authority(&path, &approved).is_err());
    approved.approval.request.id = id;
    approved.workspace_id = Some("another-workspace".into());
    assert!(verify_tool_authority(&path, &approved).is_err());
    approved.workspace_id = Some("workspace".into());
    verify_tool_authority(&path, &approved).unwrap();
    assert!(verify_tool_authority(&path, &approved).is_err());
}

fn decided_at_offset(seconds: i64) -> String {
    (chrono::Utc::now() + chrono::Duration::seconds(seconds))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[test]
fn fetched_html_becomes_readable_traceable_untrusted_evidence() {
    let url = Url::parse("https://example.com/article?edition=uk#section").unwrap();
    let paragraph = "Mivlet keeps the useful article text and removes navigation noise. ".repeat(8);
    let html = format!(
            "<html><head><title>A useful page</title><meta name=\"author\" content=\"Ada Example\"></head><body><nav>Menu noise</nav><main><article><h1>A useful page</h1><p>{paragraph}</p></article></main><script>ignore_me()</script></body></html>"
        );

    let output = format_web_page_source(
        &html,
        &url,
        "text/html; charset=utf-8",
        "2026-09-07T12:00:00Z",
    );
    let source: serde_json::Value = serde_json::from_str(&output).unwrap();

    assert_eq!(source["trust"], "untrusted");
    assert_eq!(source["instructionAuthority"], "none");
    assert_eq!(source["title"], "A useful page");
    assert_eq!(source["finalUri"], "https://example.com/article?edition=uk");
    assert_eq!(source["fetchedAt"], "2026-09-07T12:00:00Z");
    assert_eq!(source["mediaType"], "text/html");
    assert_eq!(source["extraction"], "readability");
    assert!(source["citationId"]
        .as_str()
        .is_some_and(|id| id.starts_with("web-") && id.len() == 20));
    assert!(source["content"]
        .as_str()
        .unwrap()
        .contains("useful article text"));
    assert!(!source["content"].as_str().unwrap().contains("ignore_me"));
}

#[test]
fn fetched_text_is_bounded_and_keeps_a_stable_source_identity() {
    let url = Url::parse("https://example.com/data.txt").unwrap();
    let body = "x".repeat(WEB_FETCH_MAX_READABLE_CHARACTERS + 12);
    let first = format_web_page_source(&body, &url, "text/plain", "2026-09-07T12:00:00Z");
    let second =
        format_web_page_source("different body", &url, "text/plain", "2026-09-07T12:01:00Z");
    let first: serde_json::Value = serde_json::from_str(&first).unwrap();
    let second: serde_json::Value = serde_json::from_str(&second).unwrap();

    assert_eq!(first["citationId"], second["citationId"]);
    assert_eq!(first["extraction"], "plain-text");
    assert_eq!(first["truncated"], true);
    assert_eq!(
        first["content"].as_str().unwrap().chars().count(),
        WEB_FETCH_MAX_READABLE_CHARACTERS
    );
}

#[test]
fn computer_tools_require_an_explicit_representable_generation() {
    let mut request = request("run-shell");
    assert!(require_computer_generation(&request).is_err());
    request.computer_generation = Some(0);
    assert!(require_computer_generation(&request).is_err());
    request.computer_generation = Some(u64::MAX);
    assert!(require_computer_generation(&request).is_err());
    request.computer_generation = Some(42);
    assert_eq!(require_computer_generation(&request).unwrap(), 42);
    assert!(is_computer_tool("create-spreadsheet"));
    assert!(is_computer_tool("create-document"));
    assert!(is_computer_tool("generate-image"));
    assert!(is_computer_tool("edit-image"));
}

#[test]
fn approval_canonicalization_matches_ecmascript_fixtures_without_integer_collisions() {
    use serde_json::Value;
    let fixtures: Value = serde_json::from_str(include_str!(
        "../../../../packages/connectors/src/native-api/approval-canonical-fixtures.json"
    ))
    .unwrap();
    for fixture in fixtures.as_array().unwrap() {
        let arguments: Value = serde_json::from_str(fixture["raw"].as_str().unwrap()).unwrap();
        assert_eq!(
            canonical_json(&arguments).unwrap(),
            fixture["canonical"].as_str().unwrap(),
            "{}",
            fixture["name"]
        );
        assert_eq!(
            argument_digest(&arguments).unwrap(),
            fixture["digest"].as_str().unwrap(),
            "{}",
            fixture["name"]
        );
    }
    assert!(canonical_json(&json!({"value":9_007_199_254_740_992u64})).is_err());
    assert!(canonical_json(&json!({"value":9_007_199_254_740_993u64})).is_err());
    let arguments: Value =
        serde_json::from_str("{\"path\":\"report.pdf\",\"values\":[0.000001,1e-7,-0,1.0]}")
            .unwrap();
    let previews = approval_argument_previews("create-pdf", &arguments).unwrap();
    assert!(previews.contains("values: [0.000001,1e-7,0,1]"));
    assert_ne!(
        argument_digest(&json!({"value":1e-6})).unwrap(),
        argument_digest(&json!({"value":2e-6})).unwrap()
    );
}

#[test]
fn pdf_approval_rejects_changes_beyond_the_content_preview() {
    let tool = "create-pdf";
    let mut approved = request(tool);
    approved.arguments = json!({"path":"report.pdf","title":"Report","blocks":[{"type":"paragraph","text":format!("{}original", "x".repeat(400))}]});
    let preview = approval_argument_previews(tool, &approved.arguments).unwrap();
    approved.approval.request.data_used = preview
        .iter()
        .cloned()
        .chain(std::iter::once(
            argument_digest(&approved.arguments).unwrap(),
        ))
        .collect();
    validate_tool_approval_binding(tool, &approved.arguments, &approved.approval.request).unwrap();
    approved.arguments["blocks"][0]["text"] = json!(format!("{}changed", "x".repeat(400)));
    assert_eq!(
        approval_argument_previews(tool, &approved.arguments).unwrap(),
        preview
    );
    assert!(
        validate_tool_approval_binding(tool, &approved.arguments, &approved.approval.request)
            .is_err()
    );
    assert_eq!(tool_policy(tool), Some(("full-access", "high")));
    assert!(is_computer_tool(tool));
}

#[test]
fn workspace_execution_binds_command_inputs_outputs_network_and_timeout() {
    let tool = "workspace-run";
    let arguments = json!({"command":format!("{}echo original", "# long command\n".repeat(40)),"inputs":["data.csv"],"outputs":["report.csv"],"network":false,"timeoutSeconds":30});
    let mut approved = request(tool);
    approved.arguments = arguments.clone();
    approved.approval.request.data_used = approval_argument_previews(tool, &arguments)
        .unwrap()
        .into_iter()
        .chain(std::iter::once(argument_digest(&arguments).unwrap()))
        .collect();
    validate_tool_approval_binding(tool, &arguments, &approved.approval.request).unwrap();
    for (field, changed) in [
        (
            "command",
            json!(format!("{}echo changed", "# long command\n".repeat(40))),
        ),
        ("inputs", json!(["other.csv"])),
        ("outputs", json!(["other.csv"])),
        ("network", json!(true)),
        ("timeoutSeconds", json!(300)),
    ] {
        let mut changed_arguments = arguments.clone();
        changed_arguments[field] = changed;
        assert!(
            validate_tool_approval_binding(tool, &changed_arguments, &approved.approval.request)
                .is_err(),
            "{field}"
        );
    }
    assert_eq!(tool_policy(tool), Some(("full-access", "critical")));
    assert!(is_computer_tool(tool));
}

#[test]
fn office_approval_binds_full_canonical_payload_beyond_the_bounded_preview() {
    let mut approved = request("create-document");
    let long_text = format!("{}original tail", "x".repeat(300));
    approved.arguments = json!({
        "path": "reports/summary.docx",
        "title": "Summary",
        "blocks": [{ "type": "paragraph", "text": long_text }]
    });
    let mut data_used = approval_argument_previews("create-document", &approved.arguments)
        .unwrap()
        .into_iter()
        .collect::<Vec<_>>();
    data_used.push(argument_digest(&approved.arguments).unwrap());
    approved.approval.request.data_used = data_used;

    validate_tool_approval_binding(
        "create-document",
        &approved.arguments,
        &approved.approval.request,
    )
    .unwrap();

    let original_previews =
        approval_argument_previews("create-document", &approved.arguments).unwrap();
    approved.arguments["blocks"][0]["text"] = json!(format!("{}substituted tail", "x".repeat(300)));
    assert_eq!(
        original_previews,
        approval_argument_previews("create-document", &approved.arguments).unwrap()
    );
    assert!(validate_tool_approval_binding(
        "create-document",
        &approved.arguments,
        &approved.approval.request,
    )
    .is_err());

    approved.arguments["blocks"][0]["text"] = json!("alpha beta");
    assert_eq!(
        argument_digest(&approved.arguments).unwrap(),
        "Arguments SHA-256: e579a996abaf540431f607ca6f2c8ed746867ec36cc698f58ba4fd728c6c44a4"
    );
    let whitespace_previews =
        approval_argument_previews("create-document", &approved.arguments).unwrap();
    approved.approval.request.data_used = whitespace_previews
        .iter()
        .cloned()
        .chain(std::iter::once(
            argument_digest(&approved.arguments).unwrap(),
        ))
        .collect();
    validate_tool_approval_binding(
        "create-document",
        &approved.arguments,
        &approved.approval.request,
    )
    .unwrap();
    approved.arguments["blocks"][0]["text"] = json!("alpha  beta");
    assert_eq!(
        whitespace_previews,
        approval_argument_previews("create-document", &approved.arguments).unwrap()
    );
    assert!(validate_tool_approval_binding(
        "create-document",
        &approved.arguments,
        &approved.approval.request,
    )
    .is_err());
}

#[test]
fn image_tool_permit_binds_model_options_scope_and_is_single_use() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("approvals.json");
    let mut approved = request("generate-image");
    approved.arguments = json!({
        "prompt": "A quiet workspace",
        "model": "gpt-image-2",
        "size": "1024x1024",
        "quality": "medium",
        "title": "Workspace"
    });
    approved.workspace_id = Some("workspace-one".into());
    approved.agent_id = Some("agent-one".into());
    approved.computer_generation = Some(7);
    approved.approval.request.action = "generate-image exact request".into();
    approved.approval.request.data_used = vec![
        "model: gpt-image-2".into(),
        "prompt: A quiet workspace".into(),
        "quality: medium".into(),
        "size: 1024x1024".into(),
        "title: Workspace".into(),
        "Computer workspace: workspace-one".into(),
        "Computer agent: agent-one".into(),
        "Computer generation: 7".into(),
    ];
    let response = crate::models::ApprovalResolutionResponse {
        persisted: true,
        audit_entry: crate::models::ApprovalAuditEntry {
            id: "image-permit-test".into(),
            request_id: approved.approval.request.id.clone(),
            decision: "once".into(),
            decided_at: approved.approval.decided_at.clone(),
            note: "approved".into(),
        },
        effective_request: approved.approval.request.clone(),
        dismissed: true,
        grant: None,
    };
    crate::execution_approvals::record_execution_decision(&path, &response).unwrap();

    approved.arguments["model"] = json!("gpt-5");
    assert!(verify_tool_authority(&path, &approved).is_err());
    approved.arguments["model"] = json!("gpt-image-2");
    verify_tool_authority(&path, &approved).unwrap();
    assert!(verify_tool_authority(&path, &approved).is_err());
}

#[test]
fn protected_secret_approval_is_exact_scoped_and_single_use() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("approvals.json");
    let mut approved = request("request-secret");
    approved.workspace_id = Some("workspace-one".into());
    approved.agent_id = Some("agent-one".into());
    approved.computer_generation = Some(9);
    approved.arguments = json!({
        "label": "Release webhook",
        "reason": "Verify release notifications",
        "consumer": "webhook-signing-key",
        "purpose": "verify-webhook-signature",
        "targetId": "releases"
    });
    approved.approval.request.data_used =
        approval_argument_previews(&approved.tool, &approved.arguments)
            .unwrap()
            .into_iter()
            .chain([
                argument_digest(&approved.arguments).unwrap(),
                "Computer workspace: workspace-one".into(),
                "Computer agent: agent-one".into(),
                "Computer generation: 9".into(),
            ])
            .collect();
    assert!(verify_tool_authority(&path, &approved).is_err());
    persist_permit(&path, &approved);
    for field in ["consumer", "purpose", "targetId", "label", "reason"] {
        let original = approved.arguments[field].clone();
        approved.arguments[field] = json!("changed");
        assert!(verify_tool_authority(&path, &approved).is_err(), "{field}");
        approved.arguments[field] = original;
    }
    approved.computer_generation = Some(10);
    *approved.approval.request.data_used.last_mut().unwrap() = "Computer generation: 10".into();
    assert!(verify_tool_authority(&path, &approved).is_err());
    approved.computer_generation = Some(9);
    *approved.approval.request.data_used.last_mut().unwrap() = "Computer generation: 9".into();
    verify_tool_authority(&path, &approved).unwrap();
    assert!(verify_tool_authority(&path, &approved).is_err());
}

#[test]
fn computer_approval_scope_and_generation_are_bound_to_the_original_single_use_permit() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("approvals.json");
    let mut approved = request("run-shell");
    approved.workspace_id = Some("workspace-one".into());
    approved.agent_id = Some("agent-one".into());
    approved.computer_generation = Some(4);
    approved.approval.request.data_used.extend([
        "Computer workspace: workspace-one".into(),
        "Computer agent: agent-one".into(),
        "Computer generation: 4".into(),
    ]);
    let response = crate::models::ApprovalResolutionResponse {
        persisted: true,
        audit_entry: crate::models::ApprovalAuditEntry {
            id: "computer-scope-test".into(),
            request_id: approved.approval.request.id.clone(),
            decision: "once".into(),
            decided_at: approved.approval.decided_at.clone(),
            note: "approved".into(),
        },
        effective_request: approved.approval.request.clone(),
        dismissed: true,
        grant: None,
    };
    crate::execution_approvals::record_execution_decision(&path, &response).unwrap();
    approved.agent_id = Some("agent-two".into());
    assert!(verify_tool_authority(&path, &approved).is_err());
    approved.agent_id = Some("agent-one".into());
    approved.workspace_id = Some("workspace-two".into());
    assert!(verify_tool_authority(&path, &approved).is_err());
    approved.workspace_id = Some("workspace-one".into());
    approved.computer_generation = Some(5);
    assert!(verify_tool_authority(&path, &approved).is_err());
    // Rewriting the matching suffix cannot rebind the saved native permit.
    *approved.approval.request.data_used.last_mut().unwrap() = "Computer generation: 5".into();
    assert!(verify_tool_authority(&path, &approved).is_err());
    approved.computer_generation = Some(4);
    *approved.approval.request.data_used.last_mut().unwrap() = "Computer generation: 4".into();
    verify_tool_authority(&path, &approved).unwrap();
    assert!(verify_tool_authority(&path, &approved).is_err());
}

#[test]
fn native_connector_reads_do_not_require_a_persisted_user_prompt() {
    let path = std::env::temp_dir()
        .join(format!("mivlet-no-read-permits-{}", std::process::id()))
        .join("missing.json");
    for tool in [
        "gmail-read",
        "google-drive-read",
        "google-calendar-read",
        "github-read",
        "vercel-read",
        "linear-read",
        "search-notion",
        "search-slack",
    ] {
        verify_tool_authority(&path, &request(tool)).expect(tool);
    }
    assert!(
        !path.exists(),
        "Read consent must not fabricate a user decision record"
    );
    for tool in [
        "write-file",
        "run-shell",
        "connection-read",
        "web-fetch",
        "connector-call",
    ] {
        assert!(
            verify_tool_authority(&path, &request(tool)).is_err(),
            "{tool} must retain its permit boundary"
        );
    }
}

#[test]
fn read_consent_rejects_changed_arguments_policy_and_denial() {
    let path = Path::new("unused-read-permit.json");
    let mut changed = request("gmail-read");
    changed.arguments = json!({"query": "different"});
    assert!(verify_tool_authority(path, &changed).is_err());
    let mut denied = request("gmail-read");
    denied.approval.decision = "deny".into();
    assert!(verify_tool_authority(path, &denied).is_err());
    let mut downgraded = request("gmail-read");
    downgraded.approval.request.risk_level = "low".into();
    assert!(verify_tool_authority(path, &downgraded).is_err());
}

#[test]
fn tool_authority_rejects_stale_permits_against_wall_clock_consume_time() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("approvals.json");
    let mut approved = request("web-fetch");
    let decided_at =
        decided_at_offset(-(crate::execution_approvals::EXECUTION_APPROVAL_TTL_SECONDS + 1));
    approved.approval.decided_at = decided_at.clone();
    approved.approval.request.requested_at = decided_at;
    persist_permit(&path, &approved);
    let error = verify_tool_authority(&path, &approved)
        .expect_err("reusing decided_at as consumed_at would keep this permit inside the TTL");
    assert!(
        error.contains("stale"),
        "expected the freshness fence, got {error}"
    );
}

#[test]
fn tool_authority_records_wall_clock_consume_time_not_decided_at() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("approvals.json");
    let mut approved = request("web-fetch");
    let decided_at = decided_at_offset(-30);
    approved.approval.decided_at = decided_at.clone();
    approved.approval.request.requested_at = decided_at.clone();
    persist_permit(&path, &approved);
    verify_tool_authority(&path, &approved).expect("permit within the TTL consumes");
    let records: Vec<serde_json::Value> =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let consumed = records[0]["consumedAt"]
        .as_str()
        .expect("consume must persist wall-clock time");
    assert_ne!(
        consumed, decided_at,
        "production consume must not reuse decided_at as consumed_at"
    );
}

#[test]
fn webview_synthesized_once_without_a_native_permit_cannot_execute() {
    let path = std::env::temp_dir().join(format!(
        "fable-webview-mint-{}-{}",
        std::process::id(),
        "missing.json"
    ));
    let _ = std::fs::remove_file(&path);
    let mut forged = request("web-fetch");
    forged.approval.decision = "once".into();
    let error =
        verify_tool_authority(&path, &forged).expect_err("WebView JSON is not a minted permit");
    assert!(
        error.contains("no persisted user approval"),
        "expected a missing native permit, got {error}"
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn standing_session_or_rule_decision_cannot_authorize_execution() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("approvals.json");
    for decision in ["session", "rule"] {
        let mut approved = request("web-fetch");
        approved.approval.decision = decision.into();
        persist_permit(&path, &approved);
        let error = verify_tool_authority(&path, &approved).expect_err(decision);
        assert!(
            error.contains("standing session/rule"),
            "expected standing-grant refusal, got {error}"
        );
        // The native permit must remain unconsumed so a later once-resolution
        // can still use the user decision recorded by resolve_approval_request.
        crate::execution_approvals::verify_and_consume_execution_approval(
            &path,
            &approved.approval.request,
            &crate::execution_approvals::wall_clock_consumed_at(),
        )
        .unwrap_or_else(|_| panic!("{decision} permit must remain consumable after refusal"));
    }
}

#[test]
fn execute_tool_call_checks_workspace_pause_before_permit_consume() {
    let source = include_str!("tools.rs");
    let start = source
        .find("pub async fn execute_tool_call")
        .expect("execute_tool_call");
    let body = &source[start..];
    let pause = body
        .find("ensure_active_execution_allowed")
        .expect("pause gate on execute_tool_call");
    let consume = body
        .find("verify_tool_authority")
        .expect("permit consume on execute_tool_call");
    assert!(
        pause < consume,
        "paused workspaces must fail closed before a permit is consumed"
    );
}
