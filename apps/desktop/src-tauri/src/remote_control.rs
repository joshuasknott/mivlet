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
//!   - Real PSK / long-lived device-key crypto. `RemotePairingChallenge` and
//!     `RemotePairingProof` carry opaque tokens; verification wiring lands with
//!     the transport. Until then pairing commands fail closed.
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

/// Mobile response to a pairing challenge. `proof_token` is PSK-derived
/// material this boundary verifies; opaque to JavaScript and NOT the PSK.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePairingProof {
    pub challenge_nonce: String,
    pub confirm_code: String,
    pub proof_token: String,
}

/// Outcome of a pairing attempt.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
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
    SessionExpired,
    ApprovalNotFound,
    ApprovalAlreadyResolved,
    ScheduleNotFound,
    InvalidCommand,
    ProtocolVersionUnsupported,
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

/// In-process trust list. Held as Tauri state. The real store (encrypted
/// SQLite, like the rest of the durable non-secret metadata) lands with the
/// transport layer; this skeleton keeps an in-memory list so the command
/// surface compiles and is testable.
#[derive(Default)]
pub struct RemoteTrustState(pub Mutex<Vec<RemoteDevice>>);

/// Initialize the remote-control trust state. Called once from `setup`.
pub fn initialize_state() -> RemoteTrustState {
    RemoteTrustState::default()
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
    Ok(guard.clone())
}

/// Begin a pairing attempt: issue a challenge with a fresh confirm code. The
/// PSK proof material is generated and held here; only the opaque challenge
/// crosses the boundary. Until the crypto wiring lands, this returns a
/// fail-closed placeholder so callers never observe a half-built pairing.
#[tauri::command]
pub fn remote_pairing_start() -> Result<RemotePairingResult, String> {
    // The transport + PSK generation is the next layer. Fail closed rather than
    // mint a real pairing that the skeleton cannot yet secure.
    Ok(RemotePairingResult {
        ok: false,
        device: None,
        code: Some("unauthorized".to_string()),
        message: Some("Remote pairing transport is not yet available on this build.".to_string()),
    })
}

/// Complete a pairing attempt by verifying the proof. Fail closed until the
/// PSK verification + long-lived device-key rotation wiring lands.
#[tauri::command]
pub fn remote_pairing_complete(_proof: RemotePairingProof) -> Result<RemotePairingResult, String> {
    Ok(RemotePairingResult {
        ok: false,
        device: None,
        code: Some("unauthorized".to_string()),
        message: Some("Remote pairing transport is not yet available on this build.".to_string()),
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
        code: Some(RemoteErrorCode::SessionExpired),
        message: Some("No live remote session is available on this build.".to_string()),
    })
}

/// Current ISO timestamp. Centralized so the skeleton stays deterministic-ish
/// and the future transport reuses it.
fn now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Minimal ISO-8601 placeholder; chrono replaces this when wired in.
    format!("unix:{secs}")
}
