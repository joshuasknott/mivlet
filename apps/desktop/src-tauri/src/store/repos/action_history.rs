//! Inspectable action-history / audit events.
//!
//! A single normalized [`ActionHistoryEvent`] covers every auditable category:
//! model calls, connector actions, shell/tool actions, browser/web actions,
//! approvals and blocked policy decisions. Audit *observes* actions;
//! it never grants execution authority (the typed `approval` table and the
//! path-based execution-permit store remain the only execution authority).
//!
//! Storage invariants (see `docs/security/threat-model.md`):
//! - Query columns are non-secret only: `category`, `service`, `action`,
//!   `status`, `risk_level`, `mode`, `correlation_id`, `error_code`, `summary`,
//!   `actor`, `created_at`. They are indexed for filtering without decryption.
//! - The encrypted `payload` holds richer safe detail (a redacted preview and a
//!   normalized failure message). [`redact_safe_detail`] strips token-shaped,
//!   credential-shaped, and otherwise secret material before sealing.
//! - Tokens, API keys, raw provider secrets, auth handoff codes, full private
//!   file content, full email bodies, and environment-variable values are never
//!   stored — they are rejected/redacted upstream and by [`redact_safe_detail`].

use rusqlite::Connection;
use serde_json::{Map, Value};

use crate::store::repos::{open_json, seal_json};
use crate::store::{Result, Store, StoreError};

/// The auditable action categories. Kept as `&str` constants (not an enum) so
/// the wire shape stays forward-compatible with new categories without a
/// protocol break.
pub mod category {
    pub const MODEL_CALL: &str = "model-call";
    pub const CONNECTOR_ACTION: &str = "connector-action";
    pub const TOOL_ACTION: &str = "tool-action";
    pub const WEB_ACTION: &str = "web-action";
    pub const APPROVAL: &str = "approval";
    pub const POLICY_BLOCK: &str = "policy-block";
}

/// The default list cap for [`list`]. Mirrors the legacy approval-audit cap so
/// the inspectable surface stays bounded.
pub const DEFAULT_LIST_LIMIT: i64 = 200;

/// A normalized, inspectable action-history event.
///
/// This is the unified wire shape surfaced by the `list_action_history` Tauri
/// command. The `kind` column from the legacy audit_event schema is retained as
/// `legacyKind` for back-compat (the migration path still upserts via
/// [`crate::store::repos::audit_event::upsert_from_value`]).
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActionHistoryEvent {
    pub id: String,
    pub category: String,
    pub service: String,
    pub action: String,
    pub status: String,
    pub actor: String,
    pub created_at: String,
    pub risk_level: String,
    pub mode: String,
    pub correlation_id: String,
    pub error_code: String,
    pub summary: String,
    /// Safe, redacted richer detail (preview, normalized failure message).
    /// Decrypted only on explicit read by an authorized surface.
    #[serde(default)]
    pub detail: Option<Value>,
}

/// The non-secret query columns carried by an event, plus the encrypted payload.
/// Used by the recorder to keep the write path explicit about what is and is
/// not queryable.
pub(crate) struct Record {
    pub id: String,
    pub category: String,
    pub service: String,
    pub action: String,
    pub status: String,
    pub actor: String,
    pub created_at: String,
    pub risk_level: String,
    pub mode: String,
    pub correlation_id: String,
    pub error_code: String,
    pub summary: String,
    /// Free-form safe detail to seal into the payload (already redacted).
    pub detail: Value,
}

