//! One-use native boundary for reviewed OpenAI file transcription.
//!
//! Raw recordings exist only in renderer memory, this process-scoped staging
//! map, or the in-flight HTTPS body. They never enter Mivlet storage or logs.

use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    thread,
    time::Duration,
};

use base64::Engine as _;
use chrono::{DateTime, TimeDelta, Utc};
use futures_util::StreamExt;
use reqwest::multipart::{Form, Part};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::oneshot;

use crate::authorized_scope::ScopeAccess;

const MODEL: &str = "gpt-4o-mini-transcribe";
const OPENAI_TRANSCRIPTIONS_URL: &str = "https://api.openai.com/v1/audio/transcriptions";
const MAX_RECORDING_BYTES: usize = 16 * 1024 * 1024;
const MAX_RECORDING_DURATION_MS: u64 = 120_000;
const TOKEN_TTL_SECONDS: i64 = 120;
const REQUEST_TIMEOUT_SECONDS: u64 = 60;
const MAX_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_STAGED_RECORDINGS: usize = 4;
const MAX_INFLIGHT_RECORDINGS: usize = 2;
const MAX_RESIDENT_AUDIO_BYTES: usize = 32 * 1024 * 1024;
const AUTHORITY_POLL_MILLISECONDS: u64 = 250;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrepareRecordingRequest {
    workspace_id: String,
    recording_id: String,
    mime_type: String,
    duration_ms: u64,
    audio_base64: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StagedRecordingReceipt {
    staged_recording_token: String,
    workspace_id: String,
    recording_id: String,
    bytes_digest: String,
    model: String,
    expires_at: String,
    media_type: String,
    size_bytes: usize,
    duration_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancelRecordingRequest {
    workspace_id: String,
    recording_id: String,
    staged_recording_token: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionResponse {
    transcript: String,
}

struct StagedRecording {
    receipt: StagedRecordingReceipt,
    expires_at: DateTime<Utc>,
    bytes: Vec<u8>,
    owner_id: String,
}

impl Drop for StagedRecording {
    fn drop(&mut self) {
        self.bytes.fill(0);
    }
}

#[derive(Default)]
struct SpeechState {
    staged: HashMap<String, StagedRecording>,
    inflight: HashMap<String, InflightRecording>,
}

struct InflightRecording {
    cancel: oneshot::Sender<()>,
    token: String,
    owner_id: String,
    size_bytes: usize,
}

static STATE: OnceLock<Mutex<SpeechState>> = OnceLock::new();
static EXPIRY_SWEEPER: OnceLock<()> = OnceLock::new();
fn state() -> &'static Mutex<SpeechState> {
    STATE.get_or_init(|| Mutex::new(SpeechState::default()))
}

fn ensure_expiry_sweeper() {
    EXPIRY_SWEEPER.get_or_init(|| {
        thread::spawn(|| loop {
            thread::sleep(Duration::from_secs(1));
            if let Ok(mut guard) = state().lock() {
                cleanup_expired(&mut guard, Utc::now());
            }
        });
    });
}
fn run_key(workspace_id: &str, recording_id: &str) -> String {
    format!("{workspace_id}\0{recording_id}")
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn normalized_media_type(value: &str) -> Option<(&'static str, &'static str)> {
    match value
        .split(';')
        .next()?
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "audio/webm" => Some(("audio/webm", "webm")),
        "audio/wav" | "audio/wave" | "audio/x-wav" => Some(("audio/wav", "wav")),
        "audio/ogg" => Some(("audio/ogg", "ogg")),
        "audio/mpeg" | "audio/mp3" => Some(("audio/mpeg", "mp3")),
        "audio/mp4" | "audio/x-m4a" => Some(("audio/mp4", "m4a")),
        _ => None,
    }
}

fn magic_matches(media_type: &str, bytes: &[u8]) -> bool {
    match media_type {
        "audio/webm" => bytes.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]),
        "audio/wav" => bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WAVE",
        "audio/ogg" => bytes.starts_with(b"OggS"),
        "audio/mpeg" => {
            bytes.starts_with(b"ID3")
                || (bytes.len() >= 2 && bytes[0] == 0xff && bytes[1] & 0xe0 == 0xe0)
        }
        "audio/mp4" => bytes.len() >= 12 && &bytes[4..8] == b"ftyp",
        _ => false,
    }
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|_| "Mivlet could not authorize this recording.".to_string())?;
    Ok(hex::encode(bytes))
}

