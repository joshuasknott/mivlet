import { useMediaQuery } from "../hooks/useMediaQuery";
import { WindowControls } from "../components/WindowControls";
import { ArtifactPreview } from "../components/conversation/ArtifactPreview";
import { ConversationSample } from "./ConversationSample";
import { useConversationScroll } from "../hooks/useConversationScroll";
/** Development-only component preview. No account, credentials, or model transport. */
import { useEffect, useRef, useState, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApprovalPanel } from "../components/ApprovalPanel";
import type {
  FableAgentProfile,
  ConnectorManifest,
  MemoryRecord,
} from "@fable/protocol";
import { AgentSidebar } from "../components/agents/AgentSidebar";
import { AgentWorkspaceHeader } from "../components/agents/AgentWorkspaceHeader";
import { ProfileAgentAvatar } from "../components/agents/agent-icons";
import { AgentEditor } from "../components/agents/AgentEditor";
import { AccountDialog } from "../components/agents/AccountDialog";
import { LiveWorkRail } from "../components/agents/LiveWorkRail";
import { Composer } from "../components/Composer";
import { MarketplacePage } from "../components/pages/MarketplacePage";
import type { ProviderModelOption } from "../lib/provider-models";
import { SettingsModal } from "../components/settings/SettingsModal";
import { SettingsPage } from "../components/pages/SettingsPage";
import type { SettingsTab } from "../components/pages/settings-tabs";
import type { SettingsRuntime } from "../components/settings/settings-runtime";
import { ScheduleEditor } from "../components/settings/LocalSchedules";
import {
  DEFAULT_ACCOUNT_WORKSPACE_STATUS,
  DEFAULT_IDENTITY_STATUS,
  defaultShellState,
} from "../hooks/shell-runtime/defaults";
import { resolveCodexProvider } from "@fable/connectors/backends/codex";
import { resolveNativeProvider } from "@fable/connectors/backends/native";
import { OnboardingPreview } from "./OnboardingPreview";
import { AgentAvatarPreview } from "./AgentAvatarPreview";
import { ProjectPreview } from "./ProjectPreview";
import "../styles.css";

if (!import.meta.env.DEV)
  throw new Error("The component preview is available only in development.");
const noop = () => {};
const asyncNoop = async () => {};
const samples: FableAgentProfile[] = [
  {
    id: "ava",
    name: "Chief of Staff",
    iconColor: "#FC6D69",
    instructions: "Help me plan and organize my work.",
    modelId: "codex::preview-model",
    icon: "agent",
    connectorIds: [],
    knowledgeSourceIds: [],
    permissionLabel: "Ask Me",
  },
  {
    id: "leo",
    name: "Leo",
    iconColor: "#2CC663",
    instructions: "Research questions and prepare clear briefs.",
    modelId: "codex::preview-model",
    icon: "agent",
    connectorIds: [],
    knowledgeSourceIds: [],
    permissionLabel: "Ask Me",
  },
  {
    id: "maya",
    name: "Maya",
    iconColor: "#865DFA",
    instructions: "Help with design and writing.",
    modelId: "codex::preview-model",
    icon: "agent",
    connectorIds: [],
    knowledgeSourceIds: [],
    permissionLabel: "Ask Me",
  },
];
const connectors: ConnectorManifest[] = [
  ["gmail", "Gmail"],
  ["google-drive", "Google Drive"],
  ["google-calendar", "Google Calendar"],
  ["github", "GitHub"],
  ["slack", "Slack"],
  ["notion", "Notion"],
  ["linear", "Linear"],
  ["vercel", "Vercel"],
].map(([id, name]) => ({
  id,
  name,
  status: "needs-auth",
  authMode: "oauth-broker",
  permissions: [],
  healthSummary: "Not connected",
  lastCheckedAt: "Not checked",
  supportsSearch: true,
  supportsImport: true,
  supportedActions: [],
}));
const models: ProviderModelOption[] = [
  {
    id: "codex::preview-model",
    modelId: "preview-model",
    label: "Example model",
    providerId: "codex",
    providerLabel: "ChatGPT",
    available: true,
    reasoning: {
      supportedEfforts: ["low", "medium", "high"],
      defaultEffort: "medium",
    },
  },
];
const localComputer: ComponentProps<typeof LiveWorkRail>["localComputer"] = {
  available: false,
  browserAvailable: false,
  browserActive: false,
  canGoBack: false,
  canGoForward: false,
  filesAvailable: false,
  files: null,
  filesLoading: false,
  filesError: null,
  filePreview: null,
  filePreviewLoading: false,
  filePreviewError: null,
  controller: "agent",
  loading: false,
  provisioning: false,
  busy: false,
  recoveryNeeded: false,
  error: null,
  generation: 0,
  onProvision: asyncNoop,
  onOpenBrowser: asyncNoop,
  onRefreshBrowser: asyncNoop,
  onGoBack: asyncNoop,
  onGoForward: asyncNoop,
  onRefreshFiles: asyncNoop,
  onPreviewFile: asyncNoop,
  onCloseFilePreview: noop,
  onTakeControl: asyncNoop,
  onReturnControl: asyncNoop,
  onOpenViewer: asyncNoop,
  onLaunchApplication: asyncNoop,
};
const hostedComputer: ComponentProps<typeof LiveWorkRail>["hostedComputer"] = {
  available: false,
  runtimeActive: false,
  keepAlive: false,
  loading: false,
  provisioning: false,
  error: null,
  onProvision: asyncNoop,
  browserOpening: false,
  browserPhase: "idle",
  browserError: null,
  onOpenBrowser: asyncNoop,
  onRefreshBrowser: asyncNoop,
};

