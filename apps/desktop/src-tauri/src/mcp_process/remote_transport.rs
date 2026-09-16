struct RemotePostResponse {
    frames: Vec<String>,
    server_session_id: Option<String>,
    initialized: bool,
    authorization_challenge: Option<RemoteAuthorizationChallenge>,
    error: Option<String>,
    last_event_id: Option<String>,
    retry_after_ms: u64,
}

fn validate_remote_endpoint(raw: &str) -> Result<Url, String> {
    let mut endpoint =
        Url::parse(raw).map_err(|_| "Remote MCP requires a valid HTTPS endpoint.".to_string())?;
    if endpoint.scheme() != "https"
        || endpoint.host().is_none()
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.fragment().is_some()
    {
        return Err(
            "Remote MCP endpoints must use HTTPS without credentials or a fragment.".into(),
        );
    }
    if endpoint.host_str().is_some_and(|host| {
        let host = host.to_ascii_lowercase();
        host == "localhost"
            || host == "local"
            || host.ends_with(".localhost")
            || host.ends_with(".local")
    }) {
        return Err("Remote MCP endpoints cannot target local network names.".into());
    }
    if endpoint.port().is_some_and(crate::tools::is_unsafe_port) {
        return Err("Remote MCP endpoints cannot use an unsafe port.".into());
    }
    const CREDENTIAL_QUERY_MARKERS: &[&str] = &[
        "api_key",
        "api-key",
        "apikey",
        "authorization",
        "password",
        "secret",
        "token",
    ];
    if endpoint.query_pairs().any(|(key, _)| {
        let key = key.to_ascii_lowercase();
        CREDENTIAL_QUERY_MARKERS
            .iter()
            .any(|marker| key.contains(marker))
    }) {
        return Err("Remote MCP endpoint queries cannot contain credentials.".into());
    }
    match endpoint.host() {
        Some(url::Host::Ipv4(ip)) if crate::tools::is_forbidden_ip(IpAddr::V4(ip)) => {
            return Err("Remote MCP endpoints cannot target private or reserved networks.".into())
        }
        Some(url::Host::Ipv6(ip)) if crate::tools::is_forbidden_ip(IpAddr::V6(ip)) => {
            return Err("Remote MCP endpoints cannot target private or reserved networks.".into())
        }
        _ => {}
    }
    if endpoint.port() == Some(443) {
        let _ = endpoint.set_port(None);
    }
    Ok(endpoint)
}

async fn remote_http_client(endpoint: &Url) -> Result<reqwest::Client, String> {
    crate::ensure_rustls_provider();
    let mut builder = reqwest::Client::builder()
        .timeout(MCP_HTTP_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("Mivlet/0.1 (MCP)");
    match endpoint.host() {
        Some(url::Host::Domain(host)) => {
            let port = endpoint.port_or_known_default().unwrap_or(443);
            let addrs = tokio::net::lookup_host((host, port))
                .await
                .map_err(|_| "Remote MCP endpoint DNS lookup failed.".to_string())?
                .collect::<Vec<_>>();
            if addrs.is_empty()
                || addrs
                    .iter()
                    .any(|address| crate::tools::is_forbidden_ip(address.ip()))
            {
                return Err(
                    "Remote MCP endpoint resolved to a private or reserved network.".into(),
                );
            }
            builder = builder.resolve_to_addrs(host, &addrs);
        }
        Some(url::Host::Ipv4(ip)) if crate::tools::is_forbidden_ip(IpAddr::V4(ip)) => {
            return Err("Remote MCP endpoint targets a private or reserved network.".into())
        }
        Some(url::Host::Ipv6(ip)) if crate::tools::is_forbidden_ip(IpAddr::V6(ip)) => {
            return Err("Remote MCP endpoint targets a private or reserved network.".into())
        }
        Some(_) => {}
        None => return Err("Remote MCP endpoint has no host.".into()),
    }
    builder
        .build()
        .map_err(|_| "Mivlet could not initialize the remote MCP transport.".into())
}

fn valid_server_session_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 1_024
        && value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
}

fn split_auth_parameters(value: &str) -> Result<Vec<&str>, String> {
    let mut parts = Vec::new();
    let mut start = 0;
    let mut quoted = false;
    let mut escaped = false;
    for (index, character) in value.char_indices() {
        if escaped {
            escaped = false;
        } else if character == '\\' && quoted {
            escaped = true;
        } else if character == '"' {
            quoted = !quoted;
        } else if character == ',' && !quoted {
            parts.push(value[start..index].trim());
            start = index + 1;
        }
    }
    if quoted || escaped {
        return Err("Remote MCP returned a malformed authorization challenge.".into());
    }
    parts.push(value[start..].trim());
    Ok(parts)
}

fn decode_auth_parameter(value: &str) -> Result<String, String> {
    let quoted = value
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .ok_or_else(|| {
            "Remote MCP authorization challenge parameters must be quoted.".to_string()
        })?;
    let mut decoded = String::new();
    let mut escaped = false;
    for character in quoted.chars() {
        if escaped {
            if character != '"' && character != '\\' {
                return Err("Remote MCP returned a malformed authorization challenge.".into());
            }
            decoded.push(character);
            escaped = false;
        } else if character == '\\' {
            escaped = true;
        } else if character.is_control() {
            return Err("Remote MCP returned a malformed authorization challenge.".into());
        } else {
            decoded.push(character);
        }
    }
    if escaped {
        return Err("Remote MCP returned a malformed authorization challenge.".into());
    }
    Ok(decoded)
}

fn parse_bearer_challenge(value: &str) -> Result<Option<RemoteAuthorizationChallenge>, String> {
    if value.len() > 8 * 1024 || value.chars().any(char::is_control) {
        return Err("Remote MCP returned an invalid authorization challenge.".into());
    }
    let trimmed = value.trim();
    let Some(separator) = trimmed.find(char::is_whitespace) else {
        return Ok(None);
    };
    if !trimmed[..separator].eq_ignore_ascii_case("bearer") {
        return Ok(None);
    }
    let mut resource_metadata = None;
    let mut scopes = Vec::new();
    for part in split_auth_parameters(trimmed[separator..].trim())? {
        let Some((key, raw)) = part.split_once('=') else {
            continue;
        };
        let key = key.trim().to_ascii_lowercase();
        if key.chars().any(char::is_whitespace) {
            break;
        }
        match key.as_str() {
            "resource_metadata" => {
                if resource_metadata.is_some() {
                    return Err("Remote MCP repeated authorization metadata.".into());
                }
                resource_metadata = Some(validate_remote_endpoint(&decode_auth_parameter(
                    raw.trim(),
                )?)?);
            }
            "scope" => {
                if !scopes.is_empty() {
                    return Err("Remote MCP repeated authorization scopes.".into());
                }
                let decoded = decode_auth_parameter(raw.trim())?;
                if decoded.len() > 4_096 {
                    return Err(
                        "Remote MCP authorization scopes exceeded the supported limit.".into(),
                    );
                }
                scopes = decoded
                    .split_ascii_whitespace()
                    .map(|scope| {
                        if scope.is_empty() || scope.chars().count() > 200 {
                            Err("Remote MCP authorization scopes were malformed.".to_string())
                        } else {
                            Ok(scope.to_string())
                        }
                    })
                    .collect::<Result<Vec<_>, String>>()?;
                if scopes.len() > 64 {
                    return Err(
                        "Remote MCP authorization scopes exceeded the supported limit.".into(),
                    );
                }
                scopes.sort();
                scopes.dedup();
            }
            _ => {}
        }
    }
    Ok(
        resource_metadata.map(|resource_metadata| RemoteAuthorizationChallenge {
            resource_metadata,
            scopes,
            observed_endpoint: None,
            connection_revision: None,
        }),
    )
}

