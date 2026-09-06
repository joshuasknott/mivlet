#[tauri::command]
pub fn prepare_mcp_server_configuration(
    configuration: McpServerConfiguration,
) -> Result<PreparedMcpServerConfiguration, String> {
    crate::authorized_scope::command_scope(
        Some(configuration.workspace_id.clone()),
        None,
        crate::authorized_scope::ScopeAccess::Write,
    )?;
    validate_configuration_for_approval(&configuration)?;
    let fingerprint = configuration_fingerprint(&configuration)?;
    let id = random_session_id()?.replacen("mcp-", "approval-mcp-", 1);
    let approval = approval_for_configuration(
        &configuration,
        &fingerprint,
        id,
        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    );
    Ok(PreparedMcpServerConfiguration {
        configuration_fingerprint: fingerprint,
        approval,
    })
}

#[tauri::command]
pub fn commit_mcp_server_configuration(
    app: AppHandle,
    request: CommitMcpServerConfigurationRequest,
) -> Result<crate::store::repos::mcp_local_server::SafeMcpLocalServer, String> {
    validate_configuration_for_approval(&request.configuration)?;
    let fingerprint = configuration_fingerprint(&request.configuration)?;
    let expected = approval_for_configuration(
        &request.configuration,
        &fingerprint,
        request.resolution.request.id.clone(),
        request.resolution.request.requested_at.clone(),
    );
    if request.resolution.request != expected
        || request.resolution.decision != "once"
        || request.resolution.modification.is_some()
    {
        return Err("The MCP configuration changed after the approval preview.".to_string());
    }
    let resolution = crate::approvals::resolve_approval(request.resolution)?;
    if resolution.audit_entry.decision != "once" {
        return Err("Local MCP configuration requires a fresh one-time approval.".to_string());
    }
    crate::execution_approvals::verify_and_consume_execution_approval(
        &crate::paths::execution_approvals_path(&app)?,
        &resolution.effective_request,
        &resolution.audit_entry.decided_at,
    )?;
    let scope = crate::authorized_scope::command_scope(
        Some(request.configuration.workspace_id),
        None,
        crate::authorized_scope::ScopeAccess::Write,
    )?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let now = resolution.audit_entry.decided_at;
    store
        .transaction(|tx| {
            let saved = crate::store::repos::mcp_local_server::upsert(
                tx,
                store,
                &scope,
                crate::store::repos::mcp_local_server::McpLocalServerWrite {
                    id: &request.configuration.id,
                    display_name: &request.configuration.display_name,
                    transport: &request.configuration.transport,
                    command: &request.configuration.command,
                    args: &request.configuration.args,
                    endpoint: request.configuration.endpoint.as_deref(),
                    expected_revision: request.configuration.expected_revision,
                    updated_at: &now,
                },
            )?;
            if saved.transport == "stdio" {
                crate::store::repos::connection_record::upsert_mcp_stdio(
                    tx,
                    store,
                    &scope,
                    &saved.id,
                    &saved.display_name,
                    &now,
                )?;
            } else {
                crate::store::repos::connection_record::upsert_mcp_streamable_http(
                    tx,
                    store,
                    &scope,
                    &saved.id,
                    &saved.display_name,
                    &now,
                )?;
            }
            Ok(saved)
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn list_mcp_server_configurations(
    workspace_id: String,
) -> Result<Vec<crate::store::repos::mcp_local_server::SafeMcpLocalServer>, String> {
    let scope = crate::authorized_scope::command_scope(
        Some(workspace_id),
        None,
        crate::authorized_scope::ScopeAccess::Read,
    )?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .with_conn(|tx| crate::store::repos::mcp_local_server::list(tx, store, &scope))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn open_remote_mcp_session(
    request: OpenRemoteMcpSessionRequest,
) -> Result<OpenedRemoteMcpSession, String> {
    let scope = crate::authorized_scope::command_scope(
        Some(request.workspace_id.clone()),
        None,
        crate::authorized_scope::ScopeAccess::Read,
    )?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let configuration = store
        .with_conn(|tx| {
            crate::store::repos::mcp_local_server::get_launch(
                tx,
                store,
                &scope,
                &request.configuration_reference,
            )
        })
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "This remote MCP server is unavailable.".to_string())?;
    if configuration.metadata.disabled || configuration.metadata.transport != "streamable-http" {
        return Err("This remote MCP server is unavailable.".to_string());
    }
    let endpoint = validate_remote_endpoint(configuration.endpoint.as_deref().unwrap_or_default())?;
    let connection = store
        .with_conn(|tx| {
            crate::store::repos::connection_record::mcp_details_for_remote(
                tx,
                store,
                &scope,
                &request.configuration_reference,
            )
        })
        .map_err(|error| error.to_string())?;
    let session_id = random_session_id()?;
    let oauth_credential_key = store
        .with_conn(|tx| {
            crate::store::repos::connection_record::mcp_oauth_credential_binding(
                tx,
                store,
                &scope,
                &connection.connection_id,
            )
        })
        .map_err(|error| error.to_string())?;
    remote_sessions()
        .lock()
        .map_err(|_| "Fable could not access remote MCP sessions.".to_string())?
        .insert(
            session_id.clone(),
            McpRemoteSession {
                endpoint,
                configuration_reference: request.configuration_reference.clone(),
                workspace_id: scope.data.workspace_id().to_string(),
                owner_subject: scope.private.owner_subject().to_string(),
                connection_id: connection.connection_id.clone(),
                connection_revision: connection.connection_revision,
                oauth_credential_key,
                discovery_current: false,
                server_session_id: None,
                last_event_id: None,
                retry_after_ms: 1_000,
                initialized: false,
                busy: false,
                poll_busy: false,
            },
        );
    Ok(OpenedRemoteMcpSession {
        session_id,
        configuration_reference: request.configuration_reference,
        connection_id: connection.connection_id,
        connection_revision: connection.connection_revision,
    })
}

#[tauri::command]
pub async fn inspect_remote_mcp_authorization(
    request: InspectRemoteMcpAuthorizationRequest,
) -> Result<RemoteMcpAuthorizationSummary, String> {
    let scope = crate::authorized_scope::command_scope(
        Some(request.workspace_id),
        None,
        crate::authorized_scope::ScopeAccess::Read,
    )?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let configuration = store
        .with_conn(|tx| {
            crate::store::repos::mcp_local_server::get_launch(
                tx,
                store,
                &scope,
                &request.configuration_reference,
            )
        })
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "This remote MCP server is unavailable.".to_string())?;
    if configuration.metadata.disabled || configuration.metadata.transport != "streamable-http" {
        return Err("This remote MCP server is unavailable.".into());
    }
    let endpoint = validate_remote_endpoint(configuration.endpoint.as_deref().unwrap_or_default())?;
    let connection = store
        .with_conn(|tx| {
            crate::store::repos::connection_record::mcp_details_for_remote(
                tx,
                store,
                &scope,
                &request.configuration_reference,
            )
        })
        .map_err(|error| error.to_string())?;
    let challenge = authorization_challenges()
        .lock()
        .ok()
        .and_then(|challenges| {
            challenges
                .get(&authorization_challenge_key(
                    scope.data.workspace_id(),
                    scope.private.owner_subject(),
                    &request.configuration_reference,
                ))
                .filter(|challenge| {
                    challenge.observed_endpoint.as_ref() == Some(&endpoint)
                        && challenge.connection_revision == Some(connection.connection_revision)
                })
                .cloned()
        });
    discover_remote_authorization(&endpoint, challenge.as_ref())
        .await
        .map(|discovery| discovery.summary)
}

#[tauri::command]
pub async fn begin_remote_mcp_authorization(
    request: BeginRemoteMcpAuthorizationRequest,
) -> Result<RemoteMcpAuthorizationResult, String> {
    let _authorization_guard = oauth_authorization_lock().lock().await;
    let scope = crate::authorized_scope::command_scope(
        Some(request.workspace_id),
        None,
        crate::authorized_scope::ScopeAccess::Write,
    )?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let configuration = store
        .with_conn(|tx| {
            crate::store::repos::mcp_local_server::get_launch(
                tx,
                store,
                &scope,
                &request.configuration_reference,
            )
        })
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "This remote MCP server is unavailable.".to_string())?;
    if configuration.metadata.disabled || configuration.metadata.transport != "streamable-http" {
        return Err("This remote MCP server is unavailable.".into());
    }
    let endpoint = validate_remote_endpoint(configuration.endpoint.as_deref().unwrap_or_default())?;
    let connection = store
        .with_conn(|tx| {
            crate::store::repos::connection_record::mcp_details_for_remote(
                tx,
                store,
                &scope,
                &request.configuration_reference,
            )
        })
        .map_err(|error| error.to_string())?;
    let challenge = authorization_challenges()
        .lock()
        .ok()
        .and_then(|challenges| {
            challenges
                .get(&authorization_challenge_key(
                    scope.data.workspace_id(),
                    scope.private.owner_subject(),
                    &request.configuration_reference,
                ))
                .filter(|challenge| {
                    challenge.observed_endpoint.as_ref() == Some(&endpoint)
                        && challenge.connection_revision == Some(connection.connection_revision)
                })
                .cloned()
        });
    let discovery = discover_remote_authorization(&endpoint, challenge.as_ref()).await?;
    let resource = discovery.resource.as_deref().unwrap_or(endpoint.as_str());
    if discovery.summary.client_registration_status != "selected" {
        return Err(discovery.summary.client_registration_reason.clone());
    }
    let (listener, redirect_uri) = crate::oauth_loopback::bind_loopback_callback().await?;
    let client_id = resolve_public_oauth_client(&discovery, &redirect_uri).await?;
    let state = random_oauth_value(32)?;
    let verifier = random_oauth_value(64)?;
    let challenge = crate::connector_auth::pkce_challenge(&verifier);
    let mut authorization_url = discovery.authorization_endpoint.clone();
    authorization_url
        .query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &client_id)
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("state", &state)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("resource", resource);
    if !discovery.summary.scopes.is_empty() {
        authorization_url
            .query_pairs_mut()
            .append_pair("scope", &discovery.summary.scopes.join(" "));
    }
    crate::oauth_loopback::open_browser(authorization_url.as_str());
    let callback_url =
        crate::oauth_loopback::accept_loopback_callback(listener, &redirect_uri).await?;
    let code = authorization_code_from_callback(&callback_url, &redirect_uri, &state)?;
    let mut tokens = exchange_mcp_authorization_code(
        &discovery,
        resource,
        &client_id,
        &redirect_uri,
        &code,
        &verifier,
    )
    .await?;
    tokens.transport_endpoint = Some(endpoint.to_string());
    let credential_key = mcp_oauth_credential_key(
        scope.data.workspace_id(),
        scope.private.owner_subject(),
        &request.configuration_reference,
    );
    let previous_tokens = load_mcp_oauth_tokens(&credential_key)?;
    store_mcp_oauth_tokens(&credential_key, &tokens)?;
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    if let Err(error) = store.transaction(|tx| {
        crate::store::repos::connection_record::authorize_mcp_oauth(
            tx,
            store,
            &scope,
            &connection.connection_id,
            connection.connection_revision,
            &credential_key,
            &now,
        )
    }) {
        let rollback = match previous_tokens.as_ref() {
            Some(previous) => store_mcp_oauth_tokens(&credential_key, previous),
            None => remove_mcp_oauth_tokens(&credential_key),
        };
        return match rollback {
            Ok(()) => Err(error.to_string()),
            Err(_) => Err("MCP authorization could not be saved or safely rolled back; reconnect this server.".into()),
        };
    }
    Ok(RemoteMcpAuthorizationResult {
        status: "connected",
        issuer: discovery.summary.issuer,
        scopes: tokens.scopes,
        client_registration_strategy: discovery.summary.client_registration_strategy,
        message: "MCP account credentials are stored in the native credential boundary.".into(),
    })
}