/// Append an action-history event. Existing ids are immutable: a replay is
/// ignored rather than updating prior history. The detail is redacted
/// through [`redact_safe_detail`] (defense in depth: secrets are stripped at the
/// storage layer regardless of caller) and then sealed with AAD bound to the row
/// identity (`audit_event:<id>`); query columns are stored in plaintext. Never
/// raises execution authority.
pub fn record(tx: &Connection, store: &Store, event: Record) -> Result<()> {
    let id = event.id;
    if id.trim().is_empty() {
        return Err(StoreError::Invalid(
            "Action history event is missing an id.".into(),
        ));
    }
    let category = normalize_category(&event.category);
    // Defense in depth: redact at the storage boundary so no caller can
    // accidentally seal a secret into the payload.
    let safe_detail = redact_safe_detail(&event.detail);
    let sealed = seal_json(store, &safe_detail, &aad(&id))?;
    tx.execute(
        "INSERT INTO audit_event (
           id, kind, actor, created_at, payload, payload_nonce,
           category, service, action, status, risk_level, mode,
           correlation_id, error_code, summary
         )
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
         ON CONFLICT(id) DO NOTHING;",
        rusqlite::params![
            id,
            // `kind` is the legacy column; mirror category so legacy listings
            // remain meaningful.
            category,
            normalize_short(&event.actor, "user"),
            event.created_at,
            sealed.ciphertext,
            sealed.nonce,
            category,
            normalize_short(&event.service, ""),
            normalize_short(&event.action, ""),
            normalize_short(&event.status, ""),
            normalize_short(&event.risk_level, ""),
            normalize_short(&event.mode, ""),
            normalize_short(&event.correlation_id, ""),
            normalize_short(&event.error_code, ""),
            redact_safe_text(&event.summary, MAX_SUMMARY_CHARS),
        ],
    )?;
    Ok(())
}

