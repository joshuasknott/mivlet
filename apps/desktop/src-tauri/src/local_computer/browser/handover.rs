//! Terminal handover persists canonical Work attention before control ends.
//! The owned browser stays open; resumption needs a fresh explicit request.
use super::LocalComputerState;

pub(crate) fn handover(
    computers: &LocalComputerState,
    workspace: &str,
    agent: &str,
    generation: u64,
    reason: &str,
) -> Result<String, String> {
    validate_reason(reason)?;
    computers.validate_target(workspace, agent)?;
    let authority = computers.authority_for(workspace, agent)?;
    let ticket = authority.begin_agent(generation)?;
    #[cfg(not(windows))]
    {
        let _ = (computers, ticket);
        Err("Browser handover requires Mivlet desktop on Windows.".into())
    }
    #[cfg(windows)]
    {
        let scope = computers.scope(workspace, agent)?;
        {
            let processes = computers
                .browsers
                .processes
                .lock()
                .map_err(|_| "The owned browser is unavailable.")?;
            if !processes
                .get(&scope.key)
                .is_some_and(|process| process.alive())
            {
                return Err("Open this agent's browser before handing it over.".into());
            }
        }
        ticket.check()?;
        crate::collaboration::browser_handover(workspace, agent, reason)?;
        computers.native.stop_scope(workspace, agent, generation,
            "The browser is yours. Agent control stopped; continue explicitly after completing the private step.");
        if authority.snapshot()?.generation == generation {
            authority.revoke_and_drain_later();
        }
        // Do not finish a retired ticket or silently acquire another one.
        drop(ticket);
        Ok(serde_json::json!({"status":"human-control-required","browserRetained":true,
            "requiresFreshRequest":true,"inputAuthority":false,
            "message":"The browser is yours. Complete the step, then explicitly continue the task; the agent must select and observe the current window again."}).to_string())
    }
}

fn validate_reason(reason: &str) -> Result<(), String> {
    if reason.trim().is_empty()
        || reason.chars().count() > 240
        || reason.chars().any(char::is_control)
        || crate::secret_redaction::looks_secret(reason)
        || crate::secret_redaction::secret_marker_survives(reason)
    {
        return Err(
            "Describe the human step in 1–240 public characters without credentials.".into(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn handover_reason_excludes_values_that_do_not_belong_in_work_attention() {
        validate_reason("Please complete the sign-in step in the open browser.").unwrap();
        for reason in [
            "",
            "\nprivate step",
            "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
        ] {
            assert!(validate_reason(reason).is_err());
        }
        assert!(validate_reason(&"x".repeat(241)).is_err());
    }
}
