//! Search matching, pagination, and text helpers.

use super::*;
pub(super) fn reference(workspace_id: &str, kind: &str, id: &str) -> ObjectReference {
    ObjectReference {
        workspace_id: workspace_id.to_string(),
        kind: kind.into(),
        id: id.into(),
    }
}

pub(super) fn compare_results(
    left: &SearchResult,
    right: &SearchResult,
    normalized_query: &str,
) -> std::cmp::Ordering {
    let right_exact =
        !normalized_query.is_empty() && normalize_search_text(&right.title) == normalized_query;
    let left_exact =
        !normalized_query.is_empty() && normalize_search_text(&left.title) == normalized_query;
    right_exact
        .cmp(&left_exact)
        .then_with(|| {
            right
                .score
                .partial_cmp(&left.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .then_with(|| {
            right
                .updated_at
                .as_deref()
                .unwrap_or_default()
                .cmp(left.updated_at.as_deref().unwrap_or_default())
        })
        .then_with(|| left.object_kind.cmp(&right.object_kind))
        .then_with(|| left.title.cmp(&right.title))
        .then_with(|| left.reference.id.cmp(&right.reference.id))
}

pub(super) fn normalize_search_text(value: &str) -> String {
    let mut normalized = String::new();
    let mut needs_space = false;
    for character in value.chars() {
        if character.is_alphanumeric() {
            if needs_space && !normalized.is_empty() {
                normalized.push(' ');
            }
            normalized.extend(character.to_lowercase());
            needs_space = false;
        } else if !normalized.is_empty() {
            needs_space = true;
        }
    }
    normalized
}

#[derive(Clone, Default)]
pub(super) struct SearchCursor {
    pub(super) page: usize,
    pub(super) thread: usize,
    pub(super) message: usize,
    pub(super) result: usize,
}
impl SearchCursor {
    pub(super) fn encode(&self) -> String {
        format!(
            "{}:{}:{}:{}",
            self.page, self.thread, self.message, self.result
        )
    }
}
pub(super) fn parse_cursor(cursor: Option<&str>) -> Result<SearchCursor> {
    let bad = || StoreError::Invalid("The search cursor is invalid. Start a new search.".into());
    let Some(value) = cursor.filter(|value| !value.is_empty()) else {
        return Ok(SearchCursor::default());
    };
    let parts: Vec<usize> = value
        .split(':')
        .map(|part| part.parse::<usize>().map_err(|_| bad()))
        .collect::<Result<_>>()?;
    if parts.iter().any(|value| *value > 1_000_000_000) {
        return Err(bad());
    }
    match parts.as_slice() {
        [result] => Ok(SearchCursor {
            result: *result,
            ..SearchCursor::default()
        }),
        [page, thread, message, result] if *page <= 1_000_000 => Ok(SearchCursor {
            page: *page,
            thread: *thread,
            message: *message,
            result: *result,
        }),
        _ => Err(bad()),
    }
}

pub(super) fn tokenize(query: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    for word in query.split(|character: char| !character.is_alphanumeric()) {
        if word.is_ascii() && word.len() < 2 {
            continue;
        }
        let token = lowercase(word);
        if !tokens.contains(&token) {
            tokens.push(token);
        }
    }
    tokens
}

fn lowercase(text: &str) -> String {
    text.chars().flat_map(char::to_lowercase).collect()
}

pub(super) fn weight(text: &str, tokens: &[String], weight: f64) -> f64 {
    if tokens.is_empty() || text.is_empty() {
        return 0.0;
    }
    let normalized = lowercase(text);
    tokens
        .iter()
        .map(|token| normalized.matches(token.as_str()).count() as f64)
        .sum::<f64>()
        * weight
}

fn first_match(text: &str, tokens: &[String]) -> Option<usize> {
    let normalized = lowercase(text);
    let mut remaining = tokens
        .iter()
        .filter_map(|token| normalized.find(token))
        .min()?;

    for (offset, character) in text.char_indices() {
        let lowercase_len = character.to_lowercase().map(char::len_utf8).sum();
        if remaining < lowercase_len {
            return Some(offset);
        }
        remaining -= lowercase_len;
    }
    None
}

pub(super) fn match_snippet(text: &str, tokens: &[String]) -> String {
    let collapsed = collapse(text);
    let Some(index) = first_match(&collapsed, tokens) else {
        return truncate(&collapsed, SNIPPET_CHARACTERS);
    };
    let start_target = index.saturating_sub(SNIPPET_CHARACTERS / 3);
    let mut start = start_target;
    while start > 0 && !collapsed.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = (start + SNIPPET_CHARACTERS).min(collapsed.len());
    while end > start && !collapsed.is_char_boundary(end) {
        end -= 1;
    }
    let window = collapsed[start..end].trim();
    let mut snippet = String::new();
    if start > 0 {
        snippet.push('…');
    }
    snippet.push_str(window);
    if end < collapsed.len() {
        snippet.push('…');
    }
    snippet
}

pub(super) fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub(super) fn truncate(text: &str, max_characters: usize) -> String {
    if text.chars().count() <= max_characters {
        return text.to_string();
    }
    let mut truncated: String = text.chars().take(max_characters).collect();
    truncated.push('…');
    truncated
}

pub(super) fn collect_text(value: &Value) -> (String, bool) {
    let mut text = String::new();
    let mut truncated = false;
    collect_text_into(value, &mut text, &mut truncated);
    (text, truncated)
}

pub(super) fn collect_text_into(value: &Value, out: &mut String, truncated: &mut bool) {
    if out.chars().count() >= MAX_MATCH_TEXT_CHARACTERS {
        *truncated = true;
        return;
    }
    match value {
        Value::String(text) => {
            let remaining = MAX_MATCH_TEXT_CHARACTERS.saturating_sub(out.chars().count());
            if text.chars().count() > remaining {
                out.extend(text.chars().take(remaining));
                out.push('\n');
                *truncated = true;
            } else {
                out.push_str(text);
                out.push('\n');
            }
        }
        Value::Array(values) => {
            for entry in values {
                collect_text_into(entry, out, truncated);
            }
        }
        Value::Object(values) => {
            for entry in values.values() {
                collect_text_into(entry, out, truncated);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn japanese_title_matches_exact_and_partial_queries() {
        for query in ["東京会議", "会議", "京"] {
            assert_eq!(weight("東京会議", &tokenize(query), 4.0), 4.0, "{query}");
        }
    }

    #[test]
    fn cyrillic_title_matches_a_case_insensitive_query() {
        assert_eq!(weight("Отчёт", &tokenize("ОТЧЁТ"), 4.0), 4.0);
    }

    #[test]
    fn arabic_title_matches_an_exact_query() {
        let title = "تقرير العمل";
        assert_eq!(weight(title, &tokenize(title), 4.0), 8.0);
    }

    #[test]
    fn unicode_snippet_centers_on_match_after_lowercase_expansion() {
        let text = format!("{} Отчёт {}", "İ".repeat(220), "tail ".repeat(60));
        let snippet = match_snippet(&text, &tokenize("ОТЧЁТ"));
        assert!(snippet.contains("Отчёт"), "{snippet}");
    }

    #[test]
    fn ascii_tokens_still_ignore_single_characters_and_deduplicate() {
        assert_eq!(tokenize("A TF, tf _17_7"), ["tf", "17"]);
    }
}
