use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum EventSource {
    SignedJson {
        #[serde(rename = "sourceId")]
        source_id: String,
    },
    GithubIssues {
        repository: String,
    },
    GithubWorkflowRun {
        repository: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventDraft {
    pub source: EventSource,
    pub fields: Vec<String>,
    pub max_age_seconds: u32,
    pub valid_until: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
// Persisted configuration is flattened into LocalScheduleTrigger. Incoming
// drafts remain strict; Serde does not support deny_unknown_fields with flatten.
#[serde(rename_all = "camelCase")]
pub struct EventConfig {
    pub source: EventSource,
    pub fields: Vec<String>,
    pub max_age_seconds: u32,
    pub valid_until: String,
    pub route_id: String,
    pub key_version: u32,
    pub signing_key_id: String,
}

impl EventConfig {
    pub fn draft(&self) -> EventDraft {
        EventDraft {
            source: self.source.clone(),
            fields: self.fields.clone(),
            max_age_seconds: self.max_age_seconds,
            valid_until: self.valid_until.clone(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EventPreview {
    pub prompt: String,
    pub selected_fields: BTreeMap<String, serde_json::Value>,
    pub missing: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryPayload {
    pub source: EventSource,
    pub reason: String,
    pub selected_fields: BTreeMap<String, serde_json::Value>,
    pub prompt: Option<String>,
    pub event_time: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventDelivery {
    pub id: String,
    pub schedule_id: String,
    pub received_at: String,
    pub expires_at: String,
    pub state: String,
    #[serde(flatten)]
    pub payload: DeliveryPayload,
    pub occurrence_id: Option<String>,
    pub work_id: Option<String>,
    pub thread_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EventWorkOrigin {
    pub delivery_id: String,
    pub source: EventSource,
    pub received_at: String,
    pub expires_at: String,
    pub selected_fields: BTreeMap<String, serde_json::Value>,
}
