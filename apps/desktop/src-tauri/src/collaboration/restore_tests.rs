use super::*;
use crate::store::vault::{MasterKey, Vault};

fn fixture(f: impl FnOnce(&Context<'_>, &str) -> Result<()>) {
    let store =
        Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap();
    store.transaction(|conn| {
        let scope = authorized_scope::resolve(conn, None, None, ScopeAccess::Write)?;
        let profiles = vec![serde_json::from_value(json!({"id":"lead","name":"Lead","instructions":"Fixture","modelId":"openai::fixture","icon":"sparkle","permissionLabel":"Ask Me"})).unwrap()];
        let ctx = Context { conn, store: &store, scope: &scope, profiles: &profiles, time: "2026-10-17T00:00:00Z" };
        let room = chats::open_main(&ctx, "lead")?;
        message::append_with_parent(conn, &store, &scope.data, &room.id, "user-one", "user", &json!({}), Some("run-one"), 1, 0, None, Some(None), "user-one", "revision-one", "terminal", "initial", &json!("Change the site"), ctx.time)?;
        f(&ctx, &room.id)
    }).unwrap();
}
fn intent(room: &str) -> Intent {
    let checkpoint = Checkpoint {
        id: "a".repeat(48),
        repository_id: "b".repeat(48),
        label: "Before task".into(),
        tree_id: "c".repeat(64),
        head: "d".repeat(40),
        created_at: "2026-10-17T00:00:00Z".into(),
        bytes: 1,
        file_count: 1,
        request_id: "capture-request".into(),
        generation: 1,
        reason: "before-task".into(),
    };
    Intent {
        id: "fixture-intent".into(),
        approval_request_id: "approval-one".into(),
        state: "files-restored".into(),
        before_restore_checkpoint_id: Some("e".repeat(48)),
        file_receipt_tree: Some("f".repeat(64)),
        selected_head_id: None,
        finish_expected_head_id: None,
        finish_expected_last_sequence: None,
        review: Review {
            id: "preview-one".into(),
            expected_head_id: Some("user-one".into()),
            expected_last_sequence: 1,
            computer_generation: 1,
            checkpoint: json!({"outputTreeId":"f".repeat(64)}),
            direction: "restore".into(),
            reverts_intent_id: None,
            point: Point {
                id: "point-one".into(),
                workspace_id: "default".into(),
                conversation_id: room.into(),
                agent_id: "lead".into(),
                work_id: "work-one".into(),
                work_generation: 1,
                run_id: "run-one".into(),
                target_head_id: None,
                request_message_id: Some("user-one".into()),
                label: "Change site".into(),
                created_at: "2026-10-17T00:00:00Z".into(),
                scope_id: "native-scope".into(),
                repository: RepositoryWorkBinding {
                    version: 1,
                    repository_id: "b".repeat(48),
                    branch: "codex/task".into(),
                    base_commit: "d".repeat(40),
                    captured_at: "2026-10-17T00:00:00Z".into(),
                },
                checkpoint,
            },
        },
    }
}
#[test]
fn first_turn_restore_creates_an_explicit_empty_root_and_retains_original_history() {
    fixture(|ctx, room| {
        let intent = intent(room);
        let selected = select_target(ctx.conn, ctx.store, ctx.scope, room, &intent)?;
        let visible = message::list_selected(ctx.conn, ctx.store, &ctx.scope.data, room)?;
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].id, selected);
        assert_eq!(visible[0].kind, "interruption");
        assert!(visible[0].parent_message_id.is_none());
        assert_eq!(
            message::list(ctx.conn, ctx.store, &ctx.scope.data, room)?.len(),
            2
        );
        assert_eq!(
            thread::get(ctx.conn, ctx.store, &ctx.scope.data, room)?
                .unwrap()
                .selected_head_id,
            Some(selected)
        );
        Ok(())
    });
}
#[test]
fn conversation_step_requires_exact_native_file_receipt_and_is_never_replayed() {
    fixture(|ctx, room| {
        let mut pending = intent(room);
        pending.state = "prepared".into();
        pending.file_receipt_tree = None;
        assert!(select_target(ctx.conn, ctx.store, ctx.scope, room, &pending).is_err());
        assert_eq!(
            message::list_selected(ctx.conn, ctx.store, &ctx.scope.data, room)?
                .last()
                .unwrap()
                .id,
            "user-one"
        );
        let ready = intent(room);
        select_target(ctx.conn, ctx.store, ctx.scope, room, &ready)?;
        assert!(select_target(ctx.conn, ctx.store, ctx.scope, room, &ready).is_err());
        Ok(())
    });
}
#[test]
fn partial_file_restore_preserves_conversation_when_compare_and_swap_is_stale() {
    fixture(|ctx, room| {
        let mut partial = intent(room);
        partial.review.expected_last_sequence = 0;
        assert!(select_target(ctx.conn, ctx.store, ctx.scope, room, &partial).is_err());
        assert_eq!(
            thread::get(ctx.conn, ctx.store, &ctx.scope.data, room)?
                .unwrap()
                .selected_head_id
                .as_deref(),
            Some("user-one")
        );
        assert_eq!(partial.state, "files-restored");
        Ok(())
    });
}
#[test]
fn recovery_ledger_is_account_scoped_and_retains_partial_intent_receipts() {
    fixture(|ctx, room| {
        let partial = intent(room);
        let saved = Ledger {
            points: vec![partial.review.point.clone()],
            intents: vec![partial],
            review: None,
        };
        save(ctx.conn, ctx.store, ctx.scope, room, &saved)?;
        let restored = ledger(ctx.conn, ctx.store, ctx.scope, room)?;
        assert!(outstanding(&restored));
        assert_eq!(
            restored.intents[0].before_restore_checkpoint_id,
            Some("e".repeat(48))
        );
        let other = crate::store::repos::scope::PrivateDataScope::for_authenticated_user(
            ctx.scope.data.clone(),
            "other-account",
            Some("other-member"),
        )?;
        assert!(ui_repo::get::<Ledger>(ctx.conn, ctx.store, &other, room, KEY)?.is_none());
        Ok(())
    });
}

