//! Native access to the existing Work state machine. No replacement store,
//! provider authority or approval system is introduced here.
use super::*;
use crate::models::ExecutionAttempt;
use crate::store::repos::{execution_attempt, message};
use serde_json::json;

pub(super) fn admit(ctx: &Context<'_>, id: &str) -> Result<()> {
    if !crate::background_worker::enabled_at(ctx.conn, ctx.store)?
        || !crate::background_worker::ready()
    {
        return Ok(());
    }
    let mut item = ctx.item(id)?;
    if eligible(&item, profile(ctx.profiles, &item.agent_id)?) {
        item.execution_owner = Some("native-background".into());
        ctx.work(&item)?;
    }
    Ok(())
}

/// Explicitly bounded initial route: text/research with read-only agents. File,
/// connector, computer, collaboration and attachment routes retain their live
/// renderer owner until their native tool/approval bridge is available.
pub(crate) fn eligible(item: &Work, agent: &MivletAgentProfile) -> bool {
    let route = item
        .model_option_id
        .split_once("::")
        .map(|(provider, _)| provider);
    item.permission_mode == "read-only"
        && item.attachments.is_empty()
        && item.parent_id.is_none()
        && item.project_id.is_none()
        && item.recipient_ids.len() <= 1
        && item.dependencies.is_empty()
        && item.run_ids.is_empty()
        && item.steering.is_empty()
        && item.messages.is_empty()
        && agent.connector_ids.is_empty()
        && agent.knowledge_source_ids.is_empty()
        && route.is_some_and(crate::background_worker::dispatch::supports_provider)
}

