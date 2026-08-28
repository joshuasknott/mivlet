struct ToolProposalContext {
    connection_id: String,
    connection_revision: i64,
    transport: String,
    arguments_fingerprint: String,
    proposal_fingerprint: String,
}

pub(crate) fn prepare_semantic_capability_call(
    workspace_id: String,
    session_id: String,
    capability_id: String,
    input: std::collections::BTreeMap<String, Value>,
    cursor: Option<String>,
) -> Result<McpSemanticContinuation, String> {
    if capability_id != "knowledge.content.search" {
        return Err("This MCP semantic capability is not supported.".into());
    }
    if input.keys().any(|key| key != "query" && key != "limit") {
        return Err("Connected-source search input contains unsupported fields.".into());
    }
    let query = input
        .get("query")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|query| !query.is_empty() && query.len() <= 4_096)
        .ok_or_else(|| "Connected-source search requires a bounded query.".to_string())?
        .to_string();
    let limit = input
        .get("limit")
        .map(|value| {
            value
                .as_u64()
                .filter(|limit| (1..=50).contains(limit))
                .ok_or_else(|| {
                    "Connected-source search limit must be between 1 and 50.".to_string()
                })
        })
        .transpose()?;
    let scope = crate::authorized_scope::command_scope(
        Some(workspace_id.clone()),
        None,
        crate::authorized_scope::ScopeAccess::Write,
    )?;
    let session = process_map()
        .lock()
        .map_err(|_| "Fable could not access MCP sessions.".to_string())?
        .get(&session_id)
        .map(|process| {
            require_session_owner(process, &scope)?;
            require_current_session_discovery(process.discovery_current)?;
            Ok::<(String, i64), String>((
                process.connection_id.clone(),
                process.connection_revision,
            ))
        })
        .transpose()?;
    let (connection_id, connection_revision) = if let Some(session) = session {
        session
    } else {
        let sessions = remote_sessions()
            .lock()
            .map_err(|_| "Fable could not access MCP sessions.".to_string())?;
        let session = sessions
            .get(&session_id)
            .ok_or_else(|| "This MCP session is unavailable.".to_string())?;
        require_remote_session_owner(session, &scope)?;
        if !session.initialized {
            return Err("Remote MCP execution requires an initialized session.".into());
        }
        require_current_session_discovery(session.discovery_current)?;
        (session.connection_id.clone(), session.connection_revision)
    };
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let (binding, connection) = store
        .with_conn(|tx| {
            let binding = crate::store::repos::connection_record::require_mcp_capability_binding(
                tx,
                store,
                &scope,
                &connection_id,
                connection_revision,
                &capability_id,
            )?;
            let connection = crate::store::repos::connection_record::get(
                tx,
                store,
                &scope,
                &connection_id,
            )?
            .ok_or_else(|| {
                crate::store::StoreError::Invalid("MCP Connection is unavailable.".into())
            })?;
            Ok((binding, connection))
        })
        .map_err(|error| error.to_string())?;
    let mut arguments = serde_json::Map::from_iter([
        (
            "contractVersion".into(),
            Value::String("fable.connected-source-search.v1".into()),
        ),
        ("query".into(), Value::String(query.clone())),
    ]);
    if let Some(limit) = limit {
        arguments.insert("limit".into(), Value::Number(limit.into()));
    }
    if let Some(cursor) = cursor {
        if cursor.is_empty() || cursor.len() > 2_048 || cursor.chars().any(char::is_control) {
            return Err("Connected-source search cursor is invalid.".into());
        }
        arguments.insert("cursor".into(), Value::String(cursor));
    }
    let proposal = McpToolProposal {
        workspace_id: workspace_id.clone(),
        session_id,
        tool_name: binding.tool_name,
        arguments: Value::Object(arguments),
    };
    let context = validate_tool_proposal(&proposal)?;
    if context.connection_id != connection_id || context.connection_revision != connection_revision
    {
        return Err("The MCP semantic route changed before execution.".into());
    }
    let grants = store
        .transaction(|tx| {
            let current_binding =
                crate::store::repos::connection_record::require_mcp_capability_binding(
                    tx,
                    store,
                    &scope,
                    &connection_id,
                    connection_revision,
                    &capability_id,
                )?;
            if current_binding.tool_name != proposal.tool_name {
                return Err(crate::store::StoreError::Invalid(
                    "The MCP semantic binding changed before execution.".into(),
                ));
            }
            let at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            crate::store::repos::capability_grant::authorize_and_consume(
                tx,
                store,
                &scope,
                &capability_id,
                &connection_id,
                "read",
                &at,
            )?
            .map_err(|failure| crate::store::StoreError::Invalid(failure.message.into()))
        })
        .map_err(|error| error.to_string())?;
    let permit_id = random_session_id()?.replacen("mcp-", "mcp-semantic-permit-", 1);
    tool_permits()
        .lock()
        .map_err(|_| "Fable could not access MCP execution permits.".to_string())?
        .insert(
            permit_id.clone(),
            McpToolPermit {
                session_id: proposal.session_id.clone(),
                connection_id: context.connection_id,
                connection_revision: context.connection_revision,
                tool_name: proposal.tool_name.clone(),
                arguments_fingerprint: context.arguments_fingerprint,
                issued_at: Instant::now(),
            },
        );
    let degraded = connection.health_state != "healthy";
    Ok(McpSemanticContinuation {
        kind: "mcp-connected-source-search",
        proposal,
        permit_id,
        workspace_id,
        query,
        connection_id,
        matched_grant_ids: grants.into_iter().map(|grant| grant.id).collect(),
        degraded,
        degradation_reasons: degraded
            .then_some("connection-health-unknown-or-degraded".into())
            .into_iter()
            .collect(),
    })
}

