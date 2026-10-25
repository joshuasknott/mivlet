//! Canonical storage fixtures, not live provider or Container evidence.
use super::*;
use crate::collaboration::tests::{fixture, store};
use crate::local_computer::coding::{
    hosted_repository::{OutputManifest, Snapshot},
    RepositoryWorkBinding,
};
use sha2::{Digest, Sha256};

fn prepared(ctx: &Context<'_>, writable: bool) -> Result<(Target, Review)> {
    let (mut request, scope, connections) = super::super::tests::start(ctx)?;
    let file_sha = hex::encode(Sha256::digest(b"source"));
    let mut tree = Sha256::new();
    tree.update(7u64.to_le_bytes());
    tree.update(b"main.ts");
    tree.update(hex::decode(&file_sha).unwrap());
    let writable_paths = if writable {
        vec!["main.ts".to_string()]
    } else {
        vec![]
    };
    let mut value = json!({"version":1,"snapshotId":"a".repeat(48),"repositoryId":"b".repeat(48),"branch":"main","baseCommit":"c".repeat(40),"inputTreeId":hex::encode(tree.finalize()),"files":[{"path":"main.ts","sizeBytes":6,"sha256":file_sha}],"writablePaths":writable_paths,"totalBytes":6});
    value["manifestSha256"] = json!(cloud::digest_value(&value).unwrap());
    let snapshot: Snapshot = serde_json::from_value(value).unwrap();
    let mut item = ctx.item(&request.work_id)?;
    item.repository_binding = Some(RepositoryWorkBinding {
        version: 1,
        repository_id: snapshot.repository_id.clone(),
        branch: snapshot.branch.clone(),
        base_commit: snapshot.base_commit.clone(),
        captured_at: ctx.time.into(),
    });
    ctx.work(&item)?;
    queue::hold(ctx, &item.id, item.generation, true)?;
    request.expected_generation = ctx.item(&item.id)?.generation;
    request.mode = Some("offline-coding".into());
    request.selected_paths = Some(vec!["main.ts".into()]);
    request.writable_paths = Some(writable_paths.clone());
    request.checks = Some(vec![]);
    // Preparation custody is process-wide. Independent in-memory stores must
    // not reuse an identity while another parallel test holds its guard.
    static NEXT_FIXTURE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let fixture_id = NEXT_FIXTURE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let task = TaskIdentity {
        local_workspace_id: request.workspace_id.clone(),
        agent_id: request.agent_id.clone(),
        work_id: request.work_id.clone(),
        work_generation: request.expected_generation,
        task_id: format!("task-coding-unit-{fixture_id}"),
        run_id: format!("cloud-run-coding-unit-{fixture_id}"),
    };
    let repo = CodingRepository {
        snapshot,
        scope: CodingScope {
            writable_paths,
            checks: vec![],
            image: cloud::coding::IMAGE.into(),
            network: "disabled".into(),
        },
    };
    let review = prepare_at(
        ctx,
        &request,
        &scope,
        4,
        "https://tasks.example.test",
        &connections,
        false,
        &task,
        repo,
    )?;
    Ok((request.target(), review))
}
fn completed(saved: &Offer, changed: bool, parked: bool) -> TaskResult {
    let snapshot = &saved
        .admission
        .binding
        .repository
        .as_ref()
        .unwrap()
        .snapshot;
    let mut output = OutputManifest {
        version: 1,
        snapshot_id: snapshot.snapshot_id.clone(),
        input_manifest_sha256: snapshot.manifest_sha256.clone(),
        output_manifest_sha256: String::new(),
        files: snapshot.files.clone(),
        deleted_paths: vec![],
        total_bytes: snapshot.total_bytes,
    };
    if changed {
        output.files[0].sha256 = hex::encode(Sha256::digest(b"change"));
    }
    let mut value = serde_json::to_value(&output).unwrap();
    value
        .as_object_mut()
        .unwrap()
        .remove("outputManifestSha256");
    output.output_manifest_sha256 = cloud::digest_value(&value).unwrap();
    let mut result = super::super::tests::answer(saved);
    result.snapshot.coding = Some(CodingProgress {
        model_calls: 1,
        tool_calls: if changed { 1 } else { 0 },
        allocated_output_tokens: 1024,
        completed_checks: vec![],
        output,
        proposal: parked.then(|| CodingProposal {
            tool: "scratch_write".into(),
            arguments: "{}".into(),
            arguments_sha256: cloud::digest_value(&json!("{}")).unwrap(),
            reason: "path-outside-scope".into(),
        }),
    });
    if parked {
        result.snapshot.status = "needs-review".into();
    }
    result
}
#[test]
fn coding_consent_binds_source_scope_and_one_operation_without_local_grants() {
    fixture(&store(), |ctx| {
        let (target, review) = prepared(ctx, true)?;
        assert_eq!(review.admission.binding.version, 3);
        assert_eq!(
            review.admission.binding.work_generation,
            target.expected_generation
        );
        assert_eq!(review.admission.binding.budget.max_model_calls, 4);
        assert_eq!(review.admission.binding.budget.max_tool_calls, Some(8));
        assert_eq!(
            review.approval.confirmation_phrase.as_deref(),
            Some("Run this isolated task")
        );
        assert_eq!(
            review.admission.input.messages[1].content,
            cloud::coding::policy(review.admission.binding.repository.as_ref().unwrap()).unwrap()
        );
        assert!(ctx.item(&target.work_id)?.repository_binding.is_some());
        assert!(!queue::dispatchable(
            &ctx.item(&target.work_id)?,
            &ctx.all_work()?
        ));
        let protocol =
            include_str!("../../../../../../packages/protocol/src/domains/hosted-coding.ts");
        assert!(protocol.contains(&format!(
            "export const HOSTED_CODING_POLICY = \"{}\";",
            cloud::coding::POLICY
        )));
        Ok(())
    });
}
#[test]
fn changed_candidate_parks_exact_owner_without_inserting_or_importing_files() {
    fixture(&store(), |ctx| {
        let (target, review) = prepared(ctx, true)?;
        let _gate = cloud::dispatch::AdmissionGuard::retain(&review.admission.binding);
        let saved = claim_at(ctx, &target, &review.review_id)?;
        let result = completed(&saved, true, false);
        super::super::result_at(ctx, &target, Some(result.clone()))?;
        let item = ctx.item(&target.work_id)?;
        assert_eq!(item.status, WorkStatus::AwaitingUser);
        assert_eq!(item.generation, target.expected_generation);
        assert_eq!(item.execution_owner.as_deref(), Some("hosted"));
        assert_eq!(
            item.current_run_id.as_deref(),
            Some(saved.admission.binding.run_id.as_str())
        );
        assert_eq!(item.hosted_task.as_ref().unwrap().phase, "awaiting-import");
        assert!(item.outputs.is_empty());
        super::super::result_at(ctx, &target, Some(result))?;
        assert!(ctx.item(&target.work_id)?.outputs.is_empty());
        let messages = message::list(ctx.conn, ctx.store, &ctx.scope.data, &item.conversation_id)?;
        assert!(messages.iter().all(|m| m.kind != "assistant"));
        // Only the encrypted native import receipt can connect file completion
        // to this saved provider result. Cloud completion alone did not do so.
        let snapshot = &saved
            .admission
            .binding
            .repository
            .as_ref()
            .unwrap()
            .snapshot;
        let output = &completed(&saved, true, false)
            .snapshot
            .coding
            .unwrap()
            .output;
        let imported = json!({"task":TaskIdentity::from_binding(&target.workspace_id,&saved.admission.binding).unwrap(),"snapshot":snapshot,"receipt":{"snapshotId":snapshot.snapshot_id,"repositoryId":snapshot.repository_id,"outputManifestSha256":output.output_manifest_sha256,"outputTreeId":"e".repeat(64),"beforeImportCheckpointId":"f".repeat(48),"verificationInvalidated":true}});
        ctx.put(
            Kind::Receipt,
            &format!("hosted-repository-import:{}", snapshot.snapshot_id),
            None,
            None,
            &imported,
        )?;
        super::super::result_at(ctx, &target, None)?;
        let completed = ctx.item(&target.work_id)?;
        assert_eq!(completed.status, WorkStatus::Completed);
        assert_eq!(completed.outputs.len(), 1);
        Ok(())
    });
}
#[test]
fn read_only_unchanged_output_finishes_once_without_a_file_import() {
    fixture(&store(), |ctx| {
        let (target, review) = prepared(ctx, false)?;
        let _gate = cloud::dispatch::AdmissionGuard::retain(&review.admission.binding);
        let saved = claim_at(ctx, &target, &review.review_id)?;
        let result = completed(&saved, false, false);
        super::super::result_at(ctx, &target, Some(result.clone()))?;
        super::super::result_at(ctx, &target, Some(result))?;
        let item = ctx.item(&target.work_id)?;
        assert_eq!(item.status, WorkStatus::Completed);
        assert_eq!(item.outputs.len(), 1);
        assert_eq!(item.hosted_task.as_ref().unwrap().phase, "reconciled");
        Ok(())
    });
}
#[test]
fn extra_scope_remains_needs_user_and_stop_preserves_the_authenticated_partial_result() {
    fixture(&store(), |ctx| {
        let (target, review) = prepared(ctx, true)?;
        let _gate = cloud::dispatch::AdmissionGuard::retain(&review.admission.binding);
        let saved = claim_at(ctx, &target, &review.review_id)?;
        let result = completed(&saved, true, true);
        super::super::result_at(ctx, &target, Some(result.clone()))?;
        let item = ctx.item(&target.work_id)?;
        assert_eq!(item.status, WorkStatus::AwaitingUser);
        assert_eq!(
            item.hosted_task.as_ref().unwrap().phase,
            "scope-change-required"
        );
        assert!(item.outputs.is_empty());
        assert!(work::bind(ctx, &item.id, item.generation, "local-fallback", None).is_err());
        let (_, next) = stop_at(ctx, &target)?;
        let stopped = next.unwrap();
        let retained = super::super::result_at(ctx, &stopped, Some(result.clone()))?;
        assert!(retained.reconcile_required);
        assert_eq!(retained.task_result.unwrap().text, result.text);
        assert!(ctx.item(&item.id)?.outputs.is_empty());
        Ok(())
    });
}
#[test]
fn coding_receipts_reject_scope_expansion_or_missing_manifest_and_keep_permission_changes_separate()
{
    fixture(&store(), |ctx| {
        let (target, review) = prepared(ctx, true)?;
        let _gate = cloud::dispatch::AdmissionGuard::retain(&review.admission.binding);
        let saved = claim_at(ctx, &target, &review.review_id)?;
        let result = completed(&saved, true, false);
        let mut invalid = result.clone();
        invalid.snapshot.coding.as_mut().unwrap().output.files[0].path = "extra.ts".into();
        assert!(cloud::validate_result(&saved.admission.binding, None, &invalid).is_err());
        invalid = result.clone();
        invalid.snapshot.coding = None;
        assert!(cloud::validate_result(&saved.admission.binding, None, &invalid).is_err());
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
        let retained = super::super::result_at(&reduced, &target, Some(result.clone()))?;
        assert!(retained.reconcile_required);
        assert_eq!(retained.task_result.unwrap().text, result.text);
        assert!(ctx.item(&target.work_id)?.outputs.is_empty());
        Ok(())
    });
}

