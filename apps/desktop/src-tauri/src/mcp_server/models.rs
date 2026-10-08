use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub port: u16,
    /// Explicit HTTPS reverse-proxy origin. Never inferred from request headers.
    pub public_origin: Option<String>,
    #[serde(default)]
    pub browser_origins: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum Access {
    #[default]
    ReadOnly,
    RequestTasks,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    pub id: String,
    pub client_id: String,
    pub client_name: String,
    pub redirect_uri: String,
    pub resource: String,
    pub workspace_id: String,
    pub agent_ids: Vec<String>,
    pub work_ids: Vec<String>,
    pub access: Access,
    pub permission_mode: String,
    pub created_at: i64,
    pub expires_at: i64,
    pub revoked: bool,
}

#[derive(Clone, Deserialize, Serialize)]
pub(super) struct Token {
    pub hash: String,
    pub grant_id: String,
    pub expires_at: i64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct History {
    pub at: i64,
    pub client_id: String,
    pub operation: String,
    pub target: Option<String>,
    pub outcome: String,
}

#[derive(Default, Deserialize, Serialize)]
pub(super) struct Saved {
    pub enabled: bool,
    pub grants: Vec<Grant>,
    pub tokens: Vec<Token>,
    pub history: Vec<History>,
    #[serde(default)]
    pub receipts: std::collections::BTreeMap<String, serde_json::Value>,
}

impl Saved {
    pub fn record(&mut self, client: &str, operation: &str, target: Option<String>, outcome: &str) {
        self.history.push(History {
            at: chrono::Utc::now().timestamp(),
            client_id: client.into(),
            operation: operation.into(),
            target,
            outcome: outcome.into(),
        });
        if self.history.len() > 256 {
            self.history.drain(..self.history.len() - 256);
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsentRequest {
    pub id: String,
    pub client_name: String,
    pub redirect_uri: String,
    pub requested_access: Access,
    pub expires_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Decision {
    pub request_id: String,
    pub approve: bool,
    pub workspace_id: String,
    #[serde(default)]
    pub agent_ids: Vec<String>,
    #[serde(default)]
    pub work_ids: Vec<String>,
    #[serde(default)]
    pub access: Access,
    pub lifetime_hours: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub endpoint: Option<String>,
    pub pending: Vec<ConsentRequest>,
    pub grants: Vec<Grant>,
    pub history: Vec<History>,
    pub shareable_work: Vec<serde_json::Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalWorkContext {
    pub grant_id: String,
    pub client_name: String,
}
