use super::*;

// Metadata discovery never consumes turn output. Bound both individual frames
// and queued raw bytes before JSON allocation; a noisy provider must not grow
// Mivlet's heap while the caller is processing an earlier response.
const MAX_FRAME_BYTES: usize = 1024 * 1024;
const QUEUED_FRAMES: usize = 8;
type Frame = Result<Vec<u8>, &'static str>;

pub(super) struct CodexAppServerClient {
    child: crate::provider_process::SupervisedChild,
    stdin: Arc<Mutex<ChildStdin>>,
    receiver: mpsc::Receiver<Frame>,
    reader: Option<thread::JoinHandle<()>>,
    _directory: tempfile::TempDir,
}

impl CodexAppServerClient {
    pub(super) fn start(path: &PathBuf) -> Result<Self, String> {
        let directory = tempfile::Builder::new()
            .prefix("mivlet-codex-discovery-")
            .tempdir()
            .map_err(|_| "Could not prepare Codex discovery directory.".to_string())?;
        let mut command = codex_command(path)?;
        configure_discovery(&mut command, directory.path());
        let mut child = crate::provider_process::SupervisedChild::spawn(command)
            .map_err(|_| "Mivlet could not start Codex app-server.".to_string())?;
        let stdin = Arc::new(Mutex::new(
            child
                .stdin
                .take()
                .ok_or("Codex app-server stdin was unavailable.")?,
        ));
        let stdout = child
            .stdout
            .take()
            .ok_or("Codex app-server stdout was unavailable.")?;
        let (sender, receiver) = mpsc::sync_channel(QUEUED_FRAMES);
        let reader = thread::spawn(move || read_frames(BufReader::new(stdout), sender));
        Ok(Self {
            child,
            stdin,
            receiver,
            reader: Some(reader),
            _directory: directory,
        })
    }
}

fn configure_discovery(command: &mut Command, directory: &std::path::Path) {
    // Keep the account-owned CODEX_HOME and keyring settings from codex_command.
    // This process only reads auth/model metadata; actual turns retain their
    // existing tools, project context and execution configuration.
    command
        .current_dir(directory)
        .args([
            "-c",
            "features.shell_tool=false",
            "-c",
            "features.unified_exec=false",
            "-c",
            "features.memories=false",
            "-c",
            "project_doc_max_bytes=0",
            "-c",
            "mcp_servers={}",
            "app-server",
            "--stdio",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
}

fn read_frames(mut reader: impl BufRead, sender: mpsc::SyncSender<Frame>) {
    loop {
        let mut line = Vec::new();
        let count = reader
            .by_ref()
            .take(MAX_FRAME_BYTES as u64 + 1)
            .read_until(b'\n', &mut line);
        match count {
            Ok(0) | Err(_) => break,
            Ok(_) if line.len() > MAX_FRAME_BYTES => {
                let _ = sender.send(Err("Codex metadata response exceeded the 1 MiB limit."));
                break;
            }
            Ok(_) => {
                if sender.send(Ok(line)).is_err() {
                    break;
                }
            }
        }
    }
}

fn receive_response(
    receiver: &mpsc::Receiver<Frame>,
    id: i64,
    deadline: Instant,
) -> Result<Value, String> {
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("Codex app-server did not return the requested response.".into());
        }
        let line = receiver
            .recv_timeout(remaining)
            .map_err(|_| "Codex app-server did not return the requested response.")?
            .map_err(str::to_string)?;
        if let Ok(value) = serde_json::from_slice::<Value>(&line) {
            if value.get("id").and_then(Value::as_i64) == Some(id) {
                return Ok(value);
            }
        }
    }
}

impl CodexRpcClient for CodexAppServerClient {
    fn send(&mut self, value: &Value) -> Result<(), String> {
        write_json_line(&self.stdin, value)
    }

    fn receive_response(&mut self, id: i64, deadline: Instant) -> Result<Value, String> {
        receive_response(&self.receiver, id, deadline)
    }
}

impl Drop for CodexAppServerClient {
    fn drop(&mut self) {
        self.child.terminate();
        // Never join a reader whose stdout may be retained by a Unix descendant.
        // Dropping receiver after this call also releases any blocked send.
        // Windows supervision still terminates the complete provider tree.
        self.reader.take();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn discovery_configuration_preserves_auth_custody_and_isolates_project_work() {
        let directory = tempfile::tempdir().unwrap();
        let mut command = Command::new("codex");
        command
            .env("CODEX_HOME", "account-owned-profile")
            .args(["-c", "cli_auth_credentials_store='keyring'"]);
        configure_discovery(&mut command, directory.path());
        assert_eq!(command.get_current_dir(), Some(directory.path()));
        assert!(command.get_envs().any(|(key, value)| key == "CODEX_HOME"
            && value == Some(std::ffi::OsStr::new("account-owned-profile"))));
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_str().unwrap())
            .collect();
        assert!(args.contains(&"cli_auth_credentials_store='keyring'"));
        assert!(args.contains(&"mcp_servers={}"));
        assert!(args.contains(&"project_doc_max_bytes=0"));
        assert!(args.ends_with(&["app-server", "--stdio"]));
    }

    #[test]
    fn oversized_metadata_stops_reading_before_allocating_the_entire_frame() {
        let mut input = Cursor::new(vec![b'x'; MAX_FRAME_BYTES * 2]);
        let (sender, receiver) = mpsc::sync_channel(1);
        read_frames(&mut input, sender);
        assert_eq!(input.position(), MAX_FRAME_BYTES as u64 + 1);
        assert_eq!(
            receiver.recv().unwrap().unwrap_err(),
            "Codex metadata response exceeded the 1 MiB limit."
        );
        assert!(receiver.recv().is_err());
    }

    #[test]
    fn bounded_reader_handles_notifications_and_releases_when_consumer_closes() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let reader = thread::spawn(move || {
            let noise = "{\"method\":\"notification\"}\n".repeat(1000);
            let response = "{\"id\":2,\"result\":{\"account\":{\"type\":\"chatgpt\"}}}\n";
            // More output after the response deliberately fills the queue.
            read_frames(Cursor::new(noise.clone() + response + &noise), sender);
        });
        let value =
            receive_response(&receiver, 2, Instant::now() + Duration::from_secs(5)).unwrap();
        assert_eq!(value["result"]["account"]["type"], "chatgpt");
        drop(receiver);
        reader.join().unwrap();
    }

    #[test]
    fn metadata_transport_preserves_errors_deadlines_and_large_valid_catalogues() {
        let value = json!({"id": 3, "result": {"data": [{"model": "large", "description": "x".repeat(256 * 1024)}]}});
        let (sender, receiver) = mpsc::sync_channel(2);
        read_frames(Cursor::new(serde_json::to_vec(&value).unwrap()), sender);
        assert_eq!(
            receive_response(&receiver, 3, Instant::now() + Duration::from_secs(5)).unwrap(),
            value
        );
        let (sender, receiver) = mpsc::sync_channel(2);
        sender
            .send(Ok(b"{\"id\":2,\"error\":{\"code\":-32601}}\n".to_vec()))
            .unwrap();
        assert_eq!(
            receive_response(&receiver, 2, Instant::now() + Duration::from_secs(5)).unwrap()
                ["error"]["code"],
            -32601
        );
        sender
            .send(Ok(b"{\"id\":2,\"result\":{}}\n".to_vec()))
            .unwrap();
        assert!(receive_response(&receiver, 2, Instant::now()).is_err());
        drop(sender);
        assert!(receive_response(&receiver, 99, Instant::now() + Duration::from_secs(5)).is_err());
    }
}
