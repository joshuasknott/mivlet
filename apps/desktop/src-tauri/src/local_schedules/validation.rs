//! Local schedule persistence mapping and validation.

use super::*;
pub(super) fn schedule_from_row(row: ScheduleRow) -> crate::store::Result<LocalSchedule> {
    let payload = decode_schedule_payload(&row)?;
    Ok(LocalSchedule {
        execution_kind: payload.execution_kind,
        permission_mode: payload.permission_mode,
        id: row.id,
        project_id: payload.project_id,
        agent_id: row.agent_id,
        provider_id: payload.provider_id,
        model: payload.model,
        reasoning_effort: payload.reasoning_effort,
        prompt: payload.prompt,
        timezone: payload.timezone,
        trigger: payload.trigger,
        status: LocalScheduleStatus::parse(&row.status)?,
        revision: row.revision,
        prompt_revision: row.prompt_revision,
        next_run_at: row.next_run_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

pub(super) fn occurrence_from_row(
    row: OccurrenceRow,
    thread_id: Option<String>,
) -> crate::store::Result<LocalScheduleOccurrence> {
    let payload: OccurrencePayload = serde_json::from_value(row.payload).map_err(|_| {
        StoreError::Invalid("The encrypted local schedule occurrence is invalid.".into())
    })?;
    Ok(LocalScheduleOccurrence {
        id: row.id,
        schedule_id: row.schedule_id,
        schedule_revision: row.schedule_revision,
        prompt_revision: row.prompt_revision,
        state: row.state,
        execution_attempt_id: row.execution_attempt_id,
        thread_id,
        scheduled_for: row.scheduled_for,
        claimed_at: row.claimed_at,
        started_at: row.started_at,
        completed_at: row.completed_at,
        updated_at: row.updated_at,
        outcome: payload.outcome,
        detail: payload.detail,
    })
}

pub(super) fn decode_schedule_payload(row: &ScheduleRow) -> crate::store::Result<SchedulePayload> {
    let payload: SchedulePayload = serde_json::from_value(row.payload.clone())
        .map_err(|_| StoreError::Invalid("The encrypted local schedule is invalid.".into()))?;
    if payload.agent_id != row.agent_id
        || payload.prompt_revision != row.prompt_revision
        || payload.trigger.kind() != row.trigger_kind
        || payload.prompt_fingerprint != fingerprint(&payload.prompt)
    {
        return Err(StoreError::Invalid(
            "The encrypted local schedule does not match its index.".into(),
        ));
    }
    validate_execution_kind(&payload.execution_kind, &payload.permission_mode)?;
    validate_route_and_agent(&payload.agent_id, &payload.provider_id, &payload.model)?;
    validate_prompt(&payload.prompt)?;
    validate_trigger(&payload.trigger)?;
    parse_timezone(&payload.timezone)?;
    Ok(payload)
}

pub(super) fn encode<T: Serialize>(value: &T) -> crate::store::Result<serde_json::Value> {
    serde_json::to_value(value)
        .map_err(|_| StoreError::Invalid("The local schedule could not be encoded.".into()))
}

pub(super) fn validate_execution_kind(kind: &str, permission: &str) -> crate::store::Result<()> {
    if !["research", "agent"].contains(&kind)
        || !["read-only", "trusted-scope", "full-access"].contains(&permission)
        || (kind == "research" && permission != "read-only")
    {
        return Err(StoreError::Invalid(
            "Choose a valid schedule workflow and permission mode.".into(),
        ));
    }
    Ok(())
}

pub(super) fn validate_route_and_agent(
    agent_id: &str,
    provider_id: &str,
    model: &str,
) -> crate::store::Result<()> {
    validate_bounded_id_store(agent_id, "Agent", MAX_ID_CHARACTERS)?;
    validate_catalog_id(provider_id, "Provider", MAX_PROVIDER_ID_CHARACTERS)?;
    validate_catalog_id(model, "Model", MAX_MODEL_ID_CHARACTERS)
}

pub(super) fn validate_prompt(prompt: &str) -> crate::store::Result<()> {
    let count = prompt.chars().count();
    if prompt.trim().is_empty() || count > MAX_PROMPT_CHARACTERS {
        return Err(StoreError::Invalid(format!(
            "The schedule prompt must contain 1 to {MAX_PROMPT_CHARACTERS} characters."
        )));
    }
    Ok(())
}

pub(super) fn validate_reasoning_effort(effort: Option<&str>) -> crate::store::Result<()> {
    if effort.is_some_and(|value| {
        !matches!(
            value,
            "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
        )
    }) {
        return Err(StoreError::Invalid(
            "Choose a supported reasoning effort.".into(),
        ));
    }
    Ok(())
}

pub(super) fn validate_bounded_id(value: &str, label: &str, max: usize) -> Result<(), String> {
    validate_bounded_id_store(value, label, max).map_err(|error| error.to_string())
}

pub(super) fn validate_bounded_id_store(
    value: &str,
    label: &str,
    max: usize,
) -> crate::store::Result<()> {
    if value.is_empty()
        || value.chars().count() > max
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(StoreError::Invalid(format!(
            "{label} id must use 1 to {max} letters, numbers, hyphens, or underscores."
        )));
    }
    Ok(())
}

pub(super) fn validate_catalog_id(
    value: &str,
    label: &str,
    max: usize,
) -> crate::store::Result<()> {
    if value.is_empty()
        || value.chars().count() > max
        || !value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'/' | b':')
        })
    {
        return Err(StoreError::Invalid(format!(
            "{label} id is not a supported catalog identifier."
        )));
    }
    Ok(())
}

