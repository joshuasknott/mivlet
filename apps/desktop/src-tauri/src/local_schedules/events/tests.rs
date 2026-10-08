use super::super::*;
use super::{delivery, models::*, signature, template};
use crate::store::vault::{MasterKey, Vault};
use std::collections::BTreeMap;

const NOW: &str = "2026-10-08T12:00:00.000Z";
const SECRET: &str = "temporary-test-signing-secret";
fn at(time: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(time)
        .unwrap()
        .with_timezone(&Utc)
}
fn config() -> EventConfig {
    EventConfig {
        source: EventSource::SignedJson {
            source_id: "ci.example".into(),
        },
        fields: vec!["summary".into()],
        max_age_seconds: 300,
        valid_until: "2026-10-09T12:00:00Z".into(),
        route_id: "ab".repeat(32),
        key_version: 1,
        signing_key_id: "webhook-key:test".into(),
    }
}
fn headers(raw: &[u8], id: &str, now: DateTime<Utc>) -> BTreeMap<String, String> {
    let mut signed = format!("v1\nci.example\n{id}\n{}\n", now.timestamp()).into_bytes();
    signed.extend_from_slice(raw);
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, SECRET.as_bytes());
    BTreeMap::from([
        ("x-mivlet-event-source".into(), "ci.example".into()),
        ("x-mivlet-event-id".into(), id.into()),
        ("x-mivlet-event-time".into(), now.timestamp().to_string()),
        (
            "x-mivlet-signature".into(),
            format!(
                "v1={}",
                hex::encode(ring::hmac::sign(&key, &signed).as_ref())
            ),
        ),
    ])
}
fn verify(raw: &[u8], signature: &str) -> Result<bool, String> {
    let signature = hex::decode(signature.strip_prefix("sha256=").unwrap_or(""))
        .map_err(|_| "bad".to_string())?;
    Ok(ring::hmac::verify(
        &ring::hmac::Key::new(ring::hmac::HMAC_SHA256, SECRET.as_bytes()),
        raw,
        &signature,
    )
    .is_ok())
}
fn fixture() -> (Store, AuthorizedCommandScope) {
    let store =
        Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap();
    let scope = store
        .with_conn(|conn| {
            authorized_scope::resolve(conn, Some("default"), None, ScopeAccess::Write)
        })
        .unwrap();
    store
        .transaction(|conn| {
            create_at(
                conn,
                &store,
                &scope,
                CreateLocalScheduleRequest {
                    workspace_id: "default".into(),
                    id: "event-test".into(),
                    project_id: None,
                    agent_id: "agent-test".into(),
                    provider_id: "openai".into(),
                    model: "gpt-5".into(),
                    reasoning_effort: None,
                    prompt: "Summarize {{body.summary}}".into(),
                    timezone: "UTC".into(),
                    trigger: LocalScheduleTrigger::Event { config: config() },
                    execution_kind: "agent".into(),
                    permission_mode: "read-only".into(),
                    status: LocalScheduleStatus::Enabled,
                },
                at(NOW),
            )
        })
        .unwrap();
    (store, scope)
}
fn receive(
    store: &Store,
    scope: &AuthorizedCommandScope,
    raw: &[u8],
    id: &str,
    now: DateTime<Utc>,
) -> delivery::Receipt {
    delivery::receive(
        store,
        scope,
        delivery::IncomingEvent {
            schedule_id: "event-test",
            route: &config().route_id,
            headers: &headers(raw, id, now),
            raw,
            now,
        },
        |_, _, body, signature| verify(body, signature),
        |_, _, preview| Ok(preview),
        &(),
    )
    .unwrap()
}

#[test]
fn persisted_event_trigger_round_trips_the_flattened_protocol_shape() {
    let trigger = LocalScheduleTrigger::Event { config: config() };
    let value = serde_json::to_value(&trigger).unwrap();
    assert_eq!(value["kind"], "event");
    assert_eq!(value["source"]["sourceId"], "ci.example");
    assert_eq!(value["signingKeyId"], "webhook-key:test");
    assert_eq!(
        serde_json::from_value::<LocalScheduleTrigger>(value).unwrap(),
        trigger
    );
    let mut draft = serde_json::to_value(config().draft()).unwrap();
    draft["permissionMode"] = serde_json::json!("full-access");
    assert!(serde_json::from_value::<EventDraft>(draft).is_err());
}

