use super::*;

#[test]
fn empty_conversation_has_an_empty_selected_path() {
    fixture(&store(), |ctx| {
        let room = chats::open_main(ctx, "lead")?;
        assert!(message::list_selected(ctx.conn, ctx.store, &ctx.scope.data, &room.id)?.is_empty());
        context::capture(ctx, &room, profile(ctx.profiles, "lead")?)?;
        Ok(())
    });
}

fn user(
    ctx: &Context<'_>,
    room: &str,
    id: &str,
    text: &str,
    parent: Option<Option<&str>>,
) -> Result<()> {
    let head = thread::get(ctx.conn, ctx.store, &ctx.scope.data, room)?.unwrap();
    message::append_with_parent(
        ctx.conn,
        ctx.store,
        &ctx.scope.data,
        room,
        id,
        "user",
        &json!({}),
        None,
        head.last_sequence + 1,
        head.last_sequence,
        head.last_message_id.as_deref(),
        parent,
        id,
        &format!("revision-{id}"),
        "terminal",
        "initial",
        &json!({"text":text}),
        TIME,
    )?;
    Ok(())
}

#[test]
fn branch_edit_captures_only_ancestors_and_keeps_alternatives_durable() {
    let store = store();
    let room_id = fixture(&store, |ctx| {
        let room = chats::open_main(ctx, "lead")?;
        user(ctx, &room.id, "original", "Original request", None)?;
        output(
            ctx,
            &room.id,
            "old-answer",
            "Later answer must not enter edit",
        )?;
        let before = context::capture_for_edit(
            ctx,
            &room,
            profile(ctx.profiles, "lead")?,
            Some("original"),
        )?;
        let body: serde_json::Value = serde_json::from_str(&before.text).unwrap();
        assert_eq!(body["history"], json!([]));
        assert!(!before.text.contains("Later answer must not enter edit"));
        let parent =
            message::edit_parent(ctx.conn, ctx.store, &ctx.scope.data, &room.id, "original")?;
        assert!(parent.is_none());
        user(
            ctx,
            &room.id,
            "alternative",
            "Edited request",
            Some(parent.as_deref()),
        )?;
        let selected = message::list_selected(ctx.conn, ctx.store, &ctx.scope.data, &room.id)?;
        assert_eq!(
            selected
                .iter()
                .map(|row| row.id.as_str())
                .collect::<Vec<_>>(),
            vec!["alternative"]
        );
        assert_eq!(
            message::list(ctx.conn, ctx.store, &ctx.scope.data, &room.id)?.len(),
            3
        );
        thread::select_head(
            ctx.conn,
            ctx.store,
            &ctx.scope.data,
            &room.id,
            Some("message-old-answer"),
            TIME,
        )?;
        Ok(room.id)
    });
    fixture(&store, |ctx| {
        let selected = message::list_selected(ctx.conn, ctx.store, &ctx.scope.data, &room_id)?;
        assert_eq!(
            selected
                .iter()
                .map(|row| row.id.as_str())
                .collect::<Vec<_>>(),
            vec!["original", "message-old-answer"]
        );
        user(ctx, &room_id, "continue", "Continue original", None)?;
        let rows = message::list_selected(ctx.conn, ctx.store, &ctx.scope.data, &room_id)?;
        assert_eq!(
            rows.last().unwrap().parent_message_id.as_deref(),
            Some("message-old-answer")
        );
        assert!(!rows.iter().any(|row| row.id == "alternative"));
        Ok(())
    });
}

#[test]
fn branch_admission_blocks_active_or_unreconciled_work_and_rejects_source_reuse() {
    fixture(&store(), |ctx| {
        let room = chats::open_main(ctx, "lead")?;
        user(ctx, &room.id, "original", "Request", None)?;
        work::start(
            ctx,
            "running".into(),
            room.id.clone(),
            "lead".into(),
            "Start".into(),
            false,
            None,
            None,
        )?;
        assert!(
            crate::collaboration::ensure_conversation_idle(ctx.conn, ctx.store, &room.id).is_err()
        );
        assert!(work::start_with_parent(
            ctx,
            "edit".into(),
            room.id.clone(),
            "lead".into(),
            "Edit".into(),
            false,
            None,
            Some("original"),
            None
        )
        .is_err());
        let mut item = ctx.item("running")?;
        item.status = WorkStatus::Blocked;
        item.run_ids = vec!["uncertain-run".into()];
        ctx.work(&item)?;
        assert!(work::start_with_parent(
            ctx,
            "edit".into(),
            room.id.clone(),
            "lead".into(),
            "Edit".into(),
            false,
            None,
            Some("original"),
            None
        )
        .is_err());
        item.status = WorkStatus::Completed;
        ctx.work(&item)?;
        work::start_with_parent(
            ctx,
            "edit".into(),
            room.id.clone(),
            "lead".into(),
            "Edit".into(),
            false,
            None,
            Some("original"),
            None,
        )?;
        assert!(work::start_with_parent(
            ctx,
            "edit".into(),
            room.id,
            "lead".into(),
            "Edit".into(),
            false,
            None,
            None,
            None
        )
        .is_err());
        Ok(())
    });
}

#[test]
fn explicit_live_chat_share_captures_only_selected_branch_text() {
    fixture(&store(), |ctx| {
        project(ctx, "shared-project", "project-chat")?;
        let room = chats::open_main(ctx, "lead")?;
        user(ctx, &room.id, "original", "Original request", None)?;
        output(ctx, &room.id, "original-answer", "Original selected answer")?;
        user(
            ctx,
            &room.id,
            "alternative",
            "Alternative request",
            Some(None),
        )?;
        output(
            ctx,
            &room.id,
            "alternative-answer",
            "Alternative selected answer",
        )?;
        let mut shared =
            local_project::get_project(ctx.conn, ctx.store, &ctx.scope.private, "shared-project")?
                .unwrap();
        shared.payload["shares"] = json!([{"id":"live-chat","mode":"live-reference","source":{"workspaceId":ctx.scope.data.workspace_id(),"kind":"conversation","id":room.id},"sourceRevision":"","recipient":{"kind":"agent","id":"lead"},"owner":{"kind":"user","name":"You"},"title":"Shared selected branch","createdAt":TIME}]);
        let capture =
            crate::local_projects::capture_shares(ctx.conn, ctx.store, ctx.scope, &shared, "lead")?;
        assert!(capture[0]["text"]
            .as_str()
            .unwrap()
            .contains("Alternative selected answer"));
        assert!(!capture[0]["text"]
            .as_str()
            .unwrap()
            .contains("Original selected answer"));
        thread::select_head(
            ctx.conn,
            ctx.store,
            &ctx.scope.data,
            &room.id,
            Some("message-original-answer"),
            TIME,
        )?;
        let capture =
            crate::local_projects::capture_shares(ctx.conn, ctx.store, ctx.scope, &shared, "lead")?;
        assert!(capture[0]["text"]
            .as_str()
            .unwrap()
            .contains("Original selected answer"));
        assert!(!capture[0]["text"]
            .as_str()
            .unwrap()
            .contains("Alternative selected answer"));
        Ok(())
    });
}
