//! Canonical Routine recurrence and native driver orchestration.
//!
//! Recurrence is evaluated from immutable Routine trigger evidence. The pure
//! functions intentionally mirror the legacy scheduler's minute-granularity
//! semantics so shadow comparison can prove equality before the persisted
//! one-writer marker changes.

use chrono::{DateTime, Datelike, Duration, SecondsFormat, Timelike, Utc, Weekday};
use chrono_tz::Tz;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

use crate::models::RUNNING_LEASE_MS;
use crate::store::repos::routine::{self, DriverLeaseRow, RoutineSchedulerInput};

const MAX_SCAN_MINUTES: i64 = 370 * 24 * 60;
const MAX_MISSED_OCCURRENCES: usize = 100;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LiteRecurrence {
    frequency: String,
    interval: u32,
    #[serde(default)]
    by_weekday: Vec<String>,
    by_month_day: Option<u32>,
    hour: u32,
    minute: u32,
}

#[derive(Clone, Debug)]
enum TimeSpec {
    Once(DateTime<Utc>),
    Recurring {
        timezone: Tz,
        rule: LiteRecurrence,
        until: Option<DateTime<Utc>>,
        missed_policy: String,
    },
}

fn parse_time_spec(trigger: &Value) -> Result<TimeSpec, String> {
    let spec = trigger
        .get("spec")
        .ok_or_else(|| "Routine trigger spec is missing.".to_string())?;
    match spec.get("kind").and_then(Value::as_str) {
        Some("time-once") => {
            let at = spec
                .get("at")
                .and_then(Value::as_str)
                .ok_or_else(|| "One-time Routine trigger timestamp is missing.".to_string())?;
            let at = DateTime::parse_from_rfc3339(at)
                .map_err(|_| "One-time Routine trigger timestamp is invalid.".to_string())?
                .with_timezone(&Utc);
            Ok(TimeSpec::Once(at))
        }
        Some("time-recurring") => {
            let timezone = spec
                .get("timezone")
                .and_then(Value::as_str)
                .ok_or_else(|| "Recurring Routine timezone is missing.".to_string())?
                .parse::<Tz>()
                .map_err(|_| "Recurring Routine timezone is invalid.".to_string())?;
            let expression = spec
                .pointer("/recurrence/expression")
                .and_then(Value::as_str)
                .and_then(|value| value.strip_prefix("legacy-rrule-lite:v1:"))
                .ok_or_else(|| "Recurring Routine expression is unsupported.".to_string())?;
            let rule: LiteRecurrence = serde_json::from_str(expression)
                .map_err(|_| "Recurring Routine expression is invalid.".to_string())?;
            validate_rule(&rule)?;
            let until = spec
                .pointer("/recurrence/until")
                .and_then(Value::as_str)
                .map(DateTime::parse_from_rfc3339)
                .transpose()
                .map_err(|_| "Recurring Routine cutoff is invalid.".to_string())?
                .map(|value| value.with_timezone(&Utc));
            let missed_policy = spec
                .get("missedRunPolicy")
                .and_then(Value::as_str)
                .unwrap_or("skip")
                .to_string();
            if !matches!(
                missed_policy.as_str(),
                "skip" | "run-once" | "run-all" | "run-latest"
            ) {
                return Err("Recurring Routine missed-run policy is invalid.".to_string());
            }
            Ok(TimeSpec::Recurring {
                timezone,
                rule,
                until,
                missed_policy,
            })
        }
        _ => Err("Routine trigger is not time-based.".to_string()),
    }
}

fn validate_rule(rule: &LiteRecurrence) -> Result<(), String> {
    if !matches!(rule.frequency.as_str(), "daily" | "weekly" | "monthly")
        || rule.interval == 0
        || rule.hour > 23
        || rule.minute > 59
        || (rule.frequency == "monthly"
            && !rule.by_month_day.is_some_and(|day| (1..=31).contains(&day)))
        || rule.by_weekday.iter().any(|day| weekday(day).is_none())
    {
        return Err("Recurring Routine rule is invalid.".to_string());
    }
    Ok(())
}