#[test]
fn signatures_bind_exact_bytes_and_all_envelope_identity() {
    let raw = br#"{ "summary": "Build failed" }"#;
    let h = headers(raw, "build-1", at(NOW));
    assert!(signature::verify(&config(), &h, raw, at(NOW), verify).is_ok());
    assert!(signature::verify(
        &config(),
        &h,
        br#"{"summary":"Build failed"}"#,
        at(NOW),
        verify
    )
    .is_err());
    for name in [
        "x-mivlet-event-id",
        "x-mivlet-event-time",
        "x-mivlet-event-source",
        "x-mivlet-signature",
    ] {
        let mut tampered = h.clone();
        tampered.insert(name.into(), "changed".into());
        assert!(signature::verify(&config(), &tampered, raw, at(NOW), verify).is_err());
    }
    assert!(signature::verify(&config(), &h, raw, at("2026-10-08T12:06:00Z"), verify).is_err());
    assert!(signature::verify(&config(), &h, raw, at("2026-10-08T11:59:00Z"), verify).is_err());
    assert!(signature::verify(
        &config(),
        &h,
        raw,
        at(NOW),
        |_, _| Err("revoked key".into())
    )
    .is_err());
}

#[test]
fn github_uses_signed_body_identity_and_freshness_not_unsigned_delivery_headers() {
    let mut config = config();
    config.source = EventSource::GithubIssues {
        repository: "acme/widget".into(),
    };
    let raw=br#"{"repository":{"full_name":"acme/widget"},"action":"opened","issue":{"updated_at":"2026-10-08T12:00:00Z"}}"#;
    let signature = hex::encode(
        ring::hmac::sign(
            &ring::hmac::Key::new(ring::hmac::HMAC_SHA256, SECRET.as_bytes()),
            raw,
        )
        .as_ref(),
    );
    let mut headers = BTreeMap::from([
        ("x-hub-signature-256".into(), format!("sha256={signature}")),
        ("x-github-event".into(), "issues".into()),
        ("x-github-delivery".into(), "one".into()),
    ]);
    let first = signature::verify(&config, &headers, raw, at(NOW), verify).unwrap();
    headers.insert("x-github-delivery".into(), "forged-new-guid".into());
    let replay = signature::verify(&config, &headers, raw, at(NOW), verify).unwrap();
    assert_eq!(first.id_fingerprint, replay.id_fingerprint);
    config.source = EventSource::GithubIssues {
        repository: "another/repository".into(),
    };
    assert!(signature::verify(&config, &headers, raw, at(NOW), verify).is_err());
}

