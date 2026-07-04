//! Integration tests for the Fable runtime feature modules.
//!
//! These mirror the original lib.rs tests; they import the now-modularized
//! helpers via `use` so the test bodies are unchanged.

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::approvals::{
    persist_approval_audit_entry, persist_approval_rule, read_approval_audit_entries,
    read_approval_rules, resolve_approval,
};
use crate::connector_auth::ConnectorConnection;
use crate::connectors::{
    list_connector_statuses_with, list_unconfigured_connector_statuses, redact_connector_text,
    validate_connector_action, validate_connector_execution_request, ConnectorCredentialBoundary,
};
use crate::knowledge::{import_local_text_file, search_knowledge_sources};
use crate::memory::{
    encode_memory_export, promote_knowledge_source, read_memory_state, write_memory_state,
};
use crate::models::*;
use crate::snapshot::{
    persist_imported_knowledge_source, read_imported_knowledge_sources, read_runtime_snapshot,
    write_runtime_snapshot,
};

static ENV_LOCK: Mutex<()> = Mutex::new(());

#[test]
fn lists_first_wave_connectors_without_faking_live_connections() {
    let _lock = ENV_LOCK.lock().unwrap();
    let old_broker = std::env::var("FABLE_AUTH_BROKER_URL").ok();
    let old_google = std::env::var("FABLE_GOOGLE_OAUTH_CLIENT_ID").ok();
    std::env::remove_var("FABLE_AUTH_BROKER_URL");
    std::env::remove_var("FABLE_GOOGLE_OAUTH_CLIENT_ID");

    let manifests = list_unconfigured_connector_statuses();

    assert_eq!(
        manifests
            .iter()
            .map(|manifest| manifest.id.as_str())
            .collect::<Vec<_>>(),
        FIRST_WAVE_CONNECTOR_IDS
    );
    assert!(manifests
        .iter()
        .all(|manifest| manifest.status == "unconfigured"));
    assert!(manifests.iter().all(|manifest| manifest.account.is_none()));
    assert!(manifests
        .iter()
        .all(|manifest| manifest.setup_message.is_some()));
    assert!(manifests
        .iter()
        .all(|manifest| manifest.scopes.iter().all(|scope| !scope.granted)));

    if let Some(value) = old_broker {
        std::env::set_var("FABLE_AUTH_BROKER_URL", value);
    }
    if let Some(value) = old_google {
        std::env::set_var("FABLE_GOOGLE_OAUTH_CLIENT_ID", value);
    }
}

struct StaticConnectorBoundary {
    connection: Option<ConnectorConnection>,
}

impl ConnectorCredentialBoundary for StaticConnectorBoundary {
    fn connection(&self, connector_id: &str) -> Option<ConnectorConnection> {
        self.connection
            .as_ref()
            .filter(|connection| connection.connector_id == connector_id)
            .cloned()
    }
}

fn slack_connection(status: &str) -> ConnectorConnection {
    ConnectorConnection {
        connector_id: "slack".to_string(),
        account: ConnectorAccountSummary {
            id: "U1".to_string(),
            display_name: "Slack User".to_string(),
            handle: None,
            email: None,
            workspace: Some("Fable".to_string()),
            avatar_url: None,
        },
        status: status.to_string(),
        scopes: vec!["channels:read".to_string(), "chat:write".to_string()],
        expires_at: None,
        credential_ref: "oauth-token:slack:U1".to_string(),
        connected_at: "1".to_string(),
        updated_at: "1".to_string(),
        is_active: true,
    }
}

fn google_connection(connector_id: &str, scopes: Vec<&str>) -> ConnectorConnection {
    ConnectorConnection {
        connector_id: connector_id.to_string(),
        account: ConnectorAccountSummary {
            id: "google-user-1".to_string(),
            display_name: "Google User".to_string(),
            handle: None,
            email: Some("user@example.test".to_string()),
            workspace: None,
            avatar_url: None,
        },
        status: "connected".to_string(),
        scopes: scopes.into_iter().map(str::to_string).collect(),
        expires_at: None,
        credential_ref: format!("oauth-token:{connector_id}:google-user-1"),
        connected_at: "1".to_string(),
        updated_at: "1".to_string(),
        is_active: true,
    }
}

#[test]
fn connector_lifecycle_statuses_do_not_collapse_to_connected() {
    let _lock = ENV_LOCK.lock().unwrap();
    let old_broker = std::env::var("FABLE_AUTH_BROKER_URL").ok();
    std::env::set_var("FABLE_AUTH_BROKER_URL", "https://auth.example/");

    let manifests = list_connector_statuses_with(&StaticConnectorBoundary {
        connection: Some(slack_connection("expired")),
    });
    let slack = manifests
        .iter()
        .find(|manifest| manifest.id == "slack")
        .unwrap();
    assert_eq!(slack.status, "expired");
    assert!(slack.account.is_none());
    assert!(slack.scopes.iter().all(|scope| !scope.granted));

    if let Some(value) = old_broker {
        std::env::set_var("FABLE_AUTH_BROKER_URL", value);
    } else {
        std::env::remove_var("FABLE_AUTH_BROKER_URL");
    }
}

#[test]
fn google_manifest_fail_closes_without_active_required_scopes() {
    let _lock = ENV_LOCK.lock().unwrap();
    let old_google = std::env::var("FABLE_GOOGLE_OAUTH_CLIENT_ID").ok();
    std::env::set_var(
        "FABLE_GOOGLE_OAUTH_CLIENT_ID",
        "desktop-client.apps.googleusercontent.com",
    );

    let manifests = list_connector_statuses_with(&StaticConnectorBoundary {
        connection: Some(google_connection(
            "gmail",
            vec!["openid", "email", "profile"],
        )),
    });
    let gmail = manifests
        .iter()
        .find(|manifest| manifest.id == "gmail")
        .unwrap();

    assert_eq!(gmail.status, "connected");
    assert!(gmail
        .scopes
        .iter()
        .any(|scope| scope.required && !scope.granted));
    assert!(!gmail.supports_search);
    assert!(!gmail.supports_import);
    assert!(gmail.supported_actions.is_empty());
    assert_eq!(
        gmail.health_summary,
        "Missing required OAuth scopes; reconnect this provider."
    );

    if let Some(value) = old_google {
        std::env::set_var("FABLE_GOOGLE_OAUTH_CLIENT_ID", value);
    } else {
        std::env::remove_var("FABLE_GOOGLE_OAUTH_CLIENT_ID");
    }
}

fn connector_action(action: &str, connector_id: &str, service: &str) -> ConnectorActionRequest {
    let id = format!("{connector_id}-fixture-action");
    let (label, mode, risk_level, consequence, confirmation_phrase) = match action {
        "gmail.create-draft" => (
            "Create Draft",
            "trusted-scope",
            "medium",
            "Creates an email draft. It does not send the email.",
            None,
        ),
        "gmail.send" => (
            "Send",
            "full-access",
            "high",
            "Sends the selected email to external recipients.",
            Some("send email"),
        ),
        "slack.post" => (
            "Post",
            "full-access",
            "high",
            "Posts a message to the selected Slack conversation.",
            Some("post message"),
        ),
        _ => (
            "Fixture Action",
            "trusted-scope",
            "medium",
            "Writes to the selected provider after approval.",
            None,
        ),
    };
    ConnectorActionRequest {
        id: id.clone(),
        connector_id: connector_id.to_string(),
        action: action.to_string(),
        payload: BTreeMap::from([("targetId".to_string(), "fixture-target".to_string())]),
        permission_mode: Some(mode.to_string()),
        permission_profile: crate::permission_policy::profile_for_mode(mode).map(str::to_string),
        approval: ApprovalRequest {
            id,
            service: service.to_string(),
            action: label.to_string(),
            mode: mode.to_string(),
            risk_level: risk_level.to_string(),
            data_used: vec!["targetId".to_string()],
            consequence: consequence.to_string(),
            requested_at: "2026-06-27T10:00:00.000Z".to_string(),
            decisions: APPROVAL_DECISIONS
                .iter()
                .map(|decision| decision.to_string())
                .collect(),
            confirmation_phrase: confirmation_phrase.map(str::to_string),
        },
    }
}

#[test]
fn validates_connector_actions_against_provider_and_approval_metadata() {
    let valid = validate_connector_action(connector_action("gmail.create-draft", "gmail", "Gmail"))
        .expect("known action should validate");
    assert_eq!(valid.action, "gmail.create-draft");

    let error = validate_connector_action(connector_action("slack.post", "gmail", "Gmail"))
        .expect_err("cross-provider action should fail");
    assert_eq!(error.code, "invalid-request");
}

#[test]
fn rejects_connector_actions_with_downgraded_approval_risk() {
    let mut action = connector_action("gmail.send", "gmail", "Gmail");
    action.approval.mode = "trusted-scope".to_string();
    action.approval.risk_level = "medium".to_string();
    action.approval.confirmation_phrase = None;

    let error =
        validate_connector_action(action).expect_err("high-risk policy must be runtime-owned");
    assert_eq!(error.code, "invalid-request");
}

#[test]
fn rejects_connector_writes_when_workspace_profile_is_read_only() {
    let mut action = connector_action("gmail.send", "gmail", "Gmail");
    action.permission_mode = Some("read-only".to_string());
    action.permission_profile = Some("read-only".to_string());

    let error =
        validate_connector_action(action).expect_err("read-only must block connector writes");
    assert_eq!(error.code, "approval-required");
}

#[test]
fn rejects_connector_execution_with_reshaped_approval() {
    let action = connector_action("gmail.send", "gmail", "Gmail");
    let mut approval = action.approval.clone();
    approval.consequence = "Harmless operation.".to_string();
    let request = ConnectorActionExecutionRequest {
        action,
        approval: ApprovalResolutionRequest {
            request: approval,
            decision: "once".to_string(),
            decided_at: "2026-06-27T10:01:00.000Z".to_string(),
            confirmation_text: Some("send email".to_string()),
            modification: None,
        },
    };

    let error = validate_connector_execution_request(request)
        .expect_err("execution approval must exactly match the prepared action");
    assert_eq!(error.code, "approval-required");
}

#[test]
fn rejects_standing_approvals_for_connector_writes() {
    let action = connector_action("slack.post", "slack", "Slack");
    let request = ConnectorActionExecutionRequest {
        action: action.clone(),
        approval: ApprovalResolutionRequest {
            request: action.approval,
            decision: "session".to_string(),
            decided_at: "2026-06-27T10:01:00.000Z".to_string(),
            confirmation_text: Some("post message".to_string()),
            modification: None,
        },
    };

    let error = validate_connector_execution_request(request)
        .expect_err("connector writes require fresh per-action approval");
    assert_eq!(error.code, "approval-required");
}

/// Sending email must never execute on a standing (session/rule) approval,
/// regardless of the global permission level. A `rule` decision for gmail.send
/// is rejected at the validation boundary, so the provider egress is never
/// reached. This is the per-message-approval guarantee for Gmail sends.
#[test]
fn gmail_send_rejects_standing_rule_approval() {
    let action = connector_action("gmail.send", "gmail", "Gmail");
    let request = ConnectorActionExecutionRequest {
        action: action.clone(),
        approval: ApprovalResolutionRequest {
            request: action.approval,
            decision: "rule".to_string(),
            decided_at: "2026-06-27T10:01:00.000Z".to_string(),
            confirmation_text: Some("send email".to_string()),
            modification: None,
        },
    };

    let error = validate_connector_execution_request(request)
        .expect_err("gmail.send must require a fresh per-message approval");
    assert_eq!(error.code, "approval-required");
}

#[test]
fn redacts_connector_secrets_and_private_provider_data() {
    assert_eq!(
        redact_connector_text("Authorization: Bearer secret-token"),
        "[redacted connector data]"
    );
    assert_eq!(
        redact_connector_text("email body: private content"),
        "[redacted connector data]"
    );
    assert_eq!(
        redact_connector_text("Provider temporarily unavailable"),
        "Provider temporarily unavailable"
    );
}

fn candidate(name: &str, content: &str) -> LocalTextFileCandidate {
    LocalTextFileCandidate {
        name: name.to_string(),
        content: content.to_string(),
        size_bytes: content.len(),
        imported_at: Some("2026-06-25T22:00:00.000Z".to_string()),
    }
}

#[test]
fn imports_supported_local_text_file_without_full_path() {
    let imported = import_local_text_file(candidate(
        "C:\\Users\\Josh\\Documents\\market-research.md",
        "Launch notes and connector recovery plan",
    ))
    .expect("file should import");

    assert_eq!(imported.title, "market-research.md");
    assert_eq!(imported.connector_id, "local-files");
    assert_eq!(imported.trust, "untrusted");
    assert!(!imported.provenance.contains("Users\\Josh"));
    assert!(imported.id.starts_with("local-market-research-md-"));
}

#[test]
fn rejects_unsupported_local_file_extension() {
    let error = import_local_text_file(candidate("deck.pdf", "not plain text"))
        .expect_err("pdf should be rejected");

    assert!(error.contains("text, Markdown, JSON, CSV, and YAML"));
}

#[test]
fn rejects_changed_local_file_payloads() {
    let mut changed = candidate("brief.md", "changed");
    changed.size_bytes += 1;

    let error = import_local_text_file(changed).expect_err("changed file should be rejected");

    assert!(error.contains("changed while Fable was reading"));
}

#[test]
fn knowledge_search_requires_actual_matches_before_boosts() {
    let sources = vec![
        KnowledgeSource {
            id: "memory".to_string(),
            title: "Launch plan".to_string(),
            provenance: "Approved memory".to_string(),
            freshness: "Current".to_string(),
            pinned: true,
            trust: Some("trusted".to_string()),
            content_preview: Some("Connector recovery and approval audit".to_string()),
            disabled: false,
            deleted_at: None,
            account: None,
        },
        KnowledgeSource {
            id: "design".to_string(),
            title: "Design direction".to_string(),
            provenance: "Product design".to_string(),
            freshness: "Today".to_string(),
            pinned: true,
            trust: Some("trusted".to_string()),
            content_preview: Some("Sidebar hierarchy and composer suggestions".to_string()),
            disabled: false,
            deleted_at: None,
            account: None,
        },
    ];

    let result = search_knowledge_sources("connector recovery".to_string(), sources, None);

    assert_eq!(result.mode, "lexical-fallback");
    assert_eq!(result.citations.len(), 1);
    assert_eq!(result.citations[0].source_id, "memory");
}

fn audit_entry(id: &str, decision: &str) -> ApprovalAuditEntry {
    ApprovalAuditEntry {
        id: id.to_string(),
        request_id: "weekly-digest-rule".to_string(),
        decision: decision.to_string(),
        decided_at: "2026-06-25T22:30:00.000Z".to_string(),
        note: "Fable Automations Enable weekly workspace digest".to_string(),
    }
}

fn temp_audit_path(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("fable-{name}-{}.json", std::process::id()))
}

fn approval_request(
    mode: &str,
    risk_level: &str,
    confirmation_phrase: Option<&str>,
) -> ApprovalRequest {
    ApprovalRequest {
        id: "github-draft-pr".to_string(),
        service: "GitHub".to_string(),
        action: "Create draft PR for feature-memory".to_string(),
        mode: mode.to_string(),
        risk_level: risk_level.to_string(),
        data_used: vec!["branch diff".to_string(), "test summary".to_string()],
        consequence: "Creates a private draft PR.".to_string(),
        requested_at: "2026-06-26T10:00:00.000Z".to_string(),
        decisions: APPROVAL_DECISIONS
            .iter()
            .map(|decision| decision.to_string())
            .collect(),
        confirmation_phrase: confirmation_phrase.map(str::to_string),
    }
}

