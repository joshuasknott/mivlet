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
use std::collections::BTreeSet;
use tauri::{AppHandle, Emitter};

use crate::models::RUNNING_LEASE_MS;
use crate::store::repos::routine::{self, DriverLeaseRow, RoutineSchedulerInput};

const MAX_SCAN_MINUTES: i64 = 370 * 24 * 60;
const MAX_MISSED_OCCURRENCES: usize = 100;
#[allow(
    dead_code,
    reason = "reserved for the native-only Connection event adapter boundary; no renderer command may forge provider events"
)]
const MAX_CONNECTION_EVENT_BYTES: usize = 64 * 1024;
#[allow(
    dead_code,
    reason = "reserved for the native-only Connection event adapter boundary; no renderer command may forge provider events"
)]
const MAX_CONNECTION_EVENT_NODES: usize = 512;
#[allow(
    dead_code,
    reason = "reserved for the native-only Connection event adapter boundary; no renderer command may forge provider events"
)]
const MAX_CONNECTION_EVENT_DEPTH: usize = 8;

#[allow(
    dead_code,
    reason = "constructed only by native Connection adapters once they have authenticated exact source evidence"
)]
pub(crate) struct ConnectionEventObservation<'a> {
    pub connection_id: &'a str,
    pub connection_revision: i64,
    pub event_type: &'a str,
    pub source_reference: &'a str,
    pub payload: &'a Value,
    pub received_at: &'a str,
}

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
struct CronField {
    values: BTreeSet<u32>,
    wildcard: bool,
}

#[derive(Clone, Debug)]
struct CronRecurrence {
    minute: CronField,
    hour: CronField,
    day_of_month: CronField,
    month: CronField,
    day_of_week: CronField,
}

#[derive(Clone, Debug)]
enum RecurrenceRule {
    LegacyLite(LiteRecurrence),
    Cron(CronRecurrence),
}

