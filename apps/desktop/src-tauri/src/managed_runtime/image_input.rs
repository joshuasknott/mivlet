//! Claude's wire encoding only; composer limits/metadata validation are shared
//! with Codex, and no image is copied into Mivlet's durable transcript.
use super::{prompt_text, ManagedAgentRequest, ManagedTurnOptions};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};

pub(super) fn supported_model(model: &str) -> bool {
    matches!(model, "sonnet" | "opus" | "haiku")
}

pub(super) fn validate_route(provider: &str, request: &ManagedAgentRequest) -> Result<(), String> {
    if request
        .messages
        .iter()
        .any(|message| !message.images.is_empty())
        && (provider != "claude" || !supported_model(&request.model))
    {
        return Err("This provider route/model cannot accept attached images. Reattach them with a supported Codex or Claude model.".into());
    }
    Ok(())
}

pub(super) fn user_message(
    request: &ManagedAgentRequest,
    options: &ManagedTurnOptions,
) -> Result<Value, String> {
    validate_route("claude", request)?;
    let images = crate::user_images::current_images(
        request
            .messages
            .iter()
            .map(|message| (message.role.as_str(), message.images.as_slice())),
    )?;
    let text = prompt_text(request, options);
    if !images.is_empty() && text.len() > 256 * 1024 {
        return Err("The image request's text context exceeds the supported size. Start a shorter conversation.".into());
    }
    let mut content = vec![json!({"type":"text","text":text})];
    for image in images {
        content.push(json!({"type":"image","source":{
            "type":"base64","media_type":image.media_type,"data":STANDARD.encode(image.bytes)
        }}));
    }
    Ok(json!({"type":"user","session_id":"",
        "message":{"role":"user","content":content},"parent_tool_use_id":Value::Null}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> ManagedAgentRequest {
        let bytes = STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=").unwrap();
        serde_json::from_value(json!({"model":"sonnet","messages":[
            {"role":"assistant","content":"Earlier answer"},
            {"role":"user","content":"Describe this","images":[{
                "id":"image-1","name":"pixel.png","mediaType":"image/png",
                "sizeBytes":bytes.len(),"width":1,"height":1,
                "dataUrl":format!("data:image/png;base64,{}", STANDARD.encode(bytes))
            }]}
        ]}))
        .unwrap()
    }
    fn options() -> ManagedTurnOptions {
        serde_json::from_value(json!({"contextPrefix":"Scoped task context"})).unwrap()
    }
    #[test]
    fn sdk_user_content_carries_current_pixels_and_text_in_order_without_paths() {
        let request = request();
        let message = user_message(&request, &options()).unwrap();
        assert_eq!(message["type"], "user");
        assert_eq!(
            message["message"]["content"][0]["text"],
            "Scoped task context\n\nassistant: Earlier answer\n\nuser: Describe this"
        );
        let image = &message["message"]["content"][1];
        assert_eq!(image["type"], "image");
        assert_eq!(image["source"]["type"], "base64");
        assert_eq!(image["source"]["media_type"], "image/png");
        assert_eq!(
            STANDARD
                .decode(image["source"]["data"].as_str().unwrap())
                .unwrap()
                .len(),
            request.messages[1].images[0].size_bytes
        );
        assert!(!message.to_string().contains("data:image"));
        assert!(!message.to_string().contains("pixel.png"));
        let mut text_only = request;
        text_only.messages[1].images.clear();
        assert_eq!(
            user_message(&text_only, &options()).unwrap()["message"]["content"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
    #[test]
    fn unsupported_routes_models_historical_pixels_and_changed_bytes_fail_closed() {
        let mut request = request();
        for provider in ["grok", "cursor", "opencode"] {
            assert!(validate_route(provider, &request).is_err());
        }
        request.model = "unknown".into();
        assert!(user_message(&request, &options()).is_err());
        request.model = "opus".into();
        request.messages[1].images[0].width = 2;
        assert!(user_message(&request, &options()).is_err());
        request.messages[1].images[0].width = 1;
        let historical = request.messages[1].clone();
        request.messages.insert(0, historical);
        assert!(user_message(&request, &options()).is_err());
    }
    #[test]
    fn oversized_text_with_images_fails_before_provider_start() {
        let mut request = request();
        request.messages[1].content = "x".repeat(256 * 1024);
        assert!(user_message(&request, &options()).is_err());
    }

    #[test]
    #[ignore = "disposable subprocess fixture, invoked only by the Stop regression"]
    fn nonreading_provider_stdin_fixture() {
        use std::io::Write;
        println!("fixture-ready");
        std::io::stdout().flush().unwrap();
        std::thread::sleep(std::time::Duration::from_secs(30));
    }

    #[test]
    fn stop_terminates_a_real_provider_with_a_blocked_payload_writer() {
        use std::{
            io::{BufRead, BufReader, Write},
            process::{Command, Stdio},
            sync::{mpsc, Arc, Mutex},
            time::{Duration, Instant},
        };
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "managed_runtime::image_input::tests::nonreading_provider_stdin_fixture",
                "--exact",
                "--ignored",
                "--nocapture",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let mut child = crate::provider_process::SupervisedChild::spawn(command).unwrap();
        let input = Arc::new(Mutex::new(child.stdin.take().unwrap()));
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        while !line.contains("fixture-ready") {
            assert_ne!(output.read_line(&mut line).unwrap(), 0);
        }
        let child = Arc::new(Mutex::new(child));
        let (started, waiting) = mpsc::channel();
        let (completed, result) = mpsc::channel();
        let writer = std::thread::spawn(move || {
            let mut input = input.lock().unwrap();
            started.send(()).unwrap();
            let payload = vec![b'x'; 2 * 1024 * 1024];
            completed.send(input.write_all(&payload).is_err()).unwrap();
        });
        waiting.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(
            result.recv_timeout(Duration::from_millis(100)).is_err(),
            "fixture did not block stdin"
        );
        let start = Instant::now();
        super::super::terminate_claude_turn(&child).unwrap();
        assert!(start.elapsed() < Duration::from_secs(2));
        assert!(
            result.recv_timeout(Duration::from_secs(2)).unwrap(),
            "blocked writer was not cancelled"
        );
        writer.join().unwrap();
    }
}