fn cleanup_expired(state: &mut SpeechState, now: DateTime<Utc>) {
    state
        .staged
        .retain(|_, recording| recording.expires_at > now);
}

fn authority_is_current(workspace_id: &str, owner_id: &str) -> bool {
    crate::authorized_scope::command_scope(Some(workspace_id.to_string()), None, ScopeAccess::Write)
        .is_ok_and(|scope| {
            scope.data.workspace_id() == workspace_id && scope.internal_user_id == owner_id
        })
}

fn insert_inflight(
    state: &mut SpeechState,
    key: String,
    inflight: InflightRecording,
) -> Result<(), String> {
    if state.inflight.len() >= MAX_INFLIGHT_RECORDINGS {
        return Err("Too many recordings are being transcribed. Try again shortly.".into());
    }
    let staged_collision = state.staged.values().any(|item| {
        run_key(&item.receipt.workspace_id, &item.receipt.recording_id).as_str() == key.as_str()
    });
    if staged_collision || state.inflight.contains_key(&key) {
        return Err("This recording is already staged or being transcribed.".into());
    }
    let resident_bytes = state
        .staged
        .values()
        .map(|item| item.bytes.len())
        .sum::<usize>()
        + state
            .inflight
            .values()
            .map(|item| item.size_bytes)
            .sum::<usize>();
    if resident_bytes.saturating_add(inflight.size_bytes) > MAX_RESIDENT_AUDIO_BYTES {
        return Err("Too much recording audio is already waiting. Try again shortly.".into());
    }
    state.inflight.insert(key, inflight);
    Ok(())
}

fn remove_inflight_if_token(state: &mut SpeechState, key: &str, token: &str) {
    let matches = state
        .inflight
        .get(key)
        .is_some_and(|item| item.token == token);
    if matches {
        state.inflight.remove(key);
    }
}

struct InflightGuard {
    key: String,
    token: String,
}

impl Drop for InflightGuard {
    fn drop(&mut self) {
        if let Ok(mut guard) = state().lock() {
            remove_inflight_if_token(&mut guard, &self.key, &self.token);
        }
    }
}

