use serde_json::Value;

use super::{MachineSummary, UsageSummary, MAX_MACHINES};

pub(super) fn pick_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str).map(safe_metadata))
}

fn safe_metadata(value: &str) -> String {
    value
        .chars()
        .filter(|ch| !ch.is_control())
        .take(160)
        .collect()
}

pub(super) fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_:.".contains(&b))
}

pub(super) fn machine_summary(value: &Value) -> Option<MachineSummary> {
    let id = pick_string(value, &["id", "machineId"])?;
    Some(MachineSummary {
        id,
        name: pick_string(value, &["name", "displayName"])
            .unwrap_or_else(|| "Instabox computer".into()),
        status: pick_string(value, &["status", "state"]).unwrap_or_else(|| "unknown".into()),
        template_id: pick_string(value, &["templateId", "template"]),
    })
}

pub(super) fn machine_values(value: &Value) -> Vec<Value> {
    value
        .get("machines")
        .and_then(Value::as_array)
        .or_else(|| value.as_array())
        .map(|items| items.iter().take(MAX_MACHINES).cloned().collect())
        .unwrap_or_default()
}

pub(super) fn next_cursor(value: &Value) -> Option<String> {
    pick_string(value, &["nextCursor", "next_cursor"])
}

pub(super) fn usage(value: &Value) -> UsageSummary {
    let limits = value.get("limits").and_then(Value::as_object);
    let top_number = |keys: &[&str]| {
        keys.iter()
            .find_map(|key| value.get(*key).and_then(Value::as_u64))
    };
    let limit_number = |keys: &[&str]| {
        keys.iter().find_map(|key| {
            limits
                .and_then(|limits| limits.get(*key))
                .and_then(Value::as_u64)
        })
    };
    UsageSummary {
        machine_count: top_number(&["machineCount", "machines"]),
        machine_limit: limit_number(&[
            "machines",
            "machineLimit",
            "machinesLimit",
            "maxMachines",
            "maxSandboxes",
        ]),
        snapshot_count: top_number(&["snapshotCount", "snapshots"]),
        snapshot_limit: limit_number(&[
            "snapshots",
            "snapshotLimit",
            "snapshotsLimit",
            "maxSnapshots",
        ]),
    }
}
