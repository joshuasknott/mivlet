fn mission_progress_projection(
    lifecycle: &mission_plan::MissionPlanLifecycleRow,
    journal: &mission_run::MissionRunJournalRow,
) -> Result<Value, String> {
    let steps = lifecycle
        .current_revision
        .get("steps")
        .and_then(Value::as_array)
        .ok_or_else(|| "Selected plan steps are invalid.".to_string())?;
    if steps.is_empty() || steps.len() > 32 {
        return Err("Mission progress requires one to thirty-two selected steps.".into());
    }
    let run_status = journal
        .run
        .get("status")
        .and_then(Value::as_str)
        .ok_or_else(|| "Mission run status is invalid.".to_string())?;
    let terminal_run = matches!(
        run_status,
        "completed" | "partially-completed" | "failed" | "cancelled"
    );
    let worker_facts = journal
        .events
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("worker-created"))
        .map(|event| {
            let worker = event
                .pointer("/payload/worker")
                .ok_or_else(|| "Stored worker assignment is invalid.".to_string())?;
            let worker_id = bounded(
                worker
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "Stored worker identity is invalid.".to_string())?,
                "Mission worker",
                200,
            )?;
            let step_key = bounded(
                worker
                    .get("planStepKey")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "Stored worker step is invalid.".to_string())?,
                "Mission step",
                160,
            )?;
            Ok((step_key, (worker_id, worker)))
        })
        .collect::<Result<BTreeMap<_, _>, String>>()?;
    if worker_facts.len()
        != journal
            .events
            .iter()
            .filter(|event| event.get("type").and_then(Value::as_str) == Some("worker-created"))
            .count()
    {
        return Err("Stored worker assignments are ambiguous.".into());
    }

    let mut worker_states = BTreeMap::<String, &'static str>::new();
    for (worker_id, _) in worker_facts.values() {
        worker_states.insert(worker_id.clone(), "pending");
    }
    for event in &journal.events {
        let event_type = event.get("type").and_then(Value::as_str);
        let worker_id = event.pointer("/payload/workerId").and_then(Value::as_str);
        let Some(worker_id) = worker_id else {
            continue;
        };
        let Some(state) = worker_states.get_mut(worker_id) else {
            return Err("Mission progress references an unknown worker.".into());
        };
        match event_type {
            Some("worker-started" | "worker-progressed") => {
                if matches!(*state, "completed" | "failed") {
                    return Err("Mission worker activity appears after its terminal fact.".into());
                }
                *state = "running";
            }
            Some("worker-waiting") => {
                if matches!(*state, "completed" | "failed") {
                    return Err("Mission worker wait appears after its terminal fact.".into());
                }
                *state = "waiting";
            }
            Some("worker-completed") => {
                if matches!(*state, "completed" | "failed") {
                    return Err("Mission worker has duplicate terminal facts.".into());
                }
                *state = "completed";
            }
            Some("worker-failed") => {
                if matches!(*state, "completed" | "failed") {
                    return Err("Mission worker has duplicate terminal facts.".into());
                }
                *state = "failed";
            }
            _ => {}
        }
    }

    let mut aggregation_states = BTreeMap::<String, &'static str>::new();
    for event in &journal.events {
        if event.get("type").and_then(Value::as_str) != Some("aggregation-recorded") {
            continue;
        }
        let step_key = bounded(
            event
                .pointer("/payload/aggregation/stepKey")
                .and_then(Value::as_str)
                .ok_or_else(|| "Stored aggregation step is invalid.".to_string())?,
            "Aggregation step",
            160,
        )?;
        let status = match event
            .pointer("/payload/aggregation/status")
            .and_then(Value::as_str)
        {
            Some("complete") => "completed",
            Some("partial") => "partial",
            _ => return Err("Stored aggregation status is invalid.".into()),
        };
        if aggregation_states.insert(step_key, status).is_some() {
            return Err("Mission aggregation facts are ambiguous.".into());
        }
    }

    let step_keys = steps
        .iter()
        .map(|step| {
            bounded(
                step.get("key")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "Selected plan step identity is invalid.".to_string())?,
                "Mission step",
                160,
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    if step_keys.iter().collect::<BTreeSet<_>>().len() != step_keys.len() {
        return Err("Selected plan step identities are ambiguous.".into());
    }

    let mut base_states = BTreeMap::<String, &'static str>::new();
    for (step, step_key) in steps.iter().zip(&step_keys) {
        let kind = step
            .get("kind")
            .and_then(Value::as_str)
            .ok_or_else(|| "Selected plan step kind is invalid.".to_string())?;
        if kind == "coordinate" {
            if worker_facts.contains_key(step_key) {
                return Err("A coordinate step cannot also have a worker.".into());
            }
            base_states.insert(
                step_key.clone(),
                aggregation_states
                    .get(step_key)
                    .copied()
                    .unwrap_or("pending"),
            );
        } else {
            let (worker_id, _) = worker_facts
                .get(step_key)
                .ok_or_else(|| "Every executable step requires one durable worker.".to_string())?;
            base_states.insert(
                step_key.clone(),
                worker_states.get(worker_id).copied().unwrap_or("pending"),
            );
        }
    }
    if worker_facts
        .keys()
        .any(|step_key| !base_states.contains_key(step_key))
        || aggregation_states
            .keys()
            .any(|step_key| !base_states.contains_key(step_key))
    {
        return Err("Mission progress contains work outside the selected plan.".into());
    }

    let running_workers = worker_states
        .values()
        .filter(|state| matches!(**state, "running" | "waiting"))
        .count();
    let max_parallel = lifecycle
        .current_revision
        .pointer("/bounds/maxParallelSteps")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .filter(|value| *value > 0 && *value <= 32)
        .ok_or_else(|| "Selected plan parallel bound is invalid.".to_string())?;
    let mut available_slots = max_parallel.saturating_sub(running_workers);
    let mut ready_workers = 0usize;
    let mut blocked_steps = 0usize;
    let mut waiting_steps = 0usize;
    let mut projected_steps = Vec::with_capacity(steps.len());

    for (step, step_key) in steps.iter().zip(&step_keys) {
        let title = bounded(
            step.get("title")
                .and_then(Value::as_str)
                .ok_or_else(|| "Selected plan step title is invalid.".to_string())?,
            "Mission step title",
            400,
        )?;
        let objective = bounded(
            step.get("objective")
                .and_then(Value::as_str)
                .ok_or_else(|| "Selected plan step objective is invalid.".to_string())?,
            "Mission step objective",
            2_000,
        )?;
        let kind = bounded(
            step.get("kind")
                .and_then(Value::as_str)
                .ok_or_else(|| "Selected plan step kind is invalid.".to_string())?,
            "Mission step kind",
            80,
        )?;
        let dependencies = step
            .get("dependsOnStepKeys")
            .and_then(Value::as_array)
            .ok_or_else(|| "Selected plan dependencies are invalid.".to_string())?
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .ok_or_else(|| "Selected plan dependency is invalid.".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        if dependencies
            .iter()
            .any(|dependency| !base_states.contains_key(*dependency))
        {
            return Err("Selected plan dependency is unavailable.".into());
        }

        let base_state = base_states.get(step_key).copied().unwrap_or("pending");
        let (state, detail) = if terminal_run && !matches!(base_state, "completed" | "partial") {
            (
                if run_status == "cancelled" {
                    "cancelled"
                } else {
                    "blocked"
                },
                "The run ended before this step completed.",
            )
        } else if base_state != "pending" {
            (
                base_state,
                match base_state {
                    "running" => "Work is in progress.",
                    "waiting" => "Work is waiting at a durable boundary.",
                    "completed" => "The durable output is complete.",
                    "partial" => "The deterministic aggregation retained partial output.",
                    "failed" => "The worker ended with a durable failure.",
                    _ => "The durable state is recorded.",
                },
            )
        } else {
            let dependency_state = if dependencies.is_empty() {
                "ready"
            } else if dependencies.len() == 1 {
                match base_states.get(dependencies[0]).copied() {
                    Some("completed") => "ready",
                    Some("failed" | "partial") => "blocked",
                    _ => "waiting",
                }
            } else {
                let revision_id = lifecycle
                    .current_revision
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "Selected plan revision is invalid.".to_string())?;
                let join_key = coordination_join_key(revision_id, step_key);
                let resolution = journal.events.iter().find(|event| {
                    event.get("type").and_then(Value::as_str) == Some("join-resolved")
                        && event
                            .pointer("/payload/join/joinKey")
                            .and_then(Value::as_str)
                            == Some(join_key.as_str())
                });
                if let Some(resolution) = resolution {
                    if resolution
                        .pointer("/payload/join/status")
                        .and_then(Value::as_str)
                        == Some("satisfied")
                    {
                        "ready"
                    } else {
                        "blocked"
                    }
                } else {
                    "waiting"
                }
            };
            match dependency_state {
                "ready" if kind != "coordinate" && available_slots > 0 => {
                    available_slots -= 1;
                    ready_workers += 1;
                    ("ready", "Ready within the declared parallel-work limit.")
                }
                "ready" if kind != "coordinate" => {
                    waiting_steps += 1;
                    (
                        "waiting",
                        "Ready after a current worker leaves its bounded slot.",
                    )
                }
                "ready" => ("ready", "Ready for deterministic aggregation."),
                "blocked" => (
                    "blocked",
                    "Its declared dependencies cannot satisfy this step.",
                ),
                _ => {
                    waiting_steps += 1;
                    ("waiting", "Waiting for its declared dependencies.")
                }
            }
        };
        if matches!(state, "failed" | "blocked" | "partial") {
            blocked_steps += usize::from(state != "partial" || !terminal_run);
        }
        projected_steps.push(json!({
            "stepKey":step_key,
            "title":title,
            "objective":objective,
            "kind":kind,
            "dependsOnStepKeys":dependencies,
            "state":state,
            "detail":detail
        }));
    }

    let mut input_tokens = 0i64;
    let mut output_tokens = 0i64;
    let mut tool_calls = 0i64;
    let mut duration_ms = 0i64;
    let mut usage_records = 0usize;
    let mut cost_observations = Vec::new();
    for event in &journal.events {
        if event.get("type").and_then(Value::as_str) != Some("usage-recorded") {
            continue;
        }
        let usage = event
            .pointer("/payload/usage")
            .and_then(Value::as_object)
            .ok_or_else(|| "Stored Mission usage is invalid.".to_string())?;
        for (field, total) in [
            ("inputTokens", &mut input_tokens),
            ("outputTokens", &mut output_tokens),
            ("toolCalls", &mut tool_calls),
            ("durationMs", &mut duration_ms),
        ] {
            if let Some(value) = usage.get(field) {
                let value = value
                    .as_i64()
                    .filter(|value| *value >= 0)
                    .ok_or_else(|| "Stored Mission usage is invalid.".to_string())?;
                *total = total
                    .checked_add(value)
                    .ok_or_else(|| "Stored Mission usage exceeds safe bounds.".to_string())?;
            }
        }
        let costs = usage
            .get("costs")
            .and_then(Value::as_array)
            .ok_or_else(|| "Stored Mission costs are invalid.".to_string())?;
        if cost_observations.len() + costs.len() > 64 {
            return Err("Stored Mission costs exceed safe bounds.".into());
        }
        cost_observations.extend(
            costs
                .iter()
                .map(safe_cost_observation)
                .collect::<Result<Vec<_>, _>>()?,
        );
        usage_records += 1;
    }

    let criteria = lifecycle
        .mission
        .pointer("/acceptance/criteria")
        .and_then(Value::as_array)
        .ok_or_else(|| "Mission acceptance criteria are invalid.".to_string())?;
    if criteria.len() > 128 {
        return Err("Mission acceptance criteria exceed safe bounds.".into());
    }
    let terminal_acceptance = journal
        .run
        .pointer("/terminalResult/acceptance")
        .and_then(Value::as_array);
    let mut evaluations = BTreeMap::<String, (&str, usize, Option<&str>)>::new();
    for event in &journal.events {
        if event.get("type").and_then(Value::as_str) != Some("evaluation-recorded") {
            continue;
        }
        for criterion in event
            .pointer("/payload/evaluation/criteria")
            .and_then(Value::as_array)
            .ok_or_else(|| "Stored Mission evaluation is invalid.".to_string())?
        {
            let key = criterion
                .get("criterionKey")
                .and_then(Value::as_str)
                .ok_or_else(|| "Stored Mission evaluation criterion is invalid.".to_string())?;
            let status = match criterion.get("passed").and_then(Value::as_bool) {
                Some(true) => "met",
                Some(false) => "not-met",
                None => "not-evaluated",
            };
            let evidence_count = criterion
                .get("evidenceRefs")
                .and_then(Value::as_array)
                .map_or(0, Vec::len);
            let summary = criterion.get("summary").and_then(Value::as_str);
            if evaluations
                .insert(key.to_string(), (status, evidence_count, summary))
                .is_some()
            {
                return Err("Mission evaluation criteria are ambiguous.".into());
            }
        }
    }
    let mut projected_acceptance = Vec::with_capacity(criteria.len());
    let mut criterion_keys = BTreeSet::new();
    for criterion in criteria {
        let key = bounded(
            criterion
                .get("key")
                .and_then(Value::as_str)
                .ok_or_else(|| "Mission acceptance criterion is invalid.".to_string())?,
            "Mission acceptance criterion",
            160,
        )?;
        if !criterion_keys.insert(key.clone()) {
            return Err("Mission acceptance criteria are ambiguous.".into());
        }
        let description = bounded(
            criterion
                .get("description")
                .and_then(Value::as_str)
                .ok_or_else(|| "Mission acceptance description is invalid.".to_string())?,
            "Mission acceptance description",
            2_000,
        )?;
        let terminal = terminal_acceptance.and_then(|entries| {
            entries.iter().find(|entry| {
                entry.get("criterionKey").and_then(Value::as_str) == Some(key.as_str())
            })
        });
        let evaluator = criterion
            .get("evaluator")
            .and_then(Value::as_str)
            .filter(|evaluator| matches!(*evaluator, "policy" | "human" | "worker" | "external"))
            .ok_or_else(|| "Mission acceptance evaluator is invalid.".to_string())?;
        let evaluated_status = terminal
            .and_then(|entry| entry.get("status"))
            .and_then(Value::as_str)
            .or_else(|| evaluations.get(&key).map(|(status, _, _)| *status))
            .unwrap_or("not-evaluated");
        let status = if evaluator == "worker" && evaluated_status == "met" {
            "partially-met"
        } else {
            evaluated_status
        };
        if !matches!(
            status,
            "met" | "partially-met" | "not-met" | "not-evaluated"
        ) {
            return Err("Mission acceptance status is invalid.".into());
        }
        let evidence_count = terminal
            .and_then(|entry| entry.get("evidenceRefs"))
            .and_then(Value::as_array)
            .map(Vec::len)
            .or_else(|| evaluations.get(&key).map(|(_, count, _)| *count))
            .unwrap_or(0);
        if evidence_count > 128 {
            return Err("Mission acceptance evidence exceeds safe bounds.".into());
        }
        let summary = if evaluator == "worker" && evaluated_status == "met" {
            Some(
                "The declared worker review passed this criterion, but model opinion remains advisory."
                    .to_string(),
            )
        } else {
            terminal
                .and_then(|entry| entry.get("summary"))
                .and_then(Value::as_str)
                .or_else(|| evaluations.get(&key).and_then(|(_, _, summary)| *summary))
                .map(|summary| bounded(summary, "Mission acceptance summary", 2_000))
                .transpose()?
        };
        projected_acceptance.push(json!({
            "criterionKey":key,
            "description":description,
            "required":criterion.get("required").and_then(Value::as_bool).unwrap_or(false),
            "evaluator":evaluator,
            "status":status,
            "evidenceCount":evidence_count,
            "summary":summary
        }));
    }

    let completed_steps = projected_steps
        .iter()
        .filter(|step| step.get("state").and_then(Value::as_str) == Some("completed"))
        .count();
    let state = if run_status == "cancelled" {
        "cancelled"
    } else if terminal_run {
        "complete"
    } else if blocked_steps > 0 {
        "blocked"
    } else if running_workers > 0 {
        "running"
    } else if ready_workers > 0
        || projected_steps
            .iter()
            .any(|step| step.get("state").and_then(Value::as_str) == Some("ready"))
    {
        "ready"
    } else {
        "waiting"
    };
    let summary = match state {
        "complete" => "Mission work has reached a durable terminal result.",
        "cancelled" => "Mission work stopped with a durable cancellation.",
        "blocked" => "Mission work needs a declared failure or dependency decision.",
        "running" => "Mission work is progressing within its declared limits.",
        "ready" => "Mission work has a step ready to continue.",
        _ => "Mission work is waiting at a declared boundary.",
    };
    let next_action = match state {
        "complete" | "cancelled" => "No automatic work remains.",
        "blocked" => "Review the blocked step before continuing.",
        "running" => "Wait for current bounded work to settle.",
        "ready" => "Continue the next ready step.",
        _ if projected_acceptance.iter().any(|criterion| {
            criterion.get("evaluator").and_then(Value::as_str) == Some("human")
                && criterion.get("status").and_then(Value::as_str) == Some("not-evaluated")
        }) =>
        {
            "Review the declared human acceptance criteria."
        }
        _ => "Wait for the declared dependency or human response.",
    };
    let review = if matches!(state, "waiting" | "blocked") {
        let criteria = projected_acceptance
            .iter()
            .filter(|criterion| {
                criterion.get("evaluator").and_then(Value::as_str) == Some("human")
                    && criterion.get("status").and_then(Value::as_str) == Some("not-evaluated")
            })
            .cloned()
            .collect::<Vec<_>>();
        if criteria.is_empty() {
            None
        } else {
            Some(json!({
                "runId":journal.run.get("id"),
                "expectedRunRevision":journal.run.get("revision"),
                "expectedLastSequence":journal.run.pointer("/eventHead/lastSequence"),
                "criteria":criteria
            }))
        }
    } else {
        None
    };
    let plan_title = bounded(
        lifecycle
            .mission
            .pointer("/outcome/title")
            .and_then(Value::as_str)
            .ok_or_else(|| "Mission outcome title is invalid.".to_string())?,
        "Mission outcome title",
        400,
    )?;
    let desired_outcome = bounded(
        lifecycle
            .mission
            .pointer("/outcome/desiredOutcome")
            .and_then(Value::as_str)
            .ok_or_else(|| "Mission desired outcome is invalid.".to_string())?,
        "Mission desired outcome",
        2_000,
    )?;
    let plan_summary = bounded(
        lifecycle
            .current_revision
            .get("summary")
            .and_then(Value::as_str)
            .ok_or_else(|| "Selected plan summary is invalid.".to_string())?,
        "Selected plan summary",
        2_000,
    )?;
    Ok(json!({
        "version":1,
        "plan":{
            "title":plan_title,
            "desiredOutcome":desired_outcome,
            "summary":plan_summary,
            "maxParallelSteps":max_parallel
        },
        "state":state,
        "summary":summary,
        "runStatus":run_status,
        "completedSteps":completed_steps,
        "totalSteps":steps.len(),
        "runningWorkers":running_workers,
        "readyWorkers":ready_workers,
        "waitingSteps":waiting_steps,
        "blockedSteps":blocked_steps,
        "steps":projected_steps,
        "usage":{
            "records":usage_records,
            "inputTokens":input_tokens,
            "outputTokens":output_tokens,
            "toolCalls":tool_calls,
            "durationMs":duration_ms,
            "costObservations":cost_observations
        },
        "budget":safe_budget_projection(&journal.run)?,
        "acceptance":projected_acceptance,
        "humanReview":review,
        "nextAction":next_action
    }))
}
