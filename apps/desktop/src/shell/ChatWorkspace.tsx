import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { parseComposerText } from "@fable/connectors";
import type { KnowledgeCitation, Spine } from "@fable/protocol";
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
import { isCitedBriefMissionPlanSummary, isCitedBriefMissionPrompt, isCitedBriefMissionReceipt, type CitedBriefMissionPlanSummary, type CitedBriefMissionReceipt } from "../lib/cited-brief-mission";
import { startStructuredIntakeMission, structuredIntakeSubject } from "../lib/structured-intake-mission";
import { artifactRevisionBriefFocus, startArtifactRevisionBriefMission } from "../lib/artifact-revision-brief-mission";
import { executeParallelApproachesMission, isParallelApproachesMissionPrompt, isParallelApproachesPlanSummary, resumeReviewedParallelApproachesMissions, type ParallelApproachesPlanSummary } from "../lib/parallel-approaches-mission";
import { parseGeneralMissionDraft } from "../lib/general-mission-command";
import { createDesktopDurableRunWriter } from "../hooks/useDurableConversation";
import { WorkspaceSidebar, type SidebarProject } from "../components/WorkspaceSidebar";
import { Composer } from "../components/Composer";
import { ResponseArtifactAction } from "../components/ResponseArtifactAction";
import { finalizeRuntimeMissionCoordination, getRuntimeArtifact, listRuntimePendingCitedApprovals, listRuntimePendingMissionApprovals, listRuntimePendingMissionHumanInputs, listRuntimeThreadArtifacts, listRuntimeThreadMissionProgress, readRuntimeCitedMissionPlanSummaries, readRuntimeCitedMissionReceipts, readRuntimeMissionProgress, receiveRuntimeMissionHumanInput, recordRuntimeMissionHumanEvaluation, recoverRuntimeCompletedParallelApproaches, resolveRuntimeCitedApproval, resolveRuntimeMissionApproval, searchRuntimeArtifacts, type RuntimeArtifactBundle, type RuntimeCitedApproval, type RuntimeMissionApproval, type RuntimeMissionHumanInputRequest, type RuntimeMissionHumanInputValue, type RuntimeMissionProgress, type RuntimeThreadMissionProgress } from "../runtime";
import { ConnectorIcon } from "../components/ConnectorIcon";
import { CitationResults, CitedApprovalCard, DirectiveCards, MissionEffectApprovalCard, MissionHumanInputCard, MissionPlanSummary, MissionPlanUnavailable, MissionProgressSummary, MissionRunReceipt, NewCitedMissionAction, ParallelMissionPlanSummary, ProviderRouteSummary, RunContextSummary, citationsForRun, type MissionHumanInputArtifactOption } from "../components/workspace-cards";
import { tabs as settingsTabs } from "../components/pages/settings-tabs";
import type { SettingsTab } from "../components/pages/settings-tabs";
import { composerModelsFor } from "./composer-models";
import { ShellPageBoundary } from "./ShellRoutes";
import { useShellAgentController } from "./useShellAgentController";
import { useProjects } from "../hooks/useProjects";
import { invitationAccountContextKey } from "../lib/invitation-account-context";
import { ProjectPage, type ProjectKnowledgeSourceView, type ProjectKnowledgeView, type ProjectMemoryView } from "../components/pages/ProjectPage";
import { useProjectKnowledge } from "../hooks/useProjectKnowledge";
import { useProjectMemory } from "../hooks/useProjectMemory";
import { useProjectActivity } from "../hooks/useProjectActivity";
import { useModalFocusTrap } from "../hooks/useModalFocusTrap";

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
};

