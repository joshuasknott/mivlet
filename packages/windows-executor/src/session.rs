//! Reconnectable controls for one exact restricted process; no PID adoption.
use crate::Binding;
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

#[cfg(windows)]
#[path = "session_windows.rs"]
mod platform;
#[cfg(windows)]
pub use platform::PreviewStream;
#[cfg(not(windows))]
pub struct PreviewStream;
#[cfg(not(windows))]
impl std::io::Read for PreviewStream {
    fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
        Err(std::io::ErrorKind::Unsupported.into())
    }
}
#[cfg(not(windows))]
impl std::io::Write for PreviewStream {
    fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
        Err(std::io::ErrorKind::Unsupported.into())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
#[cfg(not(windows))]
impl PreviewStream {
    pub fn try_clone(&self) -> std::io::Result<Self> {
        Err(std::io::ErrorKind::Unsupported.into())
    }
}

#[derive(Clone, Copy, Default, Debug)]
pub struct SessionOptions {
    pub interactive: bool,
    pub preview_port: Option<u16>,
}
#[derive(Clone, Debug)]
pub struct PreviewSpec {
    pub port: u16,
    pub pipe_name: String,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum InputDelivery {
    Accepted,
    Uncertain,
}

struct State {
    input_id: Option<String>,
    closed: bool,
    #[cfg(windows)]
    endpoint: Option<platform::Endpoint>,
}
struct Inner {
    binding: Binding,
    options: SessionOptions,
    preview: Option<PreviewSpec>,
    cancel: Arc<AtomicBool>,
    writing: AtomicBool,
    ready: AtomicBool,
    state: Mutex<State>,
}
#[derive(Clone)]
pub struct SessionControl(Arc<Inner>);
impl SessionControl {
    pub fn binding(&self) -> Binding {
        self.0.binding.clone()
    }
    /// Cheap UI/navigation guard; never opens a pipe or waits for a peer.
    pub fn is_current(&self, binding: &Binding) -> bool {
        if self.0.binding != *binding || self.0.cancel.load(Ordering::Acquire) {
            return false;
        }
        self.0.ready.load(Ordering::Acquire)
    }
    pub fn new(
        binding: Binding,
        options: SessionOptions,
        cancel: Arc<AtomicBool>,
    ) -> Result<Self, String> {
        if binding.scope_id.len() != 64
            || !binding.scope_id.bytes().all(|b| b.is_ascii_hexdigit())
            || binding.generation == 0
            || binding.operation_id == 0
            || options.preview_port == Some(0)
        {
            return Err(
                "A session requires the exact current execution binding and preview port.".into(),
            );
        }
        let preview = options
            .preview_port
            .map(|port| {
                let mut bytes = [0; 24];
                getrandom::fill(&mut bytes)
                    .map_err(|_| "The private preview identity is unavailable.")?;
                Ok::<_, String>(PreviewSpec {
                    port,
                    pipe_name: format!(r"\\.\pipe\LOCAL\MivletPreview-{}", hex::encode(bytes)),
                })
            })
            .transpose()?;
        Ok(Self(Arc::new(Inner {
            binding,
            options,
            preview,
            cancel,
            writing: AtomicBool::new(false),
            ready: AtomicBool::new(false),
            state: Mutex::new(State {
                input_id: None,
                closed: false,
                #[cfg(windows)]
                endpoint: None,
            }),
        })))
    }
    pub fn options(&self) -> SessionOptions {
        self.0.options
    }
    pub fn preview_spec(&self) -> Option<PreviewSpec> {
        self.0.preview.clone()
    }
    pub(crate) fn check(&self, binding: &Binding) -> Result<(), String> {
        if self.0.binding != *binding
            || self.0.cancel.load(Ordering::Acquire)
            || self
                .0
                .state
                .lock()
                .map_err(|_| "Session state is unavailable.")?
                .closed
        {
            Err(
                "This restricted session ended or its exact owner changed. No input was replayed."
                    .into(),
            )
        } else {
            Ok(())
        }
    }
    pub fn input_id(&self, binding: &Binding) -> Result<String, String> {
        self.check(binding)?;
        self.0
            .state
            .lock()
            .map_err(|_| "Session state is unavailable.")?
            .input_id
            .clone()
            .ok_or("The restricted snapshot is still preparing.".into())
    }
    pub fn open_preview(&self, binding: &Binding) -> Result<PreviewStream, String> {
        self.check(binding)?;
        #[cfg(windows)]
        {
            let endpoint = self
                .0
                .state
                .lock()
                .map_err(|_| "Session state is unavailable.")?
                .endpoint
                .clone()
                .ok_or("The restricted session is still preparing.")?;
            let spec = self
                .preview_spec()
                .ok_or("This job was not approved with an HTTP preview port.")?;
            let stream = endpoint.open_preview(&spec, self.clone())?;
            self.check(binding)?;
            Ok(stream)
        }
        #[cfg(not(windows))]
        {
            Err("Previews require restricted Windows execution.".into())
        }
    }
    /// Accepted confirms pipe delivery only. The application may still reject
    /// the input. Uncertain terminates the exact Job and must never be retried.
    pub fn write_input(&self, binding: &Binding, text: String) -> Result<InputDelivery, String> {
        self.check(binding)?;
        if !self.0.options.interactive
            || text.is_empty()
            || text.len() > 4096
            || text.contains('\0')
        {
            return Err(
                "This job needs approved interactive input of 1–4096 bytes without NUL.".into(),
            );
        }
        if self
            .0
            .writing
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err("An input receipt is still pending. No input was replayed.".into());
        }
        struct Finish(SessionControl);
        impl Drop for Finish {
            fn drop(&mut self) {
                self.0 .0.writing.store(false, Ordering::Release);
            }
        }
        let _finish = Finish(self.clone());
        #[cfg(windows)]
        {
            let endpoint = self
                .0
                .state
                .lock()
                .map_err(|_| "Session state is unavailable.")?
                .endpoint
                .clone()
                .ok_or("The restricted session is still preparing.")?;
            endpoint.write_input(self.clone(), text)
        }
        #[cfg(not(windows))]
        {
            let _ = text;
            Err("Interactive sessions require restricted Windows execution.".into())
        }
    }
    pub fn stop(&self) {
        self.0.cancel.store(true, Ordering::Release);
        #[cfg(windows)]
        if let Ok(state) = self.0.state.lock() {
            if let Some(endpoint) = &state.endpoint {
                endpoint.stop();
            }
        }
    }
    pub(crate) fn close(&self) {
        self.0.ready.store(false, Ordering::Release);
        if let Ok(mut state) = self.0.state.lock() {
            state.closed = true;
            #[cfg(windows)]
            {
                state.endpoint = None;
            }
        }
    }
    #[cfg(windows)]
    pub(crate) fn install(
        &self,
        writer: Option<crate::security::Handle>,
        job: &crate::security::Handle,
        profile: &str,
        input_id: &str,
    ) -> Result<(), String> {
        self.check(&self.0.binding)?;
        let endpoint = platform::Endpoint::new(writer, job, profile)?;
        let mut state = self
            .0
            .state
            .lock()
            .map_err(|_| "Session state is unavailable.")?;
        if state.closed || state.endpoint.is_some() {
            return Err("Restricted session control was already installed.".into());
        }
        state.input_id = Some(input_id.to_owned());
        state.endpoint = Some(endpoint);
        self.0.ready.store(true, Ordering::Release);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn control_never_adopts_another_binding_or_revoked_owner() {
        let binding = Binding {
            scope_id: "a".repeat(64),
            generation: 1,
            operation_id: 2,
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
        let spec = control.preview_spec().unwrap();
        assert_eq!(spec.port, 4173);
        assert!(spec.pipe_name.starts_with(r"\\.\pipe\LOCAL\MivletPreview-"));
        let mut stale = binding.clone();
        stale.operation_id += 1;
        assert!(control.write_input(&stale, "x".into()).is_err());
        assert!(control.input_id(&binding).is_err());
        cancel.store(true, Ordering::Release);
        assert!(control.check(&binding).is_err());
    }
}
