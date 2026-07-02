//! Mobile remote-control command boundary.
//!
//! This module is the desktop-side surface a future WebSocket/mDNS transport
//! will call. It owns the trust list and pairing state, validates inbound
//! `RemoteCommand` envelopes, and delegates approved commands to the EXISTING
//! `approvals` and `scheduler` modules — it introduces no new side-effect path.
//!
//! The mobile device is a SECOND approval/observation/control surface, never an
//! authority. Mobile approve/deny is an input to the existing approval queue,
//! not execution authority: tools still require a fresh fingerprinted permit
//! issued by `execution_approvals`, unchanged.
//!
//! DELIBERATELY DEFERRED (see docs/architecture/mobile-remote.md):
//!   - The live WebSocket listener + mDNS advertiser. This skeleton exposes the
//!     command surface; binding it to a real transport is the next layer.
//!   - Real PSK / long-lived device-key crypto. Secret-derived pairing proof
//!     stays inside the future Rust transport and never crosses into JavaScript.
//!     Until then pairing commands fail closed.
//!
//! SECRET INVARIANT: PSK material, long-lived device keys, and pairing nonces
//! live behind this boundary (like backend credentials) and are never read back
//! into JavaScript. The types crossing the command boundary are non-secret
//! metadata only, mirroring `@fable/protocol`'s mobile-remote contract.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

/// Trust state of a paired device in the local trust list.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RemoteDeviceTrustState {
    Pending,
    Trusted,
    Revoked,
}

/// A paired device record held in the desktop trust list. Non-secret metadata
/// only — no PSK, no long-lived key. Those live behind this boundary.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDevice {
    pub id: String,
    pub label: String,
    pub trust_state: RemoteDeviceTrustState,
    pub first_paired_at: String,
    pub last_seen_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revoked_at: Option<String>,
}

/// Desktop-issued pairing challenge. `confirm_code` is the short numeric code
/// the user types to prove physical presence — never the PSK.
///
/// Part of the documented command surface the transport layer (next pass)
/// returns from `remote_pairing_start`. Constructed when the live transport
/// lands; kept here so the wire shape is fixed and reviewable now.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct RemotePairingChallenge {
    pub challenge_nonce: String,
    pub confirm_code: String,
    pub issued_at: String,
    pub expires_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteControlPreferenceRequest {
    #[serde(default)]
    pub ephemeral: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePairingStartRequest {
    #[serde(default)]
    pub manual_code: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePairingStatusRequest {
    pub challenge_nonce: Option<String>,
    pub manual_code: Option<String>,
}

/// Desktop-owned, non-secret remote-control status.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteControlStatusSnapshot {
    pub status: String,
    pub requested_enabled: bool,
    pub enabled: bool,
    pub transport: String,
    pub transport_ready: bool,
    pub pairing_ready: bool,
    pub server_name: String,
    pub device_count: usize,
    pub trusted_device_count: usize,
    pub revoked_device_count: usize,
    pub active_session_count: usize,
    pub message: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePairingStartResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub challenge: Option<RemotePairingChallenge>,
    pub status: RemoteControlStatusSnapshot,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePairingStatusResult {
    pub ok: bool,
    pub status: String,
    pub claimed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    pub message: String,
}

/// Outcome of a pairing attempt. Kept for the future Rust transport; it is not
/// exposed as a JavaScript command while proof verification is unavailable.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct RemotePairingResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device: Option<RemoteDevice>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Machine-readable failure codes for remote operations (all fail-closed).
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RemoteErrorCode {
    DeviceUnpaired,
    DeviceRevoked,
    SessionExpired,
    ApprovalNotFound,
    ApprovalAlreadyResolved,
    ScheduleNotFound,
    InvalidCommand,
    ProtocolVersionUnsupported,
    TransportUnavailable,
    Unauthorized,
}

/// Result of applying (or refusing) a remote command.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCommandResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub applied_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<RemoteErrorCode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Default)]
pub struct RemoteControlStore {
    pub devices: Vec<RemoteDevice>,
    pub requested_enabled: bool,
}

/// In-process control state. Held as Tauri state. The real store (encrypted
/// SQLite, like the rest of the durable non-secret metadata) lands with the
/// transport layer; this skeleton keeps only non-secret state.
#[derive(Default)]
pub struct RemoteTrustState(pub Mutex<RemoteControlStore>);

/// Initialize the remote-control trust state. Called once from `setup`.
pub fn initialize_state() -> RemoteTrustState {
    RemoteTrustState::default()
}

fn unavailable_message() -> String {
    "Mobile remote control is local to this network, but the live connection is not available in this build. Remote actions are disabled.".to_string()
}

fn server_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "Fable desktop".to_string())
}