fn authorization_challenge_from_headers(
    headers: &reqwest::header::HeaderMap,
    session: &McpRemoteSession,
) -> Result<Option<RemoteAuthorizationChallenge>, String> {
    for value in headers.get_all(reqwest::header::WWW_AUTHENTICATE) {
        let value = value
            .to_str()
            .map_err(|_| "Remote MCP returned an invalid authorization challenge.".to_string())?;
        if let Some(mut challenge) = parse_bearer_challenge(value)? {
            challenge.observed_endpoint = Some(session.endpoint.clone());
            challenge.connection_revision = Some(session.connection_revision);
            return Ok(Some(challenge));
        }
    }
    Ok(None)
}

fn canonical_remote_frame(payload: &str) -> Result<String, String> {
    let value: Value = serde_json::from_str(payload)
        .map_err(|_| "Remote MCP returned malformed JSON-RPC.".to_string())?;
    let encoded = serde_json::to_string(&value)
        .map_err(|_| "Remote MCP returned malformed JSON-RPC.".to_string())?;
    if !valid_mcp_frame(&encoded) {
        return Err("Remote MCP returned an invalid JSON-RPC message.".into());
    }
    Ok(encoded)
}

struct ParsedRemoteSse {
    frames: Vec<String>,
    last_event_id: Option<String>,
    retry_after_ms: u64,
}

fn valid_event_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 1_024
        && value.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
}

fn parse_remote_sse(body: &[u8], require_frame: bool) -> Result<ParsedRemoteSse, String> {
    let text = std::str::from_utf8(body)
        .map_err(|_| "Remote MCP returned non-UTF-8 event data.".to_string())?;
    let mut frames = Vec::new();
    let mut data = Vec::new();
    let mut event_id = None;
    let mut last_event_id = None;
    let mut retry_after_ms = 1_000;
    let dispatch = |data: &mut Vec<String>,
                    event_id: &mut Option<String>,
                    frames: &mut Vec<String>,
                    last_event_id: &mut Option<String>|
     -> Result<(), String> {
        if !data.is_empty() {
            let payload = data.join("\n");
            if !payload.is_empty() {
                frames.push(canonical_remote_frame(&payload)?);
            }
        }
        if let Some(id) = event_id.take() {
            *last_event_id = Some(id);
        }
        data.clear();
        Ok(())
    };
    for line in text.replace("\r\n", "\n").replace('\r', "\n").lines() {
        if line.is_empty() {
            dispatch(&mut data, &mut event_id, &mut frames, &mut last_event_id)?;
        } else if let Some(value) = line.strip_prefix("data:") {
            data.push(value.strip_prefix(' ').unwrap_or(value).to_string());
        } else if let Some(value) = line.strip_prefix("id:") {
            let value = value.strip_prefix(' ').unwrap_or(value);
            if !valid_event_id(value) {
                return Err("Remote MCP returned an invalid event id.".into());
            }
            event_id = Some(value.to_string());
        } else if let Some(value) = line.strip_prefix("retry:") {
            retry_after_ms = value
                .trim()
                .parse::<u64>()
                .ok()
                .filter(|value| (250..=30_000).contains(value))
                .ok_or_else(|| "Remote MCP returned an invalid retry interval.".to_string())?;
        }
    }
    dispatch(&mut data, &mut event_id, &mut frames, &mut last_event_id)?;
    if require_frame && frames.is_empty() {
        return Err("Remote MCP event stream returned no JSON-RPC messages.".into());
    }
    Ok(ParsedRemoteSse {
        frames,
        last_event_id,
        retry_after_ms,
    })
}

async fn read_remote_body(
    response: reqwest::Response,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err("Remote MCP response exceeded the supported limit.".into());
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "Remote MCP response could not be read.".to_string())?;
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Err("Remote MCP response exceeded the supported limit.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn usable_mcp_access_token(session: &McpRemoteSession) -> Result<Option<String>, String> {
    let Some(credential_key) = session.oauth_credential_key.as_deref() else {
        return Ok(None);
    };
    let Some(tokens) = load_mcp_oauth_tokens(credential_key)? else {
        return Err("MCP Connection credentials are unavailable; reconnect this server.".into());
    };
    validate_mcp_token_binding(&tokens, &session.endpoint)?;
    if tokens.expires_at > chrono::Utc::now().timestamp() + 30 {
        return Ok(Some(tokens.access_token));
    }
    let _refresh_guard = oauth_refresh_lock().lock().await;
    let Some(mut tokens) = load_mcp_oauth_tokens(credential_key)? else {
        return Err("MCP Connection credentials are unavailable; reconnect this server.".into());
    };
    let resource = validate_mcp_token_binding(&tokens, &session.endpoint)?;
    if tokens.expires_at > chrono::Utc::now().timestamp() + 30 {
        return Ok(Some(tokens.access_token));
    }
    let refresh_token = tokens
        .refresh_token
        .clone()
        .ok_or_else(|| "MCP account authorization expired; reconnect this server.".to_string())?;
    let token_endpoint = validate_remote_endpoint(&tokens.token_endpoint)?;
    let client = remote_http_client(&token_endpoint).await?;
    let response = client
        .post(token_endpoint.clone())
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token.as_str()),
            ("client_id", tokens.client_id.as_str()),
            ("resource", tokens.resource.as_str()),
        ])
        .send()
        .await
        .map_err(|_| "MCP OAuth token refresh failed.".to_string())?;
    if response.status().is_redirection() || !response.status().is_success() {
        return Err(
            "MCP account authorization could not be renewed; reconnect this server.".into(),
        );
    }
    let bytes = read_remote_body(response, MCP_AUTH_METADATA_MAX_BYTES).await?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "MCP OAuth refresh response was malformed.".to_string())?;
    let mut refreshed = parse_mcp_token_response(
        &value,
        &tokens.scopes,
        &token_endpoint,
        &tokens.client_id,
        &resource,
    )?;
    if refreshed.refresh_token.is_none() {
        refreshed.refresh_token = tokens.refresh_token.take();
    }
    refreshed.revocation_endpoint = tokens.revocation_endpoint.take();
    refreshed.resource = tokens.resource;
    refreshed.transport_endpoint = tokens.transport_endpoint;
    let access_token = refreshed.access_token.clone();
    store_mcp_oauth_tokens(credential_key, &refreshed)?;
    Ok(Some(access_token))
}

