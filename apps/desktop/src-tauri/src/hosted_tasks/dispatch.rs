//! Short-lived native egress fences. Registered inside the canonical claim
//! transaction, cancelled by Work Stop before commit, never restored from disk.
use super::models::Binding;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
struct Gate {
    binding: Binding,
    cancelled: bool,
}
type Entries = HashMap<String, Arc<Mutex<Gate>>>;
fn entries() -> &'static Mutex<Entries> {
    static ENTRIES: OnceLock<Mutex<Entries>> = OnceLock::new();
    ENTRIES.get_or_init(|| Mutex::new(HashMap::new()))
}
const STOPPED: &str =
    "This cloud Work stopped or changed before admission. No later task request was sent.";
pub(crate) fn register(binding: &Binding) -> Result<(), String> {
    let mut all = entries().lock().map_err(|_| STOPPED)?;
    if all.contains_key(&binding.admission_id) || all.len() >= 16 {
        return Err(
            "Cloud admission is already in flight or its bounded native dispatch slots are full."
                .into(),
        );
    }
    all.insert(
        binding.admission_id.clone(),
        Arc::new(Mutex::new(Gate {
            binding: binding.clone(),
            cancelled: false,
        })),
    );
    Ok(())
}
pub(crate) fn cancel(binding: &Binding) {
    let gate = entries()
        .lock()
        .ok()
        .and_then(|all| all.get(&binding.admission_id).cloned());
    if let Some(gate) = gate {
        if let Ok(mut gate) = gate.lock() {
            if gate.binding == *binding {
                gate.cancelled = true;
            }
        }
    }
}
pub(crate) fn with_current<T>(
    binding: &Binding,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let gate = entries()
        .lock()
        .map_err(|_| STOPPED)?
        .get(&binding.admission_id)
        .cloned()
        .ok_or(STOPPED)?;
    let gate = gate.lock().map_err(|_| STOPPED)?;
    if gate.cancelled || gate.binding != *binding {
        return Err(STOPPED.into());
    }
    // The callback performs only nonblocking HTTP future polls. No Store,
    // credential capture, account resolution, or other async work under lock.
    operation()
}
pub(crate) struct AdmissionGuard {
    id: String,
}
impl AdmissionGuard {
    pub(crate) fn retain(binding: &Binding) -> Self {
        Self {
            id: binding.admission_id.clone(),
        }
    }
}
impl Drop for AdmissionGuard {
    fn drop(&mut self) {
        if let Ok(mut all) = entries().lock() {
            all.remove(&self.id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stop_during_capability_wait_prevents_a_later_admission_send() {
        let binding = super::super::tests::binding();
        register(&binding).unwrap();
        let _guard = AdmissionGuard::retain(&binding);
        let waiting = Arc::new(std::sync::Barrier::new(2));
        let resume = Arc::new(std::sync::Barrier::new(2));
        let before = waiting.clone();
        let after = resume.clone();
        let sent = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let output = sent.clone();
        let target = binding.clone();
        let task = std::thread::spawn(move || {
            before.wait();
            after.wait();
            with_current(&target, || {
                output.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
                Ok(())
            })
        });
        waiting.wait();
        cancel(&binding);
        resume.wait();
        assert!(task.join().unwrap().is_err());
        assert_eq!(sent.load(std::sync::atomic::Ordering::Acquire), 0);
    }
}
