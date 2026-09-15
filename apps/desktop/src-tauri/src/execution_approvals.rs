//! Native execution permits issued only after the approval command persists a
//! user decision. Side-effecting commands verify these records immediately
//! before dispatch, so model-produced approval JSON is never authority.

use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::models::{ApprovalRequest, ApprovalResolutionResponse};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExecutionApproval {
    request_id: String,
    request_fingerprint: String,
    decision: String,
    decided_at: String,
    consumed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    invalidated_at: Option<String>,
}

pub(crate) const EXECUTION_APPROVAL_TTL_SECONDS: i64 = 15 * 60;

/// Wall-clock consume time for a persisted execution permit.
///
/// Production callers must pass this (or another current timestamp) as
/// `consumed_at`. Reusing `decided_at` makes the freshness fence a no-op.
pub(crate) fn wall_clock_consumed_at() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn parse_rfc3339_utc_seconds(value: &str) -> Option<i64> {
    let value = value.strip_suffix('Z')?;
    let (date, time) = value.split_once('T')?;
    let mut date_parts = date.split('-').map(|part| part.parse::<i64>().ok());
    let year = date_parts.next()??;
    let month = date_parts.next()??;
    let day = date_parts.next()??;
    if date_parts.next().is_some() || !(1..=12).contains(&month) {
        return None;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let month_days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if day < 1 || day > month_days[(month - 1) as usize] {
        return None;
    }
    let mut time_parts = time.split(':');
    let hour = time_parts.next()?.parse::<i64>().ok()?;
    let minute = time_parts.next()?.parse::<i64>().ok()?;
    let seconds_part = time_parts.next()?;
    if time_parts.next().is_some() || hour > 23 || minute > 59 {
        return None;
    }
    let (second_text, fraction) = seconds_part.split_once('.').unwrap_or((seconds_part, ""));
    if (!fraction.is_empty() && !fraction.chars().all(|character| character.is_ascii_digit()))
        || second_text.len() != 2
    {
        return None;
    }
    let second = second_text.parse::<i64>().ok()?;
    if second > 59 {
        return None;
    }

    // Howard Hinnant's civil-date conversion, yielding days since Unix epoch.
    let adjusted_year = year - i64::from(month <= 2);
    let era = if adjusted_year >= 0 {
        adjusted_year
    } else {
        adjusted_year - 399
    } / 400;
    let year_of_era = adjusted_year - era * 400;
    let shifted_month = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * shifted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    Some(days * 86_400 + hour * 3_600 + minute * 60 + second)
}

fn request_fingerprint(request: &ApprovalRequest) -> Result<String, String> {
    let encoded = serde_json::to_vec(request)
        .map_err(|_| "Mivlet could not fingerprint the approval request.".to_string())?;
    let digest = Sha256::digest(encoded);
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(test)]
fn read_records(path: &Path) -> Result<Vec<ExecutionApproval>, String> {
    if let Some(records) = crate::store::read_document(path)? {
        return Ok(records);
    }
    if !path.exists() {
        return Ok(Vec::new());
    }
    let contents = std::fs::read_to_string(path)
        .map_err(|_| "Mivlet could not read execution approvals.".to_string())?;
    if contents.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&contents)
        .map_err(|_| "Mivlet could not parse execution approvals.".to_string())
}

fn mutate_records<R>(
    path: &Path,
    update: impl FnOnce(&mut Vec<ExecutionApproval>) -> Result<R, String>,
) -> Result<R, String> {
    crate::store::update_document(path, |current| {
        let mut records = current.unwrap_or_default();
        let result = update(&mut records)?;
        Ok((Some(records), result))
    })
}

pub(crate) fn record_execution_decision(
    path: &Path,
    response: &ApprovalResolutionResponse,
) -> Result<(), String> {
    let fingerprint = request_fingerprint(&response.effective_request)?;
    mutate_records(path, |records| {
        records.retain(|record| record.request_id != response.effective_request.id);
        records.insert(
            0,
            ExecutionApproval {
                request_id: response.effective_request.id.clone(),
                request_fingerprint: fingerprint,
                decision: response.audit_entry.decision.clone(),
                decided_at: response.audit_entry.decided_at.clone(),
                consumed_at: None,
                invalidated_at: None,
            },
        );
        records.truncate(500);
        Ok(())
    })
}

