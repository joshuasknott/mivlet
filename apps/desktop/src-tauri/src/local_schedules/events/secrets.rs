//! Native protected-secret consumer. No raw secret or generic credential getter
//! crosses this boundary; custody remains with the protected request authority.
use super::super::*;
use super::models::{EventConfig, EventPreview};

pub(super) fn verify(
    workspace: &str,
    agent: &str,
    target: &str,
    config: &EventConfig,
    body: &[u8],
    signature: &str,
) -> Result<bool, String> {
    crate::protected_secrets::runtime::verify_webhook_signature(
        workspace,
        agent,
        &config.signing_key_id,
        target,
        body,
        signature,
    )
}

pub(super) fn redact(
    workspace: &str,
    agent: &str,
    target: &str,
    config: &EventConfig,
    mut preview: EventPreview,
) -> Result<EventPreview, String> {
    let paths: Vec<_> = preview
        .selected_fields
        .iter()
        .map(|(path, value)| {
            (
                path.clone(),
                value
                    .as_str()
                    .map_or_else(|| value.to_string(), str::to_string),
            )
        })
        .collect();
    let texts: Vec<_> = std::iter::once(preview.prompt.clone())
        .chain(paths.iter().map(|(_, text)| text.clone()))
        .collect();
    let cleaned = crate::protected_secrets::runtime::redact_event_texts(
        workspace,
        agent,
        &config.signing_key_id,
        target,
        &texts,
    )?;
    if cleaned.len() != texts.len() {
        return Err("Event text could not be sanitized.".into());
    }
    preview.prompt = cleaned[0].clone();
    for ((path, original), clean) in paths.into_iter().zip(cleaned.into_iter().skip(1)) {
        if original != clean {
            preview
                .selected_fields
                .insert(path, serde_json::Value::String(clean));
        }
    }
    Ok(preview)
}

pub(super) fn require_key(
    workspace: &str,
    agent: &str,
    target: &str,
    config: &EventConfig,
) -> Result<(), String> {
    // A false HMAC comparison still establishes scoped key presence. Missing,
    // revoked or differently scoped keys return an error from the owner API.
    verify(
        workspace,
        agent,
        target,
        config,
        b"",
        &format!("sha256={}", "00".repeat(32)),
    )
    .map(|_| ())
}

pub(in crate::local_schedules) fn require_schedule_key(
    store: &Store,
    scope: &PrivateDataScope,
    schedule_id: &str,
) -> Result<(), String> {
    let schedule = store
        .with_conn(|conn| {
            repo::get_schedule(conn, store, scope, schedule_id)?
                .map(schedule_from_row)
                .transpose()
        })
        .map_err(|error| error.to_string())?;
    if let Some(schedule) = schedule {
        if let LocalScheduleTrigger::Event { config } = &schedule.trigger {
            require_key(
                scope.workspace_id(),
                &schedule.agent_id,
                &schedule.id,
                config,
            )?;
        }
    }
    Ok(())
}

pub(in crate::local_schedules) fn require_occurrence_key(
    store: &Store,
    scope: &PrivateDataScope,
    occurrence_id: &str,
) -> Result<(), String> {
    let schedule_id = store
        .with_conn(|conn| {
            repo::get_occurrence(conn, store, scope, occurrence_id)
                .map(|row| row.map(|row| row.schedule_id))
        })
        .map_err(|error| error.to_string())?;
    if let Some(id) = schedule_id {
        require_schedule_key(store, scope, &id)?;
    }
    Ok(())
}

pub(crate) fn pause_revoked_key(
    workspace: &str,
    agent: &str,
    key_id: &str,
    target: &str,
) -> Result<(), String> {
    let store = global_store()?;
    let scope = authorized_scope::command_scope(Some(workspace.into()), None, ScopeAccess::Write)?;
    let fence = crate::account_session::AccountDispatchFence::capture()?;
    fence.with_current(|| {
        store
            .transaction(|conn| {
                let Some(row) = repo::get_schedule(conn, store, &scope.private, target)? else {
                    return Ok(());
                };
                let schedule = schedule_from_row(row)?;
                if let LocalScheduleTrigger::Event { config } = &schedule.trigger {
                    if schedule.agent_id == agent
                        && config.signing_key_id == key_id
                        && schedule.status == LocalScheduleStatus::Enabled
                    {
                        set_status_at(
                            conn,
                            store,
                            &scope,
                            SetLocalScheduleStatusRequest {
                                workspace_id: workspace.into(),
                                id: target.into(),
                                expected_revision: schedule.revision,
                                status: LocalScheduleStatus::Paused,
                            },
                            Utc::now(),
                        )?;
                    }
                }
                Ok(())
            })
            .map_err(|error| error.to_string())
    })
}
