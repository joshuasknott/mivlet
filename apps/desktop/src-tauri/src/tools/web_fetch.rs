//! Web-fetch URL policy, source formatting, and approved egress.
//!
//! Keeping validation, source shaping, and the DNS-pinned request loop together
//! prevents approval fingerprints and redirect checks from drifting apart.

use std::net::{IpAddr, Ipv6Addr};
use std::time::Duration;

use dom_smoothie::{Config as ReadabilityConfig, Readability, TextMode};
use reqwest::header::{HeaderMap, HeaderValue};
use serde::Serialize;
use sha2::{Digest, Sha256};
use url::Url;

use super::{require_string_argument, ToolResult, MAX_TOOL_OUTPUT_BYTES};

// ---------------------------------------------------------------------------
// web-fetch SSRF / outbound policy (fail-closed). All checks before or at
// egress; approval fingerprint binds the *normalized* URL; redirects and DNS
// are re-validated on every hop.
// ---------------------------------------------------------------------------

/// Max redirects followed for web-fetch (explicit, small to bound).
pub(crate) const WEB_FETCH_MAX_REDIRECTS: usize = 5;

/// Max wall time for an entire web-fetch including redirects/DNS.
pub(crate) const WEB_FETCH_TIMEOUT_SECS: u64 = 30;

/// Max body bytes (decompressed) returned/copied for web-fetch. Matches other
/// tool output bounds to avoid OOM or unbounded buffers.
pub(crate) const WEB_FETCH_MAX_BODY_BYTES: usize = MAX_TOOL_OUTPUT_BYTES;

/// Leave room for source metadata and the agent loop's truncation marker.
pub(crate) const WEB_FETCH_MAX_READABLE_CHARACTERS: usize = 56_000;

/// Return a canonical fingerprint form for a web-fetch URL (strips default
/// ports and credentials). Used so approval binds the normalized request.
pub(crate) fn normalize_url_for_fingerprint(raw: &str) -> Option<String> {
    let mut url = Url::parse(raw).ok()?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return None;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    if let Some(port) = url.port() {
        if (url.scheme() == "http" && port == 80) || (url.scheme() == "https" && port == 443) {
            let _ = url.set_port(None);
        }
    }
    Some(url.to_string())
}

/// Parse + basic structural validation for a web-fetch target (scheme, creds,
/// host presence, port policy, hostname aliases, IP-literal blocks). Does not
/// perform DNS (see resolve_and_check_host for domain hostname DNS results).
pub(crate) fn parse_and_validate_fetch_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|e| format!("web-fetch requires a valid URL: {}", e))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("web-fetch requires an http(s) URL.".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("web-fetch does not allow embedded credentials.".to_string());
    }
    if url.host().is_none() {
        return Err("web-fetch requires a host.".to_string());
    }
    if let Some(port) = url.port() {
        if is_unsafe_port(port) {
            return Err("web-fetch to an unsafe port is not permitted.".to_string());
        }
    }
    // Hostname validation (localhost aliases) at parse for early fail-closed
    // and pure-test coverage. Complements IP-literal checks + DNS result
    // validation in resolve_and_check_host (every hop / redirect).
    if let Some(h) = url.host_str() {
        if is_forbidden_hostname(h) {
            return Err(
                "web-fetch blocked: target is a loopback, private, reserved, link-local, multicast, unspecified, or cloud-metadata address.".to_string(),
            );
        }
    }
    // IP literals are checked at parse time (covers alt encodings because the
    // Url parser + Host::Ipv* yields the semantic address).
    if let Some(host) = url.host() {
        match host {
            url::Host::Ipv4(ip) => {
                if is_forbidden_ip(IpAddr::V4(ip)) {
                    return Err(
                        "web-fetch blocked: target is a loopback, private, reserved, link-local, multicast, unspecified, or cloud-metadata address.".to_string(),
                    );
                }
            }
            url::Host::Ipv6(ip) => {
                if is_forbidden_ip(IpAddr::V6(ip)) {
                    return Err(
                        "web-fetch blocked: target is a loopback, private, reserved, link-local, multicast, unspecified, or cloud-metadata address.".to_string(),
                    );
                }
            }
            url::Host::Domain(_) => {}
        }
    }
    Ok(url)
}

