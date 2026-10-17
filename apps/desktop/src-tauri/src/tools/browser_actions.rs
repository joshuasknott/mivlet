//! Additive owned-browser actions, still behind the parent's exact tool permit.
use super::ToolResult;
use crate::local_computer::LocalComputerState;
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;

pub(super) fn supported(tool: &str) -> bool {
    tool == "local-browser-activate"
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Activation {
    activation_ref: String,
    origin: String,
}

pub(super) async fn execute(
    tool: &str,
    arguments: Value,
    computers: Arc<LocalComputerState>,
    workspace: String,
    agent: String,
    generation: u64,
) -> Result<ToolResult, String> {
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