fn with_context<T>(
    app: &tauri::AppHandle,
    operation: impl FnOnce(&Context<'_>) -> Result<T>,
) -> std::result::Result<T, String> {
    let store = crate::store::try_global().ok_or("Account storage is unavailable.")?;
    let profiles = native_profiles(
        app.clone(),
        crate::store::repos::scope::DEFAULT_WORKSPACE_ID,
    )?;
    store
        .transaction(|conn| {
            let scope = authorized_scope::resolve(conn, None, None, ScopeAccess::Write)?;
            let time = now();
            operation(&Context {
                conn,
                store,
                scope: &scope,
                profiles: &profiles,
                time: &time,
            })
        })
        .map_err(|e| e.to_string())
}

pub(crate) fn next(app: &tauri::AppHandle) -> std::result::Result<Option<Work>, String> {
    with_context(app, |ctx| {
        work::reconcile_profiles(ctx)?;
        let mut all = ctx.all_work()?;
        all.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
        Ok(all
            .iter()
            .find(|item| {
                crate::background_worker::owns_work(item)
                    && item.status == WorkStatus::Queued
                    && !all.iter().any(|other| {
                        other.id != item.id
                            && other.agent_id == item.agent_id
                            && other.status.executing()
                    })
            })
            .cloned())
    })
}

fn write_attempt(ctx: &Context<'_>, attempt: &ExecutionAttempt) -> Result<()> {
    execution_attempt::upsert_scoped(
        ctx.conn,
        ctx.store,
        &ctx.scope.data,
        &attempt.id,
        attempt.thread_id.as_deref(),
        &attempt.provider_id,
        &attempt.model,
        &attempt.status,
        attempt.turn,
        attempt.recoverable,
        attempt.retry_count,
        &attempt.created_at,
        &attempt.updated_at,
        &serde_json::to_value(attempt).map_err(|_| invalid("Attempt encoding failed."))?,
    )
}

fn append(
    ctx: &Context<'_>,
    item: &Work,
    attempt: &ExecutionAttempt,
    kind: &str,
    text: &str,
) -> Result<()> {
    let head = thread::get(ctx.conn, ctx.store, &ctx.scope.data, &item.conversation_id)?
        .ok_or_else(|| invalid("The background conversation is unavailable."))?;
    let id = format!("{}-{kind}", attempt.id);
    message::append(
        ctx.conn,
        ctx.store,
        &ctx.scope.data,
        &item.conversation_id,
        &id,
        kind,
        &json!({"executionOwner":"native-background","agentId":item.agent_id}),
        Some(&attempt.id),
        head.last_sequence + 1,
        head.last_sequence,
        head.last_message_id.as_deref(),
        &id,
        &format!("{id}-revision"),
        "terminal",
        "native-background",
        &json!({"text":text}),
        ctx.time,
    )?;
    Ok(())
}

pub(crate) fn claim(
    app: &tauri::AppHandle,
    item: &Work,
    attempt: &ExecutionAttempt,
    scheduled: Option<&crate::local_schedules::background::Claim>,
) -> std::result::Result<(), String> {
    with_context(app, |ctx| {
        let current = work::current(ctx, &item.id, item.generation, None)?;
        if !crate::background_worker::is_worker()
            || !crate::background_worker::owns_work(&current)
            || !crate::background_worker::enabled_at(ctx.conn, ctx.store)?
            || !eligible(&current, profile(ctx.profiles, &current.agent_id)?)
            || current.status != WorkStatus::Queued
            || execution_attempt::get_scoped(ctx.conn, ctx.store, &ctx.scope.data, &attempt.id)?
                .is_some()
        {
            return Err(invalid("This request now needs foreground context or tools. Open Mivlet and Continue after reviewing its saved state."));
        }
        write_attempt(ctx, attempt)?;
        if item.schedule.is_some() {
            scheduled
                .ok_or_else(|| {
                    invalid("The native schedule claim is unavailable; no attempt was replayed.")
                })?
                .bind_at(ctx.conn, ctx.store, &attempt.id)?;
        }
        work::bind(ctx, &item.id, item.generation, &attempt.id, None)?;
        if item.run_ids.is_empty() {
            append(ctx, &current, attempt, "user", &item.user_request)?;
        }
        Ok(())
    })
}

pub(crate) fn check(
    app: &tauri::AppHandle,
    item: &Work,
    run: &str,
) -> std::result::Result<(), String> {
    with_context(app, |ctx| {
        let current = work::current(ctx, &item.id, item.generation, Some(run))?;
        if !crate::background_worker::owns_work(&current)
            || !crate::background_worker::enabled_at(ctx.conn, ctx.store)?
        {
            return Err(invalid("Background execution was stopped."));
        }
        Ok(())
    })
}

pub(crate) fn finish(
    app: &tauri::AppHandle,
    item: &Work,
    attempt: &ExecutionAttempt,
    status: WorkStatus,
) -> std::result::Result<WorkStatus, String> {
    with_context(app, |ctx| finish_at(ctx, item, attempt, status))
}

fn finish_at(
    ctx: &Context<'_>,
    item: &Work,
    attempt: &ExecutionAttempt,
    status: WorkStatus,
) -> Result<WorkStatus> {
    let current = work::current(ctx, &item.id, item.generation, Some(&attempt.id))?;
    // A terminal provider event can race the worker's next polling tick. Check
    // durable revocation in the same transaction before publishing any result.
    if !crate::background_worker::owns_work(&current)
        || !crate::background_worker::enabled_at(ctx.conn, ctx.store)?
    {
        return Err(invalid("Background execution was stopped."));
    }
    // Terminal rows are immutable even if a delayed terminal event arrives.
    let existing =
        execution_attempt::get_scoped(ctx.conn, ctx.store, &ctx.scope.data, &attempt.id)?
            .ok_or_else(|| invalid("The background attempt is unavailable."))?;
    if !matches!(
        existing.status.as_str(),
        "queued" | "streaming" | "awaiting-approval"
    ) {
        return Err(invalid("The background attempt is already terminal."));
    }
    write_attempt(ctx, attempt)?;
    if status == WorkStatus::Completed {
        append(ctx, item, attempt, "assistant", &attempt.transcript)?;
    }
    work::finish(
        ctx,
        &item.id,
        item.generation,
        &attempt.id,
        status,
        attempt.error.clone(),
    )?;
    let mut finished = ctx.item(&item.id)?;
    if finished.status == WorkStatus::Queued {
        // The renderer normally supplies task-scoped follow-up context.
        // Until that native path exists, preserve the completed result and
        // new steering instead of silently repeating the original prompt.
        finished.status = WorkStatus::AwaitingUser;
        finished.awaiting_user = true;
        finished.generation += 1;
        finished.current_run_id = None;
        finished.reason = Some("The result is saved. Open Mivlet and Continue to apply the new follow-up with its current context.".into());
        ctx.work(&finished)?;
    }
    Ok(finished.status)
}

pub(crate) fn checkpoint(
    app: &tauri::AppHandle,
    item: &Work,
    attempt: &ExecutionAttempt,
) -> std::result::Result<(), String> {
    with_context(app, |ctx| {
        let mut current = work::current(ctx, &item.id, item.generation, Some(&attempt.id))?;
        if !crate::background_worker::enabled_at(ctx.conn, ctx.store)? {
            return Err(invalid("Background execution was stopped."));
        }
        write_attempt(ctx, attempt)?;
        current.updated_at = ctx.time.into();
        ctx.work(&current)
    })
}

/// Cancellation can advance Work's generation before the adapter returns.
/// Close only the original bound attempt's metadata; never publish late output
/// or change the newer Work generation.
pub(crate) fn interrupt_bound_attempt(
    app: &tauri::AppHandle,
    item: &Work,
    run: &str,
) -> std::result::Result<(), String> {
    with_context(app, |ctx| {
        let author: Author = repo::get(ctx.conn, ctx.store, &ctx.scope.private, Kind::Author, run)?
            .ok_or_else(|| invalid("The background attempt author is unavailable."))?;
        if author.work_id.as_deref() != Some(item.id.as_str())
            || author.generation != item.generation
        {
            return Err(invalid("The background attempt binding changed."));
        }
        interrupt_attempt(ctx, run)
    })
}

pub(crate) fn blocked(
    app: &tauri::AppHandle,
    item: &Work,
    reason: &str,
) -> std::result::Result<(), String> {
    with_context(app, |ctx| {
        let mut current = work::current_for_failure(ctx, &item.id, item.generation)?;
        if let Some(run) = &current.current_run_id {
            interrupt_attempt(ctx, run)?;
        }
        current.status = WorkStatus::AwaitingUser;
        current.generation += 1;
        current.current_run_id = None;
        current.reason = Some(reason.chars().take(1800).collect());
        current.updated_at = ctx.time.into();
        ctx.work(&current)
    })
}

fn interrupt_attempt(ctx: &Context<'_>, run: &str) -> Result<()> {
    if let Some(row) = execution_attempt::get_scoped(ctx.conn, ctx.store, &ctx.scope.data, run)? {
        if matches!(
            row.status.as_str(),
            "queued" | "streaming" | "awaiting-approval" | "retrying"
        ) {
            let mut attempt: ExecutionAttempt = serde_json::from_value(row.payload)
                .map_err(|_| invalid("Invalid background attempt."))?;
            attempt.status = "interrupted".into();
            attempt.recoverable = true;
            attempt.pending_approval_ids.clear();
            attempt.updated_at = ctx.time.into();
            write_attempt(ctx, &attempt)?;
        }
    }
    Ok(())
}

/// Called only by a new exclusive owner or during its shutdown. Metadata-only
/// interruption preserves the last checkpoint; it cannot manufacture a result.
pub(crate) fn recover(store: &Store) -> Result<()> {
    store.transaction(|conn| {
        let scope = authorized_scope::resolve(conn, None, None, ScopeAccess::Write)?;
        let time = now();
        let ctx = Context { conn, store, scope: &scope, profiles: &[], time: &time };
        for mut item in ctx.all_work()? {
            if !crate::background_worker::owns_work(&item) { continue; }
            if let Some(run) = &item.current_run_id {
                interrupt_attempt(&ctx, run)?;
            }
            if item.status.active() {
                item.status = WorkStatus::AwaitingUser;
                item.generation += 1;
                item.current_run_id = None;
                item.updated_at = time.clone();
                item.reason = Some("The native background owner stopped. Review saved results before continuing. No provider request, approval or command was replayed.".into());
                ctx.work(&item)?;
            }
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::vault::{MasterKey, Vault};
    fn profiles() -> Vec<MivletAgentProfile> {
        vec![serde_json::from_value(json!({"id":"agent","name":"Agent","modelId":"codex::fixture",
            "instructions":"Private frozen instruction","permissionLabel":"Read Only","icon":"sparkle"})).unwrap()]
    }
    fn fixture<T>(store: &Store, f: impl FnOnce(&Context<'_>) -> Result<T>) -> T {
        store
            .transaction(|conn| {
                let scope = authorized_scope::resolve(conn, None, None, ScopeAccess::Write)?;
                let profiles = profiles();
                f(&Context {
                    conn,
                    store,
                    scope: &scope,
                    profiles: &profiles,
                    time: "2026-10-08T00:00:00Z",
                })
            })
            .unwrap()
    }
    fn seed(ctx: &Context<'_>, owner: bool) -> Result<Work> {
        let room = chats::open_main(ctx, "agent")?;
        let id = if owner { "native" } else { "renderer" };
        work::start(
            ctx,
            id.into(),
            room.id,
            "agent".into(),
            "Private user request".into(),
            false,
            None,
            None,
        )?;
        let mut work = ctx.item(id)?;
        if owner {
            work.execution_owner = Some("native-background".into());
        }
        ctx.work(&work)?;
        Ok(work)
    }
    fn enable(ctx: &Context<'_>) -> Result<()> {
        crate::store::repos::preferences::upsert(
            ctx.conn,
            ctx.store,
            "nativeBackgroundExecution",
            &json!({"version":1,"enabled":true,"generation":1}),
            ctx.time,
        )
    }
    #[test]
    fn recovery_survives_reopen_preserves_output_and_never_requeues() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("fixture.sqlite");
        let key = MasterKey::generate().unwrap();
        let store = Store::open(&path, Vault::new(&key).unwrap()).unwrap();
        fixture(&store, |ctx| {
            let mut work = seed(ctx, true)?;
            seed(ctx, false)?;
            let attempt: ExecutionAttempt = serde_json::from_value(json!({"id":"native-attempt","providerId":"codex","model":"fixture",
                "threadId":work.conversation_id,"status":"streaming","transcript":"Verified partial output", "turn":1,
                "pendingApprovalIds":["pending-exact-approval"],"recoverable":false,"retryCount":0,"createdAt":ctx.time,"updatedAt":ctx.time})).unwrap();
            write_attempt(ctx, &attempt)?;
            work.status = WorkStatus::Running;
            work.current_run_id = Some(attempt.id.clone());
            work.run_ids.push(attempt.id);
            ctx.work(&work)
        });
        drop(store);
        let store = Store::open(&path, Vault::new(&key).unwrap()).unwrap();
        recover(&store).unwrap();
        recover(&store).unwrap();
        fixture(&store, |ctx| {
            let work = ctx.item("native")?;
            assert_eq!(work.status, WorkStatus::AwaitingUser);
            assert_eq!(work.generation, 2);
            assert!(work.current_run_id.is_none());
            assert_eq!(ctx.item("renderer")?.status, WorkStatus::Queued);
            let row = execution_attempt::get_scoped(
                ctx.conn,
                ctx.store,
                &ctx.scope.data,
                "native-attempt",
            )?
            .unwrap();
            assert_eq!(row.status, "interrupted");
            assert_eq!(row.payload["transcript"], "Verified partial output");
            assert_eq!(row.payload["pendingApprovalIds"], json!([]));
            assert!(work::current(ctx, "native", 1, Some("native-attempt")).is_err());
            Ok(())
        });
        drop(store);
        let raw = std::fs::read(path).unwrap();
        for secret in [
            "Verified partial output",
            "Private user request",
            "Private frozen instruction",
        ] {
            assert!(!raw
                .windows(secret.len())
                .any(|bytes| bytes == secret.as_bytes()));
        }
    }
    #[test]
    fn follow_up_preserves_completed_evidence_without_replaying_the_original_prompt() {
        let store =
            Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap();
        fixture(&store, |ctx| {
            enable(ctx)?;
            let mut item = seed(ctx, true)?;
            let mut attempt: ExecutionAttempt = serde_json::from_value(json!({"id":"native-attempt","providerId":"codex","model":"fixture",
                "threadId":item.conversation_id,"status":"streaming","transcript":"Completed first response", "turn":1,
                "pendingApprovalIds":[],"recoverable":false,"retryCount":0,"createdAt":ctx.time,"updatedAt":ctx.time})).unwrap();
            write_attempt(ctx, &attempt)?;
            item.status = WorkStatus::Running;
            item.current_run_id = Some(attempt.id.clone());
            item.run_ids.push(attempt.id.clone());
            item.steering.push(WorkSteering {
                id: "follow-up".into(),
                text: "Now explain the alternative".into(),
                created_at: ctx.time.into(),
            });
            ctx.work(&item)?;
            attempt.status = "completed".into();
            assert_eq!(
                finish_at(ctx, &item, &attempt, WorkStatus::Completed)?,
                WorkStatus::AwaitingUser
            );
            let saved = ctx.item(&item.id)?;
            assert_eq!(saved.outputs[0].text, "Completed first response");
            assert_eq!(saved.steering.len(), 1);
            assert_eq!(saved.delivered_steering_count, 0);
            assert_eq!(saved.generation, item.generation + 1);
            assert!(saved.current_run_id.is_none());
            assert!(finish_at(ctx, &item, &attempt, WorkStatus::Completed).is_err());
            Ok(())
        });
    }

    #[test]
    fn durable_revocation_rejects_a_racing_completion_without_publishing() {
        let store =
            Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap();
        fixture(&store, |ctx| {
            enable(ctx)?;
            let mut item = seed(ctx, true)?;
            let mut attempt: ExecutionAttempt = serde_json::from_value(json!({"id":"native-attempt","providerId":"codex","model":"fixture",
                "threadId":item.conversation_id,"status":"streaming","transcript":"Saved partial output", "turn":1,
                "pendingApprovalIds":[],"recoverable":false,"retryCount":0,"createdAt":ctx.time,"updatedAt":ctx.time})).unwrap();
            write_attempt(ctx, &attempt)?;
            item.status = WorkStatus::Running;
            item.current_run_id = Some(attempt.id.clone());
            item.run_ids.push(attempt.id.clone());
            ctx.work(&item)?;
            crate::background_worker::revoke_at(ctx.conn, ctx.store)?;
            attempt.status = "completed".into();
            attempt.transcript = "Late output after Stop".into();
            let error = finish_at(ctx, &item, &attempt, WorkStatus::Completed).unwrap_err();
            assert!(error
                .to_string()
                .contains("Background execution was stopped."));
            assert!(ctx.item(&item.id)?.outputs.is_empty());
            let saved =
                execution_attempt::get_scoped(ctx.conn, ctx.store, &ctx.scope.data, &attempt.id)?
                    .unwrap();
            assert_eq!(saved.status, "streaming");
            assert_eq!(saved.payload["transcript"], "Saved partial output");
            assert!(
                !message::list(ctx.conn, ctx.store, &ctx.scope.data, &item.conversation_id)?
                    .iter()
                    .any(|message| message.kind == "assistant")
            );
            Ok(())
        });
    }

    #[test]
    fn unsupported_tools_inputs_and_renderer_takeover_are_refused() {
        let store =
            Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap();
        fixture(&store, |ctx| {
            let work = seed(ctx, true)?;
            let mut profile = profiles().remove(0);
            assert!(eligible(&work, &profile));
            profile.connector_ids.push("connected-app".into());
            assert!(!eligible(&work, &profile));
            profile.connector_ids.clear();
            let mut unsupported = work.clone();
            unsupported.permission_mode = "full-access".into();
            assert!(!eligible(&unsupported, &profile));
            unsupported = work.clone();
            unsupported.model_option_id = "gemini::fixture".into();
            assert!(!eligible(&unsupported, &profile));
            let mut continued = work.clone();
            continued.run_ids.push("finished-attempt".into());
            assert!(!eligible(&continued, &profile));
            let mut steered = work.clone();
            steered.steering.push(WorkSteering {
                id: "steer".into(),
                text: "New instruction".into(),
                created_at: ctx.time.into(),
            });
            assert!(!eligible(&steered, &profile));
            assert!(work::bind(ctx, &work.id, work.generation, "renderer-attempt", None).is_err());
            Ok(())
        });
    }
}
