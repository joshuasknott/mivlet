//! Fable desktop runtime entrypoint.
//!
//! Feature logic lives in focused modules (`models`, `paths`, `approvals`,
//! `knowledge`, `memory`, `snapshot`, `backends`, `scheduler`, `workflows`).
//! This crate root only declares those modules, registers the Tauri command
//! handlers, and starts the in-process scheduler tick.

// Native transaction and execution-boundary functions intentionally keep
// authority, scope, revision, and timing inputs explicit. Collapsing those
// security-relevant facts into broad bags solely to satisfy shape lints would
// make call-site review less precise. Large preflight enum variants likewise
// stay inline because they are short-lived, single-owner boundary values.
#![allow(
    clippy::large_enum_variant,
    clippy::too_many_arguments,
    clippy::type_complexity
)]

mod account_workspace;
mod acp_process;
mod action_history;
mod agent_runs;
mod approvals;
mod artifacts;
mod authorized_scope;
mod backends;
mod capability_grants;
mod capability_registry;
mod clerk_identity;
mod cloud_sync;
mod codex_app_server;
mod collaboration_connectors;
mod connector_api;
mod connector_approvals;
mod connector_auth;
mod connector_cache;
mod connector_sync;
mod connectors;
mod conversations;
mod diagnostics;
mod execution_approvals;
mod execution_control;
mod goals;
mod google;
mod knowledge;
mod local_model;
mod mcp_process;
mod memory;
mod mission_approvals;
mod mission_artifact_revision_brief;
mod mission_continuations;
mod mission_coordination;
mod mission_human_input;
mod mission_parallel_approaches;
mod mission_plans;
mod mission_runs;
mod mission_structured_intake;
mod mission_workers;
mod models;
mod native_api;
mod notifications;
mod oauth_loopback;
pub mod paths;
mod permission_policy;
pub mod portable;
#[cfg(test)]
mod product_spine_parity;
mod projects;
mod remote_control;
mod routines;
mod scheduler;
mod snapshot;
mod store;
pub mod tools;
mod workflows;
mod workspace_directory;

/// reqwest is intentionally built without an implicit rustls provider. Install
/// the audited ring provider before constructing any native HTTP client.
pub(crate) fn ensure_rustls_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod store_tests;