fn weekday(value: &str) -> Option<Weekday> {
    match value {
        "Mon" => Some(Weekday::Mon),
        "Tue" => Some(Weekday::Tue),
        "Wed" => Some(Weekday::Wed),
        "Thu" => Some(Weekday::Thu),
        "Fri" => Some(Weekday::Fri),
        "Sat" => Some(Weekday::Sat),
        "Sun" => Some(Weekday::Sun),
        _ => None,
    }
}

fn calendar_ordinal(year: i32, month: u32, day: u32) -> i64 {
    let date =
        chrono::NaiveDate::from_ymd_opt(year, month, day).expect("timezone-local dates are valid");
    let epoch = chrono::NaiveDate::from_ymd_opt(1970, 1, 1).expect("epoch is valid");
    date.signed_duration_since(epoch).num_days()
}

fn matches_rule(candidate: DateTime<Utc>, timezone: Tz, rule: &LiteRecurrence) -> bool {
    let local = candidate.with_timezone(&timezone);
    if local.hour() != rule.hour || local.minute() != rule.minute {
        return false;
    }
    let ordinal = calendar_ordinal(local.year(), local.month(), local.day());
    match rule.frequency.as_str() {
        "daily" => ordinal.rem_euclid(i64::from(rule.interval)) == 0,
        "weekly" => {
            let allowed = if rule.by_weekday.is_empty() {
                true
            } else {
                rule.by_weekday
                    .iter()
                    .filter_map(|value| weekday(value))
                    .any(|value| value == local.weekday())
            };
            allowed && ordinal.div_euclid(7).rem_euclid(i64::from(rule.interval)) == 0
        }
        "monthly" => {
            let month_index = i64::from(local.year()) * 12 + i64::from(local.month0());
            local.day() == rule.by_month_day.unwrap_or(1)
                && month_index.rem_euclid(i64::from(rule.interval)) == 0
        }
        _ => false,
    }
}

fn next_occurrence(spec: &TimeSpec, after: DateTime<Utc>) -> Option<DateTime<Utc>> {
    match spec {
        TimeSpec::Once(at) => (*at > after).then_some(*at),
        TimeSpec::Recurring {
            timezone,
            rule,
            until,
            ..
        } => {
            let after_local = after.with_timezone(timezone);
            let start = after
                .with_second(0)?
                .with_nanosecond(0)?
                .checked_add_signed(Duration::minutes(1))?;
            for offset in 0..MAX_SCAN_MINUTES {
                let candidate = start.checked_add_signed(Duration::minutes(offset))?;
                if until.is_some_and(|cutoff| candidate > cutoff) {
                    return None;
                }
                if matches_rule(candidate, *timezone, rule) {
                    let local = candidate.with_timezone(timezone);
                    if (
                        local.year(),
                        local.month(),
                        local.day(),
                        local.hour(),
                        local.minute(),
                    ) == (
                        after_local.year(),
                        after_local.month(),
                        after_local.day(),
                        after_local.hour(),
                        after_local.minute(),
                    ) {
                        continue;
                    }
                    return Some(candidate);
                }
            }
            None
        }
    }
}

fn due_occurrences(
    spec: &TimeSpec,
    previous: DateTime<Utc>,
    now: DateTime<Utc>,
) -> Vec<DateTime<Utc>> {
    let policy = match spec {
        TimeSpec::Once(_) => "run-all",
        TimeSpec::Recurring { missed_policy, .. } => missed_policy.as_str(),
    };
    if policy == "skip" || now <= previous {
        return Vec::new();
    }
    let mut occurrences = Vec::new();
    let mut cursor = previous;
    while occurrences.len() < MAX_MISSED_OCCURRENCES {
        let Some(next) = next_occurrence(spec, cursor) else {
            break;
        };
        if next > now {
            break;
        }
        occurrences.push(next);
        cursor = next;
    }
    if matches!(policy, "run-once" | "run-latest") {
        occurrences.into_iter().rev().take(1).collect()
    } else {
        occurrences
    }
}

fn iso(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn parse_instant(value: &str, label: &str) -> Result<DateTime<Utc>, String> {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|_| format!("{label} is invalid."))
}

