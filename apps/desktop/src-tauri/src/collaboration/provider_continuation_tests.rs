use super::*;
use crate::collaboration::provider_continuation::{self as continuation, Input};

fn request(room: &str) -> Input {
    Input {
        conversation_id: room.into(),
        agent_id: "lead".into(),
        model_option_id: "openai::fixture-model".into(),
        prompt: "  Continue the task exactly.\n".into(),
        context_window: Some(32_768),
    }
}

#[allow(clippy::too_many_arguments)]
fn append(
    ctx: &Context<'_>,
    room: &str,
    key: &str,
    kind: &str,
    state: &str,
    detail: serde_json::Value,
    text: &str,
) -> Result<()> {
    let thread = thread::get(ctx.conn, ctx.store, &ctx.scope.data, room)?.unwrap();
    message::append(
        ctx.conn,
        ctx.store,
        &ctx.scope.data,
        room,
        key,
        kind,
        &detail,
        None,
        thread.last_sequence + 1,
        thread.last_sequence,
        thread.last_message_id.as_deref(),
        key,
        &format!("rev-{key}"),
        state,
        "fixture",
        &json!({"text":text}),
        TIME,
    )?;
    Ok(())
}

#[test]
fn provider_continuation_preserves_roles_order_partial_text_and_excludes_authority() {
    fixture(&store(), |ctx| {
        let room = chats::open_main(ctx, "lead")?;
        append(
            ctx,
            &room.id,
            "original",
            "user",
            "terminal",
            json!({"attachments":[{"id":"missing"}]}),
            "Never publish. Keep original constraints.",
        )?;
        append(
            ctx,
            &room.id,
            "partial",
            "assistant",
            "streaming",
            json!({}),
            "Unfinished public reply",
        )?;
        append(
            ctx,
            &room.id,
            "approval",
            "approval",
            "terminal",
            json!({}),
            "AUTHORITY_CANARY",
        )?;
        append(
            ctx,
            &room.id,
            "call",
            "tool",
            "terminal",
            json!({"phase":"call","toolName":"repository-run"}),
            "CALL_CANARY",
        )?;
        append(
            ctx,
            &room.id,
            "result",
            "tool",
            "terminal",
            json!({"phase":"result","toolName":"repository-run"}),
            "Exit code 1: type error",
        )?;
        append(
            ctx,
            &room.id,
            "other-tool",
            "tool",
            "terminal",
            json!({"phase":"result","toolName":"read-secret"}),
            "TOOL_CANARY",
        )?;
        append(
            ctx,
            &room.id,
            "redacted",
            "assistant",
            "redacted",
            json!({}),
            "REDACTED_CANARY",
        )?;
        let (preview, capture) = continuation::prepare(ctx, &request(&room.id))?;
        assert_eq!(
            preview
                .messages
                .iter()
                .map(|m| m.message_id.as_str())
                .collect::<Vec<_>>(),
            ["original", "partial", "result"]
        );
        assert_eq!(preview.messages[0].role, "user");
        assert_eq!(preview.messages[1].state, "streaming");
        assert_eq!(preview.messages[2].role, "assistant");
        assert_eq!(preview.attachment_count, 1);
        assert!(!capture.text.contains("Unfinished public"));
        let text = serde_json::to_string(&preview).unwrap();
        for excluded in [
            "AUTHORITY_CANARY",
            "CALL_CANARY",
            "TOOL_CANARY",
            "REDACTED_CANARY",
        ] {
            assert!(!text.contains(excluded));
        }
        Ok(())
    });
}

#[test]
fn provider_continuation_budget_keeps_whole_records_original_and_recent() {
    fixture(&store(), |ctx| {
        let room = chats::open_main(ctx, "lead")?;
        append(
            ctx,
            &room.id,
            "constraint",
            "user",
            "terminal",
            json!({}),
            "Original constraint",
        )?;
        for i in 0..40 {
            append(
                ctx,
                &room.id,
                &format!("m-{i}"),
                "assistant",
                "terminal",
                json!({}),
                &format!("{i}: {}", "x".repeat(900)),
            )?;
        }
        let (preview, _) = continuation::prepare(ctx, &request(&room.id))?;
        assert!(preview.omitted_count > 0);
        assert!(preview.history_bytes <= preview.budget_bytes);
        assert_eq!(preview.messages[0].text, "Original constraint");
        assert_eq!(preview.messages.last().unwrap().message_id, "m-39");
        assert!(preview.messages[1..].iter().all(|m| m.text.len() >= 903));
        let mut smaller = request(&room.id);
        smaller.context_window = Some(14_000);
        let small = continuation::prepare(ctx, &smaller)?;
        assert!(small.0.messages.len() < preview.messages.len());
        smaller.context_window = Some(512);
        assert!(continuation::prepare(ctx, &smaller).is_err());
        smaller.context_window = None;
        let unknown = continuation::prepare(ctx, &smaller)?.0;
        assert_eq!(unknown.context_window, 32_768);
        assert_eq!(unknown.capacity_source, "conservative-fallback");
        Ok(())
    });
}

