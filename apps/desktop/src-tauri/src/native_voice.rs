//! Ephemeral, bounded voice-call authority. Speech processing cannot grant tools.
//! Credentials and HTTP egress stay native; audio never enters the store/logs.
use crate::authorized_scope::ScopeAccess;
use base64::Engine as _;
use chrono::{DateTime, TimeDelta, Utc};
use futures_util::StreamExt;
use reqwest::multipart::{Form, Part};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    sync::{Mutex, OnceLock},
    time::Duration,
};

const MAX_AUDIO_BYTES: usize = 24_000 * 2 * 60 + 44;
const MAX_CALL_AUDIO_BYTES: usize = 24_000 * 2 * 600;
const MAX_CALL_TEXT: usize = 24_000;
const MAX_REQUESTS: usize = 512;
const LEASE_SECONDS: i64 = 45;
const CALL_SECONDS: i64 = 30 * 60;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VoiceScope {
    workspace_id: String,
    agent_id: String,
    thread_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VoiceSession {
    session_id: String,
    workspace_id: String,
    agent_id: String,
    thread_id: String,
    expires_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InterruptRequest {
    session: VoiceSession,
    generation: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranscribeRequest {
    session: VoiceSession,
    generation: u64,
    request_id: String,
    audio_base64: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpeakRequest {
    session: VoiceSession,
    generation: u64,
    request_id: String,
    text: String,
    voice: String,
}

#[derive(Serialize)]
pub struct Transcript {
    transcript: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechAudio {
    audio_base64: String,
}

struct Call {
    session: VoiceSession,
    owner: String,
    expires: DateTime<Utc>,
    heartbeat: DateTime<Utc>,
    generation: u64,
    requests: HashSet<String>,
    audio_bytes: usize,
    text_chars: usize,
    inflight: usize,
}
static CALL: OnceLock<Mutex<Option<Call>>> = OnceLock::new();
fn state() -> &'static Mutex<Option<Call>> {
    CALL.get_or_init(|| Mutex::new(None))
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}
fn owner(window: &tauri::WebviewWindow, workspace: &str) -> Result<String, String> {
    if window.label() != "main" {
        return Err("Voice is only available in the main Mivlet window.".into());
    }
    let scope =
        crate::authorized_scope::command_scope(Some(workspace.into()), None, ScopeAccess::Write)?;
    if scope.data.workspace_id() != workspace {
        return Err("The voice workspace changed.".into());
    }
    Ok(scope.internal_user_id)
}
fn current<'a>(
    call: &'a mut Option<Call>,
    session: &VoiceSession,
    owner: &str,
    now: DateTime<Utc>,
) -> Result<&'a mut Call, String> {
    let call = call.as_mut().ok_or("This voice conversation has ended.")?;
    if call.session != *session || call.owner != owner {
        return Err("The voice conversation changed. Reconnect to continue.".into());
    }
    if call.expires <= now || call.heartbeat + TimeDelta::seconds(LEASE_SECONDS) <= now {
        return Err("This voice conversation expired. Reconnect to continue.".into());
    }
    Ok(call)
}
fn reserve(
    call: &mut Call,
    generation: u64,
    id: &str,
    audio_bytes: usize,
    text_chars: usize,
) -> Result<(), String> {
    if generation != call.generation {
        return Err("This voice turn was interrupted.".into());
    }
    if !valid_id(id) || call.requests.contains(id) {
        return Err("This speech request is invalid or was already used.".into());
    }
    if call.requests.len() >= MAX_REQUESTS
        || call.audio_bytes.saturating_add(audio_bytes) > MAX_CALL_AUDIO_BYTES
        || call.text_chars.saturating_add(text_chars) > MAX_CALL_TEXT
    {
        return Err(
            "This call reached its speech limit. End voice and start a new call to continue."
                .into(),
        );
    }
    if call.inflight >= 3 {
        return Err("Speech processing is busy. Please try again.".into());
    }
    // Consume the exact request before egress, including failed requests. No replay.
    call.requests.insert(id.into());
    call.audio_bytes += audio_bytes;
    call.text_chars += text_chars;
    call.inflight += 1;
    Ok(())
}
struct RequestGuard {
    session_id: String,
}
impl Drop for RequestGuard {
    fn drop(&mut self) {
        if let Ok(mut guard) = state().lock() {
            if let Some(call) = guard
                .as_mut()
                .filter(|call| call.session.session_id == self.session_id)
            {
                call.inflight = call.inflight.saturating_sub(1);
            }
        }
    }
}
fn begin_request(
    session: &VoiceSession,
    owner: &str,
    generation: u64,
    request_id: &str,
    audio: usize,
    text: usize,
) -> Result<RequestGuard, String> {
    let mut guard = state().lock().map_err(|_| "Voice is unavailable.")?;
    let call = current(&mut guard, session, owner, Utc::now())?;
    reserve(call, generation, request_id, audio, text)?;
    Ok(RequestGuard {
        session_id: session.session_id.clone(),
    })
}
fn still_current(session: &VoiceSession, owner: &str, generation: u64) -> bool {
    let scope_current = crate::authorized_scope::command_scope(
        Some(session.workspace_id.clone()),
        None,
        ScopeAccess::Write,
    )
    .is_ok_and(|scope| scope.internal_user_id == owner);
    scope_current
        && state().lock().is_ok_and(|mut guard| {
            current(&mut guard, session, owner, Utc::now())
                .is_ok_and(|call| call.generation == generation)
        })
}
async fn revoked(session: &VoiceSession, owner: &str, generation: u64) {
    loop {
        if !still_current(session, owner, generation) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
fn credential() -> Result<String, String> {
    crate::backends::read_credential("openai")?.ok_or_else(|| "Connect OpenAI API in Providers to use voice conversations. Your ChatGPT subscription does not include API speech.".into())
}
fn client() -> Result<reqwest::Client, String> {
    crate::ensure_rustls_provider();
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|_| "Mivlet could not prepare speech processing.".into())
}
async fn body(response: reqwest::Response, max: usize) -> Result<Vec<u8>, String> {
    if !response.status().is_success() {
        return Err(match response.status().as_u16() {
            401 | 403 => "OpenAI rejected the API connection. Check it in Providers.",
            429 => "OpenAI speech is rate limited or out of credit. Check your API billing and try again.",
            _ => "OpenAI speech processing failed. Your conversation is still available.",
        }.into());
    }
    if response
        .content_length()
        .is_some_and(|size| size > max as u64)
    {
        return Err("The speech response was too large.".into());
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "The speech connection was interrupted.")?;
        if bytes.len().saturating_add(chunk.len()) > max {
            return Err("The speech response was too large.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
fn validate_wav(bytes: &[u8]) -> bool {
    bytes.len() >= 44
        && bytes.len() <= MAX_AUDIO_BYTES
        && bytes.len().is_multiple_of(2)
        && &bytes[..4] == b"RIFF"
        && &bytes[8..16] == b"WAVEfmt "
        && bytes[16..24] == [16, 0, 0, 0, 1, 0, 1, 0]
        && bytes[24..28] == 24_000u32.to_le_bytes()
        && bytes[28..32] == 48_000u32.to_le_bytes()
        && bytes[32..36] == [2, 0, 16, 0]
        && &bytes[36..40] == b"data"
        && bytes[4..8] == ((bytes.len() - 8) as u32).to_le_bytes()
        && bytes[40..44] == ((bytes.len() - 44) as u32).to_le_bytes()
}

#[tauri::command]
pub fn native_voice_start(
    window: tauri::WebviewWindow,
    request: VoiceScope,
) -> Result<VoiceSession, String> {
    let owner = owner(&window, &request.workspace_id)?;
    if !valid_id(&request.agent_id) || !valid_id(&request.thread_id) {
        return Err("Choose an agent conversation before starting voice.".into());
    }
    let _credential = credential()?;
    let mut token = [0u8; 32];
    getrandom::fill(&mut token).map_err(|_| "Voice could not start.")?;
    let now = Utc::now();
    let expires = now + TimeDelta::seconds(CALL_SECONDS);
    let session = VoiceSession {
        session_id: hex::encode(token),
        workspace_id: request.workspace_id,
        agent_id: request.agent_id,
        thread_id: request.thread_id,
        expires_at: expires.to_rfc3339(),
    };
    *state().lock().map_err(|_| "Voice is unavailable.")? = Some(Call {
        session: session.clone(),
        owner,
        expires,
        heartbeat: now,
        generation: 0,
        requests: HashSet::new(),
        audio_bytes: 0,
        text_chars: 0,
        inflight: 0,
    });
    Ok(session)
}
#[tauri::command]
pub fn native_voice_heartbeat(
    window: tauri::WebviewWindow,
    request: VoiceSession,
) -> Result<(), String> {
    let owner = owner(&window, &request.workspace_id)?;
    let mut guard = state().lock().map_err(|_| "Voice is unavailable.")?;
    current(&mut guard, &request, &owner, Utc::now())?.heartbeat = Utc::now();
    Ok(())
}
#[tauri::command]
pub fn native_voice_interrupt(
    window: tauri::WebviewWindow,
    request: InterruptRequest,
) -> Result<(), String> {
    let owner = owner(&window, &request.session.workspace_id)?;
    let mut guard = state().lock().map_err(|_| "Voice is unavailable.")?;
    let call = current(&mut guard, &request.session, &owner, Utc::now())?;
    if request.generation <= call.generation {
        return Err("This voice interruption is stale.".into());
    }
    call.generation = request.generation;
    Ok(())
}
#[tauri::command]
pub fn native_voice_end(window: tauri::WebviewWindow, request: VoiceSession) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Voice is only available in the main Mivlet window.".into());
    }
    let mut guard = state().lock().map_err(|_| "Voice is unavailable.")?;
    if guard.as_ref().is_some_and(|call| call.session == request) {
        *guard = None;
    }
    Ok(())
}
#[tauri::command]
pub async fn native_voice_transcribe(
    window: tauri::WebviewWindow,
    request: TranscribeRequest,
) -> Result<Transcript, String> {
    let owner = owner(&window, &request.session.workspace_id)?;
    if request.audio_base64.len() > MAX_AUDIO_BYTES.div_ceil(3) * 4 {
        return Err("A voice turn must be under one minute.".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&request.audio_base64)
        .map_err(|_| "The recording data is invalid.")?;
    if !validate_wav(&bytes) {
        return Err("The voice recording must be mono 24 kHz PCM WAV under one minute.".into());
    }
    let _guard = begin_request(
        &request.session,
        &owner,
        request.generation,
        &request.request_id,
        bytes.len(),
        0,
    )?;
    let key = credential()?;
    let client = client()?;
    let operation = async {
        if !still_current(&request.session, &owner, request.generation) {
            return Err("This voice turn was interrupted.".into());
        }
        let part = Part::bytes(bytes)
            .file_name("voice.wav")
            .mime_str("audio/wav")
            .map_err(|_| "The recording type is invalid.")?;
        let response = client
            .post("https://api.openai.com/v1/audio/transcriptions")
            .bearer_auth(key)
            .multipart(
                Form::new()
                    .text("model", "gpt-4o-mini-transcribe")
                    .part("file", part),
            )
            .send()
            .await
            .map_err(|_| "OpenAI transcription could not be reached.")?;
        let bytes = body(response, 64 * 1024).await?;
        #[derive(Deserialize)]
        struct ResultBody {
            text: String,
        }
        let parsed: ResultBody =
            serde_json::from_slice(&bytes).map_err(|_| "OpenAI returned an invalid transcript.")?;
        if !still_current(&request.session, &owner, request.generation) {
            return Err("This voice turn was interrupted.".into());
        }
        Ok(Transcript {
            transcript: parsed.text.trim().to_string(),
        })
    };
    tokio::select! { biased;
        _ = revoked(&request.session, &owner, request.generation) => Err("This voice turn ended or was interrupted.".into()),
        result = operation => result,
    }
}
#[tauri::command]
pub async fn native_voice_speak(
    window: tauri::WebviewWindow,
    request: SpeakRequest,
) -> Result<SpeechAudio, String> {
    let owner = owner(&window, &request.session.workspace_id)?;
    if !matches!(request.voice.as_str(), "marin" | "cedar" | "coral" | "sage") {
        return Err("Choose an available voice.".into());
    }
    let len = request.text.chars().count();
    if len == 0 || len > 1200 {
        return Err("The spoken reply segment is too long or empty.".into());
    }
    let _guard = begin_request(
        &request.session,
        &owner,
        request.generation,
        &request.request_id,
        0,
        len,
    )?;
    let key = credential()?;
    let client = client()?;
    let operation = async {
        if !still_current(&request.session, &owner, request.generation) {
            return Err("This voice turn was interrupted.".into());
        }
        let response = client.post("https://api.openai.com/v1/audio/speech").bearer_auth(key)
            .json(&serde_json::json!({ "model": "gpt-4o-mini-tts", "voice": request.voice, "input": request.text, "response_format": "wav", "instructions": "Speak naturally and conversationally, with a warm, calm tone and a clear, unhurried pace. Read the supplied words exactly; do not add any words." }))
            .send().await.map_err(|_| "OpenAI speech could not be reached.")?;
        let bytes = body(response, 8 * 1024 * 1024).await?;
        if bytes.len() < 44 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
            return Err("OpenAI returned invalid speech audio.".into());
        }
        if !still_current(&request.session, &owner, request.generation) {
            return Err("This voice turn was interrupted.".into());
        }
        Ok(SpeechAudio {
            audio_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        })
    };
    tokio::select! { biased;
        _ = revoked(&request.session, &owner, request.generation) => Err("This voice turn ended or was interrupted.".into()),
        result = operation => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn call() -> Call {
        let now = Utc::now();
        Call {
            session: VoiceSession {
                session_id: "session".into(),
                workspace_id: "workspace".into(),
                agent_id: "agent".into(),
                thread_id: "thread".into(),
                expires_at: "expiry".into(),
            },
            owner: "owner".into(),
            expires: now + TimeDelta::seconds(CALL_SECONDS),
            heartbeat: now,
            generation: 1,
            requests: HashSet::new(),
            audio_bytes: 0,
            text_chars: 0,
            inflight: 0,
        }
    }
    #[test]
    fn voice_authority_binds_owner_exact_scope_lease_and_expiry() {
        let c = call();
        let s = c.session.clone();
        let mut state = Some(c);
        assert!(current(&mut state, &s, "owner", Utc::now()).is_ok());
        assert!(current(&mut state, &s, "another-owner", Utc::now()).is_err());
        let mut other = s.clone();
        other.agent_id = "another-agent".into();
        assert!(current(&mut state, &other, "owner", Utc::now()).is_err());
        other = s.clone();
        other.thread_id = "another-thread".into();
        assert!(current(&mut state, &other, "owner", Utc::now()).is_err());
        assert!(current(&mut state, &s, "owner", Utc::now() + TimeDelta::seconds(46)).is_err());
        state.as_mut().unwrap().heartbeat = Utc::now() + TimeDelta::seconds(CALL_SECONDS);
        assert!(current(
            &mut state,
            &s,
            "owner",
            Utc::now() + TimeDelta::seconds(CALL_SECONDS + 1)
        )
        .is_err());
    }
    #[test]
    fn voice_requests_are_single_use_generation_fenced_and_bounded() {
        let mut c = call();
        assert!(reserve(&mut c, 0, "old-turn", 0, 10).is_err());
        assert!(reserve(&mut c, 1, "one", 1000, 20).is_ok());
        assert!(reserve(&mut c, 1, "one", 1000, 20).is_err());
        c.generation = 2;
        assert!(reserve(&mut c, 1, "two", 1000, 20).is_err());
        assert!(reserve(&mut c, 2, "two", MAX_CALL_AUDIO_BYTES, 0).is_err());
        assert!(reserve(&mut c, 2, "two", 0, MAX_CALL_TEXT).is_err());
        c.inflight = 3;
        assert!(reserve(&mut c, 2, "two", 0, 1).is_err());
        assert_eq!(c.requests.len(), 1);
    }
    #[test]
    fn voice_audio_requires_exact_pcm_header_and_lengths() {
        let mut wav = vec![0u8; 48];
        wav[..4].copy_from_slice(b"RIFF");
        wav[4..8].copy_from_slice(&40u32.to_le_bytes());
        wav[8..16].copy_from_slice(b"WAVEfmt ");
        wav[16..24].copy_from_slice(&[16, 0, 0, 0, 1, 0, 1, 0]);
        wav[24..28].copy_from_slice(&24_000u32.to_le_bytes());
        wav[28..32].copy_from_slice(&48_000u32.to_le_bytes());
        wav[32..36].copy_from_slice(&[2, 0, 16, 0]);
        wav[36..40].copy_from_slice(b"data");
        wav[40..44].copy_from_slice(&4u32.to_le_bytes());
        assert!(validate_wav(&wav));
        wav[22] = 2;
        assert!(!validate_wav(&wav));
        wav[22] = 1;
        wav[40] = 6;
        assert!(!validate_wav(&wav));
        assert!(!validate_wav(b"RIFF"));
    }
}
