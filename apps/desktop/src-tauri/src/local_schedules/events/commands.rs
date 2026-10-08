use super::super::*;
use super::{delivery, models::*, secrets, template};
use crate::store::repos::local_event;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveEventRequest {
    workspace_id: String,
    id: String,
    agent_id: String,
    provider_id: String,
    model: String,
    reasoning_effort: Option<String>,
    permission_mode: String,
    prompt: String,
    event: EventDraft,
    signing_key_id: String,
    expected_revision: Option<i64>,
    #[serde(default)]
    rotate_endpoint: bool,
}

#[tauri::command]
pub fn event_trigger_save(
    window: tauri::WebviewWindow,
    request: SaveEventRequest,
) -> Result<LocalSchedule, String> {
    require_main_window(&window)?;
    template::validate(&request.event, &request.prompt).map_err(|error| error.to_string())?;
    template::validate_new_expiry(&request.event, Utc::now()).map_err(|error| error.to_string())?;
    validate_bounded_id(&request.id, "Event trigger", MAX_ID_CHARACTERS)?;
    if !template::identifier(&request.id, 96) {
        return Err("Event trigger IDs use at most 96 ASCII letters, numbers, dots, underscores or hyphens.".into());
    }
    if !request.signing_key_id.starts_with("webhook-key:") || request.signing_key_id.len() > 160 {
        return Err("Choose the key reference returned by protected webhook signing setup.".into());
    }
    let fence = crate::account_session::AccountDispatchFence::capture()?;
    let store = global_store()?;
    let scope = authorized_scope::active_command_scope(ScopeAccess::Write)?;
    if request.workspace_id != scope.data.workspace_id() {
        return Err("The event trigger workspace changed.".into());
    }
    let prior = store
        .with_conn(|conn| repo::get_schedule(conn, store, &scope.private, &request.id))
        .map_err(|e| e.to_string())?;
    let prior_config = prior
        .as_ref()
        .map(|row| decode_schedule_payload(row))
        .transpose()
        .map_err(|e| e.to_string())?
        .and_then(|p| match p.trigger {
            LocalScheduleTrigger::Event { config } => Some(config),
            _ => None,
        });
    if prior.is_some() && prior_config.is_none() {
        return Err("A clock schedule cannot become an event trigger.".into());
    }
    let rotate = request.rotate_endpoint
        || prior_config.as_ref().is_some_and(|old| {
            old.signing_key_id != request.signing_key_id || old.source != request.event.source
        });
    let config = EventConfig {
        source: request.event.source,
        fields: request.event.fields,
        max_age_seconds: request.event.max_age_seconds,
        valid_until: request.event.valid_until,
        route_id: if rotate || prior_config.is_none() {
            new_route()?
        } else {
            prior_config.as_ref().unwrap().route_id.clone()
        },
        key_version: if rotate {
            prior_config.as_ref().map_or(Ok(1), |old| {
                old.key_version
                    .checked_add(1)
                    .ok_or("The signing-key revision overflowed.")
            })?
        } else {
            prior_config.as_ref().map_or(1, |old| old.key_version)
        },
        signing_key_id: request.signing_key_id,
    };
    secrets::require_key(
        &request.workspace_id,
        &request.agent_id,
        &request.id,
        &config,
    )?;
    fence.with_current(|| {
        store
            .transaction(|conn| {
                scope.private.ensure_exists(conn)?;
                let trigger = LocalScheduleTrigger::Event { config };
                let result = if let Some(expected_revision) = request.expected_revision {
                    update_at(
                        conn,
                        store,
                        &scope,
                        UpdateLocalScheduleRequest {
                            workspace_id: request.workspace_id,
                            id: request.id.clone(),
                            project_id: None,
                            agent_id: request.agent_id,
                            provider_id: request.provider_id,
                            model: request.model,
                            reasoning_effort: request.reasoning_effort,
                            prompt: request.prompt,
                            timezone: "UTC".into(),
                            execution_kind: "agent".into(),
                            permission_mode: request.permission_mode,
                            trigger,
                            expected_revision,
                        },
                        Utc::now(),
                    )?
                } else {
                    create_at(
                        conn,
                        store,
                        &scope,
                        CreateLocalScheduleRequest {
                            workspace_id: request.workspace_id,
                            id: request.id.clone(),
                            project_id: None,
                            agent_id: request.agent_id,
                            provider_id: request.provider_id,
                            model: request.model,
                            reasoning_effort: request.reasoning_effort,
                            prompt: request.prompt,
                            timezone: "UTC".into(),
                            execution_kind: "agent".into(),
                            permission_mode: request.permission_mode,
                            trigger,
                            status: LocalScheduleStatus::Paused,
                        },
                        Utc::now(),
                    )?
                };
                local_event::retire_pending(conn, &scope.private, &request.id, "paused")?;
                Ok(result)
            })
            .map_err(|error| error.to_string())
    })
}

fn new_route() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "Secure event endpoint generation is unavailable.")?;
    Ok(hex::encode(bytes))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventPreviewRequest {
    event: EventDraft,
    prompt: String,
    sample_json: String,
}

#[tauri::command]
pub fn event_template_preview(
    window: tauri::WebviewWindow,
    request: EventPreviewRequest,
) -> Result<EventPreview, String> {
    require_main_window(&window)?;
    template::parse(request.sample_json.as_bytes())
        .and_then(|body| template::render(&request.event, &request.prompt, &body))
        .map_err(|error| error.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventHistoryRequest {
    workspace_id: String,
    schedule_id: String,
}

#[tauri::command]
pub fn event_delivery_list(
    window: tauri::WebviewWindow,
    request: EventHistoryRequest,
) -> Result<Vec<EventDelivery>, String> {
    require_main_window(&window)?;
    let store = global_store()?;
    store
        .transaction(|conn| {
            let scope = authorized_scope::resolve(
                conn,
                Some(&request.workspace_id),
                None,
                ScopeAccess::Read,
            )?;
            let row = repo::get_schedule(conn, store, &scope.private, &request.schedule_id)?
                .ok_or_else(|| StoreError::Invalid("This event trigger is unavailable.".into()))?;
            if row.trigger_kind != "event" {
                return Err(StoreError::Invalid("This is not an event trigger.".into()));
            }
            local_event::prune(
                conn,
                store,
                &scope.private,
                &request.schedule_id,
                &timestamp(Utc::now()),
                &timestamp(Utc::now() - Duration::hours(24)),
            )?;
            local_event::list(conn, store, &scope.private, &request.schedule_id, 50)?
                .into_iter()
                .map(|row| delivery::public(store, conn, &scope.private, row))
                .collect()
        })
        .map_err(|error| error.to_string())
}
