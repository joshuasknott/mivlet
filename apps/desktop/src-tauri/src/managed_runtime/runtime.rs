//! Managed runtime discovery, executable isolation, status probes, and model cache.
use super::*;

pub(super) fn validate_provider_id(provider_id: &str) -> Result<&str, String> {
    MANAGED_PROVIDER_IDS
        .contains(&provider_id)
        .then_some(provider_id)
        .ok_or_else(|| "Mivlet does not recognize that managed provider runtime.".to_string())
}

pub(super) fn provider_label(provider_id: &str) -> &'static str {
    match provider_id {
        "claude" => "Claude",
        "cursor" => "Cursor",
        "grok" => "Grok",
        "opencode" => "OpenCode",
        _ => "Provider",
    }
}

fn executable_names(provider_id: &str) -> &'static [&'static str] {
    match provider_id {
        "claude" => &["claude"],
        "cursor" => &["agent", "cursor-agent"],
        "grok" => &["grok"],
        "opencode" => &["opencode"],
        _ => &[],
    }
}

fn push_candidate(candidates: &mut Vec<PathBuf>, seen: &mut HashSet<PathBuf>, path: PathBuf) {
    if seen.insert(path.clone()) {
        candidates.push(path);
    }
}

fn executable_candidates(provider_id: &str) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    if let Some(path) = env::var_os("PATH") {
        for directory in env::split_paths(&path) {
            for name in executable_names(provider_id) {
                #[cfg(windows)]
                for suffix in [".exe", ".cmd", ".bat", ""] {
                    push_candidate(
                        &mut candidates,
                        &mut seen,
                        directory.join(format!("{name}{suffix}")),
                    );
                }
                #[cfg(not(windows))]
                push_candidate(&mut candidates, &mut seen, directory.join(name));
            }
        }
    }
    #[cfg(windows)]
    {
        if let Some(profile) = env::var_os("USERPROFILE").map(PathBuf::from) {
            for name in executable_names(provider_id) {
                for base in [
                    profile.join(".local").join("bin"),
                    profile.join(".grok").join("bin"),
                ] {
                    push_candidate(&mut candidates, &mut seen, base.join(format!("{name}.exe")));
                    push_candidate(&mut candidates, &mut seen, base.join(format!("{name}.cmd")));
                }
            }
        }
        if let Some(app_data) = env::var_os("APPDATA").map(PathBuf::from) {
            for name in executable_names(provider_id) {
                push_candidate(
                    &mut candidates,
                    &mut seen,
                    app_data.join("npm").join(format!("{name}.cmd")),
                );
                push_candidate(
                    &mut candidates,
                    &mut seen,
                    app_data.join("npm").join(format!("{name}.exe")),
                );
            }
        }
    }
    candidates
}

pub(super) fn find_executable(provider_id: &str) -> Option<PathBuf> {
    executable_candidates(provider_id)
        .into_iter()
        .find(|candidate| {
            sdk_launch::executable_allowed(provider_id, candidate) && candidate.is_file()
        })
}

pub(super) fn missing_runtime_message(provider_id: &str) -> String {
    if provider_id == "claude" && cfg!(windows) {
        return "Install the official native Claude executable (claude.exe), then reopen Mivlet. Windows batch shims cannot run this adapter.".into();
    }
    format!(
        "Install the official {} runtime, then reopen Mivlet.",
        provider_label(provider_id)
    )
}

fn executable_command(path: &Path) -> Command {
    #[cfg(windows)]
    if path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("cmd") || value.eq_ignore_ascii_case("bat"))
    {
        let mut command = Command::new("cmd");
        command.arg("/C").arg(path);
        return command;
    }
    Command::new(path)
}

fn account_hash(user_id: &str) -> String {
    hex::encode(Sha256::digest(user_id.as_bytes()))
}

pub(super) fn root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::paths::app_data_dir(app)?.join("managed-runtimes"))
}

pub(super) fn workspace_dir(
    app: &AppHandle,
    user_id: &str,
    provider_id: &str,
) -> Result<PathBuf, String> {
    let path = root(app)?
        .join("workspaces")
        .join(account_hash(user_id))
        .join(provider_id);
    fs::create_dir_all(&path).map_err(|_| {
        format!(
            "Mivlet could not prepare the {} workspace.",
            provider_label(provider_id)
        )
    })?;
    Ok(path)
}