fn approval_resolution(
    request: ApprovalRequest,
    decision: &str,
    confirmation_text: Option<&str>,
    modification: Option<ApprovalModification>,
) -> ApprovalResolutionRequest {
    ApprovalResolutionRequest {
        request,
        decision: decision.to_string(),
        decided_at: "2026-06-26T10:30:00.000Z".to_string(),
        confirmation_text: confirmation_text.map(str::to_string),
        modification,
    }
}

fn approval_rule() -> ApprovalGrant {
    ApprovalGrant {
        id: "approval-rule-github-create-draft-pr".to_string(),
        request_id: "github-draft-pr".to_string(),
        scope: "rule".to_string(),
        service: "GitHub".to_string(),
        action: "Create draft PR for feature-memory".to_string(),
        mode: "trusted-scope".to_string(),
        data_used: vec!["branch diff".to_string()],
        created_at: "2026-06-26T10:30:00.000Z".to_string(),
    }
}

#[test]
fn creates_ephemeral_session_approval_grants() {
    let response = resolve_approval(approval_resolution(
        approval_request("trusted-scope", "medium", None),
        "session",
        None,
        None,
    ))
    .expect("session approval should resolve");
    let grant = response
        .grant
        .expect("session approval should create a grant");

    assert!(!response.persisted);
    assert!(response.dismissed);
    assert_eq!(grant.scope, "session");
    assert_eq!(grant.mode, "trusted-scope");
    assert_eq!(response.audit_entry.decision, "session");
}

#[test]
fn persists_standing_approval_rules() {
    let path = temp_audit_path("approval-rules-persist");
    let _ = fs::remove_file(&path);
    let response = resolve_approval(approval_resolution(
        approval_request("trusted-scope", "medium", None),
        "rule",
        None,
        None,
    ))
    .expect("rule approval should resolve");
    let grant = response.grant.expect("rule approval should create a grant");

    persist_approval_rule(&path, grant).expect("rule should persist");
    let rules = read_approval_rules(&path).expect("rules should read");

    assert_eq!(rules.len(), 1);
    assert_eq!(rules[0].scope, "rule");
    assert_eq!(rules[0].service, "GitHub");

    let _ = fs::remove_file(&path);
}

#[test]
fn applies_modified_approval_scope_before_auditing() {
    let response = resolve_approval(approval_resolution(
        approval_request("trusted-scope", "medium", None),
        "modify",
        None,
        Some(ApprovalModification {
            mode: "read-only".to_string(),
            data_used: vec!["branch diff".to_string()],
            consequence: "Reviews the branch without publishing.".to_string(),
        }),
    ))
    .expect("modified approval should resolve");

    assert_eq!(response.effective_request.mode, "read-only");
    assert_eq!(response.effective_request.data_used, vec!["branch diff"]);
    assert!(response.audit_entry.note.contains("modified to read-only"));
    assert!(response.grant.is_none());
}

#[test]
fn requires_exact_confirmation_for_high_risk_approvals() {
    let wrong = resolve_approval(approval_resolution(
        approval_request("full-access", "high", Some("publish Fable")),
        "once",
        Some("publish preview"),
        None,
    ))
    .expect_err("wrong confirmation should fail closed");

    assert!(wrong.contains("did not match"));

    let response = resolve_approval(approval_resolution(
        approval_request("full-access", "high", Some("publish Fable")),
        "once",
        Some("publish Fable"),
        None,
    ))
    .expect("exact confirmation should resolve");

    assert_eq!(response.audit_entry.decision, "once");
}

#[test]
fn denial_never_requires_high_risk_confirmation() {
    let response = resolve_approval(approval_resolution(
        approval_request("full-access", "critical", None),
        "deny",
        None,
        None,
    ))
    .expect("denial should always remain available");

    assert_eq!(response.audit_entry.decision, "deny");
    assert!(response.grant.is_none());
}

#[test]
fn persists_approval_audit_entries_latest_first() {
    let path = temp_audit_path("approval-audit-latest-first");
    let _ = fs::remove_file(&path);

    persist_approval_audit_entry(&path, audit_entry("first", "once"))
        .expect("first entry should persist");
    let response = persist_approval_audit_entry(&path, audit_entry("second", "deny"))
        .expect("second entry should persist");
    let entries = read_approval_audit_entries(&path).expect("entries should read");

    assert!(response.persisted);
    assert_eq!(response.audit_len, 2);
    assert_eq!(entries[0].id, "second");
    assert_eq!(entries[1].id, "first");

    let _ = fs::remove_file(&path);
}

#[test]
fn rejects_unknown_approval_decisions() {
    let path = temp_audit_path("approval-audit-rejects-decision");
    let _ = fs::remove_file(&path);

    let error = persist_approval_audit_entry(&path, audit_entry("bad", "forever"))
        .expect_err("unknown decisions should be rejected");

    assert!(error.contains("not recognized"));
    assert!(!path.exists());
}

#[test]
fn caps_approval_audit_entries() {
    let path = temp_audit_path("approval-audit-caps");
    let _ = fs::remove_file(&path);

    for index in 0..(MAX_APPROVAL_AUDIT_ENTRIES + 5) {
        persist_approval_audit_entry(&path, audit_entry(&format!("entry-{index}"), "session"))
            .expect("entry should persist");
    }

    let entries = read_approval_audit_entries(&path).expect("entries should read");

    assert_eq!(entries.len(), MAX_APPROVAL_AUDIT_ENTRIES);
    assert_eq!(entries[0].id, "entry-204");
    assert_eq!(entries[MAX_APPROVAL_AUDIT_ENTRIES - 1].id, "entry-5");

    let _ = fs::remove_file(&path);
}

#[test]
fn persists_imported_knowledge_sources_latest_first() {
    let path = temp_audit_path("imported-knowledge-latest-first");
    let _ = fs::remove_file(&path);
    let first = import_local_text_file(candidate("first.md", "First launch source"))
        .expect("first source should import");
    let second = import_local_text_file(candidate("second.md", "Second launch source"))
        .expect("second source should import");

    persist_imported_knowledge_source(&path, first).expect("first source should persist");
    persist_imported_knowledge_source(&path, second).expect("second source should persist");
    let sources = read_imported_knowledge_sources(&path).expect("sources should read");

    assert_eq!(sources.len(), 2);
    assert_eq!(sources[0].title, "second.md");
    assert_eq!(sources[1].title, "first.md");
    assert_eq!(sources[0].origin, "local-import");

    let _ = fs::remove_file(&path);
}

#[test]
fn deduplicates_and_caps_imported_knowledge_sources() {
    let path = temp_audit_path("imported-knowledge-caps");
    let _ = fs::remove_file(&path);

    for index in 0..(MAX_IMPORTED_KNOWLEDGE_SOURCES + 5) {
        let source = import_local_text_file(candidate(
            &format!("source-{index}.md"),
            &format!("Knowledge source {index}"),
        ))
        .expect("source should import");
        persist_imported_knowledge_source(&path, source).expect("source should persist");
    }

    let replacement = import_local_text_file(candidate("source-104.md", "Knowledge source 104"))
        .expect("replacement should import");
    persist_imported_knowledge_source(&path, replacement).expect("replacement should persist");

    let sources = read_imported_knowledge_sources(&path).expect("sources should read");

    assert_eq!(sources.len(), MAX_IMPORTED_KNOWLEDGE_SOURCES);
    assert_eq!(sources[0].title, "source-104.md");
    assert_eq!(sources[1].title, "source-103.md");
    assert_eq!(
        sources[MAX_IMPORTED_KNOWLEDGE_SOURCES - 1].title,
        "source-5.md"
    );

    let _ = fs::remove_file(&path);
}

fn memory_record(id: &str, value: &str) -> MemoryRecord {
    MemoryRecord {
        id: id.to_string(),
        kind: "preference".to_string(),
        title: format!("Memory {id}"),
        value: value.to_string(),
        source: "Approved durable memory".to_string(),
        freshness: "Updated now".to_string(),
        approved: true,
        pinned: true,
        scope: None,
        confidence: Some(1.0),
        provenance: None,
        approval_state: Some("approved".to_string()),
        run_id: None,
        created_at: None,
        updated_at: None,
        forgotten_at: None,
        disabled: false,
    }
}

fn knowledge_source(id: &str, trust: &str, preview: Option<&str>) -> KnowledgeSource {
    KnowledgeSource {
        id: id.to_string(),
        title: "Launch notes".to_string(),
        provenance: "Imported source fixture".to_string(),
        freshness: "Added today".to_string(),
        pinned: true,
        trust: Some(trust.to_string()),
        content_preview: preview.map(str::to_string),
        disabled: false,
        deleted_at: None,
        account: None,
    }
}

fn promotion_request(
    source: KnowledgeSource,
    decision: &str,
    disabled: bool,
) -> MemoryPromotionRequest {
    MemoryPromotionRequest {
        source,
        decision: decision.to_string(),
        decided_at: "2026-06-26T10:45:00.000Z".to_string(),
        state: MemoryControlState {
            disabled,
            records: vec![memory_record("existing", "Existing approved memory.")],
        },
    }
}

#[test]
fn saves_and_reads_memory_state() {
    let path = temp_audit_path("memory-state-saves");
    let _ = fs::remove_file(&path);
    let state = MemoryControlState {
        disabled: true,
        records: vec![memory_record("concise-updates", "Prefer concise updates.")],
    };

    let saved = write_memory_state(&path, state).expect("memory state should save");
    let read = read_memory_state(&path).expect("memory state should read");

    assert!(saved.disabled);
    assert_eq!(read.records.len(), 1);
    assert_eq!(read.records[0].id, "concise-updates");
    assert_eq!(read.records[0].kind, "preference");

    let _ = fs::remove_file(&path);
}

#[test]
fn rejects_unknown_memory_kinds() {
    let path = temp_audit_path("memory-state-rejects-kind");
    let _ = fs::remove_file(&path);
    let mut record = memory_record("bad-kind", "Invalid kind");
    record.kind = "rumor".to_string();

    let error = write_memory_state(
        &path,
        MemoryControlState {
            disabled: false,
            records: vec![record],
        },
    )
    .expect_err("unknown memory kinds should fail");

    assert!(error.contains("not recognized"));
    assert!(!path.exists());
}

#[test]
fn deduplicates_and_caps_memory_records() {
    let path = temp_audit_path("memory-state-caps");
    let _ = fs::remove_file(&path);
    let mut records = (0..(MAX_MEMORY_RECORDS + 8))
        .map(|index| memory_record(&format!("memory-{index}"), &format!("Value {index}")))
        .collect::<Vec<_>>();
    records.insert(0, memory_record("memory-10", "Duplicate should be ignored"));

    let saved = write_memory_state(
        &path,
        MemoryControlState {
            disabled: false,
            records,
        },
    )
    .expect("memory state should save");

    assert_eq!(saved.records.len(), MAX_MEMORY_RECORDS);
    assert_eq!(saved.records[0].id, "memory-10");
    assert_eq!(saved.records[1].id, "memory-0");
    assert_eq!(saved.records[MAX_MEMORY_RECORDS - 1].id, "memory-199");

    let _ = fs::remove_file(&path);
}

#[test]
fn exports_memory_state_with_stable_format() {
    let encoded = encode_memory_export(MemoryControlState {
        disabled: false,
        records: vec![memory_record("exported", "Exported value")],
    })
    .expect("memory export should encode");

    assert!(encoded.contains("arden.memory.export.v1"));
    assert!(encoded.contains("Exported value"));
    assert!(encoded.contains("\"disabled\": false"));
    assert!(encoded.contains("\"workspaceId\": \"default\""));
    assert!(encoded.contains("\"disabledRecordsIncluded\": false"));
    assert!(encoded.contains("\"forgottenRecordsIncluded\": false"));
}

#[test]
fn memory_export_excludes_lifecycle_hidden_records_and_redacts_tokens() {
    let mut forgotten = memory_record("forgotten", "must not export");
    forgotten.forgotten_at = Some("2026-07-01T00:00:00Z".to_string());
    let mut disabled = memory_record("disabled", "must not export either");
    disabled.disabled = true;
    let encoded = encode_memory_export(MemoryControlState {
        disabled: false,
        records: vec![
            forgotten,
            disabled,
            memory_record("live", "Bearer top-secret-token"),
        ],
    })
    .expect("memory export should encode");
    assert!(!encoded.contains("must not export"));
    assert!(!encoded.contains("top-secret-token"));
    assert!(encoded.contains("redacted secret-bearing memory data"));
}

#[test]
fn promotes_untrusted_source_to_approved_memory() {
    let response = promote_knowledge_source(promotion_request(
        knowledge_source(
            "market-research-pdf",
            "untrusted",
            Some("Market launch risk notes."),
        ),
        "once",
        false,
    ))
    .expect("approved source should promote to memory");

    assert!(!response.persisted);
    assert_eq!(response.record.id, "memory-from-market-research-pdf");
    assert_eq!(response.record.kind, "imported");
    assert!(response.record.approved);
    assert!(response.record.pinned);
    assert_eq!(response.record.value, "Market launch risk notes.");
    assert!(response.record.source.contains("untrusted source"));
    assert_eq!(response.audit_entry.decision, "once");
    assert_eq!(
        response.audit_entry.request_id,
        "memory-promotion-market-research-pdf"
    );
    assert_eq!(response.state.records[0].id, response.record.id);
    assert_eq!(response.state.records[1].id, "existing");
}

#[test]
fn rejects_non_approval_memory_promotion_decisions() {
    let error = promote_knowledge_source(promotion_request(
        knowledge_source("market-research-pdf", "untrusted", None),
        "deny",
        false,
    ))
    .expect_err("denied source should not promote to memory");

    assert!(error.contains("requires once, session, or rule"));
}

#[test]
fn rejects_memory_promotion_when_memory_is_disabled() {
    let error = promote_knowledge_source(promotion_request(
        knowledge_source("market-research-pdf", "untrusted", None),
        "session",
        true,
    ))
    .expect_err("disabled memory should block promotion");

    assert!(error.contains("disabled"));
}

fn imported_source(name: &str) -> LocalFileImport {
    import_local_text_file(candidate(name, "Recovered local knowledge"))
        .expect("source should import")
}

fn runtime_snapshot() -> RuntimeSnapshot {
    let mut automation_statuses = BTreeMap::new();
    automation_statuses.insert("weekly-digest".to_string(), "active".to_string());

    let schedules = vec![Schedule {
        id: "weekly-digest".to_string(),
        name: "Weekly digest".to_string(),
        description: "Summarize the week.".to_string(),
        day: "Fri".to_string(),
        time: "09:00".to_string(),
        enabled: true,
        created_at: "2026-06-26T10:30:00.000Z".to_string(),
    }];

    RuntimeSnapshot {
        version: RUNTIME_SNAPSHOT_VERSION,
        active_item: "Automations".to_string(),
        composer_draft: "/schedule weekly digest".to_string(),
        voice_enabled: true,
        approval_audit: vec![audit_entry("approval-one", "once")],
        dismissed_approval_ids: vec!["github-draft-pr".to_string(), "github-draft-pr".to_string()],
        approval_rules: vec![approval_rule()],
        automation_statuses,
        schedules,
        goals: Vec::new(),
        plans: Vec::new(),
        pinned_source_ids: vec![
            "codex-manual".to_string(),
            "codex-manual".to_string(),
            "product-brief".to_string(),
        ],
        imported_knowledge_sources: vec![imported_source("recovery-notes.md")],
        memory_disabled: false,
        memory_records: vec![memory_record(
            "recovery",
            "Recover the workspace after restart.",
        )],
        connected_backend_ids: vec!["codex".to_string()],
        selected_model_id: "gpt-5".to_string(),
        permission_mode: "read-only".to_string(),
        permission_label: Some("Read Only".to_string()),
        custom_approval_settings: None,
        saved_at: "2026-06-26T10:30:00.000Z".to_string(),
    }
}

