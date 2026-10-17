//! Native-owned, harmless loopback conformance. Success requires native positive
//! and negative request/UDP counters, never a renderer assertion alone.
use serde_json::json;
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream, UdpSocket},
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU8, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
use windows::core::HSTRING;
const LIFETIME: Duration = Duration::from_secs(10);
static STATE: AtomicU8 = AtomicU8::new(0); // idle, running, verified, failed
static ACTIVE: OnceLock<Mutex<Option<Arc<Probe>>>> = OnceLock::new();
struct Probe {
    origin: String,
    frame_id: String,
    baseline_nonce: String,
    restricted_nonce: String,
    baseline_udp_port: u16,
    restricted_udp_port: u16,
    expires: Instant,
    cancel: AtomicBool,
    phase: AtomicU8,
    baseline_http: AtomicU32,
    restricted_http: AtomicU32,
    baseline_udp: AtomicU32,
    restricted_udp: AtomicU32,
    baseline_rtc: AtomicBool,
    restricted_control: AtomicBool,
    restricted_rtc: AtomicBool,
    result_cue: AtomicBool,
    restricted_started: Mutex<Option<Instant>>,
}
fn active() -> &'static Mutex<Option<Arc<Probe>>> {
    ACTIVE.get_or_init(|| Mutex::new(None))
}
pub(crate) fn verified() -> bool {
    STATE.load(Ordering::Acquire) == 2
}
fn live(probe: &Probe) -> bool {
    !probe.cancel.load(Ordering::Acquire) && Instant::now() < probe.expires
}
pub(crate) fn registered(uri: &str) -> bool {
    let Some(probe) = active().lock().ok().and_then(|probe| probe.clone()) else {
        return false;
    };
    live(&probe)
        && matches!(
            uri.strip_prefix(&probe.origin),
            Some("/baseline" | "/restricted")
        )
}
pub(crate) fn navigation(expected: &str, uri: &str) -> Option<bool> {
    let parsed = url::Url::parse(expected).ok()?;
    let token = parsed
        .host_str()?
        .strip_prefix("mivlet-preview-probe-")?
        .strip_suffix(".localhost")?;
    if token.len() != 48
        || !token
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    let Some(probe) = active().lock().ok().and_then(|probe| probe.clone()) else {
        return Some(false);
    };
    let baseline = format!("{}/baseline", probe.origin);
    let restricted = format!("{}/restricted", probe.origin);
    Some(
        live(&probe)
            && registered(expected)
            && registered(uri)
            && ((expected == baseline
                && uri == baseline
                && probe.phase.load(Ordering::Acquire) == 0)
                || (expected == baseline
                    && uri == restricted
                    && probe.baseline_rtc.load(Ordering::Acquire))
                || (expected == restricted
                    && uri == restricted
                    && probe.phase.load(Ordering::Acquire) == 1)),
    )
}
fn evaluate(window: &tauri::WebviewWindow, expression: String) -> Result<(), String> {
    window.with_webview(move|webview| {
        let result=(||->windows::core::Result<()> {
            let core=unsafe{webview.controller().CoreWebView2()?};
            let callback=CallDevToolsProtocolMethodCompletedHandler::create(Box::new(|status,_|{if status.is_err(){STATE.store(3,Ordering::Release);}Ok(())}));
            unsafe{core.CallDevToolsProtocolMethod(&HSTRING::from("Runtime.evaluate"),&HSTRING::from(json!({"expression":expression,"returnByValue":true,"silent":true,"includeCommandLineAPI":false,"userGesture":false,"awaitPromise":false}).to_string()),&callback)}
        })();
        if result.is_err(){STATE.store(3,Ordering::Release);}
    }).map_err(|_|"The native connection conformance frame could not start.".into())
}
pub(crate) async fn verify(
    window: &tauri::WebviewWindow,
    check: impl Fn() -> Result<(), String>,
) -> Result<(), String> {
    if verified() {
        return check();
    }
    if STATE
        .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
    {
        let started = (|| {
            let listener = TcpListener::bind(("127.0.0.1", 0))
                .map_err(|_| "Native connection probe listener is unavailable.")?;
            let udp = UdpSocket::bind(("127.0.0.1", 0))
                .map_err(|_| "Native connection probe UDP fixture is unavailable.")?;
            let restricted_udp = UdpSocket::bind(("127.0.0.1", 0))
                .map_err(|_| "Native connection probe UDP fixture is unavailable.")?;
            listener
                .set_nonblocking(true)
                .map_err(|_| "Native connection probe listener is unavailable.")?;
            udp.set_nonblocking(true)
                .map_err(|_| "Native connection probe UDP fixture is unavailable.")?;
            restricted_udp
                .set_nonblocking(true)
                .map_err(|_| "Native connection probe UDP fixture is unavailable.")?;
            let mut nonce = [0u8; 24];
            getrandom::fill(&mut nonce).map_err(|_| "Native probe identity is unavailable.")?;
            let token = hex::encode(nonce);
            getrandom::fill(&mut nonce).map_err(|_| "Native probe nonce is unavailable.")?;
            let baseline_nonce = hex::encode(nonce);
            getrandom::fill(&mut nonce).map_err(|_| "Native probe nonce is unavailable.")?;
            let restricted_nonce = hex::encode(nonce);
            let probe = Arc::new(Probe {
                origin: format!(
                    "http://mivlet-preview-probe-{token}.localhost:{}",
                    listener
                        .local_addr()
                        .map_err(|_| "Native probe address is unavailable.")?
                        .port()
                ),
                frame_id: format!("mivlet-preview-proof-{token}"),
                baseline_nonce,
                restricted_nonce,
                baseline_udp_port: udp
                    .local_addr()
                    .map_err(|_| "Native UDP fixture address is unavailable.")?
                    .port(),
                restricted_udp_port: restricted_udp
                    .local_addr()
                    .map_err(|_| "Native UDP fixture address is unavailable.")?
                    .port(),
                expires: Instant::now() + LIFETIME,
                cancel: AtomicBool::new(false),
                phase: AtomicU8::new(0),
                baseline_http: AtomicU32::new(0),
                restricted_http: AtomicU32::new(0),
                baseline_udp: AtomicU32::new(0),
                restricted_udp: AtomicU32::new(0),
                baseline_rtc: AtomicBool::new(false),
                restricted_control: AtomicBool::new(false),
                restricted_rtc: AtomicBool::new(false),
                result_cue: AtomicBool::new(false),
                restricted_started: Mutex::new(None),
            });
            *active()
                .lock()
                .map_err(|_| "Native connection probe is unavailable.")? = Some(probe.clone());
            let running = probe.clone();
            std::thread::Builder::new()
                .name("mivlet-connection-proof".into())
                .stack_size(256 * 1024)
                .spawn(move || serve(listener, udp, restricted_udp, running))
                .map_err(|_| "Native connection probe could not start.")?;
            let source=format!("(()=>{{const f=document.createElement('iframe');f.id={};f.hidden=true;f.style.display='none';f.setAttribute('sandbox','allow-scripts allow-same-origin');f.src={};document.documentElement.append(f);}})()",json!(probe.frame_id),json!(format!("{}/baseline",probe.origin)));
            evaluate(window, source)
        })();
        if let Err(error) = started {
            STATE.store(3, Ordering::Release);
            cleanup(window);
            return Err(error);
        }
    }
    let deadline = Instant::now() + LIFETIME;
    loop {
        if let Err(error) = check() {
            cleanup(window);
            STATE.store(0, Ordering::Release);
            return Err(error);
        }
        match STATE.load(Ordering::Acquire) {0=>return Err("Native preview verification was canceled by its owning task. Retry from the current task; no app preview was exposed.".into()),2=>{cleanup(window);return check();},3=>{cleanup(window);return Err("This WebView2 runtime did not prove native connection allowlist enforcement, including blocked data-only WebRTC. Update the runtime and reopen Mivlet; no app preview was exposed.".into());},_=>{}}
        if Instant::now() >= deadline {
            cleanup(window);
            STATE.store(3, Ordering::Release);
            return Err("Native connection allowlist verification timed out. No app preview was exposed; reopen Mivlet after updating its runtime.".into());
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}
fn cleanup(window: &tauri::WebviewWindow) {
    if let Some(probe) = active().lock().ok().and_then(|mut probe| probe.take()) {
        probe.cancel.store(true, Ordering::Release);
        let _ = evaluate(
            window,
            format!(
                "document.getElementById({})?.remove()",
                json!(probe.frame_id)
            ),
        );
    }
}
fn stun(bytes: &[u8]) -> bool {
    bytes.len() >= 20 && bytes[..2] == [0, 1] && bytes[4..8] == [0x21, 0x12, 0xa4, 0x42]
}
fn observed(probe: &Probe) -> bool {
    live(probe)
        && probe.baseline_rtc.load(Ordering::Acquire)
        && probe.baseline_http.load(Ordering::Acquire) > 0
        && probe.baseline_udp.load(Ordering::Acquire) > 0
        && probe.restricted_http.load(Ordering::Acquire) == 0
        && probe.restricted_udp.load(Ordering::Acquire) == 0
        && probe.restricted_control.load(Ordering::Acquire)
        && probe.restricted_rtc.load(Ordering::Acquire)
        && probe.result_cue.load(Ordering::Acquire)
        && probe.phase.load(Ordering::Acquire) == 1
        && probe
            .restricted_started
            .lock()
            .ok()
            .and_then(|start| *start)
            .is_some_and(|start| start.elapsed() >= Duration::from_millis(1200))
}
fn serve(listener: TcpListener, udp: UdpSocket, restricted_udp: UdpSocket, probe: Arc<Probe>) {
    let mut workers: Vec<std::thread::JoinHandle<()>> = Vec::new();
    let mut bytes = [0u8; 2048];
    while live(&probe) && STATE.load(Ordering::Acquire) == 1 {
        for (socket, counter) in [
            (&udp, &probe.baseline_udp),
            (&restricted_udp, &probe.restricted_udp),
        ] {
            for _ in 0..32 {
                if !live(&probe) {
                    break;
                }
                match socket.recv_from(&mut bytes) {
                    Ok((size, peer)) if peer.ip().is_loopback() && stun(&bytes[..size]) => {
                        counter.fetch_add(1, Ordering::AcqRel);
                    }
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
        }
        if observed(&probe) {
            STATE.store(2, Ordering::Release);
            break;
        }
        workers.retain(|worker| !worker.is_finished());
        match listener.accept() {
            Ok((stream, peer)) if peer.ip().is_loopback() && workers.len() < 8 => {
                let probe = probe.clone();
                if let Ok(worker) = std::thread::Builder::new()
                    .name("mivlet-connection-fixture".into())
                    .stack_size(128 * 1024)
                    .spawn(move || connection(stream, &probe))
                {
                    workers.push(worker);
                }
            }
            _ => {}
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    probe.cancel.store(true, Ordering::Release);
    for worker in workers {
        let _ = worker.join();
    }
    if STATE.load(Ordering::Acquire) == 1 {
        STATE.store(3, Ordering::Release);
    }
}
fn connection(mut stream: TcpStream, probe: &Probe) {
    let _ = stream.set_read_timeout(Some(Duration::from_millis(50)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 2048];
    while live(probe) && Instant::now() < deadline {
        match stream.read(&mut chunk) {
            Ok(0) => return,
            Ok(size) => bytes.extend_from_slice(&chunk[..size]),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                continue
            }
            Err(_) => return,
        }
        if bytes.len() > 8192 {
            return;
        }
        if bytes.windows(4).any(|part| part == b"\r\n\r\n") {
            break;
        }
    }
    if !live(probe) {
        return;
    }
    let Some(path) = std::str::from_utf8(&bytes)
        .ok()
        .and_then(|text| text.lines().next())
        .and_then(|line| line.strip_prefix("GET "))
        .and_then(|line| line.strip_suffix(" HTTP/1.1"))
    else {
        return;
    };
    let origin = url::Url::parse(&probe.origin).expect("native probe origin");
    let forbidden_baseline = format!("/forbidden-{}", probe.baseline_nonce);
    let forbidden_restricted = format!("/forbidden-{}", probe.restricted_nonce);
    let expected = if path == forbidden_baseline || path == forbidden_restricted {
        format!("127.0.0.1:{}", origin.port().unwrap())
    } else {
        format!("{}:{}", origin.host_str().unwrap(), origin.port().unwrap())
    };
    let hosts = std::str::from_utf8(&bytes)
        .ok()
        .map(|text| {
            text.lines()
                .filter_map(|line| {
                    line.split_once(':')
                        .filter(|(name, _)| name.eq_ignore_ascii_case("host"))
                        .map(|(_, value)| value.trim())
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if hosts.len() != 1 || hosts[0] != expected {
        return;
    }
    let mut headers = String::new();
    let mut body = "ok".to_owned();
    let Some(control) = route(probe, path) else {
        return;
    };
    match control {
        "/baseline" => body = page(probe, false),
        "/restricted" => {
            if !probe.baseline_rtc.load(Ordering::Acquire)
                || probe.phase.load(Ordering::Acquire) != 0
            {
                return;
            }
            probe.phase.store(1, Ordering::Release);
            if let Ok(mut start) = probe.restricted_started.lock() {
                *start = Some(Instant::now());
            }
            headers = format!(
                "Connection-Allowlist: (\"{}/*\"); redirects=block; webrtc=block\r\n",
                probe.origin
            );
            body = page(probe, true);
        }
        "/forbidden-baseline" => {
            headers = format!("Access-Control-Allow-Origin: {}\r\n", probe.origin);
            probe.baseline_http.fetch_add(1, Ordering::AcqRel);
        }
        "/forbidden-restricted" => {
            headers = format!("Access-Control-Allow-Origin: {}\r\n", probe.origin);
            probe.restricted_http.fetch_add(1, Ordering::AcqRel);
        }
        "/baseline-done" => {
            if probe.baseline_http.load(Ordering::Acquire) > 0
                && probe.baseline_udp.load(Ordering::Acquire) > 0
                && probe.phase.load(Ordering::Acquire) == 0
            {
                probe.baseline_rtc.store(true, Ordering::Release);
            } else {
                STATE.store(3, Ordering::Release);
            }
        }
        "/result" => {
            probe.result_cue.store(true, Ordering::Release);
        }
        "/failed" => {
            STATE.store(3, Ordering::Release);
        }
        "/baseline-control" => {}
        "/restricted-control" => {
            probe.restricted_control.store(true, Ordering::Release);
        }
        "/restricted-rtc" => {
            probe.restricted_rtc.store(true, Ordering::Release);
        }
        _ => return,
    }
    let content = if matches!(path, "/baseline" | "/restricted") {
        "text/html; charset=utf-8"
    } else {
        "text/plain"
    };
    let _=stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: {content}\r\nContent-Length: {}\r\nCache-Control: no-store\r\n{headers}Connection: close\r\n\r\n{body}",body.len()).as_bytes());
}
fn route(probe: &Probe, path: &str) -> Option<&'static str> {
    if path == format!("/forbidden-{}", probe.baseline_nonce) {
        Some("/forbidden-baseline")
    } else if path == format!("/forbidden-{}", probe.restricted_nonce) {
        Some("/forbidden-restricted")
    } else if path == format!("/baseline-done-{}", probe.baseline_nonce) {
        Some("/baseline-done")
    } else if path == format!("/control-{}", probe.baseline_nonce) {
        Some("/baseline-control")
    } else if path == format!("/control-{}", probe.restricted_nonce) {
        Some("/restricted-control")
    } else if path == format!("/rtc-{}", probe.restricted_nonce) {
        Some("/restricted-rtc")
    } else if path == format!("/result-{}", probe.restricted_nonce) {
        Some("/result")
    } else if path == format!("/failed-{}", probe.baseline_nonce)
        || path == format!("/failed-{}", probe.restricted_nonce)
    {
        Some("/failed")
    } else {
        match path {
            "/baseline" => Some("/baseline"),
            "/restricted" => Some("/restricted"),
            _ => None,
        }
    }
}
fn page(probe: &Probe, restricted: bool) -> String {
    let origin = url::Url::parse(&probe.origin).expect("native probe origin");
    let nonce = if restricted {
        &probe.restricted_nonce
    } else {
        &probe.baseline_nonce
    };
    let victim = format!(
        "http://127.0.0.1:{}/forbidden-{nonce}",
        origin.port().unwrap()
    );
    format!(
        r#"<!doctype html><html><head><title>Native connection verification</title></head><body><script>
    (async()=>{{
      const restricted={restricted};let pc=null;
      try {{
        if(await(await fetch({control})).text()!=='ok')throw Error('control');
        let blocked=false;try{{await fetch({victim});}}catch{{blocked=true;}}
        if(blocked!==restricted)throw Error('fetch');
        if(typeof RTCPeerConnection!=='function')throw Error('rtc unavailable');
        if(restricted)await fetch({rtc});
        let rejected=false;
        try{{pc=new RTCPeerConnection({{iceServers:[{{urls:{stun}}}]}});pc.createDataChannel('native-proof');await pc.setLocalDescription(await pc.createOffer());await new Promise(resolve=>setTimeout(resolve,900));}}catch{{rejected=true;}}finally{{pc?.close();}}
        if(!restricted&&rejected)throw Error('rtc baseline');
        if(restricted){{await fetch({result});}}else{{await fetch({baseline_done});location.replace('/restricted');}}
      }}catch{{try{{await fetch({failed});}}catch{{}}}}
    }})();</script></body></html>"#,
        victim = json!(victim),
        stun = json!(format!(
            "stun:127.0.0.1:{}",
            if restricted {
                probe.restricted_udp_port
            } else {
                probe.baseline_udp_port
            }
        )),
        control = json!(format!("/control-{nonce}")),
        rtc = json!(format!("/rtc-{nonce}")),
        result = json!(format!("/result-{nonce}")),
        baseline_done = json!(format!("/baseline-done-{nonce}")),
        failed = json!(format!("/failed-{nonce}"))
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn probe() -> Probe {
        Probe {
            origin: format!(
                "http://mivlet-preview-probe-{}.localhost:12345",
                "a".repeat(48)
            ),
            frame_id: "frame".into(),
            baseline_nonce: "base-native-nonce".into(),
            restricted_nonce: "restricted-native-nonce".into(),
            baseline_udp_port: 12346,
            restricted_udp_port: 12347,
            expires: Instant::now() + LIFETIME,
            cancel: AtomicBool::new(false),
            phase: AtomicU8::new(1),
            baseline_http: AtomicU32::new(1),
            restricted_http: AtomicU32::new(0),
            baseline_udp: AtomicU32::new(1),
            restricted_udp: AtomicU32::new(0),
            baseline_rtc: AtomicBool::new(true),
            restricted_control: AtomicBool::new(true),
            restricted_rtc: AtomicBool::new(true),
            result_cue: AtomicBool::new(true),
            restricted_started: Mutex::new(Some(Instant::now() - Duration::from_millis(1300))),
        }
    }
    #[test]
    fn no_renderer_cue_can_replace_native_positive_and_negative_network_observations() {
        assert!(observed(&probe()));
        let value = probe();
        value.baseline_udp.store(0, Ordering::Release);
        assert!(!observed(&value));
        let value = probe();
        value.baseline_http.store(0, Ordering::Release);
        assert!(!observed(&value));
        let value = probe();
        value.restricted_udp.store(1, Ordering::Release);
        assert!(!observed(&value));
        let value = probe();
        value.restricted_http.store(1, Ordering::Release);
        assert!(!observed(&value));
        let value = probe();
        *value.restricted_started.lock().unwrap() = Some(Instant::now());
        assert!(!observed(&value));
        let value = probe();
        value.restricted_rtc.store(false, Ordering::Release);
        assert!(!observed(&value));
    }
    #[test]
    fn internal_fixture_controls_require_the_exact_per_phase_nonce() {
        let value = probe();
        assert_eq!(route(&value, "/baseline"), Some("/baseline"));
        assert_eq!(
            route(&value, "/result-restricted-native-nonce"),
            Some("/result")
        );
        for path in [
            "/result",
            "/baseline-done",
            "/restricted-control",
            "/restricted-rtc",
            "/forbidden-baseline",
            "/failed",
            "/result-base-native-nonce",
        ] {
            assert!(route(&value, path).is_none(), "{path}");
        }
        assert_eq!(
            navigation(
                &format!("{}/baseline", value.origin),
                &format!("{}/restricted", value.origin)
            ),
            Some(false)
        );
    }
    #[test]
    fn rtc_positive_control_accepts_only_actual_stun_binding_requests() {
        let mut bytes = [0u8; 20];
        bytes[1] = 1;
        bytes[4..8].copy_from_slice(&[0x21, 0x12, 0xa4, 0x42]);
        assert!(stun(&bytes));
        bytes[4] = 0;
        assert!(!stun(&bytes));
        assert!(!stun(b"not a STUN packet"));
        let source = page(&probe(), true);
        assert!(source.contains("createDataChannel"));
        assert!(source.contains("127.0.0.1:12347"));
        assert!(!source.contains("https://"));
    }
}
