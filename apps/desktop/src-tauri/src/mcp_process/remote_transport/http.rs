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
    let request = authorize_remote_request(request, session).await?;
    require_remote_dispatch(session)?;
    if matches!(parsed.get("method").and_then(Value::as_str), Some("tools/call" | "resources/read")) {
        crate::execution_control::ensure_active_execution_allowed()?;
    }
    let response = request.send()
        .await
        .map_err(|_| "Remote MCP request failed.".to_string())?;
    require_remote_response(session)?;
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
    require_remote_response(session)?;
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
    let request = authorize_remote_request(request, session).await?;
    require_remote_dispatch(session)?;
    let response = request.send()
        .await
        .map_err(|_| "Remote MCP listening request failed.".to_string())?;
    require_remote_response(session)?;
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
    require_remote_response(session)?;
    let parsed = parse_remote_sse(&body, false)?;
    Ok(RemotePollResponse {
        supported: true,
        frames: parsed.frames,
        last_event_id: parsed.last_event_id,
        retry_after_ms: parsed.retry_after_ms,
    })
}
