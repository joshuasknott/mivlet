//! Local schedule civil-time evaluation and identity helpers.

use super::*;
pub(super) fn initial_slot(
    trigger: &LocalScheduleTrigger,
    timezone: Tz,
    now: DateTime<Utc>,
) -> crate::store::Result<Option<CivilSlot>> {
    match trigger {
        LocalScheduleTrigger::Event { .. } => Ok(None),
        LocalScheduleTrigger::Once { local_date_time } => {
            let intended = parse_local_datetime(local_date_time)?;
            let slot = resolve_civil_slot(timezone, intended)?;
            if slot.instant <= now {
                return Err(StoreError::Invalid(
                    "Choose a future time for a new one-time schedule.".into(),
                ));
            }
            Ok(Some(slot))
        }
        _ => next_slot_after(trigger, timezone, now),
    }
}

pub(super) fn next_slot_after(
    trigger: &LocalScheduleTrigger,
    timezone: Tz,
    after: DateTime<Utc>,
) -> crate::store::Result<Option<CivilSlot>> {
    match trigger {
        LocalScheduleTrigger::Event { .. } => Ok(None),
        LocalScheduleTrigger::Once { local_date_time } => {
            let slot = resolve_civil_slot(timezone, parse_local_datetime(local_date_time)?)?;
            Ok((slot.instant > after).then_some(slot))
        }
        LocalScheduleTrigger::Daily { local_time } => {
            let time = parse_local_time(local_time)?;
            let local_date = after.with_timezone(&timezone).date_naive();
            for offset in 0..=2 {
                let date = local_date
                    .checked_add_days(Days::new(offset))
                    .ok_or_else(|| {
                        StoreError::Invalid("The daily schedule date overflowed.".into())
                    })?;
                let slot = resolve_civil_slot(timezone, date.and_time(time))?;
                if slot.instant > after {
                    return Ok(Some(slot));
                }
            }
            Err(StoreError::Invalid(
                "The next daily schedule time is invalid.".into(),
            ))
        }
        LocalScheduleTrigger::Weekly {
            weekday,
            local_time,
        } => {
            let weekday = parse_weekday(weekday)?;
            let time = parse_local_time(local_time)?;
            let local_date = after.with_timezone(&timezone).date_naive();
            let delta = (weekday.num_days_from_monday() as i64
                - local_date.weekday().num_days_from_monday() as i64)
                .rem_euclid(7) as u64;
            let mut date = local_date
                .checked_add_days(Days::new(delta))
                .ok_or_else(|| {
                    StoreError::Invalid("The weekly schedule date overflowed.".into())
                })?;
            let mut slot = resolve_civil_slot(timezone, date.and_time(time))?;
            if slot.instant <= after {
                date = date.checked_add_days(Days::new(7)).ok_or_else(|| {
                    StoreError::Invalid("The weekly schedule date overflowed.".into())
                })?;
                slot = resolve_civil_slot(timezone, date.and_time(time))?;
            }
            Ok(Some(slot))
        }
    }
}

pub(super) fn latest_due_slot(
    trigger: &LocalScheduleTrigger,
    timezone: Tz,
    now: DateTime<Utc>,
) -> crate::store::Result<Option<CivilSlot>> {
    match trigger {
        LocalScheduleTrigger::Event { .. } => Ok(None),
        LocalScheduleTrigger::Once { local_date_time } => {
            let slot = resolve_civil_slot(timezone, parse_local_datetime(local_date_time)?)?;
            Ok((slot.instant <= now).then_some(slot))
        }
        LocalScheduleTrigger::Daily { local_time } => {
            let time = parse_local_time(local_time)?;
            let mut date = now.with_timezone(&timezone).date_naive();
            let mut slot = resolve_civil_slot(timezone, date.and_time(time))?;
            if slot.instant > now {
                date = date.checked_sub_days(Days::new(1)).ok_or_else(|| {
                    StoreError::Invalid("The daily schedule date underflowed.".into())
                })?;
                slot = resolve_civil_slot(timezone, date.and_time(time))?;
            }
            Ok(Some(slot))
        }
        LocalScheduleTrigger::Weekly {
            weekday,
            local_time,
        } => {
            let weekday = parse_weekday(weekday)?;
            let time = parse_local_time(local_time)?;
            let local_date = now.with_timezone(&timezone).date_naive();
            let backwards = (local_date.weekday().num_days_from_monday() as i64
                - weekday.num_days_from_monday() as i64)
                .rem_euclid(7) as u64;
            let mut date = local_date
                .checked_sub_days(Days::new(backwards))
                .ok_or_else(|| {
                    StoreError::Invalid("The weekly schedule date underflowed.".into())
                })?;
            let mut slot = resolve_civil_slot(timezone, date.and_time(time))?;
            if slot.instant > now {
                date = date.checked_sub_days(Days::new(7)).ok_or_else(|| {
                    StoreError::Invalid("The weekly schedule date underflowed.".into())
                })?;
                slot = resolve_civil_slot(timezone, date.and_time(time))?;
            }
            Ok(Some(slot))
        }
    }
}

/// Resolve a wall-clock slot deterministically. During a fall-back overlap the
/// earlier instant wins; during a spring-forward gap the first valid minute
/// after the gap runs while the dedup key retains the intended wall-clock slot.
pub(super) fn resolve_civil_slot(
    timezone: Tz,
    intended: NaiveDateTime,
) -> crate::store::Result<CivilSlot> {
    let key = intended.format("%Y-%m-%dT%H:%M").to_string();
    let instant = match timezone.from_local_datetime(&intended) {
        LocalResult::Single(value) => value.with_timezone(&Utc),
        LocalResult::Ambiguous(first, second) => {
            first.with_timezone(&Utc).min(second.with_timezone(&Utc))
        }
        LocalResult::None => {
            let mut resolved = None;
            for minutes in 1..=180 {
                let candidate = intended
                    .checked_add_signed(Duration::minutes(minutes))
                    .ok_or_else(|| StoreError::Invalid("The schedule time overflowed.".into()))?;
                match timezone.from_local_datetime(&candidate) {
                    LocalResult::Single(value) => {
                        resolved = Some(value.with_timezone(&Utc));
                        break;
                    }
                    LocalResult::Ambiguous(first, second) => {
                        resolved = Some(first.with_timezone(&Utc).min(second.with_timezone(&Utc)));
                        break;
                    }
                    LocalResult::None => {}
                }
            }
            resolved.ok_or_else(|| {
                StoreError::Invalid(
                    "The schedule time could not be resolved in its timezone.".into(),
                )
            })?
        }
    };
    Ok(CivilSlot { key, instant })
}

pub(super) fn parse_utc(value: &str) -> crate::store::Result<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|_| StoreError::Invalid("A local schedule UTC timestamp is invalid.".into()))
}

pub(super) fn timestamp(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub(super) fn checked_revision(value: i64) -> crate::store::Result<i64> {
    value
        .checked_add(1)
        .ok_or_else(|| StoreError::Invalid("The local schedule revision overflowed.".into()))
}

pub(super) fn fingerprint(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

pub(super) fn random_token(prefix: &str) -> crate::store::Result<String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|_| StoreError::Invalid("Mivlet could not create schedule identity.".into()))?;
    Ok(format!("{prefix}-{}", hex::encode(bytes)))
}