#[test]
fn templates_only_expose_selected_bounded_scalars_and_redact_credentials() {
    let mut draft = config().draft();
    draft.fields = vec!["summary".into(), "count".into()];
    let rendered=template::render(&draft,"Inspect {{body.summary}} ({{body.count}})",&serde_json::json!({"summary":"Build failed\n{{body.secret}}", "count":3,"secret":"never-published"})).unwrap();
    assert!(!rendered.prompt.contains("never-published"));
    assert!(rendered.prompt.contains("\\n"));
    assert_eq!(rendered.selected_fields["count"], 3);
    for path in [
        "authorization",
        "metadata.api_key",
        "secrets.value",
        "__proto__.value",
    ] {
        draft.fields = vec![path.into()];
        assert!(template::validate(&draft, "Inspect").is_err());
    }
    let draft = config().draft();
    assert!(template::validate(&draft, "{{body}}").is_err());
    assert!(template::validate(&draft, "{{headers.authorization}}").is_err());
    assert!(template::validate(&draft, "{{body.other}}").is_err());
    assert!(template::validate(&draft, "Close }} before {{body.summary}}").is_err());
    let mut source_canary = draft.clone();
    source_canary.source = EventSource::SignedJson {
        source_id: "ghp_abcdefghijklmnopqrstuvwx1234567890".into(),
    };
    assert!(template::validate(&source_canary, "Inspect").is_err());
    source_canary.source = EventSource::GithubIssues {
        repository: "acme/ghp_abcdefghijklmnopqrstuvwx1234567890".into(),
    };
    assert!(template::validate(&source_canary, "Inspect").is_err());
    assert!(template::render(
        &draft,
        "Inspect {{body.summary}}",
        &serde_json::json!({"summary":{"secret":"not-scalar"}})
    )
    .is_err());
    assert!(template::render(
        &draft,
        "Inspect {{body.summary}}",
        &serde_json::json!({"summary":"x".repeat(2049)})
    )
    .is_err());
    assert!(template::parse(br#"[1,2]"#).is_err());
    assert!(template::parse(b"broken json").is_err());
    assert!(template::parse(&vec![b' '; template::MAX_BODY_BYTES + 1]).is_err());
}

#[test]
fn durable_duplicates_and_conflicts_never_create_another_occurrence() {
    let (store, scope) = fixture();
    let raw = br#"{"summary":"Build failed"}"#;
    let first = receive(&store, &scope, raw, "build-1", at(NOW));
    assert_eq!(first.status, 202);
    let again = receive(&store, &scope, raw, "build-1", at(NOW));
    assert_eq!(again.status, 200);
    assert_eq!(first.id, again.id);
    let conflict = receive(
        &store,
        &scope,
        br#"{"summary":"Different payload"}"#,
        "build-1",
        at(NOW),
    );
    assert_eq!(conflict.status, 409);
    let claim = claim_due_after_capacity(
        &store,
        &scope.private,
        LocalScheduleCapacityReservation::new("capacity-test".into()).unwrap(),
        at(NOW),
    )
    .unwrap()
    .unwrap();
    assert!(claim.prompt.contains("Build failed"));
    assert!(claim_due_after_capacity(
        &store,
        &scope.private,
        LocalScheduleCapacityReservation::new("capacity-again".into()).unwrap(),
        at(NOW)
    )
    .unwrap()
    .is_none());
    assert_eq!(receive(&store, &scope, raw, "build-1", at(NOW)).status, 200);
}

#[test]
fn failed_authentication_never_stages_work_or_persists_payload() {
    let (store, scope) = fixture();
    let raw = br#"{"summary":"private-canary"}"#;
    let receipt = delivery::receive(
        &store,
        &scope,
        delivery::IncomingEvent {
            schedule_id: "event-test",
            route: &config().route_id,
            headers: &BTreeMap::new(),
            raw,
            now: at(NOW),
        },
        |_, _, _, _| Ok(false),
        |_, _, preview| Ok(preview),
        &(),
    )
    .unwrap();
    assert_eq!(receipt.status, 401);
    let rows = store
        .with_conn(|conn| {
            crate::store::repos::local_event::list(conn, &store, &scope.private, "event-test", 50)
        })
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert!(!rows[0].payload.to_string().contains("private-canary"));
    assert!(claim_due_after_capacity(
        &store,
        &scope.private,
        LocalScheduleCapacityReservation::new("capacity-test".into()).unwrap(),
        at(NOW)
    )
    .unwrap()
    .is_none());
}

#[test]
fn account_stop_between_verification_and_commit_persists_no_delivery() {
    struct StoppedFence;
    impl delivery::ReceiptFence for StoppedFence {
        fn commit<T>(
            &self,
            _: impl FnOnce() -> crate::store::Result<T>,
        ) -> crate::store::Result<T> {
            Err(StoreError::Invalid(
                "Account stopped after verification".into(),
            ))
        }
    }
    let (store, scope) = fixture();
    let raw = br#"{"summary":"Account stop canary"}"#;
    assert!(delivery::receive(
        &store,
        &scope,
        delivery::IncomingEvent {
            schedule_id: "event-test",
            route: &config().route_id,
            headers: &headers(raw, "one", at(NOW)),
            raw,
            now: at(NOW)
        },
        |_, _, body, signature| verify(body, signature),
        |_, _, preview| Ok(preview),
        &StoppedFence
    )
    .is_err());
    assert_eq!(
        store
            .with_conn(|conn| crate::store::repos::local_event::count(
                conn,
                &scope.private,
                "event-test"
            ))
            .unwrap(),
        0
    );
}

#[test]
fn native_verification_runs_outside_the_account_commit_fence() {
    use std::cell::Cell;
    struct Fence(Cell<bool>);
    impl delivery::ReceiptFence for Fence {
        fn commit<T>(
            &self,
            operation: impl FnOnce() -> crate::store::Result<T>,
        ) -> crate::store::Result<T> {
            self.0.set(true);
            let result = operation();
            self.0.set(false);
            result
        }
    }
    let (store, scope) = fixture();
    let fence = Fence(Cell::new(false));
    let raw = br#"{"summary":"Native verifier"}"#;
    let receipt = delivery::receive(
        &store,
        &scope,
        delivery::IncomingEvent {
            schedule_id: "event-test",
            route: &config().route_id,
            headers: &headers(raw, "one", at(NOW)),
            raw,
            now: at(NOW),
        },
        |_, _, body, signature| {
            assert!(
                !fence.0.get(),
                "Native custody must acquire its own identity lock"
            );
            verify(body, signature)
        },
        |_, _, preview| {
            assert!(!fence.0.get());
            Ok(preview)
        },
        &fence,
    )
    .unwrap();
    assert_eq!(receipt.status, 202);
}

#[test]
fn pause_and_resume_do_not_replay_held_or_paused_deliveries() {
    let (store, scope) = fixture();
    let raw = br#"{"summary":"Build failed"}"#;
    receive(&store, &scope, raw, "one", at(NOW));
    let paused = store
        .transaction(|conn| {
            set_status_at(
                conn,
                &store,
                &scope,
                SetLocalScheduleStatusRequest {
                    workspace_id: "default".into(),
                    id: "event-test".into(),
                    expected_revision: 1,
                    status: LocalScheduleStatus::Paused,
                },
                at(NOW),
            )
        })
        .unwrap();
    assert_eq!(receive(&store, &scope, raw, "two", at(NOW)).status, 409);
    store
        .transaction(|conn| {
            set_status_at(
                conn,
                &store,
                &scope,
                SetLocalScheduleStatusRequest {
                    workspace_id: "default".into(),
                    id: "event-test".into(),
                    expected_revision: paused.revision,
                    status: LocalScheduleStatus::Enabled,
                },
                at(NOW),
            )
        })
        .unwrap();
    assert!(claim_due_after_capacity(
        &store,
        &scope.private,
        LocalScheduleCapacityReservation::new("capacity-test".into()).unwrap(),
        at(NOW)
    )
    .unwrap()
    .is_none());
}

#[test]
fn queued_event_expiry_and_trigger_revision_changes_fail_closed() {
    let (store, scope) = fixture();
    receive(
        &store,
        &scope,
        br#"{"summary":"Build failed"}"#,
        "one",
        at(NOW),
    );
    assert!(claim_due_after_capacity(
        &store,
        &scope.private,
        LocalScheduleCapacityReservation::new("capacity-test".into()).unwrap(),
        at("2026-10-08T12:06:00Z")
    )
    .unwrap()
    .is_none());
    let rows = store
        .with_conn(|conn| {
            crate::store::repos::local_event::list(conn, &store, &scope.private, "event-test", 50)
        })
        .unwrap();
    assert_eq!(rows[0].state, "expired");
}

#[test]
fn staging_uses_canonical_work_with_frozen_event_provenance_and_permission_ceiling() {
    use crate::collaboration::models::{Work, WorkStatus};
    use crate::store::repos::{collaboration, collaboration::Kind};
    let (store, scope) = fixture();
    let raw = br#"{"summary":"Build failed","permissionMode":"full-access"}"#;
    receive(&store, &scope, raw, "build-1", at(NOW));
    let claim = claim_due_after_capacity(
        &store,
        &scope.private,
        LocalScheduleCapacityReservation::new("capacity-test".into()).unwrap(),
        at(NOW),
    )
    .unwrap()
    .unwrap();
    let profiles=vec![serde_json::from_value(serde_json::json!({"id":"agent-test","name":"Scout","instructions":"Use existing Work controls","modelId":"openai::gpt-5","icon":"sparkle","permissionLabel":"Full Access"})).unwrap()];
    store
        .transaction(|conn| {
            automation::stage_at(
                conn,
                &store,
                &scope,
                &profiles,
                &claim.occurrence_id,
                &claim.claim_token,
                at(NOW),
            )
        })
        .unwrap();
    let work: Work = store
        .with_conn(|conn| {
            collaboration::get(
                conn,
                &store,
                &scope.private,
                Kind::Work,
                &format!("work-schedule-{}", claim.occurrence_id),
            )
        })
        .unwrap()
        .unwrap();
    assert_eq!(work.status, WorkStatus::Queued);
    assert_eq!(work.permission_mode, "read-only");
    assert_eq!(work.user_request, claim.prompt);
    let event = work.schedule.as_ref().unwrap().event.as_ref().unwrap();
    assert_eq!(event.source, config().source);
    assert_eq!(event.selected_fields["summary"], "Build failed");
    assert_eq!(event.selected_fields.len(), 1);
    let serialized = serde_json::to_string(&work).unwrap();
    assert!(!serialized.contains(SECRET));
    assert!(!serialized.contains(&claim.claim_token));
    assert!(store
        .with_conn(|conn| crate::collaboration::check_schedule(
            conn,
            &store,
            &scope.private,
            &work,
            NOW,
            false
        ))
        .is_ok());
    store
        .transaction(|conn| {
            set_status_at(
                conn,
                &store,
                &scope,
                SetLocalScheduleStatusRequest {
                    workspace_id: "default".into(),
                    id: "event-test".into(),
                    expected_revision: 1,
                    status: LocalScheduleStatus::Paused,
                },
                at(NOW),
            )
        })
        .unwrap();
    assert!(store
        .with_conn(|conn| crate::collaboration::check_schedule(
            conn,
            &store,
            &scope.private,
            &work,
            NOW,
            false
        ))
        .is_err());
    assert!(store
        .transaction(|conn| automation::stage_at(
            conn,
            &store,
            &scope,
            &profiles,
            &claim.occurrence_id,
            &claim.claim_token,
            at(NOW)
        ))
        .is_err());
}

#[test]
fn persisted_queue_survives_restart_but_expired_claims_never_replay() {
    use crate::store::repos::local_event;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    let master = MasterKey::generate().unwrap();
    let store = Store::open(&path, Vault::new(&master).unwrap()).unwrap();
    let scope = store
        .with_conn(|conn| {
            authorized_scope::resolve(conn, Some("default"), None, ScopeAccess::Write)
        })
        .unwrap();
    let (seed, _) = fixture();
    let row = seed
        .with_conn(|conn| repo::get_schedule(conn, &seed, &scope.private, "event-test"))
        .unwrap()
        .unwrap();
    store
        .transaction(|conn| repo::insert_schedule(conn, &store, &scope.private, &row))
        .unwrap();
    receive(
        &store,
        &scope,
        br#"{"summary":"Restart canary"}"#,
        "one",
        at(NOW),
    );
    drop(store);
    let reopened = Store::open(&path, Vault::new(&master).unwrap()).unwrap();
    let claim = claim_due_after_capacity(
        &reopened,
        &scope.private,
        LocalScheduleCapacityReservation::new("capacity-test".into()).unwrap(),
        at(NOW),
    )
    .unwrap()
    .unwrap();
    assert!(claim.prompt.contains("Restart canary"));
    assert!(claim_due_after_capacity(
        &reopened,
        &scope.private,
        LocalScheduleCapacityReservation::new("capacity-again".into()).unwrap(),
        at("2026-10-08T12:06:00Z")
    )
    .unwrap()
    .is_none());
    let ledger = reopened
        .with_conn(|conn| local_event::list(conn, &reopened, &scope.private, "event-test", 50))
        .unwrap();
    assert_eq!(ledger.len(), 1);
    let occurrence = reopened
        .with_conn(|conn| {
            repo::get_occurrence(conn, &reopened, &scope.private, &claim.occurrence_id)
        })
        .unwrap()
        .unwrap();
    assert_eq!(occurrence.state, "interrupted");
    let bytes = std::fs::read(path).unwrap();
    assert!(!bytes
        .windows("Restart canary".len())
        .any(|window| window == b"Restart canary"));
}

#[test]
fn account_scope_and_ciphertext_authentication_reject_cross_account_history() {
    use crate::store::repos::{local_event, scope::PrivateDataScope};
    let (store, scope) = fixture();
    receive(
        &store,
        &scope,
        br#"{"summary":"Account canary"}"#,
        "one",
        at(NOW),
    );
    let other = PrivateDataScope::for_authenticated_user(
        scope.data.clone(),
        "another-account",
        Some("another-member"),
    )
    .unwrap();
    let rows = store
        .with_conn(|conn| local_event::list(conn, &store, &other, "event-test", 50))
        .unwrap();
    assert!(rows.is_empty());
    let row = store
        .with_conn(|conn| local_event::list(conn, &store, &scope.private, "event-test", 50))
        .unwrap()
        .pop()
        .unwrap();
    store.transaction(|conn|{conn.execute("UPDATE local_event_delivery SET payload_nonce=x'000000000000000000000000' WHERE id=?1",[&row.id])?;Ok(())}).unwrap();
    assert!(store
        .with_conn(|conn| local_event::get(conn, &store, &scope.private, &row.id))
        .is_err());
}