async fn authorize_remote_request(
    request: reqwest::RequestBuilder,
    session: &McpRemoteSession,
) -> Result<reqwest::RequestBuilder, String> {
    let Some(access_token) = usable_mcp_access_token(session).await? else {
        return Ok(request);
    };
    Ok(request.bearer_auth(access_token))
}

async fn post_remote_mcp_frame(
    session: &McpRemoteSession,
    frame: &str,
) -> Result<RemotePostResponse, String> {
    let parsed: Value =
        serde_json::from_str(frame).map_err(|_| "The remote MCP frame is invalid.".to_string())?;
    let is_initialize = parsed.get("method").and_then(Value::as_str) == Some("initialize");
    let is_request = parsed.get("id").is_some();
    let client = remote_http_client(&session.endpoint).await?;
    let mut request = client
        .post(session.endpoint.clone())
        .header(
            reqwest::header::ACCEPT,
            "application/json, text/event-stream",
        )
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .body(frame.to_string());
    if session.initialized {
        request = request.header("MCP-Protocol-Version", MCP_PROTOCOL_VERSION);
    }
    if let Some(server_session_id) = &session.server_session_id {
        request = request.header("MCP-Session-Id", server_session_id);
    }
    let response = authorize_remote_request(request, session)
        .await?
        .send()
        .await
        .map_err(|_| "Remote MCP request failed.".to_string())?;
    if response.status().is_redirection() {
        return Err("Remote MCP redirects are not followed.".into());
    }
    if response.status() == reqwest::StatusCode::NOT_FOUND && session.server_session_id.is_some() {
        return Err("The remote MCP session expired; reconnect the server.".into());
    }
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Ok(RemotePostResponse {
            frames: Vec::new(),
            server_session_id: None,
            initialized: false,
            authorization_challenge: authorization_challenge_from_headers(
                response.headers(),
                session,
            )?,
            error: Some("Remote MCP rejected the request with HTTP 401.".into()),
            last_event_id: None,
            retry_after_ms: 1_000,
        });
    }
    if response.status() == reqwest::StatusCode::ACCEPTED {
        if is_request {
            return Err("Remote MCP accepted a request without returning a response.".into());
        }
        return Ok(RemotePostResponse {
            frames: Vec::new(),
            server_session_id: None,
            initialized: false,
            authorization_challenge: None,
            error: None,
            last_event_id: None,
            retry_after_ms: 1_000,
        });
    }
    if !response.status().is_success() {
        return Err(format!(
            "Remote MCP rejected the request with HTTP {}.",
            response.status().as_u16()
        ));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let offered_server_session_id = if is_initialize {
        response
            .headers()
            .get("MCP-Session-Id")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string)
            .map(|value| {
                if valid_server_session_id(&value) {
                    Ok(value)
                } else {
                    Err("Remote MCP returned an invalid session id.".to_string())
                }
            })
            .transpose()?
    } else {
        None
    };
    let body = read_remote_body(response, MAX_MCP_FRAME_BYTES).await?;
    let (frames, last_event_id, retry_after_ms) = match content_type.as_str() {
        "application/json" => (
            vec![canonical_remote_frame(
                std::str::from_utf8(&body)
                    .map_err(|_| "Remote MCP returned non-UTF-8 JSON.".to_string())?,
            )?],
            None,
            1_000,
        ),
        "text/event-stream" => {
            let parsed = parse_remote_sse(&body, true)?;
            (parsed.frames, parsed.last_event_id, parsed.retry_after_ms)
        }
        _ => return Err("Remote MCP returned an unsupported content type.".into()),
    };
    let initialize_request_id = parsed.get("id").and_then(discovery_request_id);
    let initialized = is_initialize
        && initialize_request_id.as_deref().is_some_and(|id| {
            frames.iter().any(|frame| {
                serde_json::from_str::<Value>(frame)
                    .ok()
                    .and_then(|value| value.as_object().cloned())
                    .is_some_and(|object| successful_initialize_response(&object, id))
            })
        });
    Ok(RemotePostResponse {
        frames,
        server_session_id: initialized.then_some(offered_server_session_id).flatten(),
        initialized,
        authorization_challenge: None,
        error: None,
        last_event_id,
        retry_after_ms,
    })
}

async fn delete_remote_mcp_session(session: &McpRemoteSession) -> Result<(), String> {
    let client = remote_http_client(&session.endpoint).await?;
    let request = client
        .delete(session.endpoint.clone())
        .header("MCP-Protocol-Version", MCP_PROTOCOL_VERSION)
        .header(
            "MCP-Session-Id",
            session.server_session_id.as_deref().unwrap_or_default(),
        );
    let response = authorize_remote_request(request, session)
        .await?
        .send()
        .await
        .map_err(|_| "Remote MCP session could not be closed.".to_string())?;
    if response.status().is_success()
        || response.status() == reqwest::StatusCode::METHOD_NOT_ALLOWED
        || response.status() == reqwest::StatusCode::NOT_FOUND
    {
        Ok(())
    } else {
        Err("Remote MCP session could not be closed.".into())
    }
}

struct RemotePollResponse {
    supported: bool,
    frames: Vec<String>,
    last_event_id: Option<String>,
    retry_after_ms: u64,
}

