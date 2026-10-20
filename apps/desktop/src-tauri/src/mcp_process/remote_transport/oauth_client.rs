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
