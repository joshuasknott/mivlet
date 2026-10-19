use std::{
    collections::HashSet,
    ffi::OsString,
    path::{Path, PathBuf},
};

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
            desktop_candidates.sort_by_cached_key(|candidate| {
                (
                    std::cmp::Reverse(modified_time(candidate)),
                    candidate.clone(),
                )
            });
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
    // PATH entries may be relative (for example, `.`). Resolve the selected
    // candidate while the parent process is still in its original directory;
    // discovery callers may move Codex into an isolated child directory after
    // this function returns.
    let process_directory = env::current_dir().ok();
    codex_candidates()
        .into_iter()
        .filter(|candidate| candidate.is_file())
        .find_map(|candidate| resolve_candidate_path(candidate, process_directory.as_deref()))
}

fn resolve_candidate_path(candidate: PathBuf, process_directory: Option<&Path>) -> Option<PathBuf> {
    if candidate.is_absolute() {
        Some(candidate)
    } else {
        let resolved = process_directory?.join(candidate);
        resolved.is_absolute().then_some(resolved)
    }
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
    // TOML literal strings survive the additional argument parsing in npm's
    // Windows .cmd shim while retaining the same value for direct executables.
    command
        .env("CODEX_HOME", profile)
        .env_remove("OPENAI_API_KEY")
        .env_remove("CODEX_API_KEY")
        .env_remove("CODEX_ACCESS_TOKEN")
        .args(["-c", "cli_auth_credentials_store='keyring'"]);
    Ok(command)
}

#[cfg(test)]
mod tests {
    use super::resolve_candidate_path;
    use std::{fs, path::PathBuf};

    #[test]
    fn relative_path_candidate_stays_bound_to_original_directory() {
        let original_directory = tempfile::tempdir().expect("original directory");
        let child_directory = tempfile::tempdir().expect("child directory");
        #[cfg(windows)]
        let relative_candidate = PathBuf::from("codex.cmd");
        #[cfg(not(windows))]
        let relative_candidate = PathBuf::from("codex");
        let expected = original_directory.path().join(&relative_candidate);
        fs::write(&expected, b"codex test target").expect("write candidate");

        let resolved =
            resolve_candidate_path(relative_candidate.clone(), Some(original_directory.path()));
        let resolved = resolved.expect("relative candidate needs an original directory");

        assert!(resolved.is_absolute());
        assert_eq!(resolved, expected);
        assert!(resolved.is_file());
        assert!(!child_directory.path().join(relative_candidate).is_file());

        let mut command = super::super::codex_executable_command(&resolved);
        command.current_dir(child_directory.path());
        assert_eq!(command.get_program(), resolved.as_os_str());
        assert!(command.get_args().next().is_none());
    }

    #[cfg(windows)]
    #[test]
    fn cmd_candidate_executes_from_another_directory_with_shell_sensitive_inputs() {
        let root = tempfile::tempdir().expect("temporary root");
        let script_directory = root.path().join("mivlet & provider");
        let child_directory = root.path().join("different working directory");
        fs::create_dir_all(&script_directory).expect("script directory");
        fs::create_dir_all(&child_directory).expect("child directory");
        fs::write(child_directory.join("cwd-marker.txt"), b"marker").expect("cwd marker");
        let script = script_directory.join("codex.cmd");
        fs::write(
            &script,
            "@echo off\r\n\
if not \"%~1\"==\"literal & value\" exit /b 11\r\n\
if not \"%~2\"==\"%%NAME%%\" exit /b 12\r\n\
if not \"%~3\"==\"spaced value\" exit /b 13\r\n\
if not \"%~4\"==\"-c\" exit /b 14\r\n\
if not exist \"cwd-marker.txt\" exit /b 15\r\n\
> \"%~dp0embedded-argument.txt\" echo(%~5\r\n\
exit /b 0\r\n",
        )
        .expect("write script");

        let mut command = super::super::codex_executable_command(&script);
        command
            .current_dir(&child_directory)
            .env("NAME", "must-not-expand")
            .args([
                "literal & value",
                "%NAME%",
                "spaced value",
                "-c",
                "cli_auth_credentials_store='keyring'",
            ]);
        let status = command.status().expect("run temporary cmd candidate");

        assert!(status.success(), "temporary cmd exited with {status}");
        let embedded_argument = fs::read_to_string(script_directory.join("embedded-argument.txt"))
            .expect("read embedded argument");
        assert_eq!(
            embedded_argument.trim(),
            "cli_auth_credentials_store='keyring'"
        );
    }

    #[test]
    fn relative_path_candidate_is_rejected_without_original_directory() {
        assert!(resolve_candidate_path(PathBuf::from("codex"), None).is_none());
    }

    #[cfg(windows)]
    #[test]
    fn drive_relative_candidate_is_rejected_instead_of_rebinding() {
        let directory = std::env::current_dir().expect("current directory");
        assert!(resolve_candidate_path(PathBuf::from(r"C:codex.cmd"), Some(&directory)).is_none());
    }
}
