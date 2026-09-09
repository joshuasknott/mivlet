//! Bounded OpenAI image generation and editing behind Mivlet's native secret,
//! approval, computer-generation, and immutable artifact boundaries.

use base64::Engine as _;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::future::Future;
use std::sync::{atomic::Ordering, Arc};
use std::time::Duration;

use crate::local_computer::artifacts::{self, LocalComputerArtifact};
use crate::local_computer::LocalComputerState;

const PROVIDER_ID: &str = "openai";
const IMAGE_MODEL: &str = "gpt-image-2";
const GENERATION_ENDPOINT: &str = "https://api.openai.com/v1/images/generations";
const EDIT_ENDPOINT: &str = "https://api.openai.com/v1/images/edits";
const IMAGE_TIMEOUT_SECONDS: u64 = 180;
// Approval audit fields retain 240 characters. Keeping the normalized prompt
// at 220 makes the entire `prompt: ...` value visible and exactly bindable.
const MAX_PROMPT_CHARACTERS: usize = 220;
const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 24 * 1024 * 1024;
const MAX_DECODED_IMAGE_BYTES: usize = 16 * 1024 * 1024;
const SIZES: [&str; 3] = ["1024x1024", "1536x1024", "1024x1536"];
const QUALITIES: [&str; 3] = ["low", "medium", "high"];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaImageStatus {
    provider_id: &'static str,
    configured: bool,
    models: [&'static str; 1],
    sizes: [&'static str; 3],
    qualities: [&'static str; 3],
    output_mime_type: &'static str,
    generation_available: bool,
    editing_available: bool,
    message: &'static str,
}

/// Reports local prerequisites only. It deliberately does not spend, call the
/// provider, or claim that this installation has a live model entitlement.
#[tauri::command]
pub fn media_image_status(window: tauri::WebviewWindow) -> Result<MediaImageStatus, String> {
    if window.label() != "main" {
        return Err("Image status is only available from the main Mivlet window.".into());
    }
    let configured = matches!(crate::backends::read_credential(PROVIDER_ID), Ok(Some(_)));
    Ok(MediaImageStatus {
        provider_id: PROVIDER_ID,
        configured,
        models: [IMAGE_MODEL],
        sizes: SIZES,
        qualities: QUALITIES,
        output_mime_type: "image/png",
        generation_available: configured,
        editing_available: configured,
        message: if configured {
            "The direct OpenAI API connection is configured. Image model access is checked only when you approve a metered request."
        } else {
            "Connect a metered OpenAI API key before generating or editing images."
        },
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GenerateImageArguments {
    prompt: String,
    model: String,
    size: String,
    quality: String,
    title: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EditImageArguments {
    prompt: String,
    model: String,
    size: String,
    quality: String,
    title: String,
    source_artifact_id: String,
}

#[derive(Debug)]
struct ValidatedImageRequest {
    prompt: String,
    model: String,
    size: String,
    quality: String,
    title: String,
}

#[derive(Deserialize)]
struct ImageResponse {
    data: Vec<ImageResponseData>,
}

#[derive(Deserialize)]
struct ImageResponseData {
    b64_json: Option<String>,
}

fn validate_common(
    prompt: String,
    model: String,
    size: String,
    quality: String,
    title: String,
) -> Result<ValidatedImageRequest, String> {
    let prompt = crate::paths::normalize_spaces(&prompt);
    if prompt.is_empty() || prompt.chars().count() > MAX_PROMPT_CHARACTERS {
        return Err("Image prompts must contain 1 to 220 visible characters.".into());
    }
    if model != IMAGE_MODEL {
        return Err("Choose the documented gpt-image-2 image model explicitly.".into());
    }
    if !SIZES.contains(&size.as_str()) {
        return Err("Choose a supported image size.".into());
    }
    if !QUALITIES.contains(&quality.as_str()) {
        return Err("Choose low, medium, or high image quality.".into());
    }
    let title = crate::paths::normalize_spaces(&title);
    if title.is_empty()
        || title.chars().count() > 160
        || title.chars().any(|character| {
            character.is_control()
                || matches!(character, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
    {
        return Err("Use an image title of 1 to 160 visible characters.".into());
    }
    Ok(ValidatedImageRequest {
        prompt,
        model,
        size,
        quality,
        title,
    })
}

fn expected_dimensions(size: &str) -> Result<(u32, u32), String> {
    match size {
        "1024x1024" => Ok((1024, 1024)),
        "1536x1024" => Ok((1536, 1024)),
        "1024x1536" => Ok((1024, 1536)),
        _ => Err("Choose a supported image size.".into()),
    }
}

fn png_has_exact_end(bytes: &[u8]) -> bool {
    let mut offset = 8usize;
    while offset < bytes.len() {
        let Some(header_end) = offset.checked_add(8).filter(|end| *end <= bytes.len()) else {
            return false;
        };
        let length = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
        let kind = &bytes[offset + 4..header_end];
        let Some(chunk_end) = header_end
            .checked_add(length)
            .and_then(|end| end.checked_add(4))
            .filter(|end| *end <= bytes.len())
        else {
            return false;
        };
        let stored_crc =
            u32::from_be_bytes(bytes[header_end + length..chunk_end].try_into().unwrap());
        if crc32fast::hash(&bytes[offset + 4..header_end + length]) != stored_crc {
            return false;
        }
        if kind == b"IEND" {
            return length == 0 && chunk_end == bytes.len();
        }
        offset = chunk_end;
    }
    false
}

/// Fully decode PNG output with CRC/decompression validation and strict bounds
/// before any provider bytes can enter the workspace or immutable artifact store.
fn validate_png(bytes: &[u8], size: &str) -> Result<(), String> {
    if bytes.len() < 45
        || bytes.len() > MAX_IMAGE_BYTES
        || !bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        || !png_has_exact_end(bytes)
    {
        return Err("OpenAI returned an invalid or oversized PNG image.".into());
    }
    let expected = expected_dimensions(size)?;
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_limits(png::Limits {
        bytes: MAX_DECODED_IMAGE_BYTES,
    });
    // Provider metadata is neither displayed nor retained. Avoid inflating
    // compressed text or colour profiles while validating the raster itself.
    decoder.set_ignore_text_chunk(true);
    decoder.set_ignore_iccp_chunk(true);
    let mut reader = decoder
        .read_info()
        .map_err(|_| "OpenAI returned an invalid PNG image.".to_string())?;
    if (reader.info().width, reader.info().height) != expected {
        return Err("OpenAI returned an image with unexpected dimensions.".into());
    }
    let decoded_size = reader.output_buffer_size();
    if decoded_size == 0 || decoded_size > MAX_DECODED_IMAGE_BYTES {
        return Err("OpenAI returned a PNG with unsafe decoded dimensions.".into());
    }
    let mut decoded = vec![0; decoded_size];
    let frame = reader
        .next_frame(&mut decoded)
        .map_err(|_| "OpenAI returned a corrupt PNG image.".to_string())?;
    if (frame.width, frame.height) != expected || frame.buffer_size() == 0 {
        return Err("OpenAI returned an incomplete PNG image.".into());
    }
    Ok(())
}

fn credential() -> Result<String, String> {
    crate::backends::read_credential(PROVIDER_ID)?
        .ok_or_else(|| "Connect a metered OpenAI API key before using image tools.".into())
}

fn client() -> Result<reqwest::Client, String> {
    crate::ensure_rustls_provider();
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(IMAGE_TIMEOUT_SECONDS))
        .build()
        .map_err(|_| "Mivlet could not prepare the OpenAI image connection.".into())
}

fn provider_error(status: reqwest::StatusCode) -> String {
    match status.as_u16() {
        400 => "OpenAI did not accept this image request. Confirm gpt-image-2 access and the selected image options.",
        401 | 403 => "OpenAI rejected this direct API request. Reconnect the API key and confirm gpt-image-2 access for its project.",
        429 => "OpenAI image generation is rate limited, or this API project needs quota or billing attention.",
        500..=599 => "OpenAI's image service is temporarily unavailable. Try again later.",
        _ => "The OpenAI image request failed before an image was returned.",
    }
    .into()
}

async fn bounded_success_body(response: reqwest::Response) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err("OpenAI returned an oversized image response.".into());
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "The OpenAI image response was interrupted.".to_string())?;
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err("OpenAI returned an oversized image response.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn decode_image_response(body: &[u8], size: &str) -> Result<Vec<u8>, String> {
    let response: ImageResponse = serde_json::from_slice(body)
        .map_err(|_| "OpenAI returned an invalid image response.".to_string())?;
    if response.data.len() != 1 {
        return Err("OpenAI did not return exactly one image.".into());
    }
    let encoded = response
        .data
        .into_iter()
        .next()
        .and_then(|item| item.b64_json)
        .ok_or_else(|| "OpenAI returned no image bytes.".to_string())?;
    if encoded.len() > MAX_RESPONSE_BYTES {
        return Err("OpenAI returned oversized image data.".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "OpenAI returned invalid image data.".to_string())?;
    validate_png(&bytes, size)?;
    Ok(bytes)
}

async fn send_generation(
    request: &ValidatedImageRequest,
    credential: &str,
) -> Result<Vec<u8>, String> {
    let response = client()?
        .post(GENERATION_ENDPOINT)
        .bearer_auth(credential)
        .json(&serde_json::json!({
            "model": request.model,
            "prompt": request.prompt,
            "n": 1,
            "size": request.size,
            "quality": request.quality,
            "output_format": "png"
        }))
        .send()
        .await
        .map_err(|_| "Mivlet could not reach OpenAI's image service.".to_string())?;
    if !response.status().is_success() {
        return Err(provider_error(response.status()));
    }
    decode_image_response(&bounded_success_body(response).await?, &request.size)
}

async fn send_edit(
    request: &ValidatedImageRequest,
    credential: &str,
    source: artifacts::VerifiedImageArtifact,
) -> Result<Vec<u8>, String> {
    let image = reqwest::multipart::Part::bytes(source.bytes)
        .file_name(source.file_name)
        .mime_str(&source.mime_type)
        .map_err(|_| "The source artifact has an unsupported image type.".to_string())?;
    let form = reqwest::multipart::Form::new()
        .text("model", request.model.clone())
        .text("prompt", request.prompt.clone())
        .text("n", "1")
        .text("size", request.size.clone())
        .text("quality", request.quality.clone())
        .text("output_format", "png")
        .part("image", image);
    let response = client()?
        .post(EDIT_ENDPOINT)
        .bearer_auth(credential)
        .multipart(form)
        .send()
        .await
        .map_err(|_| "Mivlet could not reach OpenAI's image service.".to_string())?;
    if !response.status().is_success() {
        return Err(provider_error(response.status()));
    }
    decode_image_response(&bounded_success_body(response).await?, &request.size)
}

async fn cancel_on_computer_change<T, F>(
    cancellation: Arc<std::sync::atomic::AtomicBool>,
    provider_call: F,
) -> Result<T, String>
where
    F: Future<Output = Result<T, String>>,
{
    tokio::pin!(provider_call);
    loop {
        tokio::select! {
            result = &mut provider_call => return result,
            _ = tokio::time::sleep(Duration::from_millis(50)) => {
                if cancellation.load(Ordering::Acquire) {
                    return Err("Computer control changed. The image request was cancelled and its result was discarded.".into());
                }
            }
        }
    }
}

pub(crate) async fn execute_image_tool(
    tool: &str,
    arguments: serde_json::Value,
    computers: Arc<LocalComputerState>,
    workspace_id: String,
    agent_id: String,
    computer_generation: u64,
) -> Result<LocalComputerArtifact, String> {
    let (request, source_artifact_id) = match tool {
        "generate-image" => {
            let input: GenerateImageArguments =
                serde_json::from_value(arguments).map_err(|_| {
                    "The generate-image arguments are invalid or contain extra fields.".to_string()
                })?;
            (
                validate_common(
                    input.prompt,
                    input.model,
                    input.size,
                    input.quality,
                    input.title,
                )?,
                None,
            )
        }
        "edit-image" => {
            let input: EditImageArguments = serde_json::from_value(arguments).map_err(|_| {
                "The edit-image arguments are invalid or contain extra fields.".to_string()
            })?;
            let request = validate_common(
                input.prompt,
                input.model,
                input.size,
                input.quality,
                input.title,
            )?;
            (request, Some(input.source_artifact_id))
        }
        _ => return Err("The image tool is not registered.".into()),
    };
    // Admit and retain the native Computer Use ticket before source access or
    // metered egress. Takeover, pause, generation change, shutdown, or plugin
    // disable cancels the HTTP future and drains this ticket before control moves.
    let ticket = computers.begin_agent_operation(&workspace_id, &agent_id, computer_generation)?;
    ticket.check()?;
    let cancellation = ticket.cancellation();
    let credential = credential()?;
    let source = source_artifact_id
        .as_deref()
        .map(|artifact_id| {
            artifacts::verified_image_artifact(
                &computers,
                &workspace_id,
                &agent_id,
                computer_generation,
                artifact_id,
            )
        })
        .transpose()?;
    let provider_call = async {
        match source {
            Some(source) => send_edit(&request, &credential, source).await,
            None => send_generation(&request, &credential).await,
        }
    };
    let bytes = match cancel_on_computer_change(cancellation, provider_call).await {
        Ok(bytes) => bytes,
        Err(error) => return ticket.finish(Err(error)),
    };
    ticket.check()?;
    let result = artifacts::publish_generated_png(
        &computers,
        &workspace_id,
        &agent_id,
        computer_generation,
        &request.title,
        &bytes,
    );
    ticket.finish(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = Vec::new();
        let mut encoder = png::Encoder::new(&mut bytes, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        writer
            .write_image_data(&vec![0; width as usize * height as usize * 4])
            .unwrap();
        writer.finish().unwrap();
        bytes
    }

    #[test]
    fn common_arguments_are_closed_and_bounded() {
        assert!(validate_common(
            "make a poster".into(),
            IMAGE_MODEL.into(),
            "1024x1024".into(),
            "medium".into(),
            "Poster".into()
        )
        .is_ok());
        assert!(validate_common(
            " ".into(),
            IMAGE_MODEL.into(),
            "1024x1024".into(),
            "medium".into(),
            "Poster".into()
        )
        .is_err());
        assert!(validate_common(
            "x".repeat(MAX_PROMPT_CHARACTERS + 1),
            IMAGE_MODEL.into(),
            "1024x1024".into(),
            "medium".into(),
            "Poster".into()
        )
        .is_err());
        assert!(validate_common(
            "ok".into(),
            "chat-model".into(),
            "1024x1024".into(),
            "medium".into(),
            "Poster".into()
        )
        .is_err());
    }

    #[test]
    fn provider_png_must_be_complete_and_match_requested_dimensions() {
        assert!(validate_png(&png(1024, 1024), "1024x1024").is_ok());
        assert!(validate_png(&png(1536, 1024), "1024x1024").is_err());
        let mut trailing = png(1024, 1024);
        trailing.push(0);
        assert!(validate_png(&trailing, "1024x1024").is_err());
        let mut corrupt = png(1024, 1024);
        let idat = corrupt.windows(4).position(|part| part == b"IDAT").unwrap();
        corrupt[idat + 4] ^= 0xff;
        assert!(validate_png(&corrupt, "1024x1024").is_err());
        assert!(validate_png(b"not an image", "1024x1024").is_err());
    }

    #[test]
    fn response_requires_exactly_one_bounded_base64_png() {
        let encoded = base64::engine::general_purpose::STANDARD.encode(png(1024, 1024));
        let body = serde_json::to_vec(&serde_json::json!({"data":[{"b64_json":encoded}]})).unwrap();
        assert!(decode_image_response(&body, "1024x1024").is_ok());
        assert!(decode_image_response(br#"{"data":[]}"#, "1024x1024").is_err());
        assert!(decode_image_response(br#"{"data":[{},{}]}"#, "1024x1024").is_err());
    }

    #[tokio::test]
    async fn cancellation_discards_a_pending_provider_result() {
        let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let signal = cancelled.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(5)).await;
            signal.store(true, Ordering::Release);
        });
        let result = cancel_on_computer_change(cancelled, async {
            std::future::pending::<()>().await;
            Ok::<_, String>(())
        })
        .await;
        assert!(result.unwrap_err().contains("cancelled"));
    }
}