function DesignPreview() {
  const [sampleRecordingReview, setSampleRecordingReview] = useState(
    new URLSearchParams(window.location.search).get("view") === "recording",
  );
  const [sampleMemories, setSampleMemories] = useState<MemoryRecord[]>([
    {
      id: "preview-memory",
      kind: "preference",
      title: "Response length",
      value: "Keep routine updates concise.",
      source: "Preview sample",
      freshness: "Sample",
      approved: true,
      pinned: true,
    },
  ]);
  const [previewConversations, setPreviewConversations] = useState(() =>
    new URLSearchParams(window.location.search).get("view") === "conversations"
      ? [
          { id: "preview-one", title: "Plan my week", time: "17:04" },
          { id: "preview-two", title: "Find my latest email", time: "16:32" },
        ]
      : [],
  );
  const [showApproval, setShowApproval] = useState(
    new URLSearchParams(window.location.search).get("view") === "approval",
  );
  const [profiles, setProfiles] = useState(samples);
  const [agentId, setAgentId] = useState("ava");
  const [page, setPage] = useState("chat");
  const [rail, setRail] = useState(false);
  const isPhone = useMediaQuery("(max-width: 650px)");
  const [mobileConversation, setMobileConversation] = useState(false);
  const [editor, setEditor] = useState(false);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [account, setAccount] = useState<"usage" | "sign-out" | null>(null);
  const [message, setMessage] = useState("");
  const [artifactPreview, setArtifactPreview] = useState<string | null>(null);
  const scroll = useConversationScroll("sample", message);
  const [permission, setPermission] = useState("Ask Me");
  const [addOpen, setAddOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const schedulePreview =
    new URLSearchParams(window.location.search).get("view") === "schedule";
  const [settingsOpen, setSettingsOpen] = useState(schedulePreview);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(
    schedulePreview ? "schedules" : "general",
  );
  const [theme, setTheme] = useState<"light" | "dark">("light");
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const [reasoning, setReasoning] = useState<string>();
  const [memoryDisabled, setMemoryDisabled] = useState(false);
  const [hiddenModelIds, setHiddenModelIds] = useState<string[]>([]);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [voiceProvider, setVoiceProvider] = useState<"browser" | "openai">(
    "browser",
  );
  const unavailable = async (providerId: string) => ({
    providerId,
    outcome: "unsupported" as const,
    message: "Design preview: connection requires the desktop app.",
  });
  const settingsRuntime: SettingsRuntime = {
    agents: profiles,
    allModelOptions: models,
    hiddenModelIds,
    setModelVisible: (id, visible) =>
      setHiddenModelIds((current) =>
        visible
          ? current.filter((value) => value !== id)
          : [...new Set([...current, id])],
      ),
    accountWorkspacePending: false,
    accountWorkspaceStatus: DEFAULT_ACCOUNT_WORKSPACE_STATUS,
    backendProviders: [
      resolveCodexProvider("needs-auth"),
      resolveNativeProvider("openai", "needs-auth"),
      resolveNativeProvider("anthropic", "needs-auth"),
      resolveNativeProvider("xai", "needs-auth"),
    ].filter((provider) => provider !== null),
    checkBackendConnection: unavailable,
    connectBackendWithVerify: unavailable,
    connectedBackendIds: [],
    disconnectBackend: asyncNoop,
    exportMemory: asyncNoop,
    identityPending: false,
    identityStatus: DEFAULT_IDENTITY_STATUS,
    memoryDisabled,
    recoverIdentity: asyncNoop,
    refreshIdentity: asyncNoop,
    refreshModels: asyncNoop,
    signInIdentity: asyncNoop,
    signOutIdentity: asyncNoop,
    startBackendBrowserLogin: unavailable,
    toggleMemoryDisabled: async () => setMemoryDisabled((value) => !value),
    customApprovalSettings: defaultShellState.customApprovalSettings,
    permissionLabel: permission,
    managedMemoryRecords: sampleMemories,
    correctMemory: async (id, title, value) => {
      setSampleMemories((records) =>
        records.map((record) =>
          record.id === id ? { ...record, title, value } : record,
        ),
      );
    },
    forgetMemory: async (id) =>
      setSampleMemories((records) =>
        records.filter((record) => record.id !== id),
      ),
    toggleMemoryRecordDisabled: async (id) =>
      setSampleMemories((records) =>
        records.map((record) =>
          record.id === id ? { ...record, disabled: !record.disabled } : record,
        ),
      ),
    memoryStatus: "Preview only: no saved memory is changed.",
    selectPermissionLabel: setPermission,
    setVoiceEnabled,
    updateCustomApprovalSetting: noop,
    voiceEnabled,
    voiceProvider,
    setVoiceProvider,
  };
  const composerRef =
    useRef<import("../components/ComposerInput").ComposerInputHandle>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const agent = profiles.find((profile) => profile.id === agentId)!;
  const editingAgent =
    profiles.find((profile) => profile.id === editingAgentId) ?? null;
  return (
    <>
      <main
        className={`desktop-frame desktop-frame--agents${(rail || artifactPreview) && page === "chat" ? "" : " desktop-frame--live-closed"}${artifactPreview ? " desktop-frame--artifact" : ""}`}
        data-theme={theme}
        data-mobile-view={
          mobileConversation || page !== "chat" ? "conversation" : "list"
        }
      >
        <WindowControls preview />
        <AgentSidebar
          hidden={isPhone && (mobileConversation || page !== "chat")}
          agents={profiles}
          activeAgentId={agentId}
          previews={{
            ava: {
              message: showApproval
                ? "Waiting for your approval"
                : "Project comparison ready",
              time: "01:34",
              status: showApproval ? "attention" : "idle",
              presence: showApproval ? "waiting" : "done",
            },
            leo: { message: "Research", time: "", status: "idle" },
            maya: { message: "Design", time: "", status: "idle" },
          }}
          profileName="Joshua"
          connectors={[]}
          marketplaceActive={page === "connectors"}
          onSelectAgent={(profile) => {
            setAgentId(profile.id);
            setPage("chat");
            setMobileConversation(true);
          }}
          onCreateAgent={() => {
            setEditingAgentId(null);
            setEditor(true);
          }}
          onEditAgent={(profile) => {
            setEditingAgentId(profile.id);
            setEditor(true);
          }}
          onOpenMarketplace={() => setPage("connectors")}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenUsage={() => setAccount("usage")}
          onSignOut={() => setAccount("sign-out")}
        />
        {page === "connectors" ? (
          <MarketplacePage
            manifests={connectors}
            accounts={{}}
            connectorStatus={notice || null}
            onBack={() => setPage("chat")}
            onUseConnector={noop}
            onConnect={() =>
              setNotice("Design preview: no account connection was started.")
            }
            onDisconnect={noop}
            onRefresh={noop}
            onSelectConnector={noop}
            onSwitchAccount={noop}
          />
        ) : (
          <section
            className="workspace agent-workspace"
            hidden={isPhone && !mobileConversation}
          >
            <AgentWorkspaceHeader
              agent={agent}
              presence={showApproval ? "waiting" : "idle"}
              onBack={isPhone ? () => setMobileConversation(false) : undefined}
              attentionCount={showApproval ? 1 : 0}
              panelOpen={rail}
              onTogglePanel={() => setRail(!rail)}
            />
            <div className="workspace-center workspace-center--composer workspace-center--conversation">
              <div
                className="conversation-scroll"
                ref={scroll.scrollRef}
                onScroll={scroll.onScroll}
              >
                <div
                  className="conversation-feed"
                  ref={scroll.contentRef}
                  onClickCapture={(event) => {
                    if (
                      event.target instanceof Element &&
                      event.target.closest("summary")
                    )
                      scroll.pauseFollowing();
                  }}
                >
                  <ConversationSample
                    agent={agent}
                    onPreviewArtifact={setArtifactPreview}
                  />
                  {showApproval ? (
                    <article className="conversation-message conversation-message--assistant conversation-message--approval">
                      <div className="conversation-message__author">
                        <ProfileAgentAvatar agent={agent} iconSize={28} />
                        <strong>{agent.name}</strong>
                      </div>
                      <div className="conversation-message__approval">
                        <ApprovalPanel
                          compact
                          approvals={[
                            {
                              id: "preview",
                              service: "Gmail",
                              action: "Send the project update to Alex?",
                              mode: "full-access",
                              riskLevel: "high",
                              dataUsed: ["Draft message", "alex@example.com"],
                              consequence:
                                "Sends one email from your connected account.",
                              requestedAt: "2026-09-05T12:00:00Z",
                              decisions: ["once", "deny"],
                            },
                          ]}
                          audit={[]}
                          sessionGrants={[]}
                          approvalRules={[]}
                          editingApprovalId={null}
                          modificationDraft={{
                            mode: "read-only",
                            dataUsed: "",
                            consequence: "",
                          }}
                          pendingConfirmation={null}
                          confirmationText=""
                          onDecision={() => {
                            setShowApproval(false);
                            setNotice("Preview only: no action was taken.");
                          }}
                          onStartModify={noop}
                          onUpdateModification={noop}
                          onSaveModify={noop}
                          onCancelModify={noop}
                          onUpdateConfirmation={noop}
                          onConfirmDecision={noop}
                          onCancelConfirmation={noop}
                        />
                      </div>
                    </article>
                  ) : null}
                </div>
              </div>
              <div className="conversation-composer-dock">
                {scroll.showLatest ? (
                  <button
                    type="button"
                    className="conversation-latest"
                    onClick={scroll.toLatest}
                    aria-label="Scroll to latest message"
                    title="Scroll to latest message"
                  >
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path
                        d="M12 4v16m-7-7 7 7 7-7"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                ) : null}
                <Composer
                  composerRef={composerRef}
                  fileInputRef={fileRef}
                  composerValue={message}
                  onComposerChange={setMessage}
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (message.trim()) {
                      setNotice("Design preview: no model request was sent.");
                      setMessage("");
                    }
                  }}
                  voiceStatus={
                    sampleRecordingReview ? "reviewing" : "unsupported"
                  }
                  voiceMessage={
                    sampleRecordingReview
                      ? "Preview sample: review before upload."
                      : "Dictation is unavailable in this preview."
                  }
                  voiceCanStart={false}
                  voiceDisclosure="No microphone access is requested in the preview."
                  voiceReview={
                    sampleRecordingReview
                      ? {
                          recordingId: "preview-recording",
                          durationMs: 12_000,
                          sizeBytes: 184_320,
                          mediaType: "audio/webm",
                          providerLabel: "OpenAI transcription",
                          model: "gpt-4o-mini-transcribe",
                          maxDurationMs: 120_000,
                        }
                      : null
                  }
                  onAuthorizeVoice={() => {
                    setSampleRecordingReview(false);
                    setNotice("Preview only: no recording was uploaded.");
                  }}
                  onStartVoice={noop}
                  onStopVoice={noop}
                  onCancelVoice={() => setSampleRecordingReview(false)}
                  onDismissVoice={noop}
                  onAttach={noop}
                  addMenuOpen={addOpen}
                  onImportRepository={() =>
                    setNotice(
                      "Repository import requires the native desktop app. No files were imported.",
                    )
                  }
                  onToggleAddMenu={() => setAddOpen(!addOpen)}
                  onOpenTool={() => setPage("connectors")}
                  onRunCommand={noop}
                  onFileChange={noop}
                  models={models}
                  selectedModelId={models[0].id}
                  selectedModelLabel={models[0].label}
                  onSelectModel={noop}
                  connectedConnectors={[
                    { id: "browser", name: "Browser", status: "enabled" },
                    { id: "computer", name: "Computer Use", status: "enabled" },
                    {
                      id: "google-drive",
                      name: "Google Drive",
                      status: "connected",
                    },
                    { id: "gmail", name: "Gmail", status: "connected" },
                    { id: "github", name: "GitHub", status: "connected" },
                  ]}
                  selectedReasoningEffort={reasoning}
                  onSelectReasoningEffort={setReasoning}
                  placeholder={`Message ${agent.name}…`}
                  inThread
                />
              </div>
            </div>
          </section>
        )}
        {artifactPreview ? (
          <ArtifactPreview
            output={artifactPreview}
            workspaceId="sample-workspace"
            agentId={agent.id}
            onClose={() => setArtifactPreview(null)}
          />
        ) : null}
        {rail && page === "chat" && !artifactPreview ? (
          <LiveWorkRail
            conversations={previewConversations}
            onDeleteConversation={(id) =>
              setPreviewConversations((items) =>
                items.filter((item) => item.id !== id),
              )
            }
            agentName={agent.name}
            localComputer={localComputer}
            hostedComputer={hostedComputer}
            onClose={() => setRail(false)}
            onNewConversation={() => {
              setMessage("");
              composerRef.current?.focus();
            }}
            onSelectConversation={noop}
          />
        ) : null}
        <AgentEditor
          existingAvatarSeeds={profiles.map(
            (profile) => profile.avatarSeed ?? `blob-v1:${profile.id}`,
          )}
          open={editor}
          agent={editingAgent}
          models={models}
          canDelete={false}
          onClose={() => setEditor(false)}
          onDelete={noop}
          onSave={(draft) => {
            if (editingAgent)
              setProfiles(
                profiles.map((profile) =>
                  profile.id === editingAgent.id
                    ? { ...profile, ...draft }
                    : profile,
                ),
              );
            else {
              const created = { ...draft, id: crypto.randomUUID() };
              setProfiles([...profiles, created]);
              setAgentId(created.id);
              setPage("chat");
              setMobileConversation(true);
            }
            setEditor(false);
          }}
          onSkillsChange={(learnedTasks) =>
            setProfiles(
              profiles.map((profile) =>
                profile.id === editingAgent?.id
                  ? { ...profile, learnedTasks }
                  : profile,
              ),
            )
          }
          onUseSkill={(task) => setMessage(task.instruction)}
        />
        {account ? (
          <AccountDialog
            kind={account}
            name="Joshua"
            records={[]}
            onClose={() => setAccount(null)}
            onSignOut={asyncNoop}
          />
        ) : null}
      </main>
      {settingsOpen ? (
        <SettingsModal
          activeTab={settingsTab}
          onSelectTab={setSettingsTab}
          onClose={() => setSettingsOpen(false)}
        >
          {schedulePreview && settingsTab === "schedules" ? (
            <section className="settings-page">
              <div className="settings-page__content">
                <h1 id="settings-modal-title">Schedules</h1>
                <div className="settings-page__body local-schedules">
                  <p>
                    Preview sample. Keep Fable open and your computer awake.
                  </p>
                  <ScheduleEditor
                    runtime={{
                      ...settingsRuntime,
                      backendProviders: [resolveCodexProvider("connected")],
                    }}
                    schedule={null}
                    pending={false}
                    onSave={() =>
                      setNotice("Preview only: schedule was not saved.")
                    }
                    onCancel={() => setSettingsOpen(false)}
                  />
                </div>
              </div>
            </section>
          ) : (
            <SettingsPage
              runtime={settingsRuntime}
              theme={theme}
              onThemeChange={setTheme}
              activeTab={settingsTab}
              workspaceName="Preview workspace"
              titleId="settings-modal-title"
            />
          )}
        </SettingsModal>
      ) : null}
      <div
        style={{
          position: "fixed",
          bottom: 3,
          left: "50%",
          transform: "translateX(-50%)",
          color: "#777",
          fontSize: 9,
          pointerEvents: "none",
          zIndex: 200,
        }}
      >
        Design preview · Sample conversation · {notice}
      </div>
    </>
  );
}

const previewQueryClient = new QueryClient();
const previewView = new URLSearchParams(window.location.search).get("view");
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={previewQueryClient}>
    {previewView === "onboarding" ? (
      <OnboardingPreview />
    ) : previewView === "avatars" ? (<AgentAvatarPreview />) : previewView === "projects" ? (
      <ProjectPreview />
    ) : (
      <DesignPreview />
    )}
  </QueryClientProvider>,
);