fn prepare_into(
    state: &mut SpeechState,
    request: PrepareRecordingRequest,
    now: DateTime<Utc>,
    owner_id: &str,
) -> Result<StagedRecordingReceipt, String> {
    if !valid_id(&request.workspace_id) || !valid_id(&request.recording_id) {
        return Err("The recording scope is invalid.".into());
    }
    if request.duration_ms == 0 || request.duration_ms > MAX_RECORDING_DURATION_MS {
        return Err("Recordings must be no longer than two minutes.".into());
    }
    if request.audio_base64.len() > MAX_RECORDING_BYTES.div_ceil(3) * 4 + 8 {
        return Err("Recordings must be no larger than 16 MiB.".into());
    }
    let (media_type, _) = normalized_media_type(&request.mime_type)
        .ok_or_else(|| "Use a WAV, WebM, Ogg, MP3, or M4A recording.".to_string())?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(request.audio_base64.as_bytes())
        .map_err(|_| "The recording data is invalid.".to_string())?;
    if bytes.is_empty() || bytes.len() > MAX_RECORDING_BYTES {
        return Err("Recordings must be between 1 byte and 16 MiB.".into());
    }
    if !magic_matches(media_type, &bytes) {
        return Err("The recording type does not match its audio data.".into());
    }
    cleanup_expired(state, now);
    let resident_bytes = state
        .staged
        .values()
        .map(|item| item.bytes.len())
        .sum::<usize>()
        + state
            .inflight
            .values()
            .map(|item| item.size_bytes)
            .sum::<usize>();
    if state.staged.len() >= MAX_STAGED_RECORDINGS
        || resident_bytes.saturating_add(bytes.len()) > MAX_RESIDENT_AUDIO_BYTES
    {
        return Err(
            "Too many recordings are waiting. Cancel an earlier recording and try again.".into(),
        );
    }
    let key = run_key(&request.workspace_id, &request.recording_id);
    if state
        .staged
        .values()
        .any(|item| run_key(&item.receipt.workspace_id, &item.receipt.recording_id) == key)
        || state.inflight.contains_key(&key)
    {
        return Err("This recording is already staged or being transcribed.".into());
    }
    let token = random_token()?;
    let expires_at = now + TimeDelta::seconds(TOKEN_TTL_SECONDS);
    let receipt = StagedRecordingReceipt {
        staged_recording_token: token.clone(),
        workspace_id: request.workspace_id,
        recording_id: request.recording_id,
        bytes_digest: hex::encode(Sha256::digest(&bytes)),
        model: MODEL.into(),
        expires_at: expires_at.to_rfc3339(),
        media_type: media_type.into(),
        size_bytes: bytes.len(),
        duration_ms: request.duration_ms,
    };
    state.staged.insert(
        token,
        StagedRecording {
            receipt: receipt.clone(),
            expires_at,
            bytes,
            owner_id: owner_id.to_string(),
        },
    );
    Ok(receipt)
}

fn take_exact(
    state: &mut SpeechState,
    request: &StagedRecordingReceipt,
    now: DateTime<Utc>,
    owner_id: &str,
) -> Result<StagedRecording, String> {
    cleanup_expired(state, now);
    let recording = state
        .staged
        .remove(&request.staged_recording_token)
        .ok_or_else(|| {
            "This recording authorization expired or was already used. Record it again.".to_string()
        })?;
    if recording.receipt != *request
        || recording.expires_at <= now
        || request.model != MODEL
        || recording.owner_id != owner_id
    {
        return Err("This recording authorization does not match the reviewed recording.".into());
    }
    Ok(recording)
}

#[tauri::command]
pub fn native_speech_prepare_recording(
    window: tauri::WebviewWindow,
    request: PrepareRecordingRequest,
) -> Result<StagedRecordingReceipt, String> {
    require_main_window(&window)?;
    let scope = crate::authorized_scope::command_scope(
        Some(request.workspace_id.clone()),
        None,
        ScopeAccess::Write,
    )?;
    if scope.data.workspace_id() != request.workspace_id {
        return Err("The recording workspace is no longer active.".into());
    }
    let mut guard = state()
        .lock()
        .map_err(|_| "Mivlet could not stage the recording.".to_string())?;
    let receipt = prepare_into(&mut guard, request, Utc::now(), &scope.internal_user_id)?;
    ensure_expiry_sweeper();
    Ok(receipt)
}

#[tauri::command]
pub fn native_speech_cancel_recording(
    window: tauri::WebviewWindow,
    request: CancelRecordingRequest,
) -> Result<(), String> {
    require_main_window(&window)?;
    let scope = crate::authorized_scope::active_command_scope(ScopeAccess::Write)?;
    let mut guard = state()
        .lock()
        .map_err(|_| "Mivlet could not cancel the recording.".to_string())?;
    cancel_into(&mut guard, &request, &scope.internal_user_id);
    Ok(())
}

fn cancel_into(state: &mut SpeechState, request: &CancelRecordingRequest, owner_id: &str) {
    state.staged.retain(|_, item| {
        !(item.receipt.workspace_id == request.workspace_id
            && item.receipt.recording_id == request.recording_id
            && item.receipt.staged_recording_token == request.staged_recording_token
            && item.owner_id == owner_id)
    });
    let key = run_key(&request.workspace_id, &request.recording_id);
    let matches = state.inflight.get(&key).is_some_and(|item| {
        item.token == request.staged_recording_token && item.owner_id == owner_id
    });
    if matches {
        if let Some(inflight) = state.inflight.remove(&key) {
            let _ = inflight.cancel.send(());
        }
    }
}