function messageId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function matchesTerminalGeneralRetryStatus(
  status: Spine.Missions.RunStatus
): boolean {
  return status === "partially-completed"
    || status === "failed"
    || status === "cancelled";
}
// Standalone pages are code-split: each is only rendered when navigated to, so
// loading them lazily keeps the initial workspace bundle small. Named exports
// are adapted to the lazy() default-export contract via `.then`. Suspense
// fallbacks are minimal (no layout shift) - the heaviest of these (Settings)
// pulls in Run History, Schedule panel, and provider rendering on demand.
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
  const { runtime, agent, durableConversation, voice, scheduledActive, citedMissionRunning, runCitedBrief, stopCurrentWork, resetCancellation } = controller;
  const [conversationMessages, setConversationMessages] = useState<ConversationMessage[]>([]);
  const [hydratedMissionReceipts, setHydratedMissionReceipts] = useState<{
    key: string;
    receipts: Record<string, CitedBriefMissionReceipt>;
  }>({ key: "", receipts: {} });
  const [hydratedMissionPlans, setHydratedMissionPlans] = useState<{
    key: string;
    plans: Record<string, CitedBriefMissionPlanSummary>;
  }>({ key: "", plans: {} });
  const [threadArtifacts, setThreadArtifacts] = useState<RuntimeArtifactBundle[]>([]);
  const [pendingCitedApprovals, setPendingCitedApprovals] = useState<RuntimeCitedApproval[]>([]);
  const [approvalListWarning, setApprovalListWarning] = useState<string | null>(null);
  const [approvalBusyRunId, setApprovalBusyRunId] = useState<string | null>(null);
  const [approvalErrors, setApprovalErrors] = useState<Record<string, string>>({});
  const [pendingMissionApprovals, setPendingMissionApprovals] = useState<RuntimeMissionApproval[]>([]);
  const [missionApprovalListWarning, setMissionApprovalListWarning] = useState<string | null>(null);
  const [missionApprovalBusyRunId, setMissionApprovalBusyRunId] = useState<string | null>(null);
  const [missionApprovalErrors, setMissionApprovalErrors] = useState<Record<string, string>>({});
  const [pendingMissionInputs, setPendingMissionInputs] = useState<RuntimeMissionHumanInputRequest[]>([]);
  const [missionInputListWarning, setMissionInputListWarning] = useState<string | null>(null);
  const [missionInputBusyRunId, setMissionInputBusyRunId] = useState<string | null>(null);
  const [missionInputErrors, setMissionInputErrors] = useState<Record<string, string>>({});
  const [missionInputArtifactOptions, setMissionInputArtifactOptions] = useState<Record<string, {
    loading: boolean;
    options: MissionHumanInputArtifactOption[];
    error?: string;
  }>>({});
  const [pendingMissionProgress, setPendingMissionProgress] = useState<Record<string, {
    loading: boolean;
    progress?: RuntimeMissionProgress;
    error?: string;
  }>>({});
  const [threadMissionProgress, setThreadMissionProgress] = useState<RuntimeThreadMissionProgress[]>([]);
  const [threadMissionProgressWarning, setThreadMissionProgressWarning] = useState<string | null>(null);
  const [missionReviewState, setMissionReviewState] = useState<Record<string, {
    busyCriterion?: string;
    error?: string;
  }>>({});
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [submissionInFlight, setSubmissionInFlight] = useState(false);
  const [parallelMissionRunning, setParallelMissionRunning] = useState(false);
  const parallelMissionCancellationRef = useRef<(() => Promise<void>) | null>(null);
  const [generalMissionRunning, setGeneralMissionRunning] = useState(false);
  const generalMissionCancellationRef = useRef<(() => Promise<void>) | null>(null);
  const [newMissionSourceMessageId, setNewMissionSourceMessageId] = useState<string | null>(null);
  const [newThreadProjectId, setNewThreadProjectId] = useState<string | null>(null);
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

  const appendConversationMessage = (role: ConversationMessage["role"], content: string) => {
    const id = messageId(role);
    setConversationMessages((current) => [...current, { id, role, content }]);
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
      threads: []
    })),
    [projectStore.archivedProjects]
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
  }), [projectKnowledge.actionStatus, projectKnowledge.error, projectKnowledge.importFile, projectKnowledge.loading, projectKnowledge.refresh, projectKnowledge.remove, projectKnowledge.search, projectKnowledge.sources, projectKnowledge.toggleDisabled, projectKnowledge.updateFile]);
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

  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !agent.state.running) void durableConversation.refresh();
    wasRunning.current = agent.state.running;
  }, [agent.state.running, durableConversation.refresh]);

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
          const sourceCommand = sourceRequest ? parseComposerText(sourceRequest.content) : null;
          const canCreateRoutine =
            message.role === "assistant" &&
            Boolean(message.runId) &&
            Boolean(sourceRequest?.content.trim()) &&
            !message.missionOutcome &&
            !agent.state.recoverableRuns.some((run) => run.id === message.runId) &&
            !(agent.state.running && agent.state.currentRunId === message.runId);
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
              className={`conversation-message conversation-message--${message.role}`}
            >
              <p>{message.content}</p>
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
                <section aria-label="Mission artifacts">
                  {missionArtifacts.map((entry) => (
                    <ResponseArtifactAction
                      key={entry.artifact.id}
                      threadId={selectedConversationThreadId ?? ""}
                      messageId={`${message.id}-${entry.artifact.id}`}
                      runId={message.runId ?? ""}
                      content={entry.currentVersion.content.kind === "inline"
                        ? entry.currentVersion.content.text
                        : message.content}
                      citations={[]}
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
              {canCreateRoutine && sourceRequest ? (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() =>
                    runtime.openRoutineDraft({
                      title:
                        sourceRequest.content.trim().split(/[.!?\n]/)[0]?.slice(0, 160) ||
                        "Saved routine",
                      instruction: sourceRequest.content
                    })
                  }
                >
                  Run this again later
                </button>
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
                && (!message.missionOutcome || existingArtifact) ? (
                <ResponseArtifactAction
                  threadId={selectedConversationThreadId ?? ""}
                  messageId={message.id}
                  runId={message.runId}
                  content={message.content}
                  citations={citationsForRun(message.runId, agent.state.contextReceipts)}
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
    const visibleAgentError = agent.state.noTransport ? null : agent.state.lastError;

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
        {agent.state.usage ||
        visibleAgentError ||
        agent.state.running ||
        visibleRecoverableRuns.length > 0 ? (
          <section className="agent-panel" aria-label="Agent activity">
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
            {agent.state.usage ? (
              <p className="agent-panel__usage">
                {agent.state.usage.inputTokens} in · {agent.state.usage.outputTokens} out · {" "}
                {agent.state.usage.costUnknown
                  ? "cost unknown"
                  : `$${agent.state.usage.costUsd.toFixed(6)}${
                      agent.state.usage.costEstimated ? " estimated" : ""
                    }`}
              </p>
            ) : null}
            {agent.state.running ? (
              <p className="agent-panel__running">
                {agent.state.status === "awaiting-approval"
                  ? "Waiting for approval…"
                  : agent.state.status === "retrying"
                    ? "Retrying provider…"
                    : "Running…"}
                <button
                  type="button"
                  className="agent-panel__stop"
                  onClick={() => {
                    void agent.cancel();
                  }}
                >
                  Stop
                </button>
              </p>
            ) : null}
            {visibleAgentError ? (
              <p className="agent-panel__error">{visibleAgentError}</p>
            ) : null}
          </section>
        ) : null}
      </>
    );
  };

  const liveStatusLead = /[.!?]$/.test(runtime.lastAction)
    ? runtime.lastAction
    : `${runtime.lastAction}.`;
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
  async function submitComposerText(rawText: string) {
    const submitted = rawText.trim();
    const parsed = parseComposerText(submitted);
    const stopRequested = parsed.status === "command" && parsed.request.name === "stop";
    if (!submitted || ((agent.state.running || parallelMissionRunning || generalMissionRunning || pendingPrompt) && !stopRequested)) return;
    if (!selectedConversationThreadId) {
      setSubmissionInFlight(true);
      const thread = await durableConversation.createThread({
        authorityScope: { authority: "local", visibility: "member-private", ownerMemberId: "current-member" as never },
        ...(newThreadProjectId ? { projectId: newThreadProjectId as never } : {}),
        title: submitted.slice(0, 72)
      });
      await durableConversation.deleteDraft();
      setSelectedConversationThreadId(thread.id);
      setConversationMessages([{ id: messageId("user"), role: "user", content: submitted }]);
      setPendingPrompt(submitted);
      return;
    }
    appendConversationMessage("user", submitted);
    void continueComposerSubmission(submitted);
  }

  async function continueComposerSubmission(submitted: string) {
    // The explicit local intake journey owns this narrow phrase before the
    // broader natural-language /plan parser can interpret "project brief".
    if (structuredIntakeSubject(submitted)) {
      runPrompt(submitted, { appendUserMessage: false });
      return;
    }
    const outcome = parseComposerText(submitted);
    if (outcome.status === "command") {
      if (outcome.request.name === "mission") {
        await runGeneralMissionCommand(submitted, outcome.request.args);
        return;
      }
      const result = await runtime.runFableCommand(outcome.request, { stopCurrentWork: stopActiveWork });
      // Clear the composer so the command token doesn't also reach the model
      // as ordinary prompt text. A follow-up prompt (if any) is submitted
      // through the same agent path as a normal prompt.
      runtime.setComposerValue("");
      appendConversationMessage("assistant", result.message);
      if (result.status === "ok" && result.followUpPrompt) {
        runPrompt(result.followUpPrompt, { appendUserMessage: false });
      }
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
        "Use /mission with a short title, then two to six total steps. Start with at least two bullet tasks, optionally add “all: …” or “any: …”, add short “then: …” stages, or add one “review: …” and “revise: …” pair. Finish with up to four exact “accept: …” criteria."
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
      + (draft.join
        ? 1 + (draft.join.then?.length ?? 0) + (draft.join.review ? 2 : 0)
        : 0);
    const preparationLabel = draft.join
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
    const nativeConnected = runtime.connectedAgentBackend?.backendType === "native-api"
      ? runtime.connectedAgentBackend
      : undefined;
    if (!nativeConnected) {
      if (options.forceCitedMission) {
        const error = "Starting a new cited mission requires a connected native model provider.";
        agent.reportError(error);
        appendConversationMessage("assistant", error);
        finishNewMissionLaunch();
        return;
      }
      runtime.submitPrompt(prompt);
      runtime.setComposerValue("");
      finishNewMissionLaunch();
      return;
    }
    const validation = validateModelSelection(
      nativeConnected.id,
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
      void executeParallelApproachesMission({
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
      }).then((result) => {
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
    const request = buildAgentRequest({
      model: resolvedComposerModelId,
      prompt,
      maxTokens: validation.maxTokens
    });
    const assistantMessageId = appendConversationMessage("assistant", "Working...");
    activeAssistantMessageId.current = assistantMessageId;
    resetCancellation();
    const projectContext = runProjectId ? projectMemory.loadContextRecords() : Promise.resolve([]);
    void projectContext
      .then((projectMemoryRecords) => runtime.assembleKnowledgeContext(prompt, {
        projectId: runProjectId,
        projectMemoryRecords
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
      await continueComposerSubmission(sourceCommand);
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
        current.setLastAction("Search ready");
        current.focusComposer("Search ");
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

  const openConversation = (thread: SidebarProject["threads"][number], context: string) => {
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

  return (
    <main
      className={`desktop-frame${sidebarCollapsed ? " desktop-frame--sidebar-collapsed" : ""}`}
      data-theme={theme}
    >
      <WorkspaceSidebar
        workspaceName={workspaceName}
        utilityItems={utilityItems}
        activeItem={runtime.activeItem}
        profile={verifiedProfile}
        expandedCollections={expandedCollections}
        expandedProjects={expandedProjects}
        projects={projectWorkspaces}
        archivedProjects={archivedProjectWorkspaces}
        projectsLoading={projectStore.loading}
        projectsError={projectStore.error}
        chatThreads={standaloneThreads}
        mobileNavOpen={runtime.mobileNavOpen}
        collapsed={sidebarCollapsed}
        loadingItemIds={loadingItemIds}
        isSettingsActive={false}
        activeSettingsTab={activeSettingsTab}
        onSelectSettingsTab={handleSelectSettingsTab}
        canNavigateBack={navigationIndex > 0}
        canNavigateForward={navigationIndex < navigationHistory.current.length - 1}
        onNavigateBack={() => navigateHistory(-1)}
        onNavigateForward={() => navigateHistory(1)}
        onCloseSettings={closeSettingsModal}
        onNewChat={() => startNewChat(null)}
        onAddProject={async (input) => { await projectStore.create(input); }}
        onNewProjectChat={(projectId) => startNewChat(projectId)}
        onRenameProject={async (project, title) => {
          await projectStore.update({ projectId: project.id as never, baseRevision: project.revision, title });
        }}
        onArchiveProject={async (project) => {
          await projectStore.archive({ projectId: project.id as never, baseRevision: project.revision });
          if (selectedProjectId === project.id) setSelectedProjectId(null);
        }}
        onRestoreProject={async (project) => {
          await projectStore.restore({ projectId: project.id as never, baseRevision: project.revision });
        }}
        onDeleteProject={async (project) => {
          await projectStore.remove({ projectId: project.id as never, baseRevision: project.revision });
          if (selectedProjectId === project.id) setSelectedProjectId(null);
          await durableConversation.refresh();
        }}
        onMoveThread={async (threadId, projectId) => {
          await durableConversation.updateThread({ threadId: threadId as never, projectId: projectId as never });
        }}
        onSearch={() => {
          runtime.setLastAction("Search ready");
          runtime.focusComposer("Search ");
        }}
        onSelectWorkspace={() => runtime.setLastAction("Workspace selector ready")}
        accountWorkspaces={runtime.accountWorkspaceStatus.workspaces}
        activeAccountWorkspaceId={runtime.accountWorkspaceStatus.activeWorkspace.fableWorkspaceId}
        workspacePending={runtime.accountWorkspacePending}
        workspaceSelectorButtonRef={workspaceSelectorButtonRef}
        onSelectAccountWorkspace={async (fableWorkspaceId) => {
          await runtime.selectAccountWorkspace(fableWorkspaceId);
          runtime.setLastAction("Workspace switched");
        }}
        onCreateAccountWorkspace={async (name) => {
          await runtime.createAccountWorkspace(name);
          runtime.setLastAction("Workspace created");
        }}
        onToggleProjects={() =>
          setExpandedCollections((current) => ({ ...current, projects: !current.projects }))
        }
        onToggleChats={() =>
          setExpandedCollections((current) => ({ ...current, chats: !current.chats }))
        }
        onSelectUtility={(label) => {
          setSelectedProjectId(null);
          runtime.setActiveItem(label);
          runtime.setLastAction(`${label} selected`);
        }}
        onOpenProject={openProject}
        onSelectProjectThread={(thread, projectTitle) => openConversation(thread, projectTitle)}
        onToggleProject={(projectId, projectTitle, expanded) => {
          setExpandedProjects((current) => ({ ...current, [projectId]: !expanded }));
          runtime.setLastAction(`${expanded ? "Collapsed" : "Expanded"} project: ${projectTitle}`);
        }}
        onToggleMobileNav={() => runtime.setMobileNavOpen((open) => !open)}
        onToggleCollapsed={() => {
          setSidebarCollapsed((collapsed) => !collapsed);
          runtime.setLastAction(sidebarCollapsed ? "Navigation opened" : "Navigation closed");
        }}
        onOpenMobileConnection={() => {
          setActiveSettingsTab("privacy");
          runtime.setActiveItem("Settings");
          runtime.setMobileNavOpen(false);
          runtime.setLastAction("Mobile approvals opened");
        }}
        onOpenWorkspaceSettings={() => {
          setWorkspaceSettingsStatus("");
          setWorkspaceSettingsOpen(true);
          runtime.setMobileNavOpen(false);
          runtime.setLastAction("Workspace settings opened");
        }}
        onSelectThread={(thread) => {
          openConversation(thread, "chat");
        }}
        onAccountMenu={(item) => {
          if (item === "logout") {
            void runtime.signOutIdentity();
            runtime.setLastAction("Signing out of Fable account");
            return;
          }

          const page = item === "profile" ? "Profile" : "Settings";
          runtime.setActiveItem(page);
          runtime.setMobileNavOpen(false);
          runtime.setLastAction(`${page} selected`);
        }}
      />
      <section className="workspace" aria-label="Fable workspace">
        {runtime.activePage && !isSettingsActive ? (
          <ShellPageBoundary runtime={runtime} />
        ) : selectedProject && !isSettingsActive ? (
          <div className="workspace-center workspace-center--page">
            <ProjectPage
              project={selectedProject}
              knowledge={projectKnowledgeView}
              memory={projectMemoryView}
              activity={projectActivity}
              onNewChat={() => startNewChat(selectedProject.id)}
              onSelectThread={(thread) => openConversation(thread, selectedProject.title)}
              onReload={async () => { await projectStore.refresh(); }}
              onSaveGuidance={async ({ description, instructions }) => {
                await projectStore.update({
                  projectId: selectedProject.id as never,
                  baseRevision: selectedProject.revision,
                  description,
                  instructions
                });
              }}
            />
          </div>
        ) : (
          <div className="workspace-center workspace-center--composer">
            {renderConversation()}
            <Composer
              composerRef={runtime.composerRef}
              fileInputRef={runtime.fileInputRef}
              composerValue={runtime.composerValue}
              onComposerChange={runtime.setComposerValue}
              onSubmit={(event) => {
                event.preventDefault();
                const text = runtime.composerValue;
                const parsed = parseComposerText(text);
                const stopRequested = parsed.status === "command" && parsed.request.name === "stop";
                if (!text.trim() || ((agent.state.running || parallelMissionRunning || generalMissionRunning || pendingPrompt) && !stopRequested)) return;
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
              connectedConnectors={connectedConnectorCards}
              knowledgeSources={runtime.workspaceKnowledgeSources}
              attachments={runtime.composerAttachments}
              onRemoveAttachment={runtime.removeComposerAttachment}
            />

            {renderChatContext()}
          </div>
        )}
        <p className="sr-only" aria-live="polite">
          {liveStatusLead} {runtime.managedMemoryRecords.length} memory items.{" "}
          {runtime.workspaceKnowledgeSources.length} sources. {runtime.openApprovals.length} approvals
          pending. {scheduledActive ? `Running scheduled prompt ${scheduledActive.jobId}.` : ""}
        </p>
      </section>

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