#[test]
fn missing_runtime_is_clear_after_persisting_uncertainty_without_reclassifying_network_failure() {
    fixture(&store(), |ctx| {
        let (target, review) = prepared(ctx, true)?;
        let _gate = cloud::dispatch::AdmissionGuard::retain(&review.admission.binding);
        claim_at(ctx, &target, &review.review_id)?;
        let unavailable = cloud::coding::admission_failed(
            3,
            "Cloud task request failed (hosted-coding-runtime-required).",
            || super::super::result_at(ctx, &target, None).map_err(|error| error.to_string()),
        );
        assert!(unavailable
            .err()
            .unwrap()
            .contains("Workers Paid Containers"));
        let item = ctx.item(&target.work_id)?;
        assert_eq!(item.execution_owner.as_deref(), Some("hosted"));
        assert_eq!(item.hosted_task.as_ref().unwrap().phase, "dispatching");
        assert_eq!(item.run_ids.len(), 1);
        assert!(item.outputs.is_empty());
        for (version, error) in [
            (3, "Cloud task connection interrupted."),
            (3, "Cloud task request failed (some-other-error)."),
            (
                1,
                "Cloud task request failed (hosted-coding-runtime-required).",
            ),
            (
                2,
                "Cloud task request failed (hosted-coding-runtime-required).",
            ),
        ] {
            assert_eq!(
                cloud::coding::admission_failed(version, error, || Ok(7)).unwrap(),
                7
            );
        }
        // A superseding Stop/account error from saving remains authoritative.
        let stopped: std::result::Result<(), String> = cloud::coding::admission_failed(
            3,
            "Cloud task request failed (hosted-coding-runtime-required).",
            || Err("The exact Work stopped.".into()),
        );
        assert_eq!(stopped.unwrap_err(), "The exact Work stopped.");
        Ok(())
    });
}

