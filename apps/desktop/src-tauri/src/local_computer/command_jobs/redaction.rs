use mivlet_windows_executor::{output::OutputStream, OutputLog};

pub(in crate::local_computer) fn output_log() -> OutputLog {
    let mut pem = [false; 2];
    let mut continuation = [false; 2];
    OutputLog::new(move |stream, text| {
        let index = if stream == OutputStream::Stdout { 0 } else { 1 };
        redact_line(text, &mut pem[index], &mut continuation[index])
    })
}
fn redact_line(text: &str, pem: &mut bool, continuation: &mut bool) -> String {
    // PEM suppression is stateful across lines and pipe chunks. Missing footer
    // keeps this stream suppressed. The other stream has independent framing.
    let lower = text.to_ascii_lowercase();
    let header = lower.contains("-----begin");
    if *pem || header {
        *pem = !lower.contains("-----end");
        return "[REDACTED]\n".into();
    }
    if *continuation {
        *continuation = !text.trim().is_empty();
        return "[REDACTED]\n".into();
    }
    // Split assignment/header values are ambiguous. Suppress the following
    // block until a blank line rather than publish an unlabelled secret body.
    let trimmed = text.trim_end();
    let empty_assignment = trimmed
        .strip_suffix([':', '='])
        .is_some_and(|key| crate::secret_redaction::is_sensitive_key(key.trim()));
    if empty_assignment || trimmed.eq_ignore_ascii_case("Bearer") {
        *continuation = true;
        return "[REDACTED]\n".into();
    }
    crate::secret_redaction::redact_secret_text_or_omit(text)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn multiline_private_keys_and_split_header_values_never_escape() {
        let (mut pem, mut continuation) = (false, false);
        for line in [
            "-----BEGIN PRIVATE KEY-----\n",
            "arbitrary-key-body\n",
            "-----END PRIVATE KEY-----\n",
            "Authorization:\n",
            "unlabelled-value\n",
            "\n",
        ] {
            assert_eq!(
                redact_line(line, &mut pem, &mut continuation),
                "[REDACTED]\n"
            );
        }
        assert_eq!(
            redact_line("Tests passed\n", &mut pem, &mut continuation),
            "Tests passed\n"
        );
    }
    #[test]
    fn ordinary_and_secret_lines_use_shared_vocabulary() {
        let result = redact_line("token=synthetic-canary-value\n", &mut false, &mut false);
        assert!(!result.contains("synthetic-canary-value"));
        assert_eq!(
            redact_line("build successful\n", &mut false, &mut false),
            "build successful\n"
        );
    }
}