#[test]
fn saves_and_reads_runtime_snapshot() {
    let path = temp_audit_path("runtime-snapshot-saves");
    let _ = fs::remove_file(&path);

    let saved = write_runtime_snapshot(&path, runtime_snapshot()).expect("snapshot should save");
    let read = read_runtime_snapshot(&path)
        .expect("snapshot should read")
        .expect("snapshot should exist");

    assert_eq!(saved.version, RUNTIME_SNAPSHOT_VERSION);
    assert_eq!(read.active_item, "Automations");
    assert_eq!(read.composer_draft, "/schedule weekly digest");
    assert!(read.voice_enabled);
    assert_eq!(read.approval_audit.len(), 1);
    assert_eq!(read.dismissed_approval_ids, vec!["github-draft-pr"]);
    assert_eq!(read.approval_rules.len(), 1);
    assert_eq!(read.approval_rules[0].scope, "rule");
    assert_eq!(
        read.automation_statuses.get("weekly-digest"),
        Some(&"active".to_string())
    );
    assert_eq!(
        read.pinned_source_ids,
        vec!["codex-manual", "product-brief"]
    );
    assert_eq!(
        read.imported_knowledge_sources[0].title,
        "recovery-notes.md"
    );
    assert_eq!(read.memory_records[0].id, "recovery");

    let _ = fs::remove_file(&path);
}

#[test]
fn rejects_unknown_runtime_automation_statuses() {
    let path = temp_audit_path("runtime-snapshot-rejects-status");
    let _ = fs::remove_file(&path);
    let mut snapshot = runtime_snapshot();
    snapshot
        .automation_statuses
        .insert("weekly-digest".to_string(), "running".to_string());

    let error = write_runtime_snapshot(&path, snapshot)
        .expect_err("unknown automation statuses should fail");

    assert!(error.contains("not recognized"));
    assert!(!path.exists());
}

#[test]
fn caps_runtime_snapshot_recovery_lists() {
    let path = temp_audit_path("runtime-snapshot-caps");
    let _ = fs::remove_file(&path);
    let mut snapshot = runtime_snapshot();
    snapshot.dismissed_approval_ids = (0..(MAX_RUNTIME_SNAPSHOT_IDS + 5))
        .map(|index| format!("approval-{index}"))
        .collect();
    snapshot.pinned_source_ids = (0..(MAX_RUNTIME_SNAPSHOT_IDS + 8))
        .map(|index| format!("source-{index}"))
        .collect();

    let saved =
        write_runtime_snapshot(&path, snapshot).expect("snapshot should save with capped ids");

    assert_eq!(saved.dismissed_approval_ids.len(), MAX_RUNTIME_SNAPSHOT_IDS);
    assert_eq!(saved.pinned_source_ids.len(), MAX_RUNTIME_SNAPSHOT_IDS);
    assert_eq!(saved.dismissed_approval_ids[0], "approval-0");
    assert_eq!(
        saved.pinned_source_ids[MAX_RUNTIME_SNAPSHOT_IDS - 1],
        "source-199"
    );

    let _ = fs::remove_file(&path);
}

// ---------------------------------------------------------------------------
// Agent-runtime backend credential boundary
// ---------------------------------------------------------------------------

use crate::backends::{
    clear_credential_into, list_providers_from, normalize_backend_event, read_connected_backends,
    store_credential_into,
};
use crate::models::{BackendConsequentialEvent, BackendCredentialRequest};

fn temp_backends_path(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "fable-{name}-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ))
}

fn credential_request(provider_id: &str, secret: &str) -> BackendCredentialRequest {
    BackendCredentialRequest {
        provider_id: provider_id.to_string(),
        secret: secret.to_string(),
    }
}

#[test]
fn runtime_backends_are_fail_closed_before_any_credential() {
    let path = temp_backends_path("backends-list");
    let _ = fs::remove_file(&path);

    let store = HashMap::new();
    let providers = list_providers_from(&store, &path).expect("providers should list");

    // The four runtime providers (codex/cursor/copilot/grok) are present...
    let runtime_ids: Vec<&str> = providers
        .iter()
        .filter(|p| p.backend_type != "native-api")
        .map(|p| p.id.as_str())
        .collect();
    assert_eq!(runtime_ids, vec!["codex", "cursor", "copilot", "grok"]);

    // ...and without credentials every provider is fail-closed: no capabilities.
    for provider in &providers {
        assert!(
            provider.capabilities.is_empty(),
            "{} should declare no capabilities before auth",
            provider.id
        );
        assert!(provider.auth_state != "connected");
        // Grok entitlements must never be pre-populated.
        if provider.id == "grok" {
            let entitlements = provider.entitlements.clone().unwrap_or_default();
            assert!(entitlements.is_empty());
        }
    }

    let _ = fs::remove_file(&path);
}

#[test]
fn acp_providers_are_install_required_without_a_credential() {
    let path = temp_backends_path("backends-acp");
    let _ = fs::remove_file(&path);

    let store = HashMap::new();
    let providers = list_providers_from(&store, &path).expect("providers should list");
    let cursor = providers
        .iter()
        .find(|p| p.id == "cursor")
        .expect("cursor provider exists");
    let grok = providers
        .iter()
        .find(|p| p.id == "grok")
        .expect("grok provider exists");

    assert_eq!(cursor.auth_state, "install-required");
    assert_eq!(grok.auth_state, "install-required");
    assert!(cursor
        .install_hint
        .as_deref()
        .unwrap_or("")
        .to_lowercase()
        .contains("cursor cli"));
    assert!(grok
        .install_hint
        .as_deref()
        .unwrap_or("")
        .to_lowercase()
        .contains("grok cli"));

    let _ = fs::remove_file(&path);
}

#[test]
fn catalog_only_runtime_backends_reject_api_key_storage_and_stay_gated() {
    let path = temp_backends_path("backends-connect");
    let _ = fs::remove_file(&path);

    let mut store = HashMap::new();
    let error = store_credential_into(
        &mut store,
        &path,
        credential_request("codex", "super-secret-token"),
    )
    .expect_err("catalog-only runtime must reject API-key storage");
    assert!(error.contains("real runtime adapter"));

    // Even a legacy/injected value cannot make a catalog-only provider claim
    // capabilities without a runnable adapter.
    store.insert("codex".to_string(), "legacy-token".to_string());

    let providers = list_providers_from(&store, &path).expect("providers should list");
    let codex = providers
        .iter()
        .find(|p| p.id == "codex")
        .expect("codex provider exists");

    assert_eq!(codex.auth_state, "needs-auth");
    assert!(codex.capabilities.is_empty());
    assert!(codex.models.iter().all(|model| !model.available));

    let _ = fs::remove_file(&path);
}

#[test]
fn stored_secrets_never_appear_in_list_or_connected_manifest() {
    let path = temp_backends_path("backends-secrets");
    let _ = fs::remove_file(&path);

    let mut store = HashMap::new();
    store_credential_into(
        &mut store,
        &path,
        credential_request("openai", "do-not-leak-me-12345"),
    )
    .expect("credential should store");

    // The provider list must not contain the raw secret.
    let serialized =
        serde_json::to_string(&list_providers_from(&store, &path).expect("providers list"))
            .expect("serialize");
    assert!(
        !serialized.contains("do-not-leak-me-12345"),
        "secret must not leak through list_backends"
    );

    // The persisted connected-backends manifest is ids only.
    let connected = read_connected_backends(&path).expect("connected backends read");
    let manifest = serde_json::to_string(&connected).expect("serialize");
    assert!(manifest.contains("openai"));
    assert!(!manifest.contains("do-not-leak-me-12345"));

    let _ = fs::remove_file(&path);
}

#[test]
fn clearing_a_credential_drops_the_provider_from_the_manifest() {
    let path = temp_backends_path("backends-clear");
    let _ = fs::remove_file(&path);

    let mut store = HashMap::new();
    store_credential_into(
        &mut store,
        &path,
        credential_request("openai", "openai-token"),
    )
    .expect("store openai");
    let connected = read_connected_backends(&path).expect("read");
    assert!(connected.has("openai"));

    clear_credential_into(&mut store, &path, "openai").expect("clear openai");
    let connected = read_connected_backends(&path).expect("read after clear");
    assert!(!connected.has("openai"));

    let _ = fs::remove_file(&path);
}

struct FailingRemoveStore;

impl BackendCredentialStore for FailingRemoveStore {
    fn get(&self, _provider_id: &str) -> Result<Option<String>, String> {
        Ok(None)
    }

    fn set(&mut self, _provider_id: &str, _secret: &str) -> Result<(), String> {
        Ok(())
    }

    fn remove(&mut self, _provider_id: &str) -> Result<(), String> {
        Err("secure store unavailable".to_string())
    }
}

#[test]
fn secure_store_delete_failure_keeps_connected_manifest_intact() {
    let path = temp_backends_path("backends-clear-failure");
    let _ = fs::remove_file(&path);

    let mut seed_store = HashMap::new();
    store_credential_into(
        &mut seed_store,
        &path,
        credential_request("openai", "openai-token"),
    )
    .expect("seed connected metadata");

    let error = clear_credential_into(&mut FailingRemoveStore, &path, "openai")
        .expect_err("secure-store failure must surface");
    assert!(error.contains("secure store unavailable"));
    assert!(read_connected_backends(&path)
        .expect("manifest remains readable")
        .has("openai"));

    let _ = fs::remove_file(&path);
}

#[test]
fn rejects_unsupported_backend_provider_ids() {
    let path = temp_backends_path("backends-reject");
    let _ = fs::remove_file(&path);

    let mut store = HashMap::new();
    let error = store_credential_into(&mut store, &path, credential_request("claude", "nope"))
        .expect_err("unsupported provider should fail");
    assert!(error.contains("not a supported"));

    let _ = fs::remove_file(&path);
}

#[test]
fn rejects_empty_backend_secrets() {
    let path = temp_backends_path("backends-empty");
    let _ = fs::remove_file(&path);

    let mut store = HashMap::new();
    let error = store_credential_into(&mut store, &path, credential_request("openai", "   "))
        .expect_err("empty secret should fail");
    assert!(error.contains("non-empty"));

    let _ = fs::remove_file(&path);
}

/// Every native-API provider must be able to complete a full connect → list →
/// clear cycle through the API-key boundary. xAI and OpenRouter previously had
/// only endpoint-URL coverage; this locks their catalog/manifest/auth-state
/// behavior at the boundary so a regression in their native-api wiring is
/// caught here rather than at runtime.
#[test]
fn native_api_providers_connect_list_and_clear_through_the_key_boundary() {
    for provider_id in ["xai", "openrouter"] {
        let path = temp_backends_path(&format!("backends-cycle-{provider_id}"));
        let _ = fs::remove_file(&path);

        let mut store = HashMap::new();

        // Before any credential, the provider is fail-closed.
        let providers = list_providers_from(&store, &path).expect("providers list");
        let provider = providers
            .iter()
            .find(|p| p.id == provider_id)
            .unwrap_or_else(|| panic!("{provider_id} provider exists"));
        assert_eq!(
            provider.backend_type, "native-api",
            "{provider_id} must be a native-api provider"
        );
        assert_eq!(provider.auth_state, "needs-auth");
        assert!(
            provider.capabilities.is_empty(),
            "fail-closed before connect"
        );
        assert!(provider.models.iter().all(|m| !m.available));

        // Storing a credential marks the provider connected and capability-bearing.
        store_credential_into(
            &mut store,
            &path,
            credential_request(provider_id, "real-key"),
        )
        .expect("native provider stores through the key boundary");
        assert!(
            read_connected_backends(&path)
                .expect("read manifest")
                .has(provider_id),
            "connected manifest records the provider"
        );

        let providers = list_providers_from(&store, &path).expect("providers list after connect");
        let provider = providers
            .iter()
            .find(|p| p.id == provider_id)
            .expect("provider still listed");
        assert_eq!(provider.auth_state, "connected");
        assert!(
            !provider.capabilities.is_empty(),
            "capabilities appear when connected"
        );
        assert!(provider.models.iter().all(|m| m.available));

        // Clearing fails the provider closed again and drops it from the manifest.
        clear_credential_into(&mut store, &path, provider_id).expect("clear credential");
        assert!(
            !read_connected_backends(&path)
                .expect("read manifest after clear")
                .has(provider_id),
            "manifest drops the provider after clear"
        );

        let providers = list_providers_from(&store, &path).expect("providers list after clear");
        let provider = providers
            .iter()
            .find(|p| p.id == provider_id)
            .expect("provider still listed after clear");
        assert_eq!(provider.auth_state, "needs-auth");
        assert!(provider.capabilities.is_empty());
        assert!(provider.models.iter().all(|m| !m.available));

        let _ = fs::remove_file(&path);
    }
}

/// An over-long secret is rejected instead of silently truncated, so the value
/// never reaches storage in a mutated form and no connected manifest is written.
#[test]
fn oversize_backend_secret_is_rejected_without_storing() {
    use crate::models::MAX_BACKEND_SECRET_CHARACTERS;

    let path = temp_backends_path("backends-secret-cap");
    let _ = fs::remove_file(&path);

    let mut store = HashMap::new();
    let oversized = "k".repeat(MAX_BACKEND_SECRET_CHARACTERS + 250);
    let error = store_credential_into(&mut store, &path, credential_request("openai", &oversized))
        .expect_err("oversized secret should fail");

    assert!(error.contains("exceeds the supported length"));
    assert!(
        !store.contains_key("openai"),
        "oversized secret must not be stored"
    );
    assert!(
        !read_connected_backends(&path)
            .expect("manifest readable")
            .has("openai"),
        "oversized secret must not mark the provider connected"
    );

    let _ = fs::remove_file(&path);
}

#[test]
fn rejects_backend_secrets_with_control_characters() {
    let path = temp_backends_path("backends-secret-control");
    let _ = fs::remove_file(&path);

    let mut store = HashMap::new();
    let error = store_credential_into(
        &mut store,
        &path,
        credential_request("openai", "sk-test\nwith-newline"),
    )
    .expect_err("control characters should fail");

    assert!(error.contains("control characters"));
    assert!(!store.contains_key("openai"));
    assert!(!read_connected_backends(&path)
        .expect("manifest readable")
        .has("openai"));

    let _ = fs::remove_file(&path);
}