fn claude_profile_dir(app: &AppHandle, user_id: &str) -> Result<PathBuf, String> {
    let path = root(app)?
        .join("profiles")
        .join(account_hash(user_id))
        .join("claude");
    fs::create_dir_all(&path)
        .map_err(|_| "Mivlet could not prepare the private Claude profile.".to_string())?;
    Ok(path)
}

fn models_path(app: &AppHandle, user_id: &str, provider_id: &str) -> Result<PathBuf, String> {
    Ok(root(app)?
        .join("models")
        .join(account_hash(user_id))
        .join(format!("{provider_id}.json")))
}

pub(super) fn cache_models(
    app: &AppHandle,
    user_id: &str,
    provider_id: &str,
    models: &[BackendModel],
) -> Result<(), String> {
    if models.is_empty() {
        return Ok(());
    }
    let path = models_path(app, user_id, provider_id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|_| "Mivlet could not prepare the managed model cache.".to_string())?;
    }
    let bytes = serde_json::to_vec(models)
        .map_err(|_| "Mivlet could not encode managed provider models.".to_string())?;
    fs::write(path, bytes)
        .map_err(|_| "Mivlet could not cache managed provider models.".to_string())
}

pub(crate) fn cached_models(
    app: &AppHandle,
    user_id: &str,
    provider_id: &str,
) -> Vec<BackendModel> {
    models_path(app, user_id, provider_id)
        .ok()
        .and_then(|path| fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_else(|| fallback_models(provider_id))
}

fn fallback_models(provider_id: &str) -> Vec<BackendModel> {
    let values: &[(&str, &str)] = match provider_id {
        "claude" => &[
            ("sonnet", "Claude Sonnet"),
            ("opus", "Claude Opus"),
            ("haiku", "Claude Haiku"),
        ],
        "cursor" => &[("default", "Cursor default")],
        "grok" => &[("grok-build", "Grok default")],
        _ => &[],
    };
    values
        .iter()
        .map(|(id, label)| BackendModel {
            id: (*id).to_string(),
            label: (*label).to_string(),
            available: true,
            capabilities: None,
            reasoning: None,
            fast_mode: None,
        })
        .collect()
}

pub(super) struct CommandOutput {
    pub(super) success: bool,
    pub(super) stdout: String,
    pub(super) stderr: String,
}

pub(super) fn read_limited(mut reader: impl Read, limit: usize) -> String {
    let mut collected = Vec::new();
    let mut buffer = [0_u8; 4096];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                let remaining = limit.saturating_sub(collected.len());
                collected.extend_from_slice(&buffer[..count.min(remaining)]);
            }
        }
    }
    String::from_utf8_lossy(&collected).into_owned()
}

pub(super) fn run_command(
    mut command: Command,
    timeout: Duration,
) -> Result<CommandOutput, String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = crate::provider_process::SupervisedChild::spawn(command)
        .map_err(|_| "Mivlet could not start the provider runtime.".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Provider stdout was unavailable.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Provider stderr was unavailable.".to_string())?;
    let stdout_reader = thread::spawn(move || read_limited(stdout, MAX_COMMAND_OUTPUT));
    let stderr_reader = thread::spawn(move || read_limited(stderr, MAX_COMMAND_OUTPUT));
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|_| "Mivlet could not inspect the provider process.".to_string())?
        {
            break status;
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err("The provider runtime check timed out.".to_string());
        }
        thread::sleep(Duration::from_millis(40));
    };
    Ok(CommandOutput {
        success: status.success(),
        stdout: stdout_reader.join().unwrap_or_default(),
        stderr: stderr_reader.join().unwrap_or_default(),
    })
}

fn normalized_version(value: &str) -> Option<String> {
    let line = value
        .lines()
        .map(str::trim)
        .find(|line| line.chars().any(|character| character.is_ascii_digit()))?;
    Some(crate::paths::truncate_characters(
        &crate::paths::normalize_spaces(line),
        120,
    ))
}

pub(super) fn safe_error_message(value: &str, fallback: &str) -> String {
    let candidate = value
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or(fallback);
    crate::store::repos::action_history::redact_safe_detail(&Value::String(candidate.to_string()))
        .as_str()
        .unwrap_or(fallback)
        .to_string()
}

