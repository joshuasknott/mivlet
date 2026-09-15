//! Dual-read `MIVLET_*` then legacy `FABLE_*` environment names.
//!
//! Deprecated: `FABLE_*` aliases remain for one deploy cycle so existing
//! operator secrets keep working. A present empty `MIVLET_*` value does not
//! fall through (fail closed). Values are never logged.

use std::sync::atomic::{AtomicBool, Ordering};

static WARNED_LEGACY_ALIAS: AtomicBool = AtomicBool::new(false);

fn warn_legacy_alias() {
    if WARNED_LEGACY_ALIAS.swap(true, Ordering::Relaxed) {
        return;
    }
    eprintln!("mivlet: using deprecated FABLE_* environment aliases; set MIVLET_* instead");
}

/// Read `key` (`MIVLET_*`), then the matching `FABLE_*` alias when missing.
pub fn var_named(key: &str) -> Result<String, std::env::VarError> {
    match std::env::var(key) {
        Ok(value) => Ok(value),
        Err(std::env::VarError::NotPresent) => match key.strip_prefix("MIVLET_") {
            Some(suffix) => match std::env::var(format!("FABLE_{suffix}")) {
                Ok(value) => {
                    warn_legacy_alias();
                    Ok(value)
                }
                Err(error) => Err(error),
            },
            None => Err(std::env::VarError::NotPresent),
        },
        Err(error) => Err(error),
    }
}

/// OS-string variant of [`var_named`].
pub fn var_os_named(key: &str) -> Option<std::ffi::OsString> {
    match std::env::var_os(key) {
        Some(value) => Some(value),
        None => key.strip_prefix("MIVLET_").and_then(|suffix| {
            let legacy = std::env::var_os(format!("FABLE_{suffix}"));
            if legacy.is_some() {
                warn_legacy_alias();
            }
            legacy
        }),
    }
}

pub fn var_opt(key: &str) -> Option<String> {
    var_named(key).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn with_env(mivlet: Option<&str>, fable: Option<&str>, body: impl FnOnce()) {
        let _guard = ENV_LOCK.lock().expect("env lock");
        let old_mivlet = std::env::var("MIVLET_ENV_COMPAT_TEST").ok();
        let old_fable = std::env::var("FABLE_ENV_COMPAT_TEST").ok();
        match mivlet {
            Some(value) => std::env::set_var("MIVLET_ENV_COMPAT_TEST", value),
            None => std::env::remove_var("MIVLET_ENV_COMPAT_TEST"),
        }
        match fable {
            Some(value) => std::env::set_var("FABLE_ENV_COMPAT_TEST", value),
            None => std::env::remove_var("FABLE_ENV_COMPAT_TEST"),
        }
        body();
        match old_mivlet {
            Some(value) => std::env::set_var("MIVLET_ENV_COMPAT_TEST", value),
            None => std::env::remove_var("MIVLET_ENV_COMPAT_TEST"),
        }
        match old_fable {
            Some(value) => std::env::set_var("FABLE_ENV_COMPAT_TEST", value),
            None => std::env::remove_var("FABLE_ENV_COMPAT_TEST"),
        }
    }

    #[test]
    fn reads_legacy_fable_alias_when_mivlet_is_unset() {
        with_env(None, Some("legacy"), || {
            assert_eq!(var_named("MIVLET_ENV_COMPAT_TEST").unwrap(), "legacy");
        });
    }

    #[test]
    fn present_empty_mivlet_does_not_fall_through() {
        with_env(Some(""), Some("legacy"), || {
            assert_eq!(var_named("MIVLET_ENV_COMPAT_TEST").unwrap(), "");
        });
    }

    #[test]
    fn prefers_mivlet_when_both_are_set() {
        with_env(Some("current"), Some("legacy"), || {
            assert_eq!(var_named("MIVLET_ENV_COMPAT_TEST").unwrap(), "current");
        });
    }
}
