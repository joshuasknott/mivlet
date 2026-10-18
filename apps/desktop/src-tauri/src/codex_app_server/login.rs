use url::Url;

use super::*;

pub(super) fn validated_codex_auth_url(value: &str) -> Result<String, String> {
    if value.chars().count() > 8_192 {
        return Err("Codex returned an invalid ChatGPT sign-in address.".into());
    }
    let url = Url::parse(value)
        .map_err(|_| "Codex returned an invalid ChatGPT sign-in address.".to_string())?;
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let trusted_host = matches!(host.as_str(), "chatgpt.com" | "auth.openai.com")
        || host.ends_with(".chatgpt.com")
        || host.ends_with(".openai.com");
    if url.scheme() != "https"
        || !trusted_host
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Codex returned an untrusted ChatGPT sign-in address.".into());
    }
    Ok(url.to_string())
}

fn open_system_browser(value: &str) -> Result<(), String> {
    #[cfg(windows)]
    let result = env::var_os("WINDIR")
        .map(PathBuf::from)
        .map(|root| root.join("System32").join("rundll32.exe"))
        .filter(|path| path.is_file())
        .ok_or_else(|| "Mivlet could not locate the Windows browser launcher.".to_string())
        .and_then(|launcher| {
            Command::new(launcher)
                .arg("url.dll,FileProtocolHandler")
                .arg(value)
                .spawn()
                .map_err(|_| "Mivlet could not open the ChatGPT sign-in page.".to_string())
        });
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg(value).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = Command::new("xdg-open").arg(value).spawn();

    result
        .map(|_| ())
        .map_err(|_| "Mivlet could not open the ChatGPT sign-in page.".to_string())
}

pub(super) fn receive_codex_value(
    receiver: &mpsc::Receiver<Value>,
    timeout: Duration,
    predicate: impl Fn(&Value) -> bool,
) -> Result<Value, String> {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("ChatGPT sign-in timed out.".into());
        }
        let value = receiver
            .recv_timeout(remaining)
            .map_err(|_| "Codex stopped before ChatGPT sign-in completed.".to_string())?;
        if predicate(&value) {
            return Ok(value);
        }
    }
}

pub(super) fn chatgpt_login_details(value: &Value) -> Result<(String, String), String> {
    if value.get("error").is_some()
        || value.pointer("/result/type").and_then(Value::as_str) != Some("chatgpt")
    {
        return Err("Codex could not start ChatGPT sign-in.".into());
    }
    let login_id = value
        .pointer("/result/loginId")
        .and_then(Value::as_str)
        .filter(|candidate| !candidate.is_empty() && candidate.len() <= 160)
        .ok_or_else(|| "Codex returned no ChatGPT sign-in identifier.".to_string())?;
    let auth_url = value
        .pointer("/result/authUrl")
        .and_then(Value::as_str)
        .ok_or_else(|| "Codex returned no ChatGPT sign-in address.".to_string())?;
    Ok((login_id.to_string(), validated_codex_auth_url(auth_url)?))
}

pub(super) fn start_codex_browser_login_blocking() -> Result<CodexBrowserLoginResult, String> {
    let owner = crate::backends::require_current_internal_user()?;
    let path = find_codex_executable().ok_or_else(missing_codex_runtime_message)?;
    let mut command = codex_command(&path)?;
    command
        .arg("app-server")
        .arg("--stdio")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = crate::provider_process::SupervisedChild::spawn(command)
        .map_err(|_| "Mivlet could not start Codex app-server.".to_string())?;
    let stdin =
        Arc::new(Mutex::new(child.stdin.take().ok_or_else(|| {
            "Codex app-server stdin was unavailable.".to_string()
        })?));
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Codex app-server stdout was unavailable.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Codex app-server stderr was unavailable.".to_string())?;
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                if sender.send(value).is_err() {
                    break;
                }
            }
        }
    });
    thread::spawn(
        move || {
            for _ in BufReader::new(stderr).lines().map_while(Result::ok) {}
        },
    );

    let result = (|| {
        write_json_line(
            &stdin,
            &json!({
                "id": 1,
                "method": "initialize",
                "params": {
                    "clientInfo": { "name": "mivlet", "title": "Mivlet", "version": env!("CARGO_PKG_VERSION") },
                    "capabilities": { "experimentalApi": false, "requestAttestation": false }
                }
            }),
        )?;
        let initialized = receive_codex_value(&receiver, CODEX_LOGIN_START_TIMEOUT, |value| {
            value.get("id").and_then(Value::as_i64) == Some(1)
        })?;
        if initialized.get("error").is_some() {
            return Err("Codex app-server could not initialize ChatGPT sign-in.".into());
        }
        write_json_line(&stdin, &json!({ "method": "initialized" }))?;
        write_json_line(
            &stdin,
            &json!({
                "id": 2,
                "method": "account/login/start",
                "params": {
                    "type": "chatgpt",
                    "useHostedLoginSuccessPage": true,
                    "appBrand": "chatgpt"
                }
            }),
        )?;
        let start = receive_codex_value(&receiver, CODEX_LOGIN_START_TIMEOUT, |value| {
            value.get("id").and_then(Value::as_i64) == Some(2)
        })?;
        let (login_id, auth_url) = chatgpt_login_details(&start)?;
        open_system_browser(&auth_url)?;
        let completion = receive_codex_value(&receiver, CODEX_LOGIN_COMPLETION_TIMEOUT, |value| {
            value.get("method").and_then(Value::as_str) == Some("account/login/completed")
                && value.pointer("/params/loginId").and_then(Value::as_str)
                    == Some(login_id.as_str())
        })?;
        if completion
            .pointer("/params/success")
            .and_then(Value::as_bool)
            != Some(true)
        {
            return Err("ChatGPT sign-in was not completed.".into());
        }
        if crate::backends::require_current_internal_user()? != owner {
            return Err("The account changed during ChatGPT sign-in.".into());
        }
        crate::backends::record_connected_provider(&owner, "codex")?;
        Ok(CodexBrowserLoginResult {
            provider_id: "codex",
            outcome: "ready",
            message: "ChatGPT sign-in completed in your browser.",
        })
    })();

    let _ = child.kill();
    let _ = child.wait();
    result
}
