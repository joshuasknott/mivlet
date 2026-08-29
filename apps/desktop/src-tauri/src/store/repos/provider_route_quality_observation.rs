//! Bounded encrypted policy-evaluation outcomes for install-owned provider routes.
//!
//! Only a native evaluator may write these records. A cohort is scoped to one
//! exact policy implementation revision; it is evidence, never general model
//! quality or provider, route, evaluator, workspace, or fallback authority.

use std::collections::BTreeMap;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::store::repos::{open_json, seal_json};
use crate::store::vault::Sealed;
use crate::store::{Result, Store, StoreError};

const MAX_OBSERVATIONS_PER_ROUTE_POLICY: usize = 50;
const MAX_CRITERIA: usize = 64;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProviderRouteQualityPayload {
    version: u8,
    provider_id: String,
    model_reference: String,
    workspace_id: String,
    owner_member_id: String,
    plan_revision_id: String,
    run_id: String,
    worker_id: String,
    route_selection_event_id: String,
    evaluation_event_id: String,
    passed: bool,
    criterion_count: usize,
    evaluated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRouteQualitySummary {
    pub reference: String,
    pub policy_revision_ref: String,
    pub sample_count: usize,
    pub passed_count: usize,
    pub routing_score_basis_points: u16,
    pub latest_evaluated_at: String,
}

#[allow(clippy::too_many_arguments)]
pub fn record(
    tx: &Connection,
    store: &Store,
    internal_user_id: &str,
    provider_id: &str,
    provider_route_id: &str,
    policy_revision_ref: &str,
    observation_id: &str,
    model_reference: &str,
    workspace_id: &str,
    owner_member_id: &str,
    plan_revision_id: &str,
    run_id: &str,
    worker_id: &str,
    route_selection_event_id: &str,
    evaluation_event_id: &str,
    passed: bool,
    criterion_count: usize,
    evaluated_at: &str,
) -> Result<()> {
    let internal_user_id = bounded(internal_user_id, "Quality owner", 160)?;
    let provider_id = bounded(provider_id, "Quality provider", 80)?;
    let provider_route_id = bounded(provider_route_id, "Provider route", 240)?;
    let policy_revision_ref = bounded(policy_revision_ref, "Quality policy revision", 240)?;
    let observation_id = bounded(observation_id, "Quality observation", 180)?;
    let model_reference = bounded(model_reference, "Quality model", 160)?;
    let workspace_id = bounded(workspace_id, "Quality workspace", 160)?;
    let owner_member_id = bounded(owner_member_id, "Quality member", 160)?;
    let plan_revision_id = bounded(plan_revision_id, "Quality plan revision", 160)?;
    let run_id = bounded(run_id, "Quality run", 160)?;
    let worker_id = bounded(worker_id, "Quality worker", 160)?;
    let route_selection_event_id =
        bounded(route_selection_event_id, "Quality route selection", 160)?;
    let evaluation_event_id = bounded(evaluation_event_id, "Quality evaluation", 160)?;
    let evaluated_at = bounded(evaluated_at, "Quality evaluation time", 64)?;
    if criterion_count == 0
        || criterion_count > MAX_CRITERIA
        || chrono::DateTime::parse_from_rfc3339(&evaluated_at).is_err()
    {
        return Err(StoreError::Invalid(
            "Provider route policy observation is invalid.".into(),
        ));
    }
    let connected = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM backend_connection WHERE internal_user_id=?1 AND provider_id=?2);",
        rusqlite::params![internal_user_id, provider_id],
        |row| row.get::<_, i64>(0),
    )?;
    if connected != 1 {
        return Err(StoreError::Invalid(
            "Provider route policy evidence requires this installation's connected provider."
                .into(),
        ));
    }
    let payload = json!(ProviderRouteQualityPayload {
        version: 1,
        provider_id: provider_id.clone(),
        model_reference,
        workspace_id,
        owner_member_id,
        plan_revision_id,
        run_id,
        worker_id,
        route_selection_event_id,
        evaluation_event_id,
        passed,
        criterion_count,
        evaluated_at: evaluated_at.clone(),
    });
    if let Some((existing_route_id, existing_policy_ref, existing)) =
        load_exact(tx, store, &internal_user_id, &observation_id)?
    {
        if existing_route_id != provider_route_id
            || existing_policy_ref != policy_revision_ref
            || existing != payload
        {
            return Err(StoreError::Invalid(
                "Route policy observation id already represents different evidence.".into(),
            ));
        }
        return Ok(());
    }
    let aad = observation_aad(
        &internal_user_id,
        &provider_route_id,
        &policy_revision_ref,
        &observation_id,
    );
    let sealed = seal_json(store, &payload, &aad)?;
    tx.execute(
        "INSERT INTO provider_route_quality_observation(
           internal_user_id,provider_id,provider_route_id,policy_revision_ref,observation_id,evaluated_at,payload,payload_nonce)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8);",
        rusqlite::params![
            internal_user_id,
            provider_id,
            provider_route_id,
            policy_revision_ref,
            observation_id,
            evaluated_at,
            sealed.ciphertext,
            sealed.nonce,
        ],
    )?;
    tx.execute(
        "DELETE FROM provider_route_quality_observation
         WHERE internal_user_id=?1 AND provider_route_id=?2 AND policy_revision_ref=?3
           AND observation_id NOT IN (
             SELECT observation_id FROM provider_route_quality_observation
             WHERE internal_user_id=?1 AND provider_route_id=?2 AND policy_revision_ref=?3
             ORDER BY evaluated_at DESC,observation_id DESC LIMIT ?4
           );",
        rusqlite::params![
            internal_user_id,
            provider_route_id,
            policy_revision_ref,
            MAX_OBSERVATIONS_PER_ROUTE_POLICY
        ],
    )?;
    Ok(())
}

