use super::*;
use crate::collaboration::ui::{self, ContextSelection, UiCommand};
use std::collections::BTreeMap;

fn interactive(ctx: &Context<'_>) -> Result<(Conversation, String)> {
    let room = chats::open_main(ctx, "lead")?;
    let source = "Choose a route.\n```openui\nroot = Stack([choice])\nchoice = Options(\"route\", \"Direction\", [\"Simple\", \"Detailed\"])\n```".to_string();
    output(ctx, &room.id, "ui-run", &source)?;
    ctx.put(
        Kind::Author,
        "ui-run",
        Some(&room.id),
        None,
        &Author {
            run_id: "ui-run".into(),
            conversation_id: room.id.clone(),
            agent_id: "lead".into(),
            name: "Lead".into(),
            work_id: None,
            generation: 1,
        },
    )?;
    Ok((room, source))
}
#[test]
fn obsolete_work_generation_can_be_read_but_cannot_accept_interface_actions() {
    fixture(&store(), |ctx| {
        let (room, source) = interactive(ctx)?;
        work::start(
            ctx,
            "ui-work".into(),
            room.id.clone(),
            "lead".into(),
            "Compare routes".into(),
            false,
            None,
            None,
        )?;
        let mut work = ctx.item("ui-work")?;
        work.status = WorkStatus::Completed;
        work.generation = 2;
        work.run_ids = vec!["ui-run".into()];
        ctx.work(&work)?;
        let mut author: Author = repo::get(
            ctx.conn,
            ctx.store,
            &ctx.scope.private,
            Kind::Author,
            "ui-run",
        )?
        .unwrap();
        author.work_id = Some(work.id);
        author.generation = 1;
        ctx.put(Kind::Author, "ui-run", Some(&room.id), None, &author)?;
        ui::apply(
            ctx,
            &room,
            "lead",
            UiCommand::LoadInterface {
                run_id: "ui-run".into(),
                source: source.clone(),
            },
        )?;
        assert!(ui::apply(
            ctx,
            &room,
            "lead",
            UiCommand::SaveInterface {
                run_id: "ui-run".into(),
                source: source.clone(),
                expected_revision: 0,
                values: BTreeMap::new()
            }
        )
        .is_err());
        assert!(ui::apply(
            ctx,
            &room,
            "lead",
            UiCommand::ReviewInterface {
                run_id: "ui-run".into(),
                source,
                expected_revision: 0,
                event_id: "review".into(),
                label: "Compare".into()
            }
        )
        .is_err());
        Ok(())
    });
}
#[test]
fn ui_state_is_encrypted_durable_revision_bound_and_duplicate_actions_fail() {
    let store = store();
    let room_id = fixture(&store, |ctx| {
        let (room, source) = interactive(ctx)?;
        let loaded = ui::apply(
            ctx,
            &room,
            "lead",
            UiCommand::LoadInterface {
                run_id: "ui-run".into(),
                source: source.clone(),
            },
        )?;
        assert_eq!(loaded["revision"], 0);
        let values = BTreeMap::from([("route".into(), json!("Simple"))]);
        let saved = ui::apply(
            ctx,
            &room,
            "lead",
            UiCommand::SaveInterface {
                run_id: "ui-run".into(),
                source: source.clone(),
                expected_revision: 0,
                values: values.clone(),
            },
        )?;
        assert_eq!(saved["revision"], 1);
        assert!(ui::apply(
            ctx,
            &room,
            "lead",
            UiCommand::SaveInterface {
                run_id: "ui-run".into(),
                source: source.clone(),
                expected_revision: 0,
                values
            }
        )
        .is_err());
        let review = ui::apply(
            ctx,
            &room,
            "lead",
            UiCommand::ReviewInterface {
                run_id: "ui-run".into(),
                source: source.clone(),
                expected_revision: 1,
                event_id: "first".into(),
                label: "Direction".into(),
            },
        )?;
        assert!(review["draft"]
            .as_str()
            .unwrap()
            .contains("revision-ui-run"));
        assert!(ui::apply(
            ctx,
            &room,
            "lead",
            UiCommand::ReviewInterface {
                run_id: "ui-run".into(),
                source,
                expected_revision: 2,
                event_id: "second".into(),
                label: "Direction".into()
            }
        )
        .is_err());
        let bytes: Vec<u8> = ctx.conn.query_row(
            "SELECT payload FROM conversation_ui WHERE conversation_id=?1",
            [&room.id],
            |row| row.get(0),
        )?;
        assert!(!String::from_utf8_lossy(&bytes).contains("Simple"));
        Ok(room.id)
    });
    fixture(&store, |ctx| {
        let room = ctx.room(&room_id)?;
        let rows = message::list(ctx.conn, ctx.store, &ctx.scope.data, &room_id)?;
        let loaded = ui::apply(
            ctx,
            &room,
            "lead",
            UiCommand::LoadInterface {
                run_id: "ui-run".into(),
                source: rows[0].content.as_str().unwrap().into(),
            },
        )?;
        assert_eq!(loaded["values"]["route"], "Simple");
        assert_eq!(loaded["revision"], 2);
        Ok(())
    });
}
#[test]
fn ui_rejects_foreign_owner_changed_source_and_nonliteral_selection() {
    fixture(&store(), |ctx| {
        let (room, source) = interactive(ctx)?;
        assert!(ui::apply(
            ctx,
            &room,
            "reviewer",
            UiCommand::LoadInterface {
                run_id: "ui-run".into(),
                source: source.clone()
            }
        )
        .is_err());
        assert!(ui::apply(
            ctx,
            &room,
            "lead",
            UiCommand::LoadInterface {
                run_id: "ui-run".into(),
                source: format!("{source}changed")
            }
        )
        .is_err());
        assert!(ui::apply(
            ctx,
            &room,
            "lead",
            UiCommand::QuoteResponse {
                run_id: "ui-run".into(),
                source: source.clone(),
                selection: "injected passage".into()
            }
        )
        .is_err());
        let quote = ui::apply(
            ctx,
            &room,
            "lead",
            UiCommand::QuoteResponse {
                run_id: "ui-run".into(),
                source,
                selection: "Choose a route.".into(),
            },
        )?;
        assert_eq!(quote["sourceRevision"], "revision-ui-run");
        Ok(())
    });
}
#[test]
fn native_context_choices_change_capture_and_reject_stale_overwrites() {
    fixture(&store(), |ctx| {
        let (room, _) = interactive(ctx)?;
        let selection = ContextSelection {
            include_history: false,
            ..Default::default()
        };
        let value = ui::apply(
            ctx,
            &room,
            "lead",
            UiCommand::SetContext {
                selection: selection.clone(),
            },
        )?;
        let capture: serde_json::Value =
            serde_json::from_str(value["capture"]["text"].as_str().unwrap()).unwrap();
        assert_eq!(capture["history"], json!([]));
        assert!(capture["derivedSummaries"].as_array().unwrap().is_empty());
        assert!(!value["capture"]["text"]
            .as_str()
            .unwrap()
            .contains("Choose a route"));
        assert!(ui::apply(ctx, &room, "lead", UiCommand::SetContext { selection }).is_err());
        let fresh = context::capture(ctx, &room, profile(ctx.profiles, "lead")?)?;
        assert!(!fresh.text.contains("Choose a route"));
        Ok(())
    });
}