#[derive(Clone, Debug)]
enum TimeSpec {
    Once(DateTime<Utc>),
    Recurring {
        timezone: Tz,
        rule: RecurrenceRule,
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
            let frequency = spec
                .pointer("/recurrence/frequency")
                .and_then(Value::as_str)
                .ok_or_else(|| "Recurring Routine frequency is missing.".to_string())?;
            let expression = spec
                .pointer("/recurrence/expression")
                .and_then(Value::as_str)
                .ok_or_else(|| "Recurring Routine expression is unsupported.".to_string())?;
            let rule = if frequency == "cron" {
                RecurrenceRule::Cron(parse_cron(expression)?)
            } else {
                let encoded = expression
                    .strip_prefix("legacy-rrule-lite:v1:")
                    .ok_or_else(|| "Recurring Routine expression is unsupported.".to_string())?;
                let rule: LiteRecurrence = serde_json::from_str(encoded)
                    .map_err(|_| "Recurring Routine expression is invalid.".to_string())?;
                validate_rule(&rule)?;
                if rule.frequency != frequency {
                    return Err(
                        "Recurring Routine frequency does not match its expression.".to_string()
                    );
                }
                RecurrenceRule::LegacyLite(rule)
            };
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

fn cron_alias(value: &str, aliases: &[(&str, u32)]) -> Option<u32> {
    aliases
        .iter()
        .find_map(|(name, number)| value.eq_ignore_ascii_case(name).then_some(*number))
}

fn cron_value(value: &str, min: u32, max: u32, aliases: &[(&str, u32)]) -> Result<u32, String> {
    let parsed = cron_alias(value, aliases)
        .or_else(|| value.parse::<u32>().ok())
        .ok_or_else(|| "Recurring Routine cron value is invalid.".to_string())?;
    if !(min..=max).contains(&parsed) {
        return Err("Recurring Routine cron value is out of range.".to_string());
    }
    Ok(parsed)
}

fn parse_cron_field(
    expression: &str,
    min: u32,
    max: u32,
    aliases: &[(&str, u32)],
    sunday_alias: bool,
) -> Result<CronField, String> {
    if expression.is_empty() || expression.contains('?') {
        return Err("Recurring Routine cron field is unsupported.".to_string());
    }
    let wildcard = expression.starts_with('*');
    let mut values = BTreeSet::new();
    for component in expression.split(',') {
        if component.is_empty() {
            return Err("Recurring Routine cron field is invalid.".to_string());
        }
        let mut step_parts = component.split('/');
        let range = step_parts.next().unwrap_or_default();
        let step_text = step_parts.next();
        let step = step_text
            .map(|value| value.parse::<u32>())
            .transpose()
            .map_err(|_| "Recurring Routine cron step is invalid.".to_string())?
            .unwrap_or(1);
        if step_parts.next().is_some()
            || step == 0
            || (step_text.is_some() && range != "*" && !range.contains('-'))
        {
            return Err("Recurring Routine cron step is invalid.".to_string());
        }
        let (start, end) = if range == "*" {
            (min, max)
        } else if let Some((start, end)) = range.split_once('-') {
            (
                cron_value(start, min, max, aliases)?,
                cron_value(end, min, max, aliases)?,
            )
        } else {
            let value = cron_value(range, min, max, aliases)?;
            (value, value)
        };
        if start > end {
            return Err("Recurring Routine cron range is invalid.".to_string());
        }
        for value in (start..=end).step_by(step as usize) {
            values.insert(if sunday_alias && value == 7 { 0 } else { value });
        }
    }
    if values.is_empty() {
        return Err("Recurring Routine cron field is empty.".to_string());
    }
    Ok(CronField { values, wildcard })
}

fn parse_cron(expression: &str) -> Result<CronRecurrence, String> {
    const MONTHS: &[(&str, u32)] = &[
        ("JAN", 1),
        ("FEB", 2),
        ("MAR", 3),
        ("APR", 4),
        ("MAY", 5),
        ("JUN", 6),
        ("JUL", 7),
        ("AUG", 8),
        ("SEP", 9),
        ("OCT", 10),
        ("NOV", 11),
        ("DEC", 12),
    ];
    const WEEKDAYS: &[(&str, u32)] = &[
        ("SUN", 0),
        ("MON", 1),
        ("TUE", 2),
        ("WED", 3),
        ("THU", 4),
        ("FRI", 5),
        ("SAT", 6),
    ];
    let fields = expression.split_whitespace().collect::<Vec<_>>();
    if fields.len() != 5 {
        return Err(
            "Recurring Routine cron expressions require five fields (minute through weekday)."
                .to_string(),
        );
    }
    Ok(CronRecurrence {
        minute: parse_cron_field(fields[0], 0, 59, &[], false)?,
        hour: parse_cron_field(fields[1], 0, 23, &[], false)?,
        day_of_month: parse_cron_field(fields[2], 1, 31, &[], false)?,
        month: parse_cron_field(fields[3], 1, 12, MONTHS, false)?,
        day_of_week: parse_cron_field(fields[4], 0, 7, WEEKDAYS, true)?,
    })
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

fn matches_cron(candidate: DateTime<Utc>, timezone: Tz, rule: &CronRecurrence) -> bool {
    let local = candidate.with_timezone(&timezone);
    if !rule.minute.values.contains(&local.minute())
        || !rule.hour.values.contains(&local.hour())
        || !rule.month.values.contains(&local.month())
    {
        return false;
    }
    let day_of_month = rule.day_of_month.values.contains(&local.day());
    let day_of_week = rule
        .day_of_week
        .values
        .contains(&local.weekday().num_days_from_sunday());
    match (rule.day_of_month.wildcard, rule.day_of_week.wildcard) {
        (true, true) => true,
        (true, false) => day_of_week,
        (false, true) => day_of_month,
        (false, false) => day_of_month || day_of_week,
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
                let matches = match rule {
                    RecurrenceRule::LegacyLite(rule) => matches_rule(candidate, *timezone, rule),
                    RecurrenceRule::Cron(rule) => matches_cron(candidate, *timezone, rule),
                };
                if matches {
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

#[allow(
    dead_code,
    reason = "used by the native-only Connection event intake reserved for authenticated adapters"
)]
fn bounded_connection_event_value(value: &Value, depth: usize, nodes: &mut usize) -> bool {
    *nodes += 1;
    if *nodes > MAX_CONNECTION_EVENT_NODES || depth > MAX_CONNECTION_EVENT_DEPTH {
        return false;
    }
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => true,
        Value::String(value) => value.len() <= 4_096 && !value.chars().any(char::is_control),
        Value::Array(values) => {
            values.len() <= 64
                && values
                    .iter()
                    .all(|value| bounded_connection_event_value(value, depth + 1, nodes))
        }
        Value::Object(values) => {
            values.len() <= 64
                && values.iter().all(|(key, value)| {
                    !key.is_empty()
                        && key.len() <= 128
                        && !key.chars().any(char::is_control)
                        && bounded_connection_event_value(value, depth + 1, nodes)
                })
        }
    }
}

#[allow(
    dead_code,
    reason = "used by the native-only Connection event intake reserved for authenticated adapters"
)]
fn event_filter_matches(filter: &Value, payload: &Value) -> bool {
    match (filter, payload) {
        (Value::Object(expected), Value::Object(actual)) => expected.iter().all(|(key, value)| {
            actual
                .get(key)
                .is_some_and(|candidate| event_filter_matches(value, candidate))
        }),
        _ => filter == payload,
    }
}

#[allow(
    dead_code,
    reason = "used by the native-only Connection event intake reserved for authenticated adapters"
)]
fn connection_event_trigger_matches(
    trigger: &Value,
    connection_id: &str,
    event_type: &str,
    payload: &Value,
) -> bool {
    let Some(spec) = trigger.get("spec") else {
        return false;
    };
    if spec.get("kind").and_then(Value::as_str) != Some("connection-event")
        || spec.get("connectionId").and_then(Value::as_str) != Some(connection_id)
        || spec.get("eventType").and_then(Value::as_str) != Some(event_type)
    {
        return false;
    }
    let Some(filter) = spec.get("eventFilter") else {
        return true;
    };
    let mut nodes = 0;
    bounded_connection_event_value(filter, 0, &mut nodes) && event_filter_matches(filter, payload)
}