async fn get_remote_mcp_messages(session: &McpRemoteSession) -> Result<RemotePollResponse, String> {
    let client = remote_http_client(&session.endpoint).await?;
    let mut request = client
        .get(session.endpoint.clone())
        .header(reqwest::header::ACCEPT, "text/event-stream")
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .header("MCP-Protocol-Version", MCP_PROTOCOL_VERSION);
    if let Some(server_session_id) = &session.server_session_id {
        request = request.header("MCP-Session-Id", server_session_id);
    }
    if let Some(last_event_id) = &session.last_event_id {
        request = request.header("Last-Event-ID", last_event_id);
    }
    let response = authorize_remote_request(request, session)
        .await?
        .send()
        .await
        .map_err(|_| "Remote MCP listening request failed.".to_string())?;
    if response.status() == reqwest::StatusCode::METHOD_NOT_ALLOWED {
        return Ok(RemotePollResponse {
            supported: false,
            frames: Vec::new(),
            last_event_id: None,
            retry_after_ms: 1_000,
        });
    }
    if response.status() == reqwest::StatusCode::NOT_FOUND && session.server_session_id.is_some() {
        return Err("The remote MCP session expired; reconnect the server.".into());
    }
    if response.status().is_redirection() || !response.status().is_success() {
        return Err("Remote MCP listening was rejected.".into());
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim();
    if content_type != "text/event-stream" {
        return Err("Remote MCP listening returned an unsupported content type.".into());
    }
    let body = read_remote_body(response, MAX_MCP_FRAME_BYTES).await?;
    let parsed = parse_remote_sse(&body, false)?;
    Ok(RemotePollResponse {
        supported: true,
        frames: parsed.frames,
        last_event_id: parsed.last_event_id,
        retry_after_ms: parsed.retry_after_ms,
    })
}

const MCP_AUTH_METADATA_MAX_BYTES: usize = 256 * 1024;

fn protected_resource_metadata_candidates(endpoint: &Url) -> Vec<Url> {
    let mut path_specific = endpoint.clone();
    let endpoint_path = endpoint.path().trim_start_matches('/');
    path_specific.set_path(&format!(
        "/.well-known/oauth-protected-resource{}{}",
        if endpoint_path.is_empty() { "" } else { "/" },
        endpoint_path
    ));
    path_specific.set_query(None);
    let mut root = endpoint.clone();
    root.set_path("/.well-known/oauth-protected-resource");
    root.set_query(None);
    if path_specific == root {
        vec![root]
    } else {
        vec![path_specific, root]
    }
}

fn authorization_metadata_candidates(issuer: &Url) -> Vec<Url> {
    let issuer_path = issuer.path().trim_matches('/');
    let mut oauth = issuer.clone();
    oauth.set_path(&format!(
        "/.well-known/oauth-authorization-server{}{}",
        if issuer_path.is_empty() { "" } else { "/" },
        issuer_path
    ));
    oauth.set_query(None);
    let mut oidc_inserted = issuer.clone();
    oidc_inserted.set_path(&format!(
        "/.well-known/openid-configuration{}{}",
        if issuer_path.is_empty() { "" } else { "/" },
        issuer_path
    ));
    oidc_inserted.set_query(None);
    if issuer_path.is_empty() {
        vec![oauth, oidc_inserted]
    } else {
        let mut oidc_appended = issuer.clone();
        oidc_appended.set_path(&format!(
            "{}/.well-known/openid-configuration",
            issuer.path().trim_end_matches('/')
        ));
        oidc_appended.set_query(None);
        vec![oauth, oidc_inserted, oidc_appended]
    }
}

async fn fetch_remote_metadata(url: &Url) -> Result<Option<Value>, String> {
    let url = validate_remote_endpoint(url.as_str())?;
    let client = remote_http_client(&url).await?;
    let response = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .send()
        .await
        .map_err(|_| "Remote MCP authorization metadata request failed.".to_string())?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if response.status().is_redirection() || !response.status().is_success() {
        return Err("Remote MCP authorization metadata was unavailable.".into());
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim();
    if content_type != "application/json" {
        return Err("Remote MCP authorization metadata was not JSON.".into());
    }
    let bytes = read_remote_body(response, MCP_AUTH_METADATA_MAX_BYTES).await?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| "Remote MCP authorization metadata was malformed.".into())
}

// Some servers publish their origin as the canonical OAuth audience for /mcp.
// Accept only that root alias or the exact endpoint, never another origin/path.
fn validate_mcp_oauth_resource(endpoint: &Url, raw: &str) -> Result<Url, String> {
    let resource = validate_remote_endpoint(raw)?;
    if resource != *endpoint
        && !(resource.origin() == endpoint.origin()
            && resource.path() == "/"
            && resource.query().is_none()
            && endpoint.query().is_none())
    {
        return Err("Remote MCP protected-resource metadata named a different resource.".into());
    }
    Ok(resource)
}

fn validate_mcp_token_binding(
    tokens: &RemoteMcpOAuthTokens,
    endpoint: &Url,
) -> Result<Url, String> {
    // Legacy credentials used the resource as the exact transport binding.
    let binding = tokens.transport_endpoint.as_deref().unwrap_or(&tokens.resource);
    if validate_remote_endpoint(binding)? != *endpoint {
        return Err("Stored MCP OAuth credentials target a different server.".into());
    }
    validate_mcp_oauth_resource(endpoint, &tokens.resource)
}

fn parse_protected_resource_metadata(
    endpoint: &Url,
    value: &Value,
) -> Result<(Vec<Url>, Vec<String>), String> {
    let object = value
        .as_object()
        .ok_or_else(|| "Remote MCP protected-resource metadata was malformed.".to_string())?;
    let resource = object
        .get("resource")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            "Remote MCP protected-resource metadata omitted its resource.".to_string()
        })?;
    validate_mcp_oauth_resource(endpoint, resource)?;
    let servers = object
        .get("authorization_servers")
        .and_then(Value::as_array)
        .filter(|servers| !servers.is_empty() && servers.len() <= 4)
        .ok_or_else(|| {
            "Remote MCP protected-resource metadata omitted its authorization server.".to_string()
        })?
        .iter()
        .map(|value| {
            let raw = value.as_str().ok_or_else(|| {
                "Remote MCP authorization server metadata was malformed.".to_string()
            })?;
            let issuer = validate_remote_endpoint(raw)?;
            if issuer.query().is_some() {
                return Err(
                    "Remote MCP authorization server issuer cannot contain a query.".into(),
                );
            }
            Ok(issuer)
        })
        .collect::<Result<Vec<_>, String>>()?;
    let scopes = object
        .get("scopes_supported")
        .map(|value| {
            let values = value
                .as_array()
                .filter(|values| values.len() <= 64)
                .ok_or_else(|| "Remote MCP authorization scopes were malformed.".to_string())?;
            let mut scopes = values
                .iter()
                .map(|value| {
                    let scope = value.as_str().unwrap_or_default().trim();
                    if scope.is_empty()
                        || scope.chars().count() > 200
                        || scope.chars().any(char::is_whitespace)
                        || scope.chars().any(char::is_control)
                    {
                        return Err("Remote MCP authorization scopes were malformed.".to_string());
                    }
                    Ok(scope.to_string())
                })
                .collect::<Result<Vec<_>, String>>()?;
            scopes.sort();
            scopes.dedup();
            Ok::<Vec<String>, String>(scopes)
        })
        .transpose()?
        .unwrap_or_default();
    Ok((servers, scopes))
}