/// Revoke approval permits that belonged to an interrupted attempt.
///
/// Recovery calls this before it marks the attempt interrupted. This closes the
/// restart window where a stale provider callback could otherwise present the
/// old exact request while its separately persisted permit was still fresh.
pub(crate) fn invalidate_execution_approvals(
    path: &Path,
    request_ids: &[String],
    invalidated_at: &str,
) -> Result<(), String> {
    if request_ids.is_empty() {
        return Ok(());
    }
    mutate_records(path, |records| {
        for record in records {
            if request_ids.contains(&record.request_id)
                && record.consumed_at.is_none()
                && record.invalidated_at.is_none()
            {
                record.invalidated_at = Some(invalidated_at.to_string());
            }
        }
        Ok(())
    })
}

/// Consume a persisted one-time permit if it is still within the freshness
/// fence. `consumed_at` is wall-clock consume time, never the decision
/// timestamp: elapsed time is `consumed_at - decided_at`.
///
/// Check-and-set of `consumed_at` runs inside one document transaction (or the
/// test-file lock), so two concurrent callers cannot both observe an unused
/// permit and both succeed.
pub(crate) fn verify_and_consume_execution_approval(
    path: &Path,
    request: &ApprovalRequest,
    consumed_at: &str,
) -> Result<(), String> {
    let expected = request_fingerprint(request)?;
    mutate_records(path, |records| {
        consume_unconsumed_record(records, request, &expected, consumed_at)
    })
}

