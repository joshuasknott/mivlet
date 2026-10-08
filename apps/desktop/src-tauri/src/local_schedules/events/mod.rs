//! Authenticated events extend local schedules. No event supplies permission,
//! runs a provider, restores an approval, or bypasses the canonical Work owner.
pub(crate) mod commands;
mod delivery;
mod dispatch;
pub(crate) mod ingress;
mod maintenance;
pub(crate) mod models;
mod secrets;
mod signature;
mod template;

pub(super) use dispatch::claim;
pub(crate) use ingress::EventIngress;
pub(crate) use secrets::pause_revoked_key;
pub(super) use secrets::{require_occurrence_key, require_schedule_key};
pub(crate) fn start_maintenance() {
    maintenance::start();
}

#[cfg(test)]
mod tests;
