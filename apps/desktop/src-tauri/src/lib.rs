use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::Manager;

const MAX_LOCAL_FILE_BYTES: usize = 2 * 1024 * 1024;
const MAX_LOCAL_FILE_PREVIEW_CHARACTERS: usize = 6_000;
const DEFAULT_RESULT_LIMIT: usize = 5;
const MAX_SNIPPET_CHARACTERS: usize = 240;
const MAX_APPROVAL_AUDIT_ENTRIES: usize = 200;
const MAX_APPROVAL_AUDIT_NOTE_CHARACTERS: usize = 240;
const MAX_IMPORTED_KNOWLEDGE_SOURCES: usize = 100;
const SUPPORTED_LOCAL_FILE_EXTENSIONS: [&str; 7] =
    ["txt", "md", "markdown", "json", "csv", "yaml", "yml"];
const APPROVAL_DECISIONS: [&str; 5] = ["once", "session", "rule", "modify", "deny"];

#[derive(Serialize)]
struct RuntimeStatus {
    permission_mode: &'static str,
    offline_ready: bool,
    connector_boundaries: [&'static str; 7],
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalTextFileCandidate {
    name: String,
    content: String,
    size_bytes: usize,
    imported_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalFileImport {
    id: String,
    title: String,
    kind: String,
    connector_id: String,
    provenance: String,
    freshness: String,
    pinned: bool,
    trust: String,
    content_preview: String,
    content_fingerprint: String,
    size_bytes: usize,
    imported_at: String,
    origin: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeSource {
    id: String,
    title: String,
    provenance: String,
    freshness: String,
    pinned: bool,
    trust: Option<String>,
    content_preview: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeCitation {
    source_id: String,
    title: String,
    snippet: String,
    provenance: String,
    freshness: String,
    trust: String,
    pinned: bool,
    score: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeSearchResponse {
    query: String,
    mode: &'static str,
    citations: Vec<KnowledgeCitation>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalAuditEntry {
    id: String,
    request_id: String,
    decision: String,
    decided_at: String,
    note: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalAuditRecordResponse {
    persisted: bool,
    entry: ApprovalAuditEntry,
    audit_len: usize,
}

#[tauri::command]
fn runtime_status() -> RuntimeStatus {
    RuntimeStatus {
        permission_mode: "read-only",
        offline_ready: true,
        connector_boundaries: [
            "local-files",
            "github",
            "google-drive",
            "slack",
            "notion",
            "linear",
            "vercel",
        ],
    }
}

fn app_data_file_path(app: &tauri::AppHandle, file_name: &str) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "Praxis could not resolve the app data folder.".to_string())?;

    fs::create_dir_all(&app_data_dir)
        .map_err(|_| "Praxis could not prepare the app data folder.".to_string())?;

    Ok(app_data_dir.join(file_name))
}

fn approval_audit_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app_data_file_path(app, "approval-audit.json")
}

fn imported_knowledge_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app_data_file_path(app, "imported-knowledge.json")
}

fn normalize_spaces(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate_characters(value: &str, max_characters: usize) -> String {
    if value.chars().count() <= max_characters {
        return value.to_string();
    }

    value.chars().take(max_characters).collect()
}

fn normalize_approval_audit_entry(entry: ApprovalAuditEntry) -> Result<ApprovalAuditEntry, String> {
    let id = normalize_spaces(&entry.id);
    let request_id = normalize_spaces(&entry.request_id);
    let decision = normalize_spaces(&entry.decision).to_ascii_lowercase();
    let decided_at = normalize_spaces(&entry.decided_at);
    let note = truncate_characters(
        &normalize_spaces(&entry.note),
        MAX_APPROVAL_AUDIT_NOTE_CHARACTERS,
    );

    if id.is_empty() || request_id.is_empty() {
        return Err("Approval audit entries need stable request identifiers.".to_string());
    }

    if !APPROVAL_DECISIONS.contains(&decision.as_str()) {
        return Err("Approval decision is not recognized.".to_string());
    }

    if decided_at.is_empty() {
        return Err("Approval audit entries need a decision time.".to_string());
    }

    if note.is_empty() {
        return Err("Approval audit entries need a short note.".to_string());
    }

    Ok(ApprovalAuditEntry {
        id,
        request_id,
        decision,
        decided_at,
        note,
    })
}

fn read_approval_audit_entries(path: &Path) -> Result<Vec<ApprovalAuditEntry>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }

    let contents = fs::read_to_string(path)
        .map_err(|_| "Praxis could not read the approval audit log.".to_string())?;

    if contents.trim().is_empty() {
        return Ok(Vec::new());
    }

    serde_json::from_str::<Vec<ApprovalAuditEntry>>(&contents)
        .map_err(|_| "Praxis could not parse the approval audit log.".to_string())
}

fn append_approval_audit_entry(
    mut entries: Vec<ApprovalAuditEntry>,
    entry: ApprovalAuditEntry,
) -> Vec<ApprovalAuditEntry> {
    entries.retain(|existing| existing.id != entry.id);
    entries.insert(0, entry);
    entries.truncate(MAX_APPROVAL_AUDIT_ENTRIES);
    entries
}

fn write_approval_audit_entries(path: &Path, entries: &[ApprovalAuditEntry]) -> Result<(), String> {
    let encoded = serde_json::to_string_pretty(entries)
        .map_err(|_| "Praxis could not encode the approval audit log.".to_string())?;

    fs::write(path, encoded)
        .map_err(|_| "Praxis could not save the approval audit log.".to_string())
}

fn persist_approval_audit_entry(
    path: &Path,
    entry: ApprovalAuditEntry,
) -> Result<ApprovalAuditRecordResponse, String> {
    let entry = normalize_approval_audit_entry(entry)?;
    let entries = read_approval_audit_entries(path)?;
    let entries = append_approval_audit_entry(entries, entry.clone());
    write_approval_audit_entries(path, &entries)?;

    Ok(ApprovalAuditRecordResponse {
        persisted: true,
        entry,
        audit_len: entries.len(),
    })
}

fn read_imported_knowledge_sources(path: &Path) -> Result<Vec<LocalFileImport>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }

    let contents = fs::read_to_string(path)
        .map_err(|_| "Praxis could not read imported knowledge sources.".to_string())?;

    if contents.trim().is_empty() {
        return Ok(Vec::new());
    }

    serde_json::from_str::<Vec<LocalFileImport>>(&contents)
        .map_err(|_| "Praxis could not parse imported knowledge sources.".to_string())
}

fn append_imported_knowledge_source(
    mut sources: Vec<LocalFileImport>,
    source: LocalFileImport,
) -> Vec<LocalFileImport> {
    sources.retain(|existing| existing.id != source.id);
    sources.insert(0, source);
    sources.truncate(MAX_IMPORTED_KNOWLEDGE_SOURCES);
    sources
}

fn write_imported_knowledge_sources(
    path: &Path,
    sources: &[LocalFileImport],
) -> Result<(), String> {
    let encoded = serde_json::to_string_pretty(sources)
        .map_err(|_| "Praxis could not encode imported knowledge sources.".to_string())?;

    fs::write(path, encoded)
        .map_err(|_| "Praxis could not save imported knowledge sources.".to_string())
}

fn persist_imported_knowledge_source(
    path: &Path,
    source: LocalFileImport,
) -> Result<LocalFileImport, String> {
    let sources = read_imported_knowledge_sources(path)?;
    let sources = append_imported_knowledge_source(sources, source.clone());
    write_imported_knowledge_sources(path, &sources)?;

    Ok(source)
}

#[tauri::command]
fn list_approval_audit(app: tauri::AppHandle) -> Result<Vec<ApprovalAuditEntry>, String> {
    let path = approval_audit_path(&app)?;
    read_approval_audit_entries(&path)
}

#[tauri::command]
fn record_approval_decision(
    app: tauri::AppHandle,
    entry: ApprovalAuditEntry,
) -> Result<ApprovalAuditRecordResponse, String> {
    let path = approval_audit_path(&app)?;
    persist_approval_audit_entry(&path, entry)
}

#[tauri::command]
fn list_imported_knowledge_sources(app: tauri::AppHandle) -> Result<Vec<LocalFileImport>, String> {
    let path = imported_knowledge_path(&app)?;
    read_imported_knowledge_sources(&path)
}

#[tauri::command]
fn import_local_knowledge_source(
    app: tauri::AppHandle,
    candidate: LocalTextFileCandidate,
) -> Result<LocalFileImport, String> {
    let imported = import_local_text_file(candidate)?;
    let path = imported_knowledge_path(&app)?;
    persist_imported_knowledge_source(&path, imported)
}

fn extension_for(file_name: &str) -> String {
    file_name
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn is_supported_local_file(file_name: &str) -> bool {
    let extension = extension_for(file_name);
    SUPPORTED_LOCAL_FILE_EXTENSIONS
        .iter()
        .any(|supported| *supported == extension)
}

fn file_slug(file_name: &str) -> String {
    let mut slug = String::new();
    let mut previous_dash = false;

    for character in file_name.to_ascii_lowercase().chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character);
            previous_dash = false;
        } else if !previous_dash && !slug.is_empty() {
            slug.push('-');
            previous_dash = true;
        }