fn status_snapshot(store: &RemoteControlStore) -> RemoteControlStatusSnapshot {
    let trusted_device_count = store
        .devices
        .iter()
        .filter(|device| device.trust_state == RemoteDeviceTrustState::Trusted)
        .count();
    let revoked_device_count = store
        .devices
        .iter()
        .filter(|device| device.trust_state == RemoteDeviceTrustState::Revoked)
        .count();

    RemoteControlStatusSnapshot {
        status: if store.requested_enabled {
            "unavailable".to_string()
        } else {
            "disabled".to_string()
        },
        requested_enabled: store.requested_enabled,
        enabled: false,
        transport: "lan-local".to_string(),
        transport_ready: false,
        pairing_ready: false,
        server_name: server_name(),
        device_count: store.devices.len(),
        trusted_device_count,
        revoked_device_count,
        active_session_count: 0,
        message: if store.requested_enabled {
            unavailable_message()
        } else {
            "Live mobile approvals are not available in this build.".to_string()
        },
        updated_at: now_iso(),
    }
}

/// List paired devices in the trust list. Non-secret metadata only.
#[tauri::command]
pub fn remote_list_devices(
    state: State<'_, RemoteTrustState>,
) -> Result<Vec<RemoteDevice>, String> {
    let guard = state
        .0
        .lock()
        .map_err(|_| "Remote trust list is unavailable.".to_string())?;
    Ok(guard.devices.clone())
}

#[tauri::command]
pub fn remote_control_status(
    state: State<'_, RemoteTrustState>,
) -> Result<RemoteControlStatusSnapshot, String> {
    let guard = state
        .0
        .lock()
        .map_err(|_| "Remote control status is unavailable.".to_string())?;
    Ok(status_snapshot(&guard))
}

#[tauri::command]
pub fn remote_control_enable(
    state: State<'_, RemoteTrustState>,
    _request: Option<RemoteControlPreferenceRequest>,
) -> Result<RemoteControlStatusSnapshot, String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "Remote control status is unavailable.".to_string())?;
    guard.requested_enabled = true;
    Ok(status_snapshot(&guard))
}

#[tauri::command]
pub fn remote_control_disable(
    state: State<'_, RemoteTrustState>,
    _request: Option<RemoteControlPreferenceRequest>,
) -> Result<RemoteControlStatusSnapshot, String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "Remote control status is unavailable.".to_string())?;
    guard.requested_enabled = false;
    Ok(status_snapshot(&guard))
}

/// Begin a pairing attempt: issue a challenge with a fresh confirm code. The
/// PSK proof material is generated and held here; only the opaque challenge
/// crosses the boundary. Until the crypto wiring lands, this returns a
/// fail-closed placeholder so callers never observe a half-built pairing.
#[tauri::command]
pub fn remote_pairing_start(
    state: State<'_, RemoteTrustState>,
    _request: Option<RemotePairingStartRequest>,
) -> Result<RemotePairingStartResult, String> {
    // The transport + PSK generation is the next layer. Fail closed rather than
    // mint a real pairing that the skeleton cannot yet secure.
    let guard = state
        .0
        .lock()
        .map_err(|_| "Remote control status is unavailable.".to_string())?;
    Ok(RemotePairingStartResult {
        ok: false,
        challenge: None,
        status: status_snapshot(&guard),
        code: Some("transport-unavailable".to_string()),
        message: Some(unavailable_message()),
    })
}

#[tauri::command]
pub fn remote_pairing_status(
    _state: State<'_, RemoteTrustState>,
    _request: RemotePairingStatusRequest,
) -> Result<RemotePairingStatusResult, String> {
    Ok(RemotePairingStatusResult {
        ok: false,
        status: "unavailable".to_string(),
        claimed: false,
        code: Some("transport-unavailable".to_string()),
        message: unavailable_message(),
    })
}

