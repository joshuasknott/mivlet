use chrono::{DateTime, Duration, Utc};
use url::Url;

use super::{NavigationPolicy, ValidatedStream};

/// Validate the provider response before any native WebView is created.
///
/// `expected_origin` is supplied by native configuration, never by React or a
/// remote response. The returned object retains the URL only in native memory.
pub(super) fn validate_stream(
    machine_id: &str,
    expected_origin: &str,
    stream_url: &str,
    expires_at: DateTime<Utc>,
    now: DateTime<Utc>,
) -> Result<ValidatedStream, String> {
    validate_machine_id(machine_id)?;
    let expected = parse_origin(expected_origin)?;
    if stream_url.len() > super::MAX_STREAM_URL_BYTES {
        return Err("Instabox desktop link is too large.".into());
    }
    let returned = Url::parse(stream_url).map_err(|_| "Instabox desktop link is invalid.")?;
    if returned.origin().ascii_serialization() != expected {
        return Err("Instabox desktop link returned an unexpected origin.".into());
    }
    // The API returns a bearer link to the dashboard viewer. This is not the
    // API path and must never be reconstructed from a machine id in React.
    let expected_path = format!("/dashboard/desktop/{machine_id}");
    if returned.path() != expected_path
        || returned.username() != ""
        || returned.password().is_some()
        || returned.query().is_some()
    {
        return Err("Instabox desktop link returned an unexpected path.".into());
    }
    let fragment = returned
        .fragment()
        .ok_or("Instabox desktop link has no bearer fragment.")?;
    let fragment_raw = stream_url
        .split_once('#')
        .map(|(_, fragment)| fragment)
        .ok_or("Instabox desktop link has no bearer fragment.")?;
    if fragment_raw.len() > super::MAX_FRAGMENT_BYTES
        || !fragment.starts_with("token=")
        || fragment.len() == "token=".len()
        || fragment.as_bytes().iter().any(|byte| {
            byte.is_ascii_control() || *byte == b' ' || *byte == b'\n' || *byte == b'\r'
        })
        || encoded_control_in_fragment(stream_url)
    {
        return Err("Instabox desktop link has an invalid bearer fragment.".into());
    }
    if expires_at <= now {
        return Err("Instabox desktop link has already expired.".into());
    }
    if expires_at > now + Duration::seconds(super::STREAM_TTL_SECONDS as i64 + 5) {
        return Err("Instabox desktop link exceeds Mivlet's 60-second limit.".into());
    }
    Ok(ValidatedStream {
        url: stream_url.to_owned(),
        expires_at,
        navigation: NavigationPolicy {
            origin: expected,
            path: expected_path,
            fragment_raw: fragment_raw.to_owned(),
        },
    })
}

fn parse_origin(origin: &str) -> Result<String, String> {
    let parsed = Url::parse(origin).map_err(|_| "Instabox viewer origin is invalid.")?;
    if parsed.scheme() != "https"
        || parsed.username() != ""
        || parsed.password().is_some()
        || !(parsed.path().is_empty() || parsed.path() == "/")
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.host_str().is_none()
    {
        return Err("Instabox viewer origin must be an HTTPS origin.".into());
    }
    Ok(parsed.origin().ascii_serialization())
}

pub(super) fn validate_machine_id(machine_id: &str) -> Result<(), String> {
    if machine_id.len() != super::MACHINE_ID_BYTES
        || !machine_id.starts_with("m_")
        || !machine_id[2..]
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || (b'2'..=b'7').contains(&byte))
    {
        return Err("Instabox machine identity is invalid.".into());
    }
    Ok(())
}

fn encoded_control_in_fragment(uri: &str) -> bool {
    let Some((_, fragment)) = uri.split_once('#') else {
        return true;
    };
    let bytes = fragment.as_bytes();
    bytes.windows(3).any(|window| {
        window[0] == b'%'
            && window[1].is_ascii_hexdigit()
            && window[2].is_ascii_hexdigit()
            && u8::from_str_radix(std::str::from_utf8(&window[1..]).unwrap_or("00"), 16)
                .is_ok_and(|value| value < 0x20 || value == 0x7f)
    })
}