#[test]
fn provider_continuation_native_admission_is_durable_exact_and_single_use() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("continuation.db");
    let key = MasterKey::generate().unwrap();
    let store = Store::open(&path, Vault::new(&key).unwrap()).unwrap();
    let (id, fingerprint, original) = fixture(&store, |ctx| {
        let room = chats::open_main(ctx, "lead")?;
        output(ctx, &room.id, "prior", "Saved answer")?;
        let input = request(&room.id);
        let (preview, _) = continuation::prepare(ctx, &input)?;
        continuation::start(ctx, "portable-work", &input, &preview.fingerprint, true)?;
        continuation::start(ctx, "portable-work", &input, &preview.fingerprint, true)?;
        assert_eq!(ctx.all_work()?.len(), 1);
        assert!(continuation::start(ctx, "duplicate", &input, &preview.fingerprint, true).is_err());
        Ok((room.id, preview.fingerprint, input.prompt))
    });
    drop(store);
    let store = Store::open(&path, Vault::new(&key).unwrap()).unwrap();
    fixture(&store, |ctx| {
        let saved = ctx.item("portable-work")?;
        assert_eq!(saved.user_request, original);
        assert_eq!(saved.prompt, original);
        assert_eq!(saved.conversation_id, id);
        assert_eq!(saved.continuation.unwrap().fingerprint, fingerprint);
        assert!(saved.attachments.is_empty());
        assert_eq!(saved.status, WorkStatus::Queued);
        Ok(())
    });
    fixture(&store, |ctx| {
        bind(ctx, "portable-work", "interrupted-continuation")?;
        Ok(())
    });
    drop(store);
    let store = Store::open(&path, Vault::new(&key).unwrap()).unwrap();
    crate::execution_attempts::recover_interrupted_attempts_in_store(&store, TIME).unwrap();
    fixture(&store, |ctx| {
        let saved = ctx.item("portable-work")?;
        assert_eq!(saved.status, WorkStatus::AwaitingUser);
        assert_eq!(saved.generation, 2);
        assert_eq!(saved.current_run_id, None);
        assert_eq!(saved.continuation.unwrap().fingerprint, fingerprint);
        assert!(ensure_run_current(ctx.conn, ctx.store, Some("interrupted-continuation")).is_err());
        Ok(())
    });
}

#[test]
fn provider_continuation_rejects_stale_preview_model_stop_and_cross_scope() {
    fixture(&store(), |ctx| {
        let room = chats::open_main(ctx, "lead")?;
        let input = request(&room.id);
        let preview = continuation::prepare(ctx, &input)?.0;
        output(ctx, &room.id, "new", "New saved message")?;
        assert!(continuation::start(ctx, "stale", &input, &preview.fingerprint, true).is_err());
        assert!(
            continuation::start(ctx, "unreviewed", &input, &preview.fingerprint, false).is_err()
        );
        let mut wrong = input.clone();
        wrong.model_option_id = "different::model".into();
        assert!(continuation::prepare(ctx, &wrong).is_err());
        wrong = input.clone();
        wrong.agent_id = "researcher".into();
        assert!(continuation::prepare(ctx, &wrong).is_err());
        wrong = input.clone();
        wrong.conversation_id = "another-account".into();
        assert!(continuation::prepare(ctx, &wrong).is_err());
        let sibling = chats::open_main(ctx, "researcher")?;
        output(ctx, &sibling.id, "private", "SIBLING_CANARY")?;
        let preview = continuation::prepare(ctx, &input)?.0;
        assert!(!serde_json::to_string(&preview)
            .unwrap()
            .contains("SIBLING_CANARY"));
        continuation::start(ctx, "stopped", &input, &preview.fingerprint, true)?;
        work::invalidate_descendants(ctx, "stopped", "Stop", WorkStatus::Cancelled)?;
        assert!(
            continuation::start(ctx, "stale-after-stop", &input, &preview.fingerprint, true)
                .is_err()
        );
        Ok(())
    });
}

#[test]
fn provider_continuation_retrieval_is_paged_bound_to_work_and_stops_immediately() {
    fixture(&store(), |ctx| {
        let room = chats::open_main(ctx, "lead")?;
        append(
            ctx,
            &room.id,
            "long-source",
            "user",
            "terminal",
            json!({}),
            &"界".repeat(9_000),
        )?;
        let input = request(&room.id);
        let preview = continuation::prepare(ctx, &input)?.0;
        assert!(preview.messages.is_empty());
        continuation::start(ctx, "retrieve", &input, &preview.fingerprint, true)?;
        bind(ctx, "retrieve", "new-run")?;
        let read = |sequence, offset| {
            super::super::provider_continuation_read::read(
                ctx, "retrieve", 1, "new-run", sequence, offset,
            )
        };
        let first = read(1, 0)?;
        assert_eq!(
            first["message"]["text"].as_str().unwrap().chars().count(),
            4_000
        );
        assert_eq!(first["nextSequence"], 1);
        assert_eq!(first["nextTextOffset"], 4_000);
        let last = read(1, 8_000)?;
        assert_eq!(
            last["message"]["text"].as_str().unwrap().chars().count(),
            1_000
        );
        assert_eq!(last["nextSequence"], 2);
        assert!(read(2, 0)?["message"].is_null());
        assert!(read(1, 10_000).is_err());
        assert!(super::super::provider_continuation_read::read(
            ctx,
            "retrieve",
            1,
            "wrong-run",
            1,
            0
        )
        .is_err());
        ctx.conn.execute(
            "UPDATE message SET deleted_at=?1 WHERE id='long-source'",
            [TIME],
        )?;
        assert!(read(1, 0).is_err());
        work::invalidate_descendants(ctx, "retrieve", "Stopped", WorkStatus::Cancelled)?;
        assert!(read(1, 0).is_err());
        Ok(())
    });
}
