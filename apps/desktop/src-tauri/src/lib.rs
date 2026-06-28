//! Fable desktop runtime entrypoint.
//!
//! Feature logic lives in focused modules (`models`, `paths`, `approvals`,
//! `knowledge`, `memory`, `snapshot`, `backends`). This crate root only
//! declares those modules and registers the Tauri command handlers on startup.

mod agent_runs;
mod approvals;
mod backends;
mod collaboration_connectors;
mod connector_api;
mod connector_approvals;
mod connector_auth;
mod connectors;
mod execution_approvals;
mod google;
mod knowledge;
mod memory;
mod models;
mod native_api;
mod oauth_loopback;
mod paths;
mod snapshot;
mod store;
mod tools;
use tauri::Manager as _;

/// reqwest is intentionally built without an implicit rustls provider. Install
/// the audited ring provider before constructing any native HTTP client.
pub(crate) fn ensure_rustls_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

#[cfg(test)]
mod tests;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let app_data = app
                .path()
                .app_data_dir()
                .map_err(|_| "Fable could not resolve the app data folder.")?;
            store::initialize(&app_data)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            snapshot::runtime_status,
            agent_runs::save_agent_run,
            agent_runs::list_agent_runs,
            agent_runs::recover_interrupted_agent_runs,
            knowledge::import_local_text_file,
            knowledge::search_knowledge_sources,
            approvals::list_approval_audit,
            approvals::list_approval_rules,
            approvals::record_approval_decision,
            approvals::resolve_approval_request,
            snapshot::list_imported_knowledge_sources,
            snapshot::save_imported_knowledge_sources,
            snapshot::import_local_knowledge_source,
            memory::list_memory_state,
            memory::save_memory_state,
            memory::export_memory_state,
            memory::promote_knowledge_source_to_memory,
            snapshot::load_runtime_snapshot,
            snapshot::save_runtime_snapshot,
            backends::list_backends,
            backends::store_backend_credential,
            backends::clear_backend_credential,
            backends::record_backend_event,
            connectors::list_connector_statuses,
            connector_approvals::list_connector_approval_records,
            connectors::start_connector_auth,
            connectors::complete_connector_auth,
            connectors::begin_connector_oauth,
            connectors::clear_connector_auth,
            connectors::list_connector_accounts,
            connectors::switch_connector_account,
            connectors::refresh_connector_health,
            connectors::search_connector,
            connectors::read_connector_capability,
            connectors::import_connector_item,
            connectors::prepare_connector_action,
            connectors::execute_approved_connector_action,
            native_api::stream_backend_completion,
            native_api::cancel_backend_completion,
            google::cancel_google_call,
            tools::execute_tool_call,
            store::encrypted_store_status,
            store::export_local_data,
            store::backup_local_data,
            store::delete_local_data
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Fable desktop runtime");
}
