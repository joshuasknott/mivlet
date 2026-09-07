//! User-activated conversation links. Never dispatch arbitrary OS URI schemes.

fn validate_link(value: &str) -> Result<url::Url, String> {
    if value.len() > 8192 || value.chars().any(char::is_control) {
        return Err("This link is invalid.".into());
    }
    let url = url::Url::parse(value).map_err(|_| "This link is invalid.")?;
    if !matches!(url.scheme(), "http" | "https" | "mailto")
        || !url.username().is_empty()
        || url.password().is_some()
        || (url.scheme() != "mailto" && url.host_str().is_none())
    {
        return Err("Only web and email links can be opened from a conversation.".into());
    }
    Ok(url)
}

#[tauri::command]
pub fn open_conversation_link(window: tauri::WebviewWindow, url: String) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Open the link from the Fable conversation.".into());
    }
    let url = validate_link(&url)?;
    #[cfg(windows)]
    {
        let operation: Vec<u16> = "open\0".encode_utf16().collect();
        let target: Vec<u16> = url.as_str().encode_utf16().chain(Some(0)).collect();
        let result = unsafe {
            windows_sys::Win32::UI::Shell::ShellExecuteW(
                std::ptr::null_mut(),
                operation.as_ptr(),
                target.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
            )
        } as isize;
        if result <= 32 {
            return Err(
                "Windows could not open this link. Check your default browser or email app.".into(),
            );
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = url;
        Err("Opening conversation links is currently supported on Windows.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn conversation_links_reject_os_commands_and_disguised_credentials() {
        for value in [
            "file:///C:/Windows/cmd.exe",
            "javascript:alert(1)",
            "data:text/html,test",
            "ms-settings:privacy",
            "https://user:password@example.com",
            "https://example.com\0bad",
        ] {
            assert!(validate_link(value).is_err());
        }
        for value in [
            "https://example.com/report?q=a&b=c",
            "http://localhost:1420",
            "mailto:person@example.com",
        ] {
            assert!(validate_link(value).is_ok());
        }
    }
}
