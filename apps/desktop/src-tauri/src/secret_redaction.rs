//! Shared secret-redaction vocabulary mirrored from
//! `packages/protocol/src/secret-redaction.json`.
//!
//! TypeScript compiles the same file. Native persistence, audit, and computer
//! control must not omit a marker that the renderer or hosted runner would
//! catch, and vice versa.

use regex::{Regex, RegexBuilder};
use serde::Deserialize;
use std::sync::OnceLock;

const VOCABULARY_JSON: &str =
    include_str!("../../../../packages/protocol/src/secret-redaction.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InlinePattern {
    id: String,
    pattern: String,
    flags: String,
    replacement: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vocabulary {
    redacted: String,
    omitted: String,
    inline_patterns: Vec<InlinePattern>,
    surviving_patterns: Vec<String>,
    substring_markers: Vec<String>,
    sensitive_key_stems: Vec<String>,
}

struct CompiledVocabulary {
    redacted: String,
    omitted: String,
    substring_markers: Vec<String>,
    sensitive_key_stems: Vec<String>,
    inline: Vec<(Regex, String)>,
    surviving: Vec<Regex>,
}

fn vocabulary() -> &'static Vocabulary {
    static CELL: OnceLock<Vocabulary> = OnceLock::new();
    CELL.get_or_init(|| {
        serde_json::from_str(VOCABULARY_JSON)
            .expect("packages/protocol/src/secret-redaction.json must parse")
    })
}

fn compiled() -> &'static CompiledVocabulary {
    static CELL: OnceLock<CompiledVocabulary> = OnceLock::new();
    CELL.get_or_init(|| {
        let vocabulary = vocabulary();
        let inline = vocabulary
            .inline_patterns
            .iter()
            .map(compile_inline_pattern)
            .collect();
        let surviving = vocabulary
            .surviving_patterns
            .iter()
            .map(|pattern| {
                RegexBuilder::new(pattern)
                    .case_insensitive(true)
                    .build()
                    .unwrap_or_else(|error| {
                        panic!("shared surviving pattern {pattern:?} must compile: {error}")
                    })
            })
            .collect();
        CompiledVocabulary {
            redacted: vocabulary.redacted.clone(),
            omitted: vocabulary.omitted.clone(),
            substring_markers: vocabulary.substring_markers.clone(),
            sensitive_key_stems: vocabulary.sensitive_key_stems.clone(),
            inline,
            surviving,
        }
    })
}

fn compile_js_regex(pattern: &str, flags: &str) -> Result<Regex, regex::Error> {
    let mut builder = RegexBuilder::new(pattern);
    if flags.contains('i') {
        builder.case_insensitive(true);
    }
    builder.build()
}

/// JS assignment patterns use a backreference (`\2`) for matching quotes.
/// The Rust `regex` crate does not support backrefs, so fold the optional
/// quote into the prefix and drop the closing-quote group. Surrounding prose
/// stays; the leaked value is still replaced.
fn rewrite_backref_pattern(pattern: &str) -> String {
    pattern
        .replace(r#"(["']?)"#, r#"["']?"#)
        .replace(r#"(\2)"#, "")
}

fn compile_inline_pattern(pattern: &InlinePattern) -> (Regex, String) {
    match compile_js_regex(&pattern.pattern, &pattern.flags) {
        Ok(regex) => (regex, pattern.replacement.clone()),
        Err(_) if pattern.pattern.contains(r"\2") => {
            let rewritten = rewrite_backref_pattern(&pattern.pattern);
            let regex = compile_js_regex(&rewritten, &pattern.flags).unwrap_or_else(|error| {
                panic!(
                    "shared inline pattern {} must compile after backref rewrite: {error}",
                    pattern.id
                )
            });
            (regex, "$1[REDACTED]".to_string())
        }
        Err(error) => panic!("shared inline pattern {} must compile: {error}", pattern.id),
    }
}

/// Case-insensitive substring match against the shared credential-shape markers.
pub fn looks_secret(value: &str) -> bool {
    looks_secret_with(value, &[])
}

/// Shared markers plus a layer-specific extra list. Extras only add detection;
/// they must not be used to drop a shared marker.
pub fn looks_secret_with(value: &str, extra: &[&str]) -> bool {
    let lower = value.to_ascii_lowercase();
    compiled()
        .substring_markers
        .iter()
        .any(|marker| lower.contains(&marker.to_ascii_lowercase()))
        || extra
            .iter()
            .any(|marker| lower.contains(&marker.to_ascii_lowercase()))
}

/// True when a JSON key name is a shared credential field, ignoring `-`/`_`.
pub fn is_sensitive_key(key: &str) -> bool {
    let stem: String = key
        .chars()
        .filter(|character| *character != '-' && *character != '_')
        .collect::<String>()
        .to_ascii_lowercase();
    compiled()
        .sensitive_key_stems
        .iter()
        .any(|candidate| candidate == &stem)
}

/// Shared surgical replacement marker (`[REDACTED]`).
pub fn redacted_marker() -> &'static str {
    &compiled().redacted
}

/// Shared omit sentinel when a marker survives surgical redaction.
pub fn omitted_marker() -> &'static str {
    &compiled().omitted
}