pub(crate) fn is_unsafe_port(port: u16) -> bool {
    // Common unsafe/internal ports (ssh, smtp, smb, dbs, etc.). Standard web
    // ports and developer ports are intentionally not listed here.
    matches!(
        port,
        22 | 23
            | 25
            | 53
            | 110
            | 135
            | 139
            | 143
            | 445
            | 465
            | 587
            | 993
            | 995
            | 1433
            | 1521
            | 2049
            | 2379
            | 3306
            | 3389
            | 5432
            | 5672
            | 6379
            | 7001
            | 8001
            | 8081
            | 8444
            | 9001
    )
}

/// Returns true for IPs that must never be reachable via web-fetch (fail-closed
/// SSRF policy). Covers IPv4/IPv6 loopback, private, reserved (TEST-NET,
/// benchmark, IETF etc.), link-local, multicast, unspecified, plus common
/// cloud instance metadata endpoints.
pub(crate) fn is_forbidden_ip(ip: IpAddr) -> bool {
    if is_cloud_metadata_ip(ip) {
        return true;
    }
    match ip {
        IpAddr::V4(v4) => {
            v4.is_unspecified()
                || v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_multicast()
                || v4.is_broadcast()
                || v4.octets()[0] >= 240
                || is_reserved_v4(v4)
        }
        IpAddr::V6(v6) => {
            v6.is_unspecified()
                || v6.is_loopback()
                || is_ipv6_link_local(&v6)
                || is_ipv6_unique_local(&v6)
                || v6.is_multicast()
                || v6
                    .to_ipv4_mapped()
                    .is_some_and(|v4| is_forbidden_ip(IpAddr::V4(v4)))
        }
    }
}

fn is_cloud_metadata_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            // AWS, GCP, Azure, DigitalOcean, etc.
            o == [169, 254, 169, 254]
                // Alibaba Cloud
                || o == [100, 100, 100, 200]
                // packet metadata sometimes on 169.254.169.254
                || (o[0] == 169 && o[1] == 254 && o[2] == 169)
        }
        IpAddr::V6(_) => false,
    }
}

/// Additional reserved ranges per IANA (not covered by is_private / link_local etc.).
/// Includes TEST-NET-* documentation ranges and benchmark. Called from
/// is_forbidden_ip to satisfy objective "reserved".
fn is_reserved_v4(v4: std::net::Ipv4Addr) -> bool {
    let o = v4.octets();
    // TEST-NET-1 (RFC 5737)
    (o[0] == 192 && o[1] == 0 && o[2] == 2)
        // TEST-NET-2
        || (o[0] == 198 && o[1] == 51 && o[2] == 100)
        // TEST-NET-3
        || (o[0] == 203 && o[1] == 0 && o[2] == 113)
        // Benchmarking (198.18.0.0/15, RFC 2544)
        || (o[0] == 198 && (o[1] == 18 || o[1] == 19))
        // IETF protocol assignments (192.0.0.0/24)
        || (o[0] == 192 && o[1] == 0 && o[2] == 0)
}

fn is_ipv6_link_local(v6: &Ipv6Addr) -> bool {
    let s = v6.segments();
    (s[0] & 0xffc0) == 0xfe80
}

fn is_ipv6_unique_local(v6: &Ipv6Addr) -> bool {
    let s = v6.segments();
    (s[0] & 0xfe00) == 0xfc00
}

/// Hostname-level blocks for well-known localhost / loopback aliases.
/// Called from parse_and_validate_fetch_url (before DNS) so that pure unit
/// tests can exercise "localhost aliases" rejections without network, and
/// to satisfy fail-closed hostname validation in the objective.
fn is_forbidden_hostname(host: &str) -> bool {
    let h = host.to_ascii_lowercase();
    h == "localhost"
        || h == "local"
        || h == "localhost.localdomain"
        || h == "ip6-localhost"
        || h == "ip6-loopback"
        || h.ends_with(".localhost")
        || h.ends_with(".local")
}