#[tauri::command]
pub async fn disconnect_remote_mcp_authorization(
    request: DisconnectRemoteMcpAuthorizationRequest,
) -> Result<RemoteMcpDisconnectionResult, String> {
    let _authorization_guard = oauth_authorization_lock().lock().await;
    let scope = crate::authorized_scope::command_scope(
        Some(request.workspace_id),
        None,
        crate::authorized_scope::ScopeAccess::Write,
    )?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let connection = store
        .with_conn(|tx| {
            crate::store::repos::connection_record::mcp_details_for_remote(
                tx,
                store,
                &scope,
                &request.configuration_reference,
            )
        })
        .map_err(|error| error.to_string())?;
    let credential_key = store
        .with_conn(|tx| {
            crate::store::repos::connection_record::mcp_oauth_credential_binding(
                tx,
                store,
                &scope,
                &connection.connection_id,
            )
        })
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "This MCP server has no connected account.".to_string())?;
    let expected_key = mcp_oauth_credential_key(
        scope.data.workspace_id(),
        scope.private.owner_subject(),
        &request.configuration_reference,
    );
    if credential_key != expected_key {
        return Err("MCP Connection credential binding does not match this server.".into());
    }
    let tokens = load_mcp_oauth_tokens(&credential_key)?.ok_or_else(|| {
        "MCP Connection credentials are unavailable; reconnect this server.".to_string()
    })?;
    revoke_mcp_oauth_token(&tokens).await?;
    let credential_removal = remove_mcp_oauth_tokens(&credential_key);
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    store
        .transaction(|tx| {
            crate::store::repos::connection_record::revoke_mcp_oauth(
                tx,
                store,
                &scope,
                &connection.connection_id,
                connection.connection_revision,
                &credential_key,
                &now,
            )
        })
        .map_err(|error| error.to_string())?;
    credential_removal?;
    Ok(RemoteMcpDisconnectionResult {
        status: "disconnected",
        message: "The MCP account credential was revoked and removed from this device.".into(),
    })
}

