//! Authored storage fixtures, never evidence of a live provider response.
use super::super::tests::{fixture, store};
use super::*;
use sha2::Digest;
fn start(ctx: &Context<'_>) -> Result<(Prepare, HostedComputerScope, Vec<ProviderConnection>)> {
    let room = chats::open_main(ctx, "lead")?;
    work::start(
        ctx,
        "work-cloud-unit".into(),
        room.id,
        "lead".into(),
        "Explain seasons.".into(),
        false,
        None,
        None,
    )?;
    let item = ctx.item("work-cloud-unit")?;
    Ok((
        Prepare {
            workspace_id: item.workspace_id,
            agent_id: item.agent_id,
            work_id: item.id,
            expected_generation: item.generation,
            credential_id: "credential-unit".into(),
            credential_revision: 1,
        },
        HostedComputerScope {
            workspace_id: "cloud-workspace".into(),
            device_id: "device-unit".into(),
        },
        vec![ProviderConnection {
            credential_id: "credential-unit".into(),
            provider_id: "openai".into(),
            revision: 1,
            enabled: true,
            created_at: 1,
            updated_at: 1,
            expires_at: chrono::Utc::now().timestamp_millis() + 100000,
        }],
    ))
}
#[test]
fn prepare_holds_the_canonical_queue_before_disclosing_exact_captured_text() {
    fixture(&store(), |ctx| {
        let (request, scope, connections) = start(ctx)?;
        let review = prepare_at(
            ctx,
            &request,
            &scope,
            4,
            "https://tasks.example.test",
            &connections,
            None,
        )?;
        let item = ctx.item(&request.work_id)?;
        assert!(repo::get::<Offer>(
            ctx.conn,
            ctx.store,
            &ctx.scope.private,
            Kind::Receipt,
            &format!("hosted-task:{}", item.id),
        )?
        .is_some());
        assert!(repo::get::<Offer>(
            ctx.conn,
            ctx.store,
            &ctx.scope.private,
            Kind::Receipt,
            &item.id,
        )?
        .is_none());
        assert!(item.queue.as_ref().unwrap().held);
        assert_eq!(item.generation, request.expected_generation + 1);
        assert!(!queue::dispatchable(&item, &ctx.all_work()?));
        assert_eq!(review.admission.input.messages.len(), 2);
        assert_eq!(
            review.admission.input.messages[0].content,
            "Fixture teammate"
        );
        assert_eq!(
            review.admission.input.messages[1].content,
            "Explain seasons."
        );
        assert_eq!(review.admission.binding.work_generation, item.generation);
        assert!(!review.originally_held);
        assert!(claim_at(ctx, &request.target(), &review.review_id).is_err());
        Ok(())
    });
}
#[test]
fn native_claim_owns_one_existing_work_and_stop_rejects_its_late_conversation_write() {
    fixture(&store(), |ctx| {
        let (request, scope, connections) = start(ctx)?;
        let review = prepare_at(
            ctx,
            &request,
            &scope,
            4,
            "https://tasks.example.test",
            &connections,
            None,
        )?;
        let target = Target {
            workspace_id: request.workspace_id,
            agent_id: request.agent_id,
            work_id: request.work_id,
            expected_generation: review.work_generation,
        };
        let _dispatch = cloud::dispatch::AdmissionGuard::retain(&review.admission.binding);
        let saved = claim_at(ctx, &target, &review.review_id)?;
        let item = ctx.item(&target.work_id)?;
        assert!(
            exchanges::reply_user(ctx, &item.id, item.generation, "reply-unit", "More text")
                .is_err()
        );
        assert_eq!(item.execution_owner.as_deref(), Some("hosted"));
        assert_eq!(item.run_ids, vec![saved.admission.binding.run_id.clone()]);
        assert!(work::bind(ctx, &item.id, item.generation, "run-other", None).is_err());
        let unchanged = item.clone();
        assert!(work::agent_command(
            ctx,
            &item.id,
            item.generation,
            &saved.admission.binding.run_id,
            "call-unit",
            AgentCommand::AwaitUser {
                reason: "Forged cloud tool".into()
            }
        )
        .is_err());
        assert_eq!(ctx.item(&item.id)?, unchanged);
        let head =
            thread::get(ctx.conn, ctx.store, &ctx.scope.data, &item.conversation_id)?.unwrap();
        assert_eq!(
            head.last_sequence,
            saved.admission.binding.expected_sequence
        );
        assert_eq!(
            head.last_message_id,
            saved.admission.binding.expected_head_id
        );
        work::invalidate_descendants(ctx, &item.id, "Stop fixture", WorkStatus::Cancelled)?;
        let stopped = ctx.item(&item.id)?;
        assert_eq!(stopped.hosted_task.as_ref().unwrap().phase, "stop-pending");
        assert!(super::super::ensure_run_current(
            ctx.conn,
            ctx.store,
            Some(&saved.admission.binding.run_id)
        )
        .is_err());
        Ok(())
    });
}
fn answer(offer: &Offer) -> TaskResult {
    let text = "Seasons follow Earth's tilt around the Sun.";
    let now = chrono::Utc::now().timestamp_millis();
    TaskResult {
        snapshot: TaskSnapshot {
            binding: offer.admission.binding.clone(),
            generation: 1,
            status: "completed".into(),
            sequence: 3,
            result_sha256: Some(hex::encode(sha2::Sha256::digest(text.as_bytes()))),
            result_bytes: text.len(),
            usage: None,
            error_code: None,
            created_at: now,
            updated_at: now,
            retained_until: now + 86_400_000,
        },
        text: text.into(),
    }
}
#[test]
fn native_receipt_completes_the_bound_attempt_and_chat_once_without_local_dispatch() {
    fixture(&store(), |ctx| {
        let (request, scope, connections) = start(ctx)?;
        let review = prepare_at(
            ctx,
            &request,
            &scope,
            4,
            "https://tasks.example.test",
            &connections,
            None,
        )?;
        let target = Target {
            workspace_id: request.workspace_id,
            agent_id: request.agent_id,
            work_id: request.work_id,
            expected_generation: review.work_generation,
        };
        let _dispatch = cloud::dispatch::AdmissionGuard::retain(&review.admission.binding);
        let offer = claim_at(ctx, &target, &review.review_id)?;
        let result = answer(&offer);
        let finished = result_at(ctx, &target, Some(result.clone()))?;
        assert!(!finished.reconcile_required);
        assert_eq!(ctx.item(&target.work_id)?.status, WorkStatus::Completed);
        assert_eq!(ctx.item(&target.work_id)?.outputs.len(), 1);
        result_at(ctx, &target, Some(result))?;
        assert_eq!(ctx.item(&target.work_id)?.outputs.len(), 1);
        let item = ctx.item(&target.work_id)?;
        assert!(
            exchanges::reply_user(ctx, &item.id, item.generation, "reply-unit", "More text")
                .is_err()
        );
        assert!(work::bind(ctx, &item.id, item.generation, "local-run", None).is_err());
        Ok(())
    });
}
#[test]
fn changed_chat_head_retains_native_receipt_without_inserting_a_late_answer() {
    fixture(&store(), |ctx| {
        let (request, scope, connections) = start(ctx)?;
        let review = prepare_at(
            ctx,
            &request,
            &scope,
            4,
            "https://tasks.example.test",
            &connections,
            None,
        )?;
        let target = Target {
            workspace_id: request.workspace_id,
            agent_id: request.agent_id,
            work_id: request.work_id,
            expected_generation: review.work_generation,
        };
        let _dispatch = cloud::dispatch::AdmissionGuard::retain(&review.admission.binding);
        let offer = claim_at(ctx, &target, &review.review_id)?;
        let item = ctx.item(&target.work_id)?;
        append(
            ctx,
            &item,
            "other-run",
            "user",
            "A newer message changed the head.",
        )?;
        let result = result_at(ctx, &target, Some(answer(&offer)))?;
        assert!(result.reconcile_required);
        let item = ctx.item(&target.work_id)?;
        assert_eq!(item.status, WorkStatus::AwaitingUser);
        assert!(item.outputs.is_empty());
        assert_eq!(
            item.hosted_task.as_ref().unwrap().phase,
            "reconcile-required"
        );
        let messages = message::list(ctx.conn, ctx.store, &ctx.scope.data, &item.conversation_id)?;
        assert!(messages.iter().all(|m| m.kind != "assistant"));
        let saved = execution_attempt::get_scoped(
            ctx.conn,
            ctx.store,
            &ctx.scope.data,
            &offer.admission.binding.run_id,
        )?
        .unwrap();
        assert_eq!(saved.payload["transcript"], answer(&offer).text);
        Ok(())
    });
}
#[test]
fn reduced_permissions_preserve_receipt_and_finished_before_stop_is_reviewable() {
    fixture(&store(), |ctx| {
        let (request, scope, connections) = start(ctx)?;
        let review = prepare_at(
            ctx,
            &request,
            &scope,
            4,
            "https://tasks.example.test",
            &connections,
            None,
        )?;
        let target = Target {
            workspace_id: request.workspace_id,
            agent_id: request.agent_id,
            work_id: request.work_id,
            expected_generation: review.work_generation,
        };
        let _dispatch = cloud::dispatch::AdmissionGuard::retain(&review.admission.binding);
        let offer = claim_at(ctx, &target, &review.review_id)?;
        let mut profiles = ctx.profiles.to_vec();
        profiles
            .iter_mut()
            .find(|p| p.id == "lead")
            .unwrap()
            .permission_label = "Read Only".into();
        let reduced = Context {
            conn: ctx.conn,
            store: ctx.store,
            scope: ctx.scope,
            profiles: &profiles,
            time: ctx.time,
        };
        let result = result_at(&reduced, &target, Some(answer(&offer)))?;
        assert!(result.reconcile_required);
        assert!(ctx.item(&target.work_id)?.outputs.is_empty());
        let saved = execution_attempt::get_scoped(
            ctx.conn,
            ctx.store,
            &ctx.scope.data,
            &offer.admission.binding.run_id,
        )?
        .unwrap();
        assert_eq!(saved.payload["transcript"], answer(&offer).text);
        Ok(())
    });
    fixture(&store(), |ctx| {
        let (request, scope, connections) = start(ctx)?;
        let review = prepare_at(
            ctx,
            &request,
            &scope,
            4,
            "https://tasks.example.test",
            &connections,
            None,
        )?;
        let mut target = Target {
            workspace_id: request.workspace_id,
            agent_id: request.agent_id,
            work_id: request.work_id,
            expected_generation: review.work_generation,
        };
        let _dispatch = cloud::dispatch::AdmissionGuard::retain(&review.admission.binding);
        let offer = claim_at(ctx, &target, &review.review_id)?;
        work::invalidate_descendants(ctx, &target.work_id, "Stop fixture", WorkStatus::Cancelled)?;
        target.expected_generation = ctx.item(&target.work_id)?.generation;
        let result = result_at(ctx, &target, Some(answer(&offer)))?;
        assert!(result.reconcile_required);
        assert_eq!(ctx.item(&target.work_id)?.status, WorkStatus::Cancelled);
        assert!(ctx.item(&target.work_id)?.outputs.is_empty());
        assert_eq!(result.task_result.unwrap().text, answer(&offer).text);
        Ok(())
    });
}