#[tauri::command]
pub async fn native_speech_transcribe_recording(
    window: tauri::WebviewWindow,
    request: StagedRecordingReceipt,
) -> Result<TranscriptionResponse, String> {
    require_main_window(&window)?;
    let scope = crate::authorized_scope::command_scope(
        Some(request.workspace_id.clone()),
        None,
        ScopeAccess::Write,
    )?;
    if scope.data.workspace_id() != request.workspace_id {
        return Err("The recording workspace is no longer active.".into());
    }
    let mut recording = {
        let mut guard = state()
            .lock()
            .map_err(|_| "Mivlet could not access the staged recording.".to_string())?;
        take_exact(&mut guard, &request, Utc::now(), &scope.internal_user_id)?
    };
    let (_, extension) = normalized_media_type(&recording.receipt.media_type)
        .ok_or_else(|| "The staged recording type is invalid.".to_string())?;
    let key = run_key(&request.workspace_id, &request.recording_id);
    let (cancel_tx, cancel_rx) = oneshot::channel();
    {
        let mut guard = state()
            .lock()
            .map_err(|_| "Mivlet could not start transcription.".to_string())?;
        insert_inflight(
            &mut guard,
            key.clone(),
            InflightRecording {
                cancel: cancel_tx,
                token: request.staged_recording_token.clone(),
                owner_id: scope.internal_user_id.clone(),
                size_bytes: recording.receipt.size_bytes,
            },
        )?;
    }
    let _inflight_guard = InflightGuard {
        key,
        token: request.staged_recording_token.clone(),
    };
    let credential = crate::backends::read_credential("openai")?.ok_or_else(|| {
        "Connect a direct OpenAI API key before using OpenAI transcription.".to_string()
    })?;
    if !authority_is_current(&request.workspace_id, &scope.internal_user_id) {
        return Err("The recording workspace or private owner is no longer active.".into());
    }
    crate::ensure_rustls_provider();
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECONDS))
        .build()
        .map_err(|_| "Mivlet could not prepare OpenAI transcription.".to_string())?;
    let raw_audio = std::mem::take(&mut recording.bytes);
    let part = Part::bytes(raw_audio)
        .file_name(format!("recording.{extension}"))
        .mime_str(&recording.receipt.media_type)
        .map_err(|_| "The staged recording type is invalid.".to_string())?;
    let workspace_id = request.workspace_id.clone();
    let owner_id = scope.internal_user_id.clone();
    let operation = async move {
        if !authority_is_current(&workspace_id, &owner_id) {
            return Err("The recording workspace or private owner is no longer active.".into());
        }
        let response = client
            .post(OPENAI_TRANSCRIPTIONS_URL)
            .bearer_auth(credential)
            .multipart(Form::new().text("model", MODEL).part("file", part))
            .send()
            .await
            .map_err(|_| {
                "OpenAI transcription could not be reached. The recording was discarded."
                    .to_string()
            })?;
        if !response.status().is_success() {
            let message = match response.status().as_u16() {
                401 | 403 => "OpenAI rejected the saved API credential.",
                413 => "OpenAI rejected the recording size.",
                429 => "OpenAI transcription is temporarily rate limited.",
                _ => "OpenAI transcription failed.",
            };
            return Err(format!("{message} The recording was discarded."));
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
        {
            return Err("OpenAI returned an oversized transcription response.".into());
        }
        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk
                .map_err(|_| "OpenAI returned an unreadable transcription response.".to_string())?;
            if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
                return Err("OpenAI returned an oversized transcription response.".into());
            }
            body.extend_from_slice(&chunk);
        }
        #[derive(Deserialize)]
        struct ApiResponse {
            text: String,
        }
        let parsed: ApiResponse = serde_json::from_slice(&body)
            .map_err(|_| "OpenAI returned an invalid transcription response.".to_string())?;
        if !authority_is_current(&workspace_id, &owner_id) {
            return Err("The recording workspace or private owner is no longer active.".into());
        }
        let transcript = parsed.text.trim();
        if transcript.is_empty() {
            Err("No speech was detected. Your typed prompt was left unchanged.".into())
        } else {
            Ok(TranscriptionResponse {
                transcript: transcript.to_string(),
            })
        }
    };
    let monitored_workspace_id = request.workspace_id.clone();
    let monitored_owner_id = scope.internal_user_id.clone();
    let authority_revoked = async move {
        let mut interval =
            tokio::time::interval(Duration::from_millis(AUTHORITY_POLL_MILLISECONDS));
        interval.tick().await;
        loop {
            interval.tick().await;
            if !authority_is_current(&monitored_workspace_id, &monitored_owner_id) {
                break;
            }
        }
    };
    tokio::select! {
        _ = cancel_rx => Err("Transcription was cancelled. The recording was discarded.".to_string()),
        _ = authority_revoked => Err("Transcription was cancelled because the recording scope changed.".to_string()),
        result = operation => result,
    }
}