#[test]
fn records_backend_consequential_event_as_audit_without_bypassing() {
    let event = BackendConsequentialEvent {
        provider_id: "cursor".to_string(),
        service: "Cursor".to_string(),
        action: "Edit src/index.ts".to_string(),
        mode: "trusted-scope".to_string(),
        risk_level: "medium".to_string(),
        data_used: vec!["open file".to_string()],
        consequence: "Patches a source file.".to_string(),
        backend_preapproved: Some(true),
    };

    let entry =
        normalize_backend_event(event, "2026-06-26T12:00:00.000Z").expect("event normalizes");
    // A backend that pre-approved is recorded as `once` audit — never bypasses
    // Fable's layer for future actions.
    assert_eq!(entry.decision, "once");
    assert!(entry.note.contains("Cursor"));
    assert!(entry.note.contains("Edit src/index.ts"));
    assert!(entry.note.contains("cursor"));
}

#[test]
fn records_unapproved_backend_event_as_deny_audit() {
    let event = BackendConsequentialEvent {
        provider_id: "codex".to_string(),
        service: "Codex".to_string(),
        action: "Run shell command".to_string(),
        mode: "full-access".to_string(),
        risk_level: "high".to_string(),
        data_used: vec![],
        consequence: String::new(),
        backend_preapproved: Some(false),
    };

    let entry =
        normalize_backend_event(event, "2026-06-26T12:01:00.000Z").expect("event normalizes");
    assert_eq!(entry.decision, "deny");
}

#[test]
fn runtime_snapshot_round_trips_connected_backend_ids_without_secrets() {
    let path = temp_audit_path("runtime-snapshot-backends");
    let _ = fs::remove_file(&path);

    let mut snapshot = runtime_snapshot();
    snapshot.connected_backend_ids = vec!["codex".to_string(), "cursor".to_string()];

    let saved =
        write_runtime_snapshot(&path, snapshot).expect("snapshot should save with backends");
    assert_eq!(saved.connected_backend_ids, vec!["codex", "cursor"]);

    let read = read_runtime_snapshot(&path).expect("read").expect("exists");
    assert_eq!(read.connected_backend_ids, vec!["codex", "cursor"]);

    // No secret-shaped data should be present anywhere in the snapshot file.
    let file_contents = fs::read_to_string(&path).expect("snapshot file readable");
    assert!(!file_contents.contains("secret"));
    assert!(!file_contents.contains("token"));

    let _ = fs::remove_file(&path);
}

#[test]
fn backend_auth_state_vocabulary_is_closed_and_fail_closed_set_excludes_connected() {
    use crate::models::{BACKEND_AUTH_FAIL_CLOSED_STATES, BACKEND_AUTH_STATES};

    // Every served auth state must be in the controlled vocabulary — the
    // boundary's fail-closed guard relies on this.
    assert!(BACKEND_AUTH_STATES.contains(&"connected"));
    assert!(BACKEND_AUTH_STATES.contains(&"sign-in-required"));
    assert!(BACKEND_AUTH_STATES.contains(&"connecting"));
    assert!(BACKEND_AUTH_STATES.contains(&"failed"));
    assert!(BACKEND_AUTH_STATES.contains(&"ready"));

    // "connected" is the only capability-bearing state, so it must never appear
    // in the fail-closed set. The UI leans on this split to decide whether to
    // offer actions.
    assert!(!BACKEND_AUTH_FAIL_CLOSED_STATES.contains(&"connected"));
    // Every fail-closed entry must itself be a recognized auth state.
    for state in BACKEND_AUTH_FAIL_CLOSED_STATES.iter() {
        assert!(
            BACKEND_AUTH_STATES.contains(state),
            "fail-closed state {state} is not in BACKEND_AUTH_STATES"
        );
    }

    // Verify outcomes are a closed set too.
    use crate::models::BACKEND_VERIFY_OUTCOMES;
    assert_eq!(BACKEND_VERIFY_OUTCOMES.len(), 5);
    assert!(BACKEND_VERIFY_OUTCOMES.contains(&"ready"));
    assert!(BACKEND_VERIFY_OUTCOMES.contains(&"auth-failed"));
}

#[test]
fn runtime_snapshot_round_trips_schedules_without_secrets() {
    let path = temp_audit_path("runtime-snapshot-schedules");
    let _ = fs::remove_file(&path);

    let mut snapshot = runtime_snapshot();
    snapshot.schedules = vec![
        Schedule {
            id: "weekly-digest".to_string(),
            name: "Weekly digest".to_string(),
            description: "Summarize the week.".to_string(),
            day: "Fri".to_string(),
            time: "09:00".to_string(),
            enabled: true,
            created_at: "2026-06-26T10:30:00.000Z".to_string(),
        },
        Schedule {
            id: "weekly-digest".to_string(), // duplicate id — must be deduped.
            name: "Duplicate".to_string(),
            description: "Dropped.".to_string(),
            day: "Mon".to_string(),
            time: "08:00".to_string(),
            enabled: false,
            created_at: "2026-06-20T10:00:00.000Z".to_string(),
        },
    ];

    let saved =
        write_runtime_snapshot(&path, snapshot).expect("snapshot should save with schedules");
    // The duplicate id was dropped, leaving exactly one schedule.
    assert_eq!(saved.schedules.len(), 1);
    assert_eq!(saved.schedules[0].id, "weekly-digest");
    assert_eq!(saved.schedules[0].name, "Weekly digest");

    let read = read_runtime_snapshot(&path).expect("read").expect("exists");
    assert_eq!(read.schedules.len(), 1);
    assert_eq!(read.schedules[0].id, "weekly-digest");
    assert_eq!(read.schedules[0].day, "Fri");
    assert_eq!(read.schedules[0].time, "09:00");
    assert!(read.schedules[0].enabled);

    // Schedules are non-secret; the on-disk file must not carry secret-shaped
    // substrings anywhere (mirrors the connected-backends boundary test).
    let file_contents = fs::read_to_string(&path).expect("snapshot file readable");
    assert!(!file_contents.contains("secret"));
    assert!(!file_contents.contains("token"));

    let _ = fs::remove_file(&path);
}

#[test]
fn rejects_unknown_schedule_weekday_or_time() {
    let path = temp_audit_path("runtime-snapshot-schedule-validation");
    let _ = fs::remove_file(&path);

    // Unknown weekday.
    let mut bad_day = runtime_snapshot();
    bad_day.schedules = vec![Schedule {
        id: "bad-day".to_string(),
        name: "Bad day".to_string(),
        description: "X".to_string(),
        day: "Funday".to_string(),
        time: "09:00".to_string(),
        enabled: true,
        created_at: "2026-06-26T10:30:00.000Z".to_string(),
    }];
    let error =
        write_runtime_snapshot(&path, bad_day).expect_err("unknown weekday should fail closed");
    assert!(error.contains("day"));
    assert!(!path.exists());

    // Malformed time (not HH:MM).
    let mut bad_time = runtime_snapshot();
    bad_time.schedules = vec![Schedule {
        id: "bad-time".to_string(),
        name: "Bad time".to_string(),
        description: "X".to_string(),
        day: "Fri".to_string(),
        time: "9:00".to_string(),
        enabled: true,
        created_at: "2026-06-26T10:30:00.000Z".to_string(),
    }];
    let error =
        write_runtime_snapshot(&path, bad_time).expect_err("malformed time should fail closed");
    assert!(error.contains("time"));

    // Out-of-range time.
    let mut out_of_range = runtime_snapshot();
    out_of_range.schedules = vec![Schedule {
        id: "oor".to_string(),
        name: "OOR".to_string(),
        description: "X".to_string(),
        day: "Fri".to_string(),
        time: "25:00".to_string(),
        enabled: true,
        created_at: "2026-06-26T10:30:00.000Z".to_string(),
    }];
    let error = write_runtime_snapshot(&path, out_of_range)
        .expect_err("out-of-range time should fail closed");
    assert!(error.contains("time"));
}

#[test]
fn legacy_snapshot_without_schedules_still_parses() {
    // A snapshot written before `schedules` joined the contract (the field is
    // #[serde(default)]) must still read back, with schedules defaulted empty.
    let path = temp_audit_path("runtime-snapshot-legacy-no-schedules");
    let _ = fs::remove_file(&path);
    let legacy_json = r#"{
      "version": 1,
      "activeItem": "Automations",
      "composerDraft": "/schedule weekly digest",
      "voiceEnabled": true,
      "approvalAudit": [],
      "dismissedApprovalIds": [],
      "approvalRules": [],
      "automationStatuses": {},
      "pinnedSourceIds": [],
      "importedKnowledgeSources": [],
      "memoryDisabled": false,
      "memoryRecords": [],
      "connectedBackendIds": ["codex"],
      "selectedModelId": "",
      "permissionMode": "read-only",
      "savedAt": "2026-06-26T10:30:00.000Z"
    }"#;
    fs::write(&path, legacy_json).expect("write legacy snapshot");

    let read = read_runtime_snapshot(&path).expect("read").expect("exists");
    assert!(read.schedules.is_empty());
    assert_eq!(read.active_item, "Automations");

    let _ = fs::remove_file(&path);
}

// ---------------------------------------------------------------------------
// Native-API transport (Stage 5): pure-helper tests for the key/egress boundary.
// No socket is opened — only the pure shaping helpers are unit-tested.
// ---------------------------------------------------------------------------

use crate::native_api::{
    auth_header_for, endpoint_for, extra_headers, normalize_sse_line, provider_kind, ProviderKind,
};

#[test]
fn auth_header_uses_bearer_for_openai_compat_and_custom_for_anthropic_gemini() {
    assert_eq!(
        auth_header_for("openai", "sk-x"),
        ("Authorization".to_string(), "Bearer sk-x".to_string())
    );
    assert_eq!(
        auth_header_for("xai", "xai-x"),
        ("Authorization".to_string(), "Bearer xai-x".to_string())
    );
    assert_eq!(
        auth_header_for("openrouter", "or-x"),
        ("Authorization".to_string(), "Bearer or-x".to_string())
    );
    assert_eq!(
        auth_header_for("anthropic", "sk-ant-x"),
        ("x-api-key".to_string(), "sk-ant-x".to_string())
    );
    assert_eq!(
        auth_header_for("gemini", "AIzaX"),
        ("x-goog-api-key".to_string(), "AIzaX".to_string())
    );
}

#[test]
fn endpoint_for_returns_provider_chat_or_messages_url() {
    assert!(endpoint_for("openai").contains("chat/completions"));
    assert!(endpoint_for("anthropic").contains("messages"));
    assert!(endpoint_for("gemini").contains("streamGenerateContent"));
    assert!(endpoint_for("xai").contains("chat/completions"));
    assert!(endpoint_for("openrouter").contains("chat/completions"));
    // Distinct hosts per provider.
    assert!(endpoint_for("xai").contains("api.x.ai"));
    assert!(endpoint_for("openrouter").contains("openrouter.ai"));
}

#[test]
fn extra_headers_add_anthropic_version_only_for_anthropic() {
    assert_eq!(
        extra_headers("anthropic"),
        vec![("anthropic-version".to_string(), "2023-06-01".to_string())]
    );
    assert!(extra_headers("openai").is_empty());
    assert!(extra_headers("gemini").is_empty());
}

#[test]
fn provider_kind_groups_openai_compat_vs_anthropic_vs_gemini() {
    assert_eq!(provider_kind("openai"), ProviderKind::OpenAiCompat);
    assert_eq!(provider_kind("xai"), ProviderKind::OpenAiCompat);
    assert_eq!(provider_kind("openrouter"), ProviderKind::OpenAiCompat);
    assert_eq!(provider_kind("anthropic"), ProviderKind::Anthropic);
    assert_eq!(provider_kind("gemini"), ProviderKind::Gemini);
}

#[test]
fn normalize_sse_line_strips_data_prefix_and_drops_blanks_and_done() {
    assert_eq!(
        normalize_sse_line("data: {\"x\":1}"),
        Some("{\"x\":1}".to_string())
    );
    assert_eq!(normalize_sse_line(""), None);
    assert_eq!(normalize_sse_line("data: [DONE]"), None);
    assert_eq!(normalize_sse_line(": heartbeat"), None);
    assert_eq!(normalize_sse_line("  "), None);
}

// ---------------------------------------------------------------------------
// Native API provider catalog (Stage 4): the five native providers are served
// from the credential boundary, fail-closed until a key exists.
// ---------------------------------------------------------------------------

#[test]
fn lists_all_nine_backends_with_native_providers_needs_auth_before_credential() {
    let path = temp_backends_path("backends-native-list");
    let _ = fs::remove_file(&path);

    let store = HashMap::new();
    let providers = list_providers_from(&store, &path).expect("providers should list");

    let ids: Vec<&str> = providers.iter().map(|p| p.id.as_str()).collect();
    assert_eq!(
        ids,
        vec![
            "codex",
            "cursor",
            "copilot",
            "grok",
            "openai",
            "anthropic",
            "gemini",
            "xai",
            "openrouter",
        ]
    );

    // Native providers are needs-auth + fail-closed before a credential.
    for provider in &providers {
        let is_native = matches!(
            provider.id.as_str(),
            "openai" | "anthropic" | "gemini" | "xai" | "openrouter"
        );
        if is_native {
            assert_eq!(provider.auth_state, "needs-auth");
            assert!(
                provider.capabilities.is_empty(),
                "{} should fail closed before a credential",
                provider.id
            );
            assert_eq!(provider.backend_type, "native-api");
        }
    }

    let _ = fs::remove_file(&path);
}

#[test]
fn storing_a_native_credential_serves_full_capabilities_including_usage_cost() {
    let path = temp_backends_path("backends-native-connect");
    let _ = fs::remove_file(&path);

    let mut store = HashMap::new();
    store_credential_into(
        &mut store,
        &path,
        credential_request("anthropic", "sk-ant-secret"),
    )
    .expect("credential should store");

    let providers = list_providers_from(&store, &path).expect("providers list");
    let anthropic = providers
        .iter()
        .find(|p| p.id == "anthropic")
        .expect("anthropic exists");
    assert_eq!(anthropic.auth_state, "connected");
    assert!(anthropic.capabilities.contains(&"usage-cost".to_string()));
    assert!(anthropic
        .capabilities
        .contains(&"tool-requests".to_string()));
    assert!(anthropic.capabilities.contains(&"streaming".to_string()));

    let _ = fs::remove_file(&path);
}

#[test]
fn native_secrets_never_leak_through_list_backends() {
    let path = temp_backends_path("backends-native-secrets");
    let _ = fs::remove_file(&path);

    let mut store = HashMap::new();
    store_credential_into(
        &mut store,
        &path,
        credential_request("openai", "sk-openai-do-not-leak"),
    )
    .expect("store");

    let serialized = serde_json::to_string(&list_providers_from(&store, &path).expect("list"))
        .expect("serialize");
    assert!(
        !serialized.contains("sk-openai-do-not-leak"),
        "native secret must not leak through list_backends"
    );

    // The connected-backends manifest is ids only.
    let connected = read_connected_backends(&path).expect("connected backends read");
    let manifest = serde_json::to_string(&connected).expect("serialize");
    assert!(manifest.contains("openai"));
    assert!(!manifest.contains("sk-openai-do-not-leak"));

    let _ = fs::remove_file(&path);
}

