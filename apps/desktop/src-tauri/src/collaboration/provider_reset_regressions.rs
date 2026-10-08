//! Native authority fixtures; these do not claim a live provider reset.
use super::*;
use crate::provider_usage;
use crate::store::repos::{backend_connection, preferences};

const RESET: &str = "2026-09-12T10:01:00.000Z";
fn reset_profiles() -> Vec<MivletAgentProfile> {
    let mut result = profiles();
    result[0].model_id = "chatgpt::fixture-model".into();
    result
}
fn measurement(ctx: &Context<'_>, percent: f64, owner: &str) -> Result<String> {
    let epoch = chrono::DateTime::parse_from_rfc3339(RESET)
        .unwrap()
        .timestamp();
    let report = provider_usage::codex(
        &ctx.scope.internal_user_id,
        &json!({"id":owner}),
        &json!({"rateLimits":{"primary":{"usedPercent":percent,"resetsAt":epoch,"windowDurationMins":300}}}),
        ctx.time,
    );
    let opportunity = report
        .reset_opportunity
        .as_ref()
        .map(|r| r.id.clone())
        .unwrap_or_default();
    provider_usage::store_allowance(ctx.conn, ctx.store, ctx.scope, &report)?;
    Ok(opportunity)
}
fn failed(ctx: &Context<'_>, proof: bool) -> Result<(u32, String)> {
    let room = chats::open_main(ctx, "lead")?;
    work::start(
        ctx,
        "reset-work".into(),
        room.id.clone(),
        "lead".into(),
        "Fixture request".into(),
        false,
        None,
        None,
    )?;
    let mut attempt = attempt_record("reset-run", &room.id, "queued", "");
    attempt.provider_id = "chatgpt".into();
    let save = |attempt: &crate::models::ExecutionAttempt| {
        execution_attempt::upsert_scoped(
            ctx.conn,
            ctx.store,
            &ctx.scope.data,
            &attempt.id,
            Some(&room.id),
            "chatgpt",
            "fixture-model",
            &attempt.status,
            1,
            true,
            0,
            TIME,
            ctx.time,
            &json!(attempt),
        )
    };
    save(&attempt)?;
    work::bind(ctx, "reset-work", 1, "reset-run", None)?;
    attempt.status = "failed".into();
    save(&attempt)?;
    work::finish(
        ctx,
        "reset-work",
        1,
        "reset-run",
        WorkStatus::Failed,
        Some("Fixture provider failure".into()),
    )?;
    backend_connection::upsert(ctx.conn, &ctx.scope.internal_user_id, "chatgpt", TIME)?;
    if proof {
        // Equivalent encrypted native adapter evidence; classification is
        // independently tested with real protocol shapes in provider_usage.
        preferences::upsert_scoped(
            ctx.conn,
            ctx.store,
            &ctx.scope.data,
            &format!(
                "provider-limit-failure:{}:reset-run",
                ctx.scope.internal_user_id
            ),
            &json!({"providerId":"chatgpt","reportedAt":TIME}),
            TIME,
        )?;
    }
    Ok((
        ctx.item("reset-work")?.generation,
        measurement(ctx, 100.0, "account-a")?,
    ))
}
#[test]
fn reset_needs_native_limit_evidence_reconciliation_and_exact_generation() {
    fixture_with_profiles(&store(), reset_profiles(), |ctx| {
        let (generation, opportunity) = failed(ctx, false)?;
        assert!(provider_resets::arm(ctx, "reset-work", generation, &opportunity, true).is_err());
        preferences::upsert_scoped(
            ctx.conn,
            ctx.store,
            &ctx.scope.data,
            &format!(
                "provider-limit-failure:{}:reset-run",
                ctx.scope.internal_user_id
            ),
            &json!({"providerId":"chatgpt"}),
            TIME,
        )?;
        assert!(provider_resets::arm(ctx, "reset-work", generation, &opportunity, false).is_err());
        assert!(
            provider_resets::arm(ctx, "reset-work", generation + 1, &opportunity, true).is_err()
        );
        provider_resets::arm(ctx, "reset-work", generation, &opportunity, true)?;
        assert!(provider_resets::arm(ctx, "reset-work", generation, &opportunity, true).is_err());
        provider_resets::cancel(ctx, "reset-work", generation)?;
        assert!(provider_resets::arm(ctx, "reset-work", generation, &opportunity, true).is_err());
        Ok(())
    });
}
#[test]
fn verified_reset_admits_one_fresh_attempt_through_work_and_keeps_prior_receipts() {
    fixture_with_profiles(&store(), reset_profiles(), |ctx| {
        let (generation, opportunity) = failed(ctx, true)?;
        provider_resets::arm(ctx, "reset-work", generation, &opportunity, true)?;
        provider_resets::dispatch(ctx)?;
        assert_eq!(ctx.item("reset-work")?.status, WorkStatus::Failed);
        let after = Context {
            time: RESET,
            ..*ctx
        };
        measurement(&after, 2.0, "account-a")?;
        provider_resets::dispatch(&after)?;
        let continued = after.item("reset-work")?;
        assert_eq!(continued.status, WorkStatus::Queued);
        assert_eq!(continued.generation, generation + 1);
        assert_eq!(continued.run_ids, vec!["reset-run"]);
        assert!(continued.current_run_id.is_none());
        assert_eq!(continued.reset_continuation.unwrap().state, "consumed");
        provider_resets::dispatch(&after)?;
        assert_eq!(after.item("reset-work")?.generation, generation + 1);
        assert_eq!(
            execution_attempt::get_scoped(ctx.conn, ctx.store, &ctx.scope.data, "reset-run")?
                .unwrap()
                .status,
            "failed"
        );
        Ok(())
    });
}
#[test]
fn unavailable_reset_changed_identity_and_stop_all_require_new_review() {
    for scenario in ["unavailable", "identity", "stop", "model", "restart"] {
        fixture_with_profiles(&store(), reset_profiles(), |ctx| {
            let (generation, opportunity) = failed(ctx, true)?;
            provider_resets::arm(ctx, "reset-work", generation, &opportunity, true)?;
            if scenario == "stop" {
                work::invalidate_descendants(ctx, "reset-work", "Stopped", WorkStatus::Cancelled)?;
            }
            if scenario == "restart" {
                let mut item = ctx.item("reset-work")?;
                assert!(provider_resets::require_restart_review(&mut item));
                ctx.work(&item)?;
            }
            let mut changed_profiles = reset_profiles();
            if scenario == "model" {
                changed_profiles[0].model_id = "chatgpt::different-model".into();
            }
            let after = Context {
                time: RESET,
                profiles: &changed_profiles,
                ..*ctx
            };
            if scenario != "unavailable" {
                measurement(
                    &after,
                    2.0,
                    if scenario == "identity" {
                        "account-b"
                    } else {
                        "account-a"
                    },
                )?;
            }
            provider_resets::dispatch(&after)?;
            let item = after.item("reset-work")?;
            assert_ne!(item.status, WorkStatus::Queued, "{scenario}");
            assert_eq!(
                item.reset_continuation.unwrap().state,
                "review-required",
                "{scenario}"
            );
            Ok(())
        });
    }
}
