//! Resolve an inherited upload through canonical Work, never a renderer path.
use super::*;
use crate::local_computer::attachment_shares::WorkAttachmentRequest;

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct AttachmentSource {
    pub agent_id: String,
    pub attachment: WorkAttachment,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct AttachmentPlan {
    pub sources: Vec<AttachmentSource>,
    ancestry: Vec<(String, u32)>,
}

fn same_input(a: &WorkAttachment, b: &WorkAttachment) -> bool {
    a.id == b.id
        && a.name == b.name
        && a.mime_type == b.mime_type
        && a.size_bytes == b.size_bytes
        && a.source_id == b.source_id
}

fn plan(ctx: &Context<'_>, request: &WorkAttachmentRequest) -> Result<AttachmentPlan> {
    if request.attachment_ids.is_empty() || request.attachment_ids.len() > 12 {
        return Err(invalid("Choose between 1 and 12 inherited uploads."));
    }
    let mut ids = HashSet::new();
    for value in &request.attachment_ids {
        id(value)?;
        if !ids.insert(value) {
            return Err(invalid("Upload identities must be unique."));
        }
    }
    let item = work::current(
        ctx,
        &request.work_id,
        request.expected_work_generation,
        None,
    )?;
    if item.agent_id != request.agent_id
        || item.status != WorkStatus::Queued
        || item.current_run_id.is_some()
        || item.parent_id.is_none()
        || crate::background_worker::owns_work(&item)
    {
        return Err(invalid(
            "Only this agent's queued child task can recover inherited uploads.",
        ));
    }
    let mut chain = vec![item];
    while let Some(parent_id) = chain.last().unwrap().parent_id.as_deref() {
        if chain.len() >= 16 || chain.iter().any(|entry| entry.id == parent_id) {
            return Err(invalid("The task's upload ancestry is invalid."));
        }
        let parent = ctx.item(parent_id)?;
        let child = chain.last().unwrap();
        if parent.root_id != child.root_id
            || parent.conversation_id != child.conversation_id
            || parent.workspace_id != child.workspace_id
            || parent.conversation_generation != child.conversation_generation
            || !parent.dependencies.contains(&child.id)
            || (child.workspace_recipient && !parent.recipient_ids.contains(&child.agent_id))
        {
            return Err(invalid("The upload was not shared with this task."));
        }
        profile(ctx.profiles, &parent.agent_id)?;
        chain.push(parent);
    }
    if chain.last().unwrap().id != chain[0].root_id {
        return Err(invalid("The task's original upload owner is unavailable."));
    }
    let mut sources = Vec::new();
    for id in &request.attachment_ids {
        let child_ref = chain[0]
            .attachments
            .iter()
            .find(|a| &a.id == id)
            .ok_or_else(|| invalid("The requested upload is not attached to this task."))?;
        if child_ref.availability != "transient" {
            return Err(invalid(
                "Only inherited transient uploads need native recovery.",
            ));
        }
        let mut found = None;
        for parent in chain.iter().skip(1) {
            let source = parent
                .attachments
                .iter()
                .find(|a| same_input(a, child_ref))
                .ok_or_else(|| invalid("The upload changed or was not inherited by this task."))?;
            if source.availability == "workspace-file" {
                found = Some(AttachmentSource {
                    agent_id: parent.agent_id.clone(),
                    attachment: source.clone(),
                });
                break;
            }
        }
        sources.push(found.ok_or_else(|| {
            invalid("The original upload is unavailable. Reattach it before continuing.")
        })?);
    }
    Ok(AttachmentPlan {
        sources,
        ancestry: chain
            .iter()
            .map(|item| (item.id.clone(), item.generation))
            .collect(),
    })
}

pub(crate) fn resolve(
    app: &tauri::AppHandle,
    request: &WorkAttachmentRequest,
) -> std::result::Result<AttachmentPlan, String> {
    let profiles = native_profiles(app.clone(), &request.workspace_id)?;
    let store = crate::store::try_global().ok_or("The native Work store is unavailable.")?;
    store
        .with_conn(|conn| {
            let scope = authorized_scope::resolve(
                conn,
                Some(&request.workspace_id),
                None,
                ScopeAccess::Read,
            )?;
            let time = now();
            plan(
                &Context {
                    conn,
                    store,
                    scope: &scope,
                    profiles: &profiles,
                    time: &time,
                },
                request,
            )
        })
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collaboration::tests::{fixture, store};

    #[test]
    fn inherited_uploads_require_current_canonical_chain_and_matching_metadata() {
        fixture(&store(), |ctx| {
            let room = chats::open_main(ctx, "lead")?;
            work::start(
                ctx,
                "parent".into(),
                room.id.clone(),
                "lead".into(),
                "Review upload".into(),
                false,
                None,
                None,
            )?;
            let mut parent = ctx.item("parent")?;
            parent.attachments = vec![WorkAttachment {
                id: "upload-one".into(),
                name: "notes.txt".into(),
                mime_type: "text/plain".into(),
                size_bytes: 4,
                availability: "workspace-file".into(),
                relative_path: Some("Attachments/upload-batch/notes.txt".into()),
                sha256: Some("a".repeat(64)),
                source_id: None,
            }];
            parent.recipient_ids = vec!["lead".into(), "reviewer".into()];
            parent.dependencies = vec!["child".into()];
            ctx.work(&parent)?;
            let mut child = parent.clone();
            child.id = "child".into();
            child.parent_id = Some(parent.id.clone());
            child.agent_id = "reviewer".into();
            child.depth = 1;
            child.workspace_recipient = true;
            child.dependencies.clear();
            child.recipient_ids.clear();
            child.attachments[0].availability = "transient".into();
            child.attachments[0].relative_path = None;
            child.attachments[0].sha256 = None;
            ctx.work(&child)?;
            let mut request = WorkAttachmentRequest {
                workspace_id: "default".into(),
                agent_id: "reviewer".into(),
                work_id: "child".into(),
                expected_work_generation: 1,
                expected_generation: 1,
                attachment_ids: vec!["upload-one".into()],
            };
            let resolved = plan(ctx, &request)?;
            assert_eq!(resolved.sources[0].agent_id, "lead");
            assert_eq!(resolved.sources[0].attachment.sha256, Some("a".repeat(64)));
            request.agent_id = "researcher".into();
            assert!(plan(ctx, &request).is_err());
            request.agent_id = "reviewer".into();
            request.expected_work_generation = 2;
            assert!(plan(ctx, &request).is_err());
            request.expected_work_generation = 1;
            child.attachments[0].size_bytes = 5;
            ctx.work(&child)?;
            assert!(plan(ctx, &request).is_err());
            child.attachments[0].size_bytes = 4;
            ctx.work(&child)?;
            parent.dependencies.clear();
            ctx.work(&parent)?;
            assert!(plan(ctx, &request).is_err());
            Ok(())
        });
    }
}
