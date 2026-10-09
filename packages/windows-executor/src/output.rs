//! Bounded pull-based output. A disconnected/slow observer never owns a pipe or
//! blocks a process. Sequences describe pipe-observation order, not an ordering
//! Windows cannot guarantee between separate stdout and stderr handles.
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};

pub const OUTPUT_BYTES: usize = 64 * 1024;
const LINE_BYTES: usize = 8 * 1024;
const FRAME_COUNT: usize = 512;
const PAGE_BYTES: usize = 32 * 1024;
const OMITTED: &str = "[output stream omitted: oversized, invalid or control-bearing line]\n";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OutputStream {
    Stdout,
    Stderr,
}
impl OutputStream {
    fn index(self) -> usize {
        match self {
            Self::Stdout => 0,
            Self::Stderr => 1,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputFrame {
    pub sequence: u64,
    pub stream: OutputStream,
    pub text: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputPage {
    pub frames: Vec<OutputFrame>,
    pub next_cursor: u64,
    pub dropped: bool,
    pub closed: bool,
    pub redacted: bool,
}
type Redactor = Box<dyn FnMut(OutputStream, &str) -> String + Send>;
struct Inner {
    pending: [Vec<u8>; 2],
    suppressed: [bool; 2],
    ended: [bool; 2],
    redactor: Redactor,
    frames: VecDeque<OutputFrame>,
    bytes: usize,
    sequence: u64,
    summary: String,
    truncated: bool,
    redacted: bool,
    closed: bool,
}
/// The sanitizer sees complete bounded UTF-8 lines, including a final partial
/// line only at EOF. Never publish a partial token then attempt to redact it.
/// Native callers must supply their shared secret redactor. It must be bounded
/// and must not perform IPC, disk I/O or acquire an authority lock.
#[derive(Clone)]
pub struct OutputLog(Arc<Mutex<Inner>>);
impl OutputLog {
    pub fn new(redactor: impl FnMut(OutputStream, &str) -> String + Send + 'static) -> Self {
        Self(Arc::new(Mutex::new(Inner {
            pending: [Vec::new(), Vec::new()],
            suppressed: [false; 2],
            ended: [false; 2],
            redactor: Box::new(redactor),
            frames: VecDeque::new(),
            bytes: 0,
            sequence: 0,
            summary: String::new(),
            truncated: false,
            redacted: false,
            closed: false,
        })))
    }
    pub fn read(&self, after: u64) -> Result<OutputPage, String> {
        let inner = self
            .0
            .lock()
            .map_err(|_| "Command output is unavailable.")?;
        if after > inner.sequence {
            return Err("Output cursor is ahead of this job.".into());
        }
        let first = inner
            .frames
            .front()
            .map_or(inner.sequence + 1, |frame| frame.sequence);
        let mut bytes = 0;
        let frames: Vec<_> = inner
            .frames
            .iter()
            .filter(|frame| frame.sequence > after)
            .take_while(|frame| {
                bytes += frame.text.len();
                bytes <= PAGE_BYTES
            })
            .cloned()
            .collect();
        let next_cursor = frames.last().map_or(after, |frame| frame.sequence);
        Ok(OutputPage {
            frames,
            next_cursor,
            dropped: after + 1 < first,
            closed: inner.closed && next_cursor == inner.sequence,
            redacted: inner.redacted,
        })
    }
    pub(crate) fn push(&self, stream: OutputStream, bytes: &[u8]) {
        let Ok(mut inner) = self.0.lock() else { return };
        let index = stream.index();
        if inner.closed || inner.ended[index] || inner.suppressed[index] {
            return;
        }
        for &byte in bytes {
            // Fail closed for the rest of this stream after an ambiguous line.
            // Continuing after truncating a PEM header could expose its body.
            if inner.pending[index].len() >= LINE_BYTES
                || (byte < 32 && !matches!(byte, b'\n' | b'\r' | b'\t'))
                || byte == 127
            {
                inner.suppress(stream);
                break;
            }
            inner.pending[index].push(byte);
            if byte == b'\n' {
                inner.line(stream);
            }
            if inner.suppressed[index] {
                break;
            }
        }
    }
    pub(crate) fn end(&self, stream: OutputStream) {
        if let Ok(mut inner) = self.0.lock() {
            if !inner.ended[stream.index()] && !inner.closed {
                inner.line(stream);
                inner.ended[stream.index()] = true;
            }
        }
    }
    pub fn close(&self) {
        self.end(OutputStream::Stdout);
        self.end(OutputStream::Stderr);
        if let Ok(mut inner) = self.0.lock() {
            inner.closed = true;
        }
    }
    pub(crate) fn summary(&self) -> Result<(String, bool), String> {
        let inner = self
            .0
            .lock()
            .map_err(|_| "Command output is unavailable.")?;
        Ok((inner.summary.clone(), inner.truncated))
    }
}
impl Inner {
    fn suppress(&mut self, stream: OutputStream) {
        self.pending[stream.index()].clear();
        self.suppressed[stream.index()] = true;
        self.redacted = true;
        self.append(stream, OMITTED.into());
        self.truncated = true;
    }
    fn line(&mut self, stream: OutputStream) {
        let bytes = std::mem::take(&mut self.pending[stream.index()]);
        if bytes.is_empty() {
            return;
        }
        match String::from_utf8(bytes) {
            Ok(text) => {
                let safe = (self.redactor)(stream, &text);
                self.redacted |= safe != text;
                if safe.len() > LINE_BYTES {
                    self.suppress(stream);
                } else if !safe.is_empty() {
                    self.append(stream, safe);
                }
            }
            Err(_) => self.suppress(stream),
        }
    }
    fn append(&mut self, stream: OutputStream, text: String) {
        // Retain complete redacted frames; never cut through a redaction token.
        if !self.truncated && self.summary.len() + text.len() <= OUTPUT_BYTES {
            self.summary.push_str(&text);
        } else {
            self.truncated = true;
        }
        while self.bytes + text.len() > OUTPUT_BYTES || self.frames.len() >= FRAME_COUNT {
            if let Some(old) = self.frames.pop_front() {
                self.bytes -= old.text.len();
            } else {
                break;
            }
        }
        self.sequence += 1;
        self.bytes += text.len();
        self.frames.push_back(OutputFrame {
            sequence: self.sequence,
            stream,
            text,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn log() -> OutputLog {
        OutputLog::new(|_, text| text.replace("secret-value", "[REDACTED]"))
    }
    #[test]
    fn fragmented_tokens_and_utf8_are_not_observable_until_complete() {
        let output = log();
        output.push(OutputStream::Stdout, b"sec");
        assert!(output.read(0).unwrap().frames.is_empty());
        output.push(OutputStream::Stdout, b"ret-value \xe2\x82");
        output.push(OutputStream::Stdout, b"\xac\n");
        assert_eq!(output.read(0).unwrap().frames[0].text, "[REDACTED] €\n");
        output.push(OutputStream::Stderr, b"last");
        output.end(OutputStream::Stderr);
        output.close();
        let page = output.read(0).unwrap();
        assert_eq!(page.next_cursor, 2);
        assert!(page.closed && page.redacted);
        assert_eq!(page.frames[1].text, "last");
        output.push(OutputStream::Stdout, b"late\n");
        assert!(output.read(2).unwrap().frames.is_empty());
        assert!(output.read(3).is_err());
    }
    #[test]
    fn slow_disconnected_readers_do_not_stop_drain_and_get_explicit_gaps() {
        let output = log();
        for i in 0..10_000 {
            output.push(
                OutputStream::Stdout,
                format!("{i}: {}\n", "x".repeat(100)).as_bytes(),
            );
        }
        let mut cursor = 0;
        let first = output.read(cursor).unwrap();
        assert!(first.dropped);
        assert!(output.summary().unwrap().1);
        assert!(output.0.lock().unwrap().bytes <= OUTPUT_BYTES);
        let mut last = String::new();
        loop {
            let page = output.read(cursor).unwrap();
            if page.frames.is_empty() {
                break;
            }
            for frame in page.frames {
                assert!(frame.sequence > cursor);
                cursor = frame.sequence;
                last = frame.text;
            }
        }
        assert!(last.starts_with("9999:"));
        assert_eq!(cursor, 10_000);
    }
    #[test]
    fn oversized_or_ambiguous_lines_never_publish_prefixes_or_later_secret_bodies() {
        for bytes in [
            vec![b'x'; LINE_BYTES + 1],
            vec![0xff, b'\n'],
            b"ok\x1b[0mhidden\n".to_vec(),
        ] {
            let output = log();
            output.push(OutputStream::Stdout, &bytes);
            output.push(OutputStream::Stdout, b"secret body\n");
            output.close();
            assert_eq!(output.read(0).unwrap().frames.len(), 1);
            assert_eq!(output.read(0).unwrap().frames[0].text, OMITTED);
        }
    }
}