fn require_main_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Speech commands are only available from the main Mivlet window.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn wav_request(content: Vec<u8>) -> PrepareRecordingRequest {
        PrepareRecordingRequest {
            workspace_id: "local-workspace".into(),
            recording_id: "recording-1".into(),
            mime_type: "audio/wav".into(),
            duration_ms: 1_000,
            audio_base64: base64::engine::general_purpose::STANDARD.encode(content),
        }
    }
    fn wav() -> Vec<u8> {
        let mut value = b"RIFF\x24\0\0\0WAVEfmt ".to_vec();
        value.extend([0u8; 28]);
        value
    }

    #[test]
    fn staged_recording_is_digest_bound_and_exactly_single_use() {
        let now = Utc::now();
        let mut state = SpeechState::default();
        let receipt = prepare_into(&mut state, wav_request(wav()), now, "owner-1").unwrap();
        assert_eq!(receipt.model, MODEL);
        assert_eq!(receipt.size_bytes, 44);
        let recording = take_exact(&mut state, &receipt, now, "owner-1").unwrap();
        assert_eq!(
            hex::encode(Sha256::digest(&recording.bytes)),
            receipt.bytes_digest
        );
        drop(recording);
        let repeated = take_exact(&mut state, &receipt, now, "owner-1");
        assert!(matches!(repeated, Err(ref error) if error.contains("already used")));
    }

    #[test]
    fn mismatched_receipt_consumes_and_rejects_the_staged_bytes() {
        let now = Utc::now();
        let mut state = SpeechState::default();
        let receipt = prepare_into(&mut state, wav_request(wav()), now, "owner-1").unwrap();
        let mut changed = receipt.clone();
        changed.recording_id = "recording-2".into();
        assert!(take_exact(&mut state, &changed, now, "owner-1").is_err());
        assert!(state.staged.is_empty());
    }

    #[test]
    fn mime_magic_size_duration_and_expiry_fail_closed() {
        let now = Utc::now();
        let mut state = SpeechState::default();
        let mut bad = wav_request(b"not audio".to_vec());
        assert!(prepare_into(&mut state, bad, now, "owner-1")
            .unwrap_err()
            .contains("does not match"));
        bad = wav_request(wav());
        bad.duration_ms = MAX_RECORDING_DURATION_MS + 1;
        assert!(prepare_into(&mut state, bad, now, "owner-1").is_err());
        let receipt = prepare_into(&mut state, wav_request(wav()), now, "owner-1").unwrap();
        assert!(take_exact(
            &mut state,
            &receipt,
            now + TimeDelta::seconds(TOKEN_TTL_SECONDS + 1),
            "owner-1"
        )
        .is_err());
        assert!(state.staged.is_empty());
    }

    #[test]
    fn cancellation_drains_staged_audio_and_signals_inflight_work() {
        let now = Utc::now();
        let mut state = SpeechState::default();
        let receipt = prepare_into(&mut state, wav_request(wav()), now, "owner-1").unwrap();
        let (cancel, mut cancelled) = oneshot::channel();
        state.inflight.insert(
            run_key("local-workspace", "recording-1"),
            InflightRecording {
                cancel,
                token: receipt.staged_recording_token.clone(),
                owner_id: "owner-1".into(),
                size_bytes: 44,
            },
        );
        cancel_into(
            &mut state,
            &CancelRecordingRequest {
                workspace_id: "local-workspace".into(),
                recording_id: "recording-1".into(),
                staged_recording_token: receipt.staged_recording_token,
            },
            "owner-1",
        );
        assert!(state.staged.is_empty());
        assert!(state.inflight.is_empty());
        assert!(cancelled.try_recv().is_ok());
    }

    #[test]
    fn cancellation_requires_the_exact_owner_and_token() {
        let mut state = SpeechState::default();
        let key = run_key("local-workspace", "recording-1");
        let (cancel, mut cancelled) = oneshot::channel();
        state.inflight.insert(
            key.clone(),
            InflightRecording {
                cancel,
                token: "token-1".into(),
                owner_id: "owner-1".into(),
                size_bytes: 44,
            },
        );
        let request = CancelRecordingRequest {
            workspace_id: "local-workspace".into(),
            recording_id: "recording-1".into(),
            staged_recording_token: "token-1".into(),
        };

        cancel_into(&mut state, &request, "owner-2");
        assert!(state.inflight.contains_key(&key));
        assert!(matches!(
            cancelled.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));

        cancel_into(&mut state, &request, "owner-1");
        assert!(!state.inflight.contains_key(&key));
        assert!(cancelled.try_recv().is_ok());
    }

    #[test]
    fn duplicate_inflight_keys_are_rejected_without_replacing_cancellation() {
        let mut state = SpeechState::default();
        let key = run_key("local-workspace", "recording-1");
        let (first_cancel, mut first_cancelled) = oneshot::channel();
        insert_inflight(
            &mut state,
            key.clone(),
            InflightRecording {
                cancel: first_cancel,
                token: "token-1".into(),
                owner_id: "owner-1".into(),
                size_bytes: 44,
            },
        )
        .unwrap();
        let (second_cancel, _second_cancelled) = oneshot::channel();
        assert!(insert_inflight(
            &mut state,
            key.clone(),
            InflightRecording {
                cancel: second_cancel,
                token: "token-2".into(),
                owner_id: "owner-1".into(),
                size_bytes: 44,
            },
        )
        .unwrap_err()
        .contains("already staged or being transcribed"));

        remove_inflight_if_token(&mut state, &key, "token-2");
        assert_eq!(state.inflight.get(&key).unwrap().token, "token-1");
        cancel_into(
            &mut state,
            &CancelRecordingRequest {
                workspace_id: "local-workspace".into(),
                recording_id: "recording-1".into(),
                staged_recording_token: "token-1".into(),
            },
            "owner-1",
        );
        assert!(first_cancelled.try_recv().is_ok());
    }

    #[test]
    fn staging_rejects_a_key_that_is_already_inflight() {
        let now = Utc::now();
        let mut state = SpeechState::default();
        let (cancel, _cancelled) = oneshot::channel();
        state.inflight.insert(
            run_key("local-workspace", "recording-1"),
            InflightRecording {
                cancel,
                token: "token-1".into(),
                owner_id: "owner-1".into(),
                size_bytes: 44,
            },
        );
        assert!(prepare_into(&mut state, wav_request(wav()), now, "owner-1")
            .unwrap_err()
            .contains("already staged or being transcribed"));
    }
}
