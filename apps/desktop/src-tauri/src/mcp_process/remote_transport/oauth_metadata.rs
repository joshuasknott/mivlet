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
