//! Bounded encrypted observations for account-owned native provider routes.
//!
//! These records are evidence only. They never grant provider, credential,
//! workspace, or fallback authority and are projected only as aggregate facts.

use std::collections::BTreeMap;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::store::repos::{open_json, seal_json};
use crate::store::vault::Sealed;
use crate::store::{Result, Store, StoreError};

const MAX_OBSERVATIONS_PER_ROUTE: usize = 50;
const MAX_LATENCY_MS: u64 = 24 * 60 * 60 * 1_000;
const MAX_TOKENS: i64 = 1_000_000_000;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProviderRouteObservationPayload {
    version: u8,
    provider_id: String,
    model_reference: String,
    latency_ms: u64,
    input_tokens: Option<i64>,
    output_tokens: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRouteObservationSummary {
    pub reference: String,
    pub sample_count: usize,
    pub median_latency_ms: u64,
    pub usage_sample_count: usize,
    pub latest_observed_at: String,
}

#[allow(clippy::too_many_arguments)]
pub fn record(
    tx: &Connection,
    store: &Store,
    internal_user_id: &str,
    provider_id: &str,
    provider_route_id: &str,
    observation_id: &str,
    model_reference: &str,
    latency_ms: u64,
    input_tokens: Option<i64>,
    output_tokens: Option<i64>,
    observed_at: &str,
) -> Result<()> {
    let internal_user_id = bounded(internal_user_id, "Observation owner", 160)?;
    let provider_id = bounded(provider_id, "Observation provider", 80)?;
    let provider_route_id = bounded(provider_route_id, "Provider route", 240)?;
    let observation_id = bounded(observation_id, "Route observation", 180)?;
    let model_reference = bounded(model_reference, "Observed model", 160)?;
    let observed_at = bounded(observed_at, "Observation time", 64)?;
    if chrono::DateTime::parse_from_rfc3339(&observed_at).is_err()
        || latency_ms > MAX_LATENCY_MS
        || !valid_tokens(input_tokens)
        || !valid_tokens(output_tokens)
        || input_tokens.is_some() != output_tokens.is_some()
    {
        return Err(StoreError::Invalid(
            "Provider route observation is invalid.".into(),
        ));
    }
    let connected = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM backend_connection WHERE internal_user_id=?1 AND provider_id=?2);",
        rusqlite::params![internal_user_id, provider_id],
        |row| row.get::<_, i64>(0),
    )?;
    if connected != 1 {
        return Err(StoreError::Invalid(
            "Provider route observation requires this installation's connected provider.".into(),
        ));
    }
    let payload = json!(ProviderRouteObservationPayload {
        version: 1,
        provider_id: provider_id.clone(),
        model_reference,
        latency_ms,
        input_tokens,
        output_tokens,
    });
    let aad = observation_aad(&internal_user_id, &provider_route_id, &observation_id);
    if let Some((existing_route_id, existing)) =
        load_exact(tx, store, &internal_user_id, &observation_id)?
    {
        if existing_route_id != provider_route_id || existing != payload {
            return Err(StoreError::Invalid(
                "Route observation id already represents different evidence.".into(),
            ));
        }
        return Ok(());
    }
    let sealed = seal_json(store, &payload, &aad)?;
    tx.execute(
        "INSERT INTO provider_route_observation(
           internal_user_id,provider_id,provider_route_id,observation_id,observed_at,payload,payload_nonce)
         VALUES(?1,?2,?3,?4,?5,?6,?7);",
        rusqlite::params![
            internal_user_id,
            provider_id,
            provider_route_id,
            observation_id,
            observed_at,
            sealed.ciphertext,
            sealed.nonce,
        ],
    )?;
    tx.execute(
        "DELETE FROM provider_route_observation
         WHERE internal_user_id=?1 AND provider_route_id=?2 AND observation_id NOT IN (
           SELECT observation_id FROM provider_route_observation
           WHERE internal_user_id=?1 AND provider_route_id=?2
           ORDER BY observed_at DESC,observation_id DESC LIMIT ?3
         );",
        rusqlite::params![
            internal_user_id,
            provider_route_id,
            MAX_OBSERVATIONS_PER_ROUTE
        ],
    )?;
    Ok(())
}

