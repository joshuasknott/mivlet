//! Passphrase-encrypted, explicitly initiated portable workspace transfer.
//!
//! The public command surface accepts only an optional workspace identifier;
//! native dialogs own file selection, confirmation, and passphrase capture.

mod commands;
mod data;
mod envelope;
#[cfg(test)]
mod tests;

// Re-export both the commands and the macro-generated `__cmd__*` symbols so
// `tauri::generate_handler![portable_transfer::portable_transfer_export]`
// remains valid when the implementations live in the commands submodule.
pub use commands::*;
pub use envelope::{MAX_PASSPHRASE_CHARS, MIN_PASSPHRASE_CHARS};