fn validate_tool_proposal(
    proposal: &McpToolProposal,
) -> Result<ToolProposalContext, String> {
    if !valid_session_id(&proposal.session_id) {
        return Err("The MCP session id is invalid.".into());
    }
    validate_mcp_tool_name(&proposal.tool_name)?;
    validate_mcp_arguments(&proposal.arguments)?;
    let scope = crate::authorized_scope::command_scope(
        Some(proposal.workspace_id.clone()),
        None,
        crate::authorized_scope::ScopeAccess::Write,
    )?;
    let local = process_map()
        .lock()
        .map_err(|_| "Fable could not access MCP sessions.".to_string())?
        .get(&proposal.session_id)
        .map(|process| {
            require_session_owner(process, &scope)?;
            require_current_session_discovery(process.discovery_current)?;
            Ok::<(String, i64, String), String>((
                process.connection_id.clone(),
                process.connection_revision,
                "stdio".into(),
            ))
        })
        .transpose()?;
    let (connection_id, connection_revision, transport) = if let Some(local) = local {
        local
    } else {
        let sessions = remote_sessions()
            .lock()
            .map_err(|_| "Fable could not access MCP sessions.".to_string())?;
        let session = sessions
            .get(&proposal.session_id)
            .ok_or_else(|| "This MCP session is unavailable.".to_string())?;
        require_remote_session_owner(session, &scope)?;
        if !session.initialized {
            return Err("Remote MCP execution requires an initialized session.".into());
        }
        require_current_session_discovery(session.discovery_current)?;
        (
            session.connection_id.clone(),
            session.connection_revision,
            "streamable-http".into(),
        )
    };
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .with_conn(|tx| {
            crate::store::repos::connection_record::require_enabled_mcp_tool(
                tx,
                store,
                &scope,
                &connection_id,
                connection_revision,
                &proposal.tool_name,
            )
        })
        .map_err(|error| error.to_string())?;
    let arguments = serde_json::to_vec(&proposal.arguments)
        .map_err(|_| "The MCP tool arguments are invalid.".to_string())?;
    let arguments_fingerprint = format!("{:x}", Sha256::digest(&arguments));
    let proposal_value = serde_json::json!({
        "sessionId": proposal.session_id,
        "connectionId": connection_id,
        "connectionRevision": connection_revision,
        "transport": transport,
        "toolName": proposal.tool_name,
        "argumentsFingerprint": arguments_fingerprint
    });
    let proposal_fingerprint = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&proposal_value)
                .map_err(|_| "The MCP tool proposal is invalid.".to_string())?
        )
    );
    Ok(ToolProposalContext {
        connection_id,
        connection_revision,
        transport,
        arguments_fingerprint,
        proposal_fingerprint,
    })
}

