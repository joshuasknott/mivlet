//! Only native captured source and authenticated immutable output use these
//! closed transfers. There is no renderer byte-upload or success parameter.
use super::{models::*, *};
use crate::store::repos::workspace_directory::HostedComputerScope;
use crate::{
    collaboration,
    local_computer::{
        authority::OperationTicket, coding::hosted_repository as repository, LocalComputerState,
    },
};
use base64::Engine as _;
use serde::Deserialize;
use serde_json::json;

pub(crate) async fn upload(
    app: &tauri::AppHandle,
    state: &LocalComputerState,
    ticket: &OperationTicket,
    local_workspace: &str,
    scope: &HostedComputerScope,
    offer: &Offer,
) -> Result<TaskSnapshot, String> {
    let binding = &offer.admission.binding;
    let repo = binding
        .repository
        .as_ref()
        .ok_or("The reviewed coding snapshot is unavailable.")?;
    let task = repository::TaskIdentity::from_binding(local_workspace, binding)?;
    let authorization = json!({"taskId":binding.task_id,"snapshotId":repo.snapshot.snapshot_id,"manifestSha256":repo.snapshot.manifest_sha256});
    let transfer = transport::Transfer::open(
        ticket,
        scope,
        binding,
        authorization.clone(),
        "input",
        &offer.runner_url,
    )
    .await?;
    for file in &repo.snapshot.files {
        let mut offset = 0u64;
        while offset < file.size_bytes {
            ticket.check()?;
            let bytes = repository::read_snapshot_chunk(
                app,
                state,
                ticket,
                &task,
                &repo.snapshot.snapshot_id,
                &file.path,
                offset,
            )?;
            if bytes.is_empty()
                || bytes.len() > repository::CHUNK_BYTES
                || offset.saturating_add(bytes.len() as u64) > file.size_bytes
            {
                return Err("The captured source chunk changed before transfer.".into());
            }
            let value=transfer.call(ticket,"chunk",json!({"authorization":authorization,"chunk":{"path":file.path,"offset":offset,"dataBase64":base64::engine::general_purpose::STANDARD.encode(&bytes)}})).await?;
            if value != json!({"accepted":true}) {
                return Err(
                    "Source transfer acknowledgment was invalid. No task was replayed.".into(),
                );
            }
            offset += bytes.len() as u64;
        }
    }
    let value = transfer
        .call(
            ticket,
            "seal",
            json!({"authorization":authorization,"seal":true}),
        )
        .await?;
    serde_json::from_value(value).map_err(|_|"Cloud source sealing is uncertain. Refresh this exact task; no input or effect was replayed.".into())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OutputChunk {
    task_id: String,
    path: String,
    offset: u64,
    output_manifest_sha256: String,
    data_base64: String,
    end: bool,
}

pub(crate) async fn receive(
    app: &tauri::AppHandle,
    state: &LocalComputerState,
    ticket: &OperationTicket,
    local_workspace: &str,
    scope: &HostedComputerScope,
    offer: &Offer,
    result: &TaskResult,
) -> Result<(), String> {
    let binding = &offer.admission.binding;
    let coding = result
        .snapshot
        .coding
        .as_ref()
        .ok_or("The authenticated coding output is unavailable.")?;
    let repo = binding
        .repository
        .as_ref()
        .ok_or("The reviewed coding source is unavailable.")?;
    let task = repository::TaskIdentity::from_binding(local_workspace, binding)?;
    // Result metadata has already been authenticated and validated. Keep the
    // exact owner/run until this independent native file review is resolved.
    let retained =
        repository::retained_output(app, state, ticket, &task, &repo.snapshot.snapshot_id)?;
    if let Some(retained) = retained {
        if retained != coding.output {
            return Err("The retained output differs from its authenticated cloud receipt.".into());
        }
    } else {
        let proof = repository::AuthenticatedHostedRepositoryOutput::from_authenticated_transport(
            local_workspace,
            &result.snapshot,
            &repo.snapshot,
            coding.output.clone(),
            &coding.output.output_manifest_sha256,
        )?;
        let mut stager = repository::OutputStager::begin(app, state, ticket, proof)?;
        let needed = stager.needed_files();
        if !needed.is_empty() {
            let (_binding, _gate) =
                collaboration::hosted_repository::register_import(app, ticket, &task)?;
            let authorization = json!({"taskId":binding.task_id,"outputManifestSha256":coding.output.output_manifest_sha256});
            let transfer = transport::Transfer::open(
                ticket,
                scope,
                binding,
                authorization.clone(),
                "output",
                &offer.runner_url,
            )
            .await?;
            for file in needed {
                let mut offset = 0u64;
                while offset < file.size_bytes {
                    let value = transfer
                        .call(
                            ticket,
                            "output",
                            json!({"authorization":authorization,"path":file.path,"offset":offset}),
                        )
                        .await?;
                    let chunk: OutputChunk = serde_json::from_value(value)
                        .map_err(|_| "Invalid authenticated returned source chunk.")?;
                    if chunk.task_id != binding.task_id
                        || chunk.path != file.path
                        || chunk.offset != offset
                        || chunk.output_manifest_sha256 != coding.output.output_manifest_sha256
                        || chunk.data_base64.len() > 87384
                    {
                        return Err("Returned source chunk scope changed.".into());
                    }
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(&chunk.data_base64)
                        .map_err(|_| "Invalid returned source encoding.")?;
                    let end = offset
                        .checked_add(bytes.len() as u64)
                        .ok_or("Returned source offset overflow.")?;
                    if bytes.is_empty()
                        || bytes.len() > repository::CHUNK_BYTES
                        || end > file.size_bytes
                        || chunk.end != (end == file.size_bytes)
                    {
                        return Err("Returned source chunks are missing or out of order.".into());
                    }
                    stager.write_chunk(ticket, &file.path, offset, &bytes)?;
                    offset = end;
                }
            }
        }
        stager.finish(app, ticket)?;
    }
    // Repairs only an already acknowledged filesystem import after lost IPC;
    // it never reapplies files or fabricates a renderer success receipt.
    repository::reconcile_import_receipt(
        app,
        state,
        ticket,
        &task,
        &repo.snapshot.snapshot_id,
        &coding.output.output_manifest_sha256,
    )?;
    Ok(())
}
