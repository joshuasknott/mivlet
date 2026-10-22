use super::*;
use reqwest::StatusCode;

#[test]
fn endpoint_is_pinned_and_rejects_query_or_traversal() {
    assert_eq!(
        transport::endpoint("/v1/me").unwrap().as_str(),
        "https://api.instabox.sh/v1/me"
    );
    assert!(transport::endpoint("https://evil.example").is_err());
    assert!(transport::endpoint("/v1/me?key=secret").is_err());
    assert!(transport::endpoint("/v1/../me").is_err());
    assert_eq!(
        transport::endpoint("/v1/operations/op_123?wait=25s")
            .unwrap()
            .as_str(),
        "https://api.instabox.sh/v1/operations/op_123?wait=25s"
    );
    assert!(transport::endpoint("/v1/operations/op_123?key=secret").is_err());
}

#[test]
fn machine_summary_is_metadata_only() {
    let m = machine_summary(
        &json!({"id":"m-1","name":"My Linux","status":"paused","apiKey":"do-not-copy"}),
    )
    .unwrap();
    assert_eq!(m.id, "m-1");
    assert_eq!(m.status, "paused");
}

#[test]
fn status_errors_do_not_echo_api_responses() {
    assert!(transport::map_status(StatusCode::UNAUTHORIZED).contains("API key"));
    assert!(!transport::map_status(StatusCode::UNAUTHORIZED).contains("secret"));
}

#[test]
fn usage_reads_nested_limits_without_copying_remote_payload() {
    let parsed = usage(&json!({
        "machines": 1,
        "snapshots": 2,
        "limits": {"machines": 4, "snapshots": 8}
    }));
    assert_eq!(parsed.machine_count, Some(1));
    assert_eq!(parsed.machine_limit, Some(4));
    assert_eq!(parsed.snapshot_count, Some(2));
    assert_eq!(parsed.snapshot_limit, Some(8));
}

#[test]
fn usage_keeps_missing_limits_unbounded() {
    let parsed = usage(&json!({"machines": 1, "snapshots": 2, "limits": {}}));
    assert_eq!(parsed.machine_count, Some(1));
    assert_eq!(parsed.machine_limit, None);
    assert_eq!(parsed.snapshot_count, Some(2));
    assert_eq!(parsed.snapshot_limit, None);
}

#[test]
fn unknown_operation_replay_expires_at_exactly_seven_days() {
    let now = IDEMPOTENCY_TTL_MS + 10_000_000_i64;
    assert!(replay_is_within_idempotency_window(
        now - IDEMPOTENCY_TTL_MS,
        now
    ));
    assert!(!replay_is_within_idempotency_window(
        now - IDEMPOTENCY_TTL_MS - 1,
        now
    ));
    assert!(!replay_is_within_idempotency_window(0, now));
    assert!(!replay_is_within_idempotency_window(now + 1, now));
}

#[test]
fn operation_identity_uses_instabox_operation_id_or_id() {
    assert_eq!(
        pick_string(&json!({"id": "op_123"}), &["operationId", "id"]),
        Some("op_123".into())
    );
    assert_eq!(
        pick_string(&json!({"operationId": "op_456"}), &["operationId", "id"]),
        Some("op_456".into())
    );
}

#[test]
fn create_completion_requires_one_exact_machine_identity() {
    let pending = PendingOperation {
        idempotency_key: "idem".into(),
        action: "create".into(),
        machine_id: "pending".into(),
        operation_id: Some("op_123".into()),
        path: "/v1/machines".into(),
        body: json!({"name":"one"}),
        created_at_ms: 1,
        desktop_start_approved: true,
    };
    assert_eq!(
        create_machine_id(
            &json!({"machineId":"m_abc"}),
            &json!({"machineId":"m_abc","state":"succeeded"}),
            &pending
        )
        .unwrap(),
        "m_abc"
    );
    assert!(create_machine_id(
        &json!({"machineId":"m_abc"}),
        &json!({"machineId":"m_other","state":"succeeded"}),
        &pending
    )
    .is_err());
    assert!(create_machine_id(
        &Value::Null,
        &json!({"id":"op_123","state":"succeeded"}),
        &pending
    )
    .is_err());
}

#[test]
fn desktop_start_is_queued_once_for_exact_machine() {
    let mut saved = SavedConnection::default();
    queue_desktop_start(&mut saved, "m_abc").unwrap();
    queue_desktop_start(&mut saved, "m_abc").unwrap();
    assert_eq!(saved.pending.len(), 1);
    assert_eq!(saved.pending[0].action, "desktop-start");
    assert_eq!(saved.pending[0].machine_id, "m_abc");
    assert_eq!(saved.pending[0].body["action"], "start");
}

#[test]
fn desktop_start_requires_provider_running_confirmation() {
    assert!(desktop_start_succeeded(&json!({"running": true})));
    assert!(!desktop_start_succeeded(&json!({"running": false})));
    assert!(!desktop_start_succeeded(&json!({"installed": true})));
}

#[test]
fn legacy_pending_create_does_not_gain_desktop_start_approval() {
    let pending: PendingOperation = serde_json::from_value(json!({
        "idempotencyKey": "idem",
        "action": "create",
        "machineId": "pending",
        "operationId": "op_123",
        "path": "/v1/machines",
        "body": {"name": "old"},
        "createdAtMs": 1
    }))
    .unwrap();
    assert!(!pending.desktop_start_approved);
}

#[test]
fn preference_fields_use_renderer_camel_case() {
    let preference: AgentComputerPreference = serde_json::from_value(json!({
        "kind": "instabox",
        "machineId": "m_123",
        "connectionRevision": 4
    }))
    .unwrap();
    assert_eq!(
        serde_json::to_value(preference).unwrap(),
        json!({"kind":"instabox","machineId":"m_123","connectionRevision":4})
    );
}

#[test]
fn stale_status_revision_is_rejected_instead_of_relabelled() {
    assert!(status::status_revision_matches(7, 7));
    assert!(!status::status_revision_matches(7, 8));
}

#[test]
fn preference_rejects_zero_revision_or_invalid_machine_id() {
    assert!(
        validate_agent_computer_preference(&AgentComputerPreference::Instabox {
            machine_id: "m_123".into(),
            connection_revision: 1,
        })
        .is_ok()
    );
    assert!(
        validate_agent_computer_preference(&AgentComputerPreference::Instabox {
            machine_id: "".into(),
            connection_revision: 1,
        })
        .is_err()
    );
    assert!(
        validate_agent_computer_preference(&AgentComputerPreference::Instabox {
            machine_id: "m_123".into(),
            connection_revision: 0,
        })
        .is_err()
    );
}
