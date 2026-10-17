use super::{models::*, *};
use serde_json::json;
pub(super) fn binding() -> Binding {
    serde_json::from_value(json!({"version":1,"taskId":"task-unit","admissionId":"admit-unit","runId":"run-unit","workspaceId":"workspace-unit","agentId":"agent-unit","workId":"work-unit","workGeneration":2,"conversationId":"conversation-unit","conversationGeneration":1,"expectedSequence":1,"inputSha256":"0".repeat(64),"providerId":"openai","model":"fixture-model","credentialId":"credential-unit","credentialRevision":1,"budget":{"maxModelCalls":1,"maxOutputTokens":4096,"maxElapsedMs":120000,"maxResultBytes":65536},"expiresAt":10000})).unwrap()
}
#[test]
fn canonical_hash_matches_exact_ordered_json_and_preserves_text_bytes() {
    let raw = json!({"z": [{"b":2,"a":"line\n✓"}], "a":1});
    let expected = r#"{"a":1,"z":[{"a":"line\n✓","b":2}]}"#;
    assert_eq!(serde_json::to_string(&canonical(&raw)).unwrap(), expected);
    assert_eq!(
        digest_value(&raw).unwrap(),
        hex::encode(Sha256::digest(expected.as_bytes()))
    );
    assert_ne!(
        digest_value(&raw).unwrap(),
        digest_value(&json!({"z":[{"b":2,"a":"line ✓"}],"a":1})).unwrap()
    );
}
#[test]
fn local_paths_and_shared_credential_markers_are_refused_before_cloud_admission() {
    assert!(!text_failure("Explain why seasons change."));
    for value in [
        r"Read C:\Users\unit\secret.txt",
        "Read /home/unit/private.txt",
        "Read file:///tmp/input.txt",
        "Bearer abcdefghijklmnopqrstuvwxyz1234567890",
    ] {
        assert!(text_failure(value));
    }
}
#[test]
fn receipt_requires_exact_binding_checksum_budget_and_monotonic_native_sequence() {
    let b = binding();
    let text = "A fixture answer.";
    let snapshot = TaskSnapshot {
        binding: b.clone(),
        generation: 1,
        status: "completed".into(),
        sequence: 3,
        result_sha256: Some(hex::encode(Sha256::digest(text.as_bytes()))),
        result_bytes: text.len(),
        usage: None,
        error_code: None,
        created_at: 1000,
        updated_at: 2000,
        retained_until: 1000 + 86_400_000,
    };
    let result = TaskResult {
        snapshot,
        text: text.into(),
    };
    validate_result(&b, None, &result).unwrap();
    let mut changed = result.clone();
    changed.text.push('!');
    assert!(validate_result(&b, None, &changed).is_err());
    let mut changed = result.clone();
    changed.snapshot.binding.work_generation += 1;
    assert!(validate_result(&b, None, &changed).is_err());
    let mut changed = result.clone();
    changed.snapshot.sequence -= 1;
    assert!(validate_result(&b, Some(&result.snapshot), &changed).is_err());
    let mut changed = result.clone();
    changed.snapshot.usage = Some(
        json!({"inputTokens":1,"outputTokens":4097,"costUsd":0,"costEstimated":true,"costUnknown":true}),
    );
    assert!(validate_result(&b, None, &changed).is_err());
    let mut changed = result.clone();
    changed.snapshot.status = "running".into();
    assert!(validate_result(&b, None, &changed).is_err());
}