fn parse_authorization_server_metadata(
    issuer: &Url,
    scopes: Vec<String>,
    value: &Value,
) -> Result<RemoteMcpAuthorizationDiscovery, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "Remote MCP authorization-server metadata was malformed.".to_string())?;
    let metadata_issuer = object
        .get("issuer")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            "Remote MCP authorization-server metadata omitted its issuer.".to_string()
        })?;
    if validate_remote_endpoint(metadata_issuer)? != *issuer {
        return Err("Remote MCP authorization-server metadata changed issuer.".into());
    }
    let required_endpoint = |field: &str| {
        let endpoint = object.get(field).and_then(Value::as_str).ok_or_else(|| {
            "Remote MCP authorization-server metadata omitted a required endpoint.".to_string()
        })?;
        validate_remote_endpoint(endpoint)
    };
    let authorization_endpoint = required_endpoint("authorization_endpoint")?;
    let token_endpoint = required_endpoint("token_endpoint")?;
    let supports_s256 = object
        .get("code_challenge_methods_supported")
        .and_then(Value::as_array)
        .is_some_and(|methods| methods.iter().any(|value| value.as_str() == Some("S256")));
    if !supports_s256 {
        return Err("Remote MCP authorization server does not advertise S256 PKCE.".into());
    }
    let supports_code = object
        .get("response_types_supported")
        .and_then(Value::as_array)
        .is_some_and(|types| types.iter().any(|value| value.as_str() == Some("code")));
    let supports_authorization_code = object
        .get("grant_types_supported")
        .map(|value| {
            value.as_array().is_some_and(|types| {
                types
                    .iter()
                    .any(|value| value.as_str() == Some("authorization_code"))
            })
        })
        .unwrap_or(true);
    if !supports_code || !supports_authorization_code {
        return Err(
            "Remote MCP authorization server does not support authorization code flow.".into(),
        );
    }
    let registration_endpoint = object
        .get("registration_endpoint")
        .and_then(Value::as_str)
        .map(validate_remote_endpoint)
        .transpose()?;
    let dynamic_registration_supported = registration_endpoint.is_some();
    let revocation_endpoint = object
        .get("revocation_endpoint")
        .and_then(Value::as_str)
        .map(validate_remote_endpoint)
        .transpose()?;
    let client_id_metadata_document_supported = object
        .get("client_id_metadata_document_supported")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let registration = select_client_registration(
        issuer,
        client_id_metadata_document_supported,
        dynamic_registration_supported,
    )?;
    Ok(RemoteMcpAuthorizationDiscovery {
        resource: None,
        summary: RemoteMcpAuthorizationSummary {
            issuer: issuer.to_string(),
            scopes,
            pkce_method: "S256".into(),
            client_id_metadata_document_supported,
            dynamic_registration_supported,
            client_registration_strategy: registration.strategy.into(),
            client_registration_status: registration.status.into(),
            client_registration_reason: registration.reason.into(),
        },
        authorization_endpoint,
        token_endpoint,
        registration_endpoint,
        revocation_endpoint,
    })
}

struct ClientRegistrationDecision {
    strategy: &'static str,
    status: &'static str,
    reason: &'static str,
}

fn select_client_registration_from_availability(
    pre_registered: bool,
    client_metadata_document: bool,
    dynamic_registration: bool,
) -> ClientRegistrationDecision {
    if pre_registered {
        ClientRegistrationDecision {
            strategy: "pre-registered",
            status: "selected",
            reason: "Use the issuer-specific client registration already configured for Mivlet.",
        }
    } else if client_metadata_document {
        ClientRegistrationDecision {
            strategy: "client-id-metadata-document",
            status: "selected",
            reason: "Use Mivlet's configured public HTTPS Client ID Metadata Document.",
        }
    } else if dynamic_registration {
        ClientRegistrationDecision {
            strategy: "dynamic-client-registration",
            status: "selected",
            reason:
                "Register Mivlet's public PKCE client dynamically with this authorization server.",
        }
    } else {
        ClientRegistrationDecision {
            strategy: "manual-client-information",
            status: "configuration-required",
            reason: "This server requires explicit client information before Mivlet can connect an account.",
        }
    }
}

fn configured_preregistered_client_id(issuer: &Url) -> Result<Option<String>, String> {
    let Some(raw) = crate::env_compat::var_os_named("MIVLET_MCP_OAUTH_PREREGISTERED_CLIENTS") else {
        return Ok(None);
    };
    let raw = raw
        .into_string()
        .map_err(|_| "MCP OAuth pre-registration configuration is invalid.".to_string())?;
    if raw.len() > 64 * 1024 {
        return Err("MCP OAuth pre-registration configuration is too large.".into());
    }
    let registrations: serde_json::Map<String, Value> = serde_json::from_str(&raw)
        .map_err(|_| "MCP OAuth pre-registration configuration is invalid.".to_string())?;
    let Some(client_id) = registrations.get(issuer.as_str()) else {
        return Ok(None);
    };
    let client_id = client_id
        .as_str()
        .filter(|value| {
            !value.trim().is_empty() && value.len() <= 2_048 && !value.chars().any(char::is_control)
        })
        .ok_or_else(|| "MCP OAuth pre-registered client information is invalid.".to_string())?;
    Ok(Some(client_id.to_string()))
}

fn configured_client_metadata_document_url() -> Result<Option<Url>, String> {
    let Some(raw) = crate::env_compat::var_os_named("MIVLET_MCP_OAUTH_CLIENT_METADATA_DOCUMENT_URL") else {
        return Ok(None);
    };
    let raw = raw
        .into_string()
        .map_err(|_| "MCP OAuth client metadata configuration is invalid.".to_string())?;
    let url = validate_remote_endpoint(raw.trim())?;
    if url.query().is_some() || url.fragment().is_some() || url.path().trim_matches('/').is_empty()
    {
        return Err(
            "MCP OAuth Client ID Metadata Document URL requires a path and cannot contain a query or fragment.".into(),
        );
    }
    Ok(Some(url))
}

fn select_client_registration(
    issuer: &Url,
    client_metadata_document_supported: bool,
    dynamic_registration_supported: bool,
) -> Result<ClientRegistrationDecision, String> {
    let pre_registered = configured_preregistered_client_id(issuer)?.is_some();
    let metadata_document =
        client_metadata_document_supported && configured_client_metadata_document_url()?.is_some();
    Ok(select_client_registration_from_availability(
        pre_registered,
        metadata_document,
        dynamic_registration_supported,
    ))
}