pub(super) fn validate_trigger(trigger: &LocalScheduleTrigger) -> crate::store::Result<()> {
    match trigger {
        LocalScheduleTrigger::Event { config } => {
            if config.route_id.len() != 64
                || !config.route_id.bytes().all(|c| c.is_ascii_hexdigit())
                || config.key_version == 0
            {
                return Err(StoreError::Invalid(
                    "Event triggers require a native signing-key binding.".into(),
                ));
            }
        }
        LocalScheduleTrigger::Once { local_date_time } => {
            parse_local_datetime(local_date_time)?;
        }
        LocalScheduleTrigger::Daily { local_time } => {
            parse_local_time(local_time)?;
        }
        LocalScheduleTrigger::Weekly {
            weekday,
            local_time,
        } => {
            parse_weekday(weekday)?;
            parse_local_time(local_time)?;
        }
    }
    Ok(())
}

pub(super) fn parse_timezone(value: &str) -> crate::store::Result<Tz> {
    if value.is_empty() || value.chars().count() > MAX_TIMEZONE_CHARACTERS {
        return Err(StoreError::Invalid(
            "The schedule timezone is invalid.".into(),
        ));
    }
    value
        .parse::<Tz>()
        .map_err(|_| StoreError::Invalid("Use a valid IANA timezone for this schedule.".into()))
}

pub(super) fn parse_local_datetime(value: &str) -> crate::store::Result<NaiveDateTime> {
    NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M").map_err(|_| {
        StoreError::Invalid("Use YYYY-MM-DDTHH:MM for a one-time local schedule.".into())
    })
}

pub(super) fn parse_local_time(value: &str) -> crate::store::Result<NaiveTime> {
    NaiveTime::parse_from_str(value, "%H:%M")
        .map_err(|_| StoreError::Invalid("Use HH:MM for a recurring local schedule.".into()))
}

pub(super) fn parse_weekday(value: &str) -> crate::store::Result<Weekday> {
    match value.to_ascii_lowercase().as_str() {
        "monday" => Ok(Weekday::Mon),
        "tuesday" => Ok(Weekday::Tue),
        "wednesday" => Ok(Weekday::Wed),
        "thursday" => Ok(Weekday::Thu),
        "friday" => Ok(Weekday::Fri),
        "saturday" => Ok(Weekday::Sat),
        "sunday" => Ok(Weekday::Sun),
        _ => Err(StoreError::Invalid(
            "The weekly schedule weekday is invalid.".into(),
        )),
    }
}