fn stable_id(prefix: &str, parts: &[&str]) -> String {
    let mut digest = Sha256::new();
    for part in parts {
        digest.update(part.as_bytes());
        digest.update([0]);
    }
    format!("{prefix}_{:x}", digest.finalize())
}

fn fresh_token(prefix: &str) -> Result<String, String> {
    let mut bytes = [0_u8; 24];
    getrandom::fill(&mut bytes).map_err(|_| format!("Could not create {prefix} token."))?;
    Ok(format!("{prefix}_{}", hex::encode(bytes)))
}

fn active_triggers(input: &RoutineSchedulerInput) -> Vec<&Value> {
    let declared = input
        .bundle
        .current_version
        .get("triggerIds")
        .and_then(Value::as_array);
    input
        .bundle
        .triggers
        .iter()
        .filter(|trigger| {
            trigger.get("status").and_then(Value::as_str) == Some("active")
                && trigger.get("id").and_then(Value::as_str).is_some_and(|id| {
                    declared.is_some_and(|ids| {
                        ids.iter().any(|candidate| candidate.as_str() == Some(id))
                    })
                })
        })
        .collect()
}

fn enqueue_due_for_input(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    input: &RoutineSchedulerInput,
    epoch: i64,
    now: DateTime<Utc>,
) -> crate::store::Result<usize> {
    let routine_id = input
        .bundle
        .routine
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| crate::store::StoreError::Invalid("Stored Routine id is invalid.".into()))?;
    let routine_version = input
        .bundle
        .current_version
        .get("version")
        .and_then(Value::as_i64)
        .filter(|value| *value >= 1)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Stored Routine version is invalid.".into())
        })?;
    let created_at = input
        .bundle
        .routine
        .get("createdAt")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Stored Routine creation time is invalid.".into())
        })?;
    let now_iso = iso(now);
    let mut enqueued = 0;

    for trigger in active_triggers(input) {
        let Ok(spec) = parse_time_spec(trigger) else {
            // Non-time and malformed triggers never gain execution authority.
            continue;
        };
        let trigger_id = trigger.get("id").and_then(Value::as_str).ok_or_else(|| {
            crate::store::StoreError::Invalid("Stored Routine trigger id is invalid.".into())
        })?;
        let cursor = routine::trigger_cursor(tx, &input.scope, &input.private, trigger_id)?;
        let latest_scheduled =
            routine::latest_scheduled_for(tx, &input.scope, &input.private, trigger_id)?;
        let previous_text = cursor
            .as_ref()
            .map(|value| value.last_evaluated_at.as_str())
            .or(latest_scheduled.as_deref())
            .unwrap_or(created_at);
        let previous = parse_instant(previous_text, "Routine trigger cursor")
            .map_err(crate::store::StoreError::Invalid)?;
        let due = due_occurrences(&spec, previous, now);
        for scheduled_for in due {
            let scheduled_for = iso(scheduled_for);
            let occurrence_id = stable_id(
                "routine_occurrence",
                &[
                    input.scope.workspace_id(),
                    input.private.owner_subject(),
                    trigger_id,
                    &scheduled_for,
                ],
            );
            let run_id = stable_id(
                "routine_run",
                &[
                    input.scope.workspace_id(),
                    input.private.owner_subject(),
                    routine_id,
                    &scheduled_for,
                ],
            );
            let occurrence = serde_json::json!({
                "id":occurrence_id,
                "routineId":routine_id,
                "triggerId":trigger_id,
                "routineVersion":routine_version,
                "status":"scheduled",
                "scheduledFor":scheduled_for,
                "observedAt":now_iso,
                "deduplicationKey":format!("routine:{routine_id}:{trigger_id}:{scheduled_for}"),
                "runId":run_id
            });
            routine::append_occurrence(tx, store, &input.scope, &input.private, &occurrence)?;
            let driver_evidence = serde_json::json!({
                "routineId":routine_id,
                "workspaceId":input.scope.workspace_id(),
                "routineVersion":routine_version,
                "triggerId":trigger_id,
                "projectId":input.scope.project_id(),
                "scheduledAt":scheduled_for,
                "runId":run_id,
                "action":input.bundle.current_version.get("action"),
                "routePolicy":input.bundle.current_version.get("routePolicy"),
                "placementPolicy":input.bundle.current_version.get("placementPolicy"),
                "budgets":input.bundle.current_version.get("budgets")
            });
            routine::enqueue_driver_occurrence(
                tx,
                store,
                &input.scope,
                &input.private,
                &occurrence_id,
                epoch,
                &scheduled_for,
                &driver_evidence,
            )?;
            enqueued += 1;
        }
        let next_run_at = next_occurrence(&spec, now).map(iso);
        routine::upsert_trigger_cursor(
            tx,
            store,
            &input.scope,
            &input.private,
            trigger_id,
            epoch,
            &now_iso,
            next_run_at.as_deref(),
            &serde_json::json!({
                "routineId":routine_id,
                "routineVersion":routine_version,
                "triggerId":trigger_id,
                "evaluatedThrough":now_iso.clone(),
                "nextRunAt":next_run_at
            }),
            &now_iso,
        )?;
    }
    Ok(enqueued)
}

