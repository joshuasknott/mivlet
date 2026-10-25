//! Opt-in native checks. These use an isolated dummy entry, never user credentials.

#[test]
#[ignore = "requires an unlocked Linux Secret Service session and explicit opt-in"]
fn linux_secret_service_acceptance() {
    assert_eq!(
        std::env::var("MIVLET_LINUX_SECRET_SERVICE_ACCEPTANCE").as_deref(),
        Ok("1"),
        "Set MIVLET_LINUX_SECRET_SERVICE_ACCEPTANCE=1 in the desktop session."
    );
    let mut nonce = [0_u8; 16];
    getrandom::fill(&mut nonce).expect("OS randomness unavailable");
    let name = format!("probe-{}", hex::encode(nonce));
    let entry = keyring::Entry::new("com.mivlet.linux-acceptance", &name)
        .expect("Linux Secret Service could not be opened");
    struct Cleanup(keyring::Entry);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = self.0.delete_credential();
        }
    }
    let entry = Cleanup(entry);
    let synthetic = "mivlet-non-secret-native-storage-probe";
    entry
        .0
        .set_password(synthetic)
        .expect("Secret Service could not store the dummy entry; unlock the wallet");
    // Construct another native entry so this cannot pass from an application cache.
    let reopened = keyring::Entry::new("com.mivlet.linux-acceptance", &name)
        .expect("Secret Service entry could not be reopened");
    assert_eq!(
        reopened
            .get_password()
            .expect("Dummy entry could not be read"),
        synthetic
    );
    reopened
        .delete_credential()
        .expect("Dummy entry could not be removed");
    assert!(matches!(
        reopened.get_password(),
        Err(keyring::Error::NoEntry)
    ));
}