fn validate_dynamic_client_response(value: &Value, redirect_uri: &str) -> Result<String, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "MCP OAuth client registration response was malformed.".to_string())?;
    if object.contains_key("client_secret") || object.contains_key("client_secret_expires_at") {
        return Err("MCP OAuth refused a confidential dynamic client registration.".into());
    }
    if object
        .get("token_endpoint_auth_method")
        .and_then(Value::as_str)
        != Some("none")
    {
        return Err(
            "MCP OAuth dynamic registration did not preserve public-client authentication.".into(),
        );
    }
    let includes = |field: &str, expected: &str| {
        object
            .get(field)
            .and_then(Value::as_array)
            .is_some_and(|values| values.iter().any(|value| value.as_str() == Some(expected)))
    };
    if !includes("redirect_uris", redirect_uri)
        || !includes("grant_types", "authorization_code")
        || !includes("response_types", "code")
    {
        return Err(
            "MCP OAuth dynamic registration changed the requested public-client contract.".into(),
        );
    }
    let client_id = object
        .get("client_id")
        .and_then(Value::as_str)
        .filter(|value| {
            !value.trim().is_empty() && value.len() <= 2_048 && !value.chars().any(char::is_control)
        })
        .ok_or_else(|| "MCP OAuth dynamic registration omitted a valid client id.".to_string())?;
    Ok(client_id.to_string())
}

async fn register_dynamic_public_client(
    registration_endpoint: &Url,
    redirect_uri: &str,
) -> Result<String, String> {
    let client = remote_http_client(registration_endpoint).await?;
    let response = client
        .post(registration_endpoint.clone())
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .json(&serde_json::json!({
            "client_name": "Mivlet Desktop",
            "application_type": "native",
            "redirect_uris": [redirect_uri],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none"
        }))
        .send()
        .await
        .map_err(|_| "MCP OAuth dynamic client registration failed.".to_string())?;
    if response.status().is_redirection() || response.status() != reqwest::StatusCode::CREATED {
        return Err("MCP OAuth dynamic client registration was rejected.".into());
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim();
    if content_type != "application/json" {
        return Err("MCP OAuth client registration response was not JSON.".into());
    }
    let bytes = read_remote_body(response, MCP_AUTH_METADATA_MAX_BYTES).await?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "MCP OAuth client registration response was malformed.".to_string())?;
    validate_dynamic_client_response(&value, redirect_uri)
}

fn validate_client_metadata_document(
    value: &Value,
    document_url: &Url,
    redirect_uri: &str,
) -> Result<(), String> {
    let object = value
        .as_object()
        .ok_or_else(|| "MCP OAuth Client ID Metadata Document was malformed.".to_string())?;
    if object.get("client_id").and_then(Value::as_str) != Some(document_url.as_str())
        || object
            .get("token_endpoint_auth_method")
            .and_then(Value::as_str)
            != Some("none")
    {
        return Err(
            "MCP OAuth Client ID Metadata Document did not declare the exact public client.".into(),
        );
    }
    let includes = |field: &str, expected: &str| {
        object
            .get(field)
            .and_then(Value::as_array)
            .is_some_and(|values| values.iter().any(|value| value.as_str() == Some(expected)))
    };
    if !includes("grant_types", "authorization_code") || !includes("response_types", "code") {
        return Err(
            "MCP OAuth Client ID Metadata Document does not support authorization code flow."
                .into(),
        );
    }
    let requested = Url::parse(redirect_uri)
        .map_err(|_| "MCP OAuth loopback redirect was invalid.".to_string())?;
    let redirect_allowed = object
        .get("redirect_uris")
        .and_then(Value::as_array)
        .is_some_and(|values| {
            values.iter().filter_map(Value::as_str).any(|value| {
                Url::parse(value).ok().is_some_and(|declared| {
                    declared.scheme() == "http"
                        && declared.host_str() == Some("127.0.0.1")
                        && declared.path() == requested.path()
                        && (declared.port().is_none() || declared.port() == requested.port())
                })
            })
        });
    if !redirect_allowed {
        return Err(
            "MCP OAuth Client ID Metadata Document does not allow Mivlet's loopback redirect."
                .into(),
        );
    }
    Ok(())
}

async fn resolve_public_oauth_client(
    discovery: &RemoteMcpAuthorizationDiscovery,
    redirect_uri: &str,
) -> Result<String, String> {
    let issuer = validate_remote_endpoint(&discovery.summary.issuer)?;
    match discovery.summary.client_registration_strategy.as_str() {
        "pre-registered" => configured_preregistered_client_id(&issuer)?
            .ok_or_else(|| "MCP OAuth pre-registered client information is unavailable.".into()),
        "client-id-metadata-document" => {
            let url = configured_client_metadata_document_url()?.ok_or_else(|| {
                "MCP OAuth Client ID Metadata Document is unavailable.".to_string()
            })?;
            let value = fetch_remote_metadata(&url).await?.ok_or_else(|| {
                "MCP OAuth Client ID Metadata Document is unavailable.".to_string()
            })?;
            validate_client_metadata_document(&value, &url, redirect_uri)?;
            Ok(url.to_string())
        }
        "dynamic-client-registration" => {
            let endpoint = discovery.registration_endpoint.as_ref().ok_or_else(|| {
                "MCP OAuth dynamic registration endpoint is unavailable.".to_string()
            })?;
            register_dynamic_public_client(endpoint, redirect_uri).await
        }
        _ => Err("This MCP authorization server requires manual public client information.".into()),
    }
}

fn random_oauth_value(bytes: usize) -> Result<String, String> {
    let mut value = vec![0_u8; bytes];
    getrandom::fill(&mut value)
        .map_err(|_| "Mivlet could not create secure MCP OAuth state.".to_string())?;
    Ok(URL_SAFE_NO_PAD.encode(value))
}

fn authorization_code_from_callback(
    callback_url: &str,
    redirect_uri: &str,
    expected_state: &str,
) -> Result<String, String> {
    let callback =
        Url::parse(callback_url).map_err(|_| "MCP OAuth callback was invalid.".to_string())?;
    let redirect = Url::parse(redirect_uri)
        .map_err(|_| "MCP OAuth redirect state was invalid.".to_string())?;
    if callback.scheme() != redirect.scheme()
        || callback.host_str() != redirect.host_str()
        || callback.port_or_known_default() != redirect.port_or_known_default()
        || callback.path() != redirect.path()
        || callback.fragment().is_some()
    {
        return Err("MCP OAuth callback did not match the bound loopback redirect.".into());
    }
    let mut state = Vec::new();
    let mut code = Vec::new();
    let mut errors = Vec::new();
    for (key, value) in callback.query_pairs() {
        match key.as_ref() {
            "state" => state.push(value.into_owned()),
            "code" => code.push(value.into_owned()),
            "error" => errors.push(value.into_owned()),
            _ => {}
        }
    }
    if state.len() != 1 || state[0] != expected_state {
        return Err("MCP OAuth callback state did not match the active attempt.".into());
    }
    if !errors.is_empty() {
        return Err("The MCP authorization server did not grant access.".into());
    }
    if code.len() != 1
        || code[0].trim().is_empty()
        || code[0].len() > 8_192
        || code[0].chars().any(char::is_control)
    {
        return Err("MCP OAuth callback omitted a valid authorization code.".into());
    }
    Ok(code.remove(0))
}