/// A row read from the encrypted store, decrypted into a normalized event.
pub fn list(tx: &Connection, store: &Store, limit: i64) -> Result<Vec<ActionHistoryEvent>> {
    let capped = if limit <= 0 {
        DEFAULT_LIST_LIMIT
    } else {
        limit
    };
    let mut stmt = tx.prepare(
        "SELECT id, kind, actor, created_at, payload, payload_nonce,
                category, service, action, status, risk_level, mode,
                correlation_id, error_code, summary
         FROM audit_event
         ORDER BY created_at DESC
         LIMIT ?1;",
    )?;
    let partials: Vec<Partial> = stmt
        .query_map(rusqlite::params![capped], |row| {
            Ok(Partial {
                id: row.get(0)?,
                kind: row.get(1)?,
                actor: row.get(2)?,
                created_at: row.get(3)?,
                sealed: Sealed {
                    ciphertext: row.get(4)?,
                    nonce: row.get(5)?,
                },
                category: row.get(6)?,
                service: row.get(7)?,
                action: row.get(8)?,
                status: row.get(9)?,
                risk_level: row.get(10)?,
                mode: row.get(11)?,
                correlation_id: row.get(12)?,
                error_code: row.get(13)?,
                summary: row.get(14)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut out = Vec::with_capacity(partials.len());
    for p in partials {
        // A payload that fails to open is treated as absent rather than failing
        // the whole listing: the query columns remain inspectable.
        let detail = open_json(store, &p.sealed, &aad(&p.id)).ok();
        out.push(ActionHistoryEvent {
            id: p.id,
            category: p.category,
            service: p.service,
            action: p.action,
            status: p.status,
            actor: p.actor,
            created_at: p.created_at,
            risk_level: p.risk_level,
            mode: p.mode,
            correlation_id: p.correlation_id,
            error_code: p.error_code,
            summary: p.summary,
            detail,
        });
    }
    Ok(out)
}

/// List events filtered by a single category (uses the plaintext index, so no
/// decryption is required to filter).
pub fn list_by_category(
    tx: &Connection,
    store: &Store,
    category: &str,
    limit: i64,
) -> Result<Vec<ActionHistoryEvent>> {
    let capped = if limit <= 0 {
        DEFAULT_LIST_LIMIT
    } else {
        limit
    };
    let normalized = normalize_category(category);
    let mut stmt = tx.prepare(
        "SELECT id, kind, actor, created_at, payload, payload_nonce,
                category, service, action, status, risk_level, mode,
                correlation_id, error_code, summary
         FROM audit_event
         WHERE category = ?1
         ORDER BY created_at DESC
         LIMIT ?2;",
    )?;
    let partials: Vec<Partial> = stmt
        .query_map(rusqlite::params![normalized, capped], |row| {
            Ok(Partial {
                id: row.get(0)?,
                kind: row.get(1)?,
                actor: row.get(2)?,
                created_at: row.get(3)?,
                sealed: Sealed {
                    ciphertext: row.get(4)?,
                    nonce: row.get(5)?,
                },
                category: row.get(6)?,
                service: row.get(7)?,
                action: row.get(8)?,
                status: row.get(9)?,
                risk_level: row.get(10)?,
                mode: row.get(11)?,
                correlation_id: row.get(12)?,
                error_code: row.get(13)?,
                summary: row.get(14)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut out = Vec::with_capacity(partials.len());
    for p in partials {
        let detail = open_json(store, &p.sealed, &aad(&p.id)).ok();
        out.push(ActionHistoryEvent {
            id: p.id,
            category: p.category,
            service: p.service,
            action: p.action,
            status: p.status,
            actor: p.actor,
            created_at: p.created_at,
            risk_level: p.risk_level,
            mode: p.mode,
            correlation_id: p.correlation_id,
            error_code: p.error_code,
            summary: p.summary,
            detail,
        });
    }
    Ok(out)
}

/// Maximum characters retained for a safe summary / preview field.
const MAX_SUMMARY_CHARS: usize = 240;

struct Partial {
    id: String,
    kind: String,
    actor: String,
    created_at: String,
    sealed: Sealed,
    category: String,
    service: String,
    action: String,
    status: String,
    risk_level: String,
    mode: String,
    correlation_id: String,
    error_code: String,
    summary: String,
}

use crate::store::vault::Sealed;

fn aad(id: &str) -> String {
    format!("audit_event:{id}")
}

fn normalize_category(raw: &str) -> String {
    let normalized = raw.trim();
    if normalized.is_empty() {
        return category::APPROVAL.to_string();
    }
    normalized.to_string()
}

fn normalize_short(raw: &str, fallback: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return fallback.to_string();
    }
    truncate_chars(trimmed, MAX_SUMMARY_CHARS)
}

fn truncate_chars(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_string();
    }
    let truncated: String = value.chars().take(max).collect();
    format!("{truncated}…")
}

/// Markers whose presence in *any* value indicate secret/sensitive material
/// that must never be persisted to audit. Mirrors the connector redaction list
/// and adds tokens/keys/env values explicitly required by the threat model.
const SECRET_MARKERS: &[&str] = &[
    "authorization:",
    "bearer ",
    "cookie:",
    "access_token",
    "refresh_token",
    "client_secret",
    "api_key",
    "apikey",
    "x-api-key",
    "private key",
    "-----begin",
    "xoxb-",
    "xoxp-",
    "ghp_",
    "github_pat_",
    "email body",
    "message body",
    "raw payload",
    "password",
    "passwd",
    "secret",
];

/// Whether a string value looks like it carries secret material. Case-insensitive
/// substring match against [`SECRET_MARKERS`].
pub(crate) fn looks_secret(value: &str) -> bool {
    let lowercase = value.to_ascii_lowercase();
    SECRET_MARKERS
        .iter()
        .any(|marker| lowercase.contains(marker))
}

/// Redact a single text value: if it looks secret, replace it entirely;
/// otherwise truncate to a bounded preview.
fn redact_safe_text(value: &str, max: usize) -> String {
    let normalized: String = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if looks_secret(&normalized) {
        return "[redacted]".to_string();
    }
    truncate_chars(&normalized, max)
}

/// Recursively redact a JSON value in place. Any string that looks secret is
/// replaced with `"[redacted]"`; known secret-bearing keys (token/secret/key/
/// password/authorization/cookie/code) are replaced regardless of value.
///
/// This is the single chokepoint for keeping the encrypted audit payload free
/// of credentials, raw secrets, auth handoff codes, full private file content,
/// full email bodies, and environment-variable values.
pub fn redact_safe_detail(value: &Value) -> Value {
    match value {
        Value::String(text) => Value::String(redact_safe_text(text, MAX_SUMMARY_CHARS)),
        Value::Array(items) => Value::Array(items.iter().map(redact_safe_detail).collect()),
        Value::Object(map) => {
            let mut out = Map::with_capacity(map.len());
            for (key, val) in map {
                if is_secret_key(key) {
                    out.insert(key.clone(), Value::String("[redacted]".to_string()));
                } else {
                    out.insert(key.clone(), redact_safe_detail(val));
                }
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

/// Keys whose values are always treated as secret (even if the value does not
/// match a secret marker), covering auth handoff codes and env values.
fn is_secret_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    const SECRET_KEYS: &[&str] = &[
        "token",
        "accesstoken",
        "refreshtoken",
        "idtoken",
        "secret",
        "clientsecret",
        "password",
        "passwd",
        "authorization",
        "auth",
        "cookie",
        "code",
        "verifier",
        "apikey",
        "api_key",
        "key",
        "privatekey",
        "private_key",
        "credential",
        "credentials",
        "body",
        "content",
        "env",
        "environ",
        "environment",
        "value",
    ];
    SECRET_KEYS.iter().any(|k| lower == *k)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_category_defaults_to_approval() {
        assert_eq!(normalize_category(""), category::APPROVAL);
        assert_eq!(normalize_category("   "), category::APPROVAL);
        assert_eq!(normalize_category("model-call"), category::MODEL_CALL);
    }

    #[test]
    fn truncate_chars_appends_ellipsis_only_when_too_long() {
        assert_eq!(truncate_chars("abc", 5), "abc");
        let long = "a".repeat(10);
        let out = truncate_chars(&long, 5);
        assert_eq!(out.chars().count(), 6); // 5 + ellipsis
        assert!(out.ends_with('…'));
    }

    #[test]
    fn looks_secret_detects_known_markers() {
        assert!(looks_secret("Bearer abc123"));
        assert!(looks_secret("authorization: Basic xyz"));
        assert!(looks_secret("ghp_supersecrettoken"));
        assert!(looks_secret("my api_key is here"));
        assert!(!looks_secret("read-file src/index.ts"));
        assert!(!looks_secret("github-read repo issues"));
    }

    #[test]
    fn redact_safe_text_redacts_secret_values() {
        assert_eq!(redact_safe_text("Bearer abc123", 240), "[redacted]");
        assert_eq!(
            redact_safe_text("read-file src/index.ts", 240),
            "read-file src/index.ts"
        );
        // Collapses whitespace before checking.
        assert_eq!(redact_safe_text("Bearer   abc", 240), "[redacted]");
    }

    #[test]
    fn redact_safe_detail_replaces_secret_keys_regardless_of_value() {
        let input = serde_json::json!({
            "tool": "run-shell",
            "command": "echo hi",
            "token": "opaque-looking-value",
            "env": { "PATH": "/usr/bin" },
            "nested": {
                "authorization": "anything",
                "ok": "kept"
            }
        });
        let redacted = redact_safe_detail(&input);
        assert_eq!(redacted["token"], "[redacted]");
        assert_eq!(redacted["env"], "[redacted]");
        assert_eq!(redacted["nested"]["authorization"], "[redacted]");
        assert_eq!(redacted["nested"]["ok"], "kept");
        assert_eq!(redacted["tool"], "run-shell");
        assert_eq!(redacted["command"], "echo hi");
    }

    #[test]
    fn redact_safe_detail_redacts_secret_looking_strings_in_arrays() {
        let input = serde_json::json!(["Bearer abc", "normal value", 42, true]);
        let redacted = redact_safe_detail(&input);
        assert_eq!(redacted[0], "[redacted]");
        assert_eq!(redacted[1], "normal value");
        assert_eq!(redacted[2], 42);
        assert_eq!(redacted[3], true);
    }

    #[test]
    fn redact_safe_detail_passes_through_scalars() {
        assert_eq!(redact_safe_detail(&serde_json::json!(42)), 42);
        assert_eq!(redact_safe_detail(&serde_json::json!(true)), true);
        assert!(redact_safe_detail(&serde_json::Value::Null).is_null());
    }

    // --- Store-backed persistence / listing tests ---

    use crate::store::vault::{MasterKey, Vault};
    use crate::store::Store;

    fn store() -> Store {
        Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap()
    }

    struct TestEvent<'a> {
        id: &'a str,
        category: &'a str,
        service: &'a str,
        action: &'a str,
        status: &'a str,
        created_at: &'a str,
        detail: serde_json::Value,
    }

    fn record_event(store: &Store, event: TestEvent<'_>) {
        store
            .transaction(|tx| {
                record(
                    tx,
                    store,
                    Record {
                        id: event.id.to_string(),
                        category: event.category.to_string(),
                        service: event.service.to_string(),
                        action: event.action.to_string(),
                        status: event.status.to_string(),
                        actor: "system".to_string(),
                        created_at: event.created_at.to_string(),
                        risk_level: "low".to_string(),
                        mode: "read-only".to_string(),
                        correlation_id: "req-1".to_string(),
                        error_code: String::new(),
                        summary: format!("{} ran", event.action),
                        detail: event.detail,
                    },
                )
            })
            .unwrap();
    }

    #[test]
    fn persists_and_lists_events_newest_first() {
        let store = store();
        record_event(
            &store,
            TestEvent {
                id: "ah-1",
                category: category::TOOL_ACTION,
                service: "tool",
                action: "read-file",
                status: "ok",
                created_at: "2026-06-01T00:00:00.000Z",
                detail: serde_json::json!({"tool": "read-file"}),
            },
        );
        record_event(
            &store,
            TestEvent {
                id: "ah-2",
                category: category::APPROVAL,
                service: "github",
                action: "github.comment",
                status: "approved",
                created_at: "2026-06-02T00:00:00.000Z",
                detail: serde_json::json!({"requestId": "req-1"}),
            },
        );

        let events = store
            .with_conn(|conn| list(conn, &store, 10))
            .expect("list should succeed");
        assert_eq!(events.len(), 2);
        // Newest first (created_at DESC).
        assert_eq!(events[0].id, "ah-2");
        assert_eq!(events[1].id, "ah-1");
        // Query columns are plaintext.
        assert_eq!(events[0].category, category::APPROVAL);
        assert_eq!(events[0].status, "approved");
        assert_eq!(events[0].correlation_id, "req-1");
        assert_eq!(events[0].summary, "github.comment ran");
        // Encrypted detail decrypts back.
        assert!(events[0].detail.is_some());
        assert_eq!(events[0].detail.as_ref().unwrap()["requestId"], "req-1");
    }

    #[test]
    fn list_filters_by_category_via_plaintext_index() {
        let store = store();
        record_event(
            &store,
            TestEvent {
                id: "ah-1",
                category: category::TOOL_ACTION,
                service: "tool",
                action: "read-file",
                status: "ok",
                created_at: "2026-06-01T00:00:00.000Z",
                detail: serde_json::json!({}),
            },
        );
        record_event(
            &store,
            TestEvent {
                id: "ah-2",
                category: category::MODEL_CALL,
                service: "openai",
                action: "gpt-4",
                status: "ok",
                created_at: "2026-06-02T00:00:00.000Z",
                detail: serde_json::json!({}),
            },
        );
        record_event(
            &store,
            TestEvent {
                id: "ah-3",
                category: category::TOOL_ACTION,
                service: "tool",
                action: "write-file",
                status: "ok",
                created_at: "2026-06-03T00:00:00.000Z",
                detail: serde_json::json!({}),
            },
        );

        let tools = store
            .with_conn(|conn| list_by_category(conn, &store, category::TOOL_ACTION, 10))
            .unwrap();
        assert_eq!(tools.len(), 2);
        assert!(tools.iter().all(|e| e.category == category::TOOL_ACTION));
        // Newest first within the category.
        assert_eq!(tools[0].id, "ah-3");
        assert_eq!(tools[1].id, "ah-1");
    }

    #[test]
    fn duplicate_id_cannot_mutate_existing_event() {
        let store = store();
        record_event(
            &store,
            TestEvent {
                id: "ah-1",
                category: category::TOOL_ACTION,
                service: "tool",
                action: "read-file",
                status: "attempted",
                created_at: "2026-06-01T00:00:00.000Z",
                detail: serde_json::json!({"phase": "attempt"}),
            },
        );
        // Same id is a replay: immutable history keeps the original event.
        record_event(
            &store,
            TestEvent {
                id: "ah-1",
                category: category::TOOL_ACTION,
                service: "tool",
                action: "read-file",
                status: "ok",
                created_at: "2026-06-01T00:00:00.000Z",
                detail: serde_json::json!({"phase": "done"}),
            },
        );
        let events = store.with_conn(|conn| list(conn, &store, 10)).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].status, "attempted");
        assert_eq!(events[0].detail.as_ref().unwrap()["phase"], "attempt");
    }

    #[test]
    fn record_rejects_empty_id() {
        let store = store();
        let result = store.transaction(|tx| {
            record(
                tx,
                &store,
                Record {
                    id: "".to_string(),
                    category: category::APPROVAL.to_string(),
                    service: "x".to_string(),
                    action: "y".to_string(),
                    status: "ok".to_string(),
                    actor: "system".to_string(),
                    created_at: "now".to_string(),
                    risk_level: String::new(),
                    mode: String::new(),
                    correlation_id: String::new(),
                    error_code: String::new(),
                    summary: String::new(),
                    detail: serde_json::Value::Null,
                },
            )
        });
        assert!(result.is_err());
    }

    #[test]
    fn secrets_in_detail_payload_are_redacted_before_sealing() {
        let store = store();
        // The detail carries a secret token + a safe value. record() must seal
        // a redacted payload (token → "[redacted]"), never the raw secret.
        record_event(
            &store,
            TestEvent {
                id: "ah-secret",
                category: category::TOOL_ACTION,
                service: "tool",
                action: "run-shell",
                status: "ok",
                created_at: "2026-06-01T00:00:00.000Z",
                detail: serde_json::json!({
                    "token": "ghp_supersecretvalue",
                    "command": "echo hi"
                }),
            },
        );

        let events = store.with_conn(|conn| list(conn, &store, 10)).unwrap();
        assert_eq!(events.len(), 1);
        let detail = events[0].detail.as_ref().expect("detail decrypts");
        assert_eq!(detail["token"], "[redacted]");
        assert_eq!(detail["command"], "echo hi");
        // Defense-in-depth: confirm the raw secret never reached the database
        // bytes (the encrypted payload + plaintext columns together).
        let raw = store
            .with_conn(|conn| -> Result<String> {
                let row = conn.query_row(
                    "SELECT summary, payload FROM audit_event WHERE id = 'ah-secret';",
                    [],
                    |row| {
                        let summary: String = row.get(0)?;
                        let payload: Vec<u8> = row.get(1)?;
                        Ok(format!("{summary}|{}", String::from_utf8_lossy(&payload)))
                    },
                )?;
                Ok(row)
            })
            .unwrap();
        assert!(!raw.contains("ghp_supersecretvalue"));
    }

    #[test]
    fn redact_excludes_required_threat_model_secrets() {
        let input = serde_json::json!({
            "token": "ghp_sometoken",
            "apikey": "xoxb-somekey",
            "api_key": "some-key-value",
            "code": "auth-code-123",
            "body": "This is a full email body or message body with credentials.",
            "content": "Secret file contents here.",
            "env": { "API_SECRET": "critical-secret" },
            "environment": { "PATH": "/bin" },
            "value": "some value to redact"
        });

        let redacted = redact_safe_detail(&input);

        assert_eq!(redacted["token"], "[redacted]");
        assert_eq!(redacted["apikey"], "[redacted]");
        assert_eq!(redacted["api_key"], "[redacted]");
        assert_eq!(redacted["code"], "[redacted]");
        assert_eq!(redacted["body"], "[redacted]");
        assert_eq!(redacted["content"], "[redacted]");
        assert_eq!(redacted["env"], "[redacted]");
        assert_eq!(redacted["environment"], "[redacted]");
        assert_eq!(redacted["value"], "[redacted]");
    }
}
