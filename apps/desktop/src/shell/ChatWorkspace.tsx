import { SchedulesDialog } from "../components/agents/SchedulesDialog";
import { WorkspaceMenu } from "../components/agents/WorkspaceMenu";
import { Brand } from "../components/Brand";
import { ConversationFeed } from "../components/conversation/ConversationFeed";
import { ContextRecoveryPanel } from "../components/conversation/ContextRecoveryPanel";
import { useConversationScroll } from "../hooks/useConversationScroll";
import { CONVERSATION_STYLE_INSTRUCTIONS } from "../lib/conversation-presentation";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { agentPresence, presenceLabel } from "../lib/agent-presence";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { Desktop } from "@phosphor-icons/react/dist/csr/Desktop";
import type { FableAgentProfile } from "@fable/protocol";
import { SettingsModal } from "../components/settings/SettingsModal";
import {
  AgentSidebar,
  type AgentSidebarPreview,
} from "../components/agents/AgentSidebar";
import { AgentWelcome } from "../components/agents/AgentWelcome";
import { AgentWorkspaceHeader } from "../components/agents/AgentWorkspaceHeader";

import { Composer } from "../components/Composer";


import {
  buildAgentRequest,
  buildInterruptedAttemptCheckpoint,
  INTERRUPTED_CHECKPOINT_INSTRUCTION,
  validateModelSelection,
} from "../lib/agent-run";
import { agentExecutionInstructions } from "../lib/agent-learning";
import { insertDictation } from "../lib/insert-dictation";
import { conversationToolsForModel, computerToolsReady, COMPUTER_WORK_INSTRUCTIONS } from "../lib/computer-tools";
import { builtinPluginMentions, builtinPluginInstructions } from "../lib/builtin-plugins";
import {
  type SettingsTab,
} from "../components/pages/settings-tabs";
import { composerModelsFor } from "./composer-models";
import { useShellAgentController } from "./useShellAgentController";
import { importRuntimeRepository } from "../runtime/domains/local-computer";
import { composerImageInputs } from "../lib/composer-images";
import { getRuntimeConversationThread, loadRuntimeLocalComputer } from "../runtime";
import { hasNativeRuntimeAdapter } from "../runtime/adapters/select";
import { useLocalProjects } from "../hooks/useLocalProjects";
import { createLocalProject, updateLocalProject, archiveLocalProject, bindLocalProjectRunAuthor } from "../runtime/domains/local-projects";
import { projectContributions, projectContributionPrompt, type ProjectContribution } from "../lib/project-turn";
import { modelsForProvider } from "../lib/provider-models";
import type { ExecutionAttempt, LocalProject } from "@fable/protocol";
import type { ProjectDraft } from "../components/projects/ProjectWorkspace";
import { ProfileAgentAvatar } from "../components/agents/agent-icons";
import { ACCEPTED_LOCAL_KNOWLEDGE_FILES } from "../lib/constants";
import { buildConversationHandoff } from "../lib/conversation-handoff";
import "./project-room.css";

const ProjectEditor = lazy(() => import("../components/projects/ProjectWorkspace").then((module) => ({ default: module.ProjectEditor })));
const ProjectFiles = lazy(() => import("../components/projects/ProjectWorkspace").then((module) => ({ default: module.ProjectFiles })));
const ProjectInstructions = lazy(() => import("../components/projects/ProjectWorkspace").then((module) => ({ default: module.ProjectInstructions })));
const ProjectParticipants = lazy(() => import("../components/projects/ProjectWorkspace").then((module) => ({ default: module.ProjectParticipants })));
const ProjectWorkspace = lazy(() => import("../components/projects/ProjectWorkspace").then((module) => ({ default: module.ProjectWorkspace })));

const ArtifactPreview = lazy(() => import("../components/conversation/ArtifactPreview").then((module) => ({ default: module.ArtifactPreview })));
const AgentEditor = lazy(() => import("../components/agents/AgentEditor").then((module) => ({ default: module.AgentEditor })));
const AccountDialog = lazy(() => import("../components/agents/AccountDialog").then((module) => ({ default: module.AccountDialog })));
const LiveWorkRail = lazy(() => import("../components/agents/LiveWorkRail").then((module) => ({ default: module.LiveWorkRail })));

const ApprovalPanel = lazy(() =>
  import("../components/ApprovalPanel").then((module) => ({
    default: module.ApprovalPanel,
  })),
);
const OnboardingPage = lazy(() =>
  import("../components/pages/OnboardingPage").then((module) => ({
    default: module.OnboardingPage,
  })),
);
const LocalSchedules = lazy(() => import("../components/settings/LocalSchedules").then((module) => ({ default: module.LocalSchedules })));
const SettingsPage = lazy(() =>
  import("../components/pages/SettingsPage").then((module) => ({
    default: module.SettingsPage,
  })),
);
const MarketplacePage = lazy(() =>
  import("../components/pages/MarketplacePage").then((module) => ({
    default: module.MarketplacePage,
  })),
);

interface QueuedPrompt {
  threadId: string;
  prompt: string;
}

