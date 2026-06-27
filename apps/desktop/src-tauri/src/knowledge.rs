//! Local text-file import and lexical knowledge search.
//!
//! Public Tauri commands (names must stay stable): `import_local_text_file`,
//! `search_knowledge_sources`.

use crate::models::{
    KnowledgeCitation, KnowledgeSearchResponse, KnowledgeSource, LocalFileImport,
    LocalTextFileCandidate, DEFAULT_RESULT_LIMIT, MAX_LOCAL_FILE_BYTES,
    MAX_LOCAL_FILE_PREVIEW_CHARACTERS, MAX_SNIPPET_CHARACTERS, SUPPORTED_LOCAL_FILE_EXTENSIONS,
};

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
pub fn import_local_text_file(
    candidate: LocalTextFileCandidate,
) -> Result<LocalFileImport, String> {
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
        return Err("Fable supports text, Markdown, JSON, CSV, and YAML files.".to_string());
    }

    let actual_size_bytes = candidate.content.len();
    if actual_size_bytes != candidate.size_bytes {
        return Err(
            "The selected file changed while Fable was reading it. Choose it again.".to_string(),
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
pub fn search_knowledge_sources(
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
