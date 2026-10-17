//! Additive owned-browser actions, still behind the parent's exact tool permit.
use super::ToolResult;
use crate::local_computer::LocalComputerState;
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;

pub(super) fn supported(tool: &str) -> bool {
    matches!(
        tool,
        "local-browser-activate"
            | "local-browser-fill"
            | "local-browser-handover"
            | "local-browser-download"
            | "local-browser-upload-choices"
            | "local-browser-upload"
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Activation {
    activation_ref: String,
    origin: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UploadChoices {
    tab_ref: String,
    origin: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FormEntry {
    field_ref: String,
    origin: String,
    name: String,
    text: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Handover {
    reason: String,
}

pub(super) async fn execute(
    tool: &str,
    arguments: Value,
    computers: Arc<LocalComputerState>,
    workspace: String,
    agent: String,
    generation: u64,
) -> Result<ToolResult, String> {
    if tool == "local-browser-upload-choices" {
        let input: UploadChoices = serde_json::from_value(arguments)
            .map_err(|_| "Use one current tabRef and its exact origin.")?;
        validate_reference(&input.tab_ref, &input.origin)?;
        let output = tauri::async_runtime::spawn_blocking(move || {
            crate::local_computer::browser::upload_choices(
                &computers,
                &workspace,
                &agent,
                generation,
                &input.tab_ref,
                &input.origin,
            )
        })
        .await
        .map_err(|_| "Browser upload choices were interrupted; list tabs again.")??;
        return Ok(ToolResult { ok: true, output });
    }
    if tool == "local-browser-upload" {
        let input: crate::local_computer::browser::UploadRequest =
            serde_json::from_value(arguments).map_err(|_| {
                "Use one current uploadRef, exact origin/name and published artifactId."
            })?;
        validate_reference(&input.upload_ref, &input.origin)?;
        if input.name.trim().is_empty()
            || input.name.chars().count() > 160
            || input.name.chars().any(char::is_control)
        {
            return Err("Choose the exact observed public upload label.".into());
        }
        let output=tauri::async_runtime::spawn_blocking(move||crate::local_computer::browser::upload(&computers,&workspace,&agent,generation,&input)).await.map_err(|_|"Browser file attachment outcome is uncertain. Hand control to the user; never replay it.")??;
        return Ok(ToolResult { ok: true, output });
    }
    if tool == "local-browser-download" {
        let input: crate::local_computer::browser::DownloadRequest =
            serde_json::from_value(arguments).map_err(|_| {
                "Use one current downloadRef, exact observed origin/name/URL and passive filename."
            })?;
        validate_reference(&input.download_ref, &input.origin)?;
        let output = tauri::async_runtime::spawn_blocking(move || crate::local_computer::browser::download(
            &computers, &workspace, &agent, generation, &input,
        )).await.map_err(|_| "Browser download was interrupted. No action was replayed; inspect the browser and workspace before continuing.")??;
        return Ok(ToolResult { ok: true, output });
    }
    if tool == "local-browser-handover" {
        let input: Handover =
            serde_json::from_value(arguments).map_err(|_| "Describe the human browser step.")?;
        let output = tauri::async_runtime::spawn_blocking(move || crate::local_computer::browser::handover(
            &computers, &workspace, &agent, generation, &input.reason,
        )).await.map_err(|_| "Browser handover was interrupted. Inspect saved task attention and use Stop if control is still active.")??;
        return Ok(ToolResult { ok: true, output });
    }
    if tool == "local-browser-fill" {
        let input: FormEntry = serde_json::from_value(arguments)
            .map_err(|_| "Use a current fieldRef, exact origin/name and public text.")?;
        validate_reference(&input.field_ref, &input.origin)?;
        if input.name.is_empty()
            || input.name.chars().count() > 160
            || input.name.chars().any(char::is_control)
            || input.text.is_empty()
            || input.text.len() > 2048
            || crate::secret_redaction::secret_marker_survives(&input.text)
            || crate::secret_redaction::looks_secret(&input.text)
        {
            return Err(
                "Invalid public browser form entry. No browser input was dispatched.".into(),
            );
        }
        let output=tauri::async_runtime::spawn_blocking(move||crate::local_computer::browser::fill(
            &computers,&workspace,&agent,generation,&input.field_ref,&input.origin,&input.name,&input.text,
        )).await.map_err(|_|"Browser form entry outcome is uncertain. Observe before another action; never replay it.")??;
        return Ok(ToolResult { ok: true, output });
    }
    if tool != "local-browser-activate" {
        return Err("Unsupported owned-browser action.".into());
    }
    let input: Activation = serde_json::from_value(arguments)
        .map_err(|_| "Use a current activationRef and its exact source origin.")?;
    validate_reference(&input.activation_ref, &input.origin)?;
    let output = tauri::async_runtime::spawn_blocking(move || {
        crate::local_computer::browser::activate(
            &computers,
            &workspace,
            &agent,
            generation,
            &input.activation_ref,
            &input.origin,
        )
    })
    .await
    .map_err(|_| {
        "Browser tab activation outcome is uncertain. Observe the current state; never replay it."
    })??;
    Ok(ToolResult { ok: true, output })
}

fn validate_reference(reference: &str, origin: &str) -> Result<(), String> {
    if reference.len() != 48
        || !reference.bytes().all(|byte| byte.is_ascii_hexdigit())
        || origin.len() > 2048
        || origin.chars().any(char::is_control)
    {
        return Err("Invalid browser action scope. No browser input was dispatched.".into());
    }
    Ok(())
}