#[test]
fn continued_turn_anchor_preserves_prior_results_without_inventing_a_new_user_message() {
    fixture(|ctx, room| {
        message::append_with_parent(
            ctx.conn,
            ctx.store,
            &ctx.scope.data,
            room,
            "prior-result",
            "assistant",
            &json!({}),
            Some("run-one"),
            2,
            1,
            Some("user-one"),
            None,
            "prior-result",
            "prior-revision",
            "terminal",
            "initial",
            &json!("First section complete"),
            ctx.time,
        )?;
        let before = message::list_selected(ctx.conn, ctx.store, &ctx.scope.data, room)?;
        assert_eq!(
            capture_anchor(&before, "run-two", &["run-one".into()]),
            (Some("user-one".into()), Some("prior-result".into()))
        );
        message::append_with_parent(
            ctx.conn,
            ctx.store,
            &ctx.scope.data,
            room,
            "current-read",
            "tool",
            &json!({}),
            Some("run-two"),
            3,
            2,
            Some("prior-result"),
            None,
            "current-read",
            "read-revision",
            "terminal",
            "initial",
            &json!("Read-only inspection"),
            ctx.time,
        )?;
        let during = message::list_selected(ctx.conn, ctx.store, &ctx.scope.data, room)?;
        assert_eq!(
            capture_anchor(&during, "run-two", &["run-one".into()]),
            (Some("user-one".into()), Some("prior-result".into()))
        );
        assert_eq!(
            capture_anchor(&before, "child-run", &[]),
            (None, Some("prior-result".into()))
        );
        Ok(())
    });
}