/// Revoke a paired device: remove it from the trust list (or mark it revoked),
/// rekey, and tear down any session. Subsequent frames from that device are
/// rejected by the transport. Fail closed when the device id is unknown.
#[tauri::command]
pub fn remote_revoke_device(
    state: State<'_, RemoteTrustState>,
    device_id: String,
) -> Result<RemoteDevice, String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "Remote trust list is unavailable.".to_string())?;
    let device = guard
        .devices
        .iter_mut()
        .find(|device| device.id == device_id)
        .ok_or_else(|| "Device is not in the remote trust list.".to_string())?;
    device.trust_state = RemoteDeviceTrustState::Revoked;
    device.revoked_at = Some(now_iso());
    Ok(device.clone())
}

/// Handle an inbound remote command envelope: validate it against the trust
/// list + a live session, then delegate to the existing approvals/scheduler
/// modules. Returns a typed `RemoteCommandResult`. Until the transport layer
/// binds sessions to devices, this fails closed for every envelope — a session
/// must exist and be live, which only the (deferred) transport can establish.
#[tauri::command]
pub fn remote_handle_command(
    _app: AppHandle,
    _envelope: serde_json::Value,
) -> Result<RemoteCommandResult, String> {
    // The pure session/authorization logic lives in @fable/connectors
    // (mobile-remote). The transport layer will deserialize the envelope,
    // resolve the bound session, run `authorizeCommand`, and — only on ok —
    // dispatch via the existing approvals/scheduler modules. Without a live
    // session (which only the transport establishes), every command fails
    // closed by construction.
    Ok(RemoteCommandResult {
        ok: false,
        applied_at: None,
        code: Some(RemoteErrorCode::TransportUnavailable),
        message: Some(unavailable_message()),
    })
}

/// Current ISO timestamp. Centralized so the skeleton stays deterministic-ish
/// and the future transport reuses it.
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(id: &str, trust_state: RemoteDeviceTrustState) -> RemoteDevice {
        RemoteDevice {
            id: id.to_string(),
            label: id.to_string(),
            trust_state,
            first_paired_at: "2026-01-01T00:00:00Z".to_string(),
            last_seen_at: "2026-01-01T00:00:00Z".to_string(),
            revoked_at: None,
        }
    }

    #[test]
    fn status_is_disabled_by_default_and_secret_free() {
        let status = status_snapshot(&RemoteControlStore::default());

        assert_eq!(status.status, "disabled");
        assert!(!status.requested_enabled);
        assert!(!status.enabled);
        assert_eq!(status.transport, "lan-local");
        assert!(!status.transport_ready);
        assert!(!status.pairing_ready);
    }

    #[test]
    fn requested_status_stays_unavailable_without_transport() {
        let store = RemoteControlStore {
            devices: vec![
                device("trusted", RemoteDeviceTrustState::Trusted),
                device("revoked", RemoteDeviceTrustState::Revoked),
            ],
            requested_enabled: true,
        };
        let status = status_snapshot(&store);

        assert_eq!(status.status, "unavailable");
        assert!(status.requested_enabled);
        assert!(!status.enabled);
        assert_eq!(status.trusted_device_count, 1);
        assert_eq!(status.revoked_device_count, 1);
    }

    #[test]
    fn unavailable_command_result_fails_closed() {
        let result = RemoteCommandResult {
            ok: false,
            applied_at: None,
            code: Some(RemoteErrorCode::TransportUnavailable),
            message: Some(unavailable_message()),
        };

        assert!(!result.ok);
        assert!(matches!(
            result.code,
            Some(RemoteErrorCode::TransportUnavailable)
        ));
    }

    #[test]
    fn status_snapshot_contains_no_secrets() {
        let store = RemoteControlStore {
            devices: vec![device("device-1", RemoteDeviceTrustState::Trusted)],
            requested_enabled: true,
        };
        let status = status_snapshot(&store);

        // Verify that string fields in the status snapshot are clean metadata only
        // and do not contain secret-shaped patterns like keys or tokens.
        assert!(!status.server_name.contains("bearer"));
        assert!(!status.server_name.contains("token"));
        assert!(!status.message.contains("bearer"));
        assert!(!status.message.contains("token"));
        assert!(!status.message.contains("key"));
        assert_eq!(status.transport, "lan-local");
    }
}