fn require_current_session_discovery(discovery_current: bool) -> Result<(), String> {
    if !discovery_current {
        return Err("MCP tools must be rediscovered in this session before execution.".into());
    }
    Ok(())
}

fn discovery_request_id(value: &Value) -> Option<String> {
    if value.is_string() || value.as_i64().is_some() || value.as_u64().is_some() {
        serde_json::to_string(value).ok()
    } else {
        None
    }
}

fn discovery_collection_mut(
    proof: &mut DiscoveryProof,
    kind: DiscoveryKind,
) -> &mut DiscoveryCollection {
    match kind {
        DiscoveryKind::Tools => &mut proof.tools,
        DiscoveryKind::Resources => &mut proof.resources,
    }
}

fn register_discovery_request(
    session_id: &str,
    frame: &str,
    initialized: bool,
) -> Result<(), String> {
    let Value::Object(object) = serde_json::from_str::<Value>(frame)
        .map_err(|_| "The MCP discovery request is invalid.".to_string())?
    else {
        return Err("The MCP discovery request is invalid.".into());
    };
    let method = object.get("method").and_then(Value::as_str);
    if method == Some("initialize") {
        if initialized {
            return Err("This MCP session is already initialized.".into());
        }
        let id = object
            .get("id")
            .and_then(discovery_request_id)
            .ok_or_else(|| "MCP initialization requires a request id.".to_string())?;
        let mut proofs = discovery_proofs()
            .lock()
            .map_err(|_| "Fable could not verify MCP initialization.".to_string())?;
        let proof = proofs.entry(session_id.to_string()).or_default();
        if proof.initializing.is_some() {
            return Err("MCP initialization is already pending.".into());
        }
        *proof = DiscoveryProof {
            initializing: Some(id),
            ..DiscoveryProof::default()
        };
        return Ok(());
    }
    let kind = match method {
        Some("tools/list") => DiscoveryKind::Tools,
        Some("resources/list") => DiscoveryKind::Resources,
        _ => return Ok(()),
    };
    if !initialized {
        return Err("MCP discovery requires successful initialization.".into());
    }
    let id = object
        .get("id")
        .and_then(discovery_request_id)
        .ok_or_else(|| "MCP discovery requires a request id.".to_string())?;
    let cursor = match object.get("params") {
        None | Some(Value::Null) => None,
        Some(Value::Object(params)) => match params.get("cursor") {
            None => None,
            Some(Value::String(cursor))
                if !cursor.is_empty()
                    && cursor.len() <= 2_048
                    && !cursor.chars().any(char::is_control) =>
            {
                Some(cursor.clone())
            }
            _ => return Err("The MCP discovery cursor is invalid.".into()),
        },
        _ => return Err("The MCP discovery parameters are invalid.".into()),
    };
    let mut proofs = discovery_proofs()
        .lock()
        .map_err(|_| "Fable could not verify MCP discovery.".to_string())?;
    let proof = proofs.entry(session_id.to_string()).or_default();
    if proof.pending.values().any(|pending| *pending == kind) {
        return Err("MCP discovery already has a pending page.".into());
    }
    let collection = discovery_collection_mut(proof, kind);
    if let Some(cursor) = cursor {
        if collection.expected_cursor.as_deref() != Some(cursor.as_str()) {
            return Err("The MCP discovery cursor does not match the server response.".into());
        }
        collection.expected_cursor = None;
    } else {
        *collection = DiscoveryCollection::default();
    }
    proof.pending.insert(id, kind);
    Ok(())
}

fn normalize_discovery_proof_values(
    values: impl IntoIterator<Item = String>,
    max_chars: usize,
) -> Result<Vec<String>, String> {
    let mut normalized = Vec::new();
    for value in values {
        let value = value.trim();
        if value.is_empty()
            || value.chars().count() > max_chars
            || value.chars().any(char::is_control)
        {
            return Err("MCP discovery returned an invalid value.".into());
        }
        normalized.push(value.to_string());
        if normalized.len() > 256 {
            return Err("MCP discovery exceeded the supported limit.".into());
        }
    }
    normalized.sort();
    normalized.dedup();
    Ok(normalized)
}