function compactTime(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** The Mivlet desktop product: named teammates, one durable conversation, and bounded tools. */
export function ChatWorkspace() {
  const [selectedThreadId, setSelectedThreadId] = useState<string>();
  const [selectedProjectId, setSelectedProjectId] = useState<string>();
  const [projectExecutor, setProjectExecutor] = useState<ProjectContribution>();
  const [projectRecipient, setProjectRecipient] = useState("all");
  const [projectTab, setProjectTab] = useState<"conversation" | "files" | "instructions">("conversation");
  const [projectEditorOpen, setProjectEditorOpen] = useState(false);
  const [editingProjectId, setEditingProjectId] = useState<string>();
  const [projectSaving, setProjectSaving] = useState(false);
  const projectSavingRef = useRef(false);
  const [projectError, setProjectError] = useState("");
  const projectFileInput = useRef<HTMLInputElement>(null);
  const [projectBatch, setProjectBatch] = useState<{ id: string; workspaceId: string; project: LocalProject; prompt: string; contributions: ProjectContribution[]; index: number; retryAttempt?: ExecutionAttempt; suppressHuman?: boolean }>();
  const projectBatchRef = useRef(projectBatch);
  projectBatchRef.current = projectBatch;
  const [suppressProjectPrompt, setSuppressProjectPrompt] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const saved = window.localStorage.getItem("fable-theme");
    return saved === "dark" ? "dark" : "light";
  });
  const [schedulesOpen, setSchedulesOpen] = useState(false);
  const [scheduleAgentId, setScheduleAgentId] = useState<string>();
  const openSchedules = (agentId?: string) => { setScheduleAgentId(agentId); setSchedulesOpen(true); };
  const [navigationCollapsed, setNavigationCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [accountDialog, setAccountDialog] = useState<"usage" | "sign-out" | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [marketplaceTab, setMarketplaceTab] = useState<"plugins" | null>(
    null,
  );
  const [marketplaceConnectorId, setMarketplaceConnectorId] = useState<string>();
  const [workPanelOpen, setWorkPanelOpen] = useState(false);
  const isPhone = useMediaQuery("(max-width: 650px)");
  const [mobileConversation, setMobileConversation] = useState(false);
  const navigationPending = useRef(false);
  const [agentEditorOpen, setAgentEditorOpen] = useState(false);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [queuedPrompt, setQueuedPrompt] = useState<QueuedPrompt | null>(null);
  const [optimisticUserMessage, setOptimisticUserMessage] = useState("");
  const [submissionError, setSubmissionError] = useState("");
  const [dismissedScheduleNotice, setDismissedScheduleNotice] = useState("");
  const [deletingConversation, setDeletingConversation] = useState(false);
  const [artifactPreview, setArtifactPreview] = useState<string | null>(null);
  const [artifactOwner, setArtifactOwner] = useState<{ agentId: string; generation?: number }>();
  const artifactTrigger = useRef<HTMLElement | null>(null);

  const wasRunningRef = useRef(false);

  const controller = useShellAgentController({
    threadId: selectedThreadId,
    executionAgentId: selectedProjectId ? projectExecutor?.agentId : undefined,
    executionProviderId: selectedProjectId ? projectExecutor?.providerId || undefined : undefined,
    onDictation: addDictationToComposer,
    onVoiceCancel: focusComposer,
  });
  const {
    runtime,
    agent,
    durableConversation,
    voice,
    localComputer,
    hostedComputer,
    hostedBrowser,
    stopCurrentWork,
    resetCancellation,
    beginConnectorTurn,
    endConnectorTurn,
    scheduleDispatch,
  } = controller;
  const imageApiConnected = runtime.backendProviders.some((provider) => provider.id === "openai" && provider.backendType === "native-api" && provider.authState === "connected");
  const workspaceId = runtime.accountWorkspaceStatus.activeWorkspace.localWorkspaceId;
  const projects = useLocalProjects(workspaceId, selectedProjectId, runtime.runtimeSnapshotReady && runtime.accountWorkspaceStatus.accountBound && hasNativeRuntimeAdapter());
  const selectedProject = projects.projects.find((project) => project.id === selectedProjectId);
  const projectScope = useRef({ workspaceId, projectId: selectedProjectId, threadId: selectedThreadId });
  projectScope.current = { workspaceId, projectId: selectedProjectId, threadId: selectedThreadId };
  const activeAgent =
    runtime.agents.find(
      (candidate) => candidate.id === (selectedProjectId ? projectExecutor?.agentId ?? runtime.activeAgentId : runtime.activeAgentId),
    ) ?? runtime.agents[0];
  const repositoryImportPending = useRef(false);
  const repositoryScope = `${runtime.accountWorkspaceStatus.activeWorkspace.localWorkspaceId}:${activeAgent?.id}`;
  const currentRepositoryScope = useRef(repositoryScope);
  currentRepositoryScope.current = repositoryScope;
  const currentRepositoryDraft = useRef(runtime.composerValue);
  currentRepositoryDraft.current = runtime.composerValue;
  const importRepository = async () => {
    if (repositoryImportPending.current || agent.state.running || !activeAgent) return;
    repositoryImportPending.current = true;
    const scope = repositoryScope;
    const target = { workspaceId: runtime.accountWorkspaceStatus.activeWorkspace.localWorkspaceId, agentId: activeAgent.id };
    try {
      setSubmissionError("");
      const node = await localComputer.prepareForTool("read-file");
      if (currentRepositoryScope.current !== scope) return;
      const receipt = await importRuntimeRepository(target, node.generation);
      if (!receipt || currentRepositoryScope.current !== scope) return;
      const draft = currentRepositoryDraft.current;
      runtime.setComposerValue(`${draft}${draft ? "\n\n" : ""}I imported a repository snapshot into Workspace/${receipt.relativePath} (${receipt.files} files; ${receipt.skipped} excluded entries). Inspect its structure and instructions before editing. Work only in this isolated copy, initialize a Git baseline before changes, use a separate work branch, run relevant tests and show the final diff. Ask before publishing any changes.`);
      void localComputer.refreshFiles();
    } catch (error) {
      if (currentRepositoryScope.current === scope) setSubmissionError(error instanceof Error ? error.message : "Repository import failed.");
    } finally { repositoryImportPending.current = false; }
  };

  useEffect(() => { setArtifactPreview(null); }, [activeAgent?.id, selectedThreadId, runtime.accountWorkspaceStatus.activeWorkspace.localWorkspaceId, localComputer.node?.generation]);

  useEffect(() => {
    window.localStorage.setItem("fable-theme", theme);
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (!activeAgent) return;
    runtime.selectModel(activeAgent.modelId);
  }, [activeAgent?.id, activeAgent?.modelId]);

  useEffect(() => {
    if (!activeAgent || selectedProjectId) return;
    setSelectedThreadId(activeAgent.threadId);
    setOptimisticUserMessage("");
    setSubmissionError("");
  }, [activeAgent?.id, selectedProjectId]);


  useEffect(() => {
    const draft = durableConversation.state.draft;
    if (!draft || draft.draftKey !== durableConversation.draftKey) return;
    if (!runtime.composerValue) runtime.setComposerValue(draft.content);
  }, [durableConversation.draftKey, durableConversation.state.draft?.draftKey]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const current = runtime.composerValue;
      const saved = durableConversation.state.draft?.content ?? "";
      if (current === saved) return;
      if (current) void durableConversation.saveDraft(current);
      else void durableConversation.deleteDraft();
    }, 400);
    return () => window.clearTimeout(timer);
  }, [
    durableConversation.deleteDraft,
    durableConversation.saveDraft,
    durableConversation.state.draft?.content,
    runtime.composerValue,
  ]);

  useEffect(() => {
    if (wasRunningRef.current && !agent.state.running) {
      void durableConversation.refresh();
      setOptimisticUserMessage("");
    }
    wasRunningRef.current = agent.state.running;
  }, [agent.state.running, durableConversation.refresh]);

  const conversationScroll = useConversationScroll(
    `${runtime.accountWorkspaceStatus.activeWorkspace.localWorkspaceId}:${activeAgent?.id}:${selectedThreadId}`,
    `${agent.state.transcript}:${agent.state.activity}:${agent.state.running}:${durableConversation.state.conversation?.messages.length}:${optimisticUserMessage}:${runtime.openApprovals.length}`,
  );

  const composerModels = useMemo(
    // The composer is the provider switcher. Passing no provider filter keeps
    // every connected provider selectable instead of trapping the user on the
    // provider that owns the currently persisted model.
    () => composerModelsFor(undefined, runtime.modelOptions),
    [runtime.modelOptions],
  );
  const selectedModelOptionId = useMemo(() => {
    if (
      runtime.selectedModelId &&
      composerModels.some(
        (candidate) => candidate.id === runtime.selectedModelId,
      )
    ) {
      return runtime.selectedModelId;
    }
    return runtime.resolvedModelOptionId;
  }, [composerModels, runtime.resolvedModelOptionId, runtime.selectedModelId]);
  const selectedModelId = useMemo(
    () =>
      composerModels.find((candidate) => candidate.id === selectedModelOptionId)
        ?.modelId ?? runtime.resolvedSelectedModelId,
    [composerModels, runtime.resolvedSelectedModelId, selectedModelOptionId],
  );
  const selectedModelLabel =
    composerModels.find((candidate) => candidate.id === selectedModelOptionId)
      ?.label ?? "Choose model";
  const selectedReasoning = composerModels.find((model) => model.id === selectedModelOptionId)?.reasoning;
  const selectedReasoningEffort = activeAgent?.reasoningEffort && selectedReasoning?.supportedEfforts.includes(activeAgent.reasoningEffort)
    ? activeAgent.reasoningEffort : undefined;
  const connectedConnectors = useMemo(
    () =>
      [...builtinPluginMentions(localComputer.node?.plugins), ...runtime.connectorManifests
        .filter(
          (connector) =>
            connector.status === "connected" && connector.id !== "local-files",
        )
        .map((connector) => ({
          id: connector.id,
          name: connector.name,
          status: connector.status,
        }))],
    [runtime.connectorManifests, localComputer.node?.plugins],
  );

  const submissionPending = useRef(false);
  const executePrompt = useCallback(
    async (prompt: string, batch?: NonNullable<typeof projectBatch>) => {
      if (!activeAgent || !selectedThreadId || agent.state.running || submissionPending.current || !runtime.runtimeSnapshotReady || runtime.runtimeSnapshotError) return;
      if (selectedProjectId && !batch) { setSubmissionError("Send this message from the project composer."); return; }
      const contribution = batch?.contributions[batch.index];
      const connected = contribution ? runtime.backendProviders.find((provider) => provider.id === contribution.providerId && provider.authState === "connected") : runtime.connectedAgentBackend;
      const runModelId = contribution?.modelId ?? selectedModelId;
      const runModelOptionId = contribution?.modelOptionId ?? selectedModelOptionId;
      const projectIsCurrent = () => !batch || (projectBatchRef.current?.id === batch.id && projectScope.current.workspaceId === batch.workspaceId && projectScope.current.projectId === batch.project.id);
      if (!projectIsCurrent() || (contribution && contribution.agentId !== activeAgent.id)) return;
      if (!connected) {
        setSettingsTab("providers");
        setSettingsOpen(true);
        setSubmissionError(
          "Connect a model provider before sending a message.",
        );
        return;
      }
      const validation = validateModelSelection(
        connected.id,
        runModelId,
        contribution ? modelsForProvider(runtime.modelOptions, contribution.providerId) : runtime.selectableModels,
        2_048,
      );
      if (!validation.ok) {
        const message =
          validation.error ?? "The selected model is unavailable.";
        agent.reportError(message);
        setSubmissionError(message);
        return;
      }
      const imageInputs = composerImageInputs(runtime.composerAttachments);
      const selectedModel = composerModels.find((model) => model.id === runModelOptionId);
      if (!imageInputs.ok || (imageInputs.images.length > 0 && (connected.backendType !== "codex-app-server" || connected.authState !== "connected" || selectedModel?.capabilities?.vision !== true))) {
        setSubmissionError(imageInputs.ok ? "Image understanding currently requires a connected Codex model that supports images. Choose a compatible model or remove the images." : imageInputs.error);
        return;
      }
      submissionPending.current = true;
      setSubmissionError("");
      setOptimisticUserMessage(batch && (batch.index > 0 || batch.suppressHuman) ? "" : prompt);
      setSuppressProjectPrompt(Boolean(batch && (batch.index > 0 || batch.suppressHuman)));
      if (!batch || batch.index === 0) runtime.setComposerValue("");
      await durableConversation.deleteDraft().catch(() => undefined);
      resetCancellation();
      try {
        if (!projectIsCurrent()) return;
        const { ids: connectorIds, tools: connectorTools } = await beginConnectorTurn();
        if (!projectIsCurrent()) return;
        const projectInstructions = batch ? `Shared project: ${batch.project.name}\nYou are ${activeAgent.name}. This conversation is shared with the user's agents. Read the recorded conversation before acting and identify your own contribution. Files available as context are the project sources explicitly supplied to this response. Other agents' computers and private files are not accessible through your computer tools.\n\nProject instructions:\n${batch.project.instructions}` : "";
        const tools = conversationToolsForModel(connectorTools, computerToolsReady(localComputer.node), connected, selectedModel, localComputer.node?.plugins, imageApiConnected, localComputer.node?.runtimeAvailable === true);
        const pluginInstructions = builtinPluginInstructions(prompt, localComputer.node?.plugins, tools.map((tool) => tool.name));
        const instructions = [agentExecutionInstructions(activeAgent), CONVERSATION_STYLE_INSTRUCTIONS, COMPUTER_WORK_INSTRUCTIONS, pluginInstructions, projectInstructions].filter(Boolean).join("\n\n");
        const preparedContext = await runtime.assembleConversationContext(prompt, {
          threadId: selectedThreadId,
          allowedConnectorIds: connectorIds,
          allowedKnowledgeSourceIds: [...new Set([...(batch?.project.knowledgeSourceIds ?? []), ...runtime.composerAttachments.flatMap((attachment) => attachment.sourceId ? [attachment.sourceId] : [])])],
        });
        if (!projectIsCurrent()) return;
        const request = buildAgentRequest({
            model: runModelId,
            reasoningEffort: contribution?.reasoningEffort ?? selectedReasoningEffort,
            prompt,
            images: imageInputs.images,
            instructions: batch?.retryAttempt ? `${instructions}\n\n${INTERRUPTED_CHECKPOINT_INSTRUCTION}` : instructions,
            tools,
            maxTokens: validation.maxTokens,
          });
        if (batch?.retryAttempt) request.messages.splice(request.messages.length - 1, 0, { role: "assistant", content: buildInterruptedAttemptCheckpoint(batch.retryAttempt) });
        const outcome = await agent.run(
          request,
          preparedContext,
          runtime.permissionMode,
          batch?.retryAttempt?.id,
          batch ? {
            canonicalUserMessage: batch.index > 0 || batch.suppressHuman ? "suppress" : "persist",
            afterAttemptQueued: async ({ attemptId, threadId }) => {
              if (!projectIsCurrent() || threadId !== batch.project.threadId) throw new Error("The project changed before this response started.");
              const author = await bindLocalProjectRunAuthor({ workspaceId: batch.workspaceId, projectId: batch.project.id, expectedRevision: batch.project.revision, runId: attemptId, agentId: activeAgent.id, threadId });
              if (!projectIsCurrent()) throw new Error("The project response was stopped.");
              projects.setAuthors((current) => [...current.filter((item) => item.runId !== author.runId), author]);
            },
          } : undefined,
        );
        if (outcome?.status === "completed" && (!batch || batch.index === batch.contributions.length - 1)) {
          for (const image of imageInputs.images) runtime.removeComposerAttachment(image.id);
        } else if ((!outcome || outcome.status === "failed") && !currentRepositoryDraft.current.trim()) {
          runtime.setComposerValue(batch?.prompt ?? prompt);
        }
        return outcome?.status;
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Mivlet could not complete that response.";
        agent.reportError(message);
        setSubmissionError(message);
        if (!currentRepositoryDraft.current.trim()) runtime.setComposerValue(batch?.prompt ?? prompt);
      } finally {
        submissionPending.current = false;
        endConnectorTurn();
        await Promise.allSettled([runtime.refreshConnectorStatuses(), durableConversation.refresh()]);
        setOptimisticUserMessage("");
      }
    },
    [
      activeAgent,
      agent.reportError,
      agent.run,
      agent.state.running,
      durableConversation.deleteDraft,
      durableConversation.refresh,
      durableConversation.state.conversation,
      resetCancellation,
      beginConnectorTurn,
      endConnectorTurn,
      runtime.assembleConversationContext,
      runtime.connectedAgentBackend,
      runtime.backendProviders,
      runtime.modelOptions,
      runtime.connectorManifests,
      runtime.refreshConnectorStatuses,
      runtime.permissionMode,
      runtime.selectableModels,
      runtime.runtimeSnapshotError,
      runtime.runtimeSnapshotReady,
      runtime.setComposerValue,
      runtime.composerAttachments,
      runtime.removeComposerAttachment,
      selectedModelId,
      selectedModelOptionId,
      composerModels,
      imageApiConnected,
      localComputer.node?.lifecycle,
      localComputer.node?.plugins,
      localComputer.node?.runtimeAvailable,
      localComputer.node?.controller,
      selectedReasoningEffort,
      selectedThreadId,
      selectedProjectId,
    ],
  );

  useEffect(() => {
    if (!queuedPrompt || queuedPrompt.threadId !== selectedThreadId) return;
    setQueuedPrompt(null);
    void executePrompt(queuedPrompt.prompt);
  }, [executePrompt, queuedPrompt, selectedThreadId]);

  const startedProjectContribution = useRef("");
  useEffect(() => {
    if (!projectBatch || agent.state.running || submissionPending.current || !selectedProject) return;
    const contribution = projectBatch.contributions[projectBatch.index];
    const key = `${projectBatch.id}:${projectBatch.index}`;
    if (startedProjectContribution.current === key || projectExecutor?.agentId !== contribution.agentId || selectedThreadId !== projectBatch.project.threadId) return;
    startedProjectContribution.current = key;
    void executePrompt(projectContributionPrompt(projectBatch.prompt, projectBatch.index), projectBatch).then((status) => {
      if (projectBatchRef.current?.id !== projectBatch.id) return;
      if (status !== "completed" || projectBatch.index + 1 >= projectBatch.contributions.length) {
        projectBatchRef.current = undefined;
        setProjectBatch(undefined);
        void projects.refresh();
        return;
      }
      const next = { ...projectBatch, index: projectBatch.index + 1 };
      projectBatchRef.current = next;
      setProjectExecutor(next.contributions[next.index]);
      setProjectBatch(next);
    });
  }, [projectBatch, projectExecutor, selectedProject, selectedThreadId, agent.state.running, executePrompt]);

  useEffect(() => {
    if (projectBatchRef.current && projectBatchRef.current.workspaceId !== workspaceId) {
      projectBatchRef.current = undefined;
      setProjectBatch(undefined);
      setSelectedProjectId(undefined);
      setProjectExecutor(undefined);
    }
  }, [workspaceId]);

  if (runtime.runtimeSnapshotError || !runtime.runtimeSnapshotReady) {
    return (
      <main className="og-frame">
        <section className="empty-state" role={runtime.runtimeSnapshotError ? "alert" : "status"} aria-busy={!runtime.runtimeSnapshotError}>
          <Brand compact />
          <p>{runtime.runtimeSnapshotError ?? "Loading your workspace…"}</p>
          {runtime.runtimeSnapshotError && <button type="button" disabled={runtime.accountWorkspacePending} onClick={() => void runtime.reconcileAccountWorkspace()}>Retry</button>}
        </section>
      </main>
    );
  }

  if (!activeAgent) {
    return (
      <main className="og-frame">
        <p role="alert">Mivlet could not load a agent.</p>
      </main>
    );
  }

  const localWorkspaceReady =
    runtime.accountWorkspaceStatus.activeWorkspace.source === "local" &&
    runtime.accountWorkspaceStatus.accountBound &&
    runtime.accountWorkspaceStatus.state === "ready";
  if (!localWorkspaceReady || runtime.onboardingRequired) {
    return (
      <Suspense fallback={<main className="og-frame" aria-busy="true" />}>
        <OnboardingPage
          connectors={runtime.connectorManifests}
          providers={runtime.backendProviders}
          connectedBackendIds={runtime.connectedBackendIds}
          status={runtime.backendStatus}
          identityStatus={runtime.identityStatus}
          identityPending={runtime.identityPending}
          onSignIn={() => runtime.signInIdentity()}
          onConnectWithVerify={runtime.connectBackendWithVerify}
          onCheckConnection={runtime.checkBackendConnection}
          onStartBrowserLogin={runtime.startBackendBrowserLogin}

          connectorStatus={runtime.connectorStatus}
          onConnectConnector={runtime.connectConnector}
          onComplete={runtime.dismissOnboarding}
        />
      </Suspense>
    );
  }

  const submitComposer = async () => {
    const prompt = runtime.composerValue.trim();
    if (!prompt || agent.state.running || projectBatch || projectSavingRef.current || queuedPrompt || deletingConversation || !runtime.runtimeSnapshotReady || runtime.runtimeSnapshotError) return;
    if (selectedProjectId) {
      if (!selectedProject || !workspaceId) { setSubmissionError("Reload the project before sending a message."); return; }
      try {
        const contributions = projectContributions(runtime.agents, projectRecipient, composerModels);
        const batch = { id: crypto.randomUUID(), workspaceId, project: selectedProject, prompt, contributions, index: 0 };
        projectBatchRef.current = batch;
        setProjectExecutor(contributions[0]);
        setProjectBatch(batch);
        setProjectTab("conversation");
        setSubmissionError("");
      } catch (error) { setSubmissionError(error instanceof Error ? error.message : "Could not start the project response."); }
      return;
    }
    if (!selectedThreadId) {
      const thread = await durableConversation.createThread({
        authorityScope: {
          authority: "local",
          visibility: "member-private",
          ownerMemberId: "current-member" as never,
        },
        title: prompt.slice(0, 72),
      });
      runtime.updateAgent(activeAgent.id, { threadId: thread.id });
      setSelectedThreadId(thread.id);
      setQueuedPrompt({ threadId: thread.id, prompt });
      return;
    }
    await executePrompt(prompt);
  };

  const selectProject = async (id: string) => {
    if (navigationPending.current || projectSavingRef.current || agent.state.running || projectBatch || submissionPending.current) {
      setSubmissionError("Stop the current response before switching projects.");
      return;
    }
    const project = projects.projects.find((item) => item.id === id);
    if (!project) return;
    navigationPending.current = true;
    try {
      await durableConversation.saveDraft(runtime.composerValue);
      if (projectScope.current.workspaceId !== project.workspaceId) return;
      setSelectedProjectId(project.id);
      setSelectedThreadId(project.threadId);
      setProjectExecutor(undefined);
      setProjectRecipient("all");
      setSuppressProjectPrompt(false);
      setProjectTab("conversation");
      setMarketplaceTab(null);
      setWorkPanelOpen(false);
      setMobileConversation(true);
      setProjectError("");
      setSubmissionError("");
      runtime.setComposerValue("");
      focusConversationBack();
    } catch (error) { setSubmissionError(error instanceof Error ? error.message : "Could not save the current draft."); }
    finally { navigationPending.current = false; }
  };

  const saveProject = async (draft: ProjectDraft, project = projects.projects.find((item) => item.id === editingProjectId)) => {
    if (!workspaceId || projectSavingRef.current || agent.state.running || projectBatch || submissionPending.current) return;
    projectSavingRef.current = true; setProjectSaving(true); setProjectError("");
    try {
      if (!project) await durableConversation.saveDraft(runtime.composerValue);
      if (projectScope.current.workspaceId !== workspaceId) return;
      const saved = project ? await updateLocalProject({ workspaceId, id: project.id, expectedRevision: project.revision, name: draft.name, instructions: draft.instructions, knowledgeSourceIds: project.knowledgeSourceIds })
        : await createLocalProject({ workspaceId, id: `project-${crypto.randomUUID()}`, threadId: `thread-${crypto.randomUUID()}`, ...draft, knowledgeSourceIds: [] });
      if (projectScope.current.workspaceId !== workspaceId) return;
      projects.setProjects((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      setProjectEditorOpen(false);
      if (!project) {
        setSelectedProjectId(saved.id); setSelectedThreadId(saved.threadId); setProjectExecutor(undefined); setProjectRecipient("all");
        setProjectTab("conversation"); setMobileConversation(true); setMarketplaceTab(null); setWorkPanelOpen(false); runtime.setComposerValue("");
      }
    } catch (error) { if (projectScope.current.workspaceId === workspaceId) setProjectError(error instanceof Error ? error.message : "Could not save this project."); }
    finally { projectSavingRef.current = false; setProjectSaving(false); }
  };

  const chooseProjectRecipient = (id: string | null) => {
    if (projectBatch || agent.state.running) return;
    setProjectRecipient(id ?? "all");
    const profile = runtime.agents.find((item) => item.id === id);
    const model = composerModels.find((item) => item.id === profile?.modelId);
    setProjectExecutor(profile ? { agentId: profile.id, providerId: model?.providerId ?? "", modelId: model?.modelId ?? "", modelOptionId: model?.id ?? "" } : undefined);
  };

  const saveProjectSourceIds = async (project: LocalProject, knowledgeSourceIds: string[]) => {
    const saved = await updateLocalProject({ workspaceId: project.workspaceId, id: project.id, expectedRevision: project.revision, name: project.name, instructions: project.instructions, knowledgeSourceIds });
    if (projectScope.current.workspaceId === project.workspaceId) projects.setProjects((current) => current.map((item) => item.id === saved.id ? saved : item));
    return saved;
  };

  const changeProjectSource = async (sourceId: string, remove: boolean) => {
    if (!selectedProject || projectSavingRef.current || agent.state.running || projectBatch || submissionPending.current) return;
    projectSavingRef.current = true; setProjectSaving(true); setProjectError("");
    try { await saveProjectSourceIds(selectedProject, remove ? selectedProject.knowledgeSourceIds.filter((id) => id !== sourceId) : [...new Set([...selectedProject.knowledgeSourceIds, sourceId])]); }
    catch (error) { setProjectError(error instanceof Error ? error.message : "Could not update project files."); }
    finally { projectSavingRef.current = false; setProjectSaving(false); }
  };

  const importProjectFiles = async (files: File[]) => {
    if (!selectedProject || projectSavingRef.current || agent.state.running || projectBatch || !files.length) return;
    projectSavingRef.current = true; setProjectSaving(true); setProjectError("");
    const project = selectedProject;
    try {
      const sourceIds: string[] = [];
      for (const file of files.slice(0, 12)) {
        const id = await runtime.importKnowledgeFile(file);
        if (projectScope.current.workspaceId !== project.workspaceId || projectScope.current.projectId !== project.id) return;
        if (!id) throw new Error(`Could not import ${file.name}. Check that it is a supported text document.`);
        sourceIds.push(id);
      }
      await saveProjectSourceIds(project, [...new Set([...project.knowledgeSourceIds, ...sourceIds])]);
    } catch (error) { setProjectError(error instanceof Error ? error.message : "Could not import project files."); }
    finally { projectSavingRef.current = false; setProjectSaving(false); }
  };

  const selectAgent = async (profile: FableAgentProfile) => {
    if (navigationPending.current) return false;
    // Returning to the current chat is navigation, even while a tool or an
    // approval is pending. Keep its response and draft intact.
    if (profile.id === activeAgent.id && !selectedProjectId) {
      setMarketplaceTab(null);
      setMobileConversation(true);
      focusConversationBack();
      return true;
    }
    if (deletingConversation || projectSavingRef.current) return false;
    if (agent.state.running || projectBatch || submissionPending.current) {
      runtime.setLastAction(
        "Stop the current response before switching agents.",
      );
      return false;
    }
    navigationPending.current = true;
    try {
      // Flush before changing scope: a quick navigation must not discard the debounce's draft.
      await durableConversation.saveDraft(runtime.composerValue);
    } catch {
      runtime.setLastAction("Your draft could not be saved. Try again before switching agents.");
      return false;
    } finally { navigationPending.current = false; }
    runtime.selectAgent(profile.id);
    setSelectedProjectId(undefined);
    setProjectExecutor(undefined);
    setSuppressProjectPrompt(false);
    setMobileConversation(true);
    setWorkPanelOpen(false);
    focusConversationBack();
    setMarketplaceTab(null);
    setSelectedThreadId(profile.threadId);
    runtime.setComposerValue("");
    setSubmissionError("");
    return true;
  };
  const createTeammate = () => {
    setMarketplaceTab(null);
    setEditingAgentId(null);
    setAgentEditorOpen(true);
  };
  const editTeammate = (profile: FableAgentProfile) => {
    setEditingAgentId(profile.id);
    setAgentEditorOpen(true);
  };
  const startNewConversation = (draft = "") => {
    if (agent.state.running || projectBatch || selectedProjectId) return;
    runtime.updateAgent(activeAgent.id, { threadId: undefined });
    setSelectedThreadId(undefined);
    runtime.setComposerValue(draft);
    agent.clearContextFailure();
    setSubmissionError("");
    setOptimisticUserMessage("");
    window.requestAnimationFrame(() => runtime.composerRef.current?.focus());
  };

  const threadById = new Map(
    durableConversation.state.threads.map((thread) => [
      thread.id as string,
      thread,
    ]),
  );
  const computerToolActive = agent.state.responseParts?.some((part) => part.kind === "tool" && part.state === "running" && (part.tool.startsWith("local-") || part.tool === "run-shell"));
  const activePresence = agentPresence(agent.state, runtime.openApprovals.length > 0, Boolean(queuedPrompt), {
    computerController: localComputer.node?.control.status === "active" && computerToolActive ? localComputer.controller : undefined,
    providerUnavailable: runtime.runtimeSnapshotReady && !runtime.connectedAgentBackend,
    listening: voice.state.status === "listening",
  });
  const previews = Object.fromEntries(
    runtime.agents.map((profile) => {
      const thread = profile.threadId
        ? threadById.get(profile.threadId)
        : undefined;
      const presence = profile.id === activeAgent.id ? activePresence : "idle";
      const status: AgentSidebarPreview["status"] = ["waiting", "input", "blocked", "unavailable"].includes(presence) ? "attention" : ["received", "working", "thinking", "service"].includes(presence) ? "running" : "idle";
      return [
        profile.id,
        {
          message: presence !== "idle" && presence !== "done" ? presenceLabel(presence, agent.state.activity) : thread?.title ?? "Start a conversation",
          time: compactTime(thread?.updatedAt),
          status,
          presence,
          completionId: presence === "done" ? agent.state.currentAttemptId ?? undefined : undefined,
        } satisfies AgentSidebarPreview,
      ];
    }),
  );
  const verifiedDisplay =
    runtime.identityStatus.authentication?.verifiedDisplayAttributes;
  const profileName =
    verifiedDisplay?.displayName ?? verifiedDisplay?.email ?? "Local workspace";
  const conversation = durableConversation.state.conversation?.thread.id === selectedThreadId ? durableConversation.state.conversation : null;
  const scheduleNoticeKey = scheduleDispatch ? `${scheduleDispatch.scheduleId ?? ""}:${scheduleDispatch.occurrenceId ?? ""}:${scheduleDispatch.phase}:${scheduleDispatch.message ?? ""}` : "";
  const scheduleNotice = scheduleDispatch?.phase === "needs-user" || scheduleDispatch?.phase === "failed"
    ? scheduleDispatch.message ?? "Scheduled work needs your attention."
    : scheduleDispatch?.phase === "idle" && scheduleDispatch.occurrenceId ? "Scheduled research is ready." : "";
  const messages = conversation?.messages ?? [];
  const eligibleProjectSources = runtime.workspaceKnowledgeSources.filter((source) => source.workspaceId === workspaceId && !source.deletedAt && !source.disabled && (!source.scope || source.scope.level === "global"));
  const projectFiles = (selectedProject?.knowledgeSourceIds ?? []).map((sourceId) => {
    const source = eligibleProjectSources.find((item) => item.id === sourceId);
    return { sourceId, name: source?.title ?? "Unavailable file", mediaType: source?.mediaType, sizeBytes: source?.sizeBytes, provenance: source?.provenance ?? "Remove this file or import it again." };
  });
  const projectFileChoices = eligibleProjectSources.map((source) => ({ sourceId: source.id, name: source.title, mediaType: source.mediaType, sizeBytes: source.sizeBytes, provenance: source.provenance }));
  const projectBusy = projectSaving || agent.state.running || Boolean(projectBatch);
  const projectFilesView = (compact = false) => <ProjectFiles files={projectFiles} eligibleSources={projectFileChoices}
    compact={compact} disabled={projectBusy} error={projectError}
    onAttach={(id) => { void changeProjectSource(id, false); }} onRemove={(id) => { void changeProjectSource(id, true); }}
    onImport={() => projectFileInput.current?.click()} />;
  const projectAuthors = selectedProjectId ? Object.fromEntries(projects.authors.map((author) => {
    const profile = runtime.agents.find((candidate) => candidate.id === author.agentId);
    return [author.runId, { ...(profile ?? activeAgent), id: author.agentId, name: author.agentName, avatarSeed: profile?.avatarSeed ?? `blob-v1:${author.agentId}` }];
  })) : undefined;
  const screenPreviewUrl =
    hostedBrowser.snapshot?.previewDataUrl;
  const approvalPanel = runtime.openApprovals.length ? (
    <Suspense fallback={null}>
      <ApprovalPanel
        compact
        previews={runtime.approvalPreviews}
        approvals={runtime.openApprovals}
        audit={runtime.approvalAudit}
        sessionGrants={runtime.sessionApprovalGrants}
        approvalRules={runtime.approvalRules}
        editingApprovalId={runtime.editingApprovalId}
        modificationDraft={runtime.approvalModificationDraft}
        pendingConfirmation={runtime.pendingApprovalConfirmation}
        confirmationText={runtime.approvalConfirmationText}
        onDecision={runtime.requestApprovalDecision}
        onStartModify={runtime.startApprovalModify}
        onUpdateModification={runtime.setApprovalModificationDraft}
        onSaveModify={runtime.saveApprovalModify}
        onCancelModify={runtime.clearApprovalInteraction}
        onUpdateConfirmation={runtime.setApprovalConfirmationText}
        onConfirmDecision={runtime.confirmApprovalDecision}
        onCancelConfirmation={runtime.clearApprovalInteraction}
      />
    </Suspense>
  ) : undefined;

  return (
    <main
      className={`desktop-frame desktop-frame--agents${navigationCollapsed && !isPhone ? " desktop-frame--nav-collapsed" : ""}${selectedProjectId ? " desktop-frame--project" : ""}${(workPanelOpen || artifactPreview) && !marketplaceTab ? "" : " desktop-frame--live-closed"}${artifactPreview ? " desktop-frame--artifact" : ""}`}
      data-theme={theme}
      data-mobile-view={mobileConversation || marketplaceTab ? "conversation" : "list"}
    >
      {scheduleNotice && dismissedScheduleNotice !== scheduleNoticeKey ? <aside className="scheduled-work-notice" aria-label="Scheduled work"><p role="status">{scheduleNotice}</p><div><button type="button" className="button button--secondary" onClick={() => { openSchedules(); setDismissedScheduleNotice(scheduleNoticeKey); }}>View schedules</button><button type="button" className="button button--secondary" onClick={() => setDismissedScheduleNotice(scheduleNoticeKey)} aria-label="Dismiss scheduled work notice">Dismiss</button></div></aside> : null}
      <AgentSidebar
        collapsed={navigationCollapsed && !isPhone}
        onToggleCollapsed={() => setNavigationCollapsed((value) => !value)}
        hidden={isPhone && (mobileConversation || marketplaceTab !== null)}
        connectors={runtime.connectorManifests}
        agents={runtime.agents}
        projects={projects.projects}
        selectedProjectId={selectedProjectId}
        onSelectProject={(project) => { void selectProject(project.id); }}
        onCreateProject={() => {
          if (projectBusy || submissionPending.current) return;
          setEditingProjectId(undefined); setProjectError(""); setProjectEditorOpen(true);
        }}
        activeAgentId={activeAgent.id}
        previews={previews}
        profileName={profileName}
        marketplaceActive={marketplaceTab !== null}
        onSelectAgent={selectAgent}
        onCreateAgent={createTeammate}
        onEditAgent={editTeammate}
        onOpenMarketplace={() => {
          setMarketplaceConnectorId(undefined);
          setMarketplaceTab("plugins");
          setWorkPanelOpen(false);
        }}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenUsage={() => setAccountDialog("usage")}
        onSignOut={() => setAccountDialog("sign-out")}
      />

      {marketplaceTab ? (
        <Suspense fallback={null}>
          <MarketplacePage
            initialConnectorId={marketplaceConnectorId}
            onBack={() => setMarketplaceTab(null)}
            workspaceId={runtime.accountWorkspaceStatus.activeWorkspace.localWorkspaceId}
            manifests={runtime.connectorManifests.filter(
              (connector) => connector.id !== "local-files",
            )}
            accounts={runtime.connectorAccounts}
            connectorStatus={runtime.connectorStatus}
            onUseConnector={(connector, prompt) => {
              runtime.useConnector(connector);
              if (prompt) runtime.setComposerValue(`${runtime.composerValue}${runtime.composerValue && !/\s$/.test(runtime.composerValue) ? " " : ""}@${connector.id} ${prompt}`);
              setMarketplaceTab(null);
            }}
            onUseBuiltinPlugin={(id) => {
              runtime.setComposerValue(`${runtime.composerValue}${runtime.composerValue && !/\s$/.test(runtime.composerValue) ? " " : ""}@${id} `);
              setMarketplaceTab(null);
              window.requestAnimationFrame(() => runtime.composerRef.current?.focus());
            }}
            onConnect={runtime.connectConnector}
            onDisconnect={(connectorId) =>
              runtime.disconnectConnector(connectorId)
            }
            onRefresh={(connectorId) =>
              void runtime.refreshConnector(connectorId)
            }
            onSelectConnector={(connector) =>
              void runtime.loadConnectorAccounts(connector.id)
            }
            onSwitchAccount={(connectorId, connectionId) =>
              void runtime.switchConnectorAccount(connectorId, connectionId)
            }
          />
        </Suspense>
      ) : selectedProject ? (
        isPhone && !mobileConversation ? null : <Suspense fallback={null}><ProjectWorkspace name={selectedProject.name} activeTab={projectTab} onTabChange={setProjectTab}
          onBack={isPhone ? () => { setMobileConversation(false); setWorkPanelOpen(false); } : undefined}
          headerActions={<>
            <button type="button" className="project-room-action" data-work-panel-toggle aria-label={`Open ${activeAgent.name}'s computer`} onClick={() => { setArtifactPreview(null); setWorkPanelOpen((open) => !open); }}><Desktop size={19} aria-hidden="true" /></button>
            <WorkspaceMenu label="Project options" onSchedules={() => openSchedules()} onEdit={projectBusy ? undefined : () => { setEditingProjectId(selectedProject.id); setProjectError(""); setProjectEditorOpen(true); }} />
          </>}
          conversation={renderConversation()}
          files={projectFilesView()}
          instructions={<ProjectInstructions key={selectedProject.id} instructions={selectedProject.instructions} pending={projectBusy} error={projectError}
            onSave={(instructions) => saveProject({ name: selectedProject.name, instructions }, selectedProject)} />}
          rail={!workPanelOpen && !artifactPreview ? <>
            <section className="project-room-agents" aria-label="Project agents"><h2>Working here</h2><div>{runtime.agents.map((profile) => <button type="button" key={profile.id} title={profile.name} aria-label={`Ask ${profile.name}`} disabled={projectBusy} onClick={() => {
              chooseProjectRecipient(profile.id); setProjectTab("conversation"); focusComposer();
            }}><ProfileAgentAvatar agent={profile} iconSize={30} presence={agent.state.running && activeAgent.id === profile.id ? agentPresence(agent.state, runtime.openApprovals.length > 0) : "idle"} /></button>)}</div></section>
            {projectFilesView(true)}
            <button type="button" className="project-room-view-files" onClick={() => setProjectTab("files")}>View all files</button>
          </> : undefined} /></Suspense>
      ) : selectedProjectId ? (
        <section className="workspace agent-workspace"><div className="project-room-status" role={projects.error ? "alert" : "status"}>
          <p>{projects.error || (projects.loading ? "Loading project…" : "This project is no longer available.")}</p>
          <button type="button" onClick={() => { void projects.refresh(); }}>Reload projects</button>
        </div></section>
      ) : (
      <section className="workspace agent-workspace" hidden={isPhone && !mobileConversation}>
        <AgentWorkspaceHeader
          agent={activeAgent}
          onSchedules={() => openSchedules(activeAgent.id)}
          attentionCount={runtime.openApprovals.length}
          presence={activePresence}
          activity={agent.state.activity}
          computerActive={Boolean(localComputer.node?.control.status === "active" || hostedBrowser.opening)}
          onBack={isPhone ? () => { setMobileConversation(false); setWorkPanelOpen(false); window.requestAnimationFrame(() => document.querySelector<HTMLElement>('.agent-row__select[aria-current="page"]')?.focus()); } : undefined}
          panelOpen={workPanelOpen && !artifactPreview}
          onTogglePanel={() => { if (artifactPreview) { setArtifactPreview(null); setWorkPanelOpen(true); } else setWorkPanelOpen((open) => !open); }}
        />

        {renderConversation()}
      </section>
      )}

      {artifactPreview && !marketplaceTab ? <Suspense fallback={null}><ArtifactPreview key={`${activeAgent.id}:${selectedThreadId}:${localComputer.node?.generation}:${artifactPreview}`}
        output={artifactPreview} workspaceId={runtime.accountWorkspaceStatus.activeWorkspace.localWorkspaceId ?? ""}
        agentId={artifactOwner?.agentId ?? activeAgent.id} generation={artifactOwner?.generation}
        onClose={() => { setArtifactPreview(null); artifactTrigger.current?.focus(); }} /></Suspense> : null}
      {workPanelOpen && !marketplaceTab && !artifactPreview ? (
        <Suspense fallback={null}><LiveWorkRail
          conversations={durableConversation.state.threads.filter((thread) =>
            thread.lifecycle === "active" && (activeAgent.threadIds ?? [activeAgent.threadId]).includes(thread.id)
          ).map((thread) => ({ id: thread.id, title: thread.title, time: compactTime(thread.updatedAt) }))}
          activeConversationId={selectedThreadId}
          conversationBusy={agent.state.running || Boolean(queuedPrompt) || deletingConversation}
          onDeleteConversation={async (id) => {
            if (agent.state.running || queuedPrompt || deletingConversation) return;
            setDeletingConversation(true);
            try {
              await durableConversation.deleteThread(id);
              const threadIds = (activeAgent.threadIds ?? [activeAgent.threadId]).filter((threadId): threadId is string => Boolean(threadId) && threadId !== id);
              runtime.updateAgent(activeAgent.id, { threadIds, ...(activeAgent.threadId === id ? { threadId: undefined } : {}) });
              if (selectedThreadId === id) { setSelectedThreadId(undefined); runtime.setComposerValue(""); setOptimisticUserMessage(""); }
              setSubmissionError("");
            } catch (error) { setSubmissionError(error instanceof Error ? error.message : "Could not delete this conversation."); }
            finally { setDeletingConversation(false); }
          }}
          onNewConversation={startNewConversation}
          onSelectConversation={(id) => {
            if (agent.state.running || queuedPrompt) return;
            runtime.updateAgent(activeAgent.id, { threadId: id });
            setSelectedThreadId(id); runtime.setComposerValue(""); setOptimisticUserMessage(""); setSubmissionError("");
          }}
          agentName={activeAgent.name}
          localComputer={localComputer}
          hostedComputer={{
            available: hostedComputer.available,
            status: hostedComputer.node?.status,
            runtimeActive: hostedComputer.node?.runtimeActive ?? false,
            keepAlive: hostedComputer.node?.keepAlive ?? false,
            loading: hostedComputer.loading,
            provisioning: hostedComputer.provisioning,
            error: hostedComputer.error,
            onProvision: hostedComputer.provision,
            browserOpening: hostedBrowser.opening,
            browserPhase: hostedBrowser.phase,
            browserError: hostedBrowser.error,
            browserUrl: hostedBrowser.snapshot?.currentUrl,
            browserTitle: hostedBrowser.snapshot?.title,
            liveViewUrl: hostedBrowser.snapshot?.liveViewUrl,
            browserDownload: hostedBrowser.snapshot?.lastDownload,
            onOpenBrowser: hostedBrowser.open,
            onRefreshBrowser: hostedBrowser.refresh,
          }}
          screenPreviewUrl={screenPreviewUrl}
          onClose={() => { setWorkPanelOpen(false); window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>("[data-work-panel-toggle]")?.focus()); }}
        /></Suspense>
      ) : null}

      <input ref={projectFileInput} type="file" accept={ACCEPTED_LOCAL_KNOWLEDGE_FILES} multiple hidden onChange={(event) => {
        const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; void importProjectFiles(files);
      }} />
      {projectEditorOpen ? <Suspense fallback={null}><ProjectEditor open={projectEditorOpen} project={projects.projects.find((item) => item.id === editingProjectId) ?? null}
        pending={projectSaving} error={projectError} onClose={() => { if (!projectSavingRef.current) setProjectEditorOpen(false); }} onSave={(draft) => { void saveProject(draft); }}
        onArchive={(id) => {
          const project = projects.projects.find((item) => item.id === id);
          if (!project || projectBusy || !workspaceId || projectSavingRef.current) return;
          projectSavingRef.current = true; setProjectSaving(true); setProjectError("");
          void archiveLocalProject({ workspaceId, id, expectedRevision: project.revision }).then(() => {
            if (projectScope.current.workspaceId !== workspaceId) return;
            projects.setProjects((current) => current.filter((item) => item.id !== id));
            if (selectedProjectId === id) { setSelectedProjectId(undefined); setProjectExecutor(undefined); runtime.setComposerValue(""); }
            setProjectEditorOpen(false); void durableConversation.refresh();
          }).catch((error) => setProjectError(error instanceof Error ? error.message : "Could not archive this project.")).finally(() => { projectSavingRef.current = false; setProjectSaving(false); });
        }} /></Suspense> : null}

      {agentEditorOpen ? <Suspense fallback={null}><AgentEditor
        onSkillsChange={(learnedTasks) => { if (editingAgentId) runtime.updateAgent(editingAgentId, { learnedTasks }); }}
        onUseSkill={async (task) => {
          const profile = runtime.agents.find((candidate) => candidate.id === editingAgentId);
          if (profile && !await selectAgent(profile)) return;
          runtime.setComposerValue(task.instruction);
          focusComposer();
        }}
        existingAvatarSeeds={runtime.agents.map((profile) => profile.avatarSeed ?? `blob-v1:${profile.id}`)}
        open={agentEditorOpen}
        agent={
          editingAgentId
            ? (runtime.agents.find(
                (profile) => profile.id === editingAgentId,
              ) ?? null)
            : null
        }
        models={runtime.modelOptions}
        canDelete={runtime.agents.length > 1}
        onClose={() => {
          setAgentEditorOpen(false);
          setEditingAgentId(null);
        }}
        onSave={(draft) => {
          if (editingAgentId) {
            runtime.updateAgent(editingAgentId, draft);
          } else {
            const created = runtime.createAgent(draft);
            runtime.selectAgent(created.id);
            setSelectedThreadId(undefined);
            setMobileConversation(true);
            setWorkPanelOpen(false);
          }
          setAgentEditorOpen(false);
          setEditingAgentId(null);
        }}
        onDelete={() => {
          if (editingAgentId) runtime.removeAgent(editingAgentId);
          setAgentEditorOpen(false);
          setEditingAgentId(null);
        }}
      /></Suspense> : null}

      {accountDialog ? <Suspense fallback={null}><AccountDialog key={accountDialog} kind={accountDialog} name={profileName}
        records={Object.values(agent.state.usageReceipts)} onClose={() => setAccountDialog(null)}
        onSignOut={async () => { await stopCurrentWork(); await runtime.signOutIdentity(); }} /></Suspense> : null}

      {schedulesOpen ? <SchedulesDialog onClose={() => setSchedulesOpen(false)}><Suspense fallback={<p role="status">Loading schedules…</p>}><LocalSchedules runtime={runtime} initialAgentId={scheduleAgentId}
                  onOpenResult={async (agentId, threadId) => {
                    const expectedScope = currentRepositoryScope.current;
                    const profile = runtime.agents.find((candidate) => candidate.id === agentId);
                    if (!profile) throw new Error("This schedule's agent is no longer available.");
                    if (agent.state.running || queuedPrompt || deletingConversation) throw new Error("Stop the current response before opening scheduled work.");
                    await durableConversation.saveDraft(runtime.composerValue);
                    const targetThread = await getRuntimeConversationThread(threadId);
                    if (!targetThread) throw new Error("This scheduled conversation is no longer available.");
                    if (currentRepositoryScope.current !== expectedScope) throw new Error("The active workspace or agent changed. Open the result again.");
                    if (!await selectAgent(profile)) throw new Error("The current conversation could not be saved.");
                    runtime.updateAgent(agentId, { threadId, threadIds: [...new Set([...(profile.threadIds ?? []), ...(profile.threadId ? [profile.threadId] : []), threadId])] });
                    setSelectedThreadId(threadId);
                    runtime.setComposerValue("");
                    setOptimisticUserMessage("");
                    setSubmissionError("");
                    setSchedulesOpen(false);
                    focusComposer();
                  }}
      /></Suspense></SchedulesDialog> : null}

      {settingsOpen ? (
        <SettingsModal activeTab={settingsTab} onSelectTab={setSettingsTab} onClose={() => setSettingsOpen(false)}>
              <Suspense fallback={null}>
                <SettingsPage
                  runtime={runtime}
                  theme={theme}
                  onThemeChange={setTheme}
                  activeTab={settingsTab}
                  workspaceName={
                    runtime.accountWorkspaceStatus.activeWorkspace.name ||
                    "Mivlet workspace"
                  }
                  dictationCapability={voice.capability}

                  titleId="settings-modal-title"
                />
              </Suspense>
        </SettingsModal>
      ) : null}
    </main>
  );

  function renderConversation() {
    return (
        <div className="workspace-center workspace-center--composer workspace-center--conversation">
          <div
            ref={conversationScroll.scrollRef}
            onScroll={conversationScroll.onScroll}
            className="conversation-scroll"
            aria-label="Conversation"
          >
            {messages.length === 0 &&
            !optimisticUserMessage &&
            !agent.state.running ? (
              selectedProject ? <div className="project-room-empty"><h1>{selectedProject.name}</h1><p>Give your agents a shared task. Their conversation, references, and results stay together here.</p></div> : <AgentWelcome
                agent={activeAgent}
                onChoose={(prompt) => {
                  runtime.setComposerValue(prompt);
                  runtime.focusComposer(prompt);
                }}
              />
            ) : null}
            <div className="conversation-feed" ref={conversationScroll.contentRef} onClickCapture={(event) => {
              if (event.target instanceof Element && event.target.closest("summary")) conversationScroll.pauseFollowing();
            }}>
              <ConversationFeed showAuthor={false} messages={messages} agent={activeAgent} authors={projectAuthors} requireAuthor={Boolean(selectedProjectId)} suppressLivePrompt={Boolean(selectedProjectId && suppressProjectPrompt)} state={agent.state} presence={activePresence} threadId={selectedThreadId}
                profileName={profileName} connectors={runtime.connectorManifests} optimisticPrompt={optimisticUserMessage}
                onOpenConnector={(id) => { setMarketplaceConnectorId(id); setMarketplaceTab("plugins"); }}
                workspaceId={runtime.accountWorkspaceStatus.activeWorkspace.localWorkspaceId ?? ""}
                generation={localComputer.node?.generation} approval={approvalPanel}
                onPreviewArtifact={(output, authorId) => {
                  artifactTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
                  const sourceAgentId = authorId ?? activeAgent.id;
                  const expectedScope = projectScope.current;
                  if (sourceAgentId === activeAgent.id) {
                    setArtifactOwner({ agentId: sourceAgentId, generation: localComputer.node?.generation });
                    setArtifactPreview(output);
                  } else if (workspaceId) {
                    void loadRuntimeLocalComputer({ workspaceId, agentId: sourceAgentId }).then((node) => {
                      if (projectScope.current.workspaceId !== expectedScope.workspaceId || projectScope.current.projectId !== expectedScope.projectId || projectScope.current.threadId !== expectedScope.threadId) return;
                      setArtifactOwner({ agentId: sourceAgentId, generation: node?.generation });
                      setArtifactPreview(output);
                    }).catch((error) => setSubmissionError(error instanceof Error ? error.message : "Could not open this project's file."));
                  }
                }}
                interruption={<>
                  {agent.state.contextFailure && conversation ? <ContextRecoveryPanel
                    failure={agent.state.contextFailure}
                    disabled={agent.state.running || Boolean(projectBatch) || Boolean(selectedProjectId)}
                    onPrepareHandoff={() => startNewConversation(buildConversationHandoff({
                      thread: conversation.thread,
                      messages,
                      failedPrompt: agent.state.contextFailure?.requestPrompt ?? "",
                    }))}
                  /> : null}
                  {(submissionError || agent.state.lastError) && !agent.state.contextFailure ? <div className="conversation-attention" role="alert">
                    <p>{submissionError || agent.state.lastError}</p>
                    {/sign.in|authenticat|credential|provider.*connect|api.key/i.test(submissionError || agent.state.lastError || "") ? <button type="button" onClick={() => { setSettingsTab("providers"); setSettingsOpen(true); }}>Check provider connection</button> : null}
                  </div> : null}
                  {agent.state.status === "cancelled" && agent.state.progressThreadId === selectedThreadId ? <div className="conversation-attention">
                    <p>Stopped. Your completed work is still here.</p>
                    <button type="button" onClick={() => {
                      const prompt = "Continue from where you stopped. Check the completed work before taking further actions; do not repeat actions that already succeeded.";
                      if (selectedProjectId) { runtime.setComposerValue(prompt); focusComposer(); }
                      else void executePrompt(prompt);
                    }}>Continue</button>
                  </div> : null}
                  {agent.state.recoverableAttempts.filter((attempt) => !agent.state.running && attempt.threadId === selectedThreadId && attempt.id === messages.at(-1)?.message.runId).slice(0, 1).map((attempt) => <div className="conversation-attention" key={attempt.id}>
                    <p>This response was interrupted. Your completed work remains in the conversation.</p>
                    <button type="button" disabled={agent.state.running || Boolean(projectBatch)} onClick={async () => {
                      const retryPrompt = attempt.exchanges?.filter((exchange) => exchange.role === "user").at(-1)?.content ?? "";
                      if (selectedProject && workspaceId) {
                        const author = projects.authors.find((item) => item.runId === attempt.id);
                        const profile = runtime.agents.find((item) => item.id === author?.agentId);
                        const model = composerModels.find((item) => item.providerId === attempt.providerId && item.modelId === attempt.model && item.available);
                        if (!profile || !model) { setSubmissionError("This response's original agent and connected model must be available before retrying."); return; }
                        if (attempt.exchanges?.some((exchange) => exchange.images?.length)) { setSubmissionError("Reattach the original images and send a new project message; image pixels are not stored."); return; }
                        const contribution = { agentId: profile.id, providerId: model.providerId, modelId: model.modelId, modelOptionId: model.id };
                        const batch = { id: crypto.randomUUID(), workspaceId, project: selectedProject, prompt: retryPrompt, contributions: [contribution], index: 0, retryAttempt: attempt,
                          suppressHuman: messages.some((view) => view.message.runId === attempt.id && view.message.kind === "user") || retryPrompt.startsWith("Contribute to the user's project request below.") };
                        projectBatchRef.current = batch; setProjectBatch(batch); setProjectExecutor(contribution); setProjectTab("conversation");
                        return;
                      }
                      setOptimisticUserMessage(retryPrompt);
                      try {
                        const { tools: connectorTools } = await beginConnectorTurn();
                        resetCancellation();
                        const retryProvider = runtime.backendProviders.find((provider) => provider.id === attempt.providerId);
                        const retryModel = composerModels.find((model) => model.providerId === attempt.providerId && model.modelId === attempt.model);
                        const tools = conversationToolsForModel(connectorTools, computerToolsReady(localComputer.node), retryProvider, retryModel, localComputer.node?.plugins, imageApiConnected, localComputer.node?.runtimeAvailable === true);
                        const pluginInstructions = builtinPluginInstructions(retryPrompt, localComputer.node?.plugins, tools.map((tool) => tool.name));
                        await agent.retry(attempt, tools, runtime.permissionMode,
                          [agentExecutionInstructions(activeAgent), CONVERSATION_STYLE_INSTRUCTIONS, COMPUTER_WORK_INSTRUCTIONS, pluginInstructions].filter(Boolean).join("\n\n"));
                      } catch (error) { setSubmissionError(error instanceof Error ? error.message : "Could not retry this response."); }
                      finally { endConnectorTurn(); await Promise.allSettled([runtime.refreshConnectorStatuses(), durableConversation.refresh()]); setOptimisticUserMessage(""); }
                    }}>Retry response</button>
                    <small>Starts a new attempt from your original request, with fresh permissions.</small>
                  </div>)}
                </>} />
              {durableConversation.state.error ? <p className="conversation-status conversation-status--error" role="alert">{durableConversation.state.error}</p> : null}
            </div>
          </div>

          <div className="conversation-composer-dock">
            {conversationScroll.showLatest ? <button className="conversation-latest" type="button" onClick={conversationScroll.toLatest} aria-label="Scroll to latest message" title="Scroll to latest message"><svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v16m-7-7 7 7 7-7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg></button> : null}
            <Composer
              recipientControl={selectedProjectId ? <ProjectParticipants agents={runtime.agents} recipientAgentId={projectRecipient === "all" ? null : projectRecipient} onSelect={chooseProjectRecipient} disabled={projectBusy} /> : undefined}
              modelControl={selectedProjectId && projectRecipient === "all" ? <span className="project-room-models">Each agent’s model</span> : undefined}
              composerRef={runtime.composerRef}
              fileInputRef={runtime.fileInputRef}
              composerValue={runtime.composerValue}
              onComposerChange={runtime.setComposerValue}
              onSubmit={(event) => {
                event.preventDefault();
                void submitComposer();
              }}
              voiceStatus={voice.state.status}
              voiceMessage={voice.state.message}
              voiceCanStart={voice.canStart}
              voiceDisclosure={voice.processingDisclosure}
              voiceReview={voice.review}
              onAuthorizeVoice={voice.authorize}
              onStartVoice={() => void voice.start()}
              onStopVoice={voice.stop}
              onCancelVoice={voice.cancel}
              onDismissVoice={voice.dismiss}
              onAttach={runtime.triggerAttach}
              onImportRepository={() => { void importRepository(); }}
              addMenuOpen={addMenuOpen}

              onToggleAddMenu={() => {
                setAddMenuOpen((open) => !open);
              }}
              onOpenTool={() => {
                setMarketplaceTab("plugins");
                setWorkPanelOpen(false);
                setAddMenuOpen(false);
              }}
              onRunCommand={(command) => runtime.setComposerValue(command)}
              onFileChange={runtime.handleComposerAttachmentChange}
              importStatus={runtime.importStatus}
              models={composerModels}
              selectedModelId={selectedModelOptionId}
              selectedModelLabel={selectedModelLabel}
              selectedReasoningEffort={selectedReasoningEffort}
              onSelectReasoningEffort={(reasoningEffort) => runtime.updateAgent(activeAgent.id, { reasoningEffort })}
              placeholder={selectedProjectId ? "Message this project…" : "Message…"}
              onSelectModel={(modelId) => {
                runtime.selectModel(modelId);
                runtime.updateAgent(activeAgent.id, { modelId, reasoningEffort: undefined });
              }}



              inThread={Boolean(selectedThreadId)}
              isWorking={agent.state.running || Boolean(projectBatch)}
              onStop={() => { projectBatchRef.current = undefined; setProjectBatch(undefined); void stopCurrentWork(); }}
              connectedConnectors={connectedConnectors}
              attachments={runtime.composerAttachments}
              onRemoveAttachment={runtime.removeComposerAttachment}
            />
            {selectedProjectId ? <p className="project-room-disclosure">Project messages are visible to all agents.</p> : null}
          </div>
        </div>
    );
  }

  function focusComposer() {
    window.requestAnimationFrame(() => runtime.composerRef.current?.focus());
  }

  function focusConversationBack() {
    if (isPhone) window.requestAnimationFrame(() => document.querySelector<HTMLElement>(".project-header__back, .agent-workspace-header__back")?.focus());
  }

  function addDictationToComposer(transcript: string) {
    const composer = runtime.composerRef.current;
    const insertion = insertDictation(
      runtime.composerValue,
      transcript,
      composer?.selectionStart ?? runtime.composerValue.length,
      composer?.selectionEnd ?? runtime.composerValue.length,
    );
    runtime.setComposerValue(insertion.value);
    window.requestAnimationFrame(() => {
      runtime.composerRef.current?.focus();
      runtime.composerRef.current?.setSelectionRange(
        insertion.caret,
        insertion.caret,
      );
    });
  }
}