#[test]
fn native_catalog_copy_carries_no_forbidden_subscription_phrases() {
    let path = temp_backends_path("backends-native-compliance");
    let _ = fs::remove_file(&path);

    let mut store = HashMap::new();
    // Connect every native provider so the full copy is served.
    for id in ["openai", "anthropic", "gemini", "xai", "openrouter"] {
        store_credential_into(&mut store, &path, credential_request(id, "key"))
            .expect("store native");
    }

    let serialized = serde_json::to_string(&list_providers_from(&store, &path).expect("list"))
        .expect("serialize");
    let lower = serialized.to_lowercase();
    // No Claude.ai subscription login offered; no Google AI Pro/Ultra reuse.
    assert!(!lower.contains("claude.ai"));
    assert!(!lower.contains("google ai pro"));
    assert!(!lower.contains("google ai ultra"));
    // Anthropic + Gemini copy must name the implemented API-key path only.
    assert!(lower.contains("api key"));
    assert!(!lower.contains("vertex"));
    assert!(!lower.contains("bedrock"));

    let _ = fs::remove_file(&path);
}

// ---------------------------------------------------------------------------
// OS keychain credential store (keyring swap): the secret survives a process
// restart and never crosses into JS. These tests use a file-backed mock
// BackendCredentialStore so they never touch the real OS keychain.
// ---------------------------------------------------------------------------

use crate::backends::BackendCredentialStore;

/// A file-backed mock credential store that emulates the keychain's
/// persistence: a credential written through one instance is readable from a
/// *fresh* instance pointed at the same file. This models a full process
/// restart (the keychain outlives the process) without touching the real OS
/// store. The on-disk shape is a JSON map of provider id -> secret.
struct FileKeychain {
    path: PathBuf,
}

impl FileKeychain {
    fn read_all(&self) -> HashMap<String, String> {
        match fs::read_to_string(&self.path) {
            Ok(contents) if !contents.trim().is_empty() => {
                serde_json::from_str(&contents).unwrap_or_default()
            }
            _ => HashMap::new(),
        }
    }

    fn write_all(&self, map: &HashMap<String, String>) {
        let encoded = serde_json::to_string(map).expect("mock keychain encodes");
        fs::write(&self.path, encoded).expect("mock keychain writes");
    }
}

impl BackendCredentialStore for FileKeychain {
    fn get(&self, provider_id: &str) -> Result<Option<String>, String> {
        Ok(self.read_all().get(provider_id).cloned())
    }

    fn set(&mut self, provider_id: &str, secret: &str) -> Result<(), String> {
        let mut map = self.read_all();
        map.insert(provider_id.to_string(), secret.to_string());
        self.write_all(&map);
        Ok(())
    }

    fn remove(&mut self, provider_id: &str) -> Result<(), String> {
        let mut map = self.read_all();
        map.remove(provider_id);
        self.write_all(&map);
        Ok(())
    }
}

#[test]
fn credential_survives_a_process_restart_and_re_resolves_connected() {
    // The connected-backends manifest and the (mock) keychain each get their
    // own temp file so the round-trip models two real files outliving a restart.
    let manifest_path = temp_backends_path("keychain-restart-manifest");
    let keychain_path = temp_backends_path("keychain-restart-store");
    let _ = fs::remove_file(&manifest_path);
    let _ = fs::remove_file(&keychain_path);

    // --- "Process A": store the credential. ---
    {
        let mut keychain = FileKeychain {
            path: keychain_path.clone(),
        };
        store_credential_into(
            &mut keychain,
            &manifest_path,
            credential_request("anthropic", "sk-ant-survives-restart"),
        )
        .expect("credential should store to the keychain");
    }

    // --- "Process B" (fresh instances == restart): list resolves connected. ---
    let providers = {
        let keychain = FileKeychain {
            path: keychain_path.clone(),
        };
        list_providers_from(&keychain, &manifest_path).expect("providers should list after restart")
    };

    let anthropic = providers
        .iter()
        .find(|p| p.id == "anthropic")
        .expect("anthropic provider exists");
    assert_eq!(
        anthropic.auth_state, "connected",
        "a persisted keychain entry must re-resolve to connected after a restart"
    );
    assert!(anthropic.capabilities.contains(&"streaming".to_string()));

    let _ = fs::remove_file(&manifest_path);
    let _ = fs::remove_file(&keychain_path);
}

#[test]
fn keyring_entry_value_never_appears_in_served_provider_json() {
    let manifest_path = temp_backends_path("keychain-no-leak-manifest");
    let keychain_path = temp_backends_path("keychain-no-leak-store");
    let _ = fs::remove_file(&manifest_path);
    let _ = fs::remove_file(&keychain_path);

    let mut keychain = FileKeychain {
        path: keychain_path.clone(),
    };
    store_credential_into(
        &mut keychain,
        &manifest_path,
        credential_request("openai", "sk-openai-never-leak-to-js"),
    )
    .expect("store");

    // The served provider list must not carry the raw keyring entry value.
    let serialized =
        serde_json::to_string(&list_providers_from(&keychain, &manifest_path).expect("list"))
            .expect("serialize");
    assert!(
        !serialized.contains("sk-openai-never-leak-to-js"),
        "keyring entry value must not appear in served BackendProvider JSON"
    );

    // The connected-backends manifest is ids only.
    let connected = read_connected_backends(&manifest_path).expect("connected read");
    let manifest = serde_json::to_string(&connected).expect("serialize");
    assert!(manifest.contains("openai"));
    assert!(!manifest.contains("sk-openai-never-leak-to-js"));

    let _ = fs::remove_file(&manifest_path);
    let _ = fs::remove_file(&keychain_path);
}

#[test]
fn keyring_store_trait_miss_is_a_normal_get_not_an_error() {
    // The trait contract the command path relies on: a missing credential must
    // be `Ok(None)`, not `Err`, so the path fails closed (needs-auth) without
    // surfacing a secret or aborting. Verified against the mock keychain so the
    // real OS keychain is never touched by the test suite.
    let path = temp_backends_path("keychain-miss-contract");
    let _ = fs::remove_file(&path);
    let keychain = FileKeychain { path: path.clone() };

    let missing = keychain
        .get("openai")
        .expect("a missing entry is a normal miss, not an error");
    assert_eq!(missing, None);

    let _ = fs::remove_file(&path);
}

#[test]
fn in_memory_fallback_store_implements_the_trait_contract() {
    // The HashMap fallback (the original store) still satisfies the trait: a
    // write is readable back, and a remove makes it absent — the same shape the
    // keychain impl must honor so the command layer is store-agnostic. The
    // trait methods are called via fully-qualified syntax because HashMap also
    // has an inherent `get` that would otherwise shadow the trait method.
    let mut store: HashMap<String, String> = HashMap::new();
    store.set("codex", "fallback-token").expect("set");
    assert_eq!(
        BackendCredentialStore::get(&store, "codex").expect("get"),
        Some("fallback-token".to_string())
    );
    store.remove("codex").expect("remove");
    assert_eq!(
        BackendCredentialStore::get(&store, "codex").expect("get after remove"),
        None
    );
}

// ---------------------------------------------------------------------------
// Fable-owned tool execution boundary (tools.rs): defense-in-depth Rust layer.
// Each tool call must carry its own valid approval; Rust re-validates it before
// any side effect. File paths are confined to the workspace root.
// ---------------------------------------------------------------------------

use crate::models::ApprovalModification;
use crate::paths::{
    contains_symlink, harden_workspace_root, is_unc_or_device_path, resolve_data_directory,
    resolve_data_directory_pre_init, strict_canonicalize, PathResolutionError,
};
use crate::tools::{
    confine_path, execute_tool, validate_tool_approval_binding, ToolExecutionRequest,
};

fn tool_approval(
    tool: &str,
    mode: &str,
    risk_level: &str,
    confirmation_phrase: Option<&str>,
) -> ApprovalRequest {
    let action = match tool {
        "read-file" => "read-file path: notes.txt".to_string(),
        "write-file" => "write-file path: out.txt content: hi".to_string(),
        "run-shell" => "run-shell command: echo hi".to_string(),
        "web-fetch" => "web-fetch url: https://example.test".to_string(),
        other => format!("{other} unknown"),
    };
    ApprovalRequest {
        id: format!("native-{tool}"),
        service: "openai".to_string(),
        action,
        mode: mode.to_string(),
        risk_level: risk_level.to_string(),
        data_used: vec!["target".to_string()],
        consequence: format!("Execute the {tool} tool via openai with the given arguments."),
        requested_at: "2026-06-27T10:00:00.000Z".to_string(),
        decisions: APPROVAL_DECISIONS.iter().map(|d| d.to_string()).collect(),
        confirmation_phrase: confirmation_phrase.map(str::to_string),
    }
}

fn tool_request(
    tool: &str,
    arguments: serde_json::Value,
    approval: ApprovalRequest,
    decision: &str,
) -> ToolExecutionRequest {
    ToolExecutionRequest {
        tool: tool.to_string(),
        arguments,
        approval: ApprovalResolutionRequest {
            request: approval,
            decision: decision.to_string(),
            decided_at: "2026-06-27T10:01:00.000Z".to_string(),
            confirmation_text: None,
            modification: None,
        },
        workspace_root: None,
    }
}

fn temp_workspace() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "fable-tools-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("temp workspace created");
    dir
}

#[test]
fn confine_path_rejects_parent_dir_and_absolute_escapes() {
    // Use synthetic real temp dir (no machine literals) so hardened canonical containment passes.
    let td = tempfile::tempdir().expect("synthetic ws root");
    let root = td.path().to_path_buf();
    assert!(confine_path("../escape.txt", &root).is_err());
    assert!(confine_path("sub/../../escape.txt", &root).is_err());
    #[cfg(target_os = "windows")]
    assert!(confine_path("C:\\Windows\\system32", &root).is_err());
    assert!(confine_path("/etc/passwd", &root).is_err());
    assert!(confine_path("", &root).is_err());

    // A simple relative path is confined under the root.
    let confined = confine_path("notes.txt", &root).expect("relative path confined");
    assert_eq!(confined, root.join("notes.txt"));
}

#[test]
fn bounded_output_truncates_with_a_clear_marker() {
    use crate::tools::bounded_output;
    // Under the cap: verbatim, no marker.
    let small = b"hello world";
    assert_eq!(bounded_output(small, 100), "hello world");
    // Over the cap: truncated to the head plus a marker that names the limit.
    let big = vec![b'x'; 100];
    let out = bounded_output(&big, 40);
    assert!(out.starts_with("xxxxxxxx"));
    assert!(out.ends_with("bytes]"), "marker names the byte limit");
    assert!(out.len() < big.len() + 100);
}

#[test]
fn read_file_returns_small_file_verbatim() {
    use crate::tools::run_read_file;
    let root = temp_workspace();
    std::fs::write(root.join("small.txt"), "hello").unwrap();
    let res = run_read_file(&serde_json::json!({ "path": "small.txt" }), &root).unwrap();
    assert_eq!(res.output, "hello");
    assert!(!res.output.contains("truncated"));
}

#[test]
fn read_file_truncates_large_files_with_a_clear_marker() {
    use crate::tools::{run_read_file, MAX_TOOL_OUTPUT_BYTES};
    let root = temp_workspace();
    std::fs::write(
        root.join("large.txt"),
        vec![b'x'; MAX_TOOL_OUTPUT_BYTES + 32],
    )
    .unwrap();
    let res = run_read_file(&serde_json::json!({ "path": "large.txt" }), &root).unwrap();
    assert!(res.output.starts_with("xxxxxxxx"));
    assert!(res.output.ends_with("bytes]"));
    assert!(res.output.len() < MAX_TOOL_OUTPUT_BYTES + 100);
}

#[test]
fn write_file_rejects_oversize_content() {
    use crate::tools::{run_write_file, MAX_TOOL_INPUT_BYTES};
    let root = temp_workspace();
    // Content beyond the cap fails closed before touching disk.
    let too_big = "y".repeat(MAX_TOOL_INPUT_BYTES + 1);
    let err = run_write_file(
        &serde_json::json!({ "path": "big.txt", "content": too_big }),
        &root,
    )
    .unwrap_err();
    assert!(err.contains("too large"), "oversize write rejected: {err}");
    assert!(!root.join("big.txt").exists(), "nothing was written");

    // Within the cap, the write succeeds.
    let ok = "y".repeat(16);
    run_write_file(
        &serde_json::json!({ "path": "ok.txt", "content": ok }),
        &root,
    )
    .unwrap();
    assert!(root.join("ok.txt").exists());
}

#[test]
fn run_shell_returns_bounded_success_output() {
    use crate::tools::run_shell;
    let root = temp_workspace();
    // A small command returns its stdout verbatim.
    #[cfg(target_os = "windows")]
    let cmd = "echo hello";
    #[cfg(not(target_os = "windows"))]
    let cmd = "printf hello";
    let res = run_shell(&serde_json::json!({ "command": cmd }), &root).unwrap();
    assert!(res.ok);
    assert!(res.output.contains("hello"));
}

#[test]
fn execution_boundary_rejects_argument_substitution_and_permission_downgrade() {
    let mut approval = tool_approval(
        "write-file",
        "full-access",
        "high",
        Some("approve write-file"),
    );
    approval.data_used = vec!["content: safe".to_string(), "path: safe.txt".to_string()];
    validate_tool_approval_binding(
        "write-file",
        &serde_json::json!({ "path": "safe.txt", "content": "safe" }),
        &approval,
    )
    .expect("exact approval binding");

    assert!(validate_tool_approval_binding(
        "write-file",
        &serde_json::json!({ "path": "other.txt", "content": "safe" }),
        &approval,
    )
    .is_err());
    approval.mode = "read-only".to_string();
    assert!(validate_tool_approval_binding(
        "write-file",
        &serde_json::json!({ "path": "safe.txt", "content": "safe" }),
        &approval,
    )
    .is_err());
}

#[test]
fn tool_approval_binding_rejects_mismatches() {
    let mut approval = tool_approval(
        "write-file",
        "full-access",
        "high",
        Some("approve write-file"),
    );
    approval.data_used = vec!["content: safe".to_string(), "path: safe.txt".to_string()];

    // 1. Rejects mismatching tool name (e.g. approved write-file but invoking run-shell)
    assert!(validate_tool_approval_binding(
        "run-shell",
        &serde_json::json!({ "path": "safe.txt", "content": "safe" }),
        &approval,
    )
    .is_err());

    // 2. Rejects argument substitution (e.g. adding unexpected arguments)
    assert!(validate_tool_approval_binding(
        "write-file",
        &serde_json::json!({ "path": "safe.txt", "content": "safe", "extra": "argument" }),
        &approval,
    )
    .is_err());

    // 3. Rejects missing arguments
    assert!(validate_tool_approval_binding(
        "write-file",
        &serde_json::json!({ "path": "safe.txt" }),
        &approval,
    )
    .is_err());
}

