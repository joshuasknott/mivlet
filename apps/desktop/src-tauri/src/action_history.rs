//! Action-history facade: a single recorder + Tauri command surface over the
//! encrypted `audit_event` store.
//!
//! This module is the bridge between execution boundaries (tools, connectors,
//! approvals, scheduler, model/web calls) and the durable, inspectable
//! action-history store ([`crate::store::repos::action_history`]). It exists so
//! every boundary records through one normalized path with consistent redaction
//! and id synthesis.
//!
//! **Non-negotiable:** recording is *observation only*. It never returns a value
//! that could be mistaken for execution authority, and failures to record are
//! best-effort (logged, never blocking) so audit can never weaken the approval
//! or permit gate. See `docs/security/threat-model.md`.

use serde_json::Value;

use crate::store::repos::action_history::{category, ActionHistoryEvent, Record};

/// Borrow the process-global encrypted store when initialized (the production
/// path). Returns `None` in the unit-test path that does not bring up Tauri.
/// Mirrors `store::with_store` but lends the `&Store` so execution boundaries
/// can route through the testable [`Recorder::record_into`] seam.
pub(crate) fn try_store() -> Option<&'static crate::store::Store> {
    crate::store::try_global()
}

/// Build a recorder for one auditable action. Fields are optional; only
/// `category`, `service`, `action`, and `status` carry strong meaning. The
/// recorder is a plain struct so it composes cleanly inside execution paths.
#[derive(Clone, Debug)]
pub struct Recorder {
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
    pub detail: Value,
}

impl Recorder {
    pub fn new(category: &str, service: &str, action: &str, status: &str) -> Self {
        Self {
            category: category.to_string(),
            service: service.to_string(),
            action: action.to_string(),
            status: status.to_string(),
            actor: "system".to_string(),
            created_at: now_rfc3339(),
            risk_level: String::new(),
            mode: String::new(),
            correlation_id: String::new(),
            error_code: String::new(),
            summary: String::new(),
            detail: Value::Null,
        }
    }

    pub fn actor(mut self, actor: &str) -> Self {
        self.actor = actor.to_string();
        self
    }

    pub fn risk(mut self, risk_level: &str) -> Self {
        self.risk_level = risk_level.to_string();
        self
    }

    pub fn mode(mut self, mode: &str) -> Self {
        self.mode = mode.to_string();
        self
    }

    pub fn correlation(mut self, correlation_id: &str) -> Self {
        self.correlation_id = correlation_id.to_string();
        self
    }

    pub fn error(mut self, code: &str) -> Self {
        self.error_code = code.to_string();
        self
    }

    pub fn summary(mut self, summary: &str) -> Self {
        self.summary = summary.to_string();
        self
    }

    /// Attach a safe-detail payload. The value is redacted through
    /// [`redact_safe_detail`] before persistence, so callers may pass previews
    /// and failure messages without worrying about secret leakage.
    pub fn detail(mut self, detail: Value) -> Self {
        self.detail = detail;
        self
    }

    /// Record this event into the encrypted store. Best-effort: any failure is
    /// logged to stderr and swallowed so audit can never block or weaken an
    /// execution boundary. Returns whether the event was persisted.
    ///
    /// Uses the process-global store (the production path). Execution boundaries
    /// that have an explicit `&Store` available should prefer [`record_into`],
    /// which is the testable seam that drives the same write without the global.
    pub fn record(self) -> bool {
        match try_store() {
            Some(store) => self.record_into(store),
            None => false,
        }
    }

    /// Record this event into an explicit store. Best-effort: any failure is
    /// logged to stderr and swallowed so audit can never block or weaken an
    /// execution boundary. Returns whether the event was persisted. This is the
    /// testable seam used by execution-boundary audit-path tests.
    pub fn record_into(&self, store: &crate::store::Store) -> bool {
        let id = self.synthesize_id();
        match store.transaction(|tx| {
            // The repo redacts the detail at the storage boundary (defense in
            // depth); the facade passes the raw detail through.
            crate::store::repos::action_history::record(
                tx,
                store,
                Record {
                    id: id.clone(),
                    category: self.category.clone(),
                    service: self.service.clone(),
                    action: self.action.clone(),
                    status: self.status.clone(),
                    actor: self.actor.clone(),
                    created_at: self.created_at.clone(),
                    risk_level: self.risk_level.clone(),
                    mode: self.mode.clone(),
                    correlation_id: self.correlation_id.clone(),
                    error_code: self.error_code.clone(),
                    summary: self.summary.clone(),
                    detail: self.detail.clone(),
                },
            )
        }) {
            Ok(()) => true,
            Err(error) => {
                eprintln!("action-history record failed: {error}");
                false
            }
        }
    }

    /// Deterministic, side-effect-free id derived from the event fields so a
    /// replay of the same boundary does not create duplicates (upsert by id).
    fn synthesize_id(&self) -> String {
        let basis = format!(
            "{}|{}|{}|{}|{}|{}|{}",
            self.category,
            self.service,
            self.action,
            self.status,
            self.correlation_id,
            self.created_at,
            self.summary
        );
        let digest = sha256_hex(basis.as_bytes());
        // 16 hex chars is plenty for collision safety within a local store and
        // keeps ids compact in the UI.
        format!("ah-{}", &digest[..16])
    }
}

