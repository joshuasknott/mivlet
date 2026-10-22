use super::{
    api_request, machine_summary, machine_values, next_cursor, usage, AccountDispatchFence,
    CloudComputerStatus, SavedConnection, MAX_MACHINES,
};

pub(super) fn status_revision_matches(initial: u64, latest: u64) -> bool {
    initial == latest
}

pub(super) async fn fetch_machines(key: &str) -> Result<Vec<super::MachineSummary>, String> {
    let mut cursor: Option<String> = None;
    let mut values = Vec::new();
    for _ in 0..10 {
        let path = match cursor.as_deref() {
            Some(cursor) => format!(
                "/v1/machines?limit=100&cursor={}",
                url::form_urlencoded::byte_serialize(cursor.as_bytes()).collect::<String>()
            ),
            None => "/v1/machines?limit=100".to_string(),
        };
        let page = api_request(reqwest::Method::GET, &path, key, None, None).await?;
        values.extend(machine_values(&page));
        if values.len() >= MAX_MACHINES {
            break;
        }
        cursor = next_cursor(&page);
        if cursor.is_none() {
            break;
        }
    }
    Ok(values
        .into_iter()
        .take(MAX_MACHINES)
        .filter_map(|item| machine_summary(&item))
        .collect())
}

async fn fetch_status(
    saved: SavedConnection,
    key: &str,
    fence: &AccountDispatchFence,
) -> Result<CloudComputerStatus, String> {
    fence.with_current(|| Ok(()))?;
    let machines = fetch_machines(key).await?;
    fence.with_current(|| Ok(()))?;
    let usage_json = api_request(reqwest::Method::GET, "/v1/usage", key, None, None).await?;
    fence.with_current(|| Ok(()))?;
    let selected_machine_id = saved.selected_machine_id.clone();
    let machine = selected_machine_id
        .as_ref()
        .and_then(|id| machines.iter().find(|m| &m.id == id).cloned());
    Ok(CloudComputerStatus {
        connected: true,
        provider: "instabox",
        selected_machine_id,
        connection_revision: saved.connection_revision,
        machine,
        machines,
        usage: Some(usage(&usage_json)),
        pending_action: saved.pending.first().map(|p| p.action.clone()),
        capabilities: Vec::new(),
        error: None,
    })
}

pub(super) async fn status_inner(
    workspace_id: &str,
    fence: &AccountDispatchFence,
) -> Result<CloudComputerStatus, String> {
    let scope = super::scope_for(workspace_id)?;
    let saved = super::read_saved(&scope)?;
    let credential_name = super::key_name()?;
    let Some(key) = super::native_key(&credential_name)? else {
        return Ok(CloudComputerStatus {
            provider: "instabox",
            connection_revision: saved.connection_revision,
            selected_machine_id: saved.selected_machine_id,
            pending_action: saved.pending.first().map(|pending| pending.action.clone()),
            ..Default::default()
        });
    };
    let initial_revision = saved.connection_revision;
    let result = fetch_status(saved, key.as_str(), fence).await;
    fence.with_current(|| Ok(()))?;
    let latest = super::read_saved(&scope)?;
    if !status_revision_matches(initial_revision, latest.connection_revision) {
        return Ok(CloudComputerStatus {
            connected: true,
            provider: "instabox",
            connection_revision: latest.connection_revision,
            selected_machine_id: latest.selected_machine_id,
            pending_action: latest.pending.first().map(|pending| pending.action.clone()),
            capabilities: Vec::new(),
            error: Some("Instabox state changed while refreshing. Refresh again.".into()),
            ..Default::default()
        });
    }
    match result {
        Ok(mut status) => {
            status.connection_revision = latest.connection_revision;
            status.selected_machine_id = latest.selected_machine_id.clone();
            status.pending_action = latest.pending.first().map(|pending| pending.action.clone());
            status.machine = status.selected_machine_id.as_ref().and_then(|id| {
                status
                    .machines
                    .iter()
                    .find(|machine| &machine.id == id)
                    .cloned()
            });
            Ok(status)
        }
        Err(error) => Ok(CloudComputerStatus {
            connected: true,
            provider: "instabox",
            connection_revision: latest.connection_revision,
            selected_machine_id: latest.selected_machine_id,
            pending_action: latest.pending.first().map(|pending| pending.action.clone()),
            capabilities: Vec::new(),
            error: Some(error),
            ..Default::default()
        }),
    }
}
