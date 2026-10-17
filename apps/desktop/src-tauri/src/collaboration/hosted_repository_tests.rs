//! Authored canonical Work fixtures, not live cloud receipts.
use super::*;
use crate::hosted_tasks::models::Binding;
use crate::local_computer::coding::hosted_repository::{ImportReceipt, Snapshot};
use sha2::{Digest, Sha256};

fn parked(ctx: &Context<'_>) -> Result<(TaskIdentity, Binding, Snapshot)> {
    let room = chats::open_main(ctx, "lead")?;
    work::start(
        ctx,
        "work-hosted-files".into(),
        room.id.clone(),
        "lead".into(),
        "Repair the selected source.".into(),
        false,
        None,
        None,
    )?;
    let mut item = ctx.item("work-hosted-files")?;
    let file_hash = hex::encode(Sha256::digest(b"source"));
    let mut tree = Sha256::new();
    tree.update(7u64.to_le_bytes());
    tree.update(b"main.ts");
    tree.update(hex::decode(&file_hash).unwrap());
    let mut value = serde_json::json!({"version":1,"snapshotId":"a".repeat(48),"repositoryId":"b".repeat(48),"branch":"main","baseCommit":"c".repeat(40),"inputTreeId":hex::encode(tree.finalize()),"files":[{"path":"main.ts","sha256":file_hash,"sizeBytes":6}],"writablePaths":["main.ts"],"totalBytes":6});
    value["manifestSha256"] = serde_json::json!(crate::hosted_tasks::digest_value(&value).unwrap());
    let snapshot: Snapshot = serde_json::from_value(value).unwrap();
    item.repository_binding = Some(crate::local_computer::coding::RepositoryWorkBinding {
        version: 1,
        repository_id: snapshot.repository_id.clone(),
        branch: snapshot.branch.clone(),
        base_commit: snapshot.base_commit.clone(),
        captured_at: ctx.time.into(),
    });
    item.status = WorkStatus::AwaitingUser;
    item.awaiting_user = true;
    item.execution_owner = Some("hosted".into());
    item.current_run_id = Some("cloud-run-files".into());
    item.run_ids.push("cloud-run-files".into());
    let head = thread::get(ctx.conn, ctx.store, &ctx.scope.data, &room.id)?.unwrap();
    let binding:Binding=serde_json::from_value(serde_json::json!({"version":3,"mode":"offline-coding","repository":{"snapshot":snapshot,"scope":{"writablePaths":["main.ts"],"checks":[],"image":"coding@sha256:fixed-fixture","network":"disabled"}},"taskId":"cloud-task-files","admissionId":"cloud-admit-files","runId":"cloud-run-files","workspaceId":"cloud-workspace","agentId":item.agent_id,"workId":item.id,"workGeneration":item.generation,"conversationId":item.conversation_id,"conversationGeneration":item.conversation_generation,"expectedHeadId":head.last_message_id,"expectedSequence":head.last_sequence,"inputSha256":"d".repeat(64),"providerId":"openai","model":"fixture-model","credentialId":"credential-fixture","credentialRevision":1,"budget":{"maxModelCalls":1,"maxOutputTokens":4096,"maxElapsedMs":120000,"maxResultBytes":65536,"maxToolCalls":8},"expiresAt":9000000000000i64})).unwrap();
    item.hosted_task = Some(
        serde_json::from_value(
            serde_json::json!({"version":1,"binding":binding,"phase":"awaiting-import"}),
        )
        .unwrap(),
    );
    ctx.work(&item)?;
    let task = TaskIdentity::from_binding(ctx.scope.data.workspace_id(), &binding).unwrap();
    Ok((task, binding, snapshot))
}
#[test]
fn parked_coding_review_does_not_authorize_export_and_stop_retires_import() {
    super::super::tests::fixture(&super::super::tests::store(), |ctx| {
        let (task, _, _) = parked(ctx)?;
        current_at(ctx, &task, true, true)?;
        assert!(
            current_at(ctx, &task, true, false).is_err(),
            "AwaitingUser permits explicit review, never source egress"
        );
        let mut wrong = task.clone();
        wrong.run_id = "cloud-other-run".into();
        assert!(current_at(ctx, &wrong, true, true).is_err());
        let mut item = ctx.item(&task.work_id)?;
        let before = item.clone();
        item.repository_binding.as_mut().unwrap().repository_id = "e".repeat(48);
        ctx.work(&item)?;
        assert!(
            current_at(ctx, &task, true, true).is_err(),
            "a new Library copy cannot substitute for the admitted snapshot"
        );
        ctx.work(&before)?;
        let mut changed_room = ctx.room(&before.conversation_id)?;
        changed_room.generation += 1;
        ctx.conversation(&changed_room)?;
        assert!(
            current_at(ctx, &task, true, true).is_err(),
            "conversation change blocks import"
        );
        changed_room.generation -= 1;
        ctx.conversation(&changed_room)?;
        work::invalidate_descendants(ctx, &task.work_id, "Stopped", WorkStatus::Cancelled)?;
        assert!(current_at(ctx, &task, true, true).is_err());
        assert!(ctx.item(&task.work_id)?.generation > task.work_generation);
        Ok(())
    });
}
#[test]
fn import_completion_requires_exact_namespaced_native_receipt_not_cloud_success() {
    super::super::tests::fixture(&super::super::tests::store(), |ctx| {
        let (task, binding, snapshot) = parked(ctx)?;
        let output = "d".repeat(64);
        assert!(verified_import_receipt(ctx, &binding, &snapshot.snapshot_id, &output)?.is_none());
        let receipt = ImportReceipt {
            snapshot_id: snapshot.snapshot_id.clone(),
            repository_id: snapshot.repository_id.clone(),
            output_manifest_sha256: output.clone(),
            output_tree_id: "e".repeat(64),
            before_import_checkpoint_id: "f".repeat(48),
            verification_invalidated: true,
        };
        let saved = Imported {
            task,
            snapshot: snapshot.clone(),
            receipt: receipt.clone(),
        };
        ctx.put(Kind::Receipt, &binding.work_id, None, None, &saved)?;
        assert!(
            verified_import_receipt(ctx, &binding, &snapshot.snapshot_id, &output)?.is_none(),
            "ordinary Work receipt keys grant no import completion"
        );
        ctx.put(
            Kind::Receipt,
            &format!("hosted-repository-import:{}", snapshot.snapshot_id),
            None,
            None,
            &saved,
        )?;
        assert_eq!(
            verified_import_receipt(ctx, &binding, &snapshot.snapshot_id, &output)?,
            Some(receipt)
        );
        assert!(
            verified_import_receipt(ctx, &binding, &snapshot.snapshot_id, &"0".repeat(64)).is_err()
        );
        let mut stale = binding.clone();
        stale.run_id = "other-run".into();
        assert!(verified_import_receipt(ctx, &stale, &snapshot.snapshot_id, &output).is_err());
        let mut item = ctx.item(&binding.work_id)?;
        item.generation += 1;
        ctx.work(&item)?;
        assert!(verified_import_receipt(ctx, &binding, &snapshot.snapshot_id, &output).is_err());
        Ok(())
    });
}
