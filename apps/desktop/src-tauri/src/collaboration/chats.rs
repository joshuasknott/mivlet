//! Transactional Chat identity. IDs are stable objects, independent of views.
use super::*;
use sha2::{Digest, Sha256};

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