#[tauri::command]
pub async fn send_remote_mcp_frame(
    request: SendRemoteMcpFrameRequest,
) -> Result<Vec<String>, String> {
    if !valid_session_id(&request.session_id) || !permitted_renderer_frame(&request.frame) {
        return Err("The remote MCP frame is invalid or not permitted.".to_string());
    }
    let scope = crate::authorized_scope::command_scope(
        Some(request.workspace_id),
        None,
        crate::authorized_scope::ScopeAccess::Read,
    )?;
    let snapshot = {
        let mut sessions = remote_sessions()
            .lock()
            .map_err(|_| "Fable could not access remote MCP sessions.".to_string())?;
        let session = sessions
            .get_mut(&request.session_id)
            .ok_or_else(|| "This remote MCP session is unavailable.".to_string())?;
        require_remote_session_owner(session, &scope)?;
        if session.busy {
            return Err("This remote MCP session is already handling a request.".to_string());
        }
        register_discovery_request(&request.session_id, &request.frame, session.initialized)?;
        session.busy = true;
        session.clone()
    };
    let result = post_remote_mcp_frame(&snapshot, &request.frame).await;
    if let Ok(response) = &result {
        for frame in &response.frames {
            observe_discovery_frame(&request.session_id, frame);
        }
        if response.error.is_some() {
            mark_discovery_changed(&request.session_id);
        }
    } else {
        mark_discovery_changed(&request.session_id);
    }
    if let Ok(mut sessions) = remote_sessions().lock() {
        if let Some(session) = sessions.get_mut(&request.session_id) {
            session.busy = false;
            if let Ok(response) = &result {
                if let Some(challenge) = &response.authorization_challenge {
                    if let Ok(mut challenges) = authorization_challenges().lock() {
                        if challenges.len() >= 64 {
                            if let Some(first) = challenges.keys().next().cloned() {
                                challenges.remove(&first);
                            }
                        }
                        challenges.insert(
                            authorization_challenge_key(
                                &snapshot.workspace_id,
                                &snapshot.owner_subject,
                                &snapshot.configuration_reference,
                            ),
                            challenge.clone(),
                        );
                    }
                } else if response.error.is_none() {
                    if let Ok(mut challenges) = authorization_challenges().lock() {
                        challenges.remove(&authorization_challenge_key(
                            &snapshot.workspace_id,
                            &snapshot.owner_subject,
                            &snapshot.configuration_reference,
                        ));
                    }
                }
                if response.initialized {
                    session.initialized = true;
                }
                if let Some(server_session_id) = &response.server_session_id {
                    session.server_session_id = Some(server_session_id.clone());
                }
                if let Some(event_id) = &response.last_event_id {
                    session.last_event_id = Some(event_id.clone());
                }
                session.retry_after_ms = response.retry_after_ms;
            }
        }
    }
    match result {
        Ok(response) => match response.error {
            Some(error) => Err(error),
            None => Ok(response.frames),
        },
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub async fn poll_remote_mcp_messages(
    request: CloseMcpProcessRequest,
) -> Result<RemoteMcpPollResult, String> {
    if !valid_session_id(&request.session_id) {
        return Err("The remote MCP session id is invalid.".into());
    }
    let scope = crate::authorized_scope::command_scope(
        Some(request.workspace_id),
        None,
        crate::authorized_scope::ScopeAccess::Read,
    )?;
    let snapshot = {
        let mut sessions = remote_sessions()
            .lock()
            .map_err(|_| "Fable could not access remote MCP sessions.".to_string())?;
        let session = sessions
            .get_mut(&request.session_id)
            .ok_or_else(|| "This remote MCP session is unavailable.".to_string())?;
        require_remote_session_owner(session, &scope)?;
        if !session.initialized {
            return Err("Remote MCP listening requires an initialized session.".into());
        }
        if session.poll_busy {
            return Err("This remote MCP session is already listening.".into());
        }
        session.poll_busy = true;
        session.clone()
    };
    tokio::time::sleep(Duration::from_millis(snapshot.retry_after_ms)).await;
    let result = get_remote_mcp_messages(&snapshot).await;
    if let Ok(polled) = &result {
        for frame in &polled.frames {
            observe_discovery_frame(&request.session_id, frame);
        }
    }
    if let Ok(mut sessions) = remote_sessions().lock() {
        if let Some(session) = sessions.get_mut(&request.session_id) {
            session.poll_busy = false;
            if let Ok(polled) = &result {
                if let Some(event_id) = &polled.last_event_id {
                    session.last_event_id = Some(event_id.clone());
                }
                session.retry_after_ms = polled.retry_after_ms;
            }
        }
    }
    result.map(|polled| RemoteMcpPollResult {
        supported: polled.supported,
        frames: polled.frames,
        retry_after_ms: polled.retry_after_ms,
    })
}

#[tauri::command]
pub async fn close_remote_mcp_session(request: CloseMcpProcessRequest) -> Result<(), String> {
    if !valid_session_id(&request.session_id) {
        return Err("The remote MCP session id is invalid.".to_string());
    }
    let scope = crate::authorized_scope::command_scope(
        Some(request.workspace_id),
        None,
        crate::authorized_scope::ScopeAccess::Read,
    )?;
    let session = {
        let mut sessions = remote_sessions()
            .lock()
            .map_err(|_| "Fable could not access remote MCP sessions.".to_string())?;
        let session = sessions
            .get(&request.session_id)
            .ok_or_else(|| "This remote MCP session is unavailable.".to_string())?;
        require_remote_session_owner(session, &scope)?;
        sessions
            .remove(&request.session_id)
            .expect("session existed")
    };
    if let Ok(mut proofs) = discovery_proofs().lock() {
        proofs.remove(&request.session_id);
    }
    if session.server_session_id.is_some() {
        delete_remote_mcp_session(&session).await?;
    }
    Ok(())
}

#[tauri::command]
pub fn record_mcp_server_discovery(
    request: RecordMcpDiscoveryRequest,
) -> Result<crate::store::repos::connection_record::SafeMcpConnectionDetails, String> {
    if !valid_session_id(&request.session_id) {
        return Err("The MCP session id is invalid.".to_string());
    }
    let scope = crate::authorized_scope::command_scope(
        Some(request.workspace_id),
        None,
        crate::authorized_scope::ScopeAccess::Write,
    )?;
    let local = process_map()
        .lock()
        .map_err(|_| "Fable could not access MCP sessions.".to_string())?
        .get(&request.session_id)
        .map(|process| {
            require_session_owner(process, &scope)?;
            Ok::<(String, i64), String>((
                process.connection_id.clone(),
                process.connection_revision,
            ))
        })
        .transpose()?;
    let (connection_id, connection_revision) = if let Some(local) = local {
        local
    } else {
        let sessions = remote_sessions()
            .lock()
            .map_err(|_| "Fable could not access MCP sessions.".to_string())?;
        let session = sessions
            .get(&request.session_id)
            .ok_or_else(|| "This MCP session is unavailable.".to_string())?;
        require_remote_session_owner(session, &scope)?;
        (session.connection_id.clone(), session.connection_revision)
    };
    verify_discovery_proof(&request.session_id, &request.tools, &request.resources)?;
    let proof_tools = request.tools.clone();
    let proof_resources = request.resources.clone();
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let recorded = store
        .transaction(|tx| {
            crate::store::repos::connection_record::record_mcp_discovery(
                tx,
                store,
                &scope,
                &connection_id,
                connection_revision,
                request.tools,
                request.resources,
                &chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            )
        })
        .map_err(|error| error.to_string())?;
    commit_session_discovery_authority(
        &request.session_id,
        &recorded.connection_id,
        connection_revision,
        recorded.connection_revision,
        &proof_tools,
        &proof_resources,
    )?;
    Ok(recorded)
}

#[tauri::command]
pub fn set_mcp_server_enablement(
    request: SetMcpEnablementRequest,
) -> Result<crate::store::repos::connection_record::SafeMcpConnectionDetails, String> {
    let scope = crate::authorized_scope::command_scope(
        Some(request.workspace_id),
        None,
        crate::authorized_scope::ScopeAccess::Write,
    )?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            if let Some(requested) = request.capability_bindings.first() {
                for server in crate::store::repos::mcp_local_server::list(tx, store, &scope)? {
                    let details = if server.transport == "stdio" {
                        crate::store::repos::connection_record::mcp_details_for_launch(
                            tx, store, &scope, &server.id,
                        )
                    } else {
                        crate::store::repos::connection_record::mcp_details_for_remote(
                            tx, store, &scope, &server.id,
                        )
                    }?;
                    if details.connection_id != request.connection_id
                        && details
                            .capability_bindings
                            .iter()
                            .any(|binding| binding.capability_id == requested.capability_id)
                    {
                        return Err(crate::store::StoreError::Invalid(
                            "Only one MCP Connection can be selected for a semantic capability."
                                .into(),
                        ));
                    }
                }
            }
            crate::store::repos::connection_record::set_mcp_enablement(
                tx,
                store,
                &scope,
                &request.connection_id,
                request.expected_revision,
                request.enabled_tools,
                request.enabled_resources,
                request.capability_bindings,
                &chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            )
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn resolve_mcp_capability_route(
    request: ResolveMcpCapabilityRouteRequest,
) -> Result<Option<ResolvedMcpCapabilityRoute>, String> {
    if request.capability_id != "knowledge.content.search" {
        return Ok(None);
    }
    let scope = crate::authorized_scope::command_scope(
        Some(request.workspace_id),
        None,
        crate::authorized_scope::ScopeAccess::Read,
    )?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .with_conn(|tx| {
            let mut routes = Vec::new();
            for server in crate::store::repos::mcp_local_server::list(tx, store, &scope)? {
                if server.disabled {
                    continue;
                }
                let details = if server.transport == "stdio" {
                    crate::store::repos::connection_record::mcp_details_for_launch(
                        tx, store, &scope, &server.id,
                    )
                } else {
                    crate::store::repos::connection_record::mcp_details_for_remote(
                        tx, store, &scope, &server.id,
                    )
                }?;
                if let Some(binding) = details
                    .capability_bindings
                    .iter()
                    .find(|binding| binding.capability_id == request.capability_id)
                {
                    routes.push(ResolvedMcpCapabilityRoute {
                        configuration_reference: server.id,
                        transport: details.transport,
                        connection_id: details.connection_id,
                        connection_revision: details.connection_revision,
                        capability_id: binding.capability_id.clone(),
                        tool_name: binding.tool_name.clone(),
                    });
                }
            }
            match routes.len() {
                0 => Ok(None),
                1 => Ok(routes.pop()),
                _ => Err(crate::store::StoreError::Invalid(
                    "Multiple MCP Connections are bound to this semantic capability.".into(),
                )),
            }
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn prepare_mcp_tool_call(proposal: McpToolProposal) -> Result<PreparedMcpToolCall, String> {
    let context = validate_tool_proposal(&proposal)?;
    let approval = approval_for_tool_proposal(
        &proposal,
        &context.proposal_fingerprint,
        random_session_id()?.replacen("mcp-", "approval-mcp-tool-", 1),
        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    );
    Ok(PreparedMcpToolCall {
        proposal_fingerprint: context.proposal_fingerprint,
        requires_approval: !routine_official_read(&proposal)?,
        approval,
    })
}

#[tauri::command]
pub fn authorize_mcp_tool_call(
    app: AppHandle,
    request: AuthorizeMcpToolCallRequest,
) -> Result<AuthorizedMcpToolCall, String> {
    let context = validate_tool_proposal(&request.proposal)?;
    let expected = approval_for_tool_proposal(
        &request.proposal,
        &context.proposal_fingerprint,
        request.resolution.request.id.clone(),
        request.resolution.request.requested_at.clone(),
    );
    if request.resolution.request != expected
        || request.resolution.decision != "once"
        || request.resolution.modification.is_some()
    {
        return Err("The MCP tool proposal changed after approval preview.".into());
    }
    let resolution = crate::approvals::resolve_approval(request.resolution)?;
    if !routine_official_read(&request.proposal)? {
        crate::execution_approvals::verify_and_consume_execution_approval(
            &crate::paths::execution_approvals_path(&app)?,
            &resolution.effective_request,
            &resolution.audit_entry.decided_at,
        )?;
    }
    // Re-resolve every authority after permit I/O so an account, session,
    // Connection revision, or enablement change cannot race approval.
    let current = validate_tool_proposal(&request.proposal)?;
    if current.proposal_fingerprint != context.proposal_fingerprint {
        return Err("The MCP tool proposal changed during approval.".into());
    }
    let permit_id = random_session_id()?.replacen("mcp-", "mcp-permit-", 1);
    let permit = McpToolPermit {
        session_id: request.proposal.session_id,
        connection_id: current.connection_id,
        connection_revision: current.connection_revision,
        tool_name: request.proposal.tool_name,
        arguments_fingerprint: current.arguments_fingerprint,
        issued_at: Instant::now(),
    };
    let mut permits = tool_permits()
        .lock()
        .map_err(|_| "Fable could not access MCP execution permits.".to_string())?;
    permits.retain(|_, value| value.issued_at.elapsed() <= Duration::from_secs(60));
    permits.insert(permit_id.clone(), permit);
    Ok(AuthorizedMcpToolCall {
        permit_id,
        expires_in_seconds: 60,
    })
}

#[tauri::command]
pub async fn execute_approved_mcp_tool_call(
    request: ExecuteMcpToolCallRequest,
) -> Result<Vec<String>, String> {
    crate::execution_control::ensure_active_execution_allowed()?;
    if !valid_request_id(&request.request_id) {
        return Err("The MCP request id is invalid.".into());
    }
    let permit = tool_permits()
        .lock()
        .map_err(|_| "Fable could not access MCP execution permits.".to_string())?
        .remove(&request.permit_id)
        .ok_or_else(|| "The MCP execution permit is unavailable or already used.".to_string())?;
    if permit.issued_at.elapsed() > Duration::from_secs(60) {
        return Err("The MCP execution permit expired.".into());
    }
    let context = validate_tool_proposal(&request.proposal)?;
    if permit.session_id != request.proposal.session_id
        || permit.connection_id != context.connection_id
        || permit.connection_revision != context.connection_revision
        || permit.tool_name != request.proposal.tool_name
        || permit.arguments_fingerprint != context.arguments_fingerprint
    {
        return Err("The MCP execution permit does not match this exact tool call.".into());
    }
    let scope = crate::authorized_scope::command_scope(
        Some(request.proposal.workspace_id.clone()),
        None,
        crate::authorized_scope::ScopeAccess::Write,
    )?;
    let frame = serde_json::json!({
        "jsonrpc": "2.0",
        "id": request.request_id,
        "method": "tools/call",
        "params": {
            "name": request.proposal.tool_name,
            "arguments": request.proposal.arguments
        }
    })
    .to_string();
    if frame.len() > MAX_MCP_FRAME_BYTES || !valid_mcp_frame(&frame) {
        return Err("The approved MCP tool frame is invalid.".into());
    }
    let audit_key = pending_audit_key(&request.proposal.session_id, &request.request_id);
    pending_audits()
        .lock()
        .map_err(|_| "Fable could not access MCP audit state.".to_string())?
        .insert(
            audit_key.clone(),
            PendingMcpAudit {
                tool_name: request.proposal.tool_name,
                connection_id: context.connection_id,
                actor: scope.internal_user_id.clone(),
            },
        );
    if context.transport == "stdio" {
        let sender = (|| -> Result<mpsc::Sender<String>, String> {
            let map = process_map()
                .lock()
                .map_err(|_| "Fable could not access local MCP sessions.".to_string())?;
            let process = map
                .get(&request.proposal.session_id)
                .ok_or_else(|| "This local MCP session is unavailable.".to_string())?;
            require_session_owner(process, &scope)?;
            let sender = process
                .stdin
                .clone()
                .ok_or_else(|| "This local MCP session is closed.".to_string())?;
            Ok(sender)
        })();
        let sender = match sender {
            Ok(sender) => sender,
            Err(error) => {
                fail_pending_mcp_audit(&audit_key, &request.request_id, "transport-closed");
                return Err(error);
            }
        };
        if sender.send(frame).await.is_ok() {
            return Ok(Vec::new());
        }
        if let Some(pending) = pending_audits()
            .lock()
            .ok()
            .and_then(|mut audits| audits.remove(&audit_key))
        {
            record_mcp_audit(pending, &request.request_id, true, "transport-closed");
        }
        return Err("This local MCP session is closed.".into());
    }
    let snapshot = (|| -> Result<McpRemoteSession, String> {
        let mut sessions = remote_sessions()
            .lock()
            .map_err(|_| "Fable could not access remote MCP sessions.".to_string())?;
        let session = sessions
            .get_mut(&request.proposal.session_id)
            .ok_or_else(|| "This remote MCP session is unavailable.".to_string())?;
        require_remote_session_owner(session, &scope)?;
        if session.busy {
            return Err("This remote MCP session is already handling a request.".into());
        }
        session.busy = true;
        Ok(session.clone())
    })();
    let snapshot = match snapshot {
        Ok(snapshot) => snapshot,
        Err(error) => {
            fail_pending_mcp_audit(&audit_key, &request.request_id, "transport-unavailable");
            return Err(error);
        }
    };
    let response = post_remote_mcp_frame(&snapshot, &frame).await;
    if let Ok(mut sessions) = remote_sessions().lock() {
        if let Some(session) = sessions.get_mut(&request.proposal.session_id) {
            session.busy = false;
            if let Ok(response) = &response {
                if let Some(event_id) = &response.last_event_id {
                    session.last_event_id = Some(event_id.clone());
                }
                session.retry_after_ms = response.retry_after_ms;
            }
        }
    }
    let response = match response {
        Ok(response) if response.error.is_none() => response,
        Ok(response) => {
            let error = response
                .error
                .unwrap_or_else(|| "Remote MCP tool call failed.".into());
            fail_pending_mcp_audit(&audit_key, &request.request_id, "transport-rejected");
            return Err(error);
        }
        Err(error) => {
            fail_pending_mcp_audit(&audit_key, &request.request_id, "transport-failed");
            return Err(error);
        }
    };
    let mut matched = false;
    for response_frame in &response.frames {
        if is_mcp_response_for(response_frame, &request.request_id) {
            matched = true;
        }
        audit_mcp_response(&request.proposal.session_id, response_frame);
    }
    if !matched {
        fail_pending_mcp_audit(&audit_key, &request.request_id, "missing-response");
        return Err("Remote MCP did not return the approved tool response.".into());
    }
    Ok(response.frames)
}

#[tauri::command]
pub async fn spawn_mcp_process(
    app: AppHandle,
    request: SpawnMcpProcessRequest,
) -> Result<SpawnedMcpProcess, String> {
    let scope = crate::authorized_scope::command_scope(
        Some(request.workspace_id.clone()),
        None,
        crate::authorized_scope::ScopeAccess::Read,
    )?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let launch = store
        .with_conn(|tx| {
            crate::store::repos::mcp_local_server::get_launch(
                tx,
                store,
                &scope,
                &request.launch_reference,
            )
        })
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "This local MCP server is unavailable.".to_string())?;
    if launch.metadata.disabled {
        return Err("This local MCP server is disabled.".to_string());
    }
    if launch.metadata.transport != "stdio" {
        return Err("This MCP server does not use the local STDIO transport.".to_string());
    }
    let connection = store
        .with_conn(|tx| {
            crate::store::repos::connection_record::mcp_details_for_launch(
                tx,
                store,
                &scope,
                &request.launch_reference,
            )
        })
        .map_err(|error| error.to_string())?;

    let executable = validate_executable(&launch.command)?;
    let workspace_root = crate::tools::resolve_workspace_root(&app)?;
    let mut child = spawn_mcp_child(&executable, &launch.args, &workspace_root)
        .map_err(|_| "Fable could not start this local MCP server.".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Fable could not open the MCP stdout pipe.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Fable could not open the MCP stderr pipe.".to_string())?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Fable could not open the MCP stdin pipe.".to_string())?;

    let session_id = random_session_id()?;
    let channel = format!("{MCP_EVENT_CHANNEL_PREFIX}{session_id}");
    let (stdin_tx, mut stdin_rx) = mpsc::channel::<String>(64);
    tokio::spawn(async move {
        let mut stdin = stdin;
        while let Some(frame) = stdin_rx.recv().await {
            if stdin.write_all(frame.as_bytes()).await.is_err()
                || stdin.write_all(b"\n").await.is_err()
                || stdin.flush().await.is_err()
            {
                break;
            }
        }
    });

    let stdout_app = app.clone();
    let stdout_channel = channel.clone();
    let stdout_session_id = session_id.clone();
    tokio::spawn(async move {
        let mut reader = stdout;
        let mut decoder = BoundedLineDecoder::default();
        let mut chunk = [0_u8; 8 * 1024];
        loop {
            match reader.read(&mut chunk).await {
                Ok(0) => break,
                Ok(count) => {
                    for line in decoder.push(&chunk[..count]) {
                        if let Ok(text) = String::from_utf8(line) {
                            if valid_mcp_frame(&text) {
                                observe_discovery_frame(&stdout_session_id, &text);
                                audit_mcp_response(&stdout_session_id, &text);
                                let _ = stdout_app.emit(&stdout_channel, text);
                            }
                        }
                    }
                }
                Err(_) => break,
            }
        }
        let _ = stdout_app.emit(&stdout_channel, "[MCP-CLOSED]");
    });
    // Stderr may contain credentials or provider diagnostics. Drain it so the
    // child cannot block, but never forward it across the native boundary.
    tokio::spawn(async move {
        let mut stderr = stderr;
        let mut chunk = [0_u8; 8 * 1024];
        while let Ok(count) = stderr.read(&mut chunk).await {
            if count == 0 {
                break;
            }
        }
    });

    process_map()
        .lock()
        .map_err(|_| "Fable could not access local MCP sessions.".to_string())?
        .insert(
            session_id.clone(),
            McpChild {
                child,
                stdin: Some(stdin_tx),
                workspace_id: scope.data.workspace_id().to_string(),
                owner_subject: scope.private.owner_subject().to_string(),
                connection_id: connection.connection_id.clone(),
                connection_revision: connection.connection_revision,
                initialized: false,
                discovery_current: false,
            },
        );
    Ok(SpawnedMcpProcess {
        session_id,
        channel,
        launch_reference: launch.metadata.id,
        connection_id: connection.connection_id,
        connection_revision: connection.connection_revision,
    })
}

#[tauri::command]
pub async fn write_mcp_frame(request: WriteMcpFrameRequest) -> Result<(), String> {
    if !valid_session_id(&request.session_id) || !permitted_renderer_frame(&request.frame) {
        return Err("The MCP frame is invalid.".to_string());
    }
    let scope = crate::authorized_scope::command_scope(
        Some(request.workspace_id),
        None,
        crate::authorized_scope::ScopeAccess::Read,
    )?;
    let (sender, initialized) = {
        let map = process_map()
            .lock()
            .map_err(|_| "Fable could not access local MCP sessions.".to_string())?;
        let process = map
            .get(&request.session_id)
            .ok_or_else(|| "This local MCP session is unavailable.".to_string())?;
        require_session_owner(process, &scope)?;
        (
            process
                .stdin
                .clone()
                .ok_or_else(|| "This local MCP session is closed.".to_string())?,
            process.initialized,
        )
    };
    register_discovery_request(&request.session_id, &request.frame, initialized)?;
    if sender.send(request.frame).await.is_err() {
        mark_discovery_changed(&request.session_id);
        return Err("This local MCP session is closed.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn close_mcp_process(request: CloseMcpProcessRequest) -> Result<(), String> {
    if !valid_session_id(&request.session_id) {
        return Err("The MCP session id is invalid.".to_string());
    }
    let scope = crate::authorized_scope::command_scope(
        Some(request.workspace_id),
        None,
        crate::authorized_scope::ScopeAccess::Read,
    )?;
    let mut process = {
        let mut map = process_map()
            .lock()
            .map_err(|_| "Fable could not access local MCP sessions.".to_string())?;
        let process = map
            .get(&request.session_id)
            .ok_or_else(|| "This local MCP session is unavailable.".to_string())?;
        require_session_owner(process, &scope)?;
        map.remove(&request.session_id)
            .ok_or_else(|| "This local MCP session is unavailable.".to_string())?
    };
    if let Ok(mut proofs) = discovery_proofs().lock() {
        proofs.remove(&request.session_id);
    }
    drain_session_audits(&request.session_id);
    if let Ok(mut permits) = tool_permits().lock() {
        permits.retain(|_, permit| permit.session_id != request.session_id);
    }
    process.stdin.take();
    match timeout(Duration::from_secs(2), process.child.wait()).await {
        Ok(Ok(_)) => Ok(()),
        _ => {
            let _ = process.child.kill().await;
            let _ = process.child.wait().await;
            Ok(())
        }
    }
}

fn require_session_owner(
    process: &McpChild,
    scope: &crate::authorized_scope::AuthorizedCommandScope,
) -> Result<(), String> {
    if process.workspace_id != scope.data.workspace_id()
        || process.owner_subject != scope.private.owner_subject()
    {
        return Err("This local MCP session belongs to a different account or workspace.".into());
    }
    Ok(())
}

fn require_remote_session_owner(
    session: &McpRemoteSession,
    scope: &crate::authorized_scope::AuthorizedCommandScope,
) -> Result<(), String> {
    if session.workspace_id != scope.data.workspace_id()
        || session.owner_subject != scope.private.owner_subject()
    {
        return Err("This remote MCP session belongs to a different account or workspace.".into());
    }
    Ok(())
}
