//! Native-owned, harmless loopback conformance. Success requires native positive
//! and negative request/UDP counters, never a renderer assertion alone.
use serde_json::json;
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream, UdpSocket},
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
use windows::core::HSTRING;
const LIFETIME: Duration = Duration::from_secs(10);
// Low two bits: idle, running, verified, failed. Upper bits fence every attempt.
static STATE: AtomicU64 = AtomicU64::new(0);
static ACTIVE: OnceLock<Mutex<Option<Arc<Probe>>>> = OnceLock::new();
struct Probe {
    attempt: u64,
    origin: String,
    frame_id: String,
    baseline_nonce: String,
    restricted_nonce: String,
    baseline_udp_port: u16,
    restricted_udp_port: u16,
    expires: Instant,
    cancel: AtomicBool,
    phase: AtomicU8,
    baseline_document: AtomicBool,
    baseline_control: AtomicBool,
    failure_stage: AtomicU8,
    preflights: AtomicU32,
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
    STATE.load(Ordering::Acquire) & 3 == 2
}
fn begin_attempt() -> (u64, bool) {
    loop {
        let current = STATE.load(Ordering::Acquire);
        if current & 3 != 0 {
            return (current & !3, false);
        }
        let attempt = (current & !3).wrapping_add(4);
        if STATE
            .compare_exchange(current, attempt | 1, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            return (attempt, true);
        }
    }
}
fn transition_on(state: &AtomicU64, attempt: u64, status: u64) -> bool {
    state
        .compare_exchange(
            attempt | 1,
            attempt | status,
            Ordering::AcqRel,
            Ordering::Acquire,
        )
        .is_ok()
}
fn transition(attempt: u64, status: u64) {
    let _ = transition_on(&STATE, attempt, status);
}
fn cancel_attempt(attempt: u64) {
    loop {
        let current = STATE.load(Ordering::Acquire);
        if current & !3 != attempt || matches!(current & 3, 0 | 2) {
            return;
        }
        if STATE
            .compare_exchange(current, attempt, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            return;
        }
    }
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
        .strip_prefix("mivlet-proof-")?
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
fn evaluate(
    window: &tauri::WebviewWindow,
    expression: String,
    attempt: Option<u64>,
) -> Result<(), String> {
    window.with_webview(move|webview| {
        let result=(||->windows::core::Result<()> {
            let core=unsafe{webview.controller().CoreWebView2()?};
            let callback=CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move|status,_|{if status.is_err(){if let Some(attempt)=attempt {transition(attempt,3);}}Ok(())}));
            unsafe{core.CallDevToolsProtocolMethod(&HSTRING::from("Runtime.evaluate"),&HSTRING::from(json!({"expression":expression,"returnByValue":true,"silent":true,"includeCommandLineAPI":false,"userGesture":false,"awaitPromise":false}).to_string()),&callback)}
        })();
        if result.is_err(){if let Some(attempt)=attempt {transition(attempt,3);}}
    }).map_err(|_|"The native connection conformance frame could not start.".into())
}
pub(crate) async fn verify(
    window: &tauri::WebviewWindow,
    check: impl Fn() -> Result<(), String>,
) -> Result<(), String> {
    if verified() {
        return check();
    }
    let (attempt, start) = begin_attempt();
    if !start {
        return match STATE.load(Ordering::Acquire) & 3 {
            2 => check(),
            3 => Err("This WebView2 runtime did not prove native connection allowlist enforcement, including blocked data-only WebRTC. Update the runtime and reopen Mivlet; no app preview was exposed.".into()),
            _ => Err("Native preview connection verification is already in progress. Retry opening this preview after that check finishes; no app preview was exposed.".into()),
        };
    }
    if start {
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
                attempt,
                origin: format!(
                    "http://mivlet-proof-{token}.localhost:{}",
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
                baseline_document: AtomicBool::new(false),
                baseline_control: AtomicBool::new(false),
                failure_stage: AtomicU8::new(0),
                preflights: AtomicU32::new(0),
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
            evaluate(window, source, Some(attempt))
        })();
        if let Err(error) = started {
            transition(attempt, 3);
            cleanup(window, attempt);
            return Err(error);
        }
    }
    let deadline = Instant::now() + LIFETIME;
    loop {
        if let Err(error) = check() {
            cleanup(window, attempt);
            cancel_attempt(attempt);
            return Err(error);
        }
        let current = STATE.load(Ordering::Acquire);
        if current & !3 != attempt {
            return Err("Native preview verification was replaced after its owning task stopped. Retry from the current task; no app preview was exposed.".into());
        }
        match current & 3 {0=>return Err("Native preview verification was canceled by its owning task. Retry from the current task; no app preview was exposed.".into()),2=>{cleanup(window,attempt);return check();},3=>{cleanup(window,attempt);return Err("This WebView2 runtime did not prove native connection allowlist enforcement, including blocked data-only WebRTC. Update the runtime and reopen Mivlet; no app preview was exposed.".into());},_=>{}}
        if Instant::now() >= deadline {
            transition(attempt, 3);
            cleanup(window, attempt);
            return Err("Native connection allowlist verification timed out. No app preview was exposed; reopen Mivlet after updating its runtime.".into());
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}
fn cleanup(window: &tauri::WebviewWindow, attempt: u64) {
    if let Some(probe) = active().lock().ok().and_then(|mut probe| {
        if probe.as_ref().is_some_and(|probe| probe.attempt == attempt) {
            probe.take()
        } else {
            None
        }
    }) {
        #[cfg(debug_assertions)]
        if std::env::var("MIVLET_PREVIEW_NETWORK_ACCEPTANCE").as_deref() == Ok("1") {
            eprintln!("Native preview proof diagnostics: version={} phase={} baselineDocument={} baselineControl={} baselineFetch={} baselineStun={} baselineRtc={} restrictedControl={} restrictedRtc={} restrictedFetch={} restrictedStun={} resultCue={} fixtureFailureStage={} preflights={} status={}",
                crate::interactive_network_guard::diagnostic_version(),probe.phase.load(Ordering::Acquire),probe.baseline_document.load(Ordering::Acquire),probe.baseline_control.load(Ordering::Acquire),probe.baseline_http.load(Ordering::Acquire),probe.baseline_udp.load(Ordering::Acquire),probe.baseline_rtc.load(Ordering::Acquire),probe.restricted_control.load(Ordering::Acquire),probe.restricted_rtc.load(Ordering::Acquire),probe.restricted_http.load(Ordering::Acquire),probe.restricted_udp.load(Ordering::Acquire),probe.result_cue.load(Ordering::Acquire),probe.failure_stage.load(Ordering::Acquire),probe.preflights.load(Ordering::Acquire),STATE.load(Ordering::Acquire)&3);
        }
        probe.cancel.store(true, Ordering::Release);
        let _ = evaluate(
            window,
            format!(
                "document.getElementById({})?.remove()",
                json!(probe.frame_id)
            ),
            None,
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
    while live(&probe) && STATE.load(Ordering::Acquire) == (probe.attempt | 1) {
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
            transition(probe.attempt, 2);
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
    transition(probe.attempt, 3);
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
    if std::str::from_utf8(&bytes).is_ok_and(|text| text.starts_with("OPTIONS ")) {
        probe.preflights.fetch_add(1, Ordering::AcqRel);
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
    let failure = failure_route(probe, path);
    let Some(control) = failure.map(|_| "/failed").or_else(|| route(probe, path)) else {
        return;
    };
    match control {
        "/baseline" => {
            probe.baseline_document.store(true, Ordering::Release);
            body = page(probe, false);
        }
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
                transition(probe.attempt, 3);
            }
        }
        "/result" => {
            probe.result_cue.store(true, Ordering::Release);
        }
        "/failed" => {
            probe
                .failure_stage
                .store(failure.unwrap_or(0), Ordering::Release);
            transition(probe.attempt, 3);
        }
        "/baseline-control" => {
            probe.baseline_control.store(true, Ordering::Release);
        }
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
fn failure_route(probe: &Probe, path: &str) -> Option<u8> {
    [&probe.baseline_nonce, &probe.restricted_nonce]
        .into_iter()
        .find_map(|nonce| {
            let stage = path.strip_prefix(&format!("/failed-{nonce}/"))?;
            match stage {
                "control" => Some(1),
                "fetch" => Some(2),
                "rtc-unavailable" => Some(3),
                "rtc-baseline" => Some(4),
                "result" => Some(5),
                _ => None,
            }
        })
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
      const restricted={restricted};let pc=null;let stage='control';
      try {{
        if(await(await fetch({control})).text()!=='ok')throw Error('control');
        stage='fetch';
        let blocked=false;try{{await fetch({victim});}}catch{{blocked=true;}}
        if(blocked!==restricted)throw Error('fetch');
        stage='rtc-unavailable';
        if(typeof RTCPeerConnection!=='function')throw Error('rtc unavailable');
        if(restricted)await fetch({rtc});
        stage='rtc-baseline';
        let rejected=false;
        try{{pc=new RTCPeerConnection({{iceServers:[{{urls:{stun}}}]}});pc.createDataChannel('native-proof');await pc.setLocalDescription(await pc.createOffer());await new Promise(resolve=>setTimeout(resolve,900));}}catch{{rejected=true;}}finally{{pc?.close();}}
        if(!restricted&&rejected)throw Error('rtc baseline');
        stage='result';
        if(restricted){{await fetch({result});}}else{{await fetch({baseline_done});location.replace('/restricted');}}
      }}catch{{try{{await fetch({failed}+'/'+stage);}}catch{{}}}}
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

/// Disposable debug-only installed-WebView acceptance. It starts no account,
/// provider, command executor, stored workspace, or renderer command handler.
#[cfg(debug_assertions)]
pub(crate) fn acceptance() -> Result<(), String> {
    if std::env::var("MIVLET_PREVIEW_NETWORK_ACCEPTANCE").as_deref() != Ok("1") {
        return Err(
            "Set MIVLET_PREVIEW_NETWORK_ACCEPTANCE=1 for this disposable native WebView check."
                .into(),
        );
    }
    let profile = tempfile::Builder::new()
        .prefix("mivlet-preview-network-qa-")
        .tempdir()
        .map_err(|_| "Native WebView QA profile is unavailable.")?;
    let directory = profile.path().to_owned();
    let passed = Arc::new(AtomicBool::new(false));
    let outcome = passed.clone();
    let deadline = Instant::now() + Duration::from_secs(18);
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    let app = tauri::Builder::default()
        .setup(move |app| {
            let window = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::External(url::Url::parse("about:blank")?),
            )
            .title("Mivlet native preview network acceptance")
            .visible(false)
            .skip_taskbar(true)
            .data_directory(directory)
            .additional_browser_args("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --site-per-process --enable-features=ConnectionAllowlists,OverrideConnectionAllowlistOriginTrial")
            .build()?;
            crate::mcp_app_host::install_navigation_guard(&window);
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let result = async {
                    let ready_deadline = Instant::now() + Duration::from_secs(5);
                    while crate::interactive_network_guard::require_ready().is_err() {
                        if Instant::now() >= ready_deadline {
                            return Err("Installed native WebView navigation/network guards did not become ready.".to_owned());
                        }
                        tokio::time::sleep(Duration::from_millis(25)).await;
                    }
                    crate::interactive_network_guard::verify_connection_allowlist(&window, || {
                        if Instant::now() >= deadline {
                            return Err("Native WebView QA deadline expired.".into());
                        }
                        if window.is_visible().map_err(|_| "Native WebView QA window closed.")? {
                            return Err("Native WebView QA must remain hidden.".into());
                        }
                        Ok(())
                    }).await?;
                    crate::mcp_app_host::require_live_preview_guards()?;
                    if active().lock().map_err(|_| "Native WebView QA cleanup is unavailable.")?.is_some() {
                        return Err("Native WebView QA retained its fixture registration.".into());
                    }
                    Ok::<(),String>(())
                }.await;
                let code = match result {
                    Ok(()) => {
                        outcome.store(true,Ordering::Release);
                        eprintln!("Native preview network: installed WebView guards ready; loopback fetch and real data-only STUN positive controls observed; restricted fetch and STUN denied by native counters; fixture registrations removed.");
                        0
                    }
                    Err(error) => { eprintln!("{error}"); 2 }
                };
                let closing = handle.clone();
                if window.with_webview(move |webview| {
                    crate::interactive_network_guard::dispose_acceptance();
                    let _ = unsafe { webview.controller().Close() };
                    closing.exit(code);
                }).is_err() { handle.exit(2); }
            });
            Ok(())
        })
        .build(context)
        .map_err(|_| "The disposable native WebView could not start.")?;
    let code = app.run_return(|_, _| {});
    // WebView2 may release the final profile file locks just after its event
    // loop exits. Retry only the verified native-created QA directory.
    let target = std::fs::canonicalize(profile.path())
        .map_err(|_| "The disposable native WebView profile changed.")?;
    let temporary = std::fs::canonicalize(std::env::temp_dir())
        .map_err(|_| "The native temporary directory is unavailable.")?;
    if !target.is_absolute()
        || !target.starts_with(&temporary)
        || !target
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("mivlet-preview-network-qa-"))
    {
        return Err("The disposable native WebView cleanup target changed.".into());
    }
    if profile.close().is_err() {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            match std::fs::remove_dir_all(&target) {
                Ok(())=>break,
                Err(error) if error.kind()==std::io::ErrorKind::NotFound=>break,
                Err(_) if Instant::now()<deadline=>std::thread::sleep(Duration::from_millis(50)),
                Err(_)=>return Err("The disposable native WebView profile could not be removed after bounded shutdown.".into()),
            }
        }
    }
    if code == 0 && passed.load(Ordering::Acquire) && verified() {
        Ok(())
    } else {
        Err(
            "Installed native preview network acceptance did not pass; no app preview was exposed."
                .into(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn probe() -> Probe {
        Probe {
            attempt: 4,
            origin: format!("http://mivlet-proof-{}.localhost:12345", "a".repeat(48)),
            frame_id: "frame".into(),
            baseline_nonce: "base-native-nonce".into(),
            restricted_nonce: "restricted-native-nonce".into(),
            baseline_udp_port: 12346,
            restricted_udp_port: 12347,
            expires: Instant::now() + LIFETIME,
            cancel: AtomicBool::new(false),
            phase: AtomicU8::new(1),
            baseline_document: AtomicBool::new(true),
            baseline_control: AtomicBool::new(true),
            failure_stage: AtomicU8::new(0),
            preflights: AtomicU32::new(0),
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
    fn native_probe_hostname_is_a_valid_bounded_dns_label() {
        let value = probe();
        let origin = url::Url::parse(&value.origin).unwrap();
        let host = origin.host_str().unwrap();
        assert!(host
            .split('.')
            .all(|label| !label.is_empty() && label.len() <= 63));
        assert!(host.starts_with("mivlet-proof-"));
    }
    #[test]
    fn canceled_callbacks_and_server_tail_cannot_change_a_new_attempt() {
        let state = AtomicU64::new(4 | 1);
        assert!(transition_on(&state, 4, 0));
        state.store(8 | 1, Ordering::Release);
        assert!(!transition_on(&state, 4, 3));
        assert!(!transition_on(&state, 4, 2));
        assert!(!transition_on(&state, 4, 0));
        assert_eq!(state.load(Ordering::Acquire), 8 | 1);
        assert!(transition_on(&state, 8, 2));
        assert!(!transition_on(&state, 8, 3));
        assert_eq!(state.load(Ordering::Acquire), 8 | 2);
    }
    #[test]
    fn native_runtime_and_acceptance_explicitly_enable_network_enforcement() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let arguments = config["app"]["windows"][0]["additionalBrowserArgs"]
            .as_str()
            .unwrap();
        assert!(arguments.contains(
            "--enable-features=ConnectionAllowlists,OverrideConnectionAllowlistOriginTrial"
        ));
        assert!(arguments.contains("--site-per-process"));
        for forbidden in [
            "disable-web-security",
            "disable-site-isolation",
            "no-sandbox",
            "allow-insecure-localhost",
        ] {
            assert!(!arguments.contains(forbidden));
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
        assert_eq!(
            failure_route(&value, "/failed-base-native-nonce/fetch"),
            Some(2)
        );
        assert!(failure_route(&value, "/failed/fetch").is_none());
        assert!(failure_route(&value, "/failed-base-native-nonce/claimed-pass").is_none());
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
