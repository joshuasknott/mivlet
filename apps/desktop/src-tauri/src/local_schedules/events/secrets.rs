//! Protected-secret consumer contract. The owning secret track registers its
//! native scoped verifier. No raw secret or generic credential getter crosses it.
use super::models::EventConfig;
use std::sync::OnceLock;

type Verifier = fn(&str, &str, &str, &str, &[u8], &str) -> Result<bool, String>;
static VERIFIER: OnceLock<Verifier> = OnceLock::new();

pub(crate) fn register_signing_verifier(verifier: Verifier) -> Result<(), String> {
    VERIFIER
        .set(verifier)
        .map_err(|_| "The event signing verifier was already initialized.".into())
}

pub(super) fn verify(
    workspace: &str,
    agent: &str,
    target: &str,
    config: &EventConfig,
    body: &[u8],
    signature: &str,
) -> Result<bool, String> {
    VERIFIER.get().ok_or("Protected signing-key setup is unavailable. Integrate the protected-secret native API before enabling event triggers.")?(workspace,agent,&config.signing_key_id,target,body,signature)
}

pub(super) fn require_key(
    workspace: &str,
    agent: &str,
    target: &str,
    config: &EventConfig,
) -> Result<(), String> {
    // A false HMAC comparison still establishes scoped key presence. Missing,
    // revoked or differently scoped keys return an error from the owner API.
    verify(
        workspace,
        agent,
        target,
        config,
        b"",
        &format!("sha256={}", "00".repeat(32)),
    )
    .map(|_| ())
}