#[test]
fn four_cancelled_preparations_release_slots_but_matching_or_live_preparation_stays_protected() {
    fixture(&store(), |ctx| {
        let (mut target, mut review) = prepared(ctx, false)?;
        let mut retired = 0;
        for cycle in 0..4 {
            let task = TaskIdentity::from_binding(&target.workspace_id, &review.admission.binding)
                .unwrap();
            let snapshot = review
                .admission
                .binding
                .repository
                .as_ref()
                .unwrap()
                .snapshot
                .clone();
            assert!(!crate::collaboration::hosted_repository::retire_at(
                ctx,
                &task,
                &snapshot,
                || {
                    retired += 1;
                    Ok(())
                }
            )?);
            let preparing =
                crate::local_computer::coding::hosted_repository::preparing(&task).unwrap();
            // Same native transaction as cancel_review: invalidate the old
            // held review before any source custody can be reclaimed.
            queue::hold(ctx, &target.work_id, target.expected_generation, false)?;
            let mut item = ctx.item(&target.work_id)?;
            item.hosted_task = None;
            ctx.work(&item)?;
            assert!(!crate::collaboration::hosted_repository::retire_at(
                ctx,
                &task,
                &snapshot,
                || {
                    retired += 1;
                    Ok(())
                }
            )?);
            drop(preparing);
            assert!(crate::collaboration::hosted_repository::retire_at(
                ctx,
                &task,
                &snapshot,
                || {
                    retired += 1;
                    Ok(())
                }
            )?);
            let request = Prepare {
                workspace_id: target.workspace_id.clone(),
                agent_id: target.agent_id.clone(),
                work_id: target.work_id.clone(),
                expected_generation: item.generation,
                credential_id: "credential-unit".into(),
                credential_revision: 1,
                mode: Some("offline-coding".into()),
                web_scope: None,
                selected_paths: Some(vec!["main.ts".into()]),
                writable_paths: Some(vec![]),
                checks: Some(vec![]),
            };
            queue::hold(ctx, &item.id, item.generation, true)?;
            let mut request = request;
            request.expected_generation = ctx.item(&item.id)?.generation;
            let next = TaskIdentity {
                work_generation: request.expected_generation,
                task_id: format!("task-coding-cycle-{cycle}"),
                run_id: format!("cloud-run-cycle-{cycle}"),
                ..task
            };
            let repo = review.admission.binding.repository.clone().unwrap();
            review = prepare_at(
                ctx,
                &request,
                &HostedComputerScope {
                    workspace_id: "cloud-workspace".into(),
                    device_id: "device-unit".into(),
                },
                4,
                "https://tasks.example.test",
                &[ProviderConnection {
                    credential_id: "credential-unit".into(),
                    provider_id: "openai".into(),
                    revision: 1,
                    enabled: true,
                    created_at: 1,
                    updated_at: 1,
                    expires_at: chrono::Utc::now().timestamp_millis() + 100000,
                }],
                false,
                &next,
                repo,
            )?;
            target = request.target();
        }
        assert_eq!(retired, 4);
        assert_eq!(
            ctx.item(&target.work_id)?
                .hosted_task
                .as_ref()
                .unwrap()
                .phase,
            "review"
        );
        Ok(())
    });
}
#[test]
fn retention_keeps_uncertain_import_and_scope_states_until_exact_terminal_acknowledgement() {
    fixture(&store(), |ctx| {
        let (target, review) = prepared(ctx, true)?;
        let _gate = cloud::dispatch::AdmissionGuard::retain(&review.admission.binding);
        let saved = claim_at(ctx, &target, &review.review_id)?;
        let task =
            TaskIdentity::from_binding(&target.workspace_id, &saved.admission.binding).unwrap();
        let snapshot = saved
            .admission
            .binding
            .repository
            .as_ref()
            .unwrap()
            .snapshot
            .clone();
        assert!(!crate::collaboration::hosted_repository::retire_at(
            ctx,
            &task,
            &snapshot,
            || panic!("running snapshot retired")
        )?);
        super::super::result_at(ctx, &target, Some(completed(&saved, true, false)))?;
        let original = ctx.item(&target.work_id)?;
        for phase in [
            "awaiting-import",
            "scope-change-required",
            "stop-pending",
            "reconcile-required",
            "dispatching",
            "accepted",
        ] {
            let mut item = original.clone();
            item.hosted_task.as_mut().unwrap().phase = phase.into();
            ctx.work(&item)?;
            assert!(!crate::collaboration::hosted_repository::retire_at(
                ctx,
                &task,
                &snapshot,
                || panic!("nonterminal snapshot retired")
            )?);
        }
        ctx.work(&original)?;
        let (_, next) = stop_at(ctx, &target)?;
        assert_eq!(
            next.unwrap().expected_generation,
            target.expected_generation + 1
        );
        assert!(!crate::collaboration::hosted_repository::retire_at(
            ctx,
            &task,
            &snapshot,
            || panic!("unacknowledged Stop retired")
        )?);
        Ok(())
    });
    fixture(&store(), |ctx| {
        let (target, review) = prepared(ctx, true)?;
        let _gate = cloud::dispatch::AdmissionGuard::retain(&review.admission.binding);
        let saved = claim_at(ctx, &target, &review.review_id)?;
        let task =
            TaskIdentity::from_binding(&target.workspace_id, &saved.admission.binding).unwrap();
        let snapshot = saved
            .admission
            .binding
            .repository
            .as_ref()
            .unwrap()
            .snapshot
            .clone();
        let (_, next) = stop_at(ctx, &target)?;
        let target = next.unwrap();
        // Authenticated cancellation is a later sequence, with no output or
        // retained proposal, before any completed output. An already completed
        // server result cannot be rewritten as a successful cancellation.
        let mut ack = completed(&saved, true, false);
        ack.snapshot.status = "cancelled".into();
        ack.snapshot.generation += 1;
        ack.snapshot.sequence += 1;
        ack.snapshot.coding = None;
        ack.snapshot.result_sha256 = None;
        ack.snapshot.result_bytes = 0;
        ack.text.clear();
        super::super::result_at(ctx, &target, Some(ack))?;
        assert!(crate::collaboration::hosted_repository::retire_at(
            ctx,
            &task,
            &snapshot,
            || Ok(())
        )?);
        Ok(())
    });
}
#[test]
fn completed_retention_requires_exact_native_provenance_and_reconciled_unchanged_output() {
    fixture(&store(), |ctx| {
        let (target, review) = prepared(ctx, false)?;
        let _gate = cloud::dispatch::AdmissionGuard::retain(&review.admission.binding);
        let saved = claim_at(ctx, &target, &review.review_id)?;
        let task =
            TaskIdentity::from_binding(&target.workspace_id, &saved.admission.binding).unwrap();
        let snapshot = saved
            .admission
            .binding
            .repository
            .as_ref()
            .unwrap()
            .snapshot
            .clone();
        super::super::result_at(ctx, &target, Some(completed(&saved, false, false)))?;
        assert!(crate::collaboration::hosted_repository::retire_at(
            ctx,
            &task,
            &snapshot,
            || Ok(())
        )?);
        let mut wrong = task.clone();
        wrong.run_id = "different-run".into();
        assert!(!crate::collaboration::hosted_repository::retire_at(
            ctx,
            &wrong,
            &snapshot,
            || panic!("wrong run retired")
        )?);
        wrong = task.clone();
        wrong.work_generation += 1;
        assert!(!crate::collaboration::hosted_repository::retire_at(
            ctx,
            &wrong,
            &snapshot,
            || panic!("wrong generation retired")
        )?);
        let mut wrong_scope = task;
        wrong_scope.local_workspace_id = "other-workspace".into();
        assert!(!crate::collaboration::hosted_repository::retire_at(
            ctx,
            &wrong_scope,
            &snapshot,
            || panic!("wrong account workspace retired")
        )?);
        Ok(())
    });
}
