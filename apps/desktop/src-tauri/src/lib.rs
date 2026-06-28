//! Fable desktop runtime entrypoint.
//!
//! Feature logic lives in focused modules (`models`, `paths`, `approvals`,
//! `knowledge`, `memory`, `snapshot`, `backends`, `scheduler`, `workflows`).
//! This crate root only declares those modules, registers the Tauri command
//! handlers, and starts the in-process scheduler tick.

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
mod scheduler;
mod snapshot;
mod tools;
mod workflows;

#[cfg(test)]
mod tests;

use std::time::Duration;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Load the durable scheduler store once and manage it as process
            // state. The in-process tick leases due entries; because Tauri is a
            // single shared process, the lease map is the cross-window duplicate-
            // execution guard (two windows can never lease the same occurrence).
            let handle = app.handle().clone();
            let store = scheduler::read_store(&paths::scheduler_store_path(&handle)?)
                .unwrap_or_else(|_| scheduler::SchedulerState::empty());
            app.manage(scheduler::SchedulerState(std::sync::Mutex::new(Some(store))));

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
            connectors::refresh_connector_health,
            connectors::search_connector,
            connectors::read_connector_capability,
            connectors::import_connector_item,
            connectors::prepare_connector_action,
            connectors::execute_approved_connector_action,
            native_api::stream_backend_completion,
            native_api::cancel_backend_completion,
            tools::execute_tool_call,
            scheduler::list_scheduler_jobs,
            scheduler::list_scheduler_queue,
            scheduler::save_scheduled_job,
            scheduler::delete_scheduled_job,
            scheduler::set_job_status,
            scheduler::enqueue_job_run,
            scheduler::report_job_attempt,
            workflows::save_workflow_run,
            workflows::list_workflow_runs,
            workflows::list_workflow_runs_for_definition
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Fable desktop runtime");
}