pub fn summaries_for_policy(
    tx: &Connection,
    store: &Store,
    internal_user_id: &str,
    policy_revision_ref: &str,
) -> Result<BTreeMap<String, ProviderRouteQualitySummary>> {
    let internal_user_id = bounded(internal_user_id, "Quality owner", 160)?;
    let policy_revision_ref = bounded(policy_revision_ref, "Quality policy revision", 240)?;
    let mut stmt = tx.prepare(
        "SELECT provider_route_id,observation_id,evaluated_at,payload,payload_nonce
         FROM provider_route_quality_observation
         WHERE internal_user_id=?1 AND policy_revision_ref=?2
         ORDER BY provider_route_id,evaluated_at DESC,observation_id DESC;",
    )?;
    let rows = stmt
        .query_map(
            rusqlite::params![internal_user_id, policy_revision_ref],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    Sealed {
                        ciphertext: row.get(3)?,
                        nonce: row.get(4)?,
                    },
                ))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut grouped: BTreeMap<String, (usize, usize, String)> = BTreeMap::new();
    for (route_id, observation_id, evaluated_at, sealed) in rows {
        let value = open_json(
            store,
            &sealed,
            &observation_aad(
                &internal_user_id,
                &route_id,
                &policy_revision_ref,
                &observation_id,
            ),
        )?;
        let observation: ProviderRouteQualityPayload =
            serde_json::from_value(value).map_err(|_| {
                StoreError::Invalid("Stored route policy observation is invalid.".into())
            })?;
        if observation.version != 1
            || observation.criterion_count == 0
            || observation.criterion_count > MAX_CRITERIA
        {
            return Err(StoreError::Invalid(
                "Stored route policy observation is invalid.".into(),
            ));
        }
        let entry = grouped
            .entry(route_id)
            .or_insert((0, 0, evaluated_at.clone()));
        entry.0 += 1;
        entry.1 += usize::from(observation.passed);
        if evaluated_at > entry.2 {
            entry.2 = evaluated_at;
        }
    }
    Ok(grouped
        .into_iter()
        .map(
            |(route_id, (sample_count, passed_count, latest_evaluated_at))| {
                // Laplace smoothing prevents a one-sample cohort from becoming a
                // categorical routing claim. Raw pass counts remain visible.
                let routing_score_basis_points =
                    (((passed_count + 1) * 10_000) / (sample_count + 2)) as u16;
                (
                    route_id.clone(),
                    ProviderRouteQualitySummary {
                        reference: summary_reference(
                            &route_id,
                            &policy_revision_ref,
                            sample_count,
                            passed_count,
                            routing_score_basis_points,
                            &latest_evaluated_at,
                        ),
                        policy_revision_ref: policy_revision_ref.clone(),
                        sample_count,
                        passed_count,
                        routing_score_basis_points,
                        latest_evaluated_at,
                    },
                )
            },
        )
        .collect())
}

pub fn summary_reference(
    provider_route_id: &str,
    policy_revision_ref: &str,
    sample_count: usize,
    passed_count: usize,
    routing_score_basis_points: u16,
    latest_evaluated_at: &str,
) -> String {
    let digest = Sha256::digest(format!(
        "{provider_route_id}:{policy_revision_ref}:{sample_count}:{passed_count}:{routing_score_basis_points}:{latest_evaluated_at}"
    ));
    format!("route-policy-summary:v1:{digest:x}")
}