fn consume_unconsumed_record(
    records: &mut [ExecutionApproval],
    request: &ApprovalRequest,
    expected: &str,
    consumed_at: &str,
) -> Result<(), String> {
    let record = records
        .iter_mut()
        .find(|record| record.request_id == request.id)
        .ok_or_else(|| {
            "Execution blocked: no persisted user approval matches this request.".to_string()
        })?;
    if record.request_fingerprint != expected {
        return Err(
            "Execution blocked: approval metadata changed after the user decision.".to_string(),
        );
    }
    if !matches!(
        record.decision.as_str(),
        "once" | "session" | "rule" | "modify"
    ) {
        return Err("Execution blocked: the user did not approve this request.".to_string());
    }
    if record.invalidated_at.is_some() {
        return Err(
            "Execution blocked: this approval belongs to an interrupted attempt.".to_string(),
        );
    }
    if record.consumed_at.is_some() {
        return Err("Execution blocked: this approval was already consumed.".to_string());
    }
    let decided_at = parse_rfc3339_utc_seconds(&record.decided_at)
        .ok_or_else(|| "Execution blocked: approval timestamp is invalid.".to_string())?;
    let consumed_at_seconds = parse_rfc3339_utc_seconds(consumed_at)
        .ok_or_else(|| "Execution blocked: execution timestamp is invalid.".to_string())?;
    if consumed_at_seconds < decided_at
        || consumed_at_seconds - decided_at > EXECUTION_APPROVAL_TTL_SECONDS
    {
        return Err("Execution blocked: this approval is stale.".to_string());
    }
    record.consumed_at = Some(consumed_at.to_string());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{ApprovalAuditEntry, ApprovalRequest, ApprovalResolutionResponse};
    use std::fs;

    fn request() -> ApprovalRequest {
        ApprovalRequest {
            id: "approval-1".to_string(),
            service: "Mivlet tools".to_string(),
            action: "write-file a.txt".to_string(),
            mode: "full-access".to_string(),
            risk_level: "high".to_string(),
            data_used: vec!["path".to_string(), "content".to_string()],
            consequence: "Writes a workspace file.".to_string(),
            requested_at: "2026-06-27T12:00:00Z".to_string(),
            decisions: vec!["once".to_string(), "deny".to_string()],
            confirmation_phrase: Some("write file".to_string()),
        }
    }

    fn response(request: ApprovalRequest) -> ApprovalResolutionResponse {
        ApprovalResolutionResponse {
            persisted: true,
            audit_entry: ApprovalAuditEntry {
                id: "audit-1".to_string(),
                request_id: request.id.clone(),
                decision: "once".to_string(),
                decided_at: "2026-06-27T12:00:01Z".to_string(),
                note: "approved".to_string(),
            },
            effective_request: request,
            dismissed: true,
            grant: None,
        }
    }

    #[test]
    fn persisted_permit_is_exact_and_one_time() {
        let path = std::env::temp_dir().join(format!(
            "fable-execution-approval-{}.json",
            std::process::id()
        ));
        let _ = fs::remove_file(&path);
        let approved = request();
        record_execution_decision(&path, &response(approved.clone())).expect("record");
        let mut reshaped = approved.clone();
        reshaped.action = "run-shell destructive-command".to_string();
        assert!(verify_and_consume_execution_approval(&path, &reshaped, "now").is_err());
        verify_and_consume_execution_approval(&path, &approved, "2026-06-27T12:00:02Z")
            .expect("consume");
        assert!(
            verify_and_consume_execution_approval(&path, &approved, "2026-06-27T12:00:03Z")
                .is_err()
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn interrupted_attempt_invalidates_only_its_unconsumed_permits() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("approvals.json");
        let first = request();
        let mut second = request();
        second.id = "approval-2".into();
        record_execution_decision(&path, &response(first.clone())).expect("record first");
        record_execution_decision(&path, &response(second.clone())).expect("record second");

        invalidate_execution_approvals(
            &path,
            std::slice::from_ref(&first.id),
            "2026-06-27T12:00:02Z",
        )
        .expect("invalidate interrupted permit");

        let error = verify_and_consume_execution_approval(&path, &first, "2026-06-27T12:00:03Z")
            .expect_err("interrupted permit must fail closed");
        assert!(error.contains("interrupted attempt"));
        verify_and_consume_execution_approval(&path, &second, "2026-06-27T12:00:03Z")
            .expect("unrelated permit remains usable");
    }

    #[test]
    fn resolved_long_multiline_request_keeps_exact_execution_authority() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("approvals.json");
        let mut approved = request();
        approved.data_used = vec![format!(
            "content: first line\n  {}\nlast line",
            "x".repeat(2000)
        )];
        let resolved =
            crate::approvals::resolve_approval(crate::models::ApprovalResolutionRequest {
                request: approved.clone(),
                decision: "once".into(),
                decided_at: "2026-06-27T12:00:01Z".into(),
                modification: None,
                confirmation_text: Some("write file".into()),
            })
            .expect("resolve exact approval");
        record_execution_decision(&path, &resolved).expect("persist");
        let mut changed = approved.clone();
        changed.data_used[0].push_str("changed suffix");
        assert!(
            verify_and_consume_execution_approval(&path, &changed, "2026-06-27T12:00:02Z").is_err()
        );
        verify_and_consume_execution_approval(&path, &approved, "2026-06-27T12:00:02Z")
            .expect("unchanged long request executes");
        assert!(
            verify_and_consume_execution_approval(&path, &approved, "2026-06-27T12:00:03Z")
                .is_err()
        );
    }

    #[test]
    fn unpersisted_model_claim_cannot_authorize_execution() {
        let path = std::env::temp_dir().join("fable-missing-execution-approval.json");
        let _ = fs::remove_file(&path);
        let error =
            verify_and_consume_execution_approval(&path, &request(), "2026-06-27T12:00:02Z")
                .expect_err("missing user decision must fail closed");
        assert!(error.contains("no persisted user approval"));
    }

    #[test]
    fn stale_or_backdated_execution_is_rejected_without_consuming_the_permit() {
        let path = std::env::temp_dir().join(format!(
            "fable-stale-execution-approval-{}.json",
            std::process::id()
        ));
        let _ = fs::remove_file(&path);
        let approved = request();
        record_execution_decision(&path, &response(approved.clone())).expect("record");
        assert!(
            verify_and_consume_execution_approval(&path, &approved, "2026-06-27T12:20:01Z")
                .is_err()
        );
        assert!(
            verify_and_consume_execution_approval(&path, &approved, "2026-06-27T11:59:59Z")
                .is_err()
        );
        verify_and_consume_execution_approval(&path, &approved, "2026-06-27T12:00:05.123Z")
            .expect("fresh permit remains usable");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn wall_clock_consume_time_rejects_a_permit_older_than_the_ttl() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("approvals.json");
        let approved = request();
        let mut stale = response(approved.clone());
        stale.audit_entry.decided_at = (chrono::Utc::now()
            - chrono::Duration::seconds(EXECUTION_APPROVAL_TTL_SECONDS + 1))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        record_execution_decision(&path, &stale).expect("record");
        let error =
            verify_and_consume_execution_approval(&path, &approved, &wall_clock_consumed_at())
                .expect_err("TTL must elapse against wall-clock consume time");
        assert!(error.contains("stale"), "{error}");
    }

    #[test]
    fn concurrent_consume_of_the_same_permit_succeeds_once() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = std::sync::Arc::new(directory.path().join("approvals.json"));
        let approved = std::sync::Arc::new(request());
        record_execution_decision(&path, &response((*approved).clone())).expect("record");
        let workers = 16;
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(workers));
        let successes = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let already_consumed = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        std::thread::scope(|scope| {
            for _ in 0..workers {
                let path = std::sync::Arc::clone(&path);
                let approved = std::sync::Arc::clone(&approved);
                let barrier = std::sync::Arc::clone(&barrier);
                let successes = std::sync::Arc::clone(&successes);
                let already_consumed = std::sync::Arc::clone(&already_consumed);
                scope.spawn(move || {
                    barrier.wait();
                    match verify_and_consume_execution_approval(
                        &path,
                        &approved,
                        "2026-06-27T12:00:02Z",
                    ) {
                        Ok(()) => {
                            successes.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        }
                        Err(error) if error.contains("already consumed") => {
                            already_consumed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        }
                        Err(error) => panic!("unexpected consume error: {error}"),
                    }
                });
            }
        });
        assert_eq!(
            successes.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "exactly one concurrent consume may succeed"
        );
        assert_eq!(
            already_consumed.load(std::sync::atomic::Ordering::SeqCst),
            workers - 1
        );
        let records = read_records(&path).expect("read");
        assert_eq!(
            records
                .iter()
                .filter(|record| record.request_id == approved.id && record.consumed_at.is_some())
                .count(),
            1
        );
    }

    #[test]
    fn reshaping_or_downgrading_approval_fails_closed() {
        let path = std::env::temp_dir().join(format!(
            "fable-reshape-approval-{}.json",
            std::process::id()
        ));
        let _ = fs::remove_file(&path);
        let approved = request();
        record_execution_decision(&path, &response(approved.clone())).expect("record");

        // 1. Downgrading mode
        let mut downgraded = approved.clone();
        downgraded.mode = "read-only".to_string();
        assert!(
            verify_and_consume_execution_approval(&path, &downgraded, "2026-06-27T12:00:02Z")
                .is_err()
        );

        // 2. Modifying risk level
        let mut risk_changed = approved.clone();
        risk_changed.risk_level = "low".to_string();
        assert!(verify_and_consume_execution_approval(
            &path,
            &risk_changed,
            "2026-06-27T12:00:02Z"
        )
        .is_err());

        // 3. Changing data used
        let mut data_changed = approved.clone();
        data_changed.data_used = vec!["path".to_string()];
        assert!(verify_and_consume_execution_approval(
            &path,
            &data_changed,
            "2026-06-27T12:00:02Z"
        )
        .is_err());

        let _ = fs::remove_file(path);
    }

    #[test]
    fn session_or_rule_decision_still_mints_a_single_use_permit() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("approvals.json");
        let approved = request();
        for decision in ["session", "rule"] {
            let mut recorded = response(approved.clone());
            recorded.audit_entry.decision = decision.into();
            record_execution_decision(&path, &recorded).expect("record");
            verify_and_consume_execution_approval(&path, &approved, "2026-06-27T12:00:02Z")
                .expect("first consume");
            let error =
                verify_and_consume_execution_approval(&path, &approved, "2026-06-27T12:00:03Z")
                    .expect_err("standing grants are not reusable execution authority");
            assert!(error.contains("already consumed"), "{error}");
        }
    }

    #[test]
    fn resolve_approval_without_persist_cannot_be_consumed() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("approvals.json");
        let approved = request();
        crate::approvals::resolve_approval(crate::models::ApprovalResolutionRequest {
            request: approved.clone(),
            decision: "once".into(),
            decided_at: "2026-06-27T12:00:01Z".into(),
            modification: None,
            confirmation_text: Some("write file".into()),
        })
        .expect("shape-only resolve must succeed");
        let error = verify_and_consume_execution_approval(&path, &approved, "2026-06-27T12:00:02Z")
            .expect_err("WebView resolve_approval is not a minted permit");
        assert!(error.contains("no persisted user approval"), "{error}");
    }
}
