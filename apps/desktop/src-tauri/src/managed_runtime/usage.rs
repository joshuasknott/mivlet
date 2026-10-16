use super::*;

/// The SDK control protocol is probed without ever submitting a user turn.
pub(crate) fn claude_usage(app: &AppHandle, owner: &str) -> Result<Value, String> {
    let path = find_executable("claude").ok_or_else(|| missing_runtime_message("claude"))?;
    let mut command = command_for_provider(app, owner, "claude", &path)?;
    sdk_launch::configure(&mut command, "default");
    command
        .current_dir(workspace_dir(app, owner, "claude")?)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = crate::provider_process::SupervisedChild::spawn(command)
        .map_err(|_| "Claude could not start to read usage.")?;
    let stdin = Arc::new(Mutex::new(
        child
            .stdin
            .take()
            .ok_or("Claude usage stdin is unavailable.")?,
    ));
    let stdout = child
        .stdout
        .take()
        .ok_or("Claude usage stdout is unavailable.")?;
    let (sender, receiver) = std::sync::mpsc::sync_channel(8);
    let reader = thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut line = Vec::new();
            if reader
                .by_ref()
                .take(128 * 1024 + 1)
                .read_until(b'\n', &mut line)
                .unwrap_or(0)
                == 0
                || line.len() > 128 * 1024
            {
                break;
            }
            if let Ok(value) = serde_json::from_slice::<Value>(&line) {
                if sender.send(value).is_err() {
                    break;
                }
            }
        }
    });
    let result = (|| {
        let read = |id: &str| -> Result<Value, String> {
            let deadline = Instant::now() + Duration::from_secs(12);
            loop {
                let value = receiver
                    .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                    .map_err(|_| "Claude did not answer the usage request.")?;
                if value
                    .pointer("/response/request_id")
                    .and_then(Value::as_str)
                    == Some(id)
                {
                    if value.pointer("/response/subtype").and_then(Value::as_str) != Some("success")
                    {
                        return Err(
                            "This Claude runtime does not expose supported usage measurements."
                                .into(),
                        );
                    }
                    return Ok(value["response"]["response"].clone());
                }
                if value["type"] == "control_request" {
                    respond_to_unsupported_claude_control(&stdin, &value);
                }
            }
        };
        write_json(
            &stdin,
            "claude",
            &json!({"type":"control_request","request_id":"usage-init","request":{"subtype":"initialize"}}),
        )?;
        read("usage-init")?;
        write_json(
            &stdin,
            "claude",
            &json!({"type":"control_request","request_id":"usage-read","request":{"subtype":"get_usage"}}),
        )?;
        let result = read("usage-read")?;
        if crate::backends::require_current_internal_user()? != owner {
            return Err("The account changed during the usage check.".into());
        }
        Ok(result)
    })();
    let _ = child.kill();
    let _ = child.wait();
    drop(receiver);
    let _ = reader.join();
    result
}