fn mark_discovery_changed(session_id: &str) {
    if let Ok(mut sessions) = remote_sessions().lock() {
        if let Some(session) = sessions.get_mut(session_id) {
            session.discovery_current = false;
        }
    }
    if let Ok(mut processes) = process_map().lock() {
        if let Some(process) = processes.get_mut(session_id) {
            process.discovery_current = false;
        }
    }
    if let Ok(mut proofs) = discovery_proofs().lock() {
        proofs.remove(session_id);
    }
}

fn set_session_initialized(session_id: &str, initialized: bool) {
    if let Ok(mut sessions) = remote_sessions().lock() {
        if let Some(session) = sessions.get_mut(session_id) {
            session.initialized = initialized;
            if !initialized {
                session.discovery_current = false;
            }
        }
    }
    if let Ok(mut processes) = process_map().lock() {
        if let Some(process) = processes.get_mut(session_id) {
            process.initialized = initialized;
            if !initialized {
                process.discovery_current = false;
            }
        }
    }
}

fn successful_initialize_response(object: &serde_json::Map<String, Value>, id: &str) -> bool {
    fn valid_identity_field(value: Option<&Value>) -> bool {
        value.and_then(Value::as_str).is_some_and(|value| {
            !value.is_empty()
                && value.chars().count() <= 256
                && !value.chars().any(char::is_control)
        })
    }
    if object.get("id").and_then(discovery_request_id).as_deref() != Some(id)
        || object.contains_key("error")
    {
        return false;
    }
    let Some(result) = object.get("result").and_then(Value::as_object) else {
        return false;
    };
    let Some(server_info) = result.get("serverInfo").and_then(Value::as_object) else {
        return false;
    };
    result.get("protocolVersion").and_then(Value::as_str) == Some(MCP_PROTOCOL_VERSION)
        && result.get("capabilities").is_some_and(Value::is_object)
        && valid_identity_field(server_info.get("name"))
        && valid_identity_field(server_info.get("version"))
}

fn observe_discovery_frame(session_id: &str, frame: &str) {
    let Ok(Value::Object(object)) = serde_json::from_str::<Value>(frame) else {
        return;
    };
    if let Some(
        method @ ("notifications/tools/list_changed" | "notifications/resources/list_changed"),
    ) = object.get("method").and_then(Value::as_str)
    {
        mark_discovery_changed(session_id);
        let _ = observe_discovery_change(session_id, method);
        return;
    }
    let Some(id) = object.get("id").and_then(discovery_request_id) else {
        return;
    };
    let initialization = discovery_proofs().lock().ok().and_then(|mut proofs| {
        let proof = proofs.get_mut(session_id)?;
        if proof.initializing.as_deref() != Some(id.as_str()) {
            return None;
        }
        proof.initializing = None;
        Some(successful_initialize_response(&object, &id))
    });
    if let Some(initialized) = initialization {
        set_session_initialized(session_id, initialized);
        if !initialized {
            mark_discovery_changed(session_id);
        }
        return;
    }
    let Ok(mut proofs) = discovery_proofs().lock() else {
        return;
    };
    let Some(proof) = proofs.get_mut(session_id) else {
        return;
    };
    let Some(kind) = proof.pending.remove(&id) else {
        return;
    };
    let collection = discovery_collection_mut(proof, kind);
    if object.contains_key("error") {
        *collection = DiscoveryCollection::default();
        return;
    }
    let key = match kind {
        DiscoveryKind::Tools => "tools",
        DiscoveryKind::Resources => "resources",
    };
    let value_key = match kind {
        DiscoveryKind::Tools => "name",
        DiscoveryKind::Resources => "uri",
    };
    let max_chars = match kind {
        DiscoveryKind::Tools => 256,
        DiscoveryKind::Resources => 2_048,
    };
    let parsed = (|| {
        let result = object.get("result")?.as_object()?;
        let page = result.get(key)?.as_array()?;
        let values = page
            .iter()
            .map(|item| {
                item.as_object()?
                    .get(value_key)?
                    .as_str()
                    .map(str::to_string)
            })
            .collect::<Option<Vec<_>>>()?;
        let next_cursor = match result.get("nextCursor") {
            None => None,
            Some(Value::String(cursor))
                if !cursor.is_empty()
                    && cursor.len() <= 2_048
                    && !cursor.chars().any(char::is_control) =>
            {
                Some(cursor.clone())
            }
            _ => return None,
        };
        Some((values, next_cursor))
    })();
    let Some((values, next_cursor)) = parsed else {
        *collection = DiscoveryCollection::default();
        return;
    };
    collection.values.extend(values);
    let Ok(values) = normalize_discovery_proof_values(collection.values.drain(..), max_chars)
    else {
        *collection = DiscoveryCollection::default();
        return;
    };
    collection.values = values;
    collection.expected_cursor = next_cursor;
    collection.complete = collection.expected_cursor.is_none();
}

