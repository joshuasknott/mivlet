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