        if slug.len() >= 40 {
            break;
        }
    }

    slug.trim_matches('-').to_string()
}

fn format_file_size(size_bytes: usize) -> String {
    if size_bytes < 1_024 {
        return format!("{size_bytes} B");
    }

    format!("{:.1} KB", size_bytes as f64 / 1_024.0)
}

fn local_file_fingerprint(content: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    let prime = 0x100000001b3_u64;

    for byte in content.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(prime);
    }

    format!("{hash:016x}")
}

fn preview_text(content: &str) -> String {
    content
        .chars()
        .take(MAX_LOCAL_FILE_PREVIEW_CHARACTERS)
        .collect()
}

#[tauri::command]
fn import_local_text_file(candidate: LocalTextFileCandidate) -> Result<LocalFileImport, String> {
    let file_name = candidate
        .name
        .trim()
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .to_string();

    if file_name.is_empty() {
        return Err("Choose a file with a valid name.".to_string());
    }

    if !is_supported_local_file(&file_name) {
        return Err("Praxis supports text, Markdown, JSON, CSV, and YAML files.".to_string());
    }

    let actual_size_bytes = candidate.content.as_bytes().len();
    if actual_size_bytes != candidate.size_bytes {
        return Err(
            "The selected file changed while Praxis was reading it. Choose it again.".to_string(),
        );
    }

    if actual_size_bytes == 0 {
        return Err("The selected file is empty.".to_string());
    }

    if actual_size_bytes > MAX_LOCAL_FILE_BYTES {
        return Err("Choose a text file smaller than 2 MB.".to_string());
    }

    let fingerprint = local_file_fingerprint(&candidate.content);
    let short_fingerprint = &fingerprint[..8];

    Ok(LocalFileImport {
        id: format!("local-{}-{}", file_slug(&file_name), short_fingerprint),
        title: file_name,
        kind: "document".to_string(),
        connector_id: "local-files".to_string(),
        provenance: format!("Local file - {}", format_file_size(actual_size_bytes)),
        freshness: "Imported now".to_string(),
        pinned: true,
        trust: "untrusted".to_string(),
        content_preview: preview_text(&candidate.content),
        content_fingerprint: fingerprint,
        size_bytes: actual_size_bytes,
        imported_at: candidate
            .imported_at
            .unwrap_or_else(|| "runtime-generated".to_string()),
        origin: "local-import".to_string(),
    })
}

