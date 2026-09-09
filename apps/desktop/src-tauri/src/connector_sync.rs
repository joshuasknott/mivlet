//! Central, local-first connector sync lifecycle.
//!
//! Provider reads remain on demand. This module owns only the durable,
//! workspace-scoped lifecycle used by manual sync today and background/retry
//! scheduling later. It never persists tokens or provider-owned content.

use std::{fs, path::Path};

use chrono::{Duration, SecondsFormat, Utc};

use crate::{
    models::{
        ConnectorCommandError, ConnectorSyncFailure, ConnectorSyncRequest, ConnectorSyncState,
    },
    paths::connector_sync_state_path,
};

const SYNC_TRIGGERS: &[&str] = &["manual", "background", "retry"];

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn validate_workspace_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.chars().enumerate().all(|(index, character)| {
            character.is_ascii_alphanumeric()
                || (index > 0 && matches!(character, '.' | '_' | ':' | '-'))
        })
}

fn idle_state(connector_id: &str, workspace_id: &str) -> ConnectorSyncState {
    ConnectorSyncState {
        connector_id: connector_id.to_string(),
        workspace_id: workspace_id.to_string(),
        phase: "idle".to_string(),
        trigger: None,
        attempt: 0,
        started_at: None,
        completed_at: None,
        last_successful_at: None,
        next_retry_at: None,
        cursor: None,
        items_processed: 0,
        stale_token_recovered: false,
        failure: None,
    }
}

fn start(mut state: ConnectorSyncState, trigger: &str, at: &str) -> ConnectorSyncState {
    state.phase = "syncing".to_string();
    state.trigger = Some(trigger.to_string());
    state.attempt = if trigger == "retry" {
        state.attempt.saturating_add(1)
    } else {
        1
    };
    state.started_at = Some(at.to_string());
    state.completed_at = None;
    state.next_retry_at = None;
    state.items_processed = 0;
    state.stale_token_recovered = false;
    state.failure = None;
    state
}

fn succeed(mut state: ConnectorSyncState, at: &str) -> ConnectorSyncState {
    state.phase = "succeeded".to_string();
    state.completed_at = Some(at.to_string());
    state.last_successful_at = Some(at.to_string());
    state.failure = None;
    state
}

fn partial(mut state: ConnectorSyncState, message: String, at: &str) -> ConnectorSyncState {
    state.phase = "partial".to_string();
    state.completed_at = Some(at.to_string());
    state.failure = Some(ConnectorSyncFailure {
        kind: "partial-sync".to_string(),
        message,
        retryable: true,
        retry_after: None,
    });
    state
}

fn failure_kind(code: &str) -> &'static str {
    match code {
        "needs-auth"
        | "auth-required"
        | "configuration-required"
        | "token-expired"
        | "refresh-rejected" => "auth-required",
        "permission-denied" => "permission-denied",
        "rate-limited" => "rate-limited",
        "cancelled" => "cancelled",
        "partial-sync" => "partial-sync",
        _ => "provider-unavailable",
    }
}

fn fail(
    mut state: ConnectorSyncState,
    error: &ConnectorCommandError,
    at: &str,
) -> ConnectorSyncState {
    let kind = failure_kind(&error.code);
    let retryable = matches!(
        kind,
        "provider-unavailable" | "rate-limited" | "partial-sync"
    ) && error.retryable;
    state.phase = if kind == "cancelled" {
        "cancelled".to_string()
    } else {
        "failed".to_string()
    };
    state.completed_at = Some(at.to_string());
    state.next_retry_at = if retryable {
        error.retry_after.clone().or_else(|| {
            Some((Utc::now() + Duration::minutes(5)).to_rfc3339_opts(SecondsFormat::Millis, true))
        })
    } else {
        None
    };
    state.failure = Some(ConnectorSyncFailure {
        kind: kind.to_string(),
        message: error.message.clone(),
        retryable,
        retry_after: error.retry_after.clone(),
    });
    state
}

fn read_states(path: &Path) -> Result<Vec<ConnectorSyncState>, String> {
    if let Some(states) = crate::store::read_document(path)? {
        return Ok(states);
    }
    if !path.exists() {
        return Ok(Vec::new());
    }
    let contents =
        fs::read_to_string(path).map_err(|_| "Mivlet could not read connector sync state.")?;
    serde_json::from_str(&contents)
        .map_err(|_| "Mivlet could not parse connector sync state.".into())
}

fn write_states(path: &Path, states: &[ConnectorSyncState]) -> Result<(), String> {
    if crate::store::write_document(path, &states)? {
        return Ok(());
    }
    let encoded = serde_json::to_string_pretty(states)
        .map_err(|_| "Mivlet could not encode connector sync state.")?;
    fs::write(path, encoded).map_err(|_| "Mivlet could not save connector sync state.".into())
}

fn replace_state(states: &mut Vec<ConnectorSyncState>, state: ConnectorSyncState) {
    states.retain(|current| {
        current.connector_id != state.connector_id || current.workspace_id != state.workspace_id
    });
    states.push(state);
}

fn request_error(connector_id: &str, message: &str) -> ConnectorCommandError {
    ConnectorCommandError {
        code: "invalid-request".to_string(),
        connector_id: connector_id.to_string(),
        message: message.to_string(),
        retryable: false,
        retry_after: None,
    }
}