fn parse_mcp_token_response(
    value: &Value,
    requested_scopes: &[String],
    token_endpoint: &Url,
    client_id: &str,
    resource: &Url,
) -> Result<RemoteMcpOAuthTokens, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "MCP OAuth token response was malformed.".to_string())?;
    let access_token = object
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 32 * 1024)
        .ok_or_else(|| "MCP OAuth token response omitted an access token.".to_string())?;
    if access_token.chars().any(char::is_control)
        || object
            .get("token_type")
            .and_then(Value::as_str)
            .is_none_or(|value| !value.eq_ignore_ascii_case("bearer"))
    {
        return Err("MCP OAuth token response did not provide a usable Bearer token.".into());
    }
    let refresh_token = object
        .get("refresh_token")
        .map(|value| {
            value
                .as_str()
                .filter(|value| {
                    !value.is_empty()
                        && value.len() <= 32 * 1024
                        && !value.chars().any(char::is_control)
                })
                .map(str::to_string)
                .ok_or_else(|| "MCP OAuth refresh token was invalid.".to_string())
        })
        .transpose()?;
    let expires_in = object
        .get("expires_in")
        .and_then(Value::as_u64)
        .filter(|value| (1..=31_536_000).contains(value))
        .ok_or_else(|| "MCP OAuth token response omitted a bounded expiry.".to_string())?;
    let mut scopes = object
        .get("scope")
        .and_then(Value::as_str)
        .map(|value| value.split_ascii_whitespace().map(str::to_string).collect())
        .unwrap_or_else(|| requested_scopes.to_vec());
    if scopes.len() > 64
        || scopes.iter().any(|scope: &String| {
            scope.is_empty() || scope.len() > 200 || scope.chars().any(char::is_control)
        })
    {
        return Err("MCP OAuth token response scopes were invalid.".into());
    }
    scopes.sort();
    scopes.dedup();
    if scopes
        .iter()
        .any(|scope| !requested_scopes.iter().any(|requested| requested == scope))
    {
        return Err("MCP OAuth token response attempted to widen the requested scopes.".into());
    }
    Ok(RemoteMcpOAuthTokens {
        access_token: access_token.to_string(),
        refresh_token,
        expires_at: chrono::Utc::now().timestamp() + expires_in as i64,
        scopes,
        token_endpoint: token_endpoint.to_string(),
        client_id: client_id.to_string(),
        resource: resource.to_string(),
        transport_endpoint: None,
        revocation_endpoint: None,
    })
}

async fn exchange_mcp_authorization_code(
    discovery: &RemoteMcpAuthorizationDiscovery,
    resource: &str,
    client_id: &str,
    redirect_uri: &str,
    code: &str,
    verifier: &str,
) -> Result<RemoteMcpOAuthTokens, String> {
    let client = remote_http_client(&discovery.token_endpoint).await?;
    let response = client
        .post(discovery.token_endpoint.clone())
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", client_id),
            ("redirect_uri", redirect_uri),
            ("code", code),
            ("code_verifier", verifier),
            ("resource", resource),
        ])
        .send()
        .await
        .map_err(|_| "MCP OAuth token exchange failed.".to_string())?;
    if response.status().is_redirection() || !response.status().is_success() {
        return Err("MCP OAuth token exchange was rejected.".into());
    }
    let bytes = read_remote_body(response, MCP_AUTH_METADATA_MAX_BYTES).await?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "MCP OAuth token response was malformed.".to_string())?;
    let mut tokens = parse_mcp_token_response(
        &value,
        &discovery.summary.scopes,
        &discovery.token_endpoint,
        client_id,
        &validate_remote_endpoint(resource)?,
    )?;
    // Preserve the advertised audience byte-for-byte, including a root without '/'.
    tokens.resource = resource.to_string();
    tokens.revocation_endpoint = discovery.revocation_endpoint.as_ref().map(Url::to_string);
    Ok(tokens)
}

async fn revoke_mcp_oauth_token(tokens: &RemoteMcpOAuthTokens) -> Result<(), String> {
    let Some(raw_endpoint) = tokens.revocation_endpoint.as_deref() else {
        return Ok(());
    };
    let endpoint = validate_remote_endpoint(raw_endpoint)?;
    let (token, hint) = tokens
        .refresh_token
        .as_deref()
        .map(|token| (token, "refresh_token"))
        .unwrap_or((&tokens.access_token, "access_token"));
    let client = remote_http_client(&endpoint).await?;
    let response = client
        .post(endpoint)
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .form(&[
            ("token", token),
            ("token_type_hint", hint),
            ("client_id", tokens.client_id.as_str()),
        ])
        .send()
        .await
        .map_err(|_| "MCP OAuth revocation request failed.".to_string())?;
    if response.status().is_redirection() || !response.status().is_success() {
        return Err(
            "MCP OAuth revocation was rejected; the local account remains connected.".into(),
        );
    }
    Ok(())
}

async fn discover_remote_authorization(
    endpoint: &Url,
    challenge: Option<&RemoteAuthorizationChallenge>,
) -> Result<RemoteMcpAuthorizationDiscovery, String> {
    let mut protected = None;
    let candidates = challenge
        .map(|challenge| vec![challenge.resource_metadata.clone()])
        .unwrap_or_else(|| protected_resource_metadata_candidates(endpoint));
    for candidate in candidates {
        if let Some(value) = fetch_remote_metadata(&candidate).await? {
            protected = Some(value);
            break;
        }
    }
    let protected = protected.ok_or_else(|| {
        "Remote MCP server did not publish protected-resource metadata.".to_string()
    })?;
    let (servers, metadata_scopes) = parse_protected_resource_metadata(endpoint, &protected)?;
    let scopes = challenge
        .filter(|challenge| !challenge.scopes.is_empty())
        .map(|challenge| challenge.scopes.clone())
        .unwrap_or(metadata_scopes);
    for issuer in servers {
        for candidate in authorization_metadata_candidates(&issuer) {
            if let Some(value) = fetch_remote_metadata(&candidate).await? {
                let mut discovery =
                    parse_authorization_server_metadata(&issuer, scopes.clone(), &value)?;
                discovery.resource = protected.get("resource").and_then(Value::as_str).map(str::to_string);
                return Ok(discovery);
            }
        }
    }
    Err("Remote MCP authorization server did not publish compatible metadata.".into())
}