/// Scan a string for known credential shapes and replace them in place.
pub fn redact_secret_text(value: &str) -> String {
    if value.is_empty() {
        return value.to_string();
    }
    let mut redacted = value.to_string();
    for (regex, replacement) in &compiled().inline {
        redacted = regex
            .replace_all(&redacted, replacement.as_str())
            .into_owned();
    }
    redacted
}

/// True when a known secret marker is still present after surgical redaction.
pub fn secret_marker_survives(value: &str) -> bool {
    compiled()
        .surviving
        .iter()
        .any(|pattern| pattern.is_match(value))
}

/// Surgical redaction, then omit the whole string if a marker still remains.
pub fn redact_secret_text_or_omit(value: &str) -> String {
    let redacted = redact_secret_text(value);
    if secret_marker_survives(&redacted) {
        omitted_marker().to_string()
    } else {
        redacted
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SharedCase {
        id: String,
        input: String,
        looks_secret: bool,
        #[serde(default)]
        must_not_contain: Vec<String>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SharedCasesFile {
        cases: Vec<SharedCase>,
    }

    fn shared_cases() -> Vec<SharedCase> {
        serde_json::from_str::<SharedCasesFile>(VOCABULARY_JSON)
            .expect("shared secret-redaction cases must parse")
            .cases
    }

    #[test]
    fn shared_fixtures_agree_with_native_looks_secret() {
        for case in shared_cases() {
            assert_eq!(
                looks_secret(&case.input),
                case.looks_secret,
                "shared fixture {} diverged from native looks_secret",
                case.id
            );
            for leaked in &case.must_not_contain {
                assert!(
                    case.input.contains(leaked),
                    "fixture {} must include its leaked substring before redaction",
                    case.id
                );
            }
        }
    }

    #[test]
    fn shared_fixtures_are_scrubbed_by_surgical_redaction() {
        for case in shared_cases() {
            let redacted = redact_secret_text_or_omit(&case.input);
            for leaked in &case.must_not_contain {
                assert!(
                    !redacted.contains(leaked),
                    "fixture {} leaked {leaked:?} after redact-or-omit: {redacted}",
                    case.id
                );
            }
            if case.looks_secret {
                assert!(
                    redacted == redacted_marker()
                        || redacted == omitted_marker()
                        || !secret_marker_survives(&redacted),
                    "fixture {} left a surviving marker: {redacted}",
                    case.id
                );
            } else {
                assert_eq!(
                    redacted, case.input,
                    "fixture {} mutated ordinary prose",
                    case.id
                );
                assert!(!secret_marker_survives(&case.input));
            }
        }
    }

    #[test]
    fn ordinary_prose_is_not_secret_shaped() {
        assert!(!looks_secret("read-file src/index.ts"));
        assert!(!looks_secret("github-read repo issues"));
        assert_eq!(
            redact_secret_text_or_omit("Launch plan milestone"),
            "Launch plan milestone"
        );
    }

    #[test]
    fn google_and_github_markers_are_detected() {
        assert!(looks_secret(
            "Gemini key is AIzaSy123456789012345678901234567890abc"
        ));
        assert!(looks_secret("ghp_abcdefghijklmnopqrstuvwx1234567890"));
        assert!(looks_secret(
            "github_pat_11AAAAAAA0abcdefghijklmnopqrstuvwxyz012345"
        ));
        assert!(looks_secret("gho_abcdefghijklmnopqrstuvwx1234567890"));
    }

    #[test]
    fn extras_only_add_detection() {
        assert!(!looks_secret("email body preview"));
        assert!(looks_secret_with("email body preview", &["email body"]));
        assert!(looks_secret_with(
            "ghp_abcdefghijklmnopqrstuvwx1234567890",
            &["email body"]
        ));
    }

    #[test]
    fn sensitive_keys_ignore_separators() {
        assert!(is_sensitive_key("api_key"));
        assert!(is_sensitive_key("apiKey"));
        assert!(is_sensitive_key("refresh-token"));
        assert!(is_sensitive_key("id_token"));
        assert!(!is_sensitive_key("title"));
        assert!(!is_sensitive_key("content"));
    }

    #[test]
    fn surgical_redaction_keeps_surrounding_prose() {
        let redacted = redact_secret_text_or_omit(
            "Ship Friday. export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwx1234567890 then deploy.",
        );
        assert!(redacted.contains("Ship Friday"));
        assert!(redacted.contains("then deploy"));
        assert!(!redacted.contains("ghp_abcdefghijklmnopqrstuvwx1234567890"));
        assert!(redacted.contains(redacted_marker()));
    }
}
