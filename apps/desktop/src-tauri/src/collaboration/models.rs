use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum WorkStatus {
    Queued,
    Running,
    Waiting,
    Blocked,
    AwaitingApproval,
    AwaitingUser,
    Completed,
    Failed,
    Cancelled,
}

impl WorkStatus {
    pub fn active(&self) -> bool {
        matches!(
            self,
            Self::Queued | Self::Running | Self::Waiting | Self::AwaitingApproval
        )
    }
    pub fn executing(&self) -> bool {
        matches!(self, Self::Running | Self::AwaitingApproval)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Participant {
    pub agent_id: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub workspace_id: String,
    pub kind: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub facilitator_id: Option<String>,
    pub participants: Vec<Participant>,
    pub revision: u32,
    pub generation: u32,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Author {
    pub run_id: String,
    pub conversation_id: String,
    pub agent_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_id: Option<String>,
    #[serde(default)]
    pub generation: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Team {
    pub project_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lead_agent_id: Option<String>,
    pub participant_ids: Vec<String>,
    pub revision: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Output {
    pub run_id: String,
    pub conversation_id: String,
    pub text: String,
    pub evidence: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Work {
    #[serde(default = "default_permission")]
    pub permission_mode: String,
    pub id: String,
    pub workspace_id: String,
    pub conversation_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub root_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    pub agent_id: String,
    pub agent_name: String,
    pub prompt: String,
    pub user_request: String,
    pub status: WorkStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub dependencies: Vec<String>,
    #[serde(default)]
    pub waiting_for: Vec<String>,
    #[serde(default)]
    pub prerequisites: Vec<String>,
    #[serde(default)]
    pub awaiting_user: bool,
    pub generation: u32,
    pub conversation_generation: u32,
    pub context_revision: u32,
    pub depth: u32,
    pub turn_count: u32,
    pub token_usage: u64,
    pub max_turns: u32,
    pub max_tokens: u64,
    pub run_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_run_id: Option<String>,
    pub model_option_id: String,
    pub outputs: Vec<Output>,
    pub created_at: String,
    pub updated_at: String,
}

fn default_permission() -> String {
    "read-only".into()
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Fact {
    pub id: String,
    pub project_id: String,
    pub kind: String,
    pub text: String,
    pub confidence: String,
    pub status: String,
    pub conversation_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supersedes_id: Option<String>,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub id: String,
    pub conversation_id: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LayoutNode {
    Pane {
        pane: usize,
    },
    Split {
        axis: String,
        ratio: f64,
        children: [Box<LayoutNode>; 2],
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Layout {
    pub version: u32,
    pub panes: Vec<Vec<String>>,
    pub views: Vec<View>,
    pub active: Vec<Option<String>>,
    pub active_pane: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tree: Option<LayoutNode>,
    pub closed: Vec<View>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub conversations: Vec<Conversation>,
    pub authors: Vec<Author>,
    pub teams: Vec<Team>,
    pub work: Vec<Work>,
    pub facts: Vec<Fact>,
    pub layout: Option<Layout>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum AgentCommand {
    Delegate {
        agent_id: String,
        prompt: String,
        title: String,
        dependencies: Vec<String>,
        focused: bool,
    },
    RecordFact {
        text: String,
        fact_kind: String,
        source: String,
        confidence: String,
        supersedes_id: Option<String>,
    },
    AwaitUser {
        reason: String,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Command {
    CreateConversation {
        id: String,
        title: String,
        kind: String,
        participant_ids: Vec<String>,
        facilitator_id: String,
        project_id: Option<String>,
    },
    UpdateConversation {
        id: String,
        expected_revision: u32,
        title: String,
        participant_ids: Vec<String>,
        facilitator_id: String,
        share_history: bool,
    },
    PlaceConversation {
        id: String,
        expected_revision: u32,
        project_id: String,
        share_history: bool,
    },
    UpdateTeam {
        project_id: String,
        expected_revision: u32,
        lead_agent_id: String,
        participant_ids: Vec<String>,
        share_history: bool,
    },
    StartWork {
        id: String,
        conversation_id: String,
        agent_id: String,
        prompt: String,
        discussion: bool,
    },
    BindWork {
        id: String,
        generation: u32,
        run_id: String,
    },
    CheckWork {
        id: String,
        generation: u32,
        run_id: String,
    },
    FinishWork {
        id: String,
        generation: u32,
        run_id: String,
        status: WorkStatus,
        reason: Option<String>,
    },
    StopWork {
        id: String,
    },
    StopProject {
        project_id: String,
    },
    ContinueWork {
        id: String,
        expected_generation: u32,
        reconcile: bool,
    },
    WorkStatus {
        id: String,
        generation: u32,
        status: WorkStatus,
        reason: Option<String>,
    },
    #[serde(rename = "agent-command")]
    AgentAction {
        id: String,
        generation: u32,
        run_id: String,
        call_id: String,
        command: AgentCommand,
    },
    SaveFact {
        project_id: String,
        conversation_id: String,
        id: String,
        kind: String,
        text: String,
        source: String,
        supersedes_id: Option<String>,
    },
    ChangeFact {
        id: String,
        project_id: String,
        status: String,
    },
    SaveLayout {
        layout: Layout,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub workspace_id: String,
    pub command: Command,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoadRequest {
    pub workspace_id: String,
}
