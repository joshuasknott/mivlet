//! Fable desktop runtime entrypoint.
//!
//! Feature logic lives in focused modules (`models`, `paths`, `approvals`,
//! `knowledge`, `memory`, `snapshot`, `backends`, `scheduler`, `workflows`).
//! This crate root only declares those modules, registers the Tauri command
//! handlers, and starts the in-process scheduler tick.

mod acp_process;
mod agent_runs;
mod approvals;
mod backends;
mod codex_app_server;
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
mod notifications;
mod oauth_loopback;
mod paths;
mod scheduler;
mod snapshot;
mod store;
mod tools;
mod workflows;

/// reqwest is intentionally built without an implicit rustls provider. Install
/// the audited ring provider before constructing any native HTTP client.
pub(crate) fn ensure_rustls_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

#[cfg(test)]
mod tests;

use std::time::Duration;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let app_data = app
                .path()
                .app_data_dir()
                .map_err(|_| "Fable could not resolve the app data folder.")?;
            store::initialize(&app_data)?;
            // Load the durable scheduler store once and manage it as process
            // state. The in-process tick leases due entries; because Tauri is
            // a single shared process, the lease map is the cross-window duplicate-
            // execution guard (two windows can never lease the same occurrence).
            // Any entry left leased/running by a prior crash is recovered here.
            let handle = app.handle().clone();
            app.manage(scheduler::SchedulerState(std::sync::Mutex::new(None)));
            if let Err(error) = scheduler::initialize_store(&handle) {
                // Fall back to an empty store so the app still starts; the error
                // is surfaced via the read commands' own error paths.
                eprintln!("scheduler initialize failed: {error}");
                let mut guard = app
                    .state::<scheduler::SchedulerState>()
                    .inner()
                    .0
                    .lock()
                    .expect("scheduler lock");
                *guard = Some(scheduler::SchedulerState::empty());
            }

            // In-process scheduler tick. Stops when the app exits. An
            // interrupted tick only ever leaves entries leased until their short
            // deadline; the next tick re-queues expired leases (crash-safe).
            let tick_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    let _ = scheduler::run_tick(&tick_handle);
                    tokio::time::sleep(Duration::from_secs(models::SCHEDULER_TICK_SECS)).await;
                }
            });
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
            codex_app_server::codex_cli_status,
            codex_app_server::start_codex_app_server_turn,
            codex_app_server::respond_codex_app_server_approval,
            codex_app_server::interrupt_codex_app_server_turn,
            codex_app_server::shutdown_codex_app_server_turn,
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
            native_api::list_backend_models,
            native_api::verify_backend_credential,
            acp_process::spawn_acp_process,
            acp_process::write_acp_frame,
            acp_process::close_acp_process,
            acp_process::detect_acp_cli,
            google::cancel_google_call,
            tools::execute_tool_call,
            store::encrypted_store_status,
            store::export_local_data,
            store::backup_local_data,
            store::delete_local_data,
            scheduler::list_scheduler_jobs,
            scheduler::list_scheduler_queue,
            scheduler::save_scheduled_job,
            scheduler::delete_scheduled_job,
            scheduler::set_job_status,
            scheduler::enqueue_job_run,
            scheduler::report_job_attempt,
            scheduler::renew_job_lease,
            scheduler::requeue_blocked_job_run,
            scheduler::cancel_job_run,
            workflows::save_workflow_run,
            workflows::save_workflow_definition,
            workflows::list_workflow_definitions,
            workflows::list_workflow_runs,
            workflows::list_workflow_runs_for_definition,
            notifications::deliver_notification
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Fable desktop runtime");
}
