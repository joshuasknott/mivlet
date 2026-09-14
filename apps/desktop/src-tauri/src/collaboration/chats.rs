//! Transactional Chat identity. IDs are stable objects, independent of views.
use super::*;
use sha2::{Digest, Sha256};

/// The main Chat is a structural anchor: it cannot be renamed, archived or
/// deleted, so agent selection always resolves the same durable transcript.
fn side_room(ctx: &Context<'_>, key: &str, expected_revision: u32) -> Result<Conversation> {
    id(key)?;
    let room = ctx.room(key)?;
    if room.revision != expected_revision {
        return Err(invalid("This conversation changed. Reload before editing."));
    }
    if room.chat.as_ref().is_some_and(|chat| chat.role == "main") {
        return Err(invalid(
            "The main Chat is permanent. Only Side Chats can be renamed, archived or deleted.",
        ));
    }
    Ok(room)
}

pub(super) fn rename(
    ctx: &Context<'_>,
    key: &str,
    expected_revision: u32,
    title: &str,
) -> Result<()> {
    let mut room = side_room(ctx, key, expected_revision)?;
    let title = bounded(title, 120, "Conversation title")?;
    thread::update(
        ctx.conn,
        ctx.store,
        &ctx.scope.data,
        &room.id,
        Some(&title),
        None,
        None,
        ctx.time,
    )?;
    room.title = title;
    room.revision += 1;
    room.updated_at = ctx.time.into();
    ctx.conversation(&room)
}

pub(super) fn set_archived(
    ctx: &Context<'_>,
    key: &str,
    expected_revision: u32,
    archived: bool,
) -> Result<()> {
    let mut room = side_room(ctx, key, expected_revision)?;
    if archived
        && ctx
            .all_work()?
            .iter()
            .any(|work| work.conversation_id == room.id && work.status.active())
    {
        return Err(invalid(
            "Stop this Side Chat's active request before archiving it.",
        ));
    }
    thread::update(
        ctx.conn,
        ctx.store,
        &ctx.scope.data,
        &room.id,
        None,
        Some(if archived { "archived" } else { "active" }),
        None,
        ctx.time,
    )?;
    room.archived = archived;
    room.revision += 1;
    room.updated_at = ctx.time.into();
    ctx.conversation(&room)
}

/// Deleting a Side Chat is explicit. Chats holding durable Work evidence or
/// saved project decisions must be archived so their records stay resolvable.
pub(super) fn delete(ctx: &Context<'_>, key: &str, expected_revision: u32) -> Result<()> {
    let room = side_room(ctx, key, expected_revision)?;
    if ctx
        .all_work()?
        .iter()
        .any(|work| work.conversation_id == room.id)
    {
        return Err(invalid(
            "This Side Chat has saved requests. Archive it to preserve them.",
        ));
    }
    if repo::list::<Fact>(ctx.conn, ctx.store, &ctx.scope.private, Kind::Fact)?
        .iter()
        .any(|fact| fact.conversation_id == room.id && fact.status != "forgotten")
    {
        return Err(invalid(
            "This Side Chat has saved project records. Archive it to preserve them.",
        ));
    }
    ctx.conn.execute(
        "DELETE FROM collaboration_record WHERE workspace_id=?1 AND owner_subject=?2 AND ((kind='conversation' AND id=?3) OR (kind='author' AND conversation_id=?3))",
        rusqlite::params![ctx.scope.private.workspace_id(), ctx.scope.private.owner_subject(), room.id],
    )?;
    thread::delete(ctx.conn, &ctx.scope.data, &room.id, ctx.time)
}

pub(super) fn open_main(ctx: &Context<'_>, agent_id: &str) -> Result<Conversation> {
    let agent = profile(ctx.profiles, agent_id)?;
    let digest = Sha256::digest(
        format!(
            "main-chat:v1:{}:{agent_id}",
            ctx.scope.private.owner_subject()
        )
        .as_bytes(),
    );
    let key = format!("main-{:x}", digest);
    if let Some(room) = repo::get::<Conversation>(
        ctx.conn,
        ctx.store,
        &ctx.scope.private,
        Kind::Conversation,
        &key,
    )? {
        if !room.chat.as_ref().is_some_and(|chat| {
            chat.role == "main" && chat.owner_kind == "agent" && chat.owner_id == agent_id
        }) {
            return Err(invalid(
                "The main Chat identity conflicts with an existing record.",
            ));
        }
        return Ok(room);
    }
    let mut room = ctx.create_room(
        &key,
        &format!("Chat with {}", agent.name),
        "direct",
        vec![Participant {
            agent_id: agent_id.into(),
            name: agent.name.clone(),
        }],
        Some(agent_id.into()),
        None,
    )?;
    room.chat = Some(ChatBinding {
        role: "main".into(),
        owner_kind: "agent".into(),
        owner_id: agent_id.into(),
    });
    ctx.conversation(&room)?;
    Ok(room)
}
