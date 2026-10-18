use super::*;

fn push_unique_candidate(
    candidates: &mut Vec<PathBuf>,
    seen: &mut HashSet<PathBuf>,
    candidate: PathBuf,
) {
    if seen.insert(candidate.clone()) {
        candidates.push(candidate);
    }
}

fn modified_time(path: &Path) -> Option<std::time::SystemTime> {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
}

pub(super) fn codex_candidates_from(
    path: Option<OsString>,
    app_data: Option<PathBuf>,
    local_app_data: Option<PathBuf>,
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    if let Some(paths) = path {
        for dir in env::split_paths(&paths) {
            #[cfg(windows)]
            {
                for name in ["codex.cmd", "codex.exe", "codex"] {
                    push_unique_candidate(&mut candidates, &mut seen, dir.join(name));
                }
            }
            #[cfg(not(windows))]
            {
                push_unique_candidate(&mut candidates, &mut seen, dir.join("codex"));
            }
        }
    }

    #[cfg(windows)]
    {
        // GUI apps do not inherit later user PATH updates. Check the official
        // Codex desktop and common npm install locations without opening auth
        // files or copying any provider session material.
        if let Some(root) = app_data {
            for name in ["codex.cmd", "codex.exe"] {
                push_unique_candidate(&mut candidates, &mut seen, root.join("npm").join(name));
            }
        }
        if let Some(root) = local_app_data {
            let bin_root = root.join("OpenAI").join("Codex").join("bin");
            push_unique_candidate(&mut candidates, &mut seen, bin_root.join("codex.exe"));
            let mut desktop_candidates = fs::read_dir(&bin_root)
                .ok()
                .into_iter()
                .flatten()
                .filter_map(Result::ok)
                .map(|entry| entry.path().join("codex.exe"))
                .filter(|candidate| candidate.is_file())
                .collect::<Vec<_>>();
            desktop_candidates.sort_by_key(|candidate| std::cmp::Reverse(modified_time(candidate)));
            for candidate in desktop_candidates {
                push_unique_candidate(&mut candidates, &mut seen, candidate);
            }
        }
    }

    #[cfg(not(windows))]
    let _ = (app_data, local_app_data);

    candidates
}

fn codex_candidates() -> Vec<PathBuf> {
    codex_candidates_from(
        env::var_os("PATH"),
        env::var_os("APPDATA").map(PathBuf::from),
        env::var_os("LOCALAPPDATA").map(PathBuf::from),
    )
}

pub(super) fn find_codex_executable() -> Option<PathBuf> {
    codex_candidates()
        .into_iter()
        .find(|candidate| candidate.is_file())
}

pub(super) fn missing_codex_runtime_message() -> String {
    "The official Codex runtime was not found. Install the Codex desktop app or Codex CLI, then reopen Mivlet."
        .to_string()
}

pub(super) fn codex_command(path: &PathBuf) -> Result<Command, String> {
    crate::account_session::ensure_current()?;
    let profile = crate::account_session::root()?
        .join("provider-profiles")
        .join("codex");
    std::fs::create_dir_all(&profile)
        .map_err(|_| "Could not prepare this account's Codex profile.")?;
    let mut command = codex_executable_command(path);
    command
        .env("CODEX_HOME", profile)
        .env_remove("OPENAI_API_KEY")
        .env_remove("CODEX_API_KEY")
        .env_remove("CODEX_ACCESS_TOKEN")
        .args(["-c", "cli_auth_credentials_store=\"keyring\""]);
    Ok(command)
}
