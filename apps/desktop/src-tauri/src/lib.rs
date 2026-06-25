use serde::{Deserialize, Serialize};

const MAX_LOCAL_FILE_BYTES: usize = 2 * 1024 * 1024;
const MAX_LOCAL_FILE_PREVIEW_CHARACTERS: usize = 6_000;
const DEFAULT_RESULT_LIMIT: usize = 5;
const MAX_SNIPPET_CHARACTERS: usize = 240;
const SUPPORTED_LOCAL_FILE_EXTENSIONS: [&str; 7] =
    ["txt", "md", "markdown", "json", "csv", "yaml", "yml"];

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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalFileImport {
    id: String,
    title: String,
    kind: &'static str,
    connector_id: &'static str,
    provenance: String,
    freshness: &'static str,
    pinned: bool,
    trust: &'static str,
    content_preview: String,
    content_fingerprint: String,
    size_bytes: usize,
    imported_at: String,
    origin: &'static str,
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
        kind: "document",
        connector_id: "local-files",
        provenance: format!("Local file - {}", format_file_size(actual_size_bytes)),
        freshness: "Imported now",
        pinned: true,
        trust: "untrusted",
        content_preview: preview_text(&candidate.content),
        content_fingerprint: fingerprint,
        size_bytes: actual_size_bytes,
        imported_at: candidate
            .imported_at
            .unwrap_or_else(|| "runtime-generated".to_string()),
        origin: "local-import",
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
            search_knowledge_sources
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
}
