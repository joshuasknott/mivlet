//! Narrow production consumer: move a reference into an account/workspace/agent
//! bound webhook verification key. No getter, signer, export or arbitrary sink.
use super::*;
use ring::hmac;
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct InstallInput {
    pub request_id: String,
    pub secret_ref: String,
    pub consumer: String,
    pub purpose: String,
    pub target_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct KeyStatus {
    pub key_id: String,
    pub target_id: String,
    pub configured: bool,
    algorithm: &'static str,
}
impl SigningKey {
    fn public(&self) -> KeyStatus {
        KeyStatus {
            key_id: self.id.clone(),
            target_id: self.target_id.clone(),
            configured: !self.revoked,
            algorithm: "hmac-sha256",
        }
    }
}

impl<C: Custody> Service<'_, C> {
    pub(super) fn install(
        &self,
        scope: &Scope,
        input: InstallInput,
        now: i64,
        fence: &impl Fence,
    ) -> Result<KeyStatus, Failure> {
        let started = std::time::Instant::now();
        let _custody = CUSTODY_LOCK.lock().map_err(|_| Failure::Custody)?;
        fence.check()?;
        let id = opaque("webhook-key:")?;
        let record = fence.commit(|| {
            repository::update(self.store, |records| {
                if records.signing_keys.len() >= MAX_HISTORY {
                    return Err(Failure::Limit);
                }
                let record = records
                    .requests
                    .iter_mut()
                    .find(|r| r.id == input.request_id && r.reference == input.secret_ref)
                    .ok_or(Failure::Unavailable)?;
                self.require(record, scope, now, Status::Ready)?;
                if input.consumer != record.input.consumer
                    || input.purpose != record.input.purpose
                    || input.target_id != record.input.target_id
                {
                    return Err(Failure::Unavailable);
                }
                // Durable tombstone precedes all OS I/O. A crash from this point is
                // interrupted, never retried with the old reference.
                record.status = Status::Consuming;
                record.installing_key = Some(id.clone());
                Ok(record.clone())
            })
        })?;
        let result = (|| {
            let value = self
                .custody
                .get(&scope.account, &record.reference)?
                .ok_or(Failure::Unavailable)?;
            self.custody.remove(&scope.account, &record.reference)?;
            fence.check()?;
            self.custody.put(&scope.account, &id, &value)?;
            fence.commit(|| {
                repository::update(self.store, |records| {
                    let current = records
                        .requests
                        .iter_mut()
                        .find(|r| r.id == record.id)
                        .ok_or(Failure::Unavailable)?;
                    self.require(
                        current,
                        scope,
                        now + started.elapsed().as_millis() as i64,
                        Status::Consuming,
                    )?;
                    current.status = Status::Consumed;
                    current.cleanup_pending = false;
                    let key = SigningKey {
                        id: id.clone(),
                        scope: scope.clone(),
                        target_id: input.target_id,
                        request_id: record.id.clone(),
                        created_at: now,
                        revoked: false,
                        cleanup_pending: false,
                    };
                    let status = key.public();
                    records.signing_keys.push(key);
                    Ok(status)
                })
            })
        })();
        if result.is_err() {
            self.close(&record.id, Status::Failed)?;
        }
        result
    }

    fn key(&self, scope: &Scope, id: &str, target: &str) -> Result<SigningKey, Failure> {
        repository::update(self.store, |records| {
            records
                .signing_keys
                .iter()
                .find(|k| {
                    k.id == id
                        && k.target_id == target
                        && k.scope.account == scope.account
                        && k.scope.workspace == scope.workspace
                        && k.scope.agent == scope.agent
                })
                .cloned()
                .ok_or(Failure::Unavailable)
        })
    }

    pub(super) fn key_status(
        &self,
        scope: &Scope,
        id: &str,
        target: &str,
    ) -> Result<KeyStatus, Failure> {
        let key = self.key(scope, id, target)?;
        if !key.revoked && self.custody.get(&scope.account, &key.id)?.is_none() {
            return Err(Failure::Custody);
        }
        Ok(key.public())
    }

    /// For the event-ingress authority: compare the exact raw request bytes to
    /// a GitHub-style `sha256=<hex>` header in constant time. Caller owns event
    /// freshness/deduplication and Work admission. This never starts work.
    pub(super) fn verify(
        &self,
        scope: &Scope,
        id: &str,
        target: &str,
        body: &[u8],
        signature: &str,
    ) -> Result<bool, Failure> {
        if body.len() > 1024 * 1024 {
            return Err(Failure::Invalid);
        }
        let Some(encoded) = signature.strip_prefix("sha256=").filter(|v| v.len() == 64) else {
            return Ok(false);
        };
        let Ok(signature) = hex::decode(encoded) else {
            return Ok(false);
        };
        let _custody = CUSTODY_LOCK.lock().map_err(|_| Failure::Custody)?;
        let key = self.key(scope, id, target)?;
        if key.revoked {
            return Err(Failure::Unavailable);
        }
        let value = self
            .custody
            .get(&scope.account, &key.id)?
            .ok_or(Failure::Custody)?;
        Ok(hmac::verify(
            &hmac::Key::new(hmac::HMAC_SHA256, value.as_bytes()),
            body,
            &signature,
        )
        .is_ok())
    }

    /// Event history may retain selected text only after the same scoped native
    /// consumer removes its signing material. This returns sanitized input,
    /// never a key, signer or export; missing/revoked custody fails closed.
    pub(super) fn redact_event_texts(
        &self,
        scope: &Scope,
        id: &str,
        target: &str,
        texts: &[String],
    ) -> Result<Vec<String>, Failure> {
        if texts.len() > 13
            || texts.iter().any(|text| text.len() > 32_000)
            || texts.iter().map(String::len).sum::<usize>() > 64_000
        {
            return Err(Failure::Invalid);
        }
        let _custody = CUSTODY_LOCK.lock().map_err(|_| Failure::Custody)?;
        let key = self.key(scope, id, target)?;
        if key.revoked {
            return Err(Failure::Unavailable);
        }
        let value = self
            .custody
            .get(&scope.account, &key.id)?
            .ok_or(Failure::Custody)?;
        if value.is_empty() {
            return Err(Failure::Custody);
        }
        let quoted = serde_json::to_string(value.as_str()).map_err(|_| Failure::Invalid)?;
        let escaped = &quoted[1..quoted.len() - 1];
        Ok(texts
            .iter()
            .map(|text| {
                crate::secret_redaction::redact_secret_text_or_omit(
                    &text
                        .replace(value.as_str(), "[REDACTED]")
                        .replace(escaped, "[REDACTED]"),
                )
            })
            .collect())
    }

    pub(super) fn revoke_key(
        &self,
        scope: &Scope,
        id: &str,
        target: &str,
        fence: &impl Fence,
    ) -> Result<KeyStatus, Failure> {
        let _custody = CUSTODY_LOCK.lock().map_err(|_| Failure::Custody)?;
        let key = self.key(scope, id, target)?;
        let status = fence.commit(|| {
            repository::update(self.store, |records| {
                let key = records
                    .signing_keys
                    .iter_mut()
                    .find(|k| k.id == key.id)
                    .ok_or(Failure::Unavailable)?;
                key.revoked = true;
                key.cleanup_pending = true;
                Ok(key.public())
            })
        })?;
        self.cleanup_keys()?;
        Ok(status)
    }

    pub(super) fn cleanup_keys(&self) -> Result<(), Failure> {
        let keys = repository::update(self.store, |records| {
            Ok(records
                .signing_keys
                .iter()
                .filter(|k| k.revoked && k.cleanup_pending)
                .cloned()
                .collect::<Vec<_>>())
        })?;
        for key in keys {
            self.custody.remove(&key.scope.account, &key.id)?;
            repository::update(self.store, |records| {
                records.signing_keys.retain(|k| k.id != key.id);
                Ok(())
            })?;
        }
        Ok(())
    }
}
