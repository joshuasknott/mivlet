//! Mivlet desktop runtime entrypoint.
//!
//! The native shell owns local encrypted storage, provider and connector
//! boundaries, approvals, conversations, and optional local or hosted
//! computers, and durable coordination authority.

#![allow(
    clippy::large_enum_variant,
    clippy::too_many_arguments,
    clippy::type_complexity
)]

mod account_session;
mod account_workspace;
mod action_history;
mod antigravity_acp;
mod approvals;
mod authorized_scope;
mod backends;
mod capability_grants;
mod capability_registry;
mod clerk_identity;
mod codex_app_server;
mod collaboration;
mod collaboration_connectors;
mod connector_api;
mod connector_approvals;
mod connector_auth;
mod connector_cache;
#[cfg(debug_assertions)]
mod connector_check;
mod connector_sync;
mod connectors;
mod context_summaries;
mod conversation_links;
mod conversations;
mod diagnostics;
mod embedded_agent;
mod embedded_mcp;
mod execution_approvals;
mod execution_attempts;
mod execution_control;
mod google;
mod hosted_computer;
mod knowledge;
mod local_computer;
mod local_projects;
mod local_schedules;
mod managed_runtime;
mod mcp_process;
mod media_images;
mod memory;
mod models;
mod native_api;
mod native_speech;
mod oauth_loopback;
pub mod paths;
mod permission_policy;
#[cfg(test)]
mod product_spine_parity;
mod provider_process;
mod search;
mod snapshot;
mod store;
mod token_plugins;
pub mod tools;
mod window_controls;

/// reqwest is intentionally built without an implicit rustls provider. Install
/// the audited ring provider before constructing any native HTTP client.
pub(crate) fn ensure_rustls_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

/// Opens an Antigravity authorization request only after validating the exact
/// Google origin and loopback callback expected by the pinned ACP runtime.
pub fn open_antigravity_browser_helper(raw_url: &str) -> bool {
    antigravity_acp::open_validated_browser_helper(raw_url)
}