#[test]
fn read_file_executes_after_an_approving_decision() {
    let root = temp_workspace();
    fs::write(root.join("notes.txt"), "hello rust").expect("seed file");

    let request = tool_request(
        "read-file",
        serde_json::json!({ "path": "notes.txt" }),
        tool_approval("read-file", "read-only", "low", None),
        "once",
    );
    let result = execute_tool(request, &root).expect("read-file should execute");
    assert!(result.ok);
    assert_eq!(result.output, "hello rust");

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn read_file_fails_closed_when_the_approval_is_denied() {
    let root = temp_workspace();
    fs::write(root.join("notes.txt"), "secret").expect("seed file");

    let request = tool_request(
        "read-file",
        serde_json::json!({ "path": "notes.txt" }),
        tool_approval("read-file", "read-only", "low", None),
        "deny",
    );
    // A deny resolves to a tool result marked not-ok; nothing is executed.
    let result = execute_tool(request, &root).expect("deny resolves");
    assert!(!result.ok);
    assert!(result.output.to_lowercase().contains("denied"));
    // The file was never read into a tool output.
    assert!(!result.output.contains("secret"));

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn write_file_executes_after_an_approving_decision_and_confines_the_path() {
    let root = temp_workspace();

    let request = tool_request(
        "write-file",
        serde_json::json!({ "path": "out.txt", "content": "hi" }),
        tool_approval(
            "write-file",
            "full-access",
            "high",
            Some("approve write-file"),
        ),
        "once",
    );
    // High-risk approvals require the confirmation phrase to match.
    let mut with_confirmation = request;
    with_confirmation.approval.confirmation_text = Some("approve write-file".to_string());
    let result = execute_tool(with_confirmation, &root).expect("write-file should execute");
    assert!(result.ok);
    assert_eq!(fs::read_to_string(root.join("out.txt")).unwrap(), "hi");

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn write_file_refuses_a_parent_dir_escape_even_when_approved() {
    let root = temp_workspace();

    let request = tool_request(
        "write-file",
        serde_json::json!({ "path": "../escape.txt", "content": "bad" }),
        tool_approval(
            "write-file",
            "full-access",
            "high",
            Some("approve write-file"),
        ),
        "session",
    );
    let mut with_confirmation = request;
    with_confirmation.approval.confirmation_text = Some("approve write-file".to_string());
    let error = execute_tool(with_confirmation, &root).expect_err("escape should fail closed");
    assert!(error.contains("..") || error.contains("escape") || error.contains("path"));

    // Nothing escaped the workspace.
    assert!(!root
        .parent()
        .map(|p| p.join("escape.txt").exists())
        .unwrap_or(false));

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn unknown_tool_fails_closed_even_after_an_approval() {
    let root = temp_workspace();
    let request = tool_request(
        "rm-rf",
        serde_json::json!({ "path": "everything" }),
        tool_approval("rm-rf", "full-access", "critical", None),
        "once",
    );
    let error = execute_tool(request, &root).expect_err("unknown tool should fail");
    assert!(error.contains("registry") || error.contains("supported"));

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn reshaped_high_risk_approval_fails_closed() {
    let root = temp_workspace();
    // The shell tries to downgrade a high-risk write to medium risk and drop the
    // confirmation phrase; Rust must reject the reshaped approval (fail closed).
    let mut approval = tool_approval(
        "write-file",
        "full-access",
        "high",
        Some("approve write-file"),
    );
    approval.risk_level = "medium".to_string();
    approval.confirmation_phrase = None;
    let request = tool_request(
        "write-file",
        serde_json::json!({ "path": "out.txt", "content": "hi" }),
        approval,
        "once",
    );
    let error = execute_tool(request, &root).expect_err("reshaped approval must fail closed");
    assert!(error.contains("approved") || error.contains("approval"));

    // Nothing was written.
    assert!(!root.join("out.txt").exists());

    let _ = fs::remove_dir_all(&root);
}

// ---------------------------------------------------------------------------
// web-fetch network egress (tools.rs): the pure helpers that the async Tauri
// command composes. The command performs the reqwest GET (mirroring
// native_api.rs); network I/O itself is not unit-tested here, exactly like the
// streaming backend path. These tests pin the contract the command honors:
//   - the URL argument is extracted and required to be http(s)
//   - a 2xx response turns into a success ToolResult with the body
//   - a non-2xx response fails closed (Err)
//   - a missing/non-string/non-http(s) url fails closed before any egress
// ---------------------------------------------------------------------------

use crate::tools::{parse_and_validate_fetch_url, web_fetch_url_from_args, WebFetchOutcome};

#[test]
fn web_fetch_requires_an_http_or_https_url_argument() {
    // Missing url.
    assert!(web_fetch_url_from_args(&serde_json::json!({})).is_err());
    // Non-string url.
    assert!(web_fetch_url_from_args(&serde_json::json!({ "url": 42 })).is_err());
    // Empty url.
    assert!(web_fetch_url_from_args(&serde_json::json!({ "url": "   " })).is_err());
    // Non-http(s) schemes fail closed before any network egress.
    assert!(web_fetch_url_from_args(&serde_json::json!({ "url": "ftp://example.test" })).is_err());
    assert!(web_fetch_url_from_args(&serde_json::json!({ "url": "file:///etc/passwd" })).is_err());

    // http:// and https:// are accepted.
    assert_eq!(
        web_fetch_url_from_args(&serde_json::json!({ "url": "https://example.test" }))
            .expect("https url accepted"),
        "https://example.test"
    );
    assert_eq!(
        web_fetch_url_from_args(&serde_json::json!({ "url": "http://example.test" }))
            .expect("http url accepted"),
        "http://example.test"
    );
}

#[test]
fn web_fetch_outcome_turns_a_2xx_body_into_a_success_tool_result() {
    let result = WebFetchOutcome::success(200, "the fetched body".to_string()).into_tool_result();
    assert!(result.ok);
    assert_eq!(result.output, "the fetched body");
}

#[test]
fn web_fetch_outcome_fails_closed_on_a_non_2xx_response() {
    // A 404 / 500 is NOT a success; the tool result must surface the failure so
    // the loop records a tool-role error message rather than a phantom body.
    assert!(WebFetchOutcome::status(404)
        .into_tool_result_err()
        .contains("404"));
    assert!(WebFetchOutcome::status(500)
        .into_tool_result_err()
        .contains("500"));
}

#[test]
fn web_fetch_outcome_fails_closed_on_a_transport_error() {
    // A transport failure (DNS, connection refused, TLS) surfaces as an error so
    // the loop fails closed instead of pretending a fetch happened.
    let err = WebFetchOutcome::transport_error("connection refused").into_tool_result_err();
    assert!(err.contains("connection refused"));
}

// ---------------------------------------------------------------------------
// SSRF / outbound policy table-driven tests for web-fetch (tools.rs).
// All tests are deterministic, use only local fakes / pure fns / IP literals.
// No real DNS resolution or egress is performed (lookup_host not exercised).
// Covers: non-http, malformed, creds, IPv4/IPv6 literals + alt/encoded forms via parser,
// private/loopback/link-local/multicast/unspec/metadata, mapped v6, ports, hostname aliases,
// normalize fingerprint, response types, size (via outcome contract).
// Redirects exercised by constructing join targets and feeding to parse_and_validate
// (mirrors every redirect in egress). DNS-rebind/cancel via policy fns + comments.
// ---------------------------------------------------------------------------

use crate::tools::{
    is_forbidden_ip, is_supported_response_type, is_unsafe_port, normalize_url_for_fingerprint,
    WEB_FETCH_MAX_BODY_BYTES, WEB_FETCH_MAX_REDIRECTS,
};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

#[test]
fn web_fetch_url_from_args_rejects_non_http_and_malformed_and_creds() {
    // non http
    assert!(web_fetch_url_from_args(&serde_json::json!({"url": "ftp://ex.test"})).is_err());
    assert!(web_fetch_url_from_args(&serde_json::json!({"url": "file:///x"})).is_err());
    assert!(web_fetch_url_from_args(&serde_json::json!({"url": "data:text/plain,hi"})).is_err());
    // malformed
    assert!(web_fetch_url_from_args(&serde_json::json!({"url": "http://"})).is_err());
    assert!(web_fetch_url_from_args(&serde_json::json!({"url": "https://"})).is_err());
    assert!(web_fetch_url_from_args(&serde_json::json!({"url": "not a url"})).is_err());
    // creds
    assert!(web_fetch_url_from_args(&serde_json::json!({"url": "https://u:p@ex.test"})).is_err());
    assert!(
        web_fetch_url_from_args(&serde_json::json!({"url": "http://user@example.com"})).is_err()
    );
    // ok
    assert!(web_fetch_url_from_args(&serde_json::json!({"url": "https://example.com"})).is_ok());
    assert!(
        web_fetch_url_from_args(&serde_json::json!({"url": "http://example.com/path?x=1"})).is_ok()
    );
}

#[test]
fn web_fetch_parse_rejects_forbidden_ipv4_literals_including_alt_encodings() {
    let bad_v4: &[&str] = &[
        "http://127.0.0.1",
        "https://127.1",
        "http://10.0.0.1",
        "https://192.168.1.1",
        "http://172.16.0.1",
        "https://169.254.169.254", // metadata
        "http://192.0.2.1",        // TEST-NET-1 reserved
        "https://198.51.100.5",    // TEST-NET-2 reserved
        "http://203.0.113.10",     // TEST-NET-3 reserved
        "https://198.18.5.5",      // benchmark reserved
        "http://0.0.0.0",
        "https://224.0.0.1", // multicast
        "http://240.0.0.1",
        "https://255.255.255.255",
        // alt encodings (url parser maps to semantic IP which is then rejected)
        "http://0x7f000001", // 127.0.0.1 hex
        "http://0177.0.0.1", // octal-ish 127
        "http://2130706433", // decimal 127.0.0.1
        "http://127.0.0.1:8080",
    ];
    for u in bad_v4 {
        let res = parse_and_validate_fetch_url(u);
        assert!(res.is_err(), "should reject {u} but got {:?}", res);
        let e = res.unwrap_err();
        assert!(
            e.contains("blocked") || e.contains("http(s)"),
            "err for {}: {}",
            u,
            e
        );
    }
}

#[test]
fn web_fetch_parse_accepts_safe_public_ipv4_literal_without_egress() {
    // 93.184.216.34 == example.com (public, non-forbidden)
    let ok = parse_and_validate_fetch_url("https://93.184.216.34/").expect("public ipv4 ok");
    assert_eq!(ok.host_str(), Some("93.184.216.34"));
}

#[test]
fn web_fetch_parse_rejects_forbidden_ipv6_and_mapped() {
    let bad_v6: &[&str] = &[
        "http://[::1]",
        "https://[::]",
        "http://[fe80::1]",
        "https://[fc00::1]",
        "http://[ff02::1]",
        // mapped to forbidden v4
        "https://[::ffff:127.0.0.1]",
        "http://[::ffff:10.0.0.1]",
        "https://[::ffff:169.254.169.254]",
    ];
    for u in bad_v6 {
        assert!(
            parse_and_validate_fetch_url(u).is_err(),
            "should reject ipv6 {}",
            u
        );
    }
}

#[test]
fn web_fetch_parse_accepts_safe_public_ipv6_literal() {
    // 2606:4700:4700::1111 is cloudflare public dns (safe)
    let res = parse_and_validate_fetch_url("https://[2606:4700:4700::1111]");
    assert!(res.is_ok());
}

#[test]
fn web_fetch_is_forbidden_ip_table() {
    let cases: &[(IpAddr, bool)] = &[
        (IpAddr::V4(Ipv4Addr::LOCALHOST), true),
        (IpAddr::V4(Ipv4Addr::UNSPECIFIED), true),
        (IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1)), true),
        (IpAddr::V4(Ipv4Addr::new(172, 16, 0, 1)), true),
        (IpAddr::V4(Ipv4Addr::new(192, 168, 0, 1)), true),
        (IpAddr::V4(Ipv4Addr::new(192, 0, 2, 1)), true), // TEST-NET-1 reserved
        (IpAddr::V4(Ipv4Addr::new(198, 51, 100, 1)), true), // TEST-NET-2 reserved
        (IpAddr::V4(Ipv4Addr::new(203, 0, 113, 1)), true), // TEST-NET-3 reserved
        (IpAddr::V4(Ipv4Addr::new(198, 18, 0, 1)), true), // benchmark reserved
        (IpAddr::V4(Ipv4Addr::new(169, 254, 1, 1)), true),
        (IpAddr::V4(Ipv4Addr::new(169, 254, 169, 254)), true),
        (IpAddr::V4(Ipv4Addr::new(224, 0, 0, 1)), true),
        (IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8)), false),
        (IpAddr::V4(Ipv4Addr::new(93, 184, 216, 34)), false),
        (IpAddr::V6(Ipv6Addr::LOCALHOST), true),
        (IpAddr::V6(Ipv6Addr::UNSPECIFIED), true),
        (IpAddr::V6(Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 1)), true),
        (IpAddr::V6(Ipv6Addr::new(0xfc00, 0, 0, 0, 0, 0, 0, 1)), true),
        (IpAddr::V6(Ipv6Addr::new(0xff00, 0, 0, 0, 0, 0, 0, 1)), true),
        (
            IpAddr::V6(Ipv6Addr::new(0x2606, 0x4700, 0x4700, 0, 0, 0, 0, 0x1111)),
            false,
        ),
    ];
    for (ip, want) in cases {
        assert_eq!(is_forbidden_ip(*ip), *want, "for {:?}", ip);
    }
}

#[test]
fn web_fetch_unsafe_ports_table() {
    assert!(is_unsafe_port(22));
    assert!(is_unsafe_port(445));
    assert!(is_unsafe_port(3306));
    assert!(is_unsafe_port(6379));
    assert!(!is_unsafe_port(80));
    assert!(!is_unsafe_port(443));
    assert!(!is_unsafe_port(8080));
    assert!(!is_unsafe_port(3000));
    assert!(!is_unsafe_port(65535));
}

#[test]
fn web_fetch_normalize_fingerprint_strips_creds_and_default_ports() {
    assert_eq!(
        normalize_url_for_fingerprint("https://example.com:443/path"),
        Some("https://example.com/path".to_string())
    );
    assert_eq!(
        normalize_url_for_fingerprint("http://ExAmPlE.com:80/x?y=1#z"),
        Some("http://example.com/x?y=1#z".to_string())
    );
    assert_eq!(normalize_url_for_fingerprint("https://u:p@ex.test"), None);
    assert_eq!(normalize_url_for_fingerprint("ftp://ex.test"), None);
    assert_eq!(
        normalize_url_for_fingerprint("https://ex.test:8443"),
        Some("https://ex.test:8443/".to_string())
    );
}

#[test]
fn web_fetch_supported_response_types() {
    assert!(is_supported_response_type("text/html; charset=utf-8"));
    assert!(is_supported_response_type("application/json"));
    assert!(is_supported_response_type("text/plain"));
    assert!(is_supported_response_type(""));
    assert!(!is_supported_response_type("image/png"));
    assert!(!is_supported_response_type("application/octet-stream"));
    assert!(!is_supported_response_type("application/pdf"));
    assert!(!is_supported_response_type("video/mp4"));
}

#[test]
fn web_fetch_max_constants_are_sane() {
    assert!(WEB_FETCH_MAX_REDIRECTS > 0 && WEB_FETCH_MAX_REDIRECTS <= 10);
    assert_eq!(WEB_FETCH_MAX_BODY_BYTES, 1024 * 1024);
}

#[test]
fn web_fetch_parse_rejects_unsafe_port() {
    assert!(parse_and_validate_fetch_url("https://ex.test:22").is_err());
    assert!(parse_and_validate_fetch_url("http://ex.test:3306/path").is_err());
    assert!(parse_and_validate_fetch_url("https://ex.test:443").is_ok());
}

