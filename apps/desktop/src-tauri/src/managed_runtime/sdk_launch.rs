//! Claude's process contract; shared actions stay in Mivlet's native executor.
use std::{path::Path, process::Command};

pub(super) fn executable_allowed(provider: &str, path: &Path) -> bool {
    if provider != "claude" || !cfg!(windows) {
        return true;
    }
    // A Windows batch shim reparses model arguments through cmd.exe. Only the
    // official native executable can carry this SDK contract without a shell.
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("exe"))
}

pub(super) fn configure(command: &mut Command, model: &str) {
    command.args([
        "--print",
        "--no-session-persistence",
        "--no-chrome",
        "--output-format",
        "stream-json",
        "--verbose",
        "--input-format",
        "stream-json",
        "--include-partial-messages",
        "--permission-prompt-tool",
        "stdio",
        "--permission-mode",
        "default",
        "--setting-sources=",
        "--strict-mcp-config",
        "--mcp-config",
        r#"{"mcpServers":{"mivlet":{"type":"sdk","name":"mivlet"}}}"#,
        "--tools=",
    ]);
    let model = model.trim();
    if !model.is_empty() {
        // Keep a dash-leading value bound to its option, never a second flag.
        command.arg(format!("--model={model}"));
    }
    command
        .env_remove("CLAUDECODE")
        .env("CLAUDE_CODE_SKIP_PROMPT_HISTORY", "1");
}

#[cfg(test)]
#[path = "sdk_launch_tests.rs"]
mod tests;