fn observe_discovery_change(session_id: &str, method: &str) -> Result<usize, String> {
    let change = match method {
        "notifications/tools/list_changed" => "tools",
        "notifications/resources/list_changed" => "resources",
        _ => return Err("The MCP discovery change event is unsupported.".into()),
    };
    let local = process_map()
        .lock()
        .map_err(|_| "Fable could not access MCP sessions.".to_string())?
        .get(session_id)
        .map(|process| {
            (
                process.workspace_id.clone(),
                process.owner_subject.clone(),
                process.connection_id.clone(),
                "stdio",
            )
        });
    let (workspace_id, owner_subject, connection_id, transport) = if let Some(local) = local {
        local
    } else {
        remote_sessions()
            .lock()
            .map_err(|_| "Fable could not access remote MCP sessions.".to_string())?
            .get(session_id)
            .map(|session| {
                (
                    session.workspace_id.clone(),
                    session.owner_subject.clone(),
                    session.connection_id.clone(),
                    "remote",
                )
            })
            .ok_or_else(|| "This MCP session is unavailable.".to_string())?
    };
    let scope = crate::authorized_scope::command_scope(
        Some(workspace_id),
        None,
        crate::authorized_scope::ScopeAccess::Read,
    )?;
    if scope.private.owner_subject() != owner_subject {
        return Err("This MCP session belongs to another private owner.".into());
    }
    crate::action_history::Recorder::new(
        crate::store::repos::action_history::category::CONNECTOR_ACTION,
        "MCP",
        change,
        "observed",
    )
    .actor(scope.private.owner_subject())
    .correlation(session_id)
    .summary(&format!(
        "Observed {change} discovery change for {transport} connection {connection_id}"
    ))
    .record();
    Ok(0)
}

fn verify_discovery_proof(
    session_id: &str,
    tools: &[String],
    resources: &[String],
) -> Result<(), String> {
    let tools = normalize_discovery_proof_values(tools.iter().cloned(), 256)?;
    let resources = normalize_discovery_proof_values(resources.iter().cloned(), 2_048)?;
    let proofs = discovery_proofs()
        .lock()
        .map_err(|_| "Fable could not verify MCP discovery.".to_string())?;
    if !discovery_proof_matches(proofs.get(session_id), &tools, &resources) {
        return Err("MCP discovery does not match the live server response.".into());
    }
    Ok(())
}

fn discovery_proof_matches(
    proof: Option<&DiscoveryProof>,
    tools: &[String],
    resources: &[String],
) -> bool {
    if !tools.is_empty()
        && !proof.is_some_and(|proof| proof.tools.complete && proof.tools.values == tools)
    {
        return false;
    }
    if !resources.is_empty()
        && !proof
            .is_some_and(|proof| proof.resources.complete && proof.resources.values == resources)
    {
        return false;
    }
    true
}

fn commit_session_discovery_authority(
    session_id: &str,
    connection_id: &str,
    expected_revision: i64,
    recorded_revision: i64,
    tools: &[String],
    resources: &[String],
) -> Result<(), String> {
    let tools = normalize_discovery_proof_values(tools.iter().cloned(), 256)?;
    let resources = normalize_discovery_proof_values(resources.iter().cloned(), 2_048)?;
    // This lock order matches discovery invalidation. Holding the proof lock
    // through the session update prevents a concurrent list-changed event from
    // being overwritten by a late discovery transaction.
    let mut remote = remote_sessions()
        .lock()
        .map_err(|_| "Fable could not access remote MCP sessions.".to_string())?;
    let mut local = process_map()
        .lock()
        .map_err(|_| "Fable could not access local MCP sessions.".to_string())?;
    let proofs = discovery_proofs()
        .lock()
        .map_err(|_| "Fable could not verify MCP discovery.".to_string())?;
    if !discovery_proof_matches(proofs.get(session_id), &tools, &resources) {
        return Err("MCP discovery changed before it could be committed.".into());
    }
    if let Some(process) = local.get_mut(session_id) {
        if process.connection_id != connection_id
            || process.connection_revision != expected_revision
        {
            return Err("The local MCP session changed during discovery.".into());
        }
        process.connection_revision = recorded_revision;
        process.discovery_current = true;
        return Ok(());
    }
    let session = remote
        .get_mut(session_id)
        .ok_or_else(|| "This MCP session closed during discovery.".to_string())?;
    if session.connection_id != connection_id || session.connection_revision != expected_revision {
        return Err("The remote MCP session changed during discovery.".into());
    }
    session.connection_revision = recorded_revision;
    session.discovery_current = true;
    Ok(())
}

