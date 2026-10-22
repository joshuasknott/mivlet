use super::*;

pub(super) fn is_real_machine_id(value: &str) -> bool {
    valid_id(value) && value != "pending"
}

pub(super) fn operation_state(value: &Value) -> String {
    pick_string(value, &["state", "status"]).unwrap_or_default()
}

pub(super) fn operation_machine_id(value: &Value) -> Option<String> {
    pick_string(value, &["machineId", "machine_id"]).or_else(|| {
        value
            .get("machine")
            .and_then(|machine| pick_string(machine, &["id", "machineId"]))
    })
}

pub(super) fn create_machine_id(
    response: &Value,
    operation: &Value,
    pending: &PendingOperation,
) -> Result<String, String> {
    let response_id = operation_machine_id(response);
    let operation_id = operation_machine_id(operation);
    if let (Some(response_id), Some(operation_id)) = (&response_id, &operation_id) {
        if is_real_machine_id(response_id)
            && is_real_machine_id(operation_id)
            && response_id != operation_id
        {
            return Err(
                "Instabox returned two different computer identities for this create operation."
                    .into(),
            );
        }
    }
    if let Some(pending_id) = is_real_machine_id(&pending.machine_id).then_some(&pending.machine_id)
    {
        if let Some(operation_id) = operation_id.as_ref().or(response_id.as_ref()) {
            if pending_id != operation_id {
                return Err("Instabox returned a different computer identity while completing this create operation.".into());
            }
        }
    }
    let machine_id = operation_id
        .filter(|value| is_real_machine_id(value))
        .or_else(|| response_id.filter(|value| is_real_machine_id(value)))
        .or_else(|| is_real_machine_id(&pending.machine_id).then(|| pending.machine_id.clone()))
        .ok_or_else(|| "Instabox did not return the created computer identity.".to_string())?;
    Ok(machine_id)
}

pub(super) async fn wait_for_operation(
    key: &str,
    operation_id: &str,
    fence: &AccountDispatchFence,
) -> Result<Value, String> {
    if !valid_id(operation_id) {
        return Err("Instabox returned an invalid operation identity.".into());
    }
    let mut latest = Value::Null;
    // Instabox may return early when the operation phase changes. Bound the
    // normal create wait to three long-polls instead of assuming one response
    // means the operation is terminal.
    for _ in 0..3 {
        let path = format!("/v1/operations/{operation_id}?wait=8s");
        let result = api_request(reqwest::Method::GET, &path, key, None, None).await;
        fence.with_current(|| Ok(()))?;
        latest = result?;
        if matches!(operation_state(&latest).as_str(), "succeeded" | "failed") {
            break;
        }
    }
    Ok(latest)
}

pub(super) async fn start_desktop(
    key: &str,
    machine_id: &str,
    fence: &AccountDispatchFence,
) -> Result<(), String> {
    if !is_real_machine_id(machine_id) {
        return Err("Instabox returned an invalid computer identity.".into());
    }
    let path = format!("/v1/machines/{machine_id}/desktop");
    let body = json!({
        "action": "start",
        "width": DESKTOP_START_WIDTH,
        "height": DESKTOP_START_HEIGHT,
    });
    // Instabox documents desktop.start as safe to call again: it leaves an
    // already-running desktop alone. Keep this recovery record because the
    // route has no Idempotency-Key contract, then retry only on explicit
    // reconciliation rather than on a status read.
    let result = api_request(reqwest::Method::POST, &path, key, Some(body), None).await;
    fence.with_current(|| Ok(()))?;
    let value = result?;
    if !desktop_start_succeeded(&value) {
        return Err("Instabox created the computer, but its desktop is not running yet. Check the operation result before retrying.".into());
    }
    Ok(())
}

pub(super) fn desktop_start_succeeded(value: &Value) -> bool {
    value.get("running").and_then(Value::as_bool) == Some(true)
}

pub(super) fn queue_desktop_start(
    saved: &mut SavedConnection,
    machine_id: &str,
) -> Result<(), String> {
    let path = format!("/v1/machines/{machine_id}/desktop");
    if saved
        .pending
        .iter()
        .any(|pending| pending.action == "desktop-start" && pending.machine_id == machine_id)
    {
        return Ok(());
    }
    if saved.pending.len() >= MAX_PENDING {
        return Err("Too many unresolved Instabox operations. Reconcile before continuing.".into());
    }
    saved.pending.push(PendingOperation {
        idempotency_key: String::new(),
        action: "desktop-start".into(),
        machine_id: machine_id.into(),
        operation_id: None,
        path,
        body: json!({
            "action": "start",
            "width": DESKTOP_START_WIDTH,
            "height": DESKTOP_START_HEIGHT,
        }),
        created_at_ms: now_ms(),
        desktop_start_approved: false,
    });
    Ok(())
}