async fn resolve_and_check_host(
    host: &str,
    port: u16,
) -> Result<Vec<std::net::SocketAddr>, String> {
    // Resolve once, reject the whole answer if any address is forbidden, then
    // pin this exact answer set into reqwest. Checking DNS and subsequently
    // allowing the HTTP client to resolve again would leave a rebinding race.
    let addrs = tokio::net::lookup_host((host, port))
        .await
        .map_err(|_| "DNS resolution failed for web-fetch target".to_string())?
        .collect::<Vec<_>>();
    if addrs.is_empty() {
        return Err("DNS resolution returned no addresses for web-fetch target".to_string());
    }
    for sa in &addrs {
        if is_forbidden_ip(sa.ip()) {
            return Err(
                "web-fetch blocked: target resolves to a loopback, private, reserved, link-local, multicast, unspecified, or cloud-metadata address (DNS rebinding protection).".to_string(),
            );
        }
    }
    Ok(addrs)
}

/// Read a response incrementally with a hard cap. `Response::bytes()` would
/// materialize an untrusted body before checking its length.
async fn read_bounded_text(
    mut response: reqwest::Response,
    max_bytes: usize,
) -> Result<String, String> {
    if let Some(len) = response.content_length() {
        if len > max_bytes as u64 {
            return Err("web-fetch blocked: response body too large".to_string());
        }
    }
    let mut bytes =
        Vec::with_capacity(response.content_length().unwrap_or(0).min(max_bytes as u64) as usize);
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("web-fetch body read error: {}", e))?
    {
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Err("web-fetch blocked: response body too large".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

pub(crate) fn is_supported_response_type(content_type: &str) -> bool {
    if content_type.trim().is_empty() {
        return true; // unspecified; try as text
    }
    let t = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if t.starts_with("image/")
        || t.starts_with("audio/")
        || t.starts_with("video/")
        || t == "application/octet-stream"
        || t == "application/pdf"
        || t == "application/zip"
    {
        return false;
    }
    true
}

fn redact_for_error(raw: &str) -> String {
    // Never echo full target URLs or credentials in error surfaces that may
    // be returned to the agent loop / history.
    if raw.contains("://") || raw.contains('@') {
        "connection or policy error".to_string()
    } else {
        // keep short actionable without secrets
        raw.chars().take(120).collect()
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WebPageSourceResult {
    trust: &'static str,
    instruction_authority: &'static str,
    citation_id: String,
    title: String,
    final_uri: String,
    fetched_at: String,
    media_type: String,
    extraction: &'static str,
    truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    byline: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    site_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    published_time: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    modified_time: Option<String>,
    content: String,
}

fn bounded_readable_content(content: &str) -> (String, bool) {
    let mut chars = content.chars();
    let bounded: String = chars
        .by_ref()
        .take(WEB_FETCH_MAX_READABLE_CHARACTERS)
        .collect();
    (bounded, chars.next().is_some())
}

fn web_citation_id(final_uri: &str) -> String {
    let digest = Sha256::digest(final_uri.as_bytes());
    format!("web-{}", &hex::encode(digest)[..16])
}

/// Convert an HTTP response into a traceable, explicitly untrusted source
/// envelope before it enters model context. HTML is reduced to the main readable
/// article; text/JSON responses retain their original text representation.
pub(super) fn format_web_page_source(
    body: &str,
    final_url: &Url,
    content_type: &str,
    fetched_at: &str,
) -> String {
    let mut citation_url = final_url.clone();
    citation_url.set_fragment(None);
    let final_uri = normalize_url_for_fingerprint(citation_url.as_str())
        .unwrap_or_else(|| citation_url.to_string());
    let media_type = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let is_html = matches!(media_type.as_str(), "text/html" | "application/xhtml+xml")
        || (media_type.is_empty() && body.trim_start().starts_with('<'));

    let mut title = final_url.host_str().unwrap_or("Web page").to_string();
    let mut byline = None;
    let mut site_name = None;
    let mut published_time = None;
    let mut modified_time = None;
    let mut extraction = "plain-text";
    let readable = if is_html {
        let config = ReadabilityConfig {
            text_mode: TextMode::Markdown,
            ..Default::default()
        };
        let parsed = Readability::new(body, Some(final_uri.as_str()), Some(config))
            .and_then(|mut readability| readability.parse());
        match parsed {
            Ok(article) if !article.text_content.trim().is_empty() => {
                if !article.title.trim().is_empty() {
                    title = article.title.trim().to_string();
                }
                byline = article.byline.filter(|value| !value.trim().is_empty());
                site_name = article.site_name.filter(|value| !value.trim().is_empty());
                published_time = article
                    .published_time
                    .filter(|value| !value.trim().is_empty());
                modified_time = article
                    .modified_time
                    .filter(|value| !value.trim().is_empty());
                extraction = "readability";
                article.text_content.to_string()
            }
            _ => body.to_string(),
        }
    } else {
        body.to_string()
    };
    let (content, truncated) = bounded_readable_content(readable.trim());
    let result = WebPageSourceResult {
        trust: "untrusted",
        instruction_authority: "none",
        citation_id: web_citation_id(&final_uri),
        title,
        final_uri,
        fetched_at: fetched_at.to_string(),
        media_type: if media_type.is_empty() {
            "text/plain".to_string()
        } else {
            media_type
        },
        extraction,
        truncated,
        byline,
        site_name,
        published_time,
        modified_time,
        content,
    };
    serde_json::to_string(&result)
        .unwrap_or_else(|_| "{\"trust\":\"untrusted\",\"instructionAuthority\":\"none\",\"content\":\"Mivlet could not encode the fetched page.\"}".to_string())
}

/// The outcome shape the pure web-fetch layer returns to the async command.
/// Keeping it pure (no reqwest) lets the command compose it after the GET, and
/// lets tests pin the 2xx/non-2xx/transport contract without a live socket —
/// the same shape as the streaming backend path in `native_api.rs`.
#[derive(Debug)]
pub(crate) enum WebFetchOutcome {
    /// A successful fetch: the response body text (2xx only).
    Success { body: String },
    /// A completed request with a non-2xx status (fail closed: no phantom body).
    NonSuccess { status: u16 },
    /// The request never completed (DNS/TLS/connection failure, etc.).
    TransportError { message: String },
}

impl WebFetchOutcome {
    /// Build a success outcome from a 2xx status + body.
    pub(crate) fn success(_status: u16, body: String) -> Self {
        Self::Success { body }
    }

    /// Classify a response status: 2xx → success, else fail-closed non-success.
    pub(crate) fn status(status: u16) -> Self {
        if (200..300).contains(&status) {
            Self::Success {
                body: String::new(),
            }
        } else {
            Self::NonSuccess { status }
        }
    }

    /// Build a transport-error outcome from an error message.
    pub(crate) fn transport_error(message: &str) -> Self {
        Self::TransportError {
            message: message.to_string(),
        }
    }

    /// Turn a success outcome into a ToolResult (ok=true with the body).
    pub(crate) fn into_tool_result(self) -> ToolResult {
        match self {
            Self::Success { body } => ToolResult {
                ok: true,
                output: body,
            },
            // Non-2xx and transport failures are surfaced as a failure result so
            // the loop records a tool-role error message and continues.
            Self::NonSuccess { status } => ToolResult {
                ok: false,
                output: format!("web-fetch failed with status {status}."),
            },
            Self::TransportError { message } => ToolResult {
                ok: false,
                output: format!("web-fetch transport error: {message}"),
            },
        }
    }
}

/// Validate and extract the web-fetch url argument. Requires a non-empty
/// http(s) string; stronger structural policy (no creds, no bad ports, IP
/// literal blocks for forbidden ranges) runs here for early fail-closed before
/// NeedsWebFetch decision. Full hostname DNS + redirect revalidation happens
/// at the async egress boundary.
pub(crate) fn web_fetch_url_from_args(arguments: &serde_json::Value) -> Result<String, String> {
    let url = require_string_argument(arguments, "url")?;
    // Syntax + creds + port + IP-literal policy (DNS for domains deferred).
    let _ = parse_and_validate_fetch_url(&url)?;
    Ok(url)
}

pub(super) async fn run_web_fetch_egress(url: &str) -> Result<ToolResult, String> {
    let initial =
        parse_and_validate_fetch_url(url).map_err(|e| format!("web-fetch blocked: {}", e))?;

    crate::ensure_rustls_provider();
    let mut default_headers = HeaderMap::new();
    default_headers.insert(
        reqwest::header::ACCEPT_ENCODING,
        HeaderValue::from_static("identity"),
    );
    let mut current = initial;
    let mut redirects = 0usize;
    let fetch_fut = async {
        loop {
            let mut client_builder = reqwest::Client::builder()
                .timeout(Duration::from_secs(WEB_FETCH_TIMEOUT_SECS))
                .user_agent("Mivlet/0.1 (web-fetch)")
                .redirect(reqwest::redirect::Policy::none())
                .default_headers(default_headers.clone());
            if let Some(host) = current.host() {
                match host {
                    url::Host::Domain(domain) => {
                        let port = current.port().unwrap_or_else(|| {
                            if current.scheme() == "https" {
                                443
                            } else {
                                80
                            }
                        });
                        let addrs = resolve_and_check_host(domain, port).await?;
                        client_builder = client_builder.resolve_to_addrs(domain, &addrs);
                    }
                    url::Host::Ipv4(ip) => {
                        if is_forbidden_ip(IpAddr::V4(ip)) {
                            return Err("web-fetch blocked: target is a loopback, private, reserved, link-local, multicast, unspecified, or cloud-metadata address.".to_string());
                        }
                    }
                    url::Host::Ipv6(ip) => {
                        if is_forbidden_ip(IpAddr::V6(ip)) {
                            return Err("web-fetch blocked: target is a loopback, private, reserved, link-local, multicast, unspecified, or cloud-metadata address.".to_string());
                        }
                    }
                }
            }
            if let Some(port) = current.port() {
                if is_unsafe_port(port) {
                    return Err("web-fetch blocked: unsafe port".to_string());
                }
            }
            let client = client_builder
                .build()
                .map_err(|_| "web-fetch client initialization failed".to_string())?;
            let resp = match client.get(current.clone()).send().await {
                Ok(response) => response,
                Err(error) => {
                    return Err(format!(
                        "web-fetch transport error: {}",
                        redact_for_error(&error.to_string())
                    ));
                }
            };
            let status = resp.status().as_u16();
            if resp.status().is_redirection() {
                redirects += 1;
                if redirects > WEB_FETCH_MAX_REDIRECTS {
                    return Err("web-fetch blocked: excessive redirects".to_string());
                }
                let location = match resp.headers().get(reqwest::header::LOCATION) {
                    Some(value) => match value.to_str() {
                        Ok(value) => value.to_string(),
                        Err(_) => return Err("web-fetch blocked: invalid redirect".to_string()),
                    },
                    None => return Ok(WebFetchOutcome::status(status).into_tool_result()),
                };
                let next = current
                    .join(&location)
                    .map_err(|_| "web-fetch blocked: unresolvable redirect target".to_string())?;
                let _ = parse_and_validate_fetch_url(next.as_str())
                    .map_err(|e| format!("web-fetch blocked by redirect: {}", e))?;
                if !next.username().is_empty() || next.password().is_some() {
                    return Err(
                        "web-fetch blocked: redirect target contains credentials".to_string()
                    );
                }
                current = next;
                continue;
            }
            if !resp.status().is_success() {
                return Ok(WebFetchOutcome::status(status).into_tool_result());
            }
            let content_type = resp
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .unwrap_or("")
                .to_string();
            if !is_supported_response_type(&content_type) {
                return Err("web-fetch blocked: unsupported response type".to_string());
            }
            let body = read_bounded_text(resp, WEB_FETCH_MAX_BODY_BYTES).await?;
            let fetched_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
            let source = format_web_page_source(&body, &current, &content_type, &fetched_at);
            return Ok(WebFetchOutcome::success(status, source).into_tool_result());
        }
    };
    match tokio::time::timeout(Duration::from_secs(WEB_FETCH_TIMEOUT_SECS), fetch_fut).await {
        Ok(Ok(result)) => Ok(result),
        Ok(Err(message)) => {
            Ok(WebFetchOutcome::transport_error(&redact_for_error(&message)).into_tool_result())
        }
        Err(_) => Ok(WebFetchOutcome::transport_error("web-fetch timed out").into_tool_result()),
    }
}