fn approval_for_tool_proposal(
    proposal: &McpToolProposal,
    fingerprint: &str,
    id: String,
    requested_at: String,
) -> crate::models::ApprovalRequest {
    let (argument_fields, external_destinations) = safe_mcp_argument_preview(&proposal.arguments);
    let mut data_used = vec![format!("proposal fingerprint: {fingerprint}")];
    if !argument_fields.is_empty() {
        data_used.push(format!("argument fields: {}", argument_fields.join(", ")));
    }
    if !external_destinations.is_empty() {
        data_used.push(format!(
            "external destinations: {}",
            external_destinations.join(", ")
        ));
    }
    crate::models::ApprovalRequest {
        id,
        service: "MCP tools".into(),
        action: format!("run MCP tool {}", proposal.tool_name),
        mode: "full-access".into(),
        risk_level: "critical".into(),
        data_used,
        consequence: "Runs an enabled tool in a user-managed MCP server.".into(),
        requested_at,
        decisions: vec!["once".into(), "deny".into()],
        confirmation_phrase: Some(format!("run {}", proposal.tool_name)),
    }
}

fn safe_mcp_argument_preview(value: &Value) -> (Vec<String>, Vec<String>) {
    const MAX_PREVIEW_ITEMS: usize = 16;

    fn safe_key_segment(value: &str) -> bool {
        !value.is_empty()
            && value.len() <= 64
            && value
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || "_-".contains(character))
    }

    fn walk(value: &Value, path: &str, fields: &mut Vec<String>, destinations: &mut Vec<String>) {
        if fields.len() >= MAX_PREVIEW_ITEMS && destinations.len() >= MAX_PREVIEW_ITEMS {
            return;
        }
        match value {
            Value::Object(object) => {
                for (key, child) in object.iter().take(MAX_PREVIEW_ITEMS) {
                    if !safe_key_segment(key) {
                        continue;
                    }
                    let child_path = if path.is_empty() {
                        key.clone()
                    } else {
                        format!("{path}.{key}")
                    };
                    if fields.len() < MAX_PREVIEW_ITEMS {
                        fields.push(child_path.clone());
                    }
                    walk(child, &child_path, fields, destinations);
                }
            }
            Value::Array(values) => {
                for child in values.iter().take(MAX_PREVIEW_ITEMS) {
                    walk(child, path, fields, destinations);
                }
            }
            Value::String(text) if destinations.len() < MAX_PREVIEW_ITEMS => {
                if let Ok(url) = Url::parse(text) {
                    if matches!(url.scheme(), "http" | "https")
                        && url.username().is_empty()
                        && url.password().is_none()
                    {
                        destinations.push(url.origin().ascii_serialization());
                    }
                }
            }
            _ => {}
        }
    }

    let mut fields = Vec::new();
    let mut destinations = Vec::new();
    walk(value, "", &mut fields, &mut destinations);
    fields.sort();
    fields.dedup();
    destinations.sort();
    destinations.dedup();
    (fields, destinations)
}

fn validate_mcp_tool_name(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_.".contains(character))
    {
        return Err("The MCP tool name is invalid.".into());
    }
    Ok(())
}

