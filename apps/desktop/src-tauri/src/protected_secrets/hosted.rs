//! User-invoked, cloud-only provider entry. The closed consumer below is the
//! sole recipient of captured bytes; there is no tool/IPC raw-key getter.
use super::{capture, RequestInput};
use crate::hosted_tasks::{self, models::*, transport};
use crate::local_computer::LocalComputerState;
use std::sync::Arc;

#[tauri::command]
pub(crate) async fn hosted_provider_enroll(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<LocalComputerState>>,
    request: ProviderEnroll,
) -> Result<ProviderConnection, String> {
    if window.label() != "main" || !hosted_tasks::supported_provider(&request.provider_id) {
        return Err("Connect a supported cloud API provider from Mivlet Settings.".into());
    }
    state.validate_target(&request.workspace_id, &request.agent_id)?;
    let authority = state.authority_for(&request.workspace_id, &request.agent_id)?;
    let ticket = authority.begin_viewer(authority.snapshot()?.generation)?;
    let account = crate::account_session::AccountDispatchFence::capture()?;
    let scope = transport::cloud_scope()?;
    let credential_id = request
        .credential_id
        .unwrap_or(hosted_tasks::opaque("credential")?);
    hosted_tasks::valid_id(&credential_id)?;
    let (existing, runner) = transport::connections(&ticket, &scope, &request.agent_id).await?;
    let prior = existing.iter().find(|c| c.credential_id == credential_id);
    if prior.is_some_and(|c| c.provider_id != request.provider_id)
        || prior.map(|c| c.revision) != request.expected_revision
    {
        return Err(
            "Cloud provider connection changed. Refresh its list before entering a key.".into(),
        );
    }
    let metadata = Enrollment {
        credential_id,
        provider_id: request.provider_id.clone(),
        revision: request
            .expected_revision
            .unwrap_or(0)
            .checked_add(1)
            .ok_or("Cloud credential revision limit reached.")?,
    };
    let input = RequestInput { label: format!("Connect {} for cloud text tasks", request.provider_id), reason: format!("Send this separate API key directly to {runner}. No local provider key is copied. Cloud text tasks have no tools or local files."),
        purpose: "cloud-api-provider".into(), consumer: "hosted-provider-enrollment".into(), target_id: metadata.credential_id.clone() };
    let computers = state.inner().clone();
    let workspace = request.workspace_id.clone();
    let agent = request.agent_id.clone();
    let entry_id = hosted_tasks::opaque("cloud-key-entry")?;
    let (secret, ticket, account) = tauri::async_runtime::spawn_blocking(move || {
        let current = || ticket.check().is_ok() && account.with_current(|| Ok(())).is_ok();
        let secret = computers
            .with_protected_input(&workspace, &agent, ticket.generation, &entry_id, || {
                capture::prompt(&input, &current).map_err(|e| e.to_string())
            })?
            .ok_or("Cloud API key entry was cancelled.")?;
        Ok::<_, String>((secret, ticket, account))
    })
    .await
    .map_err(|_| "Native protected key entry did not complete.")??;
    ticket.check()?;
    account.with_current(|| Ok(()))?;
    let result = transport::enroll(
        &ticket,
        &scope,
        &request.agent_id,
        &metadata,
        secret.as_str(),
        &runner,
    )
    .await;
    // `Secret` zeroizes captured native text when this closed consumer ends.
    drop(secret);
    ticket.finish(result)
}