fn load_exact(
    tx: &Connection,
    store: &Store,
    internal_user_id: &str,
    observation_id: &str,
) -> Result<Option<(String, String, serde_json::Value)>> {
    let row = tx.query_row(
        "SELECT provider_route_id,policy_revision_ref,payload,payload_nonce
         FROM provider_route_quality_observation
         WHERE internal_user_id=?1 AND observation_id=?2;",
        rusqlite::params![internal_user_id, observation_id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                Sealed {
                    ciphertext: row.get(2)?,
                    nonce: row.get(3)?,
                },
            ))
        },
    );
    match row {
        Ok((route_id, policy_revision_ref, sealed)) => {
            let value = open_json(
                store,
                &sealed,
                &observation_aad(
                    internal_user_id,
                    &route_id,
                    &policy_revision_ref,
                    observation_id,
                ),
            )?;
            Ok(Some((route_id, policy_revision_ref, value)))
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn observation_aad(
    internal_user_id: &str,
    route_id: &str,
    policy_revision_ref: &str,
    observation_id: &str,
) -> String {
    format!(
        "provider_route_quality_observation:{internal_user_id}:{route_id}:{policy_revision_ref}:{observation_id}"
    )
}

fn bounded(value: &str, label: &str, max: usize) -> Result<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max || value.chars().any(char::is_control) {
        return Err(StoreError::Invalid(format!(
            "{label} must be between 1 and {max} characters."
        )));
    }
    Ok(value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::vault::{MasterKey, Vault};

    const POLICY: &str = "native-policy:v1:test";

    fn store() -> Store {
        let store =
            Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap();
        store
            .transaction(|tx| {
                tx.execute("INSERT INTO fable_internal_user_mirror(internal_user_id,status,revision,updated_at) VALUES('user-a','active',1,'2026-07-13T00:00:00Z');", [])?;
                crate::store::repos::backend_connection::upsert(
                    tx,
                    "user-a",
                    "openai",
                    "2026-07-13T00:00:00Z",
                )?;
                Ok(())
            })
            .unwrap();
        store
    }

    #[allow(clippy::too_many_arguments)]
    fn record_test(
        tx: &Connection,
        store: &Store,
        observation: &str,
        policy: &str,
        passed: bool,
        at: &str,
    ) -> Result<()> {
        record(
            tx,
            store,
            "user-a",
            "openai",
            "route-a",
            policy,
            observation,
            "gpt-5",
            "workspace-a",
            "member-a",
            "plan-revision-a",
            "run-a",
            "worker-a",
            "route-event-a",
            observation,
            passed,
            1,
            at,
        )
    }

    #[test]
    fn policy_evidence_is_encrypted_idempotent_revision_bound_and_smoothed() {
        let store = store();
        store
            .transaction(|tx| {
                for (index, passed) in [true, false, true].into_iter().enumerate() {
                    record_test(
                        tx,
                        &store,
                        &format!("evaluation-{index}"),
                        POLICY,
                        passed,
                        &format!("2026-07-13T00:00:0{index}Z"),
                    )?;
                }
                record_test(
                    tx,
                    &store,
                    "evaluation-0",
                    POLICY,
                    true,
                    "2026-07-13T00:00:00Z",
                )?;
                record_test(
                    tx,
                    &store,
                    "evaluation-other",
                    "native-policy:v2:test",
                    false,
                    "2026-07-13T00:00:03Z",
                )?;
                Ok(())
            })
            .unwrap();
        let summary = store
            .with_conn(|tx| summaries_for_policy(tx, &store, "user-a", POLICY))
            .unwrap();
        assert_eq!(summary["route-a"].sample_count, 3);
        assert_eq!(summary["route-a"].passed_count, 2);
        assert_eq!(summary["route-a"].routing_score_basis_points, 6_000);
        assert_eq!(summary["route-a"].policy_revision_ref, POLICY);
        let ciphertext = store
            .with_conn(|tx| {
                tx.query_row(
                    "SELECT payload FROM provider_route_quality_observation LIMIT 1",
                    [],
                    |row| row.get::<_, Vec<u8>>(0),
                )
                .map_err(StoreError::from)
            })
            .unwrap();
        assert!(!String::from_utf8_lossy(&ciphertext).contains("plan-revision-a"));
    }

    #[test]
    fn changed_replay_and_unconnected_provider_fail_closed() {
        let store = store();
        store
            .transaction(|tx| {
                record_test(
                    tx,
                    &store,
                    "evaluation-a",
                    POLICY,
                    true,
                    "2026-07-13T00:00:00Z",
                )?;
                assert!(record_test(
                    tx,
                    &store,
                    "evaluation-a",
                    POLICY,
                    false,
                    "2026-07-13T00:00:00Z",
                )
                .is_err());
                assert!(record(
                    tx,
                    &store,
                    "user-a",
                    "anthropic",
                    "route-x",
                    POLICY,
                    "evaluation-x",
                    "model",
                    "workspace-a",
                    "member-a",
                    "revision-a",
                    "run-a",
                    "worker-a",
                    "route-event-a",
                    "evaluation-x",
                    true,
                    1,
                    "2026-07-13T00:00:00Z",
                )
                .is_err());
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn retention_is_capped_per_route_and_policy_revision() {
        let store = store();
        store
            .transaction(|tx| {
                for index in 0..=50 {
                    record_test(
                        tx,
                        &store,
                        &format!("evaluation-{index:02}"),
                        POLICY,
                        index % 2 == 0,
                        &format!("2026-07-13T00:{index:02}:00Z"),
                    )?;
                }
                Ok(())
            })
            .unwrap();
        let summary = store
            .with_conn(|tx| summaries_for_policy(tx, &store, "user-a", POLICY))
            .unwrap();
        assert_eq!(summary["route-a"].sample_count, 50);
        let count = store
            .with_conn(|tx| {
                tx.query_row(
                    "SELECT COUNT(*) FROM provider_route_quality_observation WHERE policy_revision_ref=?1",
                    [POLICY],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(StoreError::from)
            })
            .unwrap();
        assert_eq!(count, 50);
    }
}
