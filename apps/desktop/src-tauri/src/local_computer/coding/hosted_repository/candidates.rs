use super::*;
use serde_json::{json, Value};
use std::sync::Arc;

#[tauri::command]
pub(crate) async fn hosted_repository_candidates(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<crate::local_computer::LocalComputerState>>,
    request: Target,
) -> Result<Value, String> {
    if window.label() != "main" {
        return Err("Choose hosted source files in the main Mivlet window.".into());
    }
    crate::account_session::ensure_current()?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move|| {
        let ticket=crate::hosted_tasks::ticket(&state,&request.workspace_id,&request.agent_id)?;
        let current=crate::collaboration::hosted_repository::candidates(&app,&ticket,&request)?;
        let directory=super::super::directory(&state,&request.workspace_id,&request.agent_id)?;
        let repo=copy_manager::owned_repository(&directory,&current.repository.repository_id,&request.workspace_id,&request.agent_id)?;
        current.repository.check(&repo)?;
        let mutex=lock(&directory)?;let _guard=mutex.try_lock()?;let _lease=files::lease(&directory)?;
        if repo.operation!="idle" {return Err("Recover this task's original repository copy before choosing source files.".into());}
        let root=checkout(&directory,&repo)?;
        let before=files::tree_id(&root,COPY_LIMITS,||ticket.check().is_ok())?;
        let mut stack=vec![root.clone()];let mut count=0usize;let mut selected=Vec::new();let mut truncated=false;
        while let Some(directory)=stack.pop() {
            for entry in fs::read_dir(directory).map_err(|_|"Source inventory is unavailable.")? {
                ticket.check()?;count+=1;if count>COPY_LIMITS.file_count {return Err("The source inventory changed or exceeds its bound.".into());}
                let path=entry.map_err(|_|"A source path changed.")?.path();
                let path=crate::paths::strict_canonicalize(&path).map_err(|_|"Linked or replaced source paths are unavailable.")?;
                if !path.starts_with(&root){return Err("A source path escaped its retained copy.".into());}
                let metadata=fs::symlink_metadata(&path).map_err(|_|"A source path changed.")?;
                let relative=path.strip_prefix(&root).map_err(|_|"Invalid source path.")?.to_str().ok_or("Source names must be Unicode.")?.replace('\\',"/");
                if public_path(&relative).is_err(){truncated=true;continue;}
                if metadata.is_dir(){stack.push(path);}else if metadata.is_file(){
                    if selected.len()>=FILES||metadata.len()>FILE_BYTES {truncated=true;continue;}
                    let bytes=files::read(&path,FILE_BYTES,||ticket.check().is_ok())?;
                    if public_content(&bytes).is_err(){truncated=true;continue;}
                    selected.push(json!({"path":relative,"sizeBytes":bytes.len()}));
                }else{return Err("Only regular source files are available for hosted coding.".into());}
            }
        }
        selected.sort_by(|a,b|a["path"].as_str().cmp(&b["path"].as_str()));
        if files::tree_id(&root,COPY_LIMITS,||ticket.check().is_ok())?!=before {return Err("The private source tree changed during inspection. Refresh before selecting files.".into());}
        crate::collaboration::hosted_repository::candidates(&app,&ticket,&request)?;
        ticket.finish(Ok(json!({"repositoryId":repo.id,"files":selected,"truncated":truncated})))
    }).await.map_err(|_|"Source inspection was interrupted.".to_string())?
}
