//! Stable public scheduler facade.
//!
//! Startup and Tauri command registration continue to use `scheduler::…`.
//! Runtime orchestration, pure invariants, and persistence adapters live below
//! this boundary so they can evolve without changing that command surface.

mod events;
mod logic;
mod persistence;
mod routine_runtime;
mod runtime;
mod state;

pub(crate) use routine_runtime::{observe_connection_event, ConnectionEventObservation};
pub use runtime::*;