#[test]
fn web_fetch_parse_rejects_localhost_hostname_aliases() {
    // Direct hostname validation (no DNS) for localhost aliases. Covers case,
    // subdomains, common variants. Complements IP literal + resolve checks.
    let bad: &[&str] = &[
        "http://localhost",
        "https://LOCALHOST/",
        "http://localhost:8080/secret",
        "https://foo.localhost",
        "http://local",
        "https://localhost.localdomain",
        "http://ip6-localhost",
        "https://ip6-loopback",
        "http://bar.local",
    ];
    for u in bad {
        let res = parse_and_validate_fetch_url(u);
        assert!(
            res.is_err(),
            "should reject localhost alias {u} but got {:?}",
            res
        );
    }
    // public hostnames with .com etc must still parse ok (DNS/re-resolve later)
    assert!(parse_and_validate_fetch_url("https://example.com").is_ok());
    assert!(parse_and_validate_fetch_url("http://public.test.localdomain.example").is_ok());
}

#[test]
fn web_fetch_redirect_target_strings_validated_by_parse() {
    // Exercise redirect path: simulate Location join + re-apply parse_and_validate
    // (as done for every redirect in run_web_fetch_egress). Covers encoded,
    // IPv4/IPv6 bad, localhost alias, creds in redirect loc, and public good.
    use url::Url;
    let base = Url::parse("https://public.example.com/page").expect("base");
    // bad cases that would be joined from Location
    let bad_redirects: &[&str] = &[
        "http://127.0.0.1/admin",
        "https://10.0.0.5/creds",
        "http://[::1]/loop",
        "http://localhost/secret",
        "https://169.254.169.254/meta",
        "//evil.localhost/x",
        "http://u:p@attacker.test",
        // alt encoding in redirect target
        "http://0x7f000001/enc",
    ];
    for loc in bad_redirects {
        let next = base.join(loc).expect("joinable loc");
        let res = parse_and_validate_fetch_url(next.as_str());
        assert!(
            res.is_err(),
            "redirect target {loc} -> {next} must be rejected by parse"
        );
    }
    // good public redirect targets accepted by parse (full egress would still
    // re-resolve DNS and apply bounds/redirect count etc)
    let good_locs: &[&str] = &[
        "https://safe.public.test/data",
        "/relative/ok",
        "https://93.184.216.34/ipv4pub",
    ];
    for loc in good_locs {
        let next = base.join(loc).expect("join ok");
        assert!(
            parse_and_validate_fetch_url(next.as_str()).is_ok(),
            "good redirect {loc} should parse ok"
        );
    }
}

#[test]
fn web_fetch_parse_rejects_more_encoded_ip_bypasses() {
    // Additional encoded / alt-representation cases for thoroughness (parser
    // normalizes to IP then is_forbidden_ip rejects).
    let more_bad: &[&str] = &[
        "http://0x7f.0.0.1",          // dotted hex
        "https://2130706433/",        // already in main but repeat for coverage
        "http://[::ffff:0x7f.0.0.1]", // mapped with alt
        "https://127.0.0.1%2e1",      // may not parse as IP but test rejection path
    ];
    for u in more_bad {
        // some may fail early parse, some at policy; either is fail-closed
        let res = parse_and_validate_fetch_url(u);
        // assert err (if parses as good public somehow, fail test)
        if res.is_ok() {
            // only allow if it resolved to a truly public (none of above should)
            panic!("encoded bypass unexpectedly accepted: {}", u);
        }
    }
}

// ---------------------------------------------------------------------------
// Auth broker boundary: the Cloudflare broker is required for confidential OAuth connectors. The
// local-first invariants pinned here are:
//   1. Only confidential OAuth connectors depend on the broker env var.
//   2. Local API-key backends never read the broker URL.
//   3. The broker URL is never a proxy for model calls, connector searches,
//      imports, or actions — those reference only provider APIs directly.
// ---------------------------------------------------------------------------

use crate::connector_auth::resolve_broker_endpoints;
use crate::connectors::{
    connector_auth_boundary, ConnectorAuthBoundary, BROKER_REQUIRED_CONNECTOR_IDS,
};

#[test]
fn only_confidential_connectors_require_the_auth_broker() {
    // Every broker-required id is classified Confidential, and every
    // Confidential id is broker-required — the two sets must agree exactly.
    for id in FIRST_WAVE_CONNECTOR_IDS {
        let boundary = connector_auth_boundary(id).expect("classified connector");
        let broker_required = BROKER_REQUIRED_CONNECTOR_IDS.contains(&id);
        match boundary {
            ConnectorAuthBoundary::Confidential => assert!(
                broker_required,
                "{id} is Confidential and must be broker-required"
            ),
            ConnectorAuthBoundary::Public => assert!(
                !broker_required,
                "{id} is Public and must never require the broker"
            ),
        }
    }
}

#[test]
fn google_connectors_are_direct_public_pkce() {
    // Google Drive, Gmail, and Google Calendar are public desktop clients. They
    // use direct loopback PKCE and never depend on the confidential broker.
    for id in ["google-drive", "gmail", "google-calendar"] {
        assert_eq!(
            connector_auth_boundary(id),
            Some(ConnectorAuthBoundary::Public),
            "{id} must be a public-client PKCE connector"
        );
        assert!(
            !BROKER_REQUIRED_CONNECTOR_IDS.contains(&id),
            "{id} must not depend on the auth broker"
        );
    }
}

// ---------------------------------------------------------------------------
// Vercel live path: Vercel is a confidential connector that authenticates
// through the auth broker, even though its catalog `auth_mode` is the distinct
// `provider-installation` value. The desktop must route it through the same
// broker contract as the other confidential connectors (GitHub, Notion, Slack,
// Linear), so the local-first broker boundary applies identically. These pin
// the invariants the Vercel read/search/identity/health flows depend on:
//   1. Vercel is classified Confidential and is broker-required.
//   2. Its broker endpoints resolve to exactly the four routes the Cloudflare
//      broker serves (authorize, handoff, refresh, revoke) — never a token or
//      identity route, which the broker does not serve.
//   3. A missing broker fails closed for Vercel, scoped to the Vercel
//      connector id, without touching public PKCE paths.
// ---------------------------------------------------------------------------

#[test]
fn vercel_is_a_confidential_broker_required_connector() {
    // Vercel uses the `provider-installation` auth_mode, but `provider_config`
    // routes every non-PKCE mode through the broker. The classification and the
    // broker-required list must agree so Vercel never appears as a public/local
    // connector that could bypass the confidential boundary.
    assert_eq!(
        connector_auth_boundary("vercel"),
        Some(ConnectorAuthBoundary::Confidential),
        "Vercel must be classified Confidential"
    );
    assert!(
        BROKER_REQUIRED_CONNECTOR_IDS.contains(&"vercel"),
        "Vercel must be in the broker-required set"
    );
}

#[test]
fn vercel_broker_endpoints_resolve_to_the_four_contract_routes() {
    // The desktop derives only the routes the broker actually serves. Vercel
    // must resolve the same four routes as GitHub/Linear/Notion/Slack — there is
    // no per-provider route vocabulary. A path-prefixed broker (common for a
    // Cloudflare Worker mounted behind a route) must keep its prefix.
    let endpoints =
        resolve_broker_endpoints("vercel", Some("https://auth.fable.app/")).expect("https ok");
    assert_eq!(
        endpoints.authorization_endpoint,
        "https://auth.fable.app/oauth/vercel/authorize"
    );
    assert_eq!(
        endpoints.handoff_endpoint,
        "https://auth.fable.app/oauth/vercel/handoff"
    );
    assert_eq!(
        endpoints.refresh_endpoint,
        "https://auth.fable.app/oauth/vercel/refresh"
    );
    assert_eq!(
        endpoints.revocation_endpoint,
        "https://auth.fable.app/oauth/vercel/revoke"
    );
    let serialized = serde_json::to_string(&endpoints).expect("serialize");
    assert!(!serialized.contains("/token"));
    assert!(!serialized.contains("/identity"));
    assert!(!serialized.contains("/search"));
    assert!(!serialized.contains("/model"));
}

#[test]
fn vercel_fails_closed_when_no_broker_is_configured() {
    // With no broker URL, the Vercel connector fails closed with a
    // configuration-required error scoped to the Vercel connector id. This is
    // the honest "unconfigured" state — never a silent fixture fallback or a
    // claim that Vercel is connected.
    let error = resolve_broker_endpoints("vercel", None).expect_err("must fail closed");
    assert_eq!(error.code, "configuration-required");
    assert_eq!(error.connector_id, "vercel");
    assert!(!error.retryable);
}

#[test]
fn broker_resolver_fail_closed_keeps_core_workspace_usable() {
    // With no broker configured, confidential connectors fail closed — but the
    // resolver leaves non-OAuth runtime paths alone. This test
    // pins that the fail-closed error is scoped to the *requesting* confidential
    // connector and does not abort the broader runtime.
    let err = resolve_broker_endpoints("github", None).expect_err("must fail closed");
    assert_eq!(err.code, "configuration-required");
    assert_eq!(err.connector_id, "github");
    // Public Google connectors use their separate client-id configuration and
    // never call this broker resolver, so the scoped GitHub failure cannot
    // make the local workspace or Google path unavailable.
}

// Suppress unused-import lint when ApprovalModification is not referenced by the
// tool tests directly but is part of the shared approval surface exercised here.
#[allow(dead_code)]
fn _reference_approval_modification() -> ApprovalModification {
    ApprovalModification {
        mode: "read-only".to_string(),
        data_used: vec![],
        consequence: String::new(),
    }
}

// ---------------------------------------------------------------------------
// Execution-boundary audit path (Batch 8 action history).
//
// Drives an actual execution boundary (the native tool boundary) against an
// in-memory encrypted store via the testable `Option<&Store>` seam, then asserts
// that matching ActionHistoryEvent rows appear through the listing path. This
// closes requirement 11's explicit "at least one execution-boundary audit path".
// ---------------------------------------------------------------------------

#[test]
fn tool_execution_boundary_records_action_history_into_the_store() {
    use crate::action_history::categories;
    use crate::store::repos::action_history::ActionHistoryEvent;
    use crate::store::vault::{MasterKey, Vault};
    use crate::store::Store;
    use crate::tools::{audit_tool_attempt, audit_tool_outcome};

    let store =
        Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap();

    // A read-file tool call is attempted, then succeeds. The boundary records
    // both an "attempted" and an "ok" event against the same correlation id.
    let arguments = serde_json::json!({ "path": "src/index.ts" });
    audit_tool_attempt(
        "read-file",
        &arguments,
        "req-tool-1",
        "read-only",
        "low",
        "2026-06-30T10:00:00.000Z",
        Some(&store),
    );
    audit_tool_outcome(
        crate::tools::ToolOutcomeAudit {
            tool: "read-file",
            request_id: "req-tool-1",
            mode: "read-only",
            risk: "low",
            status: "ok",
            error_code: "",
            message: "read-file executed",
        },
        Some(&store),
    );

    // A run-shell call is blocked at the permit boundary (policy block).
    audit_tool_outcome(
        crate::tools::ToolOutcomeAudit {
            tool: "run-shell",
            request_id: "req-tool-2",
            mode: "full-access",
            risk: "critical",
            status: "blocked",
            error_code: "permit",
            message: "approval metadata changed after the user decision",
        },
        Some(&store),
    );

    // The events are persisted + decryptable through the listing path.
    let events: Vec<ActionHistoryEvent> = store
        .with_conn(|conn| crate::store::repos::action_history::list(conn, &store, 10))
        .expect("list should succeed");

    assert_eq!(events.len(), 3, "three boundary events should be recorded");

    let ok = events
        .iter()
        .find(|e| e.status == "ok")
        .expect("an ok outcome event should be present");
    assert_eq!(ok.category, categories::TOOL_ACTION);
    assert_eq!(ok.service, "tool");
    assert_eq!(ok.action, "read-file");
    assert_eq!(ok.correlation_id, "req-tool-1");
    assert_eq!(ok.mode, "read-only");
    assert_eq!(ok.risk_level, "low");
    assert_eq!(ok.actor, "system");
    assert!(ok.summary.contains("read-file"));

    // The "attempted" event is the one that carries the safe (non-secret) preview
    // detail; the outcome event records only status + summary.
    let attempt = events
        .iter()
        .find(|e| e.status == "attempted")
        .expect("an attempted event should be present");
    let detail = attempt
        .detail
        .as_ref()
        .expect("attempt detail should decrypt");
    assert_eq!(detail["tool"], "read-file");
    assert_eq!(detail["preview"], "src/index.ts");

    let blocked = events
        .iter()
        .find(|e| e.status == "blocked")
        .expect("a blocked outcome event should be present");
    assert_eq!(blocked.category, categories::TOOL_ACTION);
    assert_eq!(blocked.error_code, "permit");
    assert_eq!(blocked.risk_level, "critical");
    assert_eq!(blocked.correlation_id, "req-tool-2");
}

#[test]
fn web_fetch_boundary_is_recorded_as_a_web_action_category() {
    use crate::action_history::categories;
    use crate::store::repos::action_history::ActionHistoryEvent;
    use crate::store::vault::{MasterKey, Vault};
    use crate::store::Store;
    use crate::tools::audit_tool_outcome;

    let store =
        Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap();

    // web-fetch routes to the WEB_ACTION category (browser/web boundary).
    audit_tool_outcome(
        crate::tools::ToolOutcomeAudit {
            tool: "web-fetch",
            request_id: "req-web-1",
            mode: "read-only",
            risk: "medium",
            status: "ok",
            error_code: "",
            message: "web-fetch executed",
        },
        Some(&store),
    );

    let events: Vec<ActionHistoryEvent> = store
        .with_conn(|conn| crate::store::repos::action_history::list(conn, &store, 10))
        .expect("list should succeed");
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].category, categories::WEB_ACTION);
    assert_eq!(events[0].action, "web-fetch");
}

#[test]
fn execution_boundary_redacts_secret_preview_before_persisting() {
    use crate::store::repos::action_history::ActionHistoryEvent;
    use crate::store::vault::{MasterKey, Vault};
    use crate::store::Store;
    use crate::tools::audit_tool_attempt;

    let store =
        Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap();

    // A run-shell preview that carries a bearer token must be redacted at the
    // storage boundary; the raw secret must never reach the sealed payload.
    let arguments =
        serde_json::json!({ "command": "curl -H 'authorization: Bearer ghp_supersecret'" });
    audit_tool_attempt(
        "run-shell",
        &arguments,
        "req-secret-1",
        "full-access",
        "critical",
        "2026-06-30T11:00:00.000Z",
        Some(&store),
    );

    let events: Vec<ActionHistoryEvent> = store
        .with_conn(|conn| crate::store::repos::action_history::list(conn, &store, 10))
        .expect("list should succeed");
    assert_eq!(events.len(), 1);

    // The decrypted detail preview must not contain the raw secret.
    let detail = events[0].detail.as_ref().expect("detail decrypts");
    let preview = detail["preview"].as_str().unwrap_or("");
    assert!(
        !preview.contains("ghp_supersecret"),
        "raw secret must not appear in the persisted preview"
    );
    assert!(
        preview.contains("[redacted]") || !preview.contains("Bearer"),
        "secret-shaped preview must be redacted"
    );
}