fn tokenize(value: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();

    for character in value.to_ascii_lowercase().chars() {
        if character.is_ascii_alphanumeric() {
            current.push(character);
        } else if current.len() > 1 {
            if !tokens.contains(&current) {
                tokens.push(current.clone());
            }
            current.clear();
        } else {
            current.clear();
        }
    }

    if current.len() > 1 && !tokens.contains(&current) {
        tokens.push(current);
    }

    tokens
}

fn count_matches(value: &str, tokens: &[String]) -> f64 {
    let normalized = value.to_ascii_lowercase();

    tokens
        .iter()
        .map(|token| normalized.matches(token).count() as f64)
        .sum()
}

fn source_score(source: &KnowledgeSource, tokens: &[String]) -> f64 {
    if tokens.is_empty() {
        return if source.pinned { 1.0 } else { 0.0 };
    }

    let title_score = count_matches(&source.title, tokens) * 4.0;
    let content_score = count_matches(
        source.content_preview.as_deref().unwrap_or_default(),
        tokens,
    );
    let provenance_score = count_matches(&source.provenance, tokens) * 0.75;
    let match_score = title_score + content_score + provenance_score;

    if match_score == 0.0 {
        return 0.0;
    }

    let pin_boost = if source.pinned { 0.75 } else { 0.0 };
    let freshness = source.freshness.to_ascii_lowercase();
    let freshness_boost = if ["now", "today", "current"]
        .iter()
        .any(|needle| freshness.contains(needle))
    {
        0.25
    } else {
        0.0
    };

    match_score + pin_boost + freshness_boost
}