fn emit_run_request(app: &AppHandle, lease: &DriverLeaseRow) {
    let evidence = &lease.driver_evidence;
    let _ = app.emit(
        "fable://routine/run-request",
        serde_json::json!({
            "workspaceId":evidence.get("workspaceId"),
            "projectId":evidence.get("projectId"),
            "routineId":evidence.get("routineId"),
            "routineVersion":evidence.get("routineVersion"),
            "triggerId":evidence.get("triggerId"),
            "occurrenceId":lease.occurrence_id,
            "runId":evidence.get("runId"),
            "scheduledAt":evidence.get("scheduledAt"),
            "action":evidence.get("action"),
            "routePolicy":evidence.get("routePolicy"),
            "placementPolicy":evidence.get("placementPolicy"),
            "budgets":evidence.get("budgets"),
            "writerEpoch":lease.writer_epoch,
            "leaseToken":lease.lease_token,
            "attemptNumber":lease.attempt_count + 1
        }),
    );
}

pub(super) fn run_tick(app: &AppHandle) -> Result<usize, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let workspaces = store
        .with_conn(routine::scheduler_workspaces)
        .map_err(|error| error.to_string())?;
    let now = Utc::now();
    let now_iso = iso(now);
    let lease_expires_at = iso(now + Duration::milliseconds(RUNNING_LEASE_MS));
    let holder = format!("routine-node-{}", std::process::id());
    let mut leased = Vec::new();

    for workspace_id in workspaces {
        let workspace_leases = store
            .transaction(|tx| {
                let authority = routine::scheduler_authority(tx, store, &workspace_id, &now_iso)?;
                if authority.writer != "routine" || authority.phase != "routine" {
                    return Ok(Vec::new());
                }
                routine::recover_expired_leases(
                    tx,
                    store,
                    &workspace_id,
                    authority.epoch,
                    &now_iso,
                )?;
                let inputs = routine::scheduler_inputs(tx, store, &workspace_id)?;
                for input in &inputs {
                    enqueue_due_for_input(tx, store, input, authority.epoch, now)?;
                }
                let mut workspace_leases = Vec::new();
                for input in &inputs {
                    if workspace_leases.len() >= 32 {
                        break;
                    }
                    loop {
                        if workspace_leases.len() >= 32 {
                            break;
                        }
                        let token = fresh_token("routine_lease")
                            .map_err(crate::store::StoreError::Invalid)?;
                        let Some(lease) = routine::lease_due(
                            tx,
                            store,
                            &input.scope,
                            &input.private,
                            authority.epoch,
                            &holder,
                            &token,
                            &now_iso,
                            &lease_expires_at,
                        )?
                        else {
                            break;
                        };
                        workspace_leases.push(lease);
                    }
                }
                Ok(workspace_leases)
            })
            .map_err(|error| error.to_string())?;
        leased.extend(workspace_leases);
    }
    for lease in &leased {
        emit_run_request(app, lease);
    }
    Ok(leased.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::repos::scope::{DataScope, PrivateDataScope};
    use crate::store::repos::workspace;
    use crate::store::vault::{MasterKey, Vault};
    use crate::store::Store;

    fn recurring(timezone: &str, rule: Value, policy: &str) -> Value {
        serde_json::json!({
            "spec":{
                "kind":"time-recurring",
                "timezone":timezone,
                "recurrence":{
                    "frequency":rule["frequency"],
                    "expression":format!("legacy-rrule-lite:v1:{rule}")
                },
                "missedRunPolicy":policy
            }
        })
    }

    #[test]
    fn recurrence_matches_legacy_daily_and_dst_semantics() {
        let trigger = recurring(
            "Europe/London",
            serde_json::json!({
                "frequency":"daily","interval":1,"byWeekday":[],
                "byMonthDay":null,"hour":9,"minute":0
            }),
            "run-once",
        );
        let spec = parse_time_spec(&trigger).unwrap();
        let winter = DateTime::parse_from_rfc3339("2026-03-28T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let summer = DateTime::parse_from_rfc3339("2026-10-24T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(
            iso(next_occurrence(&spec, winter).unwrap()),
            "2026-03-29T08:00:00.000Z"
        );
        assert_eq!(
            iso(next_occurrence(&spec, summer).unwrap()),
            "2026-10-25T09:00:00.000Z"
        );
    }

    #[test]
    fn missed_policy_is_bounded_and_deduplicates_repeated_wall_clock_minutes() {
        let trigger = recurring(
            "Europe/London",
            serde_json::json!({
                "frequency":"daily","interval":1,"byWeekday":[],
                "byMonthDay":null,"hour":1,"minute":30
            }),
            "run-all",
        );
        let spec = parse_time_spec(&trigger).unwrap();
        let previous = DateTime::parse_from_rfc3339("2026-10-24T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let now = DateTime::parse_from_rfc3339("2026-10-26T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let occurrences = due_occurrences(&spec, previous, now);
        assert_eq!(occurrences.len(), 3);
        assert_eq!(iso(occurrences[1]), "2026-10-25T00:30:00.000Z");
    }

    #[test]
    fn unsupported_or_invalid_rules_fail_closed() {
        let invalid = recurring(
            "Not/AZone",
            serde_json::json!({
                "frequency":"daily","interval":1,"byWeekday":[],
                "byMonthDay":null,"hour":9,"minute":0
            }),
            "run-once",
        );
        assert!(parse_time_spec(&invalid).is_err());
        assert!(parse_time_spec(&serde_json::json!({
            "spec":{"kind":"connection-event"}
        }))
        .is_err());
    }

    #[test]
    fn canonical_tick_is_idempotent_and_settles_through_the_fenced_driver() {
        let store =
            Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap();
        store
            .transaction(|tx| workspace::upsert(tx, "w1", "One", "2026-01-01T00:00:00Z"))
            .unwrap();
        let scope = DataScope::workspace("w1").unwrap();
        let private =
            PrivateDataScope::for_authenticated_user(scope.clone(), "user-1", Some("member-1"))
                .unwrap();
        let routine_value = serde_json::json!({
            "id":"routine-1","status":"active","title":"Daily",
            "currentVersion":1,"scope":{},"authorityPolicy":"no-expansion",
            "workspaceId":"w1","authority":"local","schemaVersion":1,"revision":1,
            "visibility":"member-private","ownerMemberId":"member-1",
            "createdByInternalUserId":"user-1","createdAt":"2026-01-01T00:00:00Z",
            "updatedAt":"2026-01-01T00:00:00Z"
        });
        let version = serde_json::json!({
            "routineId":"routine-1","version":1,"createdAt":"2026-01-01T00:00:00Z",
            "createdByInternalUserId":"user-1",
            "action":{"kind":"direct-request","title":"Daily","instruction":"Summarize."},
            "scope":{},"routePolicy":{"kind":"resolve-at-run"},
            "placementPolicy":{"kind":"resolve-at-run"},
            "budgets":{"capabilityGrantIds":[]},"triggerIds":["trigger-1"]
        });
        let trigger = serde_json::json!({
            "id":"trigger-1","routineId":"routine-1","status":"active",
            "spec":{"kind":"time-recurring","timezone":"UTC",
                "recurrence":{"frequency":"daily",
                    "expression":"legacy-rrule-lite:v1:{\"frequency\":\"daily\",\"interval\":1,\"byWeekday\":[],\"byMonthDay\":null,\"hour\":9,\"minute\":0}"},
                "missedRunPolicy":"run-once"},
            "deduplication":{"strategy":"per-trigger-event"},
            "workspaceId":"w1","authority":"local","schemaVersion":1,"revision":1,
            "visibility":"member-private","ownerMemberId":"member-1",
            "createdByInternalUserId":"user-1","createdAt":"2026-01-01T00:00:00Z",
            "updatedAt":"2026-01-01T00:00:00Z"
        });
        let active = store
            .transaction(|tx| {
                routine::create(
                    tx,
                    &store,
                    &scope,
                    &private,
                    "user-1",
                    &routine_value,
                    &version,
                    &[trigger],
                )?;
                let shadow = routine::transition_scheduler_authority(
                    tx,
                    &store,
                    "w1",
                    1,
                    "legacy",
                    "shadow",
                    "shadow-2",
                    None,
                    &serde_json::json!({"comparison":"pending"}),
                    "2026-01-01T00:00:01Z",
                )?;
                routine::transition_scheduler_authority(
                    tx,
                    &store,
                    "w1",
                    shadow.epoch,
                    "routine",
                    "routine",
                    "routine-3",
                    Some(&format!("sha256:{}", "a".repeat(64))),
                    &serde_json::json!({"comparison":"matched"}),
                    "2026-01-01T00:00:02Z",
                )
            })
            .unwrap();
        let now = DateTime::parse_from_rfc3339("2026-01-02T09:00:05Z")
            .unwrap()
            .with_timezone(&Utc);
        store
            .transaction(|tx| {
                let inputs = routine::scheduler_inputs(tx, &store, "w1")?;
                assert_eq!(inputs.len(), 1);
                assert_eq!(
                    enqueue_due_for_input(tx, &store, &inputs[0], active.epoch, now)?,
                    1
                );
                assert_eq!(
                    enqueue_due_for_input(tx, &store, &inputs[0], active.epoch, now)?,
                    0
                );
                Ok(())
            })
            .unwrap();
        let lease = store
            .transaction(|tx| {
                routine::lease_due(
                    tx,
                    &store,
                    &scope,
                    &private,
                    active.epoch,
                    "node-1",
                    "lease-1",
                    "2026-01-02T09:00:05Z",
                    "2026-01-02T09:15:05Z",
                )
            })
            .unwrap()
            .unwrap();
        assert_eq!(lease.driver_evidence["action"]["instruction"], "Summarize.");
        let run_id = lease.driver_evidence["runId"].as_str().unwrap().to_string();
        store
            .transaction(|tx| {
                routine::report_driver_attempt(
                    tx,
                    &store,
                    "w1",
                    "member:member-1",
                    &lease.occurrence_id,
                    active.epoch,
                    "lease-1",
                    &run_id,
                    1,
                    "running",
                    "2026-01-02T09:00:06Z",
                    Some("2026-01-02T09:15:06Z"),
                    Some("2026-01-02T09:00:36Z"),
                )?;
                routine::report_driver_attempt(
                    tx,
                    &store,
                    "w1",
                    "member:member-1",
                    &lease.occurrence_id,
                    active.epoch,
                    "lease-1",
                    &run_id,
                    1,
                    "completed",
                    "2026-01-02T09:00:07Z",
                    Some("2026-01-02T09:15:07Z"),
                    Some("2026-01-02T09:00:37Z"),
                )?;
                Ok(())
            })
            .unwrap();
        let history = store
            .with_conn(|tx| routine::occurrence_history(tx, &store, &scope, &private, "routine-1"))
            .unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0]["status"], "completed");
        assert_eq!(history[0]["attemptCount"], 1);
    }
}
