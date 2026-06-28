//! Approvals: standing approval *rules* (persisted) and resolved approval
//! records. Only `scope == "rule"` grants are persisted (mirroring legacy
//! behavior; session grants are ephemeral). The plaintext columns carry the
//! non-secret policy enums and a SHA-256 request fingerprint; the consequence,
//! data used, note, and confirmation phrase are encrypted in the payload.

use rusqlite::Connection;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::models::{APPROVAL_DECISIONS, APPROVAL_MODES, APPROVAL_RISK_LEVELS};
use crate::store::repos::{open_json, seal_json};
use crate::store::{Result, Store, StoreError};

/// Upsert a rule-scope approval grant from a legacy `ApprovalGrant` JSON value.
pub fn upsert_rule_from_value(
    tx: &Connection,
    store: &Store,
    value: Value,
    now: &str,
) -> Result<()> {
    let scope = value.get("scope").and_then(Value::as_str).unwrap_or("");
    if scope != "rule" {
        return Err(StoreError::Invalid(
            "Only rule-scope approval grants are persisted.".into(),
        ));
    }
    let service = value
        .get("service")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let action = value
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let mode = value
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if !APPROVAL_MODES.contains(&mode.as_str()) {
        return Err(StoreError::Invalid(format!(
            "Approval mode '{mode}' is not recognized."
        )));
    }
    let risk_level = "low".to_string(); // rules carry no risk in legacy shape
    let _ = APPROVAL_RISK_LEVELS; // vocabulary kept for future validation
    let id = format!("{service}:{action}:{mode}");
    let request_fingerprint = fingerprint_of(&value);
    let payload = serde_json::json!({
        "dataUsed": value.get("dataUsed").cloned().unwrap_or(Value::Array(vec![])),
        "consequence": value.get("consequence").cloned().unwrap_or(Value::Null),
        "note": value.get("note").cloned().unwrap_or(Value::Null),
        "createdAt": value.get("createdAt").and_then(Value::as_str).unwrap_or(now),
        "legacyId": value.get("id").cloned().unwrap_or(Value::Null),
    });
    let sealed = seal_json(store, &payload, &aad(&id))?;
    tx.execute(
        "INSERT INTO approval (id, run_id, service, action, mode, risk_level, decision,
                               request_fingerprint, decided_at, payload, payload_nonce)
         VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(id) DO UPDATE SET
           mode=excluded.mode, request_fingerprint=excluded.request_fingerprint,
           decided_at=excluded.decided_at,
           payload=excluded.payload, payload_nonce=excluded.payload_nonce;",
        rusqlite::params![
            id,
            service,
            action,
            mode,
            risk_level,
            "rule",
            request_fingerprint,
            now,
            sealed.ciphertext,
            sealed.nonce,
        ],
    )?;
    Ok(())
}

pub struct ApprovalRow {
    pub id: String,
    pub service: String,
    pub action: String,
    pub mode: String,
    pub risk_level: String,
    pub decision: String,
    pub decided_at: String,
    pub payload: Value,
}

pub fn list_rules(tx: &Connection, store: &Store) -> Result<Vec<ApprovalRow>> {
    let mut stmt = tx.prepare(
        "SELECT id, service, action, mode, risk_level, decision, decided_at,
                payload, payload_nonce
         FROM approval WHERE decision = 'rule' ORDER BY service, action;",
    )?;
    let partials: Vec<Partial> = stmt
        .query_map([], |row| {
            Ok(Partial {
                id: row.get(0)?,
                service: row.get(1)?,
                action: row.get(2)?,
                mode: row.get(3)?,
                risk_level: row.get(4)?,
                decision: row.get(5)?,
                decided_at: row.get(6)?,
                sealed: Sealed {
                    ciphertext: row.get(7)?,
                    nonce: row.get(8)?,
                },
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut out = Vec::with_capacity(partials.len());
    for p in partials {
        let payload = open_json(store, &p.sealed, &aad(&p.id))?;
        out.push(ApprovalRow {
            id: p.id,
            service: p.service,
            action: p.action,
            mode: p.mode,
            risk_level: p.risk_level,
            decision: p.decision,
            decided_at: p.decided_at,
            payload,
        });
    }
    Ok(out)
}

/// Delete an approval rule by its natural key.
pub fn delete_rule(tx: &Connection, service: &str, action: &str, mode: &str) -> Result<()> {
    let id = format!("{service}:{action}:{mode}");
    tx.execute("DELETE FROM approval WHERE id = ?1;", rusqlite::params![id])?;
    Ok(())
}

struct Partial {
    id: String,
    service: String,
    action: String,
    mode: String,
    risk_level: String,
    decision: String,
    decided_at: String,
    sealed: Sealed,
}

use crate::store::vault::Sealed;

fn aad(id: &str) -> String {
    format!("approval:{id}")
}

/// SHA-256 hex of the canonical grant fields (non-secret, used only for
/// integrity reference, not for any secret).
fn fingerprint_of(value: &Value) -> String {
    let mut hasher = Sha256::new();
    hasher.update(
        value
            .get("service")
            .and_then(Value::as_str)
            .unwrap_or("")
            .as_bytes(),
    );
    hasher.update(b"|");
    hasher.update(
        value
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or("")
            .as_bytes(),
    );
    hasher.update(b"|");
    hasher.update(
        value
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or("")
            .as_bytes(),
    );
    hex::encode(hasher.finalize())
}

// vocabulary referenced to keep clippy happy
#[allow(dead_code)]
const _DECISIONS: &[&str] = APPROVAL_DECISIONS.as_slice();

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::vault::{MasterKey, Vault};

    fn store() -> Store {
        Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap()
    }

    #[test]
    fn persists_only_rule_scope() {
        let store = store();
        store
            .transaction(|tx| {
                let rule = serde_json::json!({
                    "id": "g1", "scope": "rule", "service": "github", "action": "github.comment",
                    "mode": "trusted-scope"
                });
                upsert_rule_from_value(tx, &store, rule, "now")?;
                let session = serde_json::json!({"id":"g2","scope":"session","service":"x","action":"y","mode":"read-only"});
                assert!(upsert_rule_from_value(tx, &store, session, "now").is_err());
                Ok(())
            })
            .unwrap();
        let n = store
            .with_conn(|conn| list_rules(conn, &store).map(|v| v.len()))
            .unwrap();
        assert_eq!(n, 1);
    }
}