use std::time::Duration;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // Use hardened portable-aware data dir resolution (fail-closed).
            let handle = app.handle().clone();
            let app_data = paths::app_data_dir(&handle)?;
            store::initialize(&app_data)?;
            mission_runs::initialize_recovery_epoch();
            // Load the durable scheduler store once and manage it as process
            // state. The in-process tick leases due entries; because Tauri is
            // a single shared process, the lease map is the cross-window duplicate-
            // execution guard (two windows can never lease the same occurrence).
            // Any entry left leased/running by a prior crash is recovered here.
            let handle = app.handle().clone();
            app.manage(scheduler::SchedulerState(std::sync::Mutex::new(
                std::collections::BTreeMap::new(),
            )));
            // Mobile remote-control trust list. In-memory in this foundation
            // pass; the durable store lands with the transport layer. The
            // command surface is registered below and fails closed until then.
            app.manage(remote_control::initialize_state());
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
                guard.insert(
                    store::repos::scope::DEFAULT_WORKSPACE_ID.to_string(),
                    scheduler::SchedulerState::empty(),
                );
            }
            if let Err(error) = workflows::recover_stale_runs(&handle) {
                eprintln!("workflow recovery failed: {error}");
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
            conversations::conversation_create_thread,
            conversations::conversation_list_threads,
            conversations::conversation_get_thread,
            conversations::conversation_update_thread,
            conversations::conversation_list_messages,
            conversations::conversation_append_message,
            conversations::conversation_revise_message,
            conversations::conversation_load_draft,
            conversations::conversation_save_draft,
            conversations::conversation_delete_draft,
            projects::project_create,
            projects::project_list,
            projects::project_get,
            projects::project_update,
            projects::project_archive,
            projects::project_restore,
            projects::project_delete,
            goals::goal_create,
            goals::goal_list,
            goals::goal_get,
            goals::goal_update,
            goals::goal_achieve,
            goals::goal_archive,
            goals::goal_restore,
            routines::routine_create,
            routines::routine_edit,
            routines::routine_pause,
            routines::routine_resume,
            routines::routine_delete,
            routines::routine_get,
            routines::routine_list,
            routines::routine_connection_options,
            routines::routine_occurrence_append,
            routines::routine_occurrence_history,
            routines::routine_driver_renew,
            routines::routine_driver_report,
            routines::routine_scheduler_status,
            routines::routine_scheduler_begin_shadow,
            routines::routine_scheduler_cutover,
            routines::routine_scheduler_rollback,
            routines::routine_migration_capture,
            routines::routine_migration_apply,
            routines::routine_migration_verify_replay,
            routines::routine_migration_rollback,
            mission_plans::mission_plan_create,
            mission_plans::mission_plan_get,
            mission_plans::mission_plan_cited_summary_get,
            mission_plans::mission_plan_cited_summaries_read,
            mission_plans::mission_plan_revise,
            mission_runs::mission_run_create,
            mission_runs::mission_run_get,
            mission_runs::mission_run_request_cancellation,
            mission_runs::mission_run_finalize_cancellation,
            mission_runs::mission_run_recover_interrupted_cited,
            mission_runs::mission_run_recover_interrupted_general,
            mission_runs::mission_run_prepare_cited_retry,
            mission_runs::mission_run_create_checkpoint,
            mission_runs::mission_run_restore_checkpoint,
            mission_coordination::mission_coordination_join_open,
            mission_coordination::mission_coordination_join_resolve,
            mission_coordination::mission_coordination_aggregation_record,
            mission_coordination::mission_coordination_progress_read,
            mission_coordination::mission_coordination_progress_list,
            mission_coordination::mission_coordination_human_evaluation_record,
            mission_coordination::mission_coordination_prepare_workers,
            mission_coordination::mission_coordination_worker_objective,
            mission_coordination::mission_coordination_advance,
            mission_coordination::mission_coordination_finalize,
            mission_approvals::mission_approval_request,
            mission_approvals::mission_approval_pending_list,
            mission_approvals::mission_approval_resolve,
            mission_human_input::mission_human_input_request,
            mission_human_input::mission_human_input_pending_list,
            mission_human_input::mission_human_input_receive,
            mission_parallel_approaches::mission_parallel_approaches_join_open,
            mission_parallel_approaches::mission_parallel_approaches_finalize,
            mission_parallel_approaches::mission_parallel_approaches_recover_completed,
            mission_parallel_approaches::mission_parallel_approaches_reviewer_prepare,
            mission_parallel_approaches::mission_parallel_approaches_reviewer_recover,
            mission_structured_intake::mission_structured_intake_start,
            mission_artifact_revision_brief::mission_artifact_revision_brief_start,
            mission_workers::mission_worker_create,
            mission_workers::mission_worker_start,
            mission_workers::mission_worker_output_read,
            mission_workers::mission_worker_cited_receipts_read,
            mission_workers::mission_cited_approval_pending_list,
            mission_workers::mission_cited_approval_resolve,
            artifacts::artifact_create_from_response,
            artifacts::artifact_append_version,
            artifacts::artifact_review_action,
            artifacts::artifact_get,
            artifacts::artifact_list_for_thread,
            artifacts::artifact_search,
            artifacts::artifact_export,
            artifacts::artifact_handoff_propose,
            artifacts::artifact_handoff_accept,
            knowledge::import_local_text_file,
            knowledge::search_knowledge_sources,
            approvals::list_approval_audit,
            approvals::list_approval_rules,
            approvals::record_approval_decision,
            approvals::resolve_approval_request,
            action_history::record_action_history,
            action_history::list_action_history,
            snapshot::list_imported_knowledge_sources,
            snapshot::save_imported_knowledge_sources,
            snapshot::import_local_knowledge_source,
            snapshot::refresh_local_knowledge_source,
            memory::list_memory_state,
            memory::save_memory_state,
            memory::export_memory_state,
            memory::promote_knowledge_source_to_memory,
            snapshot::load_runtime_snapshot,
            snapshot::save_runtime_snapshot,
            backends::list_backends,
            backends::list_native_provider_routes,
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
            connector_sync::list_connector_sync_states,
            connector_sync::sync_connector,
            connector_sync::cancel_connector_sync,
            connectors::search_connector,
            connectors::read_connector_capability,
            connectors::import_connector_item,
            connectors::list_connector_knowledge_sources,
            connectors::set_connector_knowledge_source_disabled,
            connectors::delete_connector_knowledge_source,
            connectors::prepare_connector_action,
            connectors::execute_approved_connector_action,
            connector_cache::list_connector_cache,
            connector_cache::search_connector_cache,
            connector_cache::cache_connector_item,
            connector_cache::set_connector_cache_item_disabled,
            connector_cache::delete_connector_cache_item,
            connector_cache::clear_connector_cache,
            connector_cache::resync_connector_cache,
            connector_cache::export_connector_cache,
            connector_cache::get_connector_cache_settings,
            connector_cache::set_connector_cache_settings,
            connector_cache::delete_connector_cache_settings,
            native_api::stream_backend_completion,
            native_api::cancel_backend_completion,
            native_api::list_backend_models,
            native_api::verify_backend_credential,
            local_model::detect_local_model_runtime,
            local_model::list_local_model_models,
            local_model::stream_local_model_completion,
            local_model::cancel_local_model_completion,
            clerk_identity::identity_status,
            clerk_identity::identity_begin_sign_in,
            clerk_identity::identity_begin_recovery,
            clerk_identity::identity_refresh,
            clerk_identity::identity_sign_out,
            account_workspace::account_workspace_status,
            account_workspace::account_workspace_reconcile,
            account_workspace::account_membership_pending_invitations,
            account_workspace::account_membership_accept_invitation,
            account_workspace::account_workspace_members,
            account_workspace::account_workspace_member_change,
            account_workspace::account_workspace_invitation_create,
            account_workspace::account_workspace_create,
            account_workspace::account_workspace_select,
            account_workspace::account_device_revoke,
            account_workspace::account_workspace_clear_session,
            cloud_sync::cloud_sync_status,
            cloud_sync::cloud_sync_link_state,
            cloud_sync::cloud_sync_enqueue_shared_mutation,
            cloud_sync::cloud_sync_flush_outbox,
            cloud_sync::cloud_sync_pull_after_cursor,
            workspace_directory::list_workspace_directory,
            workspace_directory::select_active_workspace,
            acp_process::spawn_acp_process,
            acp_process::write_acp_frame,
            acp_process::close_acp_process,
            acp_process::detect_acp_cli,
            mcp_process::spawn_mcp_process,
            mcp_process::write_mcp_frame,
            mcp_process::close_mcp_process,
            mcp_process::prepare_mcp_server_configuration,
            mcp_process::commit_mcp_server_configuration,
            mcp_process::list_mcp_server_configurations,
            mcp_process::open_remote_mcp_session,
            mcp_process::inspect_remote_mcp_authorization,
            mcp_process::begin_remote_mcp_authorization,
            mcp_process::disconnect_remote_mcp_authorization,
            mcp_process::send_remote_mcp_frame,
            mcp_process::poll_remote_mcp_messages,
            mcp_process::close_remote_mcp_session,
            mcp_process::record_mcp_server_discovery,
            mcp_process::set_mcp_server_enablement,
            mcp_process::resolve_mcp_capability_route,
            mcp_process::prepare_mcp_tool_call,
            mcp_process::authorize_mcp_tool_call,
            mcp_process::execute_approved_mcp_tool_call,
            mcp_process::attest_mission_mcp_connected_search,
            capability_grants::prepare_capability_grant,
            capability_grants::commit_capability_grant,
            capability_grants::list_capability_grants,
            capability_grants::revoke_capability_grant,
            google::cancel_google_call,
            tools::execute_tool_call,
            store::encrypted_store_status,
            store::export_local_data,
            store::backup_local_data,
            store::prepare_local_data_restore,
            store::delete_local_data,
            diagnostics::local_diagnostics,
            execution_control::execution_control_get,
            execution_control::execution_control_pause,
            execution_control::execution_control_resume,
            portable::export_workspace_archive_to_file,
            portable::export_project_archive_to_file,
            portable::import_workspace_archive_from_file,
            portable::portable_format_version,
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
            notifications::deliver_notification,
            remote_control::remote_control_disable,
            remote_control::remote_control_enable,
            remote_control::remote_control_status,
            remote_control::remote_list_devices,
            remote_control::remote_pairing_start,
            remote_control::remote_pairing_status,
            remote_control::remote_revoke_device,
            remote_control::remote_handle_command
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Fable desktop runtime");
}
