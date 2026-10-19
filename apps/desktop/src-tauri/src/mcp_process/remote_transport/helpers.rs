fn validate_configuration_for_approval(
    configuration: &McpServerConfiguration,
) -> Result<(), String> {
    crate::store::repos::scope::normalize_id(&configuration.id, "MCP launch reference")
        .map_err(|error| error.to_string())?;
    if configuration
        .expected_revision
        .is_some_and(|revision| revision < 1)
    {
        return Err("MCP configuration revision is invalid.".to_string());
    }
    crate::store::repos::mcp_local_server::validate_server_values(
        &configuration.display_name,
        &configuration.transport,
        &configuration.command,
        &configuration.args,
        configuration.endpoint.as_deref(),
    )
    .map_err(|error| error.to_string())?;
    if configuration.transport == "stdio" {
        validate_executable(&configuration.command)?;
    } else {
        validate_remote_endpoint(configuration.endpoint.as_deref().unwrap_or_default())?;
    }
    let lower_args = configuration.args.join(" ").to_ascii_lowercase();
    const SECRET_MARKERS: &[&str] = &[
        "api-key",
        "apikey",
        "authorization",
        "bearer",
        "password",
        "secret",
        "token",
    ];
    if SECRET_MARKERS
        .iter()
        .any(|marker| lower_args.contains(marker))
    {
        return Err(
            "MCP launch arguments cannot contain credentials; use native credential custody."
                .to_string(),
        );
    }
    Ok(())
}
fn configuration_fingerprint(configuration: &McpServerConfiguration) -> Result<String, String> {
    let encoded = serde_json::to_vec(configuration)
        .map_err(|_| "Mivlet could not fingerprint this MCP configuration.".to_string())?;
    Ok(format!("{:x}", Sha256::digest(encoded)))
}

fn approval_for_configuration(
    configuration: &McpServerConfiguration,
    fingerprint: &str,
    id: String,
    requested_at: String,
) -> crate::models::ApprovalRequest {
    crate::models::ApprovalRequest {
        id,
        service: "MCP connections".to_string(),
        action: format!("configure MCP server {}", configuration.id),
        mode: "full-access".to_string(),
        risk_level: "critical".to_string(),
        data_used: vec![
            format!("server: {}", configuration.display_name.trim()),
            format!("configuration fingerprint: {fingerprint}"),
        ],
        consequence: if configuration.transport == "stdio" {
            "Starts a user-managed local program that can expose tools and resources to Mivlet."
                .to_string()
        } else {
            "Connects to a user-managed remote service that can expose tools and resources to Mivlet."
                .to_string()
        },
        requested_at,
        decisions: vec!["once".to_string(), "deny".to_string()],
        confirmation_phrase: Some(format!("configure {}", configuration.id)),
    }
}

fn validate_executable(command: &str) -> Result<PathBuf, String> {
    let path = Path::new(command);
    if !path.is_absolute() {
        return Err("Local MCP executables must use an absolute path.".to_string());
    }
    let canonical = crate::paths::strict_canonicalize(path)
        .map_err(|_| "The local MCP executable path is unavailable.".to_string())?;
    let metadata = std::fs::metadata(&canonical)
        .map_err(|_| "The local MCP executable path is unavailable.".to_string())?;
    if !metadata.is_file() || crate::paths::contains_symlink(path) {
        return Err("The local MCP executable must be a regular file without links.".to_string());
    }
    #[cfg(windows)]
    if canonical
        .extension()
        .and_then(|value| value.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("exe"))
    {
        return Err("Local MCP executables must be Windows .exe files.".to_string());
    }
    Ok(canonical)
}

fn copy_safe_environment(command: &mut Command) {
    const SAFE: &[&str] = &[
        "PATH",
        "PATHEXT",
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "HOME",
        "USERPROFILE",
        "LANG",
        "LC_ALL",
    ];
    for name in SAFE {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
}

fn spawn_mcp_child(executable: &Path, args: &[String], cwd: &Path) -> std::io::Result<Child> {
    let mut command = Command::new(executable);
    command
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    copy_safe_environment(&mut command);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.as_std_mut().creation_flags(0x0800_0000);
    }
    command.spawn()
}

fn random_session_id() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|_| "Mivlet could not create a local MCP session id.".to_string())?;
    Ok(format!("mcp-{}", hex::encode(bytes)))
}

fn valid_session_id(value: &str) -> bool {
    value.len() == 36
        && value.starts_with("mcp-")
        && value[4..]
            .chars()
            .all(|character| character.is_ascii_hexdigit())
}

fn valid_mcp_frame(frame: &str) -> bool {
    if frame.is_empty() || frame.len() > MAX_MCP_FRAME_BYTES || frame.contains(['\r', '\n']) {
        return false;
    }
    let Ok(Value::Object(object)) = serde_json::from_str::<Value>(frame) else {
        return false;
    };
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return false;
    }
    let valid_id = object
        .get("id")
        .is_none_or(|id| id.is_string() || id.as_i64().is_some() || id.as_u64().is_some());
    if !valid_id {
        return false;
    }
    if let Some(method) = object.get("method") {
        return method.as_str().is_some_and(|value| !value.is_empty())
            && !object.contains_key("result")
            && !object.contains_key("error");
    }
    object.contains_key("id") && (object.contains_key("result") ^ object.contains_key("error"))
}

fn permitted_renderer_frame(frame: &str) -> bool {
    if !valid_mcp_frame(frame) {
        return false;
    }
    let Ok(Value::Object(object)) = serde_json::from_str::<Value>(frame) else {
        return false;
    };
    let Some(method) = object.get("method").and_then(Value::as_str) else {
        // This client advertises no server-request capabilities, so renderer
        // responses are never needed and cannot become an execution bypass.
        return false;
    };
    matches!(
        method,
        "initialize"
            | "ping"
            | "tools/list"
            | "resources/list"
            | "resources/templates/list"
            | "notifications/initialized"
            | "notifications/cancelled"
    )
}

#[derive(Default)]
struct BoundedLineDecoder {
    buffer: Vec<u8>,
    dropping: bool,
}

impl BoundedLineDecoder {
    fn push(&mut self, chunk: &[u8]) -> Vec<Vec<u8>> {
        let mut lines = Vec::new();
        for byte in chunk {
            if *byte == b'\n' {
                if !self.dropping {
                    if self.buffer.last() == Some(&b'\r') {
                        self.buffer.pop();
                    }
                    lines.push(std::mem::take(&mut self.buffer));
                } else {
                    self.buffer.clear();
                }
                self.dropping = false;
            } else if !self.dropping {
                if self.buffer.len() < MAX_MCP_FRAME_BYTES {
                    self.buffer.push(*byte);
                } else {
                    self.buffer.clear();
                    self.dropping = true;
                }
            }
        }
        lines
    }
}