#[allow(
    dead_code,
    reason = "native Connection adapters will call this boundary; exposing it to the renderer would allow forged provider events"
)]
pub(crate) fn observe_connection_event(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &crate::authorized_scope::AuthorizedCommandScope,
    event: ConnectionEventObservation<'_>,
) -> crate::store::Result<usize> {
    if scope.data.project_id().is_some() {
        return Err(crate::store::StoreError::Invalid(
            "Connection events require workspace Connection authority.".into(),
        ));
    }
    let connection =
        crate::store::repos::connection_record::get(tx, store, scope, event.connection_id)?
            .ok_or_else(|| {
                crate::store::StoreError::Invalid("Connection event source is unavailable.".into())
            })?;
    if connection.revision != event.connection_revision
        || connection.lifecycle != "authorized"
        || !matches!(
            connection.authorization_state.as_str(),
            "authorized" | "not-required"
        )
        || !matches!(
            connection.credential_state.as_str(),
            "available" | "not-required"
        )
    {
        return Err(crate::store::StoreError::Invalid(
            "Connection event source revision or authority is stale.".into(),
        ));
    }
    if event.event_type.is_empty()
        || event.event_type.len() > 160
        || event.event_type.chars().any(|character| {
            !(character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ':' | '-'))
        })
        || event.source_reference.is_empty()
        || event.source_reference.len() > 2_048
        || event.source_reference.chars().any(char::is_control)
    {
        return Err(crate::store::StoreError::Invalid(
            "Connection event identity is invalid.".into(),
        ));
    }
    parse_instant(event.received_at, "Connection event receipt")
        .map_err(crate::store::StoreError::Invalid)?;
    let encoded = serde_json::to_vec(event.payload).map_err(|_| {
        crate::store::StoreError::Invalid("Connection event payload is invalid.".into())
    })?;
    let mut nodes = 0;
    if encoded.len() > MAX_CONNECTION_EVENT_BYTES
        || !bounded_connection_event_value(event.payload, 0, &mut nodes)
    {
        return Err(crate::store::StoreError::Invalid(
            "Connection event payload exceeds Fable's safe local boundary.".into(),
        ));
    }
    let authority =
        routine::scheduler_authority(tx, store, scope.data.workspace_id(), event.received_at)?;
    if authority.writer != "routine" || authority.phase != "routine" {
        return Err(crate::store::StoreError::Invalid(
            "Connection events require the fenced Routine writer.".into(),
        ));
    }
    let source_reference_hash = stable_id(
        "connection_event_source",
        &[
            scope.data.workspace_id(),
            event.connection_id,
            &event.connection_revision.to_string(),
            event.event_type,
            event.source_reference,
        ],
    );
    let inputs = routine::scheduler_inputs(tx, store, scope.data.workspace_id())?;
    let mut enqueued = 0;
    for input in inputs {
        if input.private.owner_subject() != scope.private.owner_subject() {
            continue;
        }
        let routine_id = input
            .bundle
            .routine
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                crate::store::StoreError::Invalid("Stored Routine id is invalid.".into())
            })?;
        let routine_version = input
            .bundle
            .current_version
            .get("version")
            .and_then(Value::as_i64)
            .filter(|value| *value >= 1)
            .ok_or_else(|| {
                crate::store::StoreError::Invalid("Stored Routine version is invalid.".into())
            })?;
        for trigger in active_triggers(&input) {
            if !connection_event_trigger_matches(
                trigger,
                event.connection_id,
                event.event_type,
                event.payload,
            ) {
                continue;
            }
            let trigger_id = trigger.get("id").and_then(Value::as_str).ok_or_else(|| {
                crate::store::StoreError::Invalid("Stored Routine trigger id is invalid.".into())
            })?;
            let occurrence_id = stable_id(
                "routine_occurrence",
                &[
                    input.scope.workspace_id(),
                    input.private.owner_subject(),
                    trigger_id,
                    &source_reference_hash,
                ],
            );
            let run_id = stable_id(
                "routine_run",
                &[
                    input.scope.workspace_id(),
                    input.private.owner_subject(),
                    routine_id,
                    trigger_id,
                    &source_reference_hash,
                ],
            );
            let occurrence = serde_json::json!({
                "id":occurrence_id,
                "routineId":routine_id,
                "triggerId":trigger_id,
                "routineVersion":routine_version,
                "status":"scheduled",
                "scheduledFor":event.received_at,
                "observedAt":event.received_at,
                "deduplicationKey":format!(
                    "routine-connection-event:v1:{trigger_id}:{source_reference_hash}"
                ),
                "runId":run_id
            });
            routine::append_occurrence(tx, store, &input.scope, &input.private, &occurrence)?;
            let driver_evidence = serde_json::json!({
                "routineId":routine_id,
                "workspaceId":input.scope.workspace_id(),
                "routineVersion":routine_version,
                "triggerId":trigger_id,
                "projectId":input.scope.project_id(),
                "scheduledAt":event.received_at,
                "runId":run_id,
                "triggerEvidence":{
                    "kind":"connection-event",
                    "connectionId":event.connection_id,
                    "connectionRevision":event.connection_revision,
                    "eventType":event.event_type,
                    "sourceReferenceHash":source_reference_hash,
                    "untrustedPayloadStored":false
                },
                "action":input.bundle.current_version.get("action"),
                "routePolicy":input.bundle.current_version.get("routePolicy"),
                "placementPolicy":input.bundle.current_version.get("placementPolicy"),
                "budgets":input.bundle.current_version.get("budgets")
            });
            if routine::enqueue_driver_occurrence(
                tx,
                store,
                &input.scope,
                &input.private,
                &occurrence_id,
                authority.epoch,
                event.received_at,
                &driver_evidence,
            )? {
                enqueued += 1;
            }
        }
    }
    Ok(enqueued)
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
        if crate::execution_control::workspace_is_paused(&workspace_id)? {
            continue;
        }
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
    use crate::authorized_scope::{resolve, ScopeAccess};
    use crate::store::repos::scope::{DataScope, PrivateDataScope};
    use crate::store::repos::workspace;
    use crate::store::repos::workspace_directory::{
        select_active_workspace, set_current_internal_user, upsert_authoritative_summary,
        WorkspaceDirectoryUpsert,
    };
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

    fn cron(timezone: &str, expression: &str, policy: &str) -> Value {
        serde_json::json!({
            "spec":{
                "kind":"time-recurring",
                "timezone":timezone,
                "recurrence":{
                    "frequency":"cron",
                    "expression":expression
                },
                "missedRunPolicy":policy
            }
        })
    }

    fn directory_summary() -> WorkspaceDirectoryUpsert {
        WorkspaceDirectoryUpsert {
            internal_user_id: "user-1".into(),
            fable_workspace_id: "fable-workspace-1".into(),
            name: "One".into(),
            workspace_status: "active".into(),
            workspace_revision: 1,
            policy_revision: 1,
            member_id: "member-1".into(),
            role: "owner".into(),
            membership_status: "active".into(),
            membership_revision: 1,
            updated_at: "2026-01-01T00:00:00Z".into(),
        }
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
    fn cron_supports_bounded_fields_aliases_steps_and_standard_day_matching() {
        let weekdays = parse_time_spec(&cron(
            "Europe/London",
            "*/15 9-10 * JAN,MAR MON-FRI",
            "run-all",
        ))
        .unwrap();
        let friday = DateTime::parse_from_rfc3339("2026-01-02T08:59:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(
            iso(next_occurrence(&weekdays, friday).unwrap()),
            "2026-01-02T09:00:00.000Z"
        );
        assert_eq!(
            iso(next_occurrence(
                &weekdays,
                DateTime::parse_from_rfc3339("2026-01-02T09:00:00Z")
                    .unwrap()
                    .with_timezone(&Utc)
            )
            .unwrap()),
            "2026-01-02T09:15:00.000Z"
        );

        // Standard cron treats restricted day-of-month and weekday fields as
        // an OR. Sunday may be written as either zero or seven.
        let either_day = parse_time_spec(&cron("UTC", "0 12 15 * 7", "run-all")).unwrap();
        let saturday = DateTime::parse_from_rfc3339("2026-08-01T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(
            iso(next_occurrence(&either_day, saturday).unwrap()),
            "2026-08-02T12:00:00.000Z"
        );
    }

    #[test]
    fn cron_preserves_timezone_dst_and_missed_run_policy() {
        let trigger = parse_time_spec(&cron("Europe/London", "30 1 * * *", "run-once")).unwrap();
        let before_fall_back = DateTime::parse_from_rfc3339("2026-10-24T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let after_fall_back = DateTime::parse_from_rfc3339("2026-10-26T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let occurrences = due_occurrences(&trigger, before_fall_back, after_fall_back);
        assert_eq!(occurrences.len(), 1);
        assert_eq!(iso(occurrences[0]), "2026-10-26T01:30:00.000Z");

        let before_spring = DateTime::parse_from_rfc3339("2026-03-28T02:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(
            iso(next_occurrence(&trigger, before_spring).unwrap()),
            "2026-03-30T00:30:00.000Z"
        );
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
        for expression in [
            "* * * *",
            "60 * * * *",
            "*/0 * * * *",
            "5/2 * * * *",
            "10-2 * * * *",
            "* * ? * *",
            "* * * * MON#2",
        ] {
            assert!(
                parse_time_spec(&cron("UTC", expression, "run-once")).is_err(),
                "{expression}"
            );
        }
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

    #[test]
    fn connection_events_require_exact_live_authority_and_never_persist_payload_content() {
        let store =
            Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap();
        let (scope, connection) = store
            .transaction(|tx| {
                let workspace = upsert_authoritative_summary(tx, &directory_summary())?;
                set_current_internal_user(tx, "user-1", "2026-01-01T00:00:00Z")?;
                select_active_workspace(
                    tx,
                    "user-1",
                    "fable-workspace-1",
                    "2026-01-01T00:00:00Z",
                )?;
                let scope = resolve(
                    tx,
                    Some(&workspace.local_workspace_id),
                    None,
                    ScopeAccess::Write,
                )?;
                let connection = crate::store::repos::connection_record::upsert_mcp_stdio(
                    tx,
                    &store,
                    &scope,
                    "fixture-server",
                    "Fixture server",
                    "2026-01-01T00:00:00Z",
                )?;
                let routine_value = serde_json::json!({
                    "id":"routine-event","status":"active","title":"React to issue",
                    "currentVersion":1,"scope":{},"authorityPolicy":"no-expansion",
                    "workspaceId":scope.data.workspace_id(),"authority":"local",
                    "schemaVersion":1,"revision":1,"visibility":"member-private",
                    "ownerMemberId":"member-1","createdByInternalUserId":"user-1",
                    "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
                });
                let version = serde_json::json!({
                    "routineId":"routine-event","version":1,
                    "createdAt":"2026-01-01T00:00:00Z",
                    "createdByInternalUserId":"user-1",
                    "action":{"kind":"direct-request","title":"React","instruction":"Review the referenced issue."},
                    "scope":{},"routePolicy":{"kind":"resolve-at-run"},
                    "placementPolicy":{"kind":"resolve-at-run"},
                    "budgets":{"capabilityGrantIds":[]},"triggerIds":["trigger-event"]
                });
                let trigger = serde_json::json!({
                    "id":"trigger-event","routineId":"routine-event","status":"active",
                    "spec":{
                        "kind":"connection-event","connectionId":connection.id,
                        "eventType":"issue.changed",
                        "eventFilter":{"state":"ready","details":{"kind":"issue"}}
                    },
                    "deduplication":{"strategy":"source-reference"},
                    "workspaceId":scope.data.workspace_id(),"authority":"local",
                    "schemaVersion":1,"revision":1,"visibility":"member-private",
                    "ownerMemberId":"member-1","createdByInternalUserId":"user-1",
                    "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
                });
                routine::create(
                    tx,
                    &store,
                    &scope.data,
                    &scope.private,
                    "user-1",
                    &routine_value,
                    &version,
                    &[trigger],
                )?;
                let shadow = routine::transition_scheduler_authority(
                    tx,
                    &store,
                    scope.data.workspace_id(),
                    1,
                    "legacy",
                    "shadow",
                    "shadow-event",
                    None,
                    &serde_json::json!({"comparison":"pending"}),
                    "2026-01-01T00:00:01Z",
                )?;
                routine::transition_scheduler_authority(
                    tx,
                    &store,
                    scope.data.workspace_id(),
                    shadow.epoch,
                    "routine",
                    "routine",
                    "routine-event",
                    Some(&format!("sha256:{}", "b".repeat(64))),
                    &serde_json::json!({"comparison":"matched"}),
                    "2026-01-01T00:00:02Z",
                )?;
                Ok((scope, connection))
            })
            .unwrap();
        let untrusted = serde_json::json!({
            "state":"ready",
            "details":{"kind":"issue","title":"DO-NOT-PERSIST"},
            "providerToken":"fixture-secret"
        });
        store
            .transaction(|tx| {
                let event = || ConnectionEventObservation {
                    connection_id: &connection.id,
                    connection_revision: connection.revision,
                    event_type: "issue.changed",
                    source_reference: "provider-issue-42",
                    payload: &untrusted,
                    received_at: "2026-01-02T09:00:00Z",
                };
                assert_eq!(observe_connection_event(tx, &store, &scope, event())?, 1);
                assert_eq!(observe_connection_event(tx, &store, &scope, event())?, 0);
                let nonmatching = serde_json::json!({
                    "state":"draft","details":{"kind":"issue"}
                });
                assert_eq!(
                    observe_connection_event(
                        tx,
                        &store,
                        &scope,
                        ConnectionEventObservation {
                            source_reference: "provider-issue-43",
                            payload: &nonmatching,
                            ..event()
                        }
                    )?,
                    0
                );
                let stale = observe_connection_event(
                    tx,
                    &store,
                    &scope,
                    ConnectionEventObservation {
                        connection_revision: connection.revision + 1,
                        ..event()
                    },
                )
                .unwrap_err();
                assert!(stale.to_string().contains("authority is stale"));
                let oversized = Value::String("x".repeat(MAX_CONNECTION_EVENT_BYTES + 1));
                let oversized_error = observe_connection_event(
                    tx,
                    &store,
                    &scope,
                    ConnectionEventObservation {
                        source_reference: "provider-issue-oversized",
                        payload: &oversized,
                        ..event()
                    },
                )
                .unwrap_err();
                assert!(oversized_error.to_string().contains("safe local boundary"));
                let history = routine::occurrence_history(
                    tx,
                    &store,
                    &scope.data,
                    &scope.private,
                    "routine-event",
                )?;
                assert_eq!(history.len(), 1);
                let history_json = serde_json::to_string(&history).unwrap();
                assert!(!history_json.contains("DO-NOT-PERSIST"));
                assert!(!history_json.contains("fixture-secret"));
                assert!(!history_json.contains("provider-issue-42"));
                let authority = routine::scheduler_authority(
                    tx,
                    &store,
                    scope.data.workspace_id(),
                    "2026-01-02T09:00:01Z",
                )?;
                let lease = routine::lease_due(
                    tx,
                    &store,
                    &scope.data,
                    &scope.private,
                    authority.epoch,
                    "node-event",
                    "lease-event",
                    "2026-01-02T09:00:01Z",
                    "2026-01-02T09:15:01Z",
                )?
                .unwrap();
                let evidence = serde_json::to_string(&lease.driver_evidence).unwrap();
                assert!(evidence.contains("issue.changed"));
                assert!(evidence.contains("sourceReferenceHash"));
                assert!(!evidence.contains("DO-NOT-PERSIST"));
                assert!(!evidence.contains("fixture-secret"));
                assert!(!evidence.contains("provider-issue-42"));
                Ok(())
            })
            .unwrap();
    }
}