fn source_snippet(source: &KnowledgeSource) -> String {
    let content = source
        .content_preview
        .as_deref()
        .unwrap_or(&source.provenance)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");

    if content.chars().count() <= MAX_SNIPPET_CHARACTERS {
        return content;
    }

    let snippet: String = content.chars().take(MAX_SNIPPET_CHARACTERS).collect();
    format!("{snippet}...")
}

fn to_citation(source: KnowledgeSource, score: f64) -> KnowledgeCitation {
    let snippet = source_snippet(&source);

    KnowledgeCitation {
        source_id: source.id,
        title: source.title,
        snippet,
        provenance: source.provenance,
        freshness: source.freshness,
        trust: source.trust.unwrap_or_else(|| "untrusted".to_string()),
        pinned: source.pinned,
        score: (score * 100.0).round() / 100.0,
    }
}

#[tauri::command]
fn search_knowledge_sources(
    query: String,
    sources: Vec<KnowledgeSource>,
    limit: Option<usize>,
) -> KnowledgeSearchResponse {
    let normalized_query = query.trim().to_string();
    let tokens = tokenize(&normalized_query);
    let mut scored_sources = sources
        .into_iter()
        .filter_map(|source| {
            let score = source_score(&source, &tokens);
            (score > 0.0).then_some((source, score))
        })
        .collect::<Vec<_>>();

    scored_sources.sort_by(|(left_source, left_score), (right_source, right_score)| {
        right_score
            .partial_cmp(left_score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left_source.title.cmp(&right_source.title))
    });

    let citations = scored_sources
        .into_iter()
        .take(limit.unwrap_or(DEFAULT_RESULT_LIMIT))
        .map(|(source, score)| to_citation(source, score))
        .collect();

    KnowledgeSearchResponse {
        query: normalized_query,
        mode: "lexical-fallback",
        citations,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            runtime_status,
            import_local_text_file,
            search_knowledge_sources,
            list_approval_audit,
            record_approval_decision,
            list_imported_knowledge_sources,
            import_local_knowledge_source
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Praxis desktop runtime");
}

#[cfg(test)]
mod tests {
    use super::*;

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

        assert!(error.contains("changed while Praxis was reading"));
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
            note: "Praxis Automations Enable weekly workspace digest".to_string(),
        }
    }

    fn temp_audit_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("praxis-{name}-{}.json", std::process::id()))
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

        let replacement =
            import_local_text_file(candidate("source-104.md", "Knowledge source 104"))
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
}