fn validate_configuration_for_approval(
    configuration: &McpServerConfiguration,
) -> Result<(), String> {
    crate::store::repos::scope::normalize_id(&configuration.id, "MCP launch reference")
        .map_err(|error| error.to_string())?;
    if configuration
        .expected_revision
        .is_some_and(|revision| revision < 1)
    {
        return Err("MCP configuration revision is invalid.".to_string());
    }
    crate::store::repos::mcp_local_server::validate_server_values(
        &configuration.display_name,
        &configuration.transport,
        &configuration.command,
        &configuration.args,
        configuration.endpoint.as_deref(),
    )
    .map_err(|error| error.to_string())?;
    if configuration.transport == "stdio" {
        validate_executable(&configuration.command)?;
    } else {
        validate_remote_endpoint(configuration.endpoint.as_deref().unwrap_or_default())?;
    }
    let lower_args = configuration.args.join(" ").to_ascii_lowercase();
    const SECRET_MARKERS: &[&str] = &[
        "api-key",
        "apikey",
        "authorization",
        "bearer",
        "password",
        "secret",
        "token",
    ];
    if SECRET_MARKERS
        .iter()
        .any(|marker| lower_args.contains(marker))
    {
        return Err(
            "MCP launch arguments cannot contain credentials; use native credential custody."
                .to_string(),
        );
    }
    Ok(())
}

fn configuration_fingerprint(configuration: &McpServerConfiguration) -> Result<String, String> {
    let encoded = serde_json::to_vec(configuration)
        .map_err(|_| "Mivlet could not fingerprint this MCP configuration.".to_string())?;
    Ok(format!("{:x}", Sha256::digest(encoded)))
}

fn approval_for_configuration(
    configuration: &McpServerConfiguration,
    fingerprint: &str,
    id: String,
    requested_at: String,
) -> crate::models::ApprovalRequest {
    crate::models::ApprovalRequest {
        id,
        service: "MCP connections".to_string(),
        action: format!("configure MCP server {}", configuration.id),
        mode: "full-access".to_string(),
        risk_level: "critical".to_string(),
        data_used: vec![
            format!("server: {}", configuration.display_name.trim()),
            format!("configuration fingerprint: {fingerprint}"),
        ],
        consequence: if configuration.transport == "stdio" {
            "Starts a user-managed local program that can expose tools and resources to Mivlet."
                .to_string()
        } else {
            "Connects to a user-managed remote service that can expose tools and resources to Mivlet."
                .to_string()
        },
        requested_at,
        decisions: vec!["once".to_string(), "deny".to_string()],
        confirmation_phrase: Some(format!("configure {}", configuration.id)),
    }
}

fn validate_executable(command: &str) -> Result<PathBuf, String> {
    let path = Path::new(command);
    if !path.is_absolute() {
        return Err("Local MCP executables must use an absolute path.".to_string());
    }
    let canonical = crate::paths::strict_canonicalize(path)
        .map_err(|_| "The local MCP executable path is unavailable.".to_string())?;
    let metadata = std::fs::metadata(&canonical)
        .map_err(|_| "The local MCP executable path is unavailable.".to_string())?;
    if !metadata.is_file() || crate::paths::contains_symlink(path) {
        return Err("The local MCP executable must be a regular file without links.".to_string());
    }
    #[cfg(windows)]
    if canonical
        .extension()
        .and_then(|value| value.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("exe"))
    {
        return Err("Local MCP executables must be Windows .exe files.".to_string());
    }
    Ok(canonical)
}

fn copy_safe_environment(command: &mut Command) {
    const SAFE: &[&str] = &[
        "PATH",
        "PATHEXT",
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "HOME",
        "USERPROFILE",
        "LANG",
        "LC_ALL",
    ];
    for name in SAFE {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
}

fn spawn_mcp_child(executable: &Path, args: &[String], cwd: &Path) -> std::io::Result<Child> {
    let mut command = Command::new(executable);
    command
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    copy_safe_environment(&mut command);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.as_std_mut().creation_flags(0x0800_0000);
    }
    command.spawn()
}

fn random_session_id() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|_| "Mivlet could not create a local MCP session id.".to_string())?;
    Ok(format!("mcp-{}", hex::encode(bytes)))
}

fn valid_session_id(value: &str) -> bool {
    value.len() == 36
        && value.starts_with("mcp-")
        && value[4..]
            .chars()
            .all(|character| character.is_ascii_hexdigit())
}

fn valid_mcp_frame(frame: &str) -> bool {
    if frame.is_empty() || frame.len() > MAX_MCP_FRAME_BYTES || frame.contains(['\r', '\n']) {
        return false;
    }
    let Ok(Value::Object(object)) = serde_json::from_str::<Value>(frame) else {
        return false;
    };
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return false;
    }
    let valid_id = object
        .get("id")
        .is_none_or(|id| id.is_string() || id.as_i64().is_some() || id.as_u64().is_some());
    if !valid_id {
        return false;
    }
    if let Some(method) = object.get("method") {
        return method.as_str().is_some_and(|value| !value.is_empty())
            && !object.contains_key("result")
            && !object.contains_key("error");
    }
    object.contains_key("id") && (object.contains_key("result") ^ object.contains_key("error"))
}

fn permitted_renderer_frame(frame: &str) -> bool {
    if !valid_mcp_frame(frame) {
        return false;
    }
    let Ok(Value::Object(object)) = serde_json::from_str::<Value>(frame) else {
        return false;
    };
    let Some(method) = object.get("method").and_then(Value::as_str) else {
        // This client advertises no server-request capabilities, so renderer
        // responses are never needed and cannot become an execution bypass.
        return false;
    };
    matches!(
        method,
        "initialize"
            | "ping"
            | "tools/list"
            | "resources/list"
            | "resources/templates/list"
            | "notifications/initialized"
            | "notifications/cancelled"
    )
}

#[derive(Default)]
struct BoundedLineDecoder {
    buffer: Vec<u8>,
    dropping: bool,
}

impl BoundedLineDecoder {
    fn push(&mut self, chunk: &[u8]) -> Vec<Vec<u8>> {
        let mut lines = Vec::new();
        for byte in chunk {
            if *byte == b'\n' {
                if !self.dropping {
                    if self.buffer.last() == Some(&b'\r') {
                        self.buffer.pop();
                    }
                    lines.push(std::mem::take(&mut self.buffer));
                } else {
                    self.buffer.clear();
                }
                self.dropping = false;
            } else if !self.dropping {
                if self.buffer.len() < MAX_MCP_FRAME_BYTES {
                    self.buffer.push(*byte);
                } else {
                    self.buffer.clear();
                    self.dropping = true;
                }
            }
        }
        lines
    }
}