pub(super) fn command_for_provider(
    app: &AppHandle,
    user_id: &str,
    provider_id: &str,
    path: &Path,
) -> Result<Command, String> {
    if provider_id != "claude" || cfg!(target_os = "macos") {
        return Err(format!("{} is unavailable until its provider-owned credential store supports verified Mivlet account isolation. Connect a direct API provider instead.", provider_label(provider_id)));
    }
    if !sdk_launch::executable_allowed(provider_id, path) {
        return Err("Install the official native Claude executable (claude.exe); Windows batch shims cannot run this adapter.".into());
    }
    crate::account_session::ensure_current()?;
    let mut command = executable_command(path);
    for key in [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CODE_API_KEY_HELPER",
        "ANTHROPIC_BASE_URL",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    ] {
        command.env_remove(key);
    }

    if provider_id == "claude" {
        command.env("CLAUDE_CONFIG_DIR", claude_profile_dir(app, user_id)?);
    }
    if provider_id == "opencode" {
        command
            .env("OPENCODE_AUTO_SHARE", "false")
            .env("OPENCODE_DISABLE_AUTOUPDATE", "true")
            .env("OPENCODE_DISABLE_TERMINAL_TITLE", "true");
    }
    Ok(command)
}

fn parse_cursor_about(output: &CommandOutput) -> (bool, Option<String>) {
    if let Ok(value) = serde_json::from_str::<Value>(output.stdout.trim()) {
        let version = value
            .get("cliVersion")
            .and_then(Value::as_str)
            .map(str::to_string);
        let authenticated = value
            .get("userEmail")
            .and_then(Value::as_str)
            .is_some_and(|email| !email.trim().is_empty());
        return (authenticated, version);
    }
    let combined = format!("{}\n{}", output.stdout, output.stderr);
    let lower = combined.to_ascii_lowercase();
    let authenticated = combined
        .lines()
        .find_map(|line| {
            let (key, value) = line.split_once(char::is_whitespace)?;
            key.eq_ignore_ascii_case("User")
                .then(|| value.trim_start_matches("Email").trim())
        })
        .is_some_and(|email| {
            !email.is_empty()
                && !email.eq_ignore_ascii_case("not logged in")
                && !lower.contains("authentication required")
        });
    (authenticated, normalized_version(&combined))
}

pub(super) fn parse_grok_models(output: &str) -> (Option<bool>, Vec<BackendModel>) {
    let authenticated = if output.to_ascii_lowercase().contains("you are logged in") {
        Some(true)
    } else if output.to_ascii_lowercase().contains("not authenticated")
        || output.to_ascii_lowercase().contains("not logged in")
    {
        Some(false)
    } else {
        None
    };
    let mut seen = HashSet::new();
    let models = output
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            let slug = trimmed
                .strip_prefix("* ")
                .or_else(|| trimmed.strip_prefix("- "))?
                .split_whitespace()
                .next()?
                .trim();
            if slug.is_empty() || !seen.insert(slug.to_string()) {
                return None;
            }
            Some(BackendModel {
                id: slug.to_string(),
                label: slug
                    .split(['-', '_'])
                    .map(|part| {
                        if part.eq_ignore_ascii_case("grok") {
                            "Grok".to_string()
                        } else {
                            part.to_string()
                        }
                    })
                    .collect::<Vec<_>>()
                    .join(" "),
                available: true,
                capabilities: None,
                reasoning: None,
                fast_mode: None,
            })
        })
        .take(32)
        .collect();
    (authenticated, models)
}

pub(super) fn parse_opencode_models(output: &str) -> Vec<BackendModel> {
    let mut seen = HashSet::new();
    output
        .lines()
        .filter_map(|line| {
            let id = line.split_whitespace().next()?.trim();
            if id.is_empty()
                || !id.contains('/')
                || id.len() > 180
                || !id.chars().all(|character| {
                    character.is_ascii_alphanumeric() || "/._-:@".contains(character)
                })
                || !seen.insert(id.to_string())
            {
                return None;
            }
            Some(BackendModel {
                id: id.to_string(),
                label: id.to_string(),
                available: true,
                capabilities: None,
                reasoning: None,
                fast_mode: None,
            })
        })
        .take(32)
        .collect()
}