/// Developer-only live check; prints status/counts, never credentials or source content.
#[cfg(debug_assertions)]
pub fn check_connectors() {
    connector_check::run();
}

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let handle = app.handle().clone();
            if account_session::initialize(&handle)? {
                let app_data = paths::app_data_dir(&handle)?;
                store::initialize(&app_data)?;
                if let Some(store) = store::try_global() {
                    collaboration::recover(store).map_err(|error| {
                        std::io::Error::other(format!("Coordination recovery failed: {error:?}"))
                    })?;
                }
                // Public OAuth configuration is bundled; developer-provisioned secrets stay in the OS vault.
                let _ = connector_auth::provision_connector_configuration();
                let computers =
                    std::sync::Arc::new(local_computer::LocalComputerState::initialize(&handle)?);
                computers.start_activity();
                app.manage(computers);
                app.manage(local_schedules::LocalScheduleDispatchCoordinator::default());
            }
            account_session::start_watchdog(handle);
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                use std::sync::atomic::{AtomicBool, Ordering};
                static CLOSING: AtomicBool = AtomicBool::new(false);
                api.prevent_close();
                if CLOSING.swap(true, Ordering::AcqRel) {
                    return;
                }
                let app = window.app_handle().clone();
                let computers = app
                    .try_state::<std::sync::Arc<local_computer::LocalComputerState>>()
                    .map(|state| state.inner().clone());
                let _ = window.hide();
                tauri::async_runtime::spawn(async move {
                    codex_app_server::shutdown_all_runs();
                    embedded_agent::shutdown_all();
                    embedded_mcp::shutdown_all();
                    if let Some(computers) = computers {
                        local_computer::shutdown_all(computers).await;
                    }
                    app.exit(0);
                });
            }
        })
        .invoke_handler(account_session::guard(tauri::generate_handler![
            account_session::account_theme,
            local_computer::control::local_app_stop,
            local_computer::artifacts::local_computer_open_artifact,
            local_computer::artifacts::local_computer_preview_artifact,
            conversation_links::open_conversation_link,
            local_computer::local_computer_cancel,
            window_controls::control_main_window,
            snapshot::runtime_status,
            execution_attempts::save_execution_attempt,
            execution_attempts::list_execution_attempts,
            execution_attempts::recover_interrupted_execution_attempts,
            local_schedules::local_schedule_create,
            local_schedules::local_schedule_update,
            local_schedules::local_schedule_set_status,
            local_schedules::local_schedule_list,
            local_schedules::local_schedule_preview,
            local_schedules::local_schedule_occurrence_list,
            local_schedules::local_schedule_dispatch_claim,
            local_schedules::local_schedule_dispatch_bind,
            local_schedules::local_schedule_dispatch_renew,
            local_schedules::local_schedule_dispatch_finish,
            local_schedules::local_schedule_dispatch_abandon,
            local_projects::local_project_create,
            collaboration::collaboration_load,
            collaboration::collaboration_command,
            local_projects::local_project_list,
            local_projects::local_project_update,
            local_projects::local_project_archive,
            local_projects::local_project_run_author_bind,
            local_projects::local_project_run_author_list,
            local_projects::local_project_run_author_get,
            local_projects::local_project_share_add,
            local_projects::local_project_share_remove,
            local_projects::local_project_migrate_group,
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
            conversations::conversation_delete_thread,
            knowledge::import_local_text_file,
            knowledge::search_knowledge_sources,
            search::search_workspace,
            approvals::list_approval_audit,
            approvals::list_approval_rules,
            approvals::resolve_approval_request,
            action_history::record_action_history,
            action_history::list_action_history,
            snapshot::list_imported_knowledge_sources,
            snapshot::save_imported_knowledge_sources,
            snapshot::import_local_knowledge_source,
            snapshot::refresh_local_knowledge_source,
            memory::list_memory_state,
            memory::save_memory_state,
            memory::correct_memory_record,
            memory::change_memory_record_state,
            memory::export_memory_state,
            memory::promote_knowledge_source_to_memory,
            context_summaries::list_context_summaries,
            context_summaries::save_context_summary,
            media_images::media_image_status,
            native_speech::native_speech_prepare_recording,
            native_speech::native_speech_cancel_recording,
            native_speech::native_speech_transcribe_recording,
            snapshot::load_runtime_snapshot,
            snapshot::save_runtime_snapshot,
            backends::list_backends,
            backends::list_native_provider_routes,
            backends::store_backend_credential,
            backends::clear_backend_credential,
            backends::record_backend_event,
            codex_app_server::codex_cli_status,
            codex_app_server::start_codex_browser_login,
            codex_app_server::start_codex_app_server_turn,
            codex_app_server::respond_codex_app_server_approval,
            codex_app_server::interrupt_codex_app_server_turn,
            codex_app_server::shutdown_codex_app_server_turn,
            antigravity_acp::antigravity_status,
            antigravity_acp::install_antigravity_runtime,
            antigravity_acp::start_antigravity_browser_login,
            antigravity_acp::check_antigravity_connection,
            antigravity_acp::list_antigravity_models,
            antigravity_acp::start_antigravity_acp_turn,
            antigravity_acp::respond_antigravity_acp_approval,
            antigravity_acp::interrupt_antigravity_acp_turn,
            antigravity_acp::shutdown_antigravity_acp_turn,
            antigravity_acp::logout_antigravity,
            managed_runtime::managed_runtime_status,
            managed_runtime::check_managed_runtime_connection,
            managed_runtime::start_managed_runtime_login,
            managed_runtime::list_managed_runtime_models,
            managed_runtime::start_managed_runtime_turn,
            managed_runtime::respond_managed_runtime_approval,
            managed_runtime::interrupt_managed_runtime_turn,
            managed_runtime::shutdown_managed_runtime_turn,
            managed_runtime::logout_managed_runtime,
            connectors::list_connector_statuses,
            connector_approvals::list_connector_approval_records,
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
            connectors::connect_token_plugin,
            connectors::import_connector_item,
            connectors::list_connector_knowledge_sources,
            connectors::set_connector_knowledge_source_disabled,
            connectors::delete_connector_knowledge_source,
            connectors::prepare_connector_tool_action,
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
            embedded_agent::start_embedded_agent,
            embedded_agent::reply_embedded_agent,
            embedded_agent::cancel_embedded_agent,
            embedded_mcp::start_embedded_mcp,
            embedded_mcp::send_embedded_mcp,
            embedded_mcp::close_embedded_mcp,
            native_api::cancel_backend_completion,
            native_api::computer::begin_native_computer_session,
            native_api::computer::end_native_computer_session,
            native_api::list_backend_models,
            native_api::verify_backend_credential,
            clerk_identity::identity_status,
            clerk_identity::identity_begin_sign_in,
            clerk_identity::identity_begin_recovery,
            clerk_identity::identity_refresh,
            clerk_identity::identity_sign_out,
            account_workspace::account_workspace_status,
            account_workspace::account_workspace_reconcile,
            account_workspace::account_workspace_clear_session,
            hosted_computer::hosted_computer_status,
            hosted_computer::hosted_computer_provision,
            hosted_computer::hosted_process_prepare,
            hosted_computer::hosted_process_launch,
            hosted_computer::hosted_process_status,
            hosted_computer::hosted_process_kill,
            hosted_computer::hosted_browser_prepare,
            hosted_computer::hosted_browser_navigate,
            hosted_computer::hosted_browser_action_prepare,
            hosted_computer::hosted_browser_action,
            hosted_computer::hosted_browser_snapshot,
            local_computer::plugins::builtin_plugins_status,
            local_computer::plugins::builtin_plugin_set,
            local_computer::plugins::builtin_plugin_prepare_computer,
            local_computer::repositories::local_computer_import_repository,
            local_computer::local_computer_status,
            local_computer::local_computer_files,
            local_computer::local_computer_file_preview,
            local_computer::local_computer_stage_attachment,
            local_computer::local_computer_discard_attachment_batch,
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
            mcp_process::list_remote_mcp_connections,
            mcp_process::send_remote_mcp_frame,
            mcp_process::poll_remote_mcp_messages,
            mcp_process::close_remote_mcp_session,
            mcp_process::record_mcp_server_discovery,
            mcp_process::set_mcp_server_enablement,
            mcp_process::resolve_mcp_capability_route,
            mcp_process::prepare_mcp_tool_call,
            mcp_process::authorize_mcp_tool_call,
            mcp_process::execute_approved_mcp_tool_call,
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
            execution_control::execution_control_resume
        ]))
        .run(tauri::generate_context!())
        .expect("failed to run Mivlet desktop runtime");
}
