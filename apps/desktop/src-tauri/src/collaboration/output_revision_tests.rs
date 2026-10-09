use super::*;
use crate::outputs::{EnsureInput, OutputSource};

fn source(room: &str) -> OutputSource {
    OutputSource {
        conversation_id: room.into(),
        branch_id: None,
        message_id: None,
        source_revision_id: None,
        artifact_id: None,
        agent_id: Some("lead".into()),
    }
}
fn seed(ctx: &Context<'_>) -> Result<Conversation> {
    let room = chats::open_main(ctx, "lead")?;
    crate::outputs::ensure_output(
        ctx.conn,
        ctx.store,
        ctx.scope,
        EnsureInput {
            id: "output-test".into(),
            title: "Draft".into(),
            format: "markdown".into(),
            mime_type: "text/markdown".into(),
            source: source(&room.id),
            content: "Original".into(),
            author: None,
            reason: None,
        },
    )?;
    Ok(room)
}
#[test]
fn pinned_output_keeps_exact_revision_after_later_edits_and_reopen() {
    let store = store();
    fixture(&store, |ctx| {
        let room = seed(ctx)?;
        crate::outputs::pin_output(
            ctx.conn,
            ctx.store,
            ctx.scope,
            crate::outputs::PinInput {
                output_id: "output-test".into(),
                pinned: true,
                location: Some(source(&room.id)),
                revision_id: Some("output-test-1".into()),
            },
        )?;
        crate::outputs::append_output(
            ctx.conn,
            ctx.store,
            ctx.scope,
            crate::outputs::AppendInput {
                output_id: "output-test".into(),
                expected_revision_id: "output-test-1".into(),
                expected_revision_number: 1,
                content: "Later edit".into(),
                author: "user".into(),
                provenance: crate::outputs::OutputProvenance {
                    source: source(&room.id),
                    reason: "direct-edit".into(),
                },
                revision_id: None,
            },
        )?;
        Ok(())
    });
    fixture(&store, |ctx| {
        let output =
            crate::outputs::read_row(ctx.conn, ctx.store, ctx.scope, "output-test")?.unwrap();
        assert_eq!(output.current_revision_number, 2);
        assert_eq!(output.pin.unwrap().revision_id, "output-test-1");
        assert_eq!(output.revisions[0].content, "Original");
        assert!(crate::outputs::pin_output(
            ctx.conn,
            ctx.store,
            ctx.scope,
            crate::outputs::PinInput {
                output_id: "output-test".into(),
                pinned: true,
                location: None,
                revision_id: Some("missing".into())
            }
        )
        .is_err());
        Ok(())
    });
}
#[test]
fn explicit_output_request_survives_reopen_and_applies_own_run_exactly_once() {
    let store = store();
    let room_id = fixture(&store, |ctx| {
        let room = seed(ctx)?;
        output(
            ctx,
            &room.id,
            "historical",
            "Historical response must not apply",
        )?;
        output_revisions::stage(
            ctx,
            &room,
            "lead",
            "edit-work",
            "output-test",
            "output-test-1",
            1,
            "Revise",
        )?;
        work::start(
            ctx,
            "edit-work".into(),
            room.id.clone(),
            "lead".into(),
            "Revise".into(),
            false,
            None,
            None,
        )?;
        assert!(output_revisions::apply(ctx, &room, "lead", "edit-work")?.is_null());
        bind(ctx, "edit-work", "exact-run")?;
        complete(ctx, "edit-work", "exact-run", "Revised content")?;
        Ok(room.id)
    });
    fixture(&store, |ctx| {
        let room = ctx.room(&room_id)?;
        let applied = output_revisions::apply(ctx, &room, "lead", "edit-work")?;
        assert_eq!(applied["currentRevisionNumber"], 2);
        assert_eq!(applied["revisions"][1]["content"], "Revised content");
        assert_eq!(
            applied["revisions"][1]["provenance"]["messageId"],
            "message-exact-run"
        );
        assert!(output_revisions::apply(ctx, &room, "lead", "edit-work")?.is_null());
        Ok(())
    });
}
#[test]
fn late_agent_revision_cannot_replace_a_newer_user_edit() {
    fixture(&store(), |ctx| {
        let room = seed(ctx)?;
        output_revisions::stage(
            ctx,
            &room,
            "lead",
            "edit-work",
            "output-test",
            "output-test-1",
            1,
            "Revise",
        )?;
        work::start(
            ctx,
            "edit-work".into(),
            room.id.clone(),
            "lead".into(),
            "Revise".into(),
            false,
            None,
            None,
        )?;
        bind(ctx, "edit-work", "exact-run")?;
        crate::outputs::append_output(
            ctx.conn,
            ctx.store,
            ctx.scope,
            crate::outputs::AppendInput {
                output_id: "output-test".into(),
                expected_revision_id: "output-test-1".into(),
                expected_revision_number: 1,
                content: "User's newer draft".into(),
                author: "user".into(),
                provenance: crate::outputs::OutputProvenance {
                    source: source(&room.id),
                    reason: "direct-edit".into(),
                },
                revision_id: None,
            },
        )?;
        complete(ctx, "edit-work", "exact-run", "Late generated content")?;
        let result = output_revisions::apply_pending(ctx, &room, "lead")?;
        assert!(result["outputs"].as_array().unwrap().is_empty());
        assert_eq!(result["errors"].as_array().unwrap().len(), 1);
        let saved =
            crate::outputs::read_row(ctx.conn, ctx.store, ctx.scope, "output-test")?.unwrap();
        assert_eq!(saved.revisions.len(), 2);
        assert_eq!(saved.revisions[1].content, "User's newer draft");
        Ok(())
    });
}
