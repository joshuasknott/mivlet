//! Opt-in actual LPAC input/HTTP/upgrade transport. No fixtures stand in for
//! restricted process, Job, token, pipe peer, or the pinned Node runtime.
use super::*;
use std::{
    fs,
    io::{Read, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
fn resources() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .unwrap()
        .join("apps/desktop/src-tauri/resources/execution-runtime/runtime")
}
fn read_until(stream: &mut PreviewStream, expected: &[u8]) -> Vec<u8> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut result = Vec::new();
    while !result.windows(expected.len()).any(|part| part == expected) {
        assert!(
            Instant::now() < deadline && result.len() < 8192,
            "preview response bounded"
        );
        let mut buffer = [0; 1024];
        match stream.read(&mut buffer) {
            Ok(0) => panic!("preview ended before the expected response"),
            Ok(size) => result.extend_from_slice(&buffer[..size]),
            Err(error) if error.kind() == std::io::ErrorKind::TimedOut => {}
            Err(error) => panic!("private preview read failed: {error}"),
        }
    }
    result
}
#[test]
#[ignore = "Actual pinned Node LPAC interactive stdin and private HTTP/WebSocket transport; requires native setup/runtime"]
fn native_interactive_preview_session_acceptance() {
    let source = tempfile::tempdir().unwrap();
    fs::write(source.path().join("server.js"), r#"
const http=require('node:http'),crypto=require('node:crypto');
const server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/plain'});res.end('PRIVATE_HTTP_FIXTURE');});
server.on('upgrade',(req,socket)=>{
 const key=req.headers['sec-websocket-key'];
 const accept=crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
 socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
 socket.on('data',data=>{if(data.length!==13||data[0]!==0x81||data[1]!==0x87)return socket.destroy();const text=Buffer.from(data.subarray(6));for(let i=0;i<7;i++)text[i]^=data[2+i%4];socket.write(Buffer.concat([Buffer.from([0x81,7]),text]));});
});
process.stdin.once('data',data=>console.log('INPUT_DIGEST='+crypto.createHash('sha256').update(data).digest('hex')));
server.listen(4173,'127.0.0.1',()=>console.log('PRIVATE_SESSION_READY'));
setInterval(()=>{},1000);
"#).unwrap();
    let binding = Binding {
        scope_id: "c".repeat(64),
        generation: 1,
        operation_id: 37,
    };
    let cancel = Arc::new(AtomicBool::new(false));
    let control = SessionControl::new(
        binding.clone(),
        SessionOptions {
            interactive: true,
            preview_port: Some(4173),
        },
        cancel.clone(),
    )
    .unwrap();
    let runner = control.clone();
    let output = OutputLog::new(|_, text| text.to_owned());
    let observed = output.clone();
    let path = source.path().to_path_buf();
    let run_binding = binding.clone();
    let worker = std::thread::spawn(move || {
        run_with_session(
            &resources(),
            &path,
            "node server.js",
            false,
            60,
            Limits::ANALYSIS,
            run_binding,
            ExecutionMode::Persistent,
            output,
            Some(runner),
            || !cancel.load(Ordering::Acquire),
            |launch| launch(),
        )
    });
    struct Stop(SessionControl);
    impl Drop for Stop {
        fn drop(&mut self) {
            self.0.stop();
        }
    }
    let _stop = Stop(control.clone());
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        let ready = observed
            .summary()
            .unwrap()
            .0
            .contains("PRIVATE_SESSION_READY");
        if ready {
            break;
        }
        if worker.is_finished() || Instant::now() >= deadline {
            control.stop();
            panic!(
                "Native session prerequisite or launch failed: {:?}",
                worker.join().unwrap().map(|run| run.receipt().clone())
            );
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    assert!(control.is_current(&binding));
    assert_eq!(control.input_id(&binding).unwrap().len(), 64);
    let mut stale = binding.clone();
    stale.operation_id += 1;
    assert!(control.open_preview(&stale).is_err());
    assert!(control
        .write_input(&stale, "explicit line\n".into())
        .is_err());
    assert_eq!(
        control
            .write_input(&binding, "explicit line\n".into())
            .unwrap(),
        InputDelivery::Accepted
    );
    let mut http = control
        .open_preview(&binding)
        .expect("Actual host-to-LPAC private pipe access is required; no TCP fallback");
    http.write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .unwrap();
    let response = read_until(&mut http, b"PRIVATE_HTTP_FIXTURE");
    assert!(response.starts_with(b"HTTP/1.1 200"));
    let mut socket = control.open_preview(&binding).unwrap();
    let mut writer = socket.try_clone().unwrap();
    writer.write_all(b"GET /socket HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n").unwrap();
    let upgrade = read_until(&mut socket, b"\r\n\r\n");
    assert!(upgrade.starts_with(b"HTTP/1.1 101"));
    assert!(String::from_utf8_lossy(&upgrade).contains("s3pPLMBiTxaQ9kYGzzhZRbK+xOo="));
    let mask = [1u8, 2, 3, 4];
    let mut frame = vec![0x81, 0x87];
    frame.extend_from_slice(&mask);
    frame.extend(
        b"fixture"
            .iter()
            .enumerate()
            .map(|(i, byte)| byte ^ mask[i % 4]),
    );
    writer.write_all(&frame).unwrap();
    assert!(read_until(&mut socket, b"fixture").ends_with(b"\x81\x07fixture"));
    use sha2::{Digest, Sha256};
    let digest = hex::encode(Sha256::digest(b"explicit line\n"));
    let input_deadline = Instant::now() + Duration::from_secs(5);
    while !observed
        .summary()
        .unwrap()
        .0
        .contains(&format!("INPUT_DIGEST={digest}"))
    {
        assert!(Instant::now() < input_deadline);
        std::thread::sleep(Duration::from_millis(25));
    }
    control.stop();
    assert!(!control.is_current(&binding));
    assert!(control.open_preview(&binding).is_err());
    let completed = worker.join().unwrap().unwrap();
    assert!(completed.receipt().interrupted && completed.receipt().persistent);
    assert!(completed.receipt().output_id.is_none());
    assert!(completed.import_repository(source.path()).is_err());
}
