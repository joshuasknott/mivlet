import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { parseComposerText } from "@fable/connectors/commands";
import type { FableAgentProfile, KnowledgeCitation, Spine, ThreadSummary } from "@fable/protocol";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { connectors } from "../data/workspace";
import { utilityItems } from "../lib/constants";
import {
  buildAgentRequest,
  PERMISSION_PROFILES,
  validateModelSelection
} from "../lib/agent-run";
import { insertDictation } from "../lib/insert-dictation";
import { isCitedBriefMissionPlanSummary, isCitedBriefMissionPrompt, isCitedBriefMissionReceipt, type CitedBriefMissionPlanSummary, type CitedBriefMissionReceipt } from "../lib/cited-brief-contract";
import { startStructuredIntakeMission, structuredIntakeSubject } from "../lib/structured-intake-mission";
import { artifactRevisionBriefFocus, startArtifactRevisionBriefMission } from "../lib/artifact-revision-brief-mission";
import { isParallelApproachesMissionPrompt, isParallelApproachesPlanSummary, type ParallelApproachesPlanSummary } from "../lib/parallel-approaches-contract";
import { parseGeneralMissionDraft } from "../lib/general-mission-command";
import {
  matchesTerminalGeneralRetryStatus,
  resolveProjectMissionRerunSource
} from "../lib/project-mission-rerun";
import { createDesktopDurableRunWriter } from "../hooks/useDurableConversation";
import { AgentSidebar, type AgentSidebarPreview } from "../components/agents/AgentSidebar";
import { AgentEditor } from "../components/agents/AgentEditor";
import { AgentWelcome } from "../components/agents/AgentWelcome";
import { AgentTeamMissionDialog } from "../components/agents/AgentTeamMissionDialog";
import { AgentLearningDialog, type AgentLearningSource } from "../components/agents/AgentLearningDialog";
import { nextAgentColor, ProfileAgentAvatar } from "../components/agents/agent-icons";
import { AgentWorkspaceHeader } from "../components/agents/AgentWorkspaceHeader";
import { LiveWorkRail } from "../components/agents/LiveWorkRail";
import { WorkspaceSearchModal, type WorkspaceSearchItem } from "../components/agents/WorkspaceSearchModal";
import { Composer } from "../components/Composer";
import { ResponseArtifactAction } from "../components/ResponseArtifactAction";
import { exportRuntimeProjectArchive, finalizeRuntimeMissionCoordination, getRuntimeArtifact, getRuntimeConversationThread, listRuntimeConversationMessages, listRuntimePendingCitedApprovals, listRuntimePendingMissionApprovals, listRuntimePendingMissionHumanInputs, listRuntimeThreadArtifacts, listRuntimeThreadMissionProgress, readRuntimeCitedMissionPlanSummaries, readRuntimeCitedMissionReceipts, readRuntimeMissionProgress, receiveRuntimeMissionHumanInput, recordRuntimeMissionHumanEvaluation, recoverRuntimeCompletedParallelApproaches, resolveRuntimeCitedApproval, resolveRuntimeMissionApproval, searchRuntimeArtifacts, type RuntimeCitedApproval, type RuntimeMissionApproval, type RuntimeMissionHumanInputRequest, type RuntimeMissionHumanInputValue, type RuntimeMissionProgress } from "../runtime";
import { ConnectorIcon } from "../components/ConnectorIcon";
import { CitationResults, CitedApprovalCard, DirectiveCards, MissionEffectApprovalCard, MissionHumanInputCard, MissionPlanSummary, MissionPlanUnavailable, MissionProgressSummary, MissionRunReceipt, NewCitedMissionAction, ParallelMissionPlanSummary, ProviderRouteSummary, RunContextSummary, citationsForRun, type MissionHumanInputArtifactOption } from "../components/workspace-cards";
import { tabs as settingsTabs } from "../components/pages/settings-tabs";
import type { SettingsTab } from "../components/pages/settings-tabs";
import { composerModelsFor } from "./composer-models";
import { ShellPageBoundary } from "./ShellRoutes";
import { useShellAgentController } from "./useShellAgentController";
import { useProjects } from "../hooks/useProjects";
import { invitationAccountContextKey } from "../lib/invitation-account-context";
import type { ProjectKnowledgeSourceView, ProjectKnowledgeView, ProjectMemoryView } from "../components/pages/ProjectPage";
import { useProjectKnowledge } from "../hooks/useProjectKnowledge";
import { useProjectMemory } from "../hooks/useProjectMemory";
import { useProjectActivity } from "../hooks/useProjectActivity";
import { useModalFocusTrap } from "../hooks/useModalFocusTrap";
import { toSlug } from "../lib/helpers";
import { agentExecutionInstructions, suggestTeammateName } from "../lib/agent-learning";
import { useMissionWorkspaceState } from "./chat-workspace/useMissionWorkspaceState";

type ConversationMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  runId?: string;
  missionReceipt?: CitedBriefMissionReceipt;
  missionPlan?: CitedBriefMissionPlanSummary;
  parallelMissionPlan?: ParallelApproachesPlanSummary;
  missionProgress?: RuntimeMissionProgress;
  missionKind?: "cited-brief" | "structured-intake" | "artifact-revision-brief" | "parallel-approaches" | "general";
  missionOutcome?: "accepted" | "completed" | "partial" | "failed" | "cancelled" | "awaiting-approval" | "awaiting-review";
  missionArtifactId?: string;
  approvalRunId?: string;
  action?: "connect-provider";
};

