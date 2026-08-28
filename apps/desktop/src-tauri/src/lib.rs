//! Fable desktop runtime entrypoint.
//!
//! The native shell owns local encrypted storage, provider and connector
//! boundaries, approvals, conversations, and optional local or hosted
//! computers. Product orchestration lives nowhere in this crate.

#![allow(
    clippy::large_enum_variant,
    clippy::too_many_arguments,
    clippy::type_complexity
)]

mod account_workspace;
mod acp_process;
mod action_history;
mod approvals;
mod authorized_scope;
mod backends;
mod capability_grants;
mod capability_registry;
mod clerk_identity;
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
mod execution_attempts;
mod execution_control;
mod google;
mod hosted_computer;
mod knowledge;
mod local_computer;
mod mcp_process;
mod memory;
mod models;
mod native_api;
mod oauth_loopback;
pub mod paths;
mod permission_policy;
#[cfg(test)]
mod product_spine_parity;
mod snapshot;
mod store;
pub mod tools;
mod workspace_directory;

/// reqwest is intentionally built without an implicit rustls provider. Install
/// the audited ring provider before constructing any native HTTP client.
pub(crate) fn ensure_rustls_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let app_data = paths::app_data_dir(&handle)?;
            store::initialize(&app_data)?;
            app.manage(std::sync::Arc::new(
                local_computer::LocalComputerState::initialize(&handle)?,
            ));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            snapshot::runtime_status,
            execution_attempts::save_execution_attempt,
            execution_attempts::list_execution_attempts,
            execution_attempts::recover_interrupted_execution_attempts,
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
            codex_app_server::start_codex_browser_login,
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
            local_computer::local_computer_status,
            local_computer::local_computer_provision,
            local_computer::local_computer_files,
            local_computer::local_computer_file_preview,
            local_computer::local_browser_navigate,
            local_computer::local_browser_snapshot,
            local_computer::local_computer_set_controller,
            local_computer::local_browser_pointer,
            local_computer::local_browser_key,
            local_computer::local_browser_history,
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
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Fable desktop runtime");
}
