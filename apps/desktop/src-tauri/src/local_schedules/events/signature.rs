//! Verifies exactly the received bytes. GitHub headers are not authenticated:
//! repository, freshness and replay identity are therefore taken from the body.
use super::{
    models::{EventConfig, EventSource},
    template,
};
use chrono::{DateTime, Duration, Utc};
use std::collections::BTreeMap;

pub(super) struct VerifiedEvent {
    pub id_fingerprint: String,
    pub body_fingerprint: String,
    pub event_time: DateTime<Utc>,
    pub body: serde_json::Value,
}

pub(super) fn verify(
    config: &EventConfig,
    headers: &BTreeMap<String, String>,
    raw: &[u8],
    now: DateTime<Utc>,
    verifier: impl FnOnce(&[u8], &str) -> Result<bool, String>,
) -> Result<VerifiedEvent, &'static str> {
    let (signed, signature, id) = match &config.source {
        EventSource::SignedJson { source_id } => {
            let source = headers
                .get("x-mivlet-event-source")
                .ok_or("invalid_signature")?;
            let id = headers
                .get("x-mivlet-event-id")
                .ok_or("invalid_signature")?;
            let time = headers
                .get("x-mivlet-event-time")
                .ok_or("invalid_signature")?;
            if source != source_id
                || !template::identifier(id, 128)
                || time.len() > 16
                || !time.bytes().all(|c| c.is_ascii_digit())
            {
                return Err("invalid_signature");
            }
            let mut signed = format!("v1\n{source}\n{id}\n{time}\n").into_bytes();
            signed.extend_from_slice(raw);
            (
                signed,
                headers
                    .get("x-mivlet-signature")
                    .and_then(|s| s.strip_prefix("v1="))
                    .ok_or("invalid_signature")?,
                id.clone(),
            )
        }
        _ => (
            raw.to_vec(),
            headers
                .get("x-hub-signature-256")
                .and_then(|s| s.strip_prefix("sha256="))
                .ok_or("invalid_signature")?,
            super::super::fingerprint(&String::from_utf8_lossy(raw)),
        ),
    };
    let signature = hex::decode(signature).map_err(|_| "invalid_signature")?;
    if signature.len() != 32 {
        return Err("invalid_signature");
    }
    if !verifier(&signed, &format!("sha256={}", hex::encode(&signature)))
        .map_err(|_| "signing_key_unavailable")?
    {
        return Err("invalid_signature");
    }
    let expiry = DateTime::parse_from_rfc3339(&config.valid_until)
        .map_err(|_| "trigger_expired")?
        .with_timezone(&Utc);
    if expiry <= now {
        return Err("trigger_expired");
    }
    let body = template::parse(raw).map_err(|_| "invalid_payload")?;
    let event_time = match &config.source {
        EventSource::SignedJson { .. } => {
            let seconds = headers["x-mivlet-event-time"]
                .parse::<i64>()
                .map_err(|_| "invalid_payload")?;
            DateTime::from_timestamp(seconds, 0).ok_or("invalid_payload")?
        }
        EventSource::GithubIssues { repository }
        | EventSource::GithubWorkflowRun { repository } => {
            let (event, path) = if matches!(config.source, EventSource::GithubIssues { .. }) {
                ("issues", "issue.updated_at")
            } else {
                ("workflow_run", "workflow_run.updated_at")
            };
            if headers.get("x-github-event").map(String::as_str) != Some(event)
                || body["repository"]["full_name"].as_str() != Some(repository.as_str())
                || body["action"].as_str().is_none()
                || (event == "issues" && body["issue"]["pull_request"].is_object())
            {
                return Err("source_mismatch");
            }
            let value = template::lookup(&body, path)
                .and_then(serde_json::Value::as_str)
                .ok_or("missing_signed_timestamp")?;
            DateTime::parse_from_rfc3339(value)
                .map_err(|_| "invalid_payload")?
                .with_timezone(&Utc)
        }
    };
    if event_time > now + Duration::seconds(30)
        || event_time < now - Duration::seconds(config.max_age_seconds.into())
    {
        return Err("event_expired");
    }
    let id_fingerprint = super::super::fingerprint(&format!(
        "{}:{id}",
        serde_json::to_string(&config.source).map_err(|_| "source_mismatch")?
    ));
    Ok(VerifiedEvent {
        body_fingerprint: super::super::fingerprint(&format!(
            "{id_fingerprint}:{}",
            hex::encode(ring::digest::digest(&ring::digest::SHA256, raw).as_ref())
        )),
        id_fingerprint,
        event_time,
        body,
    })
}
