//! Self-contained generated HTML; authority comes from a saved assistant revision.
pub(crate) const CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; media-src 'none'; worker-src 'none'";
const MAX_HTML_BYTES: usize = 80_000;

pub(crate) fn extract(source: &str) -> Result<String, String> {
    let marker = "```mivlet-html";
    let mut parts = source.split(marker);
    let _before = parts.next();
    let body = parts
        .next()
        .ok_or("This response has no custom HTML preview.")?;
    if parts.next().is_some() {
        return Err("Use one custom HTML preview per response.".into());
    }
    let body = body
        .strip_prefix("\r\n")
        .or_else(|| body.strip_prefix('\n'))
        .ok_or("The HTML preview fence is invalid.")?;
    let (html, _) = body
        .split_once("```")
        .ok_or("Wait for the complete HTML response before opening it.")?;
    if html.trim().is_empty() || html.len() > MAX_HTML_BYTES || html.contains('\0') {
        return Err("The HTML preview exceeds its supported bounds.".into());
    }
    Ok(html.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn extracts_only_one_complete_bounded_html_fence() {
        assert_eq!(
            extract("Intro\n```mivlet-html\n<p>Hi</p>\n```\nAfter").unwrap(),
            "<p>Hi</p>\n"
        );
        for source in [
            "```html\n<p>Hi</p>\n```",
            "```mivlet-htmlExtra\nHi\n```",
            "```mivlet-html\nHi",
            "```mivlet-html\n\0\n```",
            "```mivlet-html\nHi\n```\n```mivlet-html\nAgain\n```",
        ] {
            assert!(extract(source).is_err());
        }
        assert!(extract(&format!(
            "```mivlet-html\n{}\n```",
            "x".repeat(MAX_HTML_BYTES)
        ))
        .is_err());
    }
    #[test]
    fn policy_rejects_network_native_bridge_frames_and_forms() {
        for rule in [
            "default-src 'none'",
            "connect-src 'none'",
            "frame-src 'none'",
            "form-action 'none'",
            "worker-src 'none'",
        ] {
            assert!(CSP.contains(rule));
        }
        for forbidden in [
            "http:",
            "https:",
            "'self'",
            "ipc:",
            "tauri:",
            "'unsafe-eval'",
        ] {
            assert!(!CSP.contains(forbidden));
        }
    }
}
