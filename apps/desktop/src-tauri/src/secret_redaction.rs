//! Shared secret-redaction vocabulary mirrored from
//! `packages/protocol/src/secret-redaction.json`.
//!
//! TypeScript compiles the same file. Native persistence, audit, and computer
//! control must not omit a marker that the renderer or hosted runner would
//! catch, and vice versa.

use serde::Deserialize;
use std::sync::OnceLock;

const VOCABULARY_JSON: &str =
    include_str!("../../../../packages/protocol/src/secret-redaction.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vocabulary {
    substring_markers: Vec<String>,
    sensitive_key_stems: Vec<String>,
}

fn vocabulary() -> &'static Vocabulary {
    static CELL: OnceLock<Vocabulary> = OnceLock::new();
    CELL.get_or_init(|| {
        serde_json::from_str(VOCABULARY_JSON)
            .expect("packages/protocol/src/secret-redaction.json must parse")
    })
}

/// Case-insensitive substring match against the shared credential-shape markers.
pub fn looks_secret(value: &str) -> bool {
    looks_secret_with(value, &[])
}

/// Shared markers plus a layer-specific extra list. Extras only add detection;
/// they must not be used to drop a shared marker.
pub fn looks_secret_with(value: &str, extra: &[&str]) -> bool {
    let lower = value.to_ascii_lowercase();
    vocabulary()
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
    vocabulary()
        .sensitive_key_stems
        .iter()
        .any(|candidate| candidate == &stem)
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
    fn ordinary_prose_is_not_secret_shaped() {
        assert!(!looks_secret("read-file src/index.ts"));
        assert!(!looks_secret("github-read repo issues"));
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
}