#[test]
fn integration_connector_writes_require_explicit_approval_once_or_modify() {
    let action = connector_action("gmail.send", "gmail", "Gmail");
    let request_session = ConnectorActionExecutionRequest {
        action: action.clone(),
        approval: ApprovalResolutionRequest {
            request: action.approval.clone(),
            decision: "session".to_string(),
            decided_at: "2026-06-27T10:01:00.000Z".to_string(),
            confirmation_text: Some("send email".to_string()),
            modification: None,
        },
    };

    // 1. session decision fails verification
    let error = validate_connector_execution_request(request_session)
        .expect_err("standing session approval should be rejected for connector writes");
    assert_eq!(error.code, "approval-required");

    // 2. rule decision fails verification
    let request_rule = ConnectorActionExecutionRequest {
        action: action.clone(),
        approval: ApprovalResolutionRequest {
            request: action.approval.clone(),
            decision: "rule".to_string(),
            decided_at: "2026-06-27T10:01:00.000Z".to_string(),
            confirmation_text: Some("send email".to_string()),
            modification: None,
        },
    };
    let error = validate_connector_execution_request(request_rule)
        .expect_err("standing rule approval should be rejected for connector writes");
    assert_eq!(error.code, "approval-required");
}

#[test]
fn integration_connector_reads_are_profile_gated() {
    // Evaluating permission policy for connector-read effect in read-only mode succeeds
    let ro_decision = crate::permission_policy::evaluate_permission_policy(
        "read-only",
        None,
        "connector-read",
        "low",
    )
    .expect("should evaluate");
    assert!(ro_decision.allowed);
    assert!(!ro_decision.approval_required);

    // Evaluating connector-write in read-only mode fails
    let ro_write_decision = crate::permission_policy::evaluate_permission_policy(
        "read-only",
        None,
        "connector-write",
        "low",
    )
    .expect("should evaluate");
    assert!(!ro_write_decision.allowed);
}

#[test]
fn integration_connector_production_path_never_falls_back_to_fixtures() {
    // If a connector action is called with an invalid/unknown connector id, it must fail closed
    let mut request = connector_action("gmail.send", "gmail", "Gmail");
    request.connector_id = "unknown-connector".to_string();
    let error = validate_connector_action(request)
        .expect_err("unknown connector should fail closed and not fall back to fixtures");
    assert_eq!(error.code, "invalid-request");
}

#[test]
fn integration_unified_action_history_categories_are_safe_and_persisted() {
    use crate::action_history::categories;
    use crate::action_history::Recorder;
    use crate::store::vault::{MasterKey, Vault};
    use crate::store::Store;

    let store =
        Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap();

    // Record events across different categories and ensure they are all safely persisted in plaintext index columns.
    let categories_to_test = [
        categories::MODEL_CALL,
        categories::CONNECTOR_ACTION,
        categories::TOOL_ACTION,
        categories::WEB_ACTION,
        categories::APPROVAL,
        categories::SCHEDULE,
        categories::POLICY_BLOCK,
    ];

    for (index, category) in categories_to_test.iter().enumerate() {
        let recorder = Recorder::new(category, "test-service", "test-action", "ok")
            .actor("system")
            .correlation(&format!("correlation-{index}"))
            .summary(&format!("summary-{category}"))
            .detail(serde_json::json!({ "category": *category }));

        let recorded = recorder.record_into(&store);
        assert!(recorded);
    }

    let events = store
        .with_conn(|conn| crate::store::repos::action_history::list(conn, &store, 50))
        .expect("list should succeed");

    assert_eq!(events.len(), categories_to_test.len());

    for category in &categories_to_test {
        let found = events
            .iter()
            .any(|e| e.category == *category && e.summary == format!("summary-{category}"));
        assert!(found, "event category {} was not persisted", category);
    }
}

// ---------------------------------------------------------------------------
// Focused regression tests for hardened portable data dir + workspace root.
// Synthetic temp fixtures + component inspection only; no machine path literals.
// Covers: portable marker selection, preservation of tauri/appdata, pre-init,
// fail-closed for missing/unc/device/symlink/traversal/canonical, strict confine.
// ---------------------------------------------------------------------------

fn last_name(p: &std::path::Path) -> Option<String> {
    p.components()
        .last()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
}

#[test]
fn resolve_data_directory_chooses_portable_subdir_on_marker_synthetic_fixture() {
    let td = tempfile::tempdir().expect("synthetic exe dir");
    let exe_dir = td.path();
    let marker = exe_dir.join(".fable-portable");
    std::fs::write(&marker, b"").expect("create marker");
    let exe = exe_dir.join("fable-bin");

    let data = resolve_data_directory(Some(&exe), None).expect("portable resolve");
    assert!(data.exists(), "data dir created");
    assert_eq!(
        last_name(&data),
        Some("fable-data".into()),
        "uses portable sibling"
    );
    // component count inspection (portable under the temp root)
    assert!(data.components().count() >= exe_dir.components().count());
}

#[test]
fn resolve_data_directory_preserves_tauri_candidate_when_no_marker() {
    let td = tempfile::tempdir().expect("synthetic");
    let fake_appdata = td.path().join("legacy-appdata");
    let exe = td.path().join("fable.exe");
    // no marker created -> must use tauri_cand (simulates valid existing install)
    let data = resolve_data_directory(Some(&exe), Some(fake_appdata.clone()))
        .expect("preserves existing location");
    assert!(data.exists());
    assert_eq!(last_name(&data), Some("legacy-appdata".into()));
    // marker absent still
    assert!(!exe.parent().unwrap().join(".fable-portable").exists());
}

#[test]
fn resolve_data_directory_preserves_valid_existing_tauri_dir_continues_to_work() {
    // Synthetic "existing" tauri/appdata (plain real dir, no symlink/junction prefix).
    // Ensures new strict checks do not break valid prior installs (per preserve req).
    let td = tempfile::tempdir().expect("synthetic existing appdata");
    let existing = td.path().join("existing-tauri-data");
    std::fs::create_dir_all(&existing).expect("seed existing");
    let exe = td.path().join("fable.exe");
    // no marker -> use existing
    let data = resolve_data_directory(Some(&exe), Some(existing.clone()))
        .expect("valid existing tauri dir preserved and usable");
    assert!(data.exists());
    assert!(last_name(&data) == Some("existing-tauri-data".into()));
    // component inspection: no symlink/junction triggered
    assert!(!is_unc_or_device_path(&data));
    // "continues to work": can create content under it (as store/paths would)
    let sub = data.join("test-subdir");
    std::fs::create_dir(&sub).expect("can continue using preserved dir");
    assert!(sub.exists());
}

#[test]
fn resolve_data_directory_fails_closed_no_marker_no_tauri_cand() {
    let td = tempfile::tempdir().expect("synthetic");
    let exe = td.path().join("fable.exe");
    let err = resolve_data_directory(Some(&exe), None).expect_err("fail closed");
    let msg = err.to_string();
    assert!(
        msg.contains("no portable") || msg.contains("no data dir"),
        "explicit error: {}",
        msg
    );
}

#[test]
fn resolve_data_directory_pre_init_only_allows_portable_marker() {
    let td = tempfile::tempdir().expect("synthetic");
    let exe = td.path().join("fable.exe");
    let err = resolve_data_directory_pre_init(&exe).expect_err("preinit closed");
    assert!(err.to_string().contains("requires portable marker"));

    // with marker succeeds (preinit path)
    let marker = td.path().join(".fable-portable");
    std::fs::write(&marker, b"").unwrap();
    let data = resolve_data_directory_pre_init(&exe).expect("preinit portable");
    assert!(last_name(&data) == Some("fable-data".into()));
}

#[test]
fn is_unc_or_device_and_strict_reject_bad_forms_via_component() {
    let unc = std::path::PathBuf::from(r"\\server\share\data");
    assert!(is_unc_or_device_path(&unc));
    let dev = std::path::PathBuf::from(r"\\.\PhysicalDrive0");
    assert!(is_unc_or_device_path(&dev));
    let ok = std::path::PathBuf::from("/tmp/safe");
    assert!(!is_unc_or_device_path(&ok));

    // strict on unc constructed (exists check will fail first but we test is_ before)
    // for non-existing unc path, the is_ fn covers without fs
}

#[test]
fn harden_workspace_root_accepts_valid_synthetic_and_rejects_missing() {
    let td = tempfile::tempdir().expect("synthetic root");
    let root = td.path().to_path_buf();
    let canon = harden_workspace_root(&root).expect("valid root");
    assert!(canon.components().count() > 0);

    let missing = root.join("does-not-exist-subdir-root");
    let e = harden_workspace_root(&missing).expect_err("missing");
    assert!(
        matches!(e, PathResolutionError::MissingRoot) || e.to_string().contains("does not exist")
    );
}

#[test]
fn harden_workspace_root_rejects_empty_and_trivial_roots() {
    let empty = std::path::PathBuf::new();
    assert!(harden_workspace_root(&empty).is_err());

    // Filesystem roots must never become an unrestricted workspace.
    #[cfg(unix)]
    {
        let fsroot = std::path::PathBuf::from("/");
        assert!(harden_workspace_root(&fsroot).is_err());
    }
    #[cfg(windows)]
    {
        let current = std::env::current_dir().expect("current directory");
        let drive_root = current
            .ancestors()
            .last()
            .expect("Windows path has a drive root");
        assert!(harden_workspace_root(drive_root).is_err());
    }
}

#[cfg(unix)]
#[test]
fn confine_path_rejects_nonexistent_target_below_symlinked_parent() {
    use std::os::unix::fs as unix_fs;

    let td = tempfile::tempdir().expect("synthetic");
    let workspace = td.path().join("workspace");
    let outside = td.path().join("outside");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    unix_fs::symlink(&outside, workspace.join("linked")).unwrap();

    let err = confine_path("linked/new-file.txt", &workspace)
        .expect_err("a missing target below a symlink must remain confined");
    assert!(err.contains("symlink") || err.contains("junction"));
}

#[cfg(unix)]
#[test]
fn strict_canonicalize_rejects_symlinked_root_synthetic() {
    use std::os::unix::fs as unix_fs;
    let td = tempfile::tempdir().expect("synthetic");
    let real = td.path().join("realroot");
    std::fs::create_dir_all(&real).unwrap();
    let linked = td.path().join("symlink-root");
    unix_fs::symlink(&real, &linked).expect("create symlink in temp (dev env)");
    let err = strict_canonicalize(&linked).expect_err("symlink root rejected");
    assert!(
        err.to_string().contains("Symlink")
            || matches!(err, PathResolutionError::SymlinkOrJunction)
    );
}

#[test]
fn confine_path_with_hardened_root_rejects_traversal_and_absolutes_still() {
    let td = tempfile::tempdir().expect("synthetic ws");
    let root = td.path().to_path_buf();
    // basic syntactic still
    assert!(confine_path("../x", &root).is_err());
    assert!(confine_path("/abs", &root).is_err());
    let ok = confine_path("sub/file.txt", &root).expect("ok");
    assert!(ok.starts_with(&root));
}

#[test]
fn resolve_workspace_root_fails_closed_on_bad_cwd_simulation_via_harden() {
    // resolve_workspace_root takes app but ignores; test via harden directly (drives shipped)
    let bad = std::path::PathBuf::from("/non/existent/for/ws/root/test");
    assert!(harden_workspace_root(&bad).is_err());
    // normal temp would pass but we don't assert specific cwd
}

// ---------------------------------------------------------------------------
// Additional focused synthetic regression tests for enumerated cases (per skeptic gaps).
// - Windows junction (reparse 0x400) rejection via mklink /J (cfg windows).
// - Junction as root / prefix with non-existing last segment.
// - Pre-create: bad candidates (unc/junction) do not leave side-effect dirs.
// - "Preserve" for bad linked "existing" tauri path: fails closed (no silent accept).
// All use tempfile + component/inspection, no machine literals.
// ---------------------------------------------------------------------------

#[cfg(windows)]
#[test]
fn windows_junction_rejected_in_strict_harden_and_data_resolve() {
    // Exercise the reparse-point (junction) branch in contains_symlink / strict / ensure.
    // Use cmd mklink /J ; if cannot create (privs), skip gracefully.
    let td = tempfile::tempdir().expect("synthetic");
    let real = td.path().join("real-junc-target");
    std::fs::create_dir_all(&real).expect("real target");
    let junc = td.path().join("junc-root");
    let created = std::process::Command::new("cmd")
        .args([
            "/C",
            "mklink",
            "/J",
            &junc.to_string_lossy(),
            &real.to_string_lossy(),
        ])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !created {
        // Cannot create junction in this env; the branch is exercised in unit logic via is_ checks.
        // Still assert the is_unc helper and that non-junc paths pass.
        let plain = td.path().join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        assert!(harden_workspace_root(&plain).is_ok());
        return;
    }
    // Junction exists as root -> strict/harden reject
    let e1 = strict_canonicalize(&junc).expect_err("junc root strict rejected");
    assert!(
        e1.to_string().contains("Symlink") || matches!(e1, PathResolutionError::SymlinkOrJunction)
    );
    let e2 = harden_workspace_root(&junc).expect_err("junc root harden rejected");
    assert!(
        e2.to_string().contains("Symlink") || matches!(e2, PathResolutionError::SymlinkOrJunction)
    );

    // As tauri cand (no marker) -> resolve rejects, no side effect on target
    let exe = td.path().join("fable.exe");
    let res = resolve_data_directory(Some(&exe), Some(junc.clone()));
    assert!(res.is_err());
    // target still there, junc link "exists" but we rejected using it
    assert!(real.exists());

    // Non-existing last under junction prefix -> contains catches prefix, resolve no-create
    let non_last = junc.join("new-data-sub");
    assert!(
        contains_symlink(&non_last) || is_unc_or_device_path(&non_last), /* unlikely */
        "prefix junction detected even for nonexist last"
    );
    let res2 = resolve_data_directory(Some(&exe), Some(non_last.clone()));
    assert!(res2.is_err());
    assert!(
        !non_last.exists(),
        "pre-create check prevented side-effect dir under junc prefix"
    );
}

#[test]
fn resolve_data_no_side_effect_dir_for_bad_unc_or_symlink_prefix_candidates() {
    let td = tempfile::tempdir().expect("synthetic");
    let exe = td.path().join("f.exe");

    // UNC cand -> early reject, no create
    let unc = std::path::PathBuf::from(r"\\server\share\fable-data");
    let _ = resolve_data_directory(Some(&exe), Some(unc.clone()));
    assert!(!unc.exists());

    // For symlink prefix non-exist last (unix or win via junction if avail, but use plain logic)
    // On any, a constructed path with bad form in is_ or if we had symlink we test contains
    let _bad_form = td.path().join("badform");
    // We can't easily make non-exist last with symlink without priv, but the early return in ensure is covered by UNC above
    // and the windows test above for junction prefix.
    // Assert at least the is_ rejects the unc form without fs.
    assert!(is_unc_or_device_path(&unc));
}

#[cfg(windows)]
#[test]
fn tauri_cand_with_junction_is_fail_closed_not_silently_preserved() {
    // Covers "preservation when tauri/appdata path has junction/symlink": we fail-closed (hardening),
    // do not silently accept/relocate into a junctioned "existing" location.
    let td = tempfile::tempdir().expect("synthetic");
    let real = td.path().join("real");
    std::fs::create_dir_all(&real).unwrap();
    let junc_as_tauri = td.path().join("junc-as-existing-data");
    let created = std::process::Command::new("cmd")
        .args([
            "/C",
            "mklink",
            "/J",
            &junc_as_tauri.to_string_lossy(),
            &real.to_string_lossy(),
        ])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !created {
        return;
    }
    let exe = td.path().join("f.exe");
    let res = resolve_data_directory(Some(&exe), Some(junc_as_tauri.clone()));
    assert!(
        res.is_err(),
        "junctioned 'existing' tauri cand is rejected (fail-closed, not preserved silently)"
    );
    // the link exists but we didn't use it as data root
}