pub(super) fn probe_status(
    app: &AppHandle,
    user_id: &str,
    provider_id: &str,
) -> Result<ManagedRuntimeStatus, String> {
    validate_provider_id(provider_id)?;
    let Some(path) = find_executable(provider_id) else {
        return Ok(ManagedRuntimeStatus {
            provider_id: provider_id.to_string(),
            installed: false,
            authenticated: false,
            version: None,
            message: Some(missing_runtime_message(provider_id)),
        });
    };
    let mut version_command = command_for_provider(app, user_id, provider_id, &path)?;
    version_command.arg("--version");
    let version_output = run_command(version_command, STATUS_TIMEOUT)?;
    let version = normalized_version(&format!(
        "{}\n{}",
        version_output.stdout, version_output.stderr
    ));
    if !version_output.success {
        return Ok(ManagedRuntimeStatus {
            provider_id: provider_id.to_string(),
            installed: true,
            authenticated: false,
            version,
            message: Some(format!(
                "The {} runtime is installed but could not be started.",
                provider_label(provider_id)
            )),
        });
    }

    let (authenticated, discovered_models) = match provider_id {
        "claude" => {
            let mut command = command_for_provider(app, user_id, provider_id, &path)?;
            command.args(["auth", "status", "--json"]);
            let output = run_command(command, STATUS_TIMEOUT)?;
            let value = serde_json::from_str::<Value>(output.stdout.trim()).unwrap_or(Value::Null);
            let authenticated = value
                .get("loggedIn")
                .or_else(|| value.get("authenticated"))
                .and_then(Value::as_bool)
                .unwrap_or_else(|| {
                    let text = format!("{}\n{}", output.stdout, output.stderr).to_ascii_lowercase();
                    output.success && text.contains("logged in") && !text.contains("not logged in")
                });
            (authenticated, fallback_models(provider_id))
        }
        "cursor" => {
            let mut command = command_for_provider(app, user_id, provider_id, &path)?;
            command.args(["about", "--format", "json"]);
            let mut output = run_command(command, STATUS_TIMEOUT)?;
            if !output.success
                && (output
                    .stderr
                    .to_ascii_lowercase()
                    .contains("unexpected argument")
                    || output.stderr.to_ascii_lowercase().contains("unknown"))
            {
                let mut fallback = command_for_provider(app, user_id, provider_id, &path)?;
                fallback.arg("about");
                output = run_command(fallback, STATUS_TIMEOUT)?;
            }
            let (authenticated, _) = parse_cursor_about(&output);
            (authenticated, fallback_models(provider_id))
        }
        "grok" => {
            let mut command = command_for_provider(app, user_id, provider_id, &path)?;
            command.arg("models");
            let output = run_command(command, STATUS_TIMEOUT)?;
            let combined = format!("{}\n{}", output.stdout, output.stderr);
            let (auth, models) = parse_grok_models(&combined);
            (auth.unwrap_or(false), models)
        }
        "opencode" => {
            let mut command = command_for_provider(app, user_id, provider_id, &path)?;
            command.args(["models"]);
            let output = run_command(command, STATUS_TIMEOUT)?;
            let models = if output.success {
                parse_opencode_models(&output.stdout)
            } else {
                Vec::new()
            };
            (!models.is_empty(), models)
        }
        _ => unreachable!(),
    };
    if authenticated {
        cache_models(app, user_id, provider_id, &discovered_models)?;
    }
    Ok(ManagedRuntimeStatus {
        provider_id: provider_id.to_string(),
        installed: true,
        authenticated,
        version,
        message: Some(if authenticated {
            format!("{} is connected.", provider_label(provider_id))
        } else if provider_id == "opencode" {
            "OpenCode is installed, but no configured provider models were found. Run `opencode auth login`, then check again.".to_string()
        } else {
            format!(
                "{} is installed. Continue with your {} account to connect it.",
                provider_label(provider_id),
                provider_label(provider_id)
            )
        }),
    })
}

pub(crate) fn status_for(provider_id: &str, previously_connected: bool) -> ManagedRuntimeStatus {
    let installed = find_executable(provider_id).is_some();
    ManagedRuntimeStatus {
        provider_id: provider_id.to_string(),
        installed,
        authenticated: installed && previously_connected,
        version: None,
        message: Some(if !installed {
            missing_runtime_message(provider_id)
        } else if previously_connected {
            format!(
                "{} account connection is ready to verify.",
                provider_label(provider_id)
            )
        } else if provider_id == "opencode" {
            "Configure a provider with `opencode auth login`, then check the connection in Mivlet."
                .to_string()
        } else {
            format!(
                "Continue with your {} account.",
                provider_label(provider_id)
            )
        }),
    }
}