/// List recent action-history events (newest first). Returns an empty vector
/// when the store is not initialized (the unit-test path).
pub fn list(limit: i64) -> Result<Vec<ActionHistoryEvent>, String> {
    let events = try_store()
        .map(|store| list_into(store, limit))
        .transpose()?;
    Ok(events.unwrap_or_default())
}

/// List recent action-history events filtered by category. Uses the plaintext
/// category index (no decryption needed to filter).
pub fn list_by_category(category: &str, limit: i64) -> Result<Vec<ActionHistoryEvent>, String> {
    let events = try_store()
        .map(|store| list_by_category_into(store, category, limit))
        .transpose()?;
    Ok(events.unwrap_or_default())
}

/// List recent action-history events from an explicit store (the testable seam
/// used by execution-boundary audit-path tests).
pub(crate) fn list_into(
    store: &crate::store::Store,
    limit: i64,
) -> Result<Vec<ActionHistoryEvent>, String> {
    store
        .with_conn(|conn| crate::store::repos::action_history::list(conn, store, limit))
        .map_err(|error| error.to_string())
}

fn list_by_category_into(
    store: &crate::store::Store,
    category: &str,
    limit: i64,
) -> Result<Vec<ActionHistoryEvent>, String> {
    store
        .with_conn(|conn| {
            crate::store::repos::action_history::list_by_category(conn, store, category, limit)
        })
        .map_err(|error| error.to_string())
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

// ---------------------------------------------------------------------------
// Tauri command surface
// ---------------------------------------------------------------------------

/// The wire payload for `record_action_history`. All fields are optional except
/// `category`/`service`/`action`/`status`; `detail` is redacted before sealing.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordActionHistoryRequest {
    pub category: String,
    pub service: String,
    pub action: String,
    pub status: String,
    #[serde(default)]
    pub actor: Option<String>,
    #[serde(default)]
    pub risk_level: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub correlation_id: Option<String>,
    #[serde(default)]
    pub error_code: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub detail: Option<Value>,
}

/// Record an action-history event from the UI or runtime. Observation only.
#[tauri::command]
pub fn record_action_history(request: RecordActionHistoryRequest) -> Result<bool, String> {
    let mut recorder = Recorder::new(
        &request.category,
        &request.service,
        &request.action,
        &request.status,
    );
    if let Some(actor) = request.actor {
        recorder = recorder.actor(&actor);
    }
    if let Some(risk) = request.risk_level {
        recorder = recorder.risk(&risk);
    }
    if let Some(mode) = request.mode {
        recorder = recorder.mode(&mode);
    }
    if let Some(correlation) = request.correlation_id {
        recorder = recorder.correlation(&correlation);
    }
    if let Some(code) = request.error_code {
        recorder = recorder.error(&code);
    }
    if let Some(summary) = request.summary {
        recorder = recorder.summary(&summary);
    }
    if let Some(detail) = request.detail {
        recorder = recorder.detail(detail);
    }
    Ok(recorder.record())
}

/// List recent action-history events, newest first. Optionally filtered by
/// category; `limit` defaults to 200 when omitted or non-positive.
#[tauri::command]
pub fn list_action_history(
    category: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<ActionHistoryEvent>, String> {
    let limit = limit.unwrap_or(0);
    match category {
        Some(cat) if !cat.trim().is_empty() => list_by_category(&cat, limit),
        _ => list(limit),
    }
}

/// Convenience constructors for the documented categories, used by execution
/// boundaries so they do not repeat string literals.
pub mod categories {
    pub use super::category::*;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn recorder_synthesizes_compact_prefixed_id() {
        // created_at is captured at construction, so each Recorder gets a unique
        // id; we assert the documented shape (prefix + 16 hex chars) only.
        let r = Recorder::new(category::TOOL_ACTION, "fs", "read-file", "ok")
            .summary("read src/index.ts");
        let id = r.synthesize_id();
        assert!(id.starts_with("ah-"));
        assert_eq!(id.len(), "ah-".len() + 16);
    }

    #[test]
    fn record_is_best_effort_without_store() {
        // No global store in unit tests → record() returns false, never panics.
        let recorded = Recorder::new(category::APPROVAL, "fs", "write-file", "approved")
            .actor("user")
            .summary("write-file src/foo.txt")
            .record();
        assert!(!recorded);
    }

    #[test]
    fn list_returns_empty_without_store() {
        let events = list(10).expect("list must not error without a store");
        assert!(events.is_empty());
    }

    #[test]
    fn redaction_strips_secrets_at_storage_layer() {
        // The repo redacts detail at the storage boundary; verify the helper
        // strips token-shaped values so the persisted payload stays clean.
        use crate::store::repos::action_history::redact_safe_detail;
        let detail = json!({ "token": "ghp_supersecret", "tool": "run-shell" });
        let redacted = redact_safe_detail(&detail);
        assert_eq!(redacted["token"], "[redacted]");
        assert_eq!(redacted["tool"], "run-shell");
    }
}
