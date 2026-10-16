//! Account-wide discovery includes copies left by deleted agents. Only verified
//! current agents may act on them; unknown and retired owners remain protected.
use super::*;

fn discover_owner(directory: &Path, account: &str, workspace: &str) -> Option<Owner> {
    let entries = fs::read_dir(directory).ok()?;
    for entry in entries.take(1000).filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().into_owned();
        let candidate = if let Some(id) = name
            .strip_prefix("cleanup-")
            .and_then(|name| name.strip_suffix(".json"))
        {
            if !valid_id(id) {
                continue;
            }
            read_json::<CleanupIntent>(&entry.path())
                .ok()
                .map(|intent| intent.owner)
        } else {
            let id = name.strip_prefix("deleting-").unwrap_or(&name);
            if !valid_id(id) {
                continue;
            }
            read_json::<Owner>(&entry.path().join("ownership.json")).ok()
        };
        if let Some(owner) = candidate {
            if owner.account == account && owner.workspace == workspace {
                return Some(owner);
            }
        }
    }
    None
}

fn inspect_account(
    state: &LocalComputerState,
    target: &CopyScope,
    ticket: &OperationTicket,
) -> Result<CopyInventory, String> {
    let actor = owner(&target.workspace_id, &target.agent_id)?;
    let scope = crate::authorized_scope::command_scope(
        Some(target.workspace_id.clone()),
        None,
        crate::authorized_scope::ScopeAccess::Read,
    )?;
    let snapshot: Option<crate::models::RuntimeSnapshot> =
        crate::store::read_workspace_document(&state.snapshot_path, &scope.data)?;
    let mut known = HashMap::new();
    for agent in snapshot
        .ok_or("The workspace snapshot is unavailable.")?
        .agents
    {
        let scope = state.scope(&target.workspace_id, &agent.id)?;
        known.insert(
            scope.key,
            Owner {
                agent: agent.id,
                ..actor.clone()
            },
        );
    }
    let root = crate::paths::strict_canonicalize(&state.root)
        .map_err(|_| "Account repository storage failed validation.")?;
    let mut all = CopyInventory {
        copies: Vec::new(),
        busy: false,
    };
    for (index, entry) in fs::read_dir(&root)
        .map_err(|_| "Account repository inventory is unavailable.")?
        .enumerate()
    {
        ticket.check()?;
        if index >= 4096 {
            return Err("Account repository scope inventory exceeds its limit.".into());
        }
        let entry = entry.map_err(|_| "Account repository inventory is unreadable.")?;
        let key = entry.file_name().to_string_lossy().into_owned();
        if key.len() != 32 || !key.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            continue;
        }
        let directory = entry.path().join("coding");
        if !directory.exists() {
            continue;
        }
        let directory = crate::paths::strict_canonicalize(&directory)
            .map_err(|_| "A retained scope contains an unsafe path; no cleanup allowed.")?;
        if !directory.starts_with(&root) {
            return Err("Retained copy scope escaped account storage.".into());
        }
        let saved_owner = known.get(&key);
        let discovered = discover_owner(&directory, &actor.account, &actor.workspace);
        let mut owner = saved_owner.cloned().or(discovered).unwrap_or(Owner {
            agent: format!("unknown-{key}"),
            ..actor.clone()
        });
        let verified_scope = state
            .scope(&owner.workspace, &owner.agent)
            .ok()
            .is_some_and(|scope| scope.key == key);
        if !verified_scope {
            owner.agent = format!("unknown-{key}");
        }
        let evidence_target = CopyScope {
            workspace_id: owner.workspace.clone(),
            agent_id: owner.agent.clone(),
            expected_generation: target.expected_generation,
        };
        let evidence = read_evidence(&evidence_target)?;
        let mut inventory =
            inventory_in(&directory, &owner, &evidence, ticket, saved_owner.is_some())?;
        for copy in &mut inventory.copies {
            if saved_owner.is_none() {
                copy.blockers.push("The owning agent is no longer saved in this workspace; preserve this copy until ownership is reviewed.".into());
            }
            if !verified_scope {
                copy.ownership_verified = false;
            }
        }
        all.busy |= inventory.busy;
        all.copies.extend(inventory.copies);
        if all.copies.len() > 1000 {
            return Err("Account copy inventory exceeds its limit.".into());
        }
    }
    all.copies
        .sort_by(|left, right| (&left.agent_id, &left.id).cmp(&(&right.agent_id, &right.id)));
    Ok(all)
}

#[tauri::command]
pub async fn coding_copy_account_inventory(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<LocalComputerState>>,
    target: CopyScope,
) -> Result<CopyInventory, String> {
    main_window(&window)?;
    let ticket = state.begin_agent_operation(
        &target.workspace_id,
        &target.agent_id,
        target.expected_generation,
    )?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = inspect_account(&state, &target, &ticket);
        ticket.finish(result)
    })
    .await
    .map_err(|_| "Account copy inventory stopped.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn retired_owner() -> Owner {
        Owner {
            account: "account-test".into(),
            workspace: "workspace-test".into(),
            agent: "retired-agent".into(),
            source: None,
        }
    }

    #[test]
    fn discovers_retired_owner_without_accepting_another_account_or_workspace() {
        let temp = tempfile::tempdir().unwrap();
        let copy = temp.path().join("a".repeat(48));
        fs::create_dir(&copy).unwrap();
        write_json(&copy.join("ownership.json"), &retired_owner()).unwrap();
        let owner = discover_owner(temp.path(), "account-test", "workspace-test").unwrap();
        assert_eq!(owner.agent, "retired-agent");
        assert!(discover_owner(temp.path(), "other-account", "workspace-test").is_none());
        assert!(discover_owner(temp.path(), "account-test", "other-workspace").is_none());
        fs::write(copy.join("ownership.json"), b"damaged record").unwrap();
        assert!(discover_owner(temp.path(), "account-test", "workspace-test").is_none());
    }

    #[test]
    fn discovers_cleanup_receipt_after_inner_copy_records_are_removed() {
        let temp = tempfile::tempdir().unwrap();
        let id = "b".repeat(48);
        write_json(
            &temp.path().join(format!("cleanup-{id}.json")),
            &CleanupIntent {
                owner: retired_owner(),
                repository: Repository {
                    id,
                    name: "Retained".into(),
                    branch: "mivlet/retained".into(),
                    base: "c".repeat(40),
                    base_branch: "main".into(),
                    remote: None,
                    operation: "idle".into(),
                    last_result: None,
                    last_command: None,
                    command_diff_id: None,
                    publication: None,
                },
            },
        )
        .unwrap();
        let owner = discover_owner(temp.path(), "account-test", "workspace-test").unwrap();
        assert_eq!(owner.agent, "retired-agent");
        assert!(discover_owner(temp.path(), "other-account", "workspace-test").is_none());
    }
}
