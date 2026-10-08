//! Native protected capture and purpose-bound one-use references. Only public
//! metadata crosses IPC; values move from a native dialog to OS custody and a
//! closed native consumer. Interrupted transfers never replay.
mod capture;
mod custody;
mod repository;
pub(crate) mod runtime;
#[cfg(test)]
mod tests;
mod webhook;

use crate::store::Store;
use custody::{Custody, Secret};
pub(crate) use runtime::{execute, start_maintenance};
use serde::{Deserialize, Serialize};

const TTL_MS: i64 = 10 * 60 * 1000;
const CONSUMER: &str = "webhook-signing-key";
const PURPOSE: &str = "verify-webhook-signature";
const MAX_HISTORY: usize = 500;
// Serialize custody transfers and cleanup, never native capture or Stop. SQLite
// still owns the durable claim; this lock closes delete-versus-late-put races.
static CUSTODY_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Failure {
    Invalid,
    Unavailable,
    Expired,
    Stopped,
    Custody,
    History,
    Limit,
    Capture,
}
impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Invalid => "This protected request is invalid or uses an unsupported purpose or consumer.",
            Self::Unavailable => "This protected reference is unknown, already answered, used, or belongs to another scope.",
            Self::Expired => "This protected request expired. Request a new secret.",
            Self::Stopped => "The requesting agent or account stopped. Request a new secret in a new turn.",
            Self::Custody => "Native protected credential storage is unavailable. No secret was returned.",
            Self::History => "Protected request history could not be saved. Check status before continuing.",
            Self::Limit => "Protected request storage is full. Remove unused signing keys before continuing.",
            Self::Capture => "Protected native entry is unavailable. No secret was accepted.",
        })
    }
}
impl From<crate::store::StoreError> for Failure {
    fn from(_: crate::store::StoreError) -> Self {
        Self::History
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Scope {
    account: String,
    workspace: String,
    agent: String,
    generation: u64,
}

/// Preflight may read the Store. Commit must use only cached account/generation
/// checks around SQL COMMIT; never acquire the Store or perform custody I/O.
trait Fence {
    fn check(&self) -> Result<(), Failure>;
    fn commit<T>(&self, operation: impl FnOnce() -> Result<T, Failure>) -> Result<T, Failure>;
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RequestInput {
    label: String,
    reason: String,
    purpose: String,
    consumer: String,
    target_id: String,
}
impl RequestInput {
    fn validate(&self) -> Result<(), Failure> {
        if self.consumer != CONSUMER
            || self.purpose != PURPOSE
            || !safe_text(&self.label, 80)
            || !safe_text(&self.reason, 240)
            || !valid_id(&self.target_id)
        {
            return Err(Failure::Invalid);
        }
        Ok(())
    }
}
fn safe_text(value: &str, max: usize) -> bool {
    !value.trim().is_empty()
        && value.len() <= max
        && !value.chars().any(|c| {
            c.is_control()
                || matches!(c, '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
        && !crate::secret_redaction::looks_secret(value)
}
fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
}
fn opaque(prefix: &str) -> Result<String, Failure> {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes).map_err(|_| Failure::Custody)?;
    Ok(format!("{prefix}{}", hex::encode(bytes)))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum Status {
    Pending,
    Ready,
    Declined,
    Expired,
    Stopped,
    Consuming,
    Consumed,
    Interrupted,
    Failed,
}
impl Status {
    fn terminal(self) -> bool {
        !matches!(self, Self::Pending | Self::Ready | Self::Consuming)
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    id: String,
    approved_request: String,
    scope: Scope,
    input: RequestInput,
    boot: String,
    reference: String,
    status: Status,
    created_at: i64,
    expires_at: i64,
    cleanup_pending: bool,
    installing_key: Option<String>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SigningKey {
    id: String,
    scope: Scope,
    target_id: String,
    request_id: String,
    created_at: i64,
    revoked: bool,
    cleanup_pending: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicRequest {
    request_id: String,
    label: String,
    reason: String,
    purpose: String,
    consumer: String,
    target_id: String,
    status: Status,
    expires_at: i64,
    cleanup_pending: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    secret_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    installed_key_id: Option<String>,
}
impl Record {
    fn public(&self, include_ref: bool) -> PublicRequest {
        PublicRequest {
            request_id: self.id.clone(),
            label: self.input.label.clone(),
            reason: self.input.reason.clone(),
            purpose: self.input.purpose.clone(),
            consumer: self.input.consumer.clone(),
            target_id: self.input.target_id.clone(),
            status: self.status,
            expires_at: self.expires_at,
            cleanup_pending: self.status.terminal() && self.cleanup_pending,
            secret_ref: (include_ref && self.status == Status::Ready)
                .then(|| self.reference.clone()),
            installed_key_id: (self.status == Status::Consumed)
                .then(|| self.installing_key.clone())
                .flatten(),
        }
    }
}

struct Service<'a, C: Custody> {
    store: &'a Store,
    custody: &'a C,
    boot: &'a str,
}
impl<C: Custody> Service<'_, C> {
    fn begin(
        &self,
        scope: &Scope,
        approved_request: &str,
        input: RequestInput,
        now: i64,
        fence: &impl Fence,
    ) -> Result<Record, Failure> {
        input.validate()?;
        let record = Record {
            id: opaque("secret-request:")?,
            reference: opaque("secret-ref:")?,
            approved_request: approved_request.into(),
            scope: scope.clone(),
            input,
            boot: self.boot.into(),
            status: Status::Pending,
            created_at: now,
            expires_at: now + TTL_MS,
            cleanup_pending: true,
            installing_key: None,
        };
        repository::update_fenced(self.store, fence, |records| {
            if records
                .requests
                .iter()
                .any(|r| r.approved_request == approved_request)
            {
                return Err(Failure::Unavailable);
            }
            if records.requests.len() >= MAX_HISTORY {
                if let Some(index) = records
                    .requests
                    .iter()
                    .position(|r| r.status.terminal() && !r.cleanup_pending)
                {
                    records.requests.remove(index);
                } else {
                    return Err(Failure::Limit);
                }
            }
            records.requests.push(record.clone());
            Ok(record)
        })
    }

    fn answer(
        &self,
        record: &Record,
        answer: Option<Secret>,
        now: i64,
        fence: &impl Fence,
    ) -> Result<PublicRequest, Failure> {
        let started = std::time::Instant::now();
        let _custody = CUSTODY_LOCK.lock().map_err(|_| Failure::Custody)?;
        if now >= record.expires_at {
            self.close(&record.id, Status::Expired)?;
            return Err(Failure::Expired);
        }
        if fence.check().is_err() {
            self.close(&record.id, Status::Stopped)?;
            return Err(Failure::Stopped);
        }
        // Claim the pending record before touching custody; duplicate answers
        // never replace a ready value. Only this native caller holds the value.
        repository::update_fenced(self.store, fence, |records| {
            let current = records
                .requests
                .iter_mut()
                .find(|r| r.id == record.id)
                .ok_or(Failure::Unavailable)?;
            self.require(current, &record.scope, now, Status::Pending)?;
            current.status = Status::Consuming;
            Ok(())
        })?;
        let outcome = if let Some(value) = answer {
            if value.len() < 16 || value.len() > 512 || value.contains('\0') {
                self.close(&record.id, Status::Failed)?;
                return Err(Failure::Invalid);
            }
            self.custody
                .put(&record.scope.account, &record.reference, &value)
                .map(|_| Status::Ready)
        } else {
            Ok(Status::Declined)
        };
        let status = match outcome {
            Ok(status) => status,
            Err(error) => {
                self.close(&record.id, Status::Failed)?;
                return Err(error);
            }
        };
        let result = repository::update_fenced(self.store, fence, |records| {
            let current = records
                .requests
                .iter_mut()
                .find(|r| r.id == record.id)
                .ok_or(Failure::Unavailable)?;
            self.require(
                current,
                &record.scope,
                now + started.elapsed().as_millis() as i64,
                Status::Consuming,
            )?;
            current.status = status;
            current.cleanup_pending = status == Status::Ready;
            Ok(current.public(true))
        });
        if result.is_err() {
            self.close(&record.id, Status::Stopped)?;
        }
        result
    }

    fn require(
        &self,
        record: &Record,
        scope: &Scope,
        now: i64,
        status: Status,
    ) -> Result<(), Failure> {
        if &record.scope != scope || record.status != status {
            return Err(Failure::Unavailable);
        }
        if record.boot != self.boot {
            return Err(Failure::Stopped);
        }
        if now < record.created_at || now >= record.expires_at {
            return Err(Failure::Expired);
        }
        Ok(())
    }

    fn close(&self, id: &str, status: Status) -> Result<(), Failure> {
        let record = repository::update(self.store, |records| {
            let record = records
                .requests
                .iter_mut()
                .find(|r| r.id == id)
                .ok_or(Failure::Unavailable)?;
            if !record.status.terminal() {
                record.status = status;
            }
            Ok(record.clone())
        })?;
        self.cleanup(&record)
    }

    fn cleanup(&self, record: &Record) -> Result<(), Failure> {
        if !record.status.terminal() || !record.cleanup_pending {
            return Ok(());
        }
        self.custody
            .remove(&record.scope.account, &record.reference)?;
        if record.status != Status::Consumed {
            if let Some(id) = &record.installing_key {
                self.custody.remove(&record.scope.account, id)?;
            }
        }
        repository::update(self.store, |records| {
            if let Some(current) = records.requests.iter_mut().find(|r| r.id == record.id) {
                current.cleanup_pending = false;
            }
            Ok(())
        })
    }

    fn sweep(&self, now: i64, current: impl Fn(&Scope) -> bool) -> Result<(), Failure> {
        let _custody = CUSTODY_LOCK.lock().map_err(|_| Failure::Custody)?;
        // Resolve generations outside the SQL transaction. Only cached final
        // commit checks belong under its lock; maintenance can do broader I/O.
        let snapshot = repository::update(self.store, |records| Ok(records.requests.clone()))?;
        let stale = snapshot
            .iter()
            .filter_map(|r| {
                if r.status.terminal() {
                    return None;
                }
                let status = if r.boot != self.boot {
                    Status::Interrupted
                } else if now < r.created_at || now >= r.expires_at {
                    Status::Expired
                } else if !current(&r.scope) {
                    Status::Stopped
                } else {
                    return None;
                };
                Some((r.id.clone(), status))
            })
            .collect::<std::collections::HashMap<_, _>>();
        let cleanup = repository::update(self.store, |records| {
            for r in &mut records.requests {
                if !r.status.terminal() {
                    if let Some(status) = stale.get(&r.id) {
                        r.status = *status;
                    }
                }
            }
            Ok(records
                .requests
                .iter()
                .filter(|r| r.status.terminal() && r.cleanup_pending)
                .cloned()
                .collect::<Vec<_>>())
        })?;
        let mut failed = false;
        for record in cleanup {
            failed |= self.cleanup(&record).is_err();
        }
        failed |= self.cleanup_keys().is_err();
        if failed {
            Err(Failure::Custody)
        } else {
            Ok(())
        }
    }

    fn history(&self, scope: &Scope) -> Result<Vec<PublicRequest>, Failure> {
        repository::update(self.store, |records| {
            Ok(records
                .requests
                .iter()
                .filter(|r| {
                    r.scope.account == scope.account
                        && r.scope.workspace == scope.workspace
                        && r.scope.agent == scope.agent
                })
                .rev()
                .take(50)
                .map(|r| r.public(false))
                .collect())
        })
    }
}
