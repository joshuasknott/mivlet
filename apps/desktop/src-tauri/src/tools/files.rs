//! Workspace-confined file tools.
//!
//! These handlers own only bounded file inspection and writes. Approval,
//! path-confinement and native computer authority remain in the parent
//! dispatcher; this module never expands the tool surface or accesses a host
//! shell.

use std::path::Path;

use super::{require_string_argument, ToolResult};

pub(super) const MAX_TOOL_OUTPUT_BYTES: usize = 1024 * 1024;
pub(super) const MAX_TOOL_INPUT_BYTES: usize = 8 * 1024 * 1024;

pub(super) fn bounded_output(bytes: &[u8], max_bytes: usize) -> String {
    if bytes.len() <= max_bytes {
        return String::from_utf8_lossy(bytes).into_owned();
    }
    let head = &bytes[..max_bytes];
    format!(
        "{}\n\n[truncated: output exceeded {} bytes]",
        String::from_utf8_lossy(head),
        max_bytes
    )
}

pub(super) fn run_read_file(
    arguments: &serde_json::Value,
    workspace_root: &Path,
) -> Result<ToolResult, String> {
    let path = require_string_argument(arguments, "path")?;
    let confined = super::confine_path(&path, workspace_root)?;
    let extension = confined
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if matches!(extension.as_str(), "png" | "jpg" | "jpeg") {
        let bytes = crate::local_computer::artifacts::read_bounded_limit(
            workspace_root,
            &confined,
            4 * 1024 * 1024,
        )?;
        return Ok(ToolResult {
            ok: true,
            output: crate::local_computer::office_images::inspect(&bytes, &extension)?,
        });
    }
    if crate::local_computer::office_inspection::is_office(&extension) || extension == "pdf" {
        let file = std::fs::File::open(&confined).map_err(|_| format!("File not found: {path}"))?;
        let mut bytes = Vec::new();
        std::io::Read::read_to_end(
            &mut std::io::Read::take(file, (MAX_TOOL_INPUT_BYTES + 1) as u64),
            &mut bytes,
        )
        .map_err(|_| "Mivlet could not read the Office file.")?;
        if bytes.len() > MAX_TOOL_INPUT_BYTES {
            return Err("Office and PDF inspection support files up to 8 MB.".into());
        }
        return Ok(ToolResult {
            ok: true,
            output: if extension == "pdf" {
                crate::local_computer::pdf_inspection::inspect(&bytes)?
            } else {
                crate::local_computer::office_inspection::inspect(&bytes, &extension)?
            },
        });
    }
    let mut file = std::fs::File::open(&confined).map_err(|_| format!("File not found: {path}"))?;
    let mut buf = Vec::new();
    std::io::Read::read_to_end(
        &mut std::io::Read::take(&mut file, (MAX_TOOL_OUTPUT_BYTES + 1) as u64),
        &mut buf,
    )
    .map_err(|err| err.to_string())?;
    Ok(ToolResult {
        ok: true,
        output: bounded_output(&buf, MAX_TOOL_OUTPUT_BYTES),
    })
}

pub(super) fn run_write_file(
    arguments: &serde_json::Value,
    workspace_root: &Path,
) -> Result<ToolResult, String> {
    let path = require_string_argument(arguments, "path")?;
    let content = require_string_argument(arguments, "content")?;
    if content.len() > MAX_TOOL_INPUT_BYTES {
        return Err(format!(
            "write-file content is too large ({} bytes; max {} bytes).",
            content.len(),
            MAX_TOOL_INPUT_BYTES
        ));
    }
    let confined = super::confine_path(&path, workspace_root)?;
    if let Some(parent) = confined.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    std::fs::write(&confined, &content).map_err(|err| err.to_string())?;
    Ok(ToolResult {
        ok: true,
        output: format!("Wrote {} bytes to {path}.", content.len()),
    })
}
