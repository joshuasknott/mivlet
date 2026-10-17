//! Authored storage fixtures, never evidence of a live provider response.
use super::super::tests::{fixture, store};
use super::*;
use sha2::Digest;
pub(super) fn start(
    ctx: &Context<'_>,
) -> Result<(Prepare, HostedComputerScope, Vec<ProviderConnection>)> {
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
            mode: None,
            web_scope: None,
            selected_paths: None,
            writable_paths: None,
            checks: None,
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
        let (_, pending) = stop_at(ctx, &target)?;
        assert_eq!(pending.unwrap().expected_generation, item.generation + 1);
        assert!(cloud::dispatch::with_current(&saved.admission.binding, || Ok(())).is_err());
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
#[test]
fn research_review_captures_full_policy_exact_scope_and_bound_budget_before_claim() {
    fixture(&store(), |ctx| {
        let (mut request, scope, connections) = start(ctx)?;
        request.mode = Some("public-web-research".into());
        request.web_scope = Some(PublicWebScope {
            allowed_domains: vec!["example.com".into()],
            initial_urls: vec!["https://example.com/".into()],
        });
        let review = prepare_at(
            ctx,
            &request,
            &scope,
            4,
            "https://tasks.example.test",
            &connections,
            None,
        )?;
        let binding = &review.admission.binding;
        assert_eq!(binding.version, 2);
        assert_eq!(binding.mode, request.mode);
        assert_eq!(binding.web_scope, request.web_scope);
        assert_eq!(binding.budget.max_model_calls, 4);
        assert_eq!(binding.budget.max_output_tokens, 4096);
        assert_eq!(binding.budget.max_page_reads, Some(6));
        assert_eq!(binding.budget.max_source_bytes, Some(65536));
        assert_eq!(review.admission.input.messages.len(), 3);
        assert_eq!(
            review.admission.input.messages[1].content,
            cloud::public_web::policy(request.web_scope.as_ref().unwrap())
                .map_err(StoreError::Invalid)?
        );
        assert!(review
            .approval
            .consequence
            .contains("any of that disclosed text"));
        let actual = cloud::digest_value(&serde_json::to_value(&review.admission.input).unwrap())
            .map_err(StoreError::Invalid)?;
        assert_eq!(binding.input_sha256, actual);
        let target = Target {
            expected_generation: review.work_generation,
            ..request.target()
        };
        let _dispatch = cloud::dispatch::AdmissionGuard::retain(binding);
        let captured = claim_at(ctx, &target, &review.review_id)?;
        assert_eq!(captured.admission.binding, *binding);
        assert!(stop_at(ctx, &target)?.1.is_some());
        Ok(())
    });
}
#[test]
fn research_scope_expansion_is_rejected_before_the_canonical_queue_changes() {
    fixture(&store(), |ctx| {
        let (mut request, scope, connections) = start(ctx)?;
        let before = ctx.item(&request.work_id)?;
        request.mode = Some("public-web-research".into());
        for (domain, url) in [
            ("*.example.com", "https://example.com/"),
            ("127.0.0.1", "https://127.0.0.1/"),
            ("example.com", "https://other.com/"),
            ("example.com", "https://example.com/?api_key=private"),
        ] {
            request.web_scope = Some(PublicWebScope {
                allowed_domains: vec![domain.into()],
                initial_urls: vec![url.into()],
            });
            assert!(prepare_at(
                ctx,
                &request,
                &scope,
                4,
                "https://tasks.example.test",
                &connections,
                None
            )
            .is_err());
            assert_eq!(ctx.item(&request.work_id)?, before);
        }
        Ok(())
    });
}
#[test]
fn stop_before_claim_cancels_review_and_prevents_the_delayed_approved_dispatch() {
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
            expected_generation: review.work_generation,
            ..request.target()
        };
        // Pause the approved admission at the same boundary as production:
        // its sole approval consumer retained cleanup but has not claimed Work.
        let _dispatch = cloud::dispatch::AdmissionGuard::retain(&review.admission.binding);
        let (stopped, remote) = stop_at(ctx, &target)?;
        assert!(remote.is_none());
        assert!(!stopped.reconcile_required);
        let saved = ctx.item(&target.work_id)?;
        assert_eq!(saved.status, WorkStatus::Cancelled);
        assert_eq!(saved.generation, target.expected_generation + 1);
        assert!(saved.hosted_task.is_none());
        assert!(saved.execution_owner.is_none());
        assert!(!queue::dispatchable(&saved, &ctx.all_work()?));
        let mut sends = 0;
        if let Ok(offer) = claim_at(ctx, &target, &review.review_id) {
            cloud::dispatch::with_current(&offer.admission.binding, || {
                sends += 1;
                Ok(())
            })
            .unwrap();
        }
        assert_eq!(sends, 0);
        assert!(cloud::dispatch::with_current(&review.admission.binding, || Ok(())).is_err());
        assert!(execution_attempt::get_scoped(
            ctx.conn,
            ctx.store,
            &ctx.scope.data,
            &review.admission.binding.run_id
        )?
        .is_none());
        Ok(())
    });
}
pub(super) fn answer(offer: &Offer) -> TaskResult {
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
            research: None,
            coding: None,
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