#[tauri::command]
pub fn list_connector_sync_states(
    app: tauri::AppHandle,
    workspace_id: String,
) -> Result<Vec<ConnectorSyncState>, ConnectorCommandError> {
    if !validate_workspace_id(&workspace_id) {
        return Err(request_error(
            "",
            "Connector sync requires a valid local workspace id.",
        ));
    }
    let path = connector_sync_state_path(&app).map_err(|message| request_error("", &message))?;
    let states = read_states(&path).map_err(|message| request_error("", &message))?;
    Ok(states
        .into_iter()
        .filter(|state| state.workspace_id == workspace_id)
        .collect())
}

#[tauri::command]
pub async fn sync_connector(
    app: tauri::AppHandle,
    request: ConnectorSyncRequest,
) -> Result<ConnectorSyncState, ConnectorCommandError> {
    if !validate_workspace_id(&request.workspace_id) {
        return Err(request_error(
            &request.connector_id,
            "Connector sync requires a valid local workspace id.",
        ));
    }
    let trigger = request.trigger.as_deref().unwrap_or("manual");
    if !SYNC_TRIGGERS.contains(&trigger) {
        return Err(request_error(
            &request.connector_id,
            "Unknown connector sync trigger.",
        ));
    }
    let path = connector_sync_state_path(&app)
        .map_err(|message| request_error(&request.connector_id, &message))?;
    let mut states =
        read_states(&path).map_err(|message| request_error(&request.connector_id, &message))?;
    let previous = states
        .iter()
        .find(|state| {
            state.connector_id == request.connector_id && state.workspace_id == request.workspace_id
        })
        .cloned()
        .unwrap_or_else(|| idle_state(&request.connector_id, &request.workspace_id));
    let running = start(previous, trigger, &now());
    replace_state(&mut states, running.clone());
    write_states(&path, &states)
        .map_err(|message| request_error(&request.connector_id, &message))?;

    let finished = match crate::connectors::refresh_connector_health(
        app,
        request.connector_id.clone(),
        Some(request.workspace_id.clone()),
    )
    .await
    {
        Ok(manifest) if manifest.health.state == "healthy" => succeed(running, &now()),
        Ok(manifest) => partial(running, manifest.health.summary, &now()),
        Err(error) => fail(running, &error, &now()),
    };
    replace_state(&mut states, finished.clone());
    write_states(&path, &states)
        .map_err(|message| request_error(&request.connector_id, &message))?;
    Ok(finished)
}

#[tauri::command]
pub fn cancel_connector_sync(
    app: tauri::AppHandle,
    connector_id: String,
    workspace_id: String,
) -> Result<ConnectorSyncState, ConnectorCommandError> {
    if !validate_workspace_id(&workspace_id) {
        return Err(request_error(
            &connector_id,
            "Connector sync requires a valid local workspace id.",
        ));
    }
    let path = connector_sync_state_path(&app)
        .map_err(|message| request_error(&connector_id, &message))?;
    let mut states =
        read_states(&path).map_err(|message| request_error(&connector_id, &message))?;
    let current = states
        .iter()
        .find(|state| state.connector_id == connector_id && state.workspace_id == workspace_id)
        .cloned()
        .unwrap_or_else(|| idle_state(&connector_id, &workspace_id));
    let cancelled = fail(
        current,
        &ConnectorCommandError {
            code: "cancelled".to_string(),
            connector_id: connector_id.clone(),
            message: "Connector sync was cancelled.".to_string(),
            retryable: false,
            retry_after: None,
        },
        &now(),
    );
    replace_state(&mut states, cancelled.clone());
    write_states(&path, &states).map_err(|message| request_error(&connector_id, &message))?;
    Ok(cancelled)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transitions_manual_sync_and_retry() {
        let running = start(idle_state("github", "workspace-1"), "manual", "start");
        assert_eq!(running.phase, "syncing");
        assert_eq!(running.attempt, 1);
        let retried = start(running, "retry", "retry");
        assert_eq!(retried.attempt, 2);
        let complete = succeed(retried, "done");
        assert_eq!(complete.phase, "succeeded");
        assert_eq!(complete.last_successful_at.as_deref(), Some("done"));
    }

    #[test]
    fn classifies_token_and_provider_errors_fail_closed() {
        assert_eq!(failure_kind("refresh-rejected"), "auth-required");
        assert_eq!(failure_kind("permission-denied"), "permission-denied");
        assert_eq!(failure_kind("rate-limited"), "rate-limited");
        assert_eq!(
            failure_kind("unexpected-secret-bearing-error"),
            "provider-unavailable"
        );
    }

    #[test]
    fn workspace_ids_cannot_escape_the_local_boundary() {
        assert!(validate_workspace_id("workspace-1"));
        assert!(!validate_workspace_id("../other"));
        assert!(!validate_workspace_id(""));
    }

    #[test]
    fn state_replacement_is_scoped_by_workspace_and_connector() {
        let mut states = vec![
            idle_state("github", "one"),
            idle_state("github", "two"),
            idle_state("gmail", "one"),
        ];
        replace_state(&mut states, succeed(idle_state("github", "one"), "done"));
        assert_eq!(states.len(), 3);
        assert_eq!(
            states
                .iter()
                .find(|state| state.connector_id == "github" && state.workspace_id == "two")
                .unwrap()
                .phase,
            "idle"
        );
    }
}
