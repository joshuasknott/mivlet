//! Integration tests for the Arden runtime feature modules.
//!
//! These mirror the original lib.rs tests; they import the now-modularized
//! helpers via `use` so the test bodies are unchanged.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use crate::approvals::{
    persist_approval_audit_entry, persist_approval_rule, read_approval_audit_entries,
    read_approval_rules, resolve_approval,
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

    assert!(error.contains("changed while Arden was reading"));
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
        },
        KnowledgeSource {
            id: "design".to_string(),
            title: "Design direction".to_string(),
            provenance: "Product design".to_string(),
            freshness: "Today".to_string(),
            pinned: true,
            trust: Some("trusted".to_string()),
            content_preview: Some("Sidebar hierarchy and composer suggestions".to_string()),
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
        note: "Arden Automations Enable weekly workspace digest".to_string(),
    }
}

fn temp_audit_path(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("arden-{name}-{}.json", std::process::id()))
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
        approval_request("full-access", "high", Some("publish Arden")),
        "once",
        Some("publish preview"),
        None,
    ))
    .expect_err("wrong confirmation should fail closed");

    assert!(wrong.contains("did not match"));

    let response = resolve_approval(approval_resolution(
        approval_request("full-access", "high", Some("publish Arden")),
        "once",
        Some("publish Arden"),
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

    RuntimeSnapshot {
        version: RUNTIME_SNAPSHOT_VERSION,
        active_item: "Automations".to_string(),
        composer_draft: "/schedule weekly digest".to_string(),
        voice_enabled: true,
        approval_audit: vec![audit_entry("approval-one", "once")],
        dismissed_approval_ids: vec!["github-draft-pr".to_string(), "github-draft-pr".to_string()],
        approval_rules: vec![approval_rule()],
        automation_statuses,
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
