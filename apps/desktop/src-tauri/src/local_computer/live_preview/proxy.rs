//! Bounded HTTP/WebSocket transport to an executor-verified named pipe only.
use super::Entry;
use std::{
    io::{self, Read, Write},
    net::{Shutdown, TcpListener, TcpStream},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
const HEADERS: usize = 16 * 1024;
const MAX_BYTES: u64 = 64 * 1024 * 1024;
const MAX_CONNECTIONS: usize = 8;

pub(super) fn start(listener: TcpListener, entry: Arc<Entry>) -> Result<(), String> {
    std::thread::Builder::new()
        .name("mivlet-preview".into())
        .stack_size(256 * 1024)
        .spawn(move || {
            let active = Arc::new(AtomicUsize::new(0));
            while entry.current().is_ok() {
                match listener.accept() {
                    Ok((stream, peer)) if peer.ip().is_loopback() => {
                        if active.fetch_add(1, Ordering::AcqRel) >= MAX_CONNECTIONS {
                            active.fetch_sub(1, Ordering::AcqRel);
                            continue;
                        }
                        let entry = entry.clone();
                        let permit = Permit(active.clone());
                        let _ = std::thread::Builder::new()
                            .name("mivlet-preview-request".into())
                            .stack_size(256 * 1024)
                            .spawn(move || {
                                let _permit = permit;
                                let _ = serve(stream, entry);
                            });
                    }
                    Ok(_) => {}
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(25))
                    }
                    Err(_) => break,
                }
            }
        })
        .map(|_| ())
        .map_err(|_| "The isolated preview listener could not start.".into())
}
struct Permit(Arc<AtomicUsize>);
impl Drop for Permit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}
fn current(entry: &Entry) -> io::Result<()> {
    entry
        .current()
        .map_err(|_| io::Error::new(io::ErrorKind::PermissionDenied, "Preview expired."))
}
fn idle(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut | io::ErrorKind::Interrupted
    )
}
fn headers(reader: &mut impl Read, entry: &Entry) -> io::Result<(Vec<u8>, Vec<u8>)> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut received = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        current(entry)?;
        if Instant::now() >= deadline {
            return Err(io::ErrorKind::TimedOut.into());
        }
        match reader.read(&mut chunk) {
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(count) => received.extend_from_slice(&chunk[..count]),
            Err(error) if idle(&error) => continue,
            Err(error) => return Err(error),
        }
        if let Some(end) = received
            .windows(4)
            .position(|part| part == b"\r\n\r\n")
            .map(|index| index + 4)
        {
            if end > HEADERS {
                return Err(io::ErrorKind::InvalidData.into());
            }
            let body = received.split_off(end);
            return Ok((received, body));
        }
        if received.len() > HEADERS {
            return Err(io::ErrorKind::InvalidData.into());
        }
    }
}
struct Request {
    path: String,
    websocket: bool,
    bytes: Vec<u8>,
}
fn request(bytes: &[u8], origin: &str) -> Result<Request, &'static str> {
    let text = std::str::from_utf8(bytes).map_err(|_| "Invalid preview request.")?;
    let mut lines = text.split("\r\n");
    let mut start = lines.next().ok_or("Missing preview request.")?.split(' ');
    let method = start.next().ok_or("Missing preview method.")?;
    let path = start.next().ok_or("Missing preview path.")?;
    if !matches!(
        method,
        "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS"
    ) || start.next() != Some("HTTP/1.1")
        || start.next().is_some()
        || !path.starts_with('/')
        || path.starts_with("//")
        || path.len() > 4096
        || path.chars().any(|ch| ch.is_control() || ch == '\\')
    {
        return Err("Unsupported preview request.");
    }
    let expected = url::Url::parse(origin).map_err(|_| "Invalid native preview origin.")?;
    let expected_host = format!(
        "{}:{}",
        expected.host_str().ok_or("Missing preview host.")?,
        expected.port().ok_or("Missing preview port.")?
    );
    let mut host = false;
    let mut content_length = false;
    let mut transfer = false;
    let mut upgrade = false;
    let mut connection_upgrade = false;
    let mut forwarded = Vec::new();
    for line in lines.filter(|line| !line.is_empty()) {
        if line.starts_with([' ', '\t']) {
            return Err("Folded preview headers are unsupported.");
        }
        let (name, value) = line.split_once(':').ok_or("Invalid preview header.")?;
        let value = value.trim();
        let name = name.to_ascii_lowercase();
        if name.is_empty()
            || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            || value.chars().any(char::is_control)
        {
            return Err("Invalid preview header.");
        }
        match name.as_str() {
            "host" => {
                if host || value != expected_host {
                    return Err("This preview request targets another origin.");
                }
                host = true;
            }
            "origin" => {
                if value != origin {
                    return Err("Cross-origin preview input is blocked.");
                }
            }
            "content-length" => {
                if content_length
                    || value
                        .parse::<u64>()
                        .ok()
                        .is_none_or(|n| n > 8 * 1024 * 1024)
                {
                    return Err("Preview request body exceeds its bound.");
                }
                content_length = true;
            }
            "transfer-encoding" => {
                if transfer || !value.eq_ignore_ascii_case("chunked") {
                    return Err("Unsupported preview body encoding.");
                }
                transfer = true;
            }
            "upgrade" => {
                if !value.eq_ignore_ascii_case("websocket") {
                    return Err("Unsupported preview upgrade.");
                }
                upgrade = true;
            }
            "connection" => {
                connection_upgrade = value
                    .split(',')
                    .any(|part| part.trim().eq_ignore_ascii_case("upgrade"));
                continue;
            }
            "accept-encoding"
            | "proxy-authorization"
            | "proxy-connection"
            | "forwarded"
            | "x-forwarded-host"
            | "x-forwarded-proto" => continue,
            _ => {}
        }
        forwarded.push(format!("{name}: {value}"));
    }
    if !host || content_length && transfer || upgrade != connection_upgrade {
        return Err("Ambiguous preview request.");
    }
    let websocket = upgrade && connection_upgrade;
    forwarded.push("accept-encoding: identity".into());
    forwarded.push(format!(
        "connection: {}",
        if websocket { "Upgrade" } else { "close" }
    ));
    Ok(Request {
        path: path.into(),
        websocket,
        bytes: format!(
            "{method} {path} HTTP/1.1\r\n{}\r\n\r\n",
            forwarded.join("\r\n")
        )
        .into_bytes(),
    })
}
fn policy(origin: &str) -> String {
    let socket = origin.replacen("http://", "ws://", 1);
    format!("default-src 'none'; sandbox allow-scripts allow-same-origin allow-forms; script-src {origin} 'unsafe-inline' 'unsafe-eval' blob:; style-src {origin} 'unsafe-inline'; img-src {origin} data: blob:; font-src {origin} data:; connect-src {origin} {socket}; frame-src 'none'; object-src 'none'; base-uri {origin}; form-action {origin}; media-src {origin} blob:; worker-src {origin} blob:")
}
fn response(bytes: &[u8], origin: &str, websocket: bool) -> Result<Vec<u8>, &'static str> {
    let text = std::str::from_utf8(bytes).map_err(|_| "Invalid app response.")?;
    let mut lines = text.split("\r\n");
    let start = lines.next().ok_or("Missing app response.")?;
    if !start.starts_with("HTTP/1.1 ") && !start.starts_with("HTTP/1.0 ") {
        return Err("Unsupported app response.");
    }
    let status = start
        .split(' ')
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or("Invalid app status.")?;
    if (!(200..=599).contains(&status) && status != 101) || (status == 101) != websocket {
        return Err("Invalid app upgrade.");
    }
    let mut output = vec![start.to_owned()];
    let mut length = false;
    let mut transfer = false;
    for line in lines.filter(|line| !line.is_empty()) {
        let (name, value) = line.split_once(':').ok_or("Invalid app header.")?;
        let lower = name.to_ascii_lowercase();
        if name.is_empty()
            || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            || value.chars().any(char::is_control)
        {
            return Err("Invalid app header.");
        }
        match lower.as_str() {
            "content-length" => {
                if length
                    || value
                        .trim()
                        .parse::<u64>()
                        .ok()
                        .is_none_or(|n| n > MAX_BYTES)
                {
                    return Err("App response exceeds preview bounds.");
                }
                length = true;
            }
            "transfer-encoding" => {
                if transfer || !value.trim().eq_ignore_ascii_case("chunked") {
                    return Err("Unsupported app encoding.");
                }
                transfer = true;
            }
            "access-control-allow-origin"
            | "access-control-allow-credentials"
            | "referrer-policy"
            | "cache-control"
            | "x-content-type-options"
            | "permissions-policy"
            | "content-security-policy-report-only"
            | "report-to"
            | "reporting-endpoints"
            | "nel" => continue,
            "content-security-policy" => {
                let preserved = value
                    .split(';')
                    .filter(|directive| {
                        !matches!(
                            directive
                                .trim()
                                .split_ascii_whitespace()
                                .next()
                                .map(str::to_ascii_lowercase)
                                .as_deref(),
                            Some("report-uri" | "report-to")
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(";");
                output.push(format!("{name}: {preserved}"));
                continue;
            }
            _ => {}
        }
        output.push(line.into());
    }
    if length && transfer {
        return Err("Ambiguous app response.");
    }
    output.push(format!("Content-Security-Policy: {}", policy(origin)));
    output.push("Referrer-Policy: no-referrer".into());
    output.push("Cache-Control: no-store".into());
    output.push("X-Content-Type-Options: nosniff".into());
    output.push("Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), clipboard-read=(), clipboard-write=()".into());
    Ok(format!("{}\r\n\r\n", output.join("\r\n")).into_bytes())
}
fn count(entry: &Entry, bytes: usize) -> io::Result<()> {
    if entry
        .bytes
        .fetch_add(bytes as u64, Ordering::AcqRel)
        .saturating_add(bytes as u64)
        > MAX_BYTES
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Preview transfer limit reached.",
        ));
    }
    Ok(())
}
fn copy(mut reader: impl Read, mut writer: impl Write, entry: &Entry) -> io::Result<()> {
    let mut bytes = [0u8; 64 * 1024];
    loop {
        current(entry)?;
        match reader.read(&mut bytes) {
            Ok(0) => return Ok(()),
            Ok(size) => {
                count(entry, size)?;
                writer.write_all(&bytes[..size])?;
            }
            Err(error) if idle(&error) => continue,
            Err(error) => return Err(error),
        }
    }
}
fn serve(mut socket: TcpStream, entry: Arc<Entry>) -> io::Result<()> {
    socket.set_read_timeout(Some(Duration::from_millis(250)))?;
    socket.set_write_timeout(Some(Duration::from_secs(2)))?;
    let (head, body) = headers(&mut socket, &entry)?;
    let request =
        request(&head, &entry.descriptor.origin).map_err(|_| io::ErrorKind::PermissionDenied)?;
    if request.path.starts_with("/__mivlet_preview/") {
        if request.path != "/__mivlet_preview/picker.js"
            || request.websocket
            || !body.is_empty()
            || !request.bytes.starts_with(b"GET ")
        {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        let script = super::picker::script(
            &entry.descriptor.id,
            &entry.descriptor.job_id,
            entry.descriptor.job_generation,
            &entry.descriptor.revision,
        );
        current(&entry)?;
        return socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/javascript; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n{script}",script.len()).as_bytes());
    }
    current(&entry)?;
    let mut upstream = entry
        .session
        .open_preview(&entry.binding)
        .map_err(|_| io::ErrorKind::PermissionDenied)?;
    count(&entry, request.bytes.len() + body.len())?;
    upstream.write_all(&request.bytes)?;
    upstream.write_all(&body)?;
    let mut incoming = socket.try_clone()?;
    let stop_socket = socket.try_clone()?;
    let writer = upstream.try_clone()?;
    let input_entry = entry.clone();
    let input = std::thread::Builder::new()
        .name("mivlet-preview-input".into())
        .stack_size(256 * 1024)
        .spawn(move || {
            let _ = copy(&mut incoming, writer, &input_entry);
            let _ = incoming.shutdown(Shutdown::Both);
        })?;
    let result = (|| {
        let (head, body) = headers(&mut upstream, &entry)?;
        let head = response(&head, &entry.descriptor.origin, request.websocket)
            .map_err(|_| io::ErrorKind::InvalidData)?;
        count(&entry, head.len() + body.len())?;
        socket.write_all(&head)?;
        socket.write_all(&body)?;
        copy(upstream, &mut socket, &entry)
    })();
    let _ = stop_socket.shutdown(Shutdown::Both);
    let _ = input.join();
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    const ORIGIN: &str = "http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost:41234";
    #[test]
    fn host_origin_body_and_upgrade_are_exact_without_host_port_forwarding() {
        let valid=format!("GET /src/main.ts?version=1 HTTP/1.1\r\nHost: {}\r\nOrigin: {ORIGIN}\r\nAccept-Encoding: gzip\r\n\r\n",ORIGIN.trim_start_matches("http://"));
        let parsed = request(valid.as_bytes(), ORIGIN).unwrap();
        assert!(!parsed.websocket);
        let text = String::from_utf8(parsed.bytes).unwrap();
        assert!(text.contains("accept-encoding: identity"));
        assert!(!text.contains("gzip"));
        for changed in [
            valid.replace(ORIGIN, "http://127.0.0.1:1420"),
            valid.replace("GET /src/main.ts?version=1", "CONNECT 127.0.0.1:1420"),
            valid.replace(
                "\r\n\r\n",
                "\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n",
            ),
            valid.replace("\r\nOrigin:", "\r\nHost: other\r\nOrigin:"),
        ] {
            assert!(request(changed.as_bytes(), ORIGIN).is_err());
        }
    }
    #[test]
    fn response_policy_never_grants_external_network_or_native_protocols() {
        let guarded = response(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nAccess-Control-Allow-Origin: *\r\n\r\n",
            ORIGIN,
            false,
        )
        .unwrap();
        let guarded = String::from_utf8(guarded).unwrap();
        assert!(guarded.contains("frame-src 'none'"));
        assert!(guarded.contains(&format!("connect-src {ORIGIN} ws://")));
        assert!(!guarded.contains("Allow-Origin: *"));
        for forbidden in ["ipc:", "tauri:", "https:", "127.0.0.1:1420"] {
            assert!(!guarded.contains(forbidden));
        }
        assert!(response(b"HTTP/1.1 101 Switching Protocols\r\n\r\n", ORIGIN, false).is_err());
    }
}