#[test]
fn native_memory_exclusion_is_scoped_and_durable_without_disabling_other_agents() {
    fixture(&store(), |ctx| {
        let (room, _) = interactive(ctx)?;
        let (scope, key) = crate::store::private_document_location(
            std::path::Path::new("memory-state.json"),
            &ctx.scope.private,
        )
        .map_err(StoreError::Invalid)?;
        crate::store::repos::preferences::upsert_scoped(
            ctx.conn,
            ctx.store,
            &scope,
            &key,
            &json!({"disabled":false,"records":[
                {"id":"global-memory","approved":true,"value":"Include shared preference","scope":{"level":"global"}},
                {"id":"sibling-memory","approved":true,"value":"Never leak sibling","scope":{"level":"thread","threadId":"unrelated"}}
            ]}),
            TIME,
        )?;
        let before = context::capture(ctx, &room, profile(ctx.profiles, "lead")?)?;
        assert!(before.text.contains("Include shared preference"));
        assert!(!before.text.contains("Never leak sibling"));
        ui::apply(
            ctx,
            &room,
            "lead",
            UiCommand::SetContext {
                selection: ContextSelection {
                    excluded_memory_ids: vec!["global-memory".into()],
                    excluded_knowledge_source_ids: vec!["file-one".into()],
                    ..Default::default()
                },
            },
        )?;
        let after = context::capture(ctx, &room, profile(ctx.profiles, "lead")?)?;
        assert!(!after.text.contains("Include shared preference"));
        assert!(after.text.contains("file-one"));
        assert!(!after.text.contains("Never leak sibling"));
        assert!(
            context::capture(ctx, &room, profile(ctx.profiles, "reviewer")?)?
                .text
                .contains("Include shared preference")
        );
        Ok(())
    });
}