function messageId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function compactThreadTime(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

// Standalone pages are code-split: each is only rendered when navigated to, so
// loading them lazily keeps the initial workspace bundle small. Named exports
// are adapted to the lazy() default-export contract via `.then`. Suspense
// fallbacks are minimal (no layout shift) - the heaviest of these (Settings)
// pulls in Run History, Schedule panel, and provider rendering on demand.
const ConversationMessageActions = lazy(() =>
  import("../components/ConversationMessageActions").then((module) => ({
    default: module.ConversationMessageActions
  }))
);

const OnboardingPage = lazy(() =>
  import("../components/pages/OnboardingPage").then((m) => ({ default: m.OnboardingPage }))
);
const SettingsPage = lazy(() =>
  import("../components/pages/SettingsPage").then((m) => ({ default: m.SettingsPage }))
);
const WorkspaceSettingsView = lazy(() =>
  import("../components/pages/SettingsPage").then((m) => ({ default: m.WorkspaceSettingsView }))
);
const ApprovalPanel = lazy(() =>
  import("../components/ApprovalPanel").then((m) => ({ default: m.ApprovalPanel }))
);
const ProjectPage = lazy(() =>
  import("../components/pages/ProjectPage").then((m) => ({ default: m.ProjectPage }))
);

/**
 * Root composition for the Fable desktop shell.
 *
 * useShellRuntime owns runtime/data state and effects. This component owns
 * shell-local UI state (collection expansion, the account popover, tool/command
 * picker visibility) and routes between chat views and the standalone
 * Connectors / Knowledge / Schedules pages. The composer renders only on chat
 * views.
 */

/** Presentation and interaction boundary for the active desktop workspace. */
export function ChatWorkspace() {
  // The shared approval gate: the shell's grant/deny decisions resolve it, and
  // the agent-loop executor awaits it. Created once before the hooks so both
  // useShellRuntime (dispatch on grant/deny) and useNativeAgent (executor awaits
  // it) share the same instance - a grant in the approval UI drives the tool call
  // the loop is currently blocked on.
  const [selectedConversationThreadId, setSelectedConversationThreadId] = useState<string>();
  const selectedConversationThreadIdRef = useRef<string | undefined>(undefined);
  selectedConversationThreadIdRef.current = selectedConversationThreadId;
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const controller = useShellAgentController({ onDictation: addDictationToComposer, onVoiceCancel: focusComposerAfterVoice, threadId: selectedConversationThreadId });
  const { runtime, agent, durableConversation, voice, hostedComputer, hostedBrowser, scheduledActive, citedMissionRunning, runCitedBrief, stopCurrentWork, resetCancellation } = controller;
  const activeAgent = runtime.agents.find((candidate) => candidate.id === runtime.activeAgentId) ?? runtime.agents[0]!;
  const [liveRailOpen, setLiveRailOpen] = useState(false);
  const [teamMissionOpen, setTeamMissionOpen] = useState(false);
  const [learningDialog, setLearningDialog] = useState<{
    mode: "manage" | "teach";
    source: AgentLearningSource | null;
  } | null>(null);
  const [agentEditorOpen, setAgentEditorOpen] = useState(false);
  const [workspaceSearchOpen, setWorkspaceSearchOpen] = useState(false);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [agentPreviewMessages, setAgentPreviewMessages] = useState<Record<string, string>>({});
  const [conversationMessages, setConversationMessages] = useState<ConversationMessage[]>([]);
  const {
    hydratedMissionReceipts, setHydratedMissionReceipts,
    hydratedMissionPlans, setHydratedMissionPlans,
    threadArtifacts, setThreadArtifacts,
    pendingCitedApprovals, setPendingCitedApprovals,
    approvalListWarning, setApprovalListWarning,
    approvalBusyRunId, setApprovalBusyRunId,
    approvalErrors, setApprovalErrors,
    pendingMissionApprovals, setPendingMissionApprovals,
    missionApprovalListWarning, setMissionApprovalListWarning,
    missionApprovalBusyRunId, setMissionApprovalBusyRunId,
    missionApprovalErrors, setMissionApprovalErrors,
    pendingMissionInputs, setPendingMissionInputs,
    missionInputListWarning, setMissionInputListWarning,
    missionInputBusyRunId, setMissionInputBusyRunId,
    missionInputErrors, setMissionInputErrors,
    missionInputArtifactOptions, setMissionInputArtifactOptions,
    pendingMissionProgress, setPendingMissionProgress,
    threadMissionProgress, setThreadMissionProgress,
    threadMissionProgressWarning, setThreadMissionProgressWarning,
    missionReviewState, setMissionReviewState,
    parallelMissionRunning, setParallelMissionRunning,
    parallelMissionCancellationRef,
    generalMissionRunning, setGeneralMissionRunning,
    generalMissionCancellationRef
  } = useMissionWorkspaceState();
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [submissionInFlight, setSubmissionInFlight] = useState(false);
  const [newMissionSourceMessageId, setNewMissionSourceMessageId] = useState<string | null>(null);
  const [newThreadProjectId, setNewThreadProjectId] = useState<string | null>(null);
  const [pendingProjectMissionRerun, setPendingProjectMissionRerun] = useState<{
    threadId: string;
    sourceCommand: string;
    sourceMessageId: string;
  } | null>(null);
  const draftHydrationKey = useRef<string | null>(null);
  const missionReceiptHydrationKey = useRef<string | null>(null);
  const missionReceiptHydrationRequestKey = useRef<string | null>(null);
  const missionPlanHydrationKey = useRef<string | null>(null);
  const missionPlanHydrationRequestKey = useRef<string | null>(null);
  const newMissionLaunchRef = useRef<string | null>(null);
  const nativeInputMissionStartingRef = useRef(false);
  const parallelRecoveryWorkspaceRef = useRef<string | null>(null);
  const optimisticMissionInputRunIds = useRef(new Set<string>());
  const activeAssistantMessageId = useRef<string | null>(null);
  const conversationScrollRef = useRef<HTMLDivElement | null>(null);
  const hydratedConversation = durableConversation.state.conversation;
  const boundWorkspaceId =
    runtime.accountWorkspaceStatus.accountBound &&
    (runtime.accountWorkspaceStatus.state === "ready" ||
      runtime.accountWorkspaceStatus.state === "offline")
      ? runtime.accountWorkspaceStatus.activeWorkspace.localWorkspaceId
      : null;
  const artifactInputHydrationKey = `${boundWorkspaceId ?? "unbound"}|${pendingMissionInputs
    .filter((request) => request.fields.some((field) => field.kind === "artifact"))
    .map((request) => `${request.runId}:${request.projectId ?? "workspace"}:${request.runRevision}`)
    .sort()
    .join("|")}`;
  const projectStore = useProjects(boundWorkspaceId);
  const liveMissionProgress = useMemo(() => {
    const optimistic = [...conversationMessages]
      .reverse()
      .find((message) => message.missionProgress)?.missionProgress;
    if (optimistic && !["complete", "cancelled"].includes(optimistic.state)) return optimistic;
    return [...threadMissionProgress]
      .reverse()
      .find((entry) => !["complete", "cancelled"].includes(entry.progress.state))?.progress;
  }, [conversationMessages, threadMissionProgress]);
  const conversationWorkspaceId = useRef<string | null>(boundWorkspaceId);
  const workspaceName = runtime.accountWorkspaceStatus.activeWorkspace.name || "Fable workspace";
  // Account identity and native ownership can settle at different moments.
  // Include both boundaries so either A->B transition clears A immediately;
  // workspace selection is deliberately absent so same-user switches stay put.
  const invitationContextKey = invitationAccountContextKey({
    provider: runtime.identityStatus.authentication?.provider,
    normalizedIssuer: runtime.identityStatus.authentication?.normalizedIssuer,
    subject: runtime.identityStatus.authentication?.subject,
    identityState: runtime.identityStatus.state,
    internalUserId: runtime.accountWorkspaceStatus.activeContextOwner?.internalUserId,
    accountState: runtime.accountWorkspaceStatus.state
  });
  const verifiedProfile = useMemo(() => {
    const display = runtime.identityStatus.authentication?.verifiedDisplayAttributes;
    return { name: display?.displayName ?? display?.email ?? "Fable account", email: display?.email ?? "" };
  }, [runtime.identityStatus.authentication]);
  // Re-sync the shell's standing grants into the gate so session/rule grants
  // auto-satisfy matching tool calls without re-prompting.
  // The real executor: awaits the gate, then runs the granted tool through the
  // Rust boundary (which re-validates the approval and performs the side effect).
  // Cooperative cancellation: a cancel flag the agent hook's shouldCancel reads.
  // The cancel() path flips it true so an in-flight loop bails between events;
  // the real-Rust cancel (cancelRuntimeCompletion) still drops the socket. This
  // is the cooperative layer on top of the Rust boundary drop.
  const [expandedCollections, setExpandedCollections] = useState({
    projects: true,
    chats: true
  });
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({
    fable: true,
    site: false
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [toolPickerOpen, setToolPickerOpen] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const storedTheme = window.localStorage.getItem("fable-theme");
    if (storedTheme === "light" || storedTheme === "dark") {
      return storedTheme;
    }

    return "light";
  });

  useEffect(() => {
    window.localStorage.setItem("fable-theme", theme);
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const [previousActiveItem, setPreviousActiveItem] = useState("new-chat");
  const [activeSettingsTab, setActiveSettingsTab] = useState<SettingsTab>("general");
  const [settingsModalSearch, setSettingsModalSearch] = useState("");
  const settingsModalRef = useRef<HTMLElement>(null);
  const settingsSearchRef = useRef<HTMLInputElement>(null);
  const [workspaceSettingsOpen, setWorkspaceSettingsOpen] = useState(false);
  const [workspaceSettingsStatus, setWorkspaceSettingsStatus] = useState("");
  const workspaceSettingsModalRef = useRef<HTMLElement>(null);
  const workspaceSettingsCloseRef = useRef<HTMLButtonElement>(null);
  const workspaceSelectorButtonRef = useRef<HTMLButtonElement>(null);
  const navigationHistory = useRef([runtime.activeItem]);
  const navigationTarget = useRef<string | null>(null);
  const [navigationIndex, setNavigationIndex] = useState(0);
  const isSettingsActive = runtime.activePage === "Settings" || runtime.activePage === "Profile";
  const closeSettingsModal = () => {
    if (navigationIndex > 0) {
      const nextIndex = navigationIndex - 1;
      const target = navigationHistory.current[nextIndex];
      if (target) {
        navigationTarget.current = target;
        setNavigationIndex(nextIndex);
        runtime.setActiveItem(target);
      }
    } else {
      runtime.setActiveItem(previousActiveItem);
    }
  };

  useModalFocusTrap({
    active: isSettingsActive,
    containerRef: settingsModalRef,
    initialFocusRef: settingsSearchRef,
    onClose: closeSettingsModal
  });
  const closeWorkspaceSettings = () => {
    setWorkspaceSettingsOpen(false);
    setWorkspaceSettingsStatus("");
  };
  useModalFocusTrap({
    active: workspaceSettingsOpen,
    containerRef: workspaceSettingsModalRef,
    initialFocusRef: workspaceSettingsCloseRef,
    returnFocusRef: workspaceSelectorButtonRef,
    onClose: closeWorkspaceSettings
  });

  useEffect(() => {
    if (boundWorkspaceId === null) {
      if (conversationWorkspaceId.current === null) {
        return;
      }

      void agent.cancel();
      setSelectedConversationThreadId(undefined);
      setSelectedProjectId(null);
      setNewThreadProjectId(null);
      activeAssistantMessageId.current = null;
      setConversationMessages([]);
      navigationHistory.current = [runtime.activeItem];
      setNavigationIndex(0);
      conversationWorkspaceId.current = null;
      return;
    }

    // Establishing the first authoritative workspace is hydration, not a switch.
    // Clearing here would cancel recovery work started while account status loads.
    if (conversationWorkspaceId.current === null) {
      conversationWorkspaceId.current = boundWorkspaceId;
      return;
    }

    if (conversationWorkspaceId.current !== boundWorkspaceId) {
      void agent.cancel();
      setSelectedConversationThreadId(undefined);
      setSelectedProjectId(null);
      setNewThreadProjectId(null);
      activeAssistantMessageId.current = null;
      setConversationMessages([]);
      navigationHistory.current = [runtime.activeItem];
      setNavigationIndex(0);
      conversationWorkspaceId.current = boundWorkspaceId;
    }
  }, [agent.cancel, boundWorkspaceId, runtime.activeItem]);

  useEffect(() => {
    const recoveryBackend = agent.backend;
    const recoveryKey = boundWorkspaceId && recoveryBackend
      ? `${boundWorkspaceId}:${recoveryBackend.providerId}`
      : null;
    if (!recoveryKey || !recoveryBackend || recoveryBackend.backend.backendType !== "native-api"
      || parallelRecoveryWorkspaceRef.current === recoveryKey
      || parallelRecoveryWorkspaceRef.current === `pending:${recoveryKey}`) return;
    const pendingKey = `pending:${recoveryKey}`;
    parallelRecoveryWorkspaceRef.current = pendingKey;
    const sourceThreadId = selectedConversationThreadIdRef.current;
    let active = true;
    const recover = async () => {
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const { resumeReviewedParallelApproachesMissions } = await import("../lib/parallel-approaches-mission");
          const reviewed = await resumeReviewedParallelApproachesMissions({
            backend: recoveryBackend,
            onCancellationReady: (cancel) => {
              parallelMissionCancellationRef.current = cancel;
              setParallelMissionRunning(Boolean(cancel));
            }
          });
          const terminal = await recoverRuntimeCompletedParallelApproaches();
          return { terminal, changed: reviewed.finalized > 0 || Boolean(terminal?.length) };
        } catch (error) {
          lastError = error;
          if (attempt < 2) await new Promise((resolve) => window.setTimeout(resolve, 100 * (attempt + 1)));
        }
      }
      throw lastError;
    };
    void recover().then(async ({ changed }) => {
      if (!active) return;
      parallelRecoveryWorkspaceRef.current = recoveryKey;
      parallelMissionCancellationRef.current = null;
      setParallelMissionRunning(false);
      if (!changed || !sourceThreadId || selectedConversationThreadIdRef.current !== sourceThreadId) return;
      await durableConversation.refresh();
      if (selectedConversationThreadIdRef.current !== sourceThreadId) return;
      const artifacts = await listRuntimeThreadArtifacts(sourceThreadId);
      if (selectedConversationThreadIdRef.current === sourceThreadId) setThreadArtifacts(artifacts);
    }).catch(() => {
      parallelMissionCancellationRef.current = null;
      setParallelMissionRunning(false);
      if (active && parallelRecoveryWorkspaceRef.current === pendingKey) {
        parallelRecoveryWorkspaceRef.current = null;
      }
    });
    return () => { active = false; };
  }, [agent.backend, boundWorkspaceId, durableConversation.refresh]);

  useEffect(() => {
    if (navigationTarget.current === runtime.activeItem) {
      navigationTarget.current = null;
    } else if (navigationHistory.current[navigationIndex] !== runtime.activeItem) {
      const nextHistory = navigationHistory.current.slice(0, navigationIndex + 1);
      nextHistory.push(runtime.activeItem);
      navigationHistory.current = nextHistory;
      setNavigationIndex(nextHistory.length - 1);
    }

    if (runtime.activeItem !== "Settings" && runtime.activeItem !== "Profile") {
      setPreviousActiveItem(runtime.activeItem);
    }
  }, [navigationIndex, runtime.activeItem]);

  useEffect(() => {
    if (runtime.activeItem === "Profile") {
      setActiveSettingsTab("general");
    }
    if (runtime.runHistoryJobId && runtime.activeItem === "Settings") {
      setActiveSettingsTab("history");
    }
  }, [runtime.activeItem, runtime.runHistoryJobId]);

  // Connected connectors shown on the home rail. Real provider marks only;
  // local-files is always available so it is not surfaced as a connector. If
  // nothing is connected, the rail renders nothing. Memoized so the rail and
  // the composer prop keep a stable reference across unrelated re-renders.
  const connectedConnectorCards = useMemo(
    () =>
      runtime.connectorManifests.filter(
        (connector) => connector.status === "connected" && connector.id !== "local-files"
      ),
    [runtime.connectorManifests]
  );
  const composerModels = useMemo(
    () => composerModelsFor(runtime.connectedAgentBackend?.id, runtime.modelOptions),
    [runtime.connectedAgentBackend?.id, runtime.modelOptions]
  );
  // The picker stores provider-qualified ids (for example `openai::gpt-5`),
  // while the agent backend must receive the provider's original model id
  // (`gpt-5`). Keep the two values distinct so model selection stays collision
  // safe without sending the UI key to a provider.
  const resolvedComposerModelOptionId = useMemo(() => {
    if (
      runtime.selectedModelId &&
      composerModels.some((model) => model.id === runtime.selectedModelId)
    ) {
      return runtime.selectedModelId;
    }
    return composerModels[0]?.id ?? runtime.resolvedModelOptionId;
  }, [composerModels, runtime.resolvedModelOptionId, runtime.selectedModelId]);
  const resolvedComposerModelId = useMemo(
    () =>
      composerModels.find((model) => model.id === resolvedComposerModelOptionId)?.modelId ??
      runtime.resolvedSelectedModelId,
    [composerModels, resolvedComposerModelOptionId, runtime.resolvedSelectedModelId]
  );

  const appendConversationMessage = (
    role: ConversationMessage["role"],
    content: string,
    metadata: Pick<ConversationMessage, "action"> = {}
  ) => {
    const id = messageId(role);
    setConversationMessages((current) => [...current, { id, role, content, ...metadata }]);
    return id;
  };

  const durableThreads = useMemo(
    () => durableConversation.state.threads.map((thread) => ({
      id: thread.id,
      title: thread.title,
      kind: thread.projectId ? "project" as const : "chat" as const,
      description: thread.projectId ? "Project conversation" : "Workspace conversation",
      updatedAt: thread.updatedAt,
      pinnedContextIds: []
    })),
    [durableConversation.state.threads]
  );

  useEffect(() => {
    runtime.selectModel(activeAgent.modelId);
    runtime.selectPermissionLabel(activeAgent.permissionLabel);
  }, [activeAgent.id, activeAgent.modelId, activeAgent.permissionLabel]);

  useEffect(() => {
    let current = true;
    const load = async () => {
      const entries = await Promise.all(runtime.agents.map(async (profile) => {
        if (!profile.threadId) return [profile.id, ""] as const;
        const messages = await listRuntimeConversationMessages(profile.threadId).catch(() => []);
        return [profile.id, messages.at(-1)?.currentRevision.content ?? ""] as const;
      }));
      if (current) setAgentPreviewMessages(Object.fromEntries(entries));
    };
    void load();
    return () => { current = false; };
  }, [durableConversation.state.threads, runtime.agents]);

  useEffect(() => {
    if (selectedConversationThreadId || !activeAgent.threadId) return;
    if (!durableThreads.some((thread) => thread.id === activeAgent.threadId)) return;
    setSelectedConversationThreadId(activeAgent.threadId);
    runtime.setActiveItem(activeAgent.id);
  }, [activeAgent.id, activeAgent.threadId, durableThreads, selectedConversationThreadId]);

  useEffect(() => {
    if (!selectedConversationThreadId || activeAgent.threadId === selectedConversationThreadId) return;
    runtime.updateAgent(activeAgent.id, { threadId: selectedConversationThreadId });
  }, [activeAgent.id, activeAgent.threadId, selectedConversationThreadId]);
  const standaloneThreads = useMemo(
    () => durableThreads.filter((thread) => thread.kind === "chat"),
    [durableThreads]
  );
  const projectWorkspaces = useMemo(
    () => projectStore.projects.map((project) => ({
      ...project,
      description: project.description ?? "",
      instructions: project.instructions ?? "",
      lifecycle: "active" as const,
      threads: durableThreads.filter((thread) =>
        durableConversation.state.threads.some((record) => record.id === thread.id && record.projectId === project.id)
      )
    })),
    [durableConversation.state.threads, durableThreads, projectStore.projects]
  );
  const archivedProjectWorkspaces = useMemo(
    () => projectStore.archivedProjects.map((project) => ({
      ...project,
      description: project.description ?? "",
      instructions: project.instructions ?? "",
      lifecycle: "archived" as const,
      threads: durableThreads.filter((thread) =>
        durableConversation.state.threads.some(
          (record) => record.id === thread.id && record.projectId === project.id
        )
      )
    })),
    [durableConversation.state.threads, durableThreads, projectStore.archivedProjects]
  );
  const selectedProject = useMemo(
    () => selectedProjectId
      ? [...projectWorkspaces, ...archivedProjectWorkspaces].find((project) => project.id === selectedProjectId) ?? null
      : null,
    [archivedProjectWorkspaces, projectWorkspaces, selectedProjectId]
  );
  const runProjectId = useMemo(() => {
    if (newThreadProjectId) return newThreadProjectId;
    if (!selectedConversationThreadId) return null;
    return durableConversation.state.threads.find((thread) => thread.id === selectedConversationThreadId)?.projectId ?? null;
  }, [durableConversation.state.threads, newThreadProjectId, selectedConversationThreadId]);
  const scopedProjectId = selectedProjectId ?? runProjectId;
  const scopedProject = scopedProjectId
    ? [...projectWorkspaces, ...archivedProjectWorkspaces].find((project) => project.id === scopedProjectId) ?? null
    : null;
  const projectKnowledge = useProjectKnowledge({
    workspaceId: boundWorkspaceId ?? "",
    projectId: scopedProjectId ?? "",
    enabled: Boolean(boundWorkspaceId && scopedProjectId && scopedProject)
  });
  const projectKnowledgeView = useMemo<ProjectKnowledgeView>(() => ({
    sources: projectKnowledge.sources.map((source: ProjectKnowledgeSourceView) => ({
      id: source.id,
      title: source.title,
      provenance: source.provenance,
      freshness: source.freshness,
      status: source.status,
      statusMessage: source.statusMessage,
      disabled: Boolean(source.disabled)
    })),
    loading: projectKnowledge.loading,
    error: projectKnowledge.error,
    actionStatus: projectKnowledge.actionStatus,
    refresh: projectKnowledge.refresh,
    importFile: projectKnowledge.importFile,
    searchConnection: projectKnowledge.searchConnection,
    importConnectionItem: projectKnowledge.importConnectionItem,
    toggleDisabled: projectKnowledge.toggleDisabled,
    remove: projectKnowledge.remove,
    updateFile: projectKnowledge.updateFile,
    search: async (query: string) => {
      const result = await projectKnowledge.search(query);
      return result.citations.map((citation: KnowledgeCitation) => ({
        id: citation.sourceId,
        title: citation.title,
        provenance: citation.provenance,
        freshness: citation.freshness
      }));
    }
  }), [projectKnowledge.actionStatus, projectKnowledge.error, projectKnowledge.importConnectionItem, projectKnowledge.importFile, projectKnowledge.loading, projectKnowledge.refresh, projectKnowledge.remove, projectKnowledge.search, projectKnowledge.searchConnection, projectKnowledge.sources, projectKnowledge.toggleDisabled, projectKnowledge.updateFile]);
  const projectMemory = useProjectMemory({
    workspaceId: boundWorkspaceId ?? "",
    projectId: scopedProjectId ?? "",
    enabled: Boolean(boundWorkspaceId && scopedProjectId && scopedProject)
  });
  const projectMemoryView = useMemo<ProjectMemoryView>(() => ({
    records: projectMemory.records.map((record) => ({
      id: record.id,
      title: record.title,
      value: record.value,
      source: record.provenance?.note || record.source,
      freshness: record.freshness,
      pinned: record.pinned,
      disabled: Boolean(record.disabled)
    })),
    disabled: projectMemory.disabled,
    loading: projectMemory.loading,
    error: projectMemory.error,
    refresh: projectMemory.refresh,
    promote: async (sourceId: string) => {
      const source = projectKnowledge.liveSources.find((candidate) => candidate.id === sourceId);
      if (!source) throw new Error("That knowledge source is no longer available.");
      return projectMemory.promote(source);
    },
    edit: projectMemory.edit,
    togglePin: projectMemory.togglePin,
    toggleDisabled: projectMemory.toggleDisabled,
    forget: projectMemory.forget,
    exportText: projectMemory.exportText
  }), [projectKnowledge.liveSources, projectMemory.disabled, projectMemory.edit, projectMemory.error, projectMemory.exportText, projectMemory.forget, projectMemory.loading, projectMemory.promote, projectMemory.records, projectMemory.refresh, projectMemory.toggleDisabled, projectMemory.togglePin]);
  const projectActivity = useProjectActivity({
    workspaceId: boundWorkspaceId ?? "",
    projectId: selectedProject?.id ?? "",
    connectionIds: selectedProject?.connectionIds ?? [],
    threads: selectedProject?.threads ?? [],
    enabled: Boolean(boundWorkspaceId && selectedProject)
  });

  useEffect(() => {
    if (selectedProjectId && !projectStore.loading && !selectedProject) {
      setSelectedProjectId(null);
    }
  }, [projectStore.loading, selectedProject, selectedProjectId]);

  const citedMissionMessages = hydratedConversation?.messages.filter(({ message }) =>
    message.kind === "assistant"
      && message.detail?.type === "mission-result"
      && (message.detail.missionKind === undefined || message.detail.missionKind === "cited-brief")
      && (message.detail.outcome === "accepted" || message.detail.outcome === "partial")
  ) ?? [];
  const terminalCitedMissionMessages = hydratedConversation?.messages.filter(({ message }) =>
    message.kind === "assistant"
      && message.detail?.type === "mission-result"
      && (message.detail.missionKind === undefined || message.detail.missionKind === "cited-brief")
      && (message.detail.outcome === "accepted" || message.detail.outcome === "partial"
        || message.detail.outcome === "failed" || message.detail.outcome === "cancelled")
  ) ?? [];
  const activeMissionReceiptHydrationKey = selectedConversationThreadId
    && hydratedConversation?.thread.id === selectedConversationThreadId
    && citedMissionMessages.length > 0
    ? `${invitationContextKey}:${boundWorkspaceId ?? "unbound"}:${hydratedConversation.thread.id}:${citedMissionMessages
      .map(({ message }) => `${message.id}:${message.currentRevisionId}`)
      .join("|")}`
    : "";
  const activeMissionPlanHydrationKey = selectedConversationThreadId
    && hydratedConversation?.thread.id === selectedConversationThreadId
    && terminalCitedMissionMessages.length > 0
    ? `${invitationContextKey}:${boundWorkspaceId ?? "unbound"}:${hydratedConversation.thread.id}:${terminalCitedMissionMessages
      .map(({ message }) => `${message.id}:${message.currentRevisionId}`)
      .join("|")}`
    : "";

  useEffect(() => {
    const hydrated = durableConversation.state.conversation;
    if (!selectedConversationThreadId || !hydrated || hydrated.thread.id !== selectedConversationThreadId) {
      return;
    }
    // A new cited mission launched from a hydrated terminal result owns an
    // optimistic exchange until that fresh mission settles. The prior durable
    // snapshot must not erase it merely because the local message count changed.
    if (newMissionLaunchRef.current) return;
    // A freshly created thread hydrates before its serialized run writer has
    // appended the first records. Do not let that valid-but-stale empty read
    // erase the optimistic first exchange; explicit thread selection already
    // clears the feed before hydration, so this cannot leak another thread.
    if (hydrated.messages.length === 0 && conversationMessages.length > 0) return;
    setConversationMessages(hydrated.messages.map(({ message, currentRevision }) => {
      const missionResult = message.kind === "assistant" && message.detail?.type === "mission-result"
        ? message.detail
        : undefined;
      return {
        id: message.id,
        role: message.kind === "user" ? "user" : "assistant",
        content: currentRevision.state === "redacted" ? "This message was removed." : currentRevision.content,
        runId: message.kind === "assistant" ? message.runId : undefined,
        ...(missionResult ? {
          missionOutcome: missionResult.outcome,
          ...(missionResult.missionKind ? { missionKind: missionResult.missionKind } : {}),
          ...(missionResult.missionKind === "parallel-approaches" && isParallelApproachesPlanSummary(missionResult.plan)
            ? { parallelMissionPlan: missionResult.plan }
            : {}),
          ...(missionResult.outcome === "accepted" || missionResult.outcome === "completed"
            ? { missionArtifactId: missionResult.artifactId }
            : {})
        } : {})
      };
    }));
  }, [conversationMessages.length, durableConversation.state.conversation, selectedConversationThreadId]);

  useEffect(() => {
    const hydrated = hydratedConversation;
    if (!hydrated || !activeMissionReceiptHydrationKey) return;
    const missionMessages = citedMissionMessages;
    const hydrationKey = activeMissionReceiptHydrationKey;
    if (
      missionReceiptHydrationKey.current === hydrationKey
      || missionReceiptHydrationRequestKey.current === hydrationKey
    ) return;
    missionReceiptHydrationRequestKey.current = hydrationKey;
    let active = true;
    const batches = Array.from(
      { length: Math.ceil(missionMessages.length / 32) },
      (_, index) => missionMessages.slice(index * 32, index * 32 + 32).map(({ message }) => message.id)
    );
    void Promise.all(batches.map((messageIds) =>
      readRuntimeCitedMissionReceipts(hydrated.thread.id, messageIds)
    )).then((results) => {
      if (!active) return;
      missionReceiptHydrationRequestKey.current = null;
      missionReceiptHydrationKey.current = hydrationKey;
      const receipts = new Map(results
        .flatMap((result) => result ?? [])
        .flatMap((result) => result.status === "available" && isCitedBriefMissionReceipt(result.receipt)
          ? [[result.messageId, result.receipt] as const]
          : []));
      setHydratedMissionReceipts({
        key: hydrationKey,
        receipts: Object.fromEntries(receipts)
      });
    }).catch(() => {
      if (active && missionReceiptHydrationRequestKey.current === hydrationKey) {
        missionReceiptHydrationRequestKey.current = null;
      }
    });
    return () => {
      active = false;
      if (missionReceiptHydrationRequestKey.current === hydrationKey) {
        missionReceiptHydrationRequestKey.current = null;
      }
    };
  }, [activeMissionReceiptHydrationKey]);

  useEffect(() => {
    const hydrated = hydratedConversation;
    if (!hydrated || !activeMissionPlanHydrationKey) return;
    const missionMessages = terminalCitedMissionMessages;
    const hydrationKey = activeMissionPlanHydrationKey;
    if (missionPlanHydrationKey.current === hydrationKey
      || missionPlanHydrationRequestKey.current === hydrationKey) return;
    missionPlanHydrationRequestKey.current = hydrationKey;
    let active = true;
    const batches = Array.from(
      { length: Math.ceil(missionMessages.length / 32) },
      (_, index) => missionMessages.slice(index * 32, index * 32 + 32).map(({ message }) => message.id)
    );
    void Promise.all(batches.map((messageIds) =>
      readRuntimeCitedMissionPlanSummaries(hydrated.thread.id, messageIds)
    )).then((results) => {
      if (!active) return;
      missionPlanHydrationRequestKey.current = null;
      missionPlanHydrationKey.current = hydrationKey;
      const plans = new Map(results
        .flatMap((result) => result ?? [])
        .flatMap((result) => result.status === "available" && isCitedBriefMissionPlanSummary(result.plan)
          ? [[result.messageId, result.plan] as const]
          : []));
      setHydratedMissionPlans({ key: hydrationKey, plans: Object.fromEntries(plans) });
    }).catch(() => {
      if (active && missionPlanHydrationRequestKey.current === hydrationKey) {
        missionPlanHydrationRequestKey.current = null;
      }
    });
    return () => {
      active = false;
      if (missionPlanHydrationRequestKey.current === hydrationKey) {
        missionPlanHydrationRequestKey.current = null;
      }
    };
  }, [activeMissionPlanHydrationKey]);

  useEffect(() => {
    let active = true;
    setThreadArtifacts([]);
    if (!selectedConversationThreadId) return () => { active = false; };
    void listRuntimeThreadArtifacts(selectedConversationThreadId)
      .then((artifacts) => { if (active) setThreadArtifacts(artifacts); })
      .catch(() => { if (active) setThreadArtifacts([]); });
    return () => { active = false; };
  }, [boundWorkspaceId, selectedConversationThreadId]);

  useEffect(() => {
    let active = true;
    setPendingCitedApprovals([]);
    setApprovalListWarning(null);
    if (!selectedConversationThreadId) return () => { active = false; };
    void listRuntimePendingCitedApprovals(selectedConversationThreadId)
      .then((result) => {
        if (!active) return;
        setPendingCitedApprovals(result.approvals);
        setApprovalListWarning(result.unavailableCount > 0 || result.truncated
          ? "Some pending approvals could not be shown. Fable left them untouched."
          : null);
      })
      .catch(() => {
        if (!active) return;
        setPendingCitedApprovals([]);
        setApprovalListWarning("Pending approvals are temporarily unavailable. Fable left them untouched.");
      });
    return () => { active = false; };
  }, [boundWorkspaceId, hydratedConversation?.messages.length, selectedConversationThreadId]);

  useEffect(() => {
    let active = true;
    setPendingMissionApprovals([]);
    setMissionApprovalListWarning(null);
    if (!selectedConversationThreadId) return () => { active = false; };
    void listRuntimePendingMissionApprovals(selectedConversationThreadId)
      .then((result) => {
        if (!active) return;
        setPendingMissionApprovals(result.approvals);
        setMissionApprovalListWarning(result.unavailableCount > 0 || result.truncated
          ? "Some mission action approvals could not be shown. Fable left them untouched."
          : null);
      })
      .catch(() => {
        if (!active) return;
        setPendingMissionApprovals([]);
        setMissionApprovalListWarning("Mission action approvals are temporarily unavailable. Fable left them untouched.");
      });
    return () => { active = false; };
  }, [boundWorkspaceId, hydratedConversation?.messages.length, selectedConversationThreadId]);

  useEffect(() => {
    let active = true;
    const requests = pendingMissionInputs.filter((request) =>
      request.sourceThreadId === selectedConversationThreadId
        && request.fields.some((field) => field.kind === "artifact")
    );
    setMissionInputArtifactOptions(Object.fromEntries(requests.map((request) => [request.runId, {
      loading: true,
      options: []
    }])));
    for (const request of requests) {
      void searchRuntimeArtifacts({
        ...(request.projectId ? { projectId: request.projectId as Spine.Primitives.ProjectId } : {}),
        limit: 100
      }).then((results) => {
        if (!active || selectedConversationThreadIdRef.current !== request.sourceThreadId) return;
        const options = results.map(({ artifact, currentVersion }) => ({
          artifactId: artifact.id,
          artifactVersionId: currentVersion.id,
          label: artifact.title,
          versionLabel: `Version ${currentVersion.version}`
        }));
        setMissionInputArtifactOptions((current) => ({
          ...current,
          [request.runId]: { loading: false, options }
        }));
      }).catch(() => {
        if (!active || selectedConversationThreadIdRef.current !== request.sourceThreadId) return;
        setMissionInputArtifactOptions((current) => ({
          ...current,
          [request.runId]: {
            loading: false,
            options: [],
            error: "Artifacts are temporarily unavailable. Fable left this mission waiting."
          }
        }));
      });
    }
    return () => { active = false; };
  }, [artifactInputHydrationKey, selectedConversationThreadId]);

  useEffect(() => {
    let active = true;
    const waits = [...pendingMissionInputs, ...pendingMissionApprovals]
      .filter((wait) => wait.sourceThreadId === selectedConversationThreadId);
    const runIds = [...new Set(waits.map((wait) => wait.runId))];
    setPendingMissionProgress(Object.fromEntries(
      runIds.map((runId) => [runId, { loading: true }])
    ));
    for (const runId of runIds) {
      void readRuntimeMissionProgress(runId)
        .then((progress) => {
          if (!active || selectedConversationThreadIdRef.current !== selectedConversationThreadId) return;
          setPendingMissionProgress((current) => ({
            ...current,
            [runId]: progress
              ? { loading: false, progress }
              : { loading: false, error: "Plan and progress are unavailable. Fable left this mission waiting." }
          }));
        })
        .catch(() => {
          if (!active || selectedConversationThreadIdRef.current !== selectedConversationThreadId) return;
          setPendingMissionProgress((current) => ({
            ...current,
            [runId]: {
              loading: false,
              error: "Plan and progress are unavailable. Fable left this mission waiting."
            }
          }));
        });
    }
    return () => { active = false; };
  }, [pendingMissionApprovals, pendingMissionInputs, selectedConversationThreadId]);

  useEffect(() => {
    let active = true;
    setThreadMissionProgress([]);
    setThreadMissionProgressWarning(null);
    if (!selectedConversationThreadId) return () => { active = false; };
    const sourceThreadId = selectedConversationThreadId;
    void listRuntimeThreadMissionProgress(sourceThreadId)
      .then((result) => {
        if (!active || selectedConversationThreadIdRef.current !== sourceThreadId) return;
        setThreadMissionProgress(result.progress);
        setThreadMissionProgressWarning(result.unavailableCount > 0 || result.truncated
          ? "Some Mission activity could not be shown. Fable left its durable records unchanged."
          : null);
      })
      .catch(() => {
        if (!active || selectedConversationThreadIdRef.current !== sourceThreadId) return;
        setThreadMissionProgress([]);
        setThreadMissionProgressWarning(
          "Mission activity is temporarily unavailable. Fable left its durable records unchanged."
        );
      });
    return () => { active = false; };
  }, [boundWorkspaceId, hydratedConversation?.messages.length, selectedConversationThreadId]);

  useEffect(() => {
    let active = true;
    setPendingMissionInputs((current) => current.filter((request) =>
      optimisticMissionInputRunIds.current.has(request.runId)
        && request.sourceThreadId === selectedConversationThreadId
    ));
    setMissionInputListWarning(null);
    if (!selectedConversationThreadId) return () => { active = false; };
    void listRuntimePendingMissionHumanInputs(selectedConversationThreadId)
      .then((result) => {
        if (!active) return;
        const listed = new Set(result.requests.map((request) => request.runId));
        for (const runId of listed) optimisticMissionInputRunIds.current.delete(runId);
        setPendingMissionInputs((current) => {
          const optimistic = current.filter((request) =>
            optimisticMissionInputRunIds.current.has(request.runId)
              && request.sourceThreadId === selectedConversationThreadId
              && !listed.has(request.runId)
          );
          return [...result.requests, ...optimistic];
        });
        setMissionInputListWarning(result.unavailableCount > 0 || result.truncated
          ? "Some mission input requests could not be shown. Fable left them untouched."
          : null);
      })
      .catch(() => {
        if (!active) return;
        setPendingMissionInputs((current) => current.filter((request) =>
          optimisticMissionInputRunIds.current.has(request.runId)
            && request.sourceThreadId === selectedConversationThreadId
        ));
        setMissionInputListWarning("Mission input requests are temporarily unavailable. Fable left them untouched.");
      });
    return () => { active = false; };
  }, [boundWorkspaceId, hydratedConversation?.messages.length, selectedConversationThreadId]);

  useEffect(() => {
    if (durableConversation.state.loading || submissionInFlight) return;
    if (draftHydrationKey.current === durableConversation.draftKey) return;
    draftHydrationKey.current = durableConversation.draftKey;
    if (durableConversation.state.draft) {
      runtime.setComposerValue(durableConversation.state.draft.content);
    }
  }, [durableConversation.draftKey, durableConversation.state.draft, durableConversation.state.loading, runtime.setComposerValue, submissionInFlight]);

  useEffect(() => {
    if (draftHydrationKey.current !== durableConversation.draftKey) return;
    const timer = window.setTimeout(() => {
      if (runtime.composerValue) void durableConversation.saveDraft(runtime.composerValue);
      else void durableConversation.deleteDraft();
    }, 250);
    return () => window.clearTimeout(timer);
  }, [durableConversation.deleteDraft, durableConversation.draftKey, durableConversation.saveDraft, runtime.composerValue]);

  useEffect(() => {
    if (!pendingPrompt || !selectedConversationThreadId) return;
    const prompt = pendingPrompt;
    setPendingPrompt(null);
    void continueComposerSubmission(prompt).finally(() => setSubmissionInFlight(false));
  }, [pendingPrompt, selectedConversationThreadId]);

  useEffect(() => {
    if (
      !pendingProjectMissionRerun
      || pendingProjectMissionRerun.threadId !== selectedConversationThreadId
    ) return;
    const rerun = pendingProjectMissionRerun;
    setPendingProjectMissionRerun(null);
    void startFreshGeneralMission(rerun.sourceCommand, rerun.sourceMessageId);
  }, [pendingProjectMissionRerun, selectedConversationThreadId]);

  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !agent.state.running) void durableConversation.refresh();
    wasRunning.current = agent.state.running;
  }, [agent.state.running, durableConversation.refresh]);

  useEffect(() => {
    const scrollRegion = conversationScrollRef.current;
    if (!scrollRegion) return;
    scrollRegion.scrollTop = scrollRegion.scrollHeight;
  }, [
    agent.state.running,
    conversationMessages,
    pendingCitedApprovals.length,
    pendingMissionApprovals.length,
    pendingMissionInputs.length,
    threadMissionProgress.length
  ]);

  useEffect(() => {
    const assistantId = activeAssistantMessageId.current;
    if (!assistantId) return;
    const fallback =
      agent.state.status === "awaiting-approval"
        ? "Waiting for approval."
        : agent.state.running
          ? "Working..."
          : agent.state.lastError
            ? agent.state.lastError
            : "";
    const content = agent.state.transcript || fallback;
    setConversationMessages((current) =>
      current.map((message) =>
        message.id === assistantId
          ? {
              ...message,
              content,
              ...(agent.state.currentRunId ? { runId: agent.state.currentRunId } : {})
            }
          : message
      )
    );
    if (!agent.state.running && agent.state.status !== "streaming" && agent.state.status !== "awaiting-approval") {
      activeAssistantMessageId.current = null;
    }
  }, [agent.state.currentRunId, agent.state.lastError, agent.state.running, agent.state.status, agent.state.transcript]);

  // Recoverable runs scoped to the active thread. Hoisted + memoized so the
  // agent panel does not re-filter the full recoverable list on every render
  // (agent text deltas re-render App frequently).
  const activeThreadId = runtime.activeThread?.id ?? runtime.activeItem;
  const visibleRecoverableRuns = useMemo(
    () =>
      agent.state.recoverableRuns.filter(
        (run) => !run.threadId || run.threadId === activeThreadId
      ),
    [agent.state.recoverableRuns, activeThreadId]
  );

  // The sidebar highlights the active item's spinner while an agent run is in
  // flight. Memoized so the prop keeps a stable array reference (the previous
  // inline ternary allocated a fresh array every render).
  const loadingItemIds = useMemo(
    () => (agent.state.running && runtime.activeItem ? [runtime.activeItem] : []),
    [agent.state.running, runtime.activeItem]
  );

  const resolveCitedApproval = async (approval: RuntimeCitedApproval, decision: "approved" | "denied") => {
    if (approvalBusyRunId) return;
    setApprovalBusyRunId(approval.runId);
    setApprovalErrors((current) => {
      const next = { ...current };
      delete next[approval.runId];
      return next;
    });
    try {
      await resolveRuntimeCitedApproval(approval, decision);
      setPendingCitedApprovals((current) => current.filter((entry) => entry.runId !== approval.runId));
      await durableConversation.refresh();
      if (selectedConversationThreadId) {
        const artifacts = await listRuntimeThreadArtifacts(selectedConversationThreadId);
        setThreadArtifacts(artifacts);
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Fable could not resolve this cited draft.";
      setApprovalErrors((current) => ({ ...current, [approval.runId]: message }));
    } finally {
      setApprovalBusyRunId(null);
    }
  };

  const submitMissionInput = async (
    request: RuntimeMissionHumanInputRequest,
    values: RuntimeMissionHumanInputValue[]
  ) => {
    if (missionInputBusyRunId) return;
    setMissionInputBusyRunId(request.runId);
    setMissionInputErrors((current) => {
      const next = { ...current };
      delete next[request.runId];
      return next;
    });
    try {
      await receiveRuntimeMissionHumanInput(request, values);
      optimisticMissionInputRunIds.current.delete(request.runId);
      setPendingMissionInputs((current) => current.filter((entry) => entry.runId !== request.runId));
      if (selectedConversationThreadIdRef.current === request.sourceThreadId) {
        await durableConversation.refresh();
        if (selectedConversationThreadIdRef.current !== request.sourceThreadId) return;
        const artifacts = await listRuntimeThreadArtifacts(request.sourceThreadId);
        if (selectedConversationThreadIdRef.current !== request.sourceThreadId) return;
        setThreadArtifacts(artifacts);
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Fable could not continue this mission.";
      setMissionInputErrors((current) => ({ ...current, [request.runId]: message }));
    } finally {
      setMissionInputBusyRunId(null);
    }
  };

  const resolveMissionApproval = async (
    approval: RuntimeMissionApproval,
    decision: "approved" | "denied"
  ) => {
    if (missionApprovalBusyRunId) return;
    setMissionApprovalBusyRunId(approval.runId);
    setMissionApprovalErrors((current) => {
      const next = { ...current };
      delete next[approval.runId];
      return next;
    });
    try {
      await resolveRuntimeMissionApproval(approval, decision);
      setPendingMissionApprovals((current) =>
        current.filter((entry) => entry.runId !== approval.runId));
      await durableConversation.refresh();
    } catch (cause) {
      const message = cause instanceof Error
        ? cause.message
        : "Fable could not save this Mission decision.";
      setMissionApprovalErrors((current) => ({ ...current, [approval.runId]: message }));
    } finally {
      setMissionApprovalBusyRunId(null);
    }
  };

  const recordMissionReview = async (
    progress: RuntimeMissionProgress,
    criterionKey: string,
    passed: boolean
  ) => {
    const review = progress.humanReview;
    if (!review || !review.criteria.some((criterion) => criterion.criterionKey === criterionKey)) {
      return;
    }
    if (missionReviewState[review.runId]?.busyCriterion) return;
    setMissionReviewState((current) => ({
      ...current,
      [review.runId]: { busyCriterion: criterionKey }
    }));
    try {
      await recordRuntimeMissionHumanEvaluation({
        runId: review.runId,
        criterionKey,
        passed,
        expectedRunRevision: review.expectedRunRevision,
        expectedLastSequence: review.expectedLastSequence
      });
      let nextProgress = await readRuntimeMissionProgress(review.runId);
      if (!nextProgress) {
        throw new Error("Mission progress is available only in the desktop app.");
      }
      if (!nextProgress.humanReview?.criteria.length) {
        const terminal = await finalizeRuntimeMissionCoordination(review.runId);
        if (terminal?.progress) nextProgress = terminal.progress;
        const threadId = selectedConversationThreadIdRef.current;
        if (threadId) {
          const artifacts = await listRuntimeThreadArtifacts(threadId);
          if (selectedConversationThreadIdRef.current === threadId) {
            setThreadArtifacts(artifacts);
          }
        }
      }
      setPendingMissionProgress((current) => current[review.runId]
        ? {
            ...current,
            [review.runId]: { loading: false, progress: nextProgress }
          }
        : current);
      setConversationMessages((current) => current.map((message) =>
        message.runId === review.runId
          || message.missionProgress?.humanReview?.runId === review.runId
          ? { ...message, missionProgress: nextProgress }
          : message
      ));
      setMissionReviewState((current) => {
        const next = { ...current };
        delete next[review.runId];
        return next;
      });
      await durableConversation.refresh().catch(() => undefined);
    } catch (cause) {
      const message = cause instanceof Error
        ? cause.message
        : "Fable could not save this Mission review.";
      setMissionReviewState((current) => ({
        ...current,
        [review.runId]: { error: message }
      }));
    }
  };

  const renderPendingMissionProgress = (runId: string) => {
    const state = pendingMissionProgress[runId];
    if (state?.progress) {
      return (
        <MissionProgressSummary
          progress={state.progress}
          reviewBusyCriterion={missionReviewState[runId]?.busyCriterion}
          reviewError={missionReviewState[runId]?.error}
          onReview={(criterionKey, passed) =>
            void recordMissionReview(state.progress!, criterionKey, passed)}
        />
      );
    }
    if (state?.error) {
      return <p className="conversation-feed__notice" role="status">{state.error}</p>;
    }
    return null;
  };

  const saveMessageToKnowledge = async (message: ConversationMessage) => {
    const firstLine = message.content
      .split(/\r?\n/, 1)[0]
      .replace(/^#+\s*/, "")
      .trim();
    const title = firstLine.slice(0, 72) || (
      message.role === "user" ? "Conversation prompt" : "Assistant response"
    );

    if (scopedProjectId) {
      const sourceName = `${toSlug(title).slice(0, 72)}.md`;
      await projectKnowledge.importFile(
        new File([message.content], sourceName, { type: "text/markdown" })
      );
      return;
    }

    const saved = await runtime.saveTextToKnowledge(title, message.content);
    if (!saved) throw new Error("Fable could not save this message to Knowledge.");
  };

  const renderConversation = () => {
    if (conversationMessages.length === 0 && pendingCitedApprovals.length === 0
      && pendingMissionApprovals.length === 0 && pendingMissionInputs.length === 0
      && threadMissionProgress.length === 0
      && !approvalListWarning && !missionApprovalListWarning && !missionInputListWarning
      && !threadMissionProgressWarning) return null;
    const linkedMissionRunIds = new Set([
      ...conversationMessages.flatMap((message) => message.runId ? [message.runId] : []),
      ...pendingMissionInputs.map((request) => request.runId),
      ...pendingMissionApprovals.map((approval) => approval.runId)
    ]);
    const unlinkedMissionProgress = threadMissionProgress.filter(
      (entry) => !linkedMissionRunIds.has(entry.runId)
    );
    return (
      <section className="conversation-feed" aria-label="Conversation">
        {conversationMessages.map((message, messageIndex) => {
          const citedApproval = message.approvalRunId
            ? pendingCitedApprovals.find((approval) => approval.runId === message.approvalRunId)
            : undefined;
          const missionReceipt = message.missionReceipt
            ?? (hydratedMissionReceipts.key === activeMissionReceiptHydrationKey
              ? hydratedMissionReceipts.receipts[message.id]
              : undefined);
          const missionPlan = message.missionPlan
            ?? (hydratedMissionPlans.key === activeMissionPlanHydrationKey
              ? hydratedMissionPlans.plans[message.id]
              : undefined);
          const missionPlanUnavailable = (message.missionKind === undefined || message.missionKind === "cited-brief")
            && !missionPlan && Boolean(message.missionOutcome)
            && hydratedMissionPlans.key === activeMissionPlanHydrationKey;
          const canStartNewMission = message.role === "assistant" && Boolean(missionPlan)
            && (message.missionOutcome === "partial" || message.missionOutcome === "failed"
              || message.missionOutcome === "cancelled");
          const newMissionBusy = citedMissionRunning || parallelMissionRunning || generalMissionRunning || agent.state.running || Boolean(pendingPrompt)
            || newMissionSourceMessageId !== null;
          const sourceRequest = [...conversationMessages.slice(0, messageIndex)]
            .reverse()
            .find((candidate) => candidate.role === "user");
          const isCurrentResponse =
            message.role === "assistant"
            && messageIndex === conversationMessages.length - 1
            && conversationWorking;
          const sourceCommand = sourceRequest ? parseComposerText(sourceRequest.content) : null;
          const existingArtifact = threadArtifacts.find((entry) =>
            entry.sourceMessageId === message.id
            || entry.artifact.id === message.missionArtifactId
            || (message.missionOutcome === "accepted" && entry.artifact.producingRunId === message.runId)
          );
          const durableMissionProgress = message.runId
            ? threadMissionProgress.find((entry) => entry.runId === message.runId)?.progress
            : undefined;
          const visibleMissionProgress = message.missionProgress ?? durableMissionProgress;
          const canStartNewGeneralMission =
            message.role === "assistant"
            && message.missionKind === "general"
            && sourceRequest !== undefined
            && sourceCommand?.status === "command"
            && sourceCommand.request.name === "mission"
            && visibleMissionProgress !== undefined
            && matchesTerminalGeneralRetryStatus(visibleMissionProgress.runStatus);
          const missionArtifacts = visibleMissionProgress && message.runId
            ? threadArtifacts.filter((entry) => entry.artifact.producingRunId === message.runId)
            : [];
          return (
            <article
              key={message.id}
              className={`conversation-message conversation-message--${message.role}${
                isCurrentResponse ? " conversation-message--working" : ""
              }`}
            >
              <div className="conversation-message__author">
                {message.role === "assistant" ? (
                  <ProfileAgentAvatar agent={activeAgent} iconSize={36} />
                ) : (
                  <span className="conversation-message__user-avatar">
                    {verifiedProfile.name.trim().slice(0, 1).toUpperCase() || "F"}
                  </span>
                )}
                <strong>{message.role === "assistant" ? activeAgent.name : verifiedProfile.name}</strong>
              </div>
              <p>{message.content}</p>
              {message.action === "connect-provider" ? (
                <button
                  type="button"
                  className="conversation-message__setup-action"
                  onClick={() => handleSelectSettingsTab("providers")}
                >
                  Connect a model
                </button>
              ) : null}
              {message.role === "user" || !isCurrentResponse ? (
                <Suspense fallback={null}>
                  <ConversationMessageActions
                    role={message.role}
                    content={message.content}
                    onSaveToKnowledge={() => saveMessageToKnowledge(message)}
                    onMakeRoutine={() => {
                      const title = message.content
                        .split(/\r?\n/, 1)[0]
                        .replace(/^#+\s*/, "")
                        .trim()
                        .slice(0, 72) || "Conversation routine";
                      runtime.openRoutineDraft({ title, instruction: message.content });
                    }}
                    onTeachTask={message.role === "assistant" && sourceRequest ? () => {
                      const sourcePrompt = sourceCommand?.status === "command"
                        ? sourceCommand.request.args.trim() || sourceRequest.content
                        : sourceRequest.content;
                      setLearningDialog({
                        mode: "teach",
                        source: { prompt: sourcePrompt, response: message.content }
                      });
                    } : undefined}
                    onEdit={message.role === "user" ? () => {
                      runtime.setComposerValue(message.content);
                      runtime.focusComposer(message.content);
                    } : undefined}
                    onRedo={message.role === "assistant" && sourceRequest ? () => {
                      if (conversationWorking) return;
                      runPrompt(sourceRequest.content, { appendUserMessage: false });
                    } : undefined}
                    redoDisabled={conversationWorking}
                  />
                </Suspense>
              ) : null}
              {message.role === "assistant" && missionPlan ? <MissionPlanSummary plan={missionPlan} /> : null}
              {message.role === "assistant" && message.parallelMissionPlan
                ? <ParallelMissionPlanSummary plan={message.parallelMissionPlan} />
                : null}
              {message.role === "assistant" && visibleMissionProgress
                ? <MissionProgressSummary
                    progress={visibleMissionProgress}
                    reviewBusyCriterion={visibleMissionProgress.humanReview
                      ? missionReviewState[visibleMissionProgress.humanReview.runId]?.busyCriterion
                      : undefined}
                    reviewError={visibleMissionProgress.humanReview
                      ? missionReviewState[visibleMissionProgress.humanReview.runId]?.error
                      : undefined}
                    onReview={(criterionKey, passed) =>
                      void recordMissionReview(visibleMissionProgress, criterionKey, passed)}
                  />
                : null}
              {message.role === "assistant" && missionArtifacts.length > 0 ? (
                <section aria-label="Mission saved work">
                  {missionArtifacts.map((entry) => (
                    <ResponseArtifactAction
                      key={entry.artifact.id}
                      existing={entry}
                      onSaved={(saved) => setThreadArtifacts((current) => [
                        ...current.filter((artifact) => artifact.artifact.id !== saved.artifact.id),
                        saved
                      ])}
                    />
                  ))}
                </section>
              ) : null}
              {message.role === "assistant" && missionPlanUnavailable ? <MissionPlanUnavailable /> : null}
              {message.role === "assistant" && missionReceipt ? <MissionRunReceipt receipt={missionReceipt} /> : null}
              {message.role === "assistant" && citedApproval ? (
                <CitedApprovalCard
                  requestedAt={citedApproval.requestedAt}
                  busy={approvalBusyRunId === citedApproval.runId}
                  error={approvalErrors[citedApproval.runId]}
                  onApprove={() => void resolveCitedApproval(citedApproval, "approved")}
                  onKeepDraft={() => void resolveCitedApproval(citedApproval, "denied")}
                />
              ) : null}
              {canStartNewMission && missionPlan ? (
                <NewCitedMissionAction
                  disabled={newMissionBusy}
                  starting={newMissionSourceMessageId === message.id}
                  onStart={() => runPrompt(missionPlan.summary, {
                    forceCitedMission: true,
                    newMissionSourceMessageId: message.id
                  })}
                />
              ) : null}
              {canStartNewGeneralMission && sourceRequest ? (
                <NewCitedMissionAction
                  disabled={newMissionBusy}
                  starting={newMissionSourceMessageId === message.id}
                  onStart={() => void startFreshGeneralMission(
                    sourceRequest.content,
                    message.id
                  )}
                />
              ) : null}
              {message.role === "assistant" && message.runId && agent.state.providerRoutes[message.runId] ? (
                <ProviderRouteSummary
                  route={agent.state.providerRoutes[message.runId]}
                  usage={agent.state.usageReceipts[message.runId]}
                />
              ) : null}
              {message.role === "assistant" && message.runId && agent.state.contextReceipts[message.runId] ? (
                <RunContextSummary receipt={agent.state.contextReceipts[message.runId]} />
              ) : null}
              {message.role === "assistant" && message.runId && message.content
                && missionArtifacts.length === 0
                && existingArtifact
                && !isCurrentResponse
                && (!message.missionOutcome || existingArtifact) ? (
                <ResponseArtifactAction
                  existing={existingArtifact}
                  onSaved={(saved) => setThreadArtifacts((current) => [...current.filter((entry) => entry.artifact.id !== saved.artifact.id), saved])}
                />
              ) : null}
            </article>
          );
        })}
        {pendingCitedApprovals
          .filter((approval) => !conversationMessages.some((message) => message.approvalRunId === approval.runId))
          .map((approval) => (
            <article key={approval.runId} className="conversation-message conversation-message--assistant">
              <p>{approval.draft}</p>
              {isCitedBriefMissionPlanSummary(approval.plan) ? <MissionPlanSummary plan={approval.plan} /> : <MissionPlanUnavailable />}
              <CitedApprovalCard
                requestedAt={approval.requestedAt}
                busy={approvalBusyRunId === approval.runId}
                error={approvalErrors[approval.runId]}
                onApprove={() => void resolveCitedApproval(approval, "approved")}
                onKeepDraft={() => void resolveCitedApproval(approval, "denied")}
              />
            </article>
          ))}
        {pendingMissionInputs.map((request) => (
          <article key={request.runId} className="conversation-message conversation-message--assistant">
            <MissionHumanInputCard
              prompt={request.prompt}
              fields={request.fields}
              requestedAt={request.requestedAt}
              busy={missionInputBusyRunId === request.runId}
              error={missionInputErrors[request.runId]}
              artifactOptions={missionInputArtifactOptions[request.runId]?.options}
              artifactOptionsLoading={missionInputArtifactOptions[request.runId]?.loading}
              artifactOptionsError={missionInputArtifactOptions[request.runId]?.error}
              onSubmit={(values) => void submitMissionInput(request, values)}
            />
            {renderPendingMissionProgress(request.runId)}
          </article>
        ))}
        {pendingMissionApprovals.map((approval) => (
          <article key={approval.runId} className="conversation-message conversation-message--assistant">
            <MissionEffectApprovalCard
              actionSummary={approval.actionSummary}
              targetSummary={approval.effect.targetSummary}
              requestedAt={approval.requestedAt}
              busy={missionApprovalBusyRunId === approval.runId}
              error={missionApprovalErrors[approval.runId]}
              onApprove={() => void resolveMissionApproval(approval, "approved")}
              onDeny={() => void resolveMissionApproval(approval, "denied")}
            />
            {renderPendingMissionProgress(approval.runId)}
          </article>
        ))}
        {unlinkedMissionProgress.map((entry) => (
          <article key={entry.runId} className="conversation-message conversation-message--assistant">
            <p>Mission activity</p>
            <MissionProgressSummary
              progress={entry.progress}
              reviewBusyCriterion={entry.progress.humanReview
                ? missionReviewState[entry.progress.humanReview.runId]?.busyCriterion
                : undefined}
              reviewError={entry.progress.humanReview
                ? missionReviewState[entry.progress.humanReview.runId]?.error
                : undefined}
              onReview={(criterionKey, passed) =>
                void recordMissionReview(entry.progress, criterionKey, passed)}
            />
          </article>
        ))}
        {approvalListWarning ? (
          <p className="conversation-feed__notice" role="status">{approvalListWarning}</p>
        ) : null}
        {missionApprovalListWarning ? (
          <p className="conversation-feed__notice" role="status">{missionApprovalListWarning}</p>
        ) : null}
        {missionInputListWarning ? (
          <p className="conversation-feed__notice" role="status">{missionInputListWarning}</p>
        ) : null}
        {threadMissionProgressWarning ? (
          <p className="conversation-feed__notice" role="status">{threadMissionProgressWarning}</p>
        ) : null}
      </section>
    );
  };

  const renderChatContext = () => {
    return (
      <>
        {connectedConnectorCards.length > 0 ? (
          <div className="connector-rail" aria-label="Connected connectors">
            {connectedConnectorCards.map((connector) => (
              <button
                key={connector.id}
                type="button"
                className={`connector-pill connector-pill--${connector.id}`}
                onClick={() => {
                  const prompt = `Use @${connector.id} to `;
                  runtime.setComposerValue(prompt);
                  runtime.focusComposer(prompt);
                }}
              >
                <ConnectorIcon id={connector.id} />
                <span>{connector.name}</span>
              </button>
            ))}
          </div>
        ) : null}
        {runtime.openApprovals.length > 0 ||
        runtime.editingApprovalId ||
        runtime.pendingApprovalConfirmation ||
        runtime.sessionApprovalGrants.length > 0 ||
        runtime.approvalRules.length > 0 ? (
          <Suspense fallback={null}>
            <ApprovalPanel
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
        ) : null}
        {runtime.knowledgeCitations.length > 0 ? (
          <CitationResults citations={runtime.knowledgeCitations} mode={runtime.knowledgeSearchMode} />
        ) : null}
        {runtime.importStatus ? (
          <DirectiveCards
            directives={runtime.contextualDirectives}
            connectors={connectors}
            onUseDirective={runtime.useDirective}
          />
        ) : null}
        {visibleRecoverableRuns.length > 0 ? (
          <section className="agent-panel" aria-label="Interrupted responses">
            {visibleRecoverableRuns.map((run) => (
              <div className="agent-panel__recovery" key={run.id}>
                <p>
                  {run.status === "interrupted" ? "Interrupted" : "Failed"} run · {run.model}
                  {run.transcript ? ` · ${run.transcript.slice(0, 120)}` : ""}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    activeAssistantMessageId.current = appendConversationMessage("assistant", "Working...");
                    void agent.retry(run);
                  }}
                >
                  Retry from prompt
                </button>
              </div>
            ))}
          </section>
        ) : null}
      </>
    );
  };

  const liveStatusLead = /[.!?]$/.test(runtime.lastAction)
    ? runtime.lastAction
    : `${runtime.lastAction}.`;
  const conversationIsActive = Boolean(
    selectedConversationThreadId || conversationMessages.length > 0
  );
  const conversationWorking = Boolean(
    citedMissionRunning ||
    parallelMissionRunning ||
    generalMissionRunning ||
    agent.state.running
  );
  const conversationSubmissionBlocked = conversationWorking || Boolean(pendingPrompt);
  const agentSidebarPreviews = useMemo<Record<string, AgentSidebarPreview>>(() => {
    return Object.fromEntries(runtime.agents.map((profile) => {
      const thread = profile.threadId
        ? durableThreads.find((candidate) => candidate.id === profile.threadId)
        : undefined;
      const currentMessage = profile.id === activeAgent.id
        ? [...conversationMessages].reverse().find((message) => message.content.trim() && message.content !== "Working...")?.content
        : undefined;
      const message = currentMessage || agentPreviewMessages[profile.id] || "Start a conversation";
      const status: AgentSidebarPreview["status"] = profile.id === activeAgent.id && runtime.openApprovals.length > 0
        ? "attention"
        : profile.id === activeAgent.id && conversationWorking
          ? "running"
          : "idle";
      return [profile.id, { message, time: compactThreadTime(thread?.updatedAt), status }];
    }));
  }, [activeAgent.id, agentPreviewMessages, conversationMessages, conversationWorking, durableThreads, runtime.agents, runtime.openApprovals.length]);
  // Label for the model chip: the selected model's friendly label, or a
  // placeholder when no model is selected/available on the connected backend.
  // Memoized so the composer's chip prop keeps a stable primitive unless the
  // model selection actually changes.
  const modelChipLabel = useMemo(
    () =>
      composerModels.find((model) => model.id === resolvedComposerModelOptionId)?.label ??
      "Select model",
    [composerModels, resolvedComposerModelOptionId]
  );
  const workspaceSearchItems = useMemo<WorkspaceSearchItem[]>(() => [
    {
      id: "schedules-page",
      scope: "work" as const,
      action: "schedule" as const,
      title: "Schedules",
      description: "Manage local routines and always-on cloud work",
      meta: "Page",
      keywords: "automation recurring routines cloud computer background"
    },
    {
      id: "knowledge-page",
      scope: "knowledge" as const,
      action: "knowledge" as const,
      title: "Knowledge",
      description: "Review sources, memory, and reusable context",
      meta: "Page",
      keywords: "sources files memory context"
    },
    {
      id: "connections-page",
      scope: "connections" as const,
      action: "connection" as const,
      title: "Connections",
      description: "Connect apps and inspect what agents can access",
      meta: "Page",
      keywords: "plugins connectors apps permissions"
    },
    ...runtime.agents.map((profile) => ({
      id: profile.id,
      scope: "agents" as const,
      action: "agent" as const,
      title: profile.name,
      description: agentSidebarPreviews[profile.id]?.message ?? "Start a conversation",
      meta: "Agent",
      keywords: profile.instructions,
      agent: profile
    })),
    ...projectWorkspaces.map((project) => ({
      id: project.id,
      scope: "work" as const,
      action: "project" as const,
      title: project.title,
      description: project.description || "Project workspace",
      meta: "Project",
      keywords: project.instructions
    })),
    ...runtime.schedules.map((schedule) => ({
      id: schedule.id,
      scope: "work" as const,
      action: "schedule" as const,
      title: schedule.name,
      description: schedule.description,
      meta: schedule.enabled ? "Routine" : "Paused routine",
      keywords: `${schedule.day} ${schedule.time}`
    })),
    ...runtime.workspaceKnowledgeSources.map((source) => ({
      id: source.id,
      scope: "knowledge" as const,
      action: "knowledge" as const,
      title: source.title,
      description: source.contentPreview || source.provenance,
      meta: source.kind,
      keywords: `${source.provenance} ${source.connectorId}`
    })),
    ...runtime.connectorManifests
      .filter((connector) => connector.id !== "local-files")
      .map((connector) => ({
        id: connector.id,
        scope: "connections" as const,
        action: "connection" as const,
        title: connector.name,
        description: connector.status === "connected"
          ? "Ready for your agents to use"
          : `Connect ${connector.name} when you want an agent to use it`,
        meta: connector.status === "connected" ? "Installed" : "Connection",
        keywords: connector.permissions.join(" ")
      }))
  ], [agentSidebarPreviews, projectWorkspaces, runtime.agents, runtime.connectorManifests, runtime.schedules, runtime.workspaceKnowledgeSources]);

  // Settings nav search filter. Memoized (and kept above the onboarding early
  // return so the Rules of Hooks hold) so typing in the settings search box
  // does not refilter the static tab list on every unrelated render.
  const visibleSettingsTabs = useMemo(() => {
    const query = settingsModalSearch.trim().toLocaleLowerCase();
    if (!query) return settingsTabs;
    return settingsTabs.filter((tab) => tab.label.toLocaleLowerCase().includes(query));
  }, [settingsModalSearch]);

  /**
   * Submit raw composer text. Fable-owned slash commands (/goal, /plan,
   * /remember, /schedule, /stop) are parsed and executed first - they create
   * structured Fable state and, when a backend is connected, submit follow-up
   * model work through the agent run. Unknown slashes and ordinary text fall
   * through to the normal prompt path unchanged.
   */
  async function submitComposerText(rawText: string, options: { displayText?: string } = {}) {
    const submitted = rawText.trim();
    const displayed = options.displayText?.trim() || submitted;
    if (!submitted || agent.state.running || parallelMissionRunning || generalMissionRunning || pendingPrompt) return;
    if (!activeAgent.instructions.trim()) {
      const parsedPurpose = parseComposerText(submitted);
      const purpose = parsedPurpose.status === "command"
        ? parsedPurpose.request.args.trim() || submitted
        : submitted;
      runtime.updateAgent(activeAgent.id, {
        instructions: purpose,
        ...(activeAgent.name === "New teammate" ? { name: suggestTeammateName(purpose) } : {})
      });
    }
    if (!selectedConversationThreadId) {
      setSubmissionInFlight(true);
      const thread = await durableConversation.createThread({
        authorityScope: { authority: "local", visibility: "member-private", ownerMemberId: "current-member" as never },
        ...(newThreadProjectId ? { projectId: newThreadProjectId as never } : {}),
        title: displayed.slice(0, 72)
      });
      await durableConversation.deleteDraft();
      setSelectedConversationThreadId(thread.id);
      setConversationMessages([{ id: messageId("user"), role: "user", content: displayed }]);
      setPendingPrompt(submitted);
      return;
    }
    appendConversationMessage("user", displayed);
    void continueComposerSubmission(submitted);
  }

  async function continueComposerSubmission(submitted: string) {
    const parsed = parseComposerText(submitted);
    if (parsed.status === "command") {
      if (parsed.request.name === "mission") {
        await runGeneralMissionCommand(submitted, parsed.request.args);
        return;
      }
      const result = await runtime.runFableCommand(parsed.request, {
        backendConnected: Boolean(runtime.connectedAgentBackend),
        stopCurrentWork: stopActiveWork
      });
      appendConversationMessage("assistant", result.message);
      if (result.status === "ok" && result.followUpPrompt && runtime.connectedAgentBackend) {
        runPrompt(result.followUpPrompt, { appendUserMessage: false });
      }
      return;
    }
    // The explicit local intake journey owns this narrow phrase before the
    // broader natural-language /plan parser can interpret "project brief".
    if (structuredIntakeSubject(submitted)) {
      runPrompt(submitted, { appendUserMessage: false });
      return;
    }
    runPrompt(submitted, { appendUserMessage: false });
  }

  async function stopActiveWork() {
    const generalCancel = generalMissionCancellationRef.current;
    if (generalCancel) {
      await generalCancel();
      return true;
    }
    const parallelCancel = parallelMissionCancellationRef.current;
    if (parallelCancel) {
      await parallelCancel();
      return true;
    }
    return stopCurrentWork();
  }

  async function runGeneralMissionCommand(submitted: string, args: string) {
    runtime.setComposerValue("");
    const draft = parseGeneralMissionDraft(args);
    if (!draft) {
      appendConversationMessage(
        "assistant",
        "Use /mission with a short title, then two to six total steps. Start with at least two bullet tasks. Add “all: …” or “any: …” for one continuation, or use numbered joins such as “all 1,2: …” and “any 2,3: …” for a small dependency graph. Short “then: …” stages and one “review: …” plus “revise: …” pair remain available for the simple path. Finish with up to four exact “accept: …” criteria."
      );
      return;
    }
    const nativeConnected = runtime.connectedAgentBackend?.backendType === "native-api"
      ? runtime.connectedAgentBackend
      : undefined;
    const missionBackend = agent.backend;
    if (!nativeConnected || !missionBackend || !boundWorkspaceId || !selectedConversationThreadId) {
      appendConversationMessage(
        "assistant",
        "Missions require an active Fable workspace, conversation, and connected native model provider."
      );
      return;
    }
    const validation = validateModelSelection(
      nativeConnected.id,
      resolvedComposerModelId,
      runtime.selectableModels,
      2048
    );
    if (!validation.ok) {
      const error = validation.error ?? "The selected model cannot run this Mission.";
      agent.reportError(error);
      appendConversationMessage("assistant", error);
      return;
    }

    const sourceThreadId = selectedConversationThreadId;
    const declaredStepCount = draft.tasks.length
      + (draft.graph
        ? draft.graph.steps.length
        : draft.join
        ? 1 + (draft.join.then?.length ?? 0) + (draft.join.review ? 2 : 0)
        : 0);
    const preparationLabel = draft.join || draft.graph
      ? `Preparing ${declaredStepCount} declared Mission steps...`
      : `Preparing ${draft.tasks.length} independent tasks...`;
    const assistantMessageId = appendConversationMessage(
      "assistant",
      preparationLabel
    );
    let checkpointAssistant: (content: string, terminal?: boolean) => Promise<void> =
      async (_content: string, _terminal = true): Promise<void> => {
      throw new Error("Fable could not open the durable Mission transcript.");
      };
    resetCancellation();
    setGeneralMissionRunning(true);
    try {
      const { executeGeneralMission } = await import("../lib/general-mission");
      const result = await executeGeneralMission({
        ...draft,
        workspaceId: boundWorkspaceId,
        sourceThreadId,
        ...(runProjectId ? { projectId: runProjectId } : {}),
        backend: missionBackend,
        model: resolvedComposerModelId,
        resolveBackend: (route) => agent.resolveBackend(route.providerFamily),
        onCancellationReady: (cancel) => { generalMissionCancellationRef.current = cancel; },
        onRunReady: async (runId, missionProgress) => {
          const writer = createDesktopDurableRunWriter(sourceThreadId, runId);
          await writer.record({ kind: "user", content: submitted });
          await writer.record({
            kind: "assistant",
            content: preparationLabel,
            state: "streaming"
          });
          checkpointAssistant = (content, terminal = true) =>
            writer.checkpointAssistant(content, terminal);
          if (selectedConversationThreadIdRef.current !== sourceThreadId) return;
          setConversationMessages((current) => current.map((entry) =>
            entry.id === assistantMessageId
              ? { ...entry, runId, missionKind: "general", missionProgress }
              : entry
          ));
        },
        onProgress: (missionProgress) => {
          if (selectedConversationThreadIdRef.current !== sourceThreadId) return;
          setConversationMessages((current) => current.map((entry) =>
            entry.id === assistantMessageId ? { ...entry, missionProgress } : entry
          ));
        }
      });
      await checkpointAssistant(result.text, true);
      if (selectedConversationThreadIdRef.current === sourceThreadId) {
        setConversationMessages((current) => current.map((entry) =>
          entry.id === assistantMessageId ? {
            ...entry,
            content: result.text,
            runId: result.runId,
            missionKind: "general",
            missionOutcome: result.outcome,
            missionProgress: result.progress
          } : entry
        ));
      }
      await durableConversation.refresh();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Fable could not complete this Mission.";
      await checkpointAssistant(message, true).catch(() => undefined);
      if (selectedConversationThreadIdRef.current === sourceThreadId) {
        setConversationMessages((current) => current.map((entry) =>
          entry.id === assistantMessageId ? { ...entry, content: message } : entry
        ));
      }
    } finally {
      generalMissionCancellationRef.current = null;
      setGeneralMissionRunning(false);
    }
  }

  function focusComposerAfterVoice() {
    window.requestAnimationFrame(() => runtime.composerRef.current?.focus());
  }

  function addDictationToComposer(transcript: string) {
    const composer = runtime.composerRef.current;
    const insertion = insertDictation(
      runtime.composerValue,
      transcript,
      composer?.selectionStart ?? runtime.composerValue.length,
      composer?.selectionEnd ?? runtime.composerValue.length
    );
    runtime.setComposerValue(insertion.value);
    window.requestAnimationFrame(() => {
      const currentComposer = runtime.composerRef.current;
      currentComposer?.focus();
      currentComposer?.setSelectionRange(insertion.caret, insertion.caret);
    });
  }

  function runPrompt(rawPrompt: string, options: {
    appendUserMessage?: boolean;
    forceCitedMission?: boolean;
    newMissionSourceMessageId?: string;
  } = {}) {
    const prompt = rawPrompt.trim();
    if (!prompt) return;
    const sourceMessageId = options.newMissionSourceMessageId;
    if (sourceMessageId && (newMissionLaunchRef.current || citedMissionRunning || parallelMissionRunning || generalMissionRunning || agent.state.running || pendingPrompt)) {
      return;
    }
    const finishNewMissionLaunch = () => {
      if (!sourceMessageId || newMissionLaunchRef.current !== sourceMessageId) return;
      newMissionLaunchRef.current = null;
      setNewMissionSourceMessageId(null);
    };
    if (sourceMessageId) {
      newMissionLaunchRef.current = sourceMessageId;
      setNewMissionSourceMessageId(sourceMessageId);
    }
    if (options.appendUserMessage !== false) {
      appendConversationMessage("user", prompt);
    }
    runtime.setComposerValue("");
    const revisionBriefFocus = artifactRevisionBriefFocus(prompt);
    if (revisionBriefFocus) {
      if (!selectedConversationThreadId) return;
      if (nativeInputMissionStartingRef.current) {
        appendConversationMessage(
          "assistant",
          "A provider-free mission is already starting. Try again when its form appears."
        );
        return;
      }
      const sourceThreadId = selectedConversationThreadId;
      nativeInputMissionStartingRef.current = true;
      void startArtifactRevisionBriefMission({
        sourceThreadId,
        ...(runProjectId ? { projectId: runProjectId } : {}),
        focus: revisionBriefFocus
      }).then((request) => {
        if (selectedConversationThreadIdRef.current !== request.sourceThreadId) return;
        optimisticMissionInputRunIds.current.add(request.runId);
        setPendingMissionInputs((current) => [
          ...current.filter((entry) => entry.runId !== request.runId),
          request
        ]);
      }).catch((cause) => {
        if (selectedConversationThreadIdRef.current !== sourceThreadId) return;
        const message = cause instanceof Error ? cause.message : "Fable could not start the artifact revision brief.";
        appendConversationMessage("assistant", message);
      }).finally(() => {
        nativeInputMissionStartingRef.current = false;
      });
      finishNewMissionLaunch();
      return;
    }
    const intakeSubject = structuredIntakeSubject(prompt);
    if (intakeSubject) {
      if (!selectedConversationThreadId) return;
      if (nativeInputMissionStartingRef.current) {
        appendConversationMessage(
          "assistant",
          "A structured brief is already starting. Try again when its form appears."
        );
        return;
      }
      const sourceThreadId = selectedConversationThreadId;
      nativeInputMissionStartingRef.current = true;
      void startStructuredIntakeMission({
        sourceThreadId,
        ...(runProjectId ? { projectId: runProjectId } : {}),
        subject: intakeSubject
      }).then((request) => {
        if (selectedConversationThreadIdRef.current !== request.sourceThreadId) return;
        optimisticMissionInputRunIds.current.add(request.runId);
        setPendingMissionInputs((current) => [
          ...current.filter((entry) => entry.runId !== request.runId),
          request
        ]);
      }).catch((cause) => {
        if (selectedConversationThreadIdRef.current !== sourceThreadId) return;
        const message = cause instanceof Error ? cause.message : "Fable could not start the structured brief.";
        appendConversationMessage("assistant", message);
      }).finally(() => {
        nativeInputMissionStartingRef.current = false;
      });
      finishNewMissionLaunch();
      return;
    }
    const connectedBackend = runtime.connectedAgentBackend;
    if (!connectedBackend) {
      if (options.forceCitedMission) {
        const error = "Starting a new cited mission requires a connected native model provider.";
        agent.reportError(error);
        appendConversationMessage("assistant", error);
        finishNewMissionLaunch();
        return;
      }
      appendConversationMessage(
        "assistant",
        "I’m ready to take this on, but I need a model connection before I can do the work. Your request is safe here—nothing ran in the background.",
        { action: "connect-provider" }
      );
      runtime.setLastAction("Connect a model to start agent work");
      finishNewMissionLaunch();
      return;
    }
    const validation = validateModelSelection(
      connectedBackend.id,
      resolvedComposerModelId,
      runtime.selectableModels,
      2048
    );
    if (!validation.ok) {
      agent.reportError(validation.error ?? "The selected model cannot run.");
      appendConversationMessage("assistant", validation.error ?? "The selected model cannot run.");
      finishNewMissionLaunch();
      return;
    }
    if (isParallelApproachesMissionPrompt(prompt)) {
      const parallelBackend = agent.backend;
      if (!boundWorkspaceId || !selectedConversationThreadId || !parallelBackend) {
        appendConversationMessage("assistant", "Parallel missions require an active Fable workspace and conversation.");
        finishNewMissionLaunch();
        return;
      }
      const sourceThreadId = selectedConversationThreadId;
      const assistantMessageId = appendConversationMessage("assistant", "Developing two independent approaches...");
      resetCancellation();
      setParallelMissionRunning(true);
      void import("../lib/parallel-approaches-mission").then(({ executeParallelApproachesMission }) => executeParallelApproachesMission({
        prompt,
        workspaceId: boundWorkspaceId,
        sourceThreadId,
        ...(runProjectId ? { projectId: runProjectId } : {}),
        backend: parallelBackend,
        model: resolvedComposerModelId,
        onCancellationReady: (cancel) => { parallelMissionCancellationRef.current = cancel; },
        onPlanReady: (parallelMissionPlan) => {
          setConversationMessages((current) => current.map((entry) =>
            entry.id === assistantMessageId ? { ...entry, parallelMissionPlan } : entry
          ));
        },
        onProgress: (missionProgress) => {
          if (selectedConversationThreadIdRef.current !== sourceThreadId) return;
          setConversationMessages((current) => current.map((entry) =>
            entry.id === assistantMessageId ? { ...entry, missionProgress } : entry
          ));
        }
      })).then((result) => {
        if (selectedConversationThreadIdRef.current !== sourceThreadId) return;
        setConversationMessages((current) => current.map((entry) =>
          entry.id === assistantMessageId ? {
            ...entry,
            content: result.text,
            runId: result.runId,
            missionKind: "parallel-approaches",
            missionOutcome: result.outcome,
            parallelMissionPlan: result.plan,
            ...(result.artifactId ? { missionArtifactId: result.artifactId } : {})
          } : entry
        ));
        if (result.artifactId) {
          void getRuntimeArtifact(result.artifactId).then((artifact) => {
            if (!artifact || selectedConversationThreadIdRef.current !== sourceThreadId) return;
            setThreadArtifacts((current) => [
              ...current.filter((entry) => entry.artifact.id !== artifact.artifact.id),
              artifact
            ]);
          }).catch(() => undefined);
        }
      }).catch((cause) => {
        if (selectedConversationThreadIdRef.current !== sourceThreadId) return;
        const message = cause instanceof Error ? cause.message : "Fable could not complete the parallel mission.";
        setConversationMessages((current) => current.map((entry) =>
          entry.id === assistantMessageId ? { ...entry, content: message } : entry
        ));
      }).finally(() => {
        parallelMissionCancellationRef.current = null;
        setParallelMissionRunning(false);
        finishNewMissionLaunch();
      });
      return;
    }
    if (options.forceCitedMission || isCitedBriefMissionPrompt(prompt)) {
      const assistantMessageId = appendConversationMessage("assistant", "Searching connected work sources...");
      resetCancellation();
      void runCitedBrief(prompt, resolvedComposerModelId, runProjectId ?? undefined, (plan) => {
        setConversationMessages((current) => current.map((entry) =>
          entry.id === assistantMessageId ? { ...entry, missionPlan: plan } : entry
        ));
      })
        .then((result) => {
          const citedApproval = result.approval;
          if (citedApproval) {
            setPendingCitedApprovals((current) => [
              ...current.filter((entry) => entry.runId !== citedApproval.runId),
              citedApproval
            ]);
          }
          setConversationMessages((current) => current.map((entry) =>
            entry.id === assistantMessageId ? {
              ...entry,
              content: result.text,
              runId: result.runId,
              missionPlan: result.plan,
              missionReceipt: result.receipt,
              missionOutcome: result.outcome,
              ...(result.approval ? { approvalRunId: result.approval.runId } : {}),
              ...(result.artifactId ? { missionArtifactId: result.artifactId } : {})
            } : entry
          ));
          if (result.artifactId) {
            void getRuntimeArtifact(result.artifactId)
              .then((artifact) => {
                if (!artifact) return;
                setThreadArtifacts((current) => [
                  ...current.filter((entry) => entry.artifact.id !== artifact.artifact.id),
                  artifact
                ]);
              })
              .catch(() => undefined);
          }
        })
        .catch((cause) => {
          const message = cause instanceof Error ? cause.message : "Fable could not complete the connected-source brief.";
          setConversationMessages((current) => current.map((entry) =>
            entry.id === assistantMessageId ? { ...entry, content: message } : entry
          ));
        })
        .finally(finishNewMissionLaunch);
      return;
    }
    finishNewMissionLaunch();
    const executionInstructions = agentExecutionInstructions(activeAgent);
    const executionPrompt = executionInstructions
      ? `Agent instructions:\n${executionInstructions}\n\nUser request:\n${prompt}`
      : prompt;
    const request = buildAgentRequest({
      model: resolvedComposerModelId,
      prompt: executionPrompt,
      maxTokens: validation.maxTokens
    });
    const assistantMessageId = appendConversationMessage("assistant", "Working...");
    activeAssistantMessageId.current = assistantMessageId;
    resetCancellation();
    const runProject = runProjectId
      ? projectWorkspaces.find((project) => project.id === runProjectId)
      : undefined;
    const projectContext = runProjectId ? projectMemory.loadContextRecords() : Promise.resolve([]);
    void projectContext
      .then((projectMemoryRecords) => runtime.assembleKnowledgeContext(prompt, {
        projectId: runProjectId,
        projectMemoryRecords,
        allowedConnectionIds: runProject?.connectionIds ?? [],
        allowedConnectorIds: activeAgent.connectorIds,
        allowedKnowledgeSourceIds: activeAgent.knowledgeSourceIds
      }))
      .then((preparedContext) => {
        setConversationMessages((current) => current.map((entry) =>
          entry.id === assistantMessageId
            ? { ...entry, runId: preparedContext.receipt.runId }
            : entry
        ));
        return agent.run(request, preparedContext, runtime.permissionMode);
      })
      .catch((cause) => {
        const message = cause instanceof Error ? cause.message : "Fable could not load this project's context.";
        agent.reportError(message);
        setConversationMessages((current) => current.map((entry) =>
          entry.id === assistantMessageId ? { ...entry, content: message } : entry
        ));
        activeAssistantMessageId.current = null;
      });
  }

  async function startFreshGeneralMission(
    sourceCommand: string,
    sourceMessageId: string
  ) {
    if (
      newMissionLaunchRef.current
      || citedMissionRunning
      || parallelMissionRunning
      || generalMissionRunning
      || agent.state.running
      || pendingPrompt
    ) {
      return;
    }
    const parsed = parseComposerText(sourceCommand);
    if (parsed.status !== "command" || parsed.request.name !== "mission") return;
    newMissionLaunchRef.current = sourceMessageId;
    setNewMissionSourceMessageId(sourceMessageId);
    appendConversationMessage("user", sourceCommand);
    try {
      await runGeneralMissionCommand(sourceCommand, parsed.request.args);
    } finally {
      if (newMissionLaunchRef.current === sourceMessageId) {
        newMissionLaunchRef.current = null;
        setNewMissionSourceMessageId(null);
      }
    }
  }

  // Subscribe the global shortcut listener once. The runtime object is not
  // referentially stable (it is rebuilt each render), so depending on it here
  // would tear down and re-add the keydown listener on every render. A ref
  // always points at the latest runtime, keeping the handlers current without
  // resubscribing.
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) {
        return;
      }

      const key = event.key.toLowerCase();
      const current = runtimeRef.current;
      if (key === "k") {
        event.preventDefault();
        setWorkspaceSearchOpen(true);
        current.setLastAction("Workspace search opened");
      }

      if (key === "n") {
        event.preventDefault();
        current.startNewChat();
      }
    };

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  // The account establishes the active workspace before provider setup.
  // Preview runtimes report a synthetic ready account, so they enter the
  // provider stage without a production-only bypass.
  const accountWorkspaceUsable = runtime.accountWorkspaceStatus.state === "ready" ||
    (runtime.accountWorkspaceStatus.state === "offline" && runtime.accountWorkspaceStatus.accountBound);
  const identityUsable = runtime.identityStatus.state === "signed-in" ||
    (runtime.identityStatus.state === "offline" && runtime.accountWorkspaceStatus.state === "offline" && runtime.accountWorkspaceStatus.accountBound);
  const accountReady = identityUsable && accountWorkspaceUsable;
  if (!accountReady || runtime.onboardingRequired) {
    return (
      <Suspense fallback={<div className="og-frame" aria-busy="true" />}>
        <OnboardingPage
          providers={runtime.backendProviders}
          connectedBackendIds={runtime.connectedBackendIds}
          status={runtime.backendStatus}
          identityStatus={runtime.identityStatus}
          identityPending={runtime.identityPending}
          accountWorkspaceStatus={runtime.accountWorkspaceStatus}
          accountWorkspacePending={runtime.accountWorkspacePending}
          onSignIn={runtime.signInIdentity}
          onRecover={runtime.recoverIdentity}
          onRefreshAccount={async () => {
            await runtime.refreshIdentity();
            await runtime.reconcileAccountWorkspace();
          }}
          onConnect={(providerId, secret) => void runtime.connectBackend(providerId, secret)}
          onConnectWithVerify={(providerId, secret) =>
            runtime.connectBackendWithVerify(providerId, secret)
          }
          onCheckConnection={async () => {
            await runtime.refreshBackendProviders();
          }}
          onComplete={runtime.dismissOnboarding}
          allowProviderless={import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)}
        />
      </Suspense>
    );
  }

  const handleSelectSettingsTab = (tab: SettingsTab) => {
    setActiveSettingsTab(tab);
    runtime.setActiveItem("Settings");
  };

  const navigateHistory = (offset: -1 | 1) => {
    const nextIndex = navigationIndex + offset;
    const target = navigationHistory.current[nextIndex];
    if (!target || nextIndex < 0 || nextIndex >= navigationHistory.current.length) {
      return;
    }
    navigationTarget.current = target;
    setNavigationIndex(nextIndex);
    runtime.setActiveItem(target);
  };

  const startNewChat = (projectId: string | null) => {
    setSelectedProjectId(null);
    setNewThreadProjectId(projectId);
    setSelectedConversationThreadId(undefined);
    activeAssistantMessageId.current = null;
    setConversationMessages([]);
    runtime.setComposerValue("");
    runtime.startNewChat();
    runtime.setLastAction(projectId ? "New project chat ready" : "New chat ready");
  };

  const selectAgentSurface = (profile: FableAgentProfile) => {
    setLearningDialog(null);
    setSelectedProjectId(null);
    setNewThreadProjectId(null);
    activeAssistantMessageId.current = null;
    setConversationMessages([]);
    runtime.setComposerValue("");
    const thread = profile.threadId
      ? durableThreads.find((candidate) => candidate.id === profile.threadId)
      : undefined;
    setSelectedConversationThreadId(thread?.id);
    runtime.selectAgent(profile.id);
  };

  const openAgentEditor = (profile?: FableAgentProfile) => {
    setEditingAgentId(profile?.id ?? null);
    setAgentEditorOpen(true);
  };

  const closeAgentEditor = () => {
    setAgentEditorOpen(false);
    setEditingAgentId(null);
  };

  const createConversationalAgent = () => {
    const created = runtime.createAgent({
      name: "New teammate",
      instructions: "",
      modelId: "",
      icon: "agent",
      iconColor: nextAgentColor(runtime.agents.map((profile) => profile.iconColor)),
      connectorIds: [],
      knowledgeSourceIds: [],
      permissionLabel: "Ask Me"
    });
    selectAgentSurface(created);
    runtime.setLastAction("New teammate ready");
  };

  const openConversation = (thread: ThreadSummary, context: string) => {
    setSelectedProjectId(null);
    setNewThreadProjectId(null);
    setSelectedConversationThreadId(thread.id);
    activeAssistantMessageId.current = null;
    setConversationMessages([]);
    runtime.setComposerValue("");
    runtime.openThread(thread, context);
  };

  const openProject = (projectId: string) => {
    setSelectedProjectId(projectId);
    setNewThreadProjectId(null);
    setSelectedConversationThreadId(undefined);
    activeAssistantMessageId.current = null;
    setConversationMessages([]);
    runtime.setComposerValue("");
    runtime.setActiveItem(projectId);
    runtime.setLastAction("Project opened");
  };

  const selectWorkspaceSearchItem = (item: WorkspaceSearchItem) => {
    setWorkspaceSearchOpen(false);
    if (item.action === "agent") {
      const profile = runtime.agents.find((candidate) => candidate.id === item.id);
      if (profile) selectAgentSurface(profile);
      return;
    }
    if (item.action === "project") {
      openProject(item.id);
      return;
    }
    if (item.action === "schedule") {
      runtime.setActiveItem("Schedules");
      return;
    }
    runtime.setActiveItem(item.action === "knowledge" ? "Knowledge" : "Connectors");
  };

  return (
    <main
      className={`desktop-frame desktop-frame--agents${liveRailOpen ? "" : " desktop-frame--live-closed"}`}
      data-theme={theme}
    >
      <AgentSidebar
        agents={runtime.agents}
        activeAgentId={activeAgent.id}
        previews={agentSidebarPreviews}
        profileName={verifiedProfile.name}
        onSelectAgent={selectAgentSurface}
        onCreateAgent={createConversationalAgent}
        onOpenSearch={() => setWorkspaceSearchOpen(true)}
        onEditAgent={openAgentEditor}
        onOpenSettings={() => runtime.setActiveItem("Settings")}
      />
      <section className="workspace" aria-label="Fable workspace">
        <AgentWorkspaceHeader
          agent={activeAgent}
          canTeamUp={runtime.agents.length > 1}
          teamUpOpen={teamMissionOpen}
          onTeamUp={() => setTeamMissionOpen(true)}
          learnedCount={activeAgent.learnedTasks?.length ?? 0}
          learnedOpen={learningDialog !== null}
          onOpenLearned={() => setLearningDialog({ mode: "manage", source: null })}
          attentionCount={runtime.openApprovals.length}
          liveRailOpen={liveRailOpen}
          onToggleLiveRail={() => setLiveRailOpen((open) => !open)}
        />
        <div className="agent-workspace-body">
        {runtime.activePage && !isSettingsActive ? (
          <ShellPageBoundary
            runtime={runtime}
            hostedComputer={{
              scopeKey: hostedComputer.scopeKey,
              agentName: activeAgent.name,
              available: hostedComputer.available,
              status: hostedComputer.node?.status,
              keepAlive: hostedComputer.node?.keepAlive ?? false,
              loading: hostedComputer.loading,
              provisioning: hostedComputer.provisioning,
              schedules: hostedComputer.schedules,
              schedulesLoading: hostedComputer.schedulesLoading,
              schedulesRefreshing: hostedComputer.schedulesRefreshing,
              schedulesError: hostedComputer.schedulesError,
              scheduleRuns: hostedComputer.scheduleRuns,
              scheduleRunsLoading: hostedComputer.scheduleRunsLoading,
              scheduleRunsError: hostedComputer.scheduleRunsError,
              agentRoutines: hostedComputer.agentRoutines,
              agentRoutinesLoading: hostedComputer.agentRoutinesLoading,
              agentRoutinesError: hostedComputer.agentRoutinesError,
              agentRoutineRuns: hostedComputer.agentRoutineRuns,
              agentRoutineRunsLoading: hostedComputer.agentRoutineRunsLoading,
              agentRoutineRunsError: hostedComputer.agentRoutineRunsError,
              onProvision: hostedComputer.provision,
              onRefresh: hostedComputer.refreshSchedules,
              onCreate: hostedComputer.createSchedule,
              onCancel: hostedComputer.cancelSchedule,
              onPause: hostedComputer.pauseSchedule,
              onResume: hostedComputer.resumeSchedule,
              onInspectRun: hostedComputer.inspectScheduleRun,
              onCreateAgentRoutine: hostedComputer.createAgentRoutine,
              onCancelAgentRoutine: hostedComputer.cancelAgentRoutine,
              onPauseAgentRoutine: hostedComputer.pauseAgentRoutine,
              onResumeAgentRoutine: hostedComputer.resumeAgentRoutine
            }}
          />
        ) : selectedProject && !isSettingsActive ? (
          <div className="workspace-center workspace-center--page">
            <Suspense fallback={<div className="og-frame" aria-busy="true" />}>
              <ProjectPage
                project={selectedProject}
                workspaceId={boundWorkspaceId ?? ""}
                knowledge={projectKnowledgeView}
                memory={projectMemoryView}
                activity={projectActivity}
                onNewChat={() => startNewChat(selectedProject.id)}
                onSelectThread={(thread) => openConversation(thread, selectedProject.title)}
                onRerunMission={async (mission) => {
                  if (
                    selectedProject.lifecycle !== "active"
                    || !matchesTerminalGeneralRetryStatus(mission.progress.runStatus)
                  ) {
                    throw new Error("Only retryable terminal Missions in an active Project can run again.");
                  }
                  const thread = selectedProject.threads.find(
                    (candidate) => candidate.id === mission.threadId
                  );
                  if (!thread) throw new Error("That Project conversation is no longer available.");
                  const before = await getRuntimeConversationThread(thread.id);
                  if (
                    !before
                    || before.projectId !== selectedProject.id
                    || before.lifecycle !== "active"
                  ) {
                    throw new Error("That conversation no longer belongs to this active Project.");
                  }
                  const messages = await listRuntimeConversationMessages(thread.id);
                  const after = await getRuntimeConversationThread(thread.id);
                  if (
                    !after
                    || after.projectId !== selectedProject.id
                    || after.lifecycle !== "active"
                    || after.revision !== before.revision
                  ) {
                    throw new Error("That Project conversation changed while Fable checked it. Refresh and try again.");
                  }
                  const rerun = resolveProjectMissionRerunSource(messages, mission.runId);
                  setPendingProjectMissionRerun({ threadId: thread.id, ...rerun });
                  openConversation(thread, selectedProject.title);
                }}
                onExportCopy={async (destination) => Boolean(
                  boundWorkspaceId
                  && await exportRuntimeProjectArchive(
                    destination,
                    boundWorkspaceId,
                    selectedProject.id
                  )
                )}
                onReload={async () => { await projectStore.refresh(); }}
                onSaveGuidance={async ({ description, instructions }) => {
                  await projectStore.update({
                    projectId: selectedProject.id as never,
                    baseRevision: selectedProject.revision,
                    description,
                    instructions
                  });
                }}
                onSaveConnections={async (connectionIds) => {
                  await projectStore.update({
                    projectId: selectedProject.id as never,
                    baseRevision: selectedProject.revision,
                    connectionIds: connectionIds as never
                  });
                }}
              />
            </Suspense>
          </div>
        ) : (
          <div
            className={`workspace-center workspace-center--composer${
              conversationIsActive ? " workspace-center--conversation" : ""
            }`}
          >
            {conversationIsActive ? (
              <div
                ref={conversationScrollRef}
                className="conversation-scroll"
                aria-live="polite"
              >
                {renderConversation()}
                {renderChatContext()}
              </div>
            ) : null}
            {!conversationIsActive ? (
              <AgentWelcome
                agent={activeAgent}
                onChoose={(prompt) => {
                  runtime.setComposerValue(prompt);
                  runtime.focusComposer(prompt);
                }}
              />
            ) : null}
            <div className={conversationIsActive ? "conversation-composer-dock" : "agent-composer-dock"}>
              <Composer
              composerRef={runtime.composerRef}
              fileInputRef={runtime.fileInputRef}
              composerValue={runtime.composerValue}
              onComposerChange={runtime.setComposerValue}
              onSubmit={(event) => {
                event.preventDefault();
                const text = runtime.composerValue;
                if (!text.trim() || conversationSubmissionBlocked) return;
                void submitComposerText(text);
              }}
              voiceStatus={voice.state.status}
              voiceMessage={voice.state.message}
              voiceCanStart={voice.canStart}
              voiceDisclosure={voice.processingDisclosure}
              onStartVoice={() => void voice.start()}
              onStopVoice={voice.stop}
              onCancelVoice={voice.cancel}
              onDismissVoice={voice.dismiss}
              onAttach={runtime.triggerAttach}
              addMenuOpen={addMenuOpen}
              permissionsOpen={toolPickerOpen}
              onTogglePermissions={() => {
                setToolPickerOpen((open) => !open);
                setAddMenuOpen(false);
                runtime.setLastAction("Tool picker toggled");
              }}
              onToggleAddMenu={() => {
                setAddMenuOpen((open) => !open);
                setToolPickerOpen(false);
                runtime.setLastAction("Add menu toggled");
              }}
              onOpenTool={(tool) => {
                setAddMenuOpen(false);
                runtime.setActiveItem(tool);
                runtime.setLastAction(`${tool} selected`);
              }}
              onRunCommand={runtime.runCommand}
              onFileChange={runtime.handleComposerAttachmentChange}

              importStatus={runtime.importStatus}
              models={composerModels}
              selectedModelId={resolvedComposerModelOptionId}
              selectedModelLabel={modelChipLabel}
              onSelectModel={runtime.selectModel}
              permissionLabel={runtime.permissionLabel}
              permissionProfiles={PERMISSION_PROFILES}
              onSelectPermissionLabel={runtime.selectPermissionLabel}
              inThread={!!selectedConversationThreadId}
              isWorking={conversationWorking}
              onStop={() => {
                void stopActiveWork();
              }}
              connectedConnectors={connectedConnectorCards}
              knowledgeSources={runtime.workspaceKnowledgeSources}
              attachments={runtime.composerAttachments}
              onRemoveAttachment={runtime.removeComposerAttachment}
              compactAgentSurface
              />
            </div>
            {!conversationIsActive ? renderChatContext() : null}
          </div>
        )}
        <p className="sr-only" aria-live="polite">
          {liveStatusLead} {runtime.managedMemoryRecords.length} memory items.{" "}
          {runtime.workspaceKnowledgeSources.length} sources. {runtime.openApprovals.length} approvals
          pending. {scheduledActive ? `Running scheduled prompt ${scheduledActive.jobId}.` : ""}
        </p>
        </div>
      </section>

      {liveRailOpen ? (
        <LiveWorkRail
          agentName={activeAgent.name}
          running={conversationWorking}
          status={agent.state.status}
          transcript={agent.state.transcript}
          runId={agent.state.currentRunId}
          approvalCount={runtime.openApprovals.length}
          computerUseActive={Boolean(hostedBrowser.snapshot) || (!runtime.browserSession.fixtureOnly && runtime.browserSession.lifecycle === "active")}
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
            schedules: hostedComputer.schedules,
            schedulesLoading: hostedComputer.schedulesLoading,
            schedulesError: hostedComputer.schedulesError,
            agentRoutines: hostedComputer.agentRoutines,
            onOpenBrowser: hostedBrowser.open,
            onRefreshBrowser: hostedBrowser.refresh
          }}
          screenPreviewUrl={hostedBrowser.snapshot?.previewDataUrl}
          missionProgress={liveMissionProgress}
          onReviewApprovals={() => {
            setLiveRailOpen(false);
            handleSelectSettingsTab("privacy");
          }}
          onClose={() => setLiveRailOpen(false)}
        />
      ) : null}

      <AgentEditor
        open={agentEditorOpen}
        agent={editingAgentId ? runtime.agents.find((profile) => profile.id === editingAgentId) ?? null : null}
        models={runtime.modelOptions}
        connectors={runtime.connectorManifests}
        knowledgeSources={runtime.workspaceKnowledgeSources}
        suggestedColor={nextAgentColor(runtime.agents.map((profile) => profile.iconColor))}
        canDelete={runtime.agents.length > 1}
        onClose={closeAgentEditor}
        onSave={(draft) => {
          if (editingAgentId) {
            runtime.updateAgent(editingAgentId, draft);
          } else {
            const created = runtime.createAgent(draft);
            selectAgentSurface(created);
          }
          closeAgentEditor();
        }}
        onDelete={() => {
          if (editingAgentId) runtime.removeAgent(editingAgentId);
          closeAgentEditor();
        }}
      />

      <AgentLearningDialog
        open={learningDialog !== null}
        agent={activeAgent}
        source={learningDialog?.mode === "teach" ? learningDialog.source : null}
        onClose={() => setLearningDialog(null)}
        onChange={(learnedTasks) => {
          runtime.updateAgent(activeAgent.id, { learnedTasks });
          runtime.setLastAction(
            learnedTasks.length
              ? `${activeAgent.name} learned ${learnedTasks.length === 1 ? "a responsibility" : `${learnedTasks.length} responsibilities`}`
              : `${activeAgent.name} has no learned responsibilities`
          );
        }}
        onMakeRoutine={(draft) => {
          setLearningDialog(null);
          runtime.openRoutineDraft(draft);
        }}
        onRun={(task) => {
          setLearningDialog(null);
          void submitComposerText(task.instruction, { displayText: `Run: ${task.title}` });
        }}
      />

      <AgentTeamMissionDialog
        open={teamMissionOpen}
        agents={runtime.agents}
        activeAgentId={activeAgent.id}
        busy={conversationSubmissionBlocked}
        onClose={() => setTeamMissionOpen(false)}
        onLaunch={(command, objective) => {
          setTeamMissionOpen(false);
          void submitComposerText(command, { displayText: `Team up: ${objective}` });
        }}
      />

      <WorkspaceSearchModal
        open={workspaceSearchOpen}
        items={workspaceSearchItems}
        onClose={() => setWorkspaceSearchOpen(false)}
        onSelect={selectWorkspaceSearchItem}
      />

      {isSettingsActive ? (
        <div className="settings-modal-backdrop" role="presentation">
          <section
            ref={settingsModalRef}
            className="settings-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-modal-title"
            tabIndex={-1}
          >
            <aside className="settings-modal__nav" aria-label="Settings sections">
              <label className="settings-modal__search">
                <MagnifyingGlass size={15} aria-hidden="true" />
                <span className="sr-only">Search settings</span>
                <input
                  ref={settingsSearchRef}
                  type="search"
                  placeholder="Search settings"
                  value={settingsModalSearch}
                  onChange={(event) => setSettingsModalSearch(event.target.value)}
                />
              </label>
              <nav className="settings-modal__tab-list" aria-label="Settings">
                {visibleSettingsTabs.map((tab) => {
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      className={activeSettingsTab === tab.id ? "settings-modal__tab settings-modal__tab--active" : "settings-modal__tab"}
                      aria-current={activeSettingsTab === tab.id ? "page" : undefined}
                      onClick={() => handleSelectSettingsTab(tab.id)}
                    >
                      {tab.label}
                    </button>
                  );
                })}
              </nav>
            </aside>
            <div className="settings-modal__content">
              <button
                type="button"
                className="settings-modal__close"
                aria-label="Close settings"
                onClick={closeSettingsModal}
              >
                <X size={17} />
              </button>
              <Suspense fallback={null}>
                <SettingsPage
                  runtime={runtime}
                  theme={theme}
                  onThemeChange={setTheme}
                  activeTab={activeSettingsTab}
                  workspaceName={workspaceName}
                  dictationCapability={voice.capability}
                  titleId="settings-modal-title"
                />
              </Suspense>
            </div>
          </section>
        </div>
      ) : null}

      {workspaceSettingsOpen ? (
        <div className="settings-modal-backdrop" role="presentation">
          <section
            ref={workspaceSettingsModalRef}
            className="settings-modal settings-modal--workspace"
            role="dialog"
            aria-modal="true"
            aria-labelledby="workspace-settings-modal-title"
            tabIndex={-1}
          >
            <div className="settings-modal__content">
              <button
                ref={workspaceSettingsCloseRef}
                type="button"
                className="settings-modal__close"
                aria-label="Close workspace settings"
                onClick={closeWorkspaceSettings}
              >
                <X size={17} />
              </button>
              <section className="settings-page" aria-labelledby="workspace-settings-modal-title">
                <div className="settings-page__content">
                  <div className="settings-page__header">
                    <h1 id="workspace-settings-modal-title">{workspaceName}</h1>
                  </div>
                  <Suspense fallback={null}>
                    <WorkspaceSettingsView
                      key={invitationContextKey}
                      workspaceName={workspaceName}
                      fableWorkspaceId={runtime.accountWorkspaceStatus.activeWorkspace.fableWorkspaceId ?? null}
                      accountContextKey={invitationContextKey}
                      onInvitationAccepted={async () => {
                        await runtime.reconcileAccountWorkspace();
                      }}
                      onStatus={(message) => {
                        setWorkspaceSettingsStatus(message);
                        runtime.setLastAction(message);
                      }}
                    />
                  </Suspense>
                  {workspaceSettingsStatus ? (
                    <p className="settings-status" role="status">
                      {workspaceSettingsStatus}
                    </p>
                  ) : null}
                </div>
              </section>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
