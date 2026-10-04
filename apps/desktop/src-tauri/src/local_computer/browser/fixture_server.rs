//! Local opt-in acceptance pages; idle browser preconnects cannot block requests.
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

pub(super) struct Server {
    pub origin: String,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}
impl Server {
    pub(super) fn start() -> Result<Self, String> {
        let listener =
            TcpListener::bind("127.0.0.1:0").map_err(|_| "Browser QA listener unavailable.")?;
        listener
            .set_nonblocking(true)
            .map_err(|_| "Browser QA listener unavailable.")?;
        let origin = format!(
            "http://{}",
            listener
                .local_addr()
                .map_err(|_| "Browser QA address unavailable.")?
        );
        let stop = Arc::new(AtomicBool::new(false));
        let ending = stop.clone();
        let thread = std::thread::spawn(move || {
            let mut workers: Vec<JoinHandle<()>> = Vec::new();
            while !ending.load(Ordering::Acquire) {
                let mut index = 0;
                while index < workers.len() {
                    if workers[index].is_finished() {
                        let _ = workers.swap_remove(index).join();
                    } else {
                        index += 1;
                    }
                }
                if let Ok((stream, _)) = listener.accept() {
                    if workers.len() < 16 {
                        let stopped = ending.clone();
                        workers.push(std::thread::spawn(move || serve(stream, &stopped)));
                    }
                } else {
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
            for worker in workers {
                let _ = worker.join();
            }
        });
        Ok(Self {
            origin,
            stop,
            thread: Some(thread),
        })
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
fn serve(mut stream: TcpStream, stop: &AtomicBool) {
    if stream
        .set_read_timeout(Some(Duration::from_millis(50)))
        .is_err()
        || stream
            .set_write_timeout(Some(Duration::from_millis(300)))
            .is_err()
    {
        return;
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut request = [0u8; 4096];
    let mut count = 0;
    while count < request.len() && !request[..count].windows(4).any(|b| b == b"\r\n\r\n") {
        if stop.load(Ordering::Acquire) || Instant::now() >= deadline {
            return;
        }
        match stream.read(&mut request[count..]) {
            Ok(0) => return,
            Ok(size) => count += size,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(_) => return,
        }
    }
    // Never respond to a speculative connection or an incomplete request.
    if !request[..count].windows(4).any(|b| b == b"\r\n\r\n") || stop.load(Ordering::Acquire) {
        return;
    }
    let path = std::str::from_utf8(&request[..count])
        .ok()
        .and_then(|r| r.split("\r\n").next())
        .and_then(|line| line.strip_prefix("GET "))
        .and_then(|line| line.strip_suffix(" HTTP/1.1"));
    let body = match path {
        Some("/scroll") => "<!doctype html><title>Scroll fixture</title><script>Object.defineProperty(Document.prototype,'visibilityState',{get:()=> 'visible'});</script><style>body{margin:0}main{position:relative;min-height:5000px;background:#eee}button{position:absolute;top:1250px;left:40px;height:40px}#result{position:absolute;top:1300px}</style><main><h1>Public scrolling report</h1><button onclick=\"document.getElementById('result').textContent='Scrolled action verified'\">Finish scroll</button><button style=\"top:50px\" onclick=\"window.open('/second','_blank')\">Open scroll companion</button><p id=result>Not finished</p></main>",
        Some("/private") => "<!doctype html><title>Private step</title><label>Password<input type=password value='Hidden password delta'></label>",
        Some("/file") => "<!doctype html><title>Private file step</title><label>Choose file<input type=file></label>",
        _ => "<!doctype html><title>Mivlet browser fixture</title><script>Object.defineProperty(Document.prototype,'visibilityState',{get:()=> 'visible'});</script><h1>Quarterly report</h1><p>Revenue 42</p><button onclick=\"document.getElementById('result').textContent='Activated once'\">Activate once</button><button onclick=\"window.open('/second','_blank')\">Open second tab</button><p id=result>Not activated</p><label>Notes<input value='Hidden entry alpha'></label><textarea>Hidden entry beta</textarea><div contenteditable=true>Hidden entry gamma</div><iframe srcdoc=\"<p>Hidden subframe epsilon</p>\"></iframe>",
    };
    let body = if path == Some("/second") {
        body.replace("Mivlet browser fixture", "Second tab fixture")
    } else {
        body.into()
    };
    let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
    let _ = stream.write_all(response.as_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;
    fn response(stream: &mut TcpStream) -> String {
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        stream
            .write_all(b"GET /report HTTP/1.1\r\nHost: fixture\r\n\r\n")
            .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    }
    #[test]
    fn preconnect_does_not_delay_a_request_and_is_not_closed_at_300ms() {
        let server = Server::start().unwrap();
        let address = server.origin.strip_prefix("http://").unwrap();
        let mut idle = TcpStream::connect(address).unwrap();
        let mut active = TcpStream::connect(address).unwrap();
        assert!(response(&mut active).contains("Quarterly report"));
        std::thread::sleep(Duration::from_millis(350));
        assert!(response(&mut idle).contains("Quarterly report"));
    }
    #[test]
    fn stop_joins_idle_workers_without_waiting_for_the_five_second_deadline() {
        let server = Server::start().unwrap();
        let _idle = TcpStream::connect(server.origin.strip_prefix("http://").unwrap()).unwrap();
        std::thread::sleep(Duration::from_millis(50));
        let began = Instant::now();
        drop(server);
        assert!(began.elapsed() < Duration::from_secs(2));
    }
}