pub fn summaries(
    tx: &Connection,
    store: &Store,
    internal_user_id: &str,
) -> Result<BTreeMap<String, ProviderRouteObservationSummary>> {
    let internal_user_id = bounded(internal_user_id, "Observation owner", 160)?;
    let mut stmt = tx.prepare(
        "SELECT provider_route_id,observation_id,observed_at,payload,payload_nonce
         FROM provider_route_observation WHERE internal_user_id=?1
         ORDER BY provider_route_id,observed_at DESC,observation_id DESC;",
    )?;
    let rows = stmt
        .query_map([&internal_user_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                Sealed {
                    ciphertext: row.get(3)?,
                    nonce: row.get(4)?,
                },
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut grouped: BTreeMap<String, (Vec<u64>, usize, String)> = BTreeMap::new();
    for (route_id, observation_id, observed_at, sealed) in rows {
        let value = open_json(
            store,
            &sealed,
            &observation_aad(&internal_user_id, &route_id, &observation_id),
        )?;
        let observation: ProviderRouteObservationPayload =
            serde_json::from_value(value).map_err(|_| {
                StoreError::Invalid("Stored provider route observation is invalid.".into())
            })?;
        if observation.version != 1 || observation.latency_ms > MAX_LATENCY_MS {
            return Err(StoreError::Invalid(
                "Stored provider route observation is invalid.".into(),
            ));
        }
        let entry = grouped
            .entry(route_id)
            .or_insert_with(|| (Vec::new(), 0, observed_at.clone()));
        entry.0.push(observation.latency_ms);
        if observation.input_tokens.is_some() && observation.output_tokens.is_some() {
            entry.1 += 1;
        }
        if observed_at > entry.2 {
            entry.2 = observed_at;
        }
    }
    Ok(grouped
        .into_iter()
        .map(
            |(route_id, (mut latencies, usage_sample_count, latest_observed_at))| {
                latencies.sort_unstable();
                let median_latency_ms = latencies[latencies.len() / 2];
                (
                    route_id.clone(),
                    ProviderRouteObservationSummary {
                        reference: summary_reference(
                            &route_id,
                            latencies.len(),
                            median_latency_ms,
                            usage_sample_count,
                            &latest_observed_at,
                        ),
                        sample_count: latencies.len(),
                        median_latency_ms,
                        usage_sample_count,
                        latest_observed_at,
                    },
                )
            },
        )
        .collect())
}

pub fn summary_reference(
    provider_route_id: &str,
    sample_count: usize,
    median_latency_ms: u64,
    usage_sample_count: usize,
    latest_observed_at: &str,
) -> String {
    let digest = Sha256::digest(format!(
        "{provider_route_id}:{sample_count}:{median_latency_ms}:{usage_sample_count}:{latest_observed_at}"
    ));
    format!("route-observation-summary:v1:{digest:x}")
}

fn load_exact(
    tx: &Connection,
    store: &Store,
    internal_user_id: &str,
    observation_id: &str,
) -> Result<Option<(String, serde_json::Value)>> {
    let row = tx.query_row(
        "SELECT provider_route_id,payload,payload_nonce FROM provider_route_observation
         WHERE internal_user_id=?1 AND observation_id=?2;",
        rusqlite::params![internal_user_id, observation_id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                Sealed {
                    ciphertext: row.get(1)?,
                    nonce: row.get(2)?,
                },
            ))
        },
    );
    match row {
        Ok((route_id, sealed)) => {
            let value = open_json(
                store,
                &sealed,
                &observation_aad(internal_user_id, &route_id, observation_id),
            )?;
            Ok(Some((route_id, value)))
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn observation_aad(internal_user_id: &str, route_id: &str, observation_id: &str) -> String {
    format!("provider_route_observation:{internal_user_id}:{route_id}:{observation_id}")
}

fn valid_tokens(value: Option<i64>) -> bool {
    value.is_none_or(|tokens| (0..=MAX_TOKENS).contains(&tokens))
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

    fn store() -> Store {
        let vault = Vault::new(&MasterKey::generate().unwrap()).unwrap();
        let store = Store::open_in_memory(vault).unwrap();
        store
            .transaction(|tx| {
                for user in ["user-a", "user-b"] {
                    tx.execute(
                        "INSERT INTO fable_internal_user_mirror(internal_user_id,status,revision,updated_at)
                         VALUES(?1,'active',1,'2026-07-12T00:00:00Z');",
                        [user],
                    )?;
                    crate::store::repos::backend_connection::upsert(
                        tx,
                        user,
                        "openai",
                        "2026-07-12T00:00:00Z",
                    )?;
                }
                Ok(())
            })
            .unwrap();
        store
    }

    #[test]
    fn observations_are_encrypted_bounded_idempotent_and_account_isolated() {
        let store = store();
        store
            .transaction(|tx| {
                for (index, latency) in [300_u64, 100, 200].into_iter().enumerate() {
                    record(
                        tx,
                        &store,
                        "user-a",
                        "openai",
                        "route-a",
                        &format!("observation-{index}"),
                        "gpt-5",
                        latency,
                        Some(10),
                        Some(4),
                        &format!("2026-07-12T00:00:0{index}Z"),
                    )?;
                }
                record(
                    tx,
                    &store,
                    "user-a",
                    "openai",
                    "route-a",
                    "observation-0",
                    "gpt-5",
                    300,
                    Some(10),
                    Some(4),
                    "2026-07-12T00:00:00Z",
                )?;
                record(
                    tx,
                    &store,
                    "user-b",
                    "openai",
                    "route-b",
                    "observation-b",
                    "gpt-5",
                    999,
                    None,
                    None,
                    "2026-07-12T00:00:00Z",
                )?;
                Ok(())
            })
            .unwrap();
        let summary = store
            .with_conn(|tx| summaries(tx, &store, "user-a"))
            .unwrap();
        assert_eq!(summary.len(), 1);
        assert_eq!(summary["route-a"].sample_count, 3);
        assert_eq!(summary["route-a"].median_latency_ms, 200);
        assert_eq!(summary["route-a"].usage_sample_count, 3);
        let ciphertext = store
            .with_conn(|tx| {
                tx.query_row(
                    "SELECT payload FROM provider_route_observation WHERE internal_user_id='user-a' LIMIT 1;",
                    [],
                    |row| row.get::<_, Vec<u8>>(0),
                )
                .map_err(StoreError::from)
            })
            .unwrap();
        assert!(!String::from_utf8_lossy(&ciphertext).contains("gpt-5"));
    }

    #[test]
    fn changed_replay_and_unconnected_provider_fail_closed() {
        let store = store();
        store
            .transaction(|tx| {
                record(
                    tx,
                    &store,
                    "user-a",
                    "openai",
                    "route-a",
                    "observation-a",
                    "gpt-5",
                    100,
                    None,
                    None,
                    "2026-07-12T00:00:00Z",
                )?;
                assert!(record(
                    tx,
                    &store,
                    "user-a",
                    "openai",
                    "route-a",
                    "observation-a",
                    "gpt-5",
                    101,
                    None,
                    None,
                    "2026-07-12T00:00:00Z",
                )
                .is_err());
                assert!(record(
                    tx,
                    &store,
                    "user-a",
                    "anthropic",
                    "route-x",
                    "observation-x",
                    "claude-sonnet-4-6",
                    100,
                    None,
                    None,
                    "2026-07-12T00:00:00Z",
                )
                .is_err());
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn route_history_keeps_only_the_newest_fifty_samples() {
        let store = store();
        store
            .transaction(|tx| {
                for index in 0..55 {
                    record(
                        tx,
                        &store,
                        "user-a",
                        "openai",
                        "route-a",
                        &format!("observation-{index:02}"),
                        "gpt-5",
                        100 + index,
                        None,
                        None,
                        &format!("2026-07-12T00:{:02}:{:02}Z", index / 60, index % 60),
                    )?;
                }
                Ok(())
            })
            .unwrap();
        let summary = store
            .with_conn(|tx| summaries(tx, &store, "user-a"))
            .unwrap();
        assert_eq!(summary["route-a"].sample_count, MAX_OBSERVATIONS_PER_ROUTE);
    }
}