fn validate_mcp_arguments(value: &Value) -> Result<(), String> {
    if !value.is_object() {
        return Err("MCP tool arguments must be a JSON object.".into());
    }
    let encoded =
        serde_json::to_vec(value).map_err(|_| "The MCP tool arguments are invalid.".to_string())?;
    if encoded.len() > 1024 * 1024 {
        return Err("MCP tool arguments exceed the supported size.".into());
    }
    fn walk(value: &Value, depth: usize, nodes: &mut usize) -> Result<(), String> {
        *nodes += 1;
        if depth > 20 || *nodes > 10_000 {
            return Err("MCP tool arguments are too deeply nested or complex.".into());
        }
        match value {
            Value::Object(object) => {
                for (key, child) in object {
                    let lower = key.to_ascii_lowercase();
                    if [
                        "authorization",
                        "apikey",
                        "api_key",
                        "password",
                        "secret",
                        "token",
                    ]
                    .iter()
                    .any(|marker| lower.contains(marker))
                    {
                        return Err("Credentials cannot be passed in MCP tool arguments.".into());
                    }
                    walk(child, depth + 1, nodes)?;
                }
            }
            Value::Array(values) => {
                for child in values {
                    walk(child, depth + 1, nodes)?;
                }
            }
            Value::String(text) => {
                if let Ok(url) = Url::parse(text) {
                    if matches!(url.scheme(), "http" | "https")
                        && (!url.username().is_empty() || url.password().is_some())
                    {
                        return Err(
                            "URL credentials cannot be passed in MCP tool arguments.".into()
                        );
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }
    let mut nodes = 0;
    walk(value, 0, &mut nodes)
}

fn valid_request_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_:".contains(character))
}

fn pending_audit_key(session_id: &str, request_id: &str) -> String {
    format!("{session_id}:{request_id}")
}

fn is_mcp_response_for(frame: &str, request_id: &str) -> bool {
    let Ok(Value::Object(object)) = serde_json::from_str::<Value>(frame) else {
        return false;
    };
    !object.contains_key("method")
        && object.get("id").and_then(Value::as_str) == Some(request_id)
        && (object.contains_key("result") ^ object.contains_key("error"))
}

fn audit_mcp_response(session_id: &str, frame: &str) {
    let Ok(Value::Object(object)) = serde_json::from_str::<Value>(frame) else {
        return;
    };
    if object.contains_key("method") {
        return;
    }
    let Some(request_id) = object.get("id").and_then(Value::as_str) else {
        return;
    };
    let key = pending_audit_key(session_id, request_id);
    let pending = pending_audits()
        .lock()
        .ok()
        .and_then(|mut audits| audits.remove(&key));
    let Some(pending) = pending else {
        return;
    };
    let failed = object.contains_key("error");
    record_mcp_audit(
        pending,
        request_id,
        failed,
        if failed { "mcp-tool-error" } else { "" },
    );
}

fn record_mcp_audit(pending: PendingMcpAudit, request_id: &str, failed: bool, error_code: &str) {
    let mut recorder = crate::action_history::Recorder::new(
        crate::store::repos::action_history::category::TOOL_ACTION,
        "MCP",
        &pending.tool_name,
        if failed { "failed" } else { "completed" },
    )
    .actor(&pending.actor)
    .risk("critical")
    .mode("full-access")
    .correlation(request_id)
    .summary(if failed {
        "Approved MCP tool call failed."
    } else {
        "Approved MCP tool call completed."
    })
    .detail(serde_json::json!({ "connectionId": pending.connection_id }));
    if failed {
        recorder = recorder.error(error_code);
    }
    recorder.record();
}

fn fail_pending_mcp_audit(audit_key: &str, request_id: &str, error_code: &str) {
    if let Some(pending) = pending_audits()
        .lock()
        .ok()
        .and_then(|mut audits| audits.remove(audit_key))
    {
        record_mcp_audit(pending, request_id, true, error_code);
    }
}

fn drain_session_audits(session_id: &str) {
    let prefix = format!("{session_id}:");
    let drained = pending_audits()
        .lock()
        .map(|mut audits| {
            let keys = audits
                .keys()
                .filter(|key| key.starts_with(&prefix))
                .cloned()
                .collect::<Vec<_>>();
            keys.into_iter()
                .filter_map(|key| audits.remove(&key).map(|pending| (key, pending)))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for (key, pending) in drained {
        let request_id = key.strip_prefix(&prefix).unwrap_or("unknown");
        record_mcp_audit(pending, request_id, true, "session-closed");
    }
}

const MCP_HTTP_TIMEOUT: Duration = Duration::from_secs(30);
