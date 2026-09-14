import { runtimeAccountTheme } from "../runtime/domains/account";
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  CollaborationWorkItem,
  ConversationLayout,
  FableAgentProfile,
  LocalProject,
  WorkOutput,
} from "@fable/protocol";
import { useShellRuntime, type ShellRuntime } from "../hooks/useShellRuntime";
import { useLocalProjects } from "../hooks/useLocalProjects";
import { useMediaQuery } from "../hooks/useMediaQuery";
import {
  useLocalScheduleDispatcher,
  useLocalScheduleDispatchStatus,
} from "../hooks/useLocalScheduleDispatcher";
import { ExecutionApprovalRouter } from "../lib/execution-approvals";
import { activeWork, WorkspaceExecution } from "../lib/workspace-execution";
import { agentPresence, type AgentPresence } from "../lib/agent-presence";
import { promoteWorkOutputToMemory } from "../lib/work-memory";
import {
  emptyLayout,
  reduceLayout,
  restoreLayout,
  type LayoutAction,
} from "../lib/conversation-layout";
import {
  addLocalProjectShare,
  createLocalProject,
  migrateLegacyGroup,
  removeLocalProjectShare,
  updateLocalProject,
} from "../runtime/domains/local-projects";
import {
  listRuntimeExecutionAttempts,
  recoverRuntimeExecutionAttempts,
  saveRuntimeConversationDraft,
} from "../runtime";
import { hasNativeRuntimeAdapter } from "../runtime/adapters/select";
import { composerScopeKey } from "../hooks/useScopedComposer";
import { ConversationPane } from "./ConversationPane";
import {
  ConversationTabs,
  ConversationGrid,
  type NewAction,
} from "../components/conversation/ConversationTabs";
import {
  AgentSidebar,
  type AgentSidebarPreview,
} from "../components/agents/AgentSidebar";
import { SettingsModal } from "../components/settings/SettingsModal";
import { SchedulesDialog } from "../components/agents/SchedulesDialog";
import type { SettingsTab } from "../components/pages/settings-tabs";
import type { ConversationDraft } from "../components/projects/ConversationDialogs";
import { parseComputerArtifact } from "../lib/computer-artifacts";
import { useConversationDrag } from "../hooks/useConversationDrag";
const ProjectContextPanel = lazy(() => import("../components/projects/ProjectContextPanel").then(module => ({ default: module.ProjectContextPanel })));
import { SideChatList } from "../components/conversation/SideChats";
import { createSideChat, renameSideChat, setSideChatArchived, deleteSideChat } from "../lib/conversation-service";
const SearchOverlay = lazy(() => import("../components/search/SearchOverlay").then(module => ({ default: module.SearchOverlay })));
import { SearchFileDialog } from "../components/search/SearchFileDialog";
import { ConversationSummaries } from "../components/memory/ConversationSummaries";
import { navigationTargetFor } from "../lib/search/navigation";
import {
  WorkspaceRightNav,
  type NavContext,
} from "../components/navigation/WorkspaceRightNav";
const WorkModeView = lazy(() => import("../components/navigation/WorkModeView").then(module => ({ default: module.WorkModeView })));
import { scopedRoomIds, scopeWork } from "../components/navigation/work-order";
import { workPresentation } from "../components/work/WorkStatusBadge";
import "./teammate-workspace.css";

const ExecutionWorker = lazy(() =>
  import("./ExecutionWorker").then((module) => ({
    default: module.ExecutionWorker,
  })),
);
const AgentEditor = lazy(() =>
  import("../components/agents/AgentEditor").then((module) => ({
    default: module.AgentEditor,
  })),
);
const ConversationDialog = lazy(() =>
  import("../components/projects/ConversationDialogs").then((module) => ({
    default: module.ConversationDialog,
  })),
);
const PlaceConversationDialog = lazy(() =>
  import("../components/projects/ConversationDialogs").then((module) => ({
    default: module.PlaceConversationDialog,
  })),
);
const MigrateGroupDialog = lazy(() =>
  import("../components/projects/ConversationDialogs").then((module) => ({
    default: module.MigrateGroupDialog,
  })),
);
const OnboardingPage = lazy(() =>
  import("../components/pages/OnboardingPage").then((module) => ({
    default: module.OnboardingPage,
  })),
);
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
const LocalSchedules = lazy(() =>
  import("../components/settings/LocalSchedules").then((module) => ({
    default: module.LocalSchedules,
  })),
);
const AccountDialog = lazy(() =>
  import("../components/agents/AccountDialog").then((module) => ({
    default: module.AccountDialog,
  })),
);
const ComputerInspector = lazy(() =>
  import("./ComputerInspector").then((module) => ({
    default: module.ComputerInspector,
  })),
);

/** A single account/settings owner, with one execution workspace per native scope. */
export function TeammateWorkspace() {
  const [approvals] = useState(() => new ExecutionApprovalRouter());
  const current = useRef<WorkspaceExecution | null>(null);
  const runtime = useShellRuntime({
    approvalGate: approvals,
    onScopeReset: () => {
      current.current?.dispose();
      current.current = null;
    },
  });
  const account = runtime.accountWorkspaceStatus;
  const [theme, setTheme] = useState<"light" | "dark">("light");
  useEffect(() => {
    if (!account.accountBound || !hasNativeRuntimeAdapter()) return;
    let current = true;
    void runtimeAccountTheme().then(value => { if (current) setTheme(value); }).catch(() => undefined);
    return () => { current = false; };
  }, [account.accountBound]);
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  const changeTheme = (value: "light" | "dark") => {
    setTheme(value);
    if (account.accountBound && hasNativeRuntimeAdapter()) void runtimeAccountTheme(value).catch(() => undefined);
  };
  if (
    runtime.accountWorkspacePending ||
    (!runtime.runtimeSnapshotReady &&
      !runtime.runtimeSnapshotError &&
      account.accountBound)
  )
    return (
      <main className="team-loading" role="status">
        Opening your workspace…
      </main>
    );
  if (
    !account.accountBound ||
    !["ready", "offline"].includes(account.state) ||
    account.activeWorkspace.source !== "local" ||
    runtime.onboardingRequired
  )
    return (
      <Suspense fallback={<main className="team-loading" aria-busy="true" />}>
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
  const scope = `${account.activeWorkspace.localWorkspaceId}:${account.activeContextOwner?.internalUserId}:${account.activeContextOwner?.memberId ?? ""}`;
  return (
    <ActiveWorkspace
      key={scope}
      runtime={runtime}
      approvals={approvals}
      theme={theme}
      onTheme={changeTheme}
      onService={(service) => {
        current.current = service;
      }}
    />
  );
}

function ActiveWorkspace({
  runtime,
  approvals,
  theme,
  onTheme,
  onService,
}: {
  runtime: ShellRuntime;
  approvals: ExecutionApprovalRouter;
  theme: "light" | "dark";
  onTheme: (theme: "light" | "dark") => void;
  onService: (service: WorkspaceExecution) => void;
}) {
  const workspaceId =
    runtime.accountWorkspaceStatus.activeWorkspace.localWorkspaceId;
  const [service] = useState(
    () => new WorkspaceExecution(workspaceId, undefined, approvals),
  );
  onService(service);
  const state = useSyncExternalStore(
    service.subscribe,
    service.getSnapshot,
    service.getSnapshot,
  );
  const projects = useLocalProjects(
    workspaceId,
    undefined,
    hasNativeRuntimeAdapter(),
  );
  const [layout, setLayout] = useState<ConversationLayout>(emptyLayout);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const restored = useRef(false);
  const mounts = useRef(0);
  const initialized = useRef(false);
  const narrow = useMediaQuery("(max-width: 850px)");
  const phone = useMediaQuery("(max-width: 700px)");
  // One contextual right panel replaces history, details and computer panels.
  const [contextOpen, setContextOpen] = useState(!narrow);
  const [mode, setMode] = useState<"chat" | "work">("chat");
  const [navWorkId, setNavWorkId] = useState<string | null>(null);
  const [navigationCollapsed, setNavigationCollapsed] = useState(false);
  const [mobileNavigation, setMobileNavigation] = useState(false);
  const [settings, setSettings] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchFile, setSearchFile] = useState<Parameters<typeof SearchFileDialog>[0] | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [marketplace, setMarketplace] = useState<{ id?: string } | null>(null);
  const [editor, setEditor] = useState<{
    roomId?: string;
    projectId?: string;
    draft?: Partial<ConversationDraft>;
    focused?: boolean;
  } | null>(null);
  const [placeId, setPlaceId] = useState<string | null>(null);
  const [migrateId, setMigrateId] = useState<string | null>(null);
  const [agentEditor, setAgentEditor] = useState<{ id?: string } | null>(null);
  const [createdAgentId, setCreatedAgentId] = useState<string | null>(null);
  const [schedules, setSchedules] = useState<{
    agentId?: string;
    projectId?: string;
  } | null>(null);
  const [computer, setComputer] = useState<string | null>(null);
  const [accountDialog, setAccountDialog] = useState<
    "usage" | "sign-out" | null
  >(null);
  const [usage, setUsage] = useState<
    NonNullable<import("@fable/protocol").ExecutionAttempt["usage"]>[]
  >([]);
  const appendDraft = useRef<(text: string) => void>(() => undefined);
  const seen = useRef(new Map<string, string>());
  const profileName =
    runtime.identityStatus.authentication?.verifiedDisplayAttributes
      ?.displayName ??
    runtime.identityStatus.authentication?.verifiedDisplayAttributes?.email ??
    "Local workspace";
  const activeView = layout.views.find(
    (view) => view.id === layout.active[layout.activePane],
  );
  const activeRoom = state.data.conversations.find(
    (room) => room.id === activeView?.conversationId,
  );
  const activeProfile =
    runtime.agents.find((agent) => agent.id === activeRoom?.facilitatorId) ??
    runtime.agents.find((agent) => agent.id === runtime.activeAgentId) ??
    runtime.agents[0];

  // The context the right panel and modes describe: an explicitly selected
  // Work item, else the active view's loaded Project, else its Agent, else the
  // remembered active agent. A Project that has not loaded yet is not faked.
  const activeProject = projects.projects.find(
    (project) => project.id === activeRoom?.projectId,
  );
  const selectedWork =
    (navWorkId
      ? state.data.work.find((work) => work.id === navWorkId)
      : undefined) ?? null;
  const navContext: NavContext = selectedWork
    ? { kind: "work", item: selectedWork }
    : activeProject
      ? { kind: "project", project: activeProject }
      : activeProfile
        ? { kind: "agent", agent: activeProfile }
        : null;
  const navAgent =
    navContext?.kind === "agent"
      ? navContext.agent
      : navContext?.kind === "work"
        ? runtime.agents.find(
            (agent) => agent.id === navContext.item.agentId,
          ) ?? activeProfile
        : undefined;
  const navProject =
    navContext?.kind === "project"
      ? navContext.project
      : navContext?.kind === "work" && navContext.item.projectId
        ? projects.projects.find(
            (project) => project.id === navContext.item.projectId,
          )
        : undefined;
  const navTeam = state.data.teams.find(
    (team) => team.projectId === navProject?.id,
  );
  const navRoomIds = new Set(
    scopedRoomIds(navAgent?.id, navProject?.id, state.data.conversations),
  );
  const navWork =
    navContext?.kind === "work"
      ? [navContext.item]
      : scopeWork(state.data.work, {
          agentId: navContext?.kind === "agent" ? navAgent?.id : undefined,
          projectId: navProject?.id,
        });
  const navApprovals = runtime.openApprovals.filter((approval) =>
    state.sessions.some(
      (session) =>
        session.approvalIds.has(approval.id) &&
        (navContext?.kind === "work"
          ? session.work.id === navContext.item.id
          : navRoomIds.has(session.work.conversationId)),
    ),
  );
  const navSession = navAgent
    ? state.sessions.find(
        (entry) => entry.work.agentId === navAgent.id && entry.state,
      )
    : undefined;
  const navPresence: AgentPresence = (() => {
    if (!navAgent) return "idle";
    const session = navSession;
    if (session?.state)
      return agentPresence(
        session.state,
        runtime.openApprovals.some((approval) =>
          session.approvalIds.has(approval.id),
        ),
        session.work.status === "queued",
      );
    const current =
      navWork.find(activeWork) ?? navWork.at(-1) ?? undefined;
    if (!current) return "idle";
    if (current.status === "queued") return "received";
    if (current.status === "awaiting-approval") return "waiting";
    if (current.status === "awaiting-user") return "input";
    if (current.status === "failed" || current.status === "blocked")
      return "blocked";
    return "working";
  })();

  useEffect(() => {
    mounts.current++;
    if (!initialized.current) {
      initialized.current = true;
      void (async () => {
        await recoverRuntimeExecutionAttempts(new Date().toISOString());
        await service.refresh();
      })().catch((error) => service.report(error));
    }
    return () => {
      mounts.current--;
      queueMicrotask(() => {
        if (!mounts.current) service.dispose();
      });
    };
  }, [service]);
  useEffect(() => {
    for (const session of state.sessions) {
      const profile = runtime.agents.find(
        (profile) => profile.id === session.work.agentId,
      );
      if (!profile || profile.modelId !== session.work.modelOptionId) {
        session.cancelled = true;
        void session.cancel?.().catch((error) => service.report(error));
      }
    }
    void runtime
      .flushSnapshot()
      .then(() => service.refresh())
      .catch((error) => service.report(error));
  }, [runtime.agents]);
  useEffect(() => {
    if (
      !projects.loading &&
      !projects.error &&
      runtime.runtimeSnapshotReady &&
      !runtime.runtimeSnapshotError
    )
      service.admit(
        runtime.agents,
        runtime.modelOptions,
        runtime.backendProviders,
        runtime.permissionMode,
      );
  }, [
    state.revision,
    runtime.agents,
    runtime.modelOptions,
    runtime.backendProviders,
    runtime.permissionMode,
    projects.loading,
    projects.error,
  ]);
  useEffect(() => {
    if (state.loading || restored.current) return;
    restored.current = true;
    let saved = restoreLayout(
      state.data.layout,
      new Set(state.data.conversations.map((room) => room.id)),
    );
    if (!state.data.layout && state.data.conversations.length) {
      const room =
        state.data.conversations.find(
          (room) => room.id === activeProfile?.threadId,
        ) ?? state.data.conversations.at(-1)!;
      saved = reduceLayout(saved, {
        type: "open",
        view: {
          id: `view-${crypto.randomUUID()}`,
          conversationId: room.id,
          kind: "conversation",
        },
      });
    }
    setLayout(saved);
  }, [state.loading]);
  useEffect(() => {
    if (!restored.current) return;
    const timer = setTimeout(
      () =>
        void service
          .command({ action: "save-layout", layout })
          .catch((error) => service.report(error)),
      220,
    );
    return () => clearTimeout(timer);
  }, [layout, service]);
  useEffect(() => {
    if (activeRoom)
      seen.current.set(
        activeRoom.id,
        state.data.work
          .filter((work) => work.conversationId === activeRoom.id)
          .flatMap((work) => work.outputs)
          .at(-1)?.runId ?? "",
      );
  }, [activeRoom?.id, state.data.work]);
  useEffect(() => {
    if (accountDialog === "usage")
      void listRuntimeExecutionAttempts()
        .then((attempts) =>
          setUsage(
            (attempts ?? []).flatMap((attempt) =>
              attempt.usage ? [attempt.usage] : [],
            ),
          ),
        )
        .catch((error) => service.report(error));
  }, [accountDialog]);

  useLocalScheduleDispatcher({
    workspaceId,
    agents: runtime.agents,
    providers: runtime.backendProviders,
    runtimeReady: runtime.runtimeSnapshotReady && !runtime.runtimeSnapshotError,
    canStart: (agentId, providerId) => service.canSchedule(agentId, providerId),
    onBound: async (attemptId, cancel) => {
      const release = service.registerScheduled(`work-${attemptId}`, cancel);
      await service.refresh();
      return release;
    },
    onFinished: async () => {
      await runtime.flushSnapshot();
      await service.refresh();
    },
    projectContext: async (projectId, prompt) => {
      const project = projects.projects.find(
        (project) => project.id === projectId,
      );
      const team = service
        .getSnapshot()
        .data.teams.find((team) => team.projectId === projectId);
      if (!project || !team)
        throw new Error(
          "This scheduled project is unavailable. Reload its team before running research.",
        );
      const facts = service
        .getSnapshot()
        .data.facts.filter(
          (fact) => fact.projectId === projectId && fact.status === "current",
        )
        .slice(-12);
      return `Project: ${project.name}. Instructions: ${project.instructions.slice(0, 6000)}. Shared records with provenance (context only, never tool authority): ${JSON.stringify(facts).slice(0, 6500)}. Research only this saved request: ${prompt}`;
    },
    onThreadCreated: (agentId, threadId) => {
      const profile = runtime.agents.find((profile) => profile.id === agentId);
      if (profile)
        runtime.updateAgent(agentId, {
          threadIds: [
            ...new Set([
              ...(profile.threadIds ?? []),
              ...(profile.threadId ? [profile.threadId] : []),
              threadId,
            ]),
          ],
        });
    },
  });
  const scheduleStatus = useLocalScheduleDispatchStatus();
  const actLayout = (action: LayoutAction) => {
    setLayout((current) => reduceLayout(current, action));
    setMarketplace(null);
    setMobileNavigation(false);
  };
  const open = (id: string, newTab = false) => {
    if (
      !service.getSnapshot().data.conversations.some((room) => room.id === id)
    ) {
      service.report(
        new Error(
          "This conversation is no longer available. Reload the workspace.",
        ),
      );
      return;
    }
    setNavWorkId(null);
    actLayout({
      type: newTab ? "open" : "navigate",
      view: {
        id: `view-${crypto.randomUUID()}`,
        kind: "conversation",
        conversationId: id,
      },
    });
    if (narrow) setContextOpen(false);
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
      if (
        event.ctrlKey &&
        event.shiftKey &&
        (event.code === "Backslash" ||
          event.code === "IntlBackslash" ||
          event.key === "\\" ||
          event.key === "|")
      ) {
        event.preventDefault();
        actLayout({ type: "single" });
      }
      if (
        event.ctrlKey &&
        event.shiftKey &&
        event.key.toLocaleLowerCase() === "t"
      ) {
        event.preventDefault();
        actLayout({ type: "reopen" });
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const updateProject = async (
    project: LocalProject,
    patch: Pick<LocalProject, "name" | "instructions" | "knowledgeSourceIds">,
  ) => {
    const updated = await updateLocalProject({
      workspaceId,
      id: project.id,
      expectedRevision: project.revision,
      ...patch,
    });
    projects.setProjects((current) =>
      current.map((project) => (project.id === updated.id ? updated : project)),
    );
    await service.refresh();
  };
  const createRoom = async (
    draft: ConversationDraft,
    projectId?: string,
    seedText?: string,
  ) => {
    await runtime.flushSnapshot();
    const id = `thread-${crypto.randomUUID()}`;
    if (draft.kind === "project" && !projectId) {
      const project = await createLocalProject({
        workspaceId,
        id: `project-${crypto.randomUUID()}`,
        threadId: id,
        name: draft.title,
        instructions: draft.instructions,
        knowledgeSourceIds: [],
      });
      projects.setProjects((current) => [...current, project]);
      const data = await service
        .refresh()
        .then(() => service.getSnapshot().data);
      const team = data.teams.find((team) => team.projectId === project.id);
      if (!team)
        throw new Error(
          "The project was saved, but its team could not be loaded. Reload the workspace to finish setup.",
        );
      await service.command({
        action: "update-team",
        projectId: project.id,
        expectedRevision: team.revision,
        participantIds: draft.participantIds,
        leadAgentId: draft.facilitatorId || undefined,
        shareHistory: true,
      });
    } else
      await service.command({
        action: "create-conversation",
        id,
        title: draft.title,
        kind: draft.kind === "project" ? "group" : "direct",
        participantIds: draft.participantIds,
        facilitatorId: draft.facilitatorId || undefined,
        projectId,
      });
    if (seedText && draft.facilitatorId)
      await saveDraft(id, draft.facilitatorId, seedText, projectId);
    open(id, true);
    return id;
  };
  const selectAgent = async (
    agent: FableAgentProfile,
    newConversation = false,
    text?: string,
  ) => {
    if (!newConversation) {
      await runtime.flushSnapshot();
      const data = await service.command({ action: "open-main-chat", agentId: agent.id });
      const room = data.conversations.find(room => room.chat?.role === "main" && room.chat.ownerKind === "agent" && room.chat.ownerId === agent.id);
      if (!room) throw new Error("The main Chat could not be resolved.");
      open(room.id);
      return room.id;
    }
    const id = await createRoom(
      {
        kind: "direct",
        title: `Conversation with ${agent.name}`,
        instructions: "",
        participantIds: [agent.id],
        facilitatorId: agent.id,
        shareHistory: false,
      },
      undefined,
      text,
    );
    return id;
  };
  useEffect(() => {
    if (!createdAgentId) return;
    const created = runtime.agents.find(agent => agent.id === createdAgentId);
    if (!created) return;
    setCreatedAgentId(null);
    void selectAgent(created, true).catch(error => service.report(error));
  }, [createdAgentId, runtime.agents]);
  const saveDraft = async (
    threadId: string,
    agentId: string,
    text: string,
    projectId?: string,
  ) => {
    const owner = runtime.accountWorkspaceStatus.activeContextOwner;
    const draftKey = composerScopeKey({
      workspaceId,
      accountId: `${owner?.internalUserId}:${owner?.memberId ?? ""}`,
      agentId,
      projectId,
      threadId,
    });
    await saveRuntimeConversationDraft(
      {
        draftKey,
        threadId,
        content: JSON.stringify({ text, attachments: [] }),
        updatedAt: new Date().toISOString(),
      },
      workspaceId,
    );
  };
  const editingRoom = state.data.conversations.find(
    (room) => room.id === editor?.roomId,
  );
  const editingProject = projects.projects.find(
    (project) => project.id === editor?.projectId,
  );
  const editingTeam = state.data.teams.find(
    (team) => team.projectId === editingProject?.id,
  );
  const indicators = Object.fromEntries(
    state.data.conversations.map((room) => {
      const work = state.data.work.filter(
        (work) => work.conversationId === room.id,
      );
      const latest = work.at(-1);
      const needsInput = work.some((item) =>
        ["awaiting-user", "blocked"].includes(item.status),
      );
      return [
        room.id,
        work.some((work) => work.status === "awaiting-approval")
          ? "Approval needed"
          : work.some(activeWork)
            ? "Working"
            : needsInput || latest?.status === "failed"
              ? "Needs attention"
              : latest?.outputs.at(-1)?.runId &&
                  seen.current.get(room.id) !== latest.outputs.at(-1)?.runId
                ? "Unread"
                : "",
      ];
    }),
  );
  const previews: Record<string, AgentSidebarPreview> = Object.fromEntries(
    runtime.agents.map((agent) => {
      const agentWork = state.data.work.filter(
        (work) => work.agentId === agent.id,
      );
      const current = agentWork.find(activeWork) ?? agentWork.at(-1);
      const session = state.sessions.find(
        (entry) => entry.work.agentId === agent.id && entry.state,
      );
      const awaitingApproval = session
        ? runtime.openApprovals.some((approval) =>
            session.approvalIds.has(approval.id),
          )
        : current?.status === "awaiting-approval";
      // Detailed execution text stays out of the sidebar: it shows the unified
      // state, while approvals and failures outrank another item completing.
      const presence: AgentPresence = session?.state
        ? agentPresence(
            session.state,
            awaitingApproval,
            session.work.status === "queued",
          )
        : awaitingApproval
          ? "waiting"
          : current?.status === "awaiting-user"
            ? "input"
            : current && ["failed", "blocked"].includes(current.status)
              ? "blocked"
              : current?.status === "queued"
                ? "received"
                : current && activeWork(current)
                  ? "working"
                  : "idle";
      return [
        agent.id,
        {
          message: current
            ? workPresentation(current).label
            : "Open a conversation",
          time: "",
          presence,
          status:
            awaitingApproval || (current && ["failed", "blocked", "awaiting-user"].includes(current.status))
              ? "attention"
              : current && activeWork(current)
                ? "running"
                : "idle",
        },
      ];
    }),
  );
  const newConversation = () => {
    if (activeRoom && activeRoom.participants.length)
      void createRoom(
        {
          kind: activeRoom.kind === "group" ? "project" : "direct",
          title: activeProject
            ? "New conversation"
            : activeRoom.kind === "group"
              ? activeRoom.title
              : "Conversation with " + (activeProfile?.name ?? "agent"),
          instructions: "",
          participantIds: activeRoom.participants.map(
            (member) => member.agentId,
          ),
          facilitatorId: activeRoom.facilitatorId ?? "",
          shareHistory: false,
        },
        activeRoom.projectId,
      ).catch((error) => service.report(error));
    else if (activeProfile)
      void selectAgent(activeProfile, true).catch((error) =>
        service.report(error),
      );
    else setAgentEditor({});
  };
  // Contextual New: it names and creates the relevant object for the selected
  // Agent, Project or workspace, never an implicit generic conversation.
  const newSideChat = () => {
    if (navContext?.kind === "agent") {
      void createRoom(
        {
          kind: "direct",
          title: `Side chat with ${navContext.agent.name}`,
          instructions: "",
          participantIds: [navContext.agent.id],
          facilitatorId: navContext.agent.id,
          shareHistory: false,
        },
        undefined,
      ).catch((error) => service.report(error));
      return;
    }
    if (navProject && navTeam) {
      const facilitatorId =
        navTeam.leadAgentId ?? "";
      void createRoom(
        {
          kind: "project",
          title: `Side chat in ${navProject.name}`,
          instructions: "",
          participantIds: navTeam.participantIds,
          facilitatorId,
          shareHistory: false,
        },
        navProject.id,
      ).catch((error) => service.report(error));
      return;
    }
    setEditor({
      draft: {
        kind: "direct",
        ...(activeProfile
          ? {
              participantIds: [activeProfile.id],
              facilitatorId: activeProfile.id,
            }
          : {}),
      },
    });
  };
  const newActions: NewAction[] =
    navContext?.kind === "agent"
      ? [
          {
            id: "side-chat",
            label: `New side chat with ${navContext.agent.name}`,
            run: newSideChat,
          },
        ]
      : navProject
        ? [
            {
              id: "side-chat",
              label: `New side chat in ${navProject.name}`,
              run: newSideChat,
            },
          ]
        : [
            {
              id: "agent",
              label: "New agent",
              run: () => setAgentEditor({}),
            },
            {
              id: "project",
              label: "New project",
              run: () =>
                setEditor({
                  draft: {
                    kind: "project",
                    ...(activeProfile
                      ? { participantIds: [activeProfile.id] }
                      : {}),
                  },
                }),
            },
          ];
  const onConversationPointerDown = useConversationDrag(
    layout,
    actLayout,
    open,
    !narrow,
  );
  // Narrow shared work actions: the shell routes Work UI callbacks to the
  // service, keeping result snapshots out of the component contracts.
  const stopWork = (id: string) => service.stop(id);
  const continueWork = (id: string, generation: number) =>
    service
      .command({
        action: "continue-work",
        id,
        expectedGeneration: generation,
        reconcile: true,
      })
      .then(() => undefined);
  const steerWork = (id: string, generation: number, text: string) =>
    service.steer(id, generation, text).then(() => undefined);
  const promoteWorkOutput = async (
    output: WorkOutput,
    workItem: CollaborationWorkItem,
    value: string,
  ) => {
    await promoteWorkOutputToMemory(
      workItem,
      output,
      value,
      runtime.memoryState,
    );
  };
  const selectNavWork = (id: string | null) => {
    setNavWorkId(id);
    if (id) {
      setMode("work");
      setContextOpen(true);
    }
  };
  const navProjectRoom =
    navProject && activeRoom?.projectId === navProject.id
      ? activeRoom
      : navProject
        ? state.data.conversations.find(
            (room) => room.id === navProject.threadId,
          )
        : undefined;
  return (
    <main
      onPointerDownCapture={onConversationPointerDown}
      className={`desktop-frame desktop-frame--agents desktop-frame--live-closed teammates-workspace${navigationCollapsed ? " teammates-workspace--collapsed" : ""}${contextOpen || computer ? " teammates-workspace--history" : ""}`}
      data-theme={theme}
      data-mobile-navigation={mobileNavigation}
    >
      {searchOpen ? <Suspense fallback={null}><SearchOverlay workspaceId={workspaceId} open={searchOpen} onClose={() => setSearchOpen(false)}
        enabled={!runtime.accountWorkspacePending}
        dataRevision={JSON.stringify([state.data, runtime.agents, runtime.workspaceKnowledgeSources, projects.projects])}
        onOpenResult={result => {
          const target = navigationTargetFor(result);
          if (!target || target.workspaceId !== workspaceId) { service.report(new Error("This result is unavailable.")); return; }
          setSearchOpen(false);
          setMarketplace(null);
          setMode("chat");
          if (target.type === "conversation") open(target.conversationId);
          else if (target.type === "project") open(target.threadId);
          else if (target.type === "work") { open(target.conversationId); setNavWorkId(target.workId); setContextOpen(true); }
          else if (target.type === "agent") {
            const room = state.data.conversations.find(room => room.chat?.role === "main" && room.chat.ownerKind === "agent" && room.chat.ownerId === target.agentId);
            if (room) open(room.id); else setAgentEditor({ id: target.agentId });
          } else {
            const source = target.type === "knowledge-file" ? runtime.workspaceKnowledgeSources.find(source => source.id === target.sourceId && !source.deletedAt && !source.disabled) : undefined;
            setSearchFile({ target, title: result.title, text: source?.contentPreview ?? (target.type === "knowledge-file" ? "This source has no text preview." : undefined), onClose: () => setSearchFile(null) });
          }
        }} /></Suspense> : null}
      {searchFile ? <SearchFileDialog key={JSON.stringify(searchFile.target)} {...searchFile} /> : null}
      <AgentSidebar
        onSearch={() => setSearchOpen(true)}
        collapsed={navigationCollapsed && !phone}
        hidden={phone && !mobileNavigation}
        onToggleCollapsed={() => setNavigationCollapsed(!navigationCollapsed)}
        agents={runtime.agents}
        projects={projects.projects}
        selectedProjectId={activeRoom?.projectId}
        activeAgentId={activeProfile?.id ?? ""}
        selectedConversationId={activeRoom?.id}
        previews={previews}
        profileName={profileName}
        connectors={runtime.connectorManifests}
        marketplaceActive={Boolean(marketplace)}
        conversations={state.data.conversations.map((room) => ({
          ...room,
          status: indicators[room.id],
        }))}
        onSelectConversation={open}
        onCreateProject={() => setEditor({ draft: { kind: "project", ...(activeProfile ? { participantIds: [activeProfile.id] } : {}) } })}
        onSelectProject={(project) => {
          const saved = projects.projects.find(
            (item) => item.id === project.id,
          );
          if (saved) open(saved.threadId);
        }}
        onSelectAgent={(agent) =>
          void selectAgent(agent).catch((error) => service.report(error))
        }
        onCreateAgent={() => setAgentEditor({})}
        onEditAgent={(agent) => setAgentEditor({ id: agent.id })}
        onOpenMarketplace={() => setMarketplace({})}
        onOpenSettings={() => setSettings(true)}
        onOpenUsage={() => setAccountDialog("usage")}
        onSignOut={() => setAccountDialog("sign-out")}
      />
      <section className="workspace-views" aria-label="Conversation workspace">
        <div
          className="workspace-mode-bar"
          role="tablist"
          aria-label="Workspace mode"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === "chat"}
            onClick={() => setMode("chat")}
          >
            Chat
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "work"}
            onClick={() => setMode("work")}
          >
            Work
          </button>
        </div>
        {mode === "chat" && !marketplace ? (
          <ConversationTabs
            layout={layout}
            titles={Object.fromEntries(
              state.data.conversations.map((room) => [room.id, room.title]),
            )}
            indicators={indicators}
            descriptions={Object.fromEntries(state.data.conversations.map(room => [room.id, [projects.projects.find(project => project.id === room.projectId)?.name, room.participants.map(member => member.name).join(", ")].filter(Boolean).join(" · ")]))}
            onAction={actLayout}
            onCreate={newConversation}
            newActions={newActions}
          />
        ) : null}
        <button
          type="button"
          className="workspace-history-toggle"
          aria-label={contextOpen ? "Hide context" : "Show context"}
          title={contextOpen ? "Hide context" : "Show context"}
          aria-expanded={contextOpen}
          onClick={() => {
            if (computer) {
              setComputer(null);
              setContextOpen(true);
              return;
            }
            setContextOpen(!contextOpen);
          }}
        >
          ◷
        </button>
        {phone ? (
          <button
            type="button"
            className="workspace-navigation-toggle"
            onClick={() => setMobileNavigation(!mobileNavigation)}
          >
            {mobileNavigation
              ? "Return to conversation"
              : "Agents & conversations"}
          </button>
        ) : null}
        {state.error || runtime.runtimeSnapshotError || projects.error ? (
          <div className="workspace-error" role="alert">
            <span>
              {state.error || runtime.runtimeSnapshotError || projects.error}
            </span>
            <button
              type="button"
              onClick={() => {
                service.clearError();
                void Promise.all([service.refresh(), projects.refresh()]).catch(
                  (error) => service.report(error),
                );
              }}
            >
              Reload
            </button>
            <button
              type="button"
              aria-label="Dismiss workspace notice"
              onClick={() => service.clearError()}
            >
              ×
            </button>
          </div>
        ) : null}
        {scheduleStatus.phase !== "idle" && scheduleStatus.message ? (
          <div className="workspace-schedule-status" role="status">
            {scheduleStatus.message}
            <button type="button" onClick={() => setSchedules({})}>
              View schedules
            </button>
          </div>
        ) : null}
        {marketplace ? (
          <Suspense fallback={<p role="status">Loading plugins…</p>}>
            <MarketplacePage
              initialConnectorId={marketplace.id}
              onBack={() => setMarketplace(null)}
              workspaceId={workspaceId}
              manifests={runtime.connectorManifests.filter(
                (connector) => connector.id !== "local-files",
              )}
              accounts={runtime.connectorAccounts}
              connectorStatus={runtime.connectorStatus}
              onUseConnector={(connector, prompt) => {
                appendDraft.current(`@${connector.id} ${prompt ?? ""}`);
                setMarketplace(null);
              }}
              onUseBuiltinPlugin={(id) => {
                appendDraft.current(`@${id} `);
                setMarketplace(null);
              }}
              onConnect={runtime.connectConnector}
              onDisconnect={runtime.disconnectConnector}
              onRefresh={(id) => void runtime.refreshConnector(id)}
              onSelectConnector={(connector) =>
                void runtime.loadConnectorAccounts(connector.id)
              }
              onSwitchAccount={(id, connectionId) =>
                void runtime.switchConnectorAccount(id, connectionId)
              }
            />
          </Suspense>
        ) : mode === "work" ? (
          <Suspense fallback={<p role="status">Loading work…</p>}><WorkModeView
            project={navProject}
            agent={navAgent}
            work={navWork}
            runtime={runtime}
            service={service}
            approvals={navApprovals}
            selectedWork={selectedWork ?? undefined}
            onOpen={open}
            onOpenWork={selectNavWork}
            onStopWork={stopWork}
            onContinueWork={continueWork}
            onSteerWork={steerWork}
            onPromoteWorkOutput={promoteWorkOutput}
            onOpenArtifact={(output, agentId) => {
              const artifact = parseComputerArtifact(output);
              const conversationId =
                activeRoom?.id ?? state.data.conversations[0]?.id;
              if (!artifact || !conversationId) return;
              setMode("chat");
              actLayout({
                type: "open",
                view: {
                  id: `view-${crypto.randomUUID()}`,
                  conversationId,
                  kind: "artifact",
                  output,
                  agentId,
                  title: artifact.title,
                },
              });
            }}
            onOpenComputer={(agentId) => {
              setComputer(agentId);
              setContextOpen(true);
            }}
            onSchedules={() =>
              setSchedules({
                agentId: navAgent?.id,
                projectId: navProject?.id,
              })
            }
            onOpenPlugins={() => setMarketplace({})}
          /></Suspense>
        ) : (
          <ConversationGrid
            layout={layout}
            compact={narrow}
            onAction={actLayout}
            renderPane={(pane) => {
              const view = layout.views.find(
                (view) => view.id === layout.active[pane],
              );
              const room = state.data.conversations.find(
                (room) => room.id === view?.conversationId,
              );
              const project = projects.projects.find(
                (project) => project.id === room?.projectId,
              );
              return (
                <section
                  className={`conversation-pane${pane === layout.activePane ? " conversation-pane--active" : ""}`}
                  onFocusCapture={() => {
                    if (view && pane !== layout.activePane)
                      actLayout({ type: "activate", id: view.id });
                  }}
                  onPointerDown={() => {
                    if (view && pane !== layout.activePane)
                      actLayout({ type: "activate", id: view.id });
                  }}
                >
                  <div
                    role="tabpanel"
                    id={view ? `panel-${view.id}` : undefined}
                    aria-labelledby={view ? `tab-${view.id}` : undefined}
                    className="conversation-panel"
                    tabIndex={0}
                  >
                    {view && room ? (
                      <ConversationPane
                        key={view.id}
                        view={view}
                        room={room}
                        project={project}
                        runtime={runtime}
                        service={service}
                        state={state}
                        active={pane === layout.activePane}
                        profileName={profileName}
                        onOpenWork={selectNavWork}
                        onClose={() =>
                          actLayout({ type: "close", id: view.id })
                        }
                        onArtifact={(output, agentId) => {
                          const artifact = parseComputerArtifact(output);
                          if (!artifact) return;
                          actLayout({
                            type: "open",
                            pane,
                            view: {
                              id: `view-${crypto.randomUUID()}`,
                              conversationId: room.id,
                              kind: "artifact",
                              output,
                              agentId,
                              title: artifact.title,
                            },
                          });
                        }}
                        onEdit={() =>
                          setEditor(
                            project
                              ? { projectId: project.id }
                              : { roomId: room.id },
                          )
                        }
                        onPlace={() => setPlaceId(room.id)}
                        onMigrate={() => setMigrateId(room.id)}
                        onSchedules={() =>
                          setSchedules({
                            agentId: room.facilitatorId,
                            projectId: room.projectId,
                          })
                        }
                        onComputer={setComputer}
                        onPlugins={(id) => setMarketplace({ id })}
                        onProviders={() => { setSettingsTab("providers"); setSettings(true); }}
                        onProjectUpdate={updateProject}
                        onDraftReady={(append) => {
                          appendDraft.current = append;
                        }}
                        onNew={async (text) => {
                          const id = await createRoom(
                            {
                              kind:
                                room.kind === "group" ? "project" : "direct",
                              title: text
                                ? `${room.title.slice(0, 98)} · continued`
                                : "New conversation",
                              instructions: "",
                              participantIds: room.participants.map(
                                (member) => member.agentId,
                              ),
                              facilitatorId: room.facilitatorId ?? "",
                              shareHistory: false,
                            },
                            project?.id,
                            text,
                          );
                          return id;
                        }}
                      />
                    ) : (
                      <div className="workspace-empty">
                        <h1>Start a conversation</h1>

                        <button
                          type="button"
                          className="button button--primary"
                          onClick={newConversation}
                        >
                          New conversation
                        </button>
                        {layout.closed.length ? (
                          <button
                            type="button"
                            onClick={() => actLayout({ type: "reopen" })}
                          >
                            Reopen last closed tab
                          </button>
                        ) : null}
                      </div>
                    )}
                  </div>
                </section>
              );
            }}
          />
        )}
      </section>
      <Suspense fallback={null}>
        {state.sessions.map((session) => (
          <ExecutionWorker
            key={session.key}
            session={session}
            service={service}
            runtime={runtime}
            projects={projects.projects}
          />
        ))}
      </Suspense>
      <WorkspaceRightNav
        context={navContext}
        rooms={state.data.conversations}
        work={state.data.work}
        team={navTeam}
        runtime={runtime}
        approvals={navApprovals}
        open={contextOpen || Boolean(computer)}
        onClose={() => {
          setComputer(null);
          setContextOpen(false);
        }}
        onOpenConversation={open}
        onOpenWork={selectNavWork}
        onStopWork={stopWork}
        onContinueWork={continueWork}
        onSteerWork={steerWork}
        onPromoteWorkOutput={promoteWorkOutput}
        onNewSideChat={newSideChat}
        summaries={activeRoom ? <ConversationSummaries key={activeRoom.id} threadId={activeRoom.id} revision={JSON.stringify(state.data.work.filter(work => work.conversationId === activeRoom.id).map(work => [work.id, work.updatedAt]))} /> : undefined}
        sideChats={navContext && navContext.kind !== "work" ? <SideChatList
          owner={navContext.kind === "project" ? { kind: "project", id: navContext.project.id } : { kind: "agent", id: navContext.agent.id }}
          ownerName={navContext.kind === "project" ? navContext.project.name : navContext.agent.name}
          chats={state.data.conversations}
          activeId={activeRoom?.id}
          onOpen={room => open(room.id)}
          onCreate={async title => {
            const project = navContext.kind === "project";
            const room = await createSideChat(service, { title,
              owner: project ? { kind: "project", id: navContext.project.id } : { kind: "agent", id: navContext.agent.id },
              participantIds: project ? navTeam?.participantIds ?? [] : [navContext.agent.id],
              facilitatorId: project ? navTeam?.leadAgentId ?? "" : navContext.agent.id,
            });
            open(room.id);
          }}
          onRename={async (room, title) => { await renameSideChat(service, room, title); }}
          onArchive={async (room, archived) => { await setSideChatArchived(service, room, archived); }}
          onDelete={async room => { await deleteSideChat(service, room); }}
        /> : undefined}
        onSchedules={() =>
          setSchedules({
            agentId: navAgent?.id,
            projectId: navProject?.id,
          })
        }
        onOpenComputer={(agentId) => {
          setComputer(agentId);
          setContextOpen(true);
        }}
        computerAgentId={computer}
        computer={
          computer ? (
            <Suspense fallback={null}>
              <ComputerInspector
                key={computer}
                agentId={computer}
                runtime={runtime}
                service={service}
                onClose={() => setComputer(null)}
              />
            </Suspense>
          ) : null
        }
        onCloseComputer={() => setComputer(null)}
        onManageMemory={() => {
          setSettingsTab("privacy");
          setSettings(true);
        }}
        onEditProject={
          navProject ? () => setEditor({ projectId: navProject.id }) : undefined
        }
        presence={navPresence}
        activity={navSession?.state?.activity}
        projectDetails={
          navProject && navProjectRoom ? (
            <Suspense fallback={null}><ProjectContextPanel
              key={navProject.id}
              project={navProject}
              room={navProjectRoom}
              data={state.data}
              runtime={runtime}
              service={service}
              onOpen={open}
              onEdit={() => {
                if (narrow) setContextOpen(false);
                setEditor({ projectId: navProject.id });
              }}
              onSchedules={() => {
                if (narrow) setContextOpen(false);
                setSchedules({
                  projectId: navProject.id,
                  agentId: navProjectRoom.facilitatorId,
                });
              }}
              onUpdate={updateProject}
              onAddShare={async (share) => {
                const updated = await addLocalProjectShare({ workspaceId, projectId: navProject.id, expectedRevision: navProject.revision, share });
                projects.setProjects(current => current.map(item => item.id === updated.id ? updated : item));
                await service.refresh();
              }}
              onRemoveShare={async (shareId) => {
                const updated = await removeLocalProjectShare({ workspaceId, projectId: navProject.id, expectedRevision: navProject.revision, shareId });
                projects.setProjects(current => current.map(item => item.id === updated.id ? updated : item));
                await service.refresh();
              }}
            /></Suspense>
          ) : undefined
        }
      />
      {editor ? (
        <Suspense fallback={null}>
          <ConversationDialog
            agents={
              editor.focused && editingTeam
                ? runtime.agents.filter((agent) =>
                    editingTeam.participantIds.includes(agent.id),
                  )
                : runtime.agents
            }
            models={runtime.modelOptions}
            providers={runtime.backendProviders}
            projectName={editor.focused ? editingProject?.name : undefined}
            edit={Boolean(editingRoom || (editingProject && !editor.focused))}
            initial={
              editingRoom
                ? {
                    kind:
                      editingRoom.kind === "direct" ? "direct" : "project",
                    title: editingRoom.title,
                    participantIds: editingRoom.participants.map(
                      (member) => member.agentId,
                    ),
                    facilitatorId: editingRoom.facilitatorId ?? "",
                  }
                : editingProject && !editor.focused
                  ? {
                      kind: "project",
                      title: editingProject.name,
                      instructions: editingProject.instructions,
                      participantIds: editingTeam?.participantIds,
                      facilitatorId: editingTeam?.leadAgentId ?? "",
                    }
                  : editor.draft
            }
            onClose={() => setEditor(null)}
            onSave={async (draft) => {
              await runtime.flushSnapshot();
              if (editingRoom)
                await service.command({
                  action: "update-conversation",
                  id: editingRoom.id,
                  expectedRevision: editingRoom.revision,
                  title: draft.title,
                  participantIds: draft.participantIds,
                  facilitatorId: draft.facilitatorId || undefined,
                  shareHistory: draft.shareHistory,
                });
              else if (editingProject && editingTeam && !editor.focused) {
                await updateProject(editingProject, {
                  name: draft.title,
                  instructions: draft.instructions,
                  knowledgeSourceIds: editingProject.knowledgeSourceIds,
                });
                const team = service
                  .getSnapshot()
                  .data.teams.find(
                    (team) => team.projectId === editingProject.id,
                  )!;
                await service.command({
                  action: "update-team",
                  projectId: editingProject.id,
                  expectedRevision: team.revision,
                  leadAgentId: draft.facilitatorId || undefined,
                  participantIds: draft.participantIds,
                  shareHistory: draft.shareHistory,
                });
              } else
                await createRoom(
                  draft,
                  editor.focused ? editor.projectId : undefined,
                );
            }}
          />
        </Suspense>
      ) : null}
      {placeId ? (
        <Suspense fallback={null}>
          <PlaceConversationDialog
            title={
              state.data.conversations.find((room) => room.id === placeId)
                ?.title ?? "Conversation"
            }
            projects={projects.projects}
            onClose={() => setPlaceId(null)}
            onPlace={async (projectId) => {
              const room = service
                .getSnapshot()
                .data.conversations.find((room) => room.id === placeId);
              if (!room)
                throw new Error("This conversation is no longer available.");
              await service.command({
                action: "place-conversation",
                id: room.id,
                expectedRevision: room.revision,
                projectId,
                shareHistory: true,
              });
            }}
          />
        </Suspense>
      ) : null}
      {migrateId ? (
        <Suspense fallback={null}>
          <MigrateGroupDialog
            title={
              state.data.conversations.find((room) => room.id === migrateId)
                ?.title ?? "Legacy group"
            }
            agents={runtime.agents}
            models={runtime.modelOptions}
            providers={runtime.backendProviders}
            initialParticipantIds={
              state.data.conversations
                .find((room) => room.id === migrateId)
                ?.participants.map((member) => member.agentId) ?? []
            }
            onClose={() => setMigrateId(null)}
            onMigrate={async (draft) => {
              await runtime.flushSnapshot();
              const updated = await migrateLegacyGroup({
                workspaceId,
                id: `project-${crypto.randomUUID()}`,
                conversationId: migrateId,
                expectedRevision:
                  service
                    .getSnapshot()
                    .data.conversations.find((room) => room.id === migrateId)
                    ?.revision ?? 0,
                name: draft.name,
                instructions: draft.instructions,
                participantIds: draft.participantIds,
                leadAgentId: draft.leadAgentId || undefined,
                shareHistory: true,
              });
              projects.setProjects((current) => [...current, updated]);
              await service.refresh();
              open(updated.threadId);
            }}
          />
        </Suspense>
      ) : null}
      {agentEditor ? (
        <Suspense fallback={null}>
          <AgentEditor
            open
            agent={
              runtime.agents.find((agent) => agent.id === agentEditor.id) ??
              null
            }
            models={runtime.modelOptions}
            existingAvatarSeeds={runtime.agents.map(
              (agent) => agent.avatarSeed ?? `blob-v1:${agent.id}`,
            )}
            canDelete={runtime.agents.length > 1}
            onClose={() => setAgentEditor(null)}
            onSave={(draft) => {
              if (agentEditor.id) runtime.updateAgent(agentEditor.id, draft);
              else setCreatedAgentId(runtime.createAgent(draft).id);
              setAgentEditor(null);
            }}
            onDelete={() => {
              if (agentEditor.id) runtime.removeAgent(agentEditor.id);
              setAgentEditor(null);
            }}
            onSkillsChange={(learnedTasks) => {
              if (agentEditor.id)
                runtime.updateAgent(agentEditor.id, { learnedTasks });
            }}
            onUseSkill={(task) => {
              const agent = runtime.agents.find(
                (agent) => agent.id === agentEditor.id,
              );
              if (agent)
                void selectAgent(agent, true, task.instruction).catch((error) =>
                  service.report(error),
                );
              setAgentEditor(null);
            }}
          />
        </Suspense>
      ) : null}
      {settings ? (
        <SettingsModal
          activeTab={settingsTab}
          onSelectTab={setSettingsTab}
          onClose={() => setSettings(false)}
        >
          <Suspense fallback={null}>
            <SettingsPage
              runtime={runtime}
              theme={theme}
              onThemeChange={onTheme}
              activeTab={settingsTab}
              workspaceName={
                runtime.accountWorkspaceStatus.activeWorkspace.name ||
                "Mivlet workspace"
              }
              titleId="settings-modal-title"
            />
          </Suspense>
        </SettingsModal>
      ) : null}
      {schedules ? (
        <SchedulesDialog onClose={() => setSchedules(null)}>
          <Suspense fallback={null}>
            <LocalSchedules
              runtime={runtime}
              project={
                schedules.projectId
                  ? {
                      id: schedules.projectId,
                      name:
                        projects.projects.find(
                          (project) => project.id === schedules.projectId,
                        )?.name ?? "Project",
                      participantIds:
                        state.data.teams.find(
                          (team) => team.projectId === schedules.projectId,
                        )?.participantIds ?? [],
                    }
                  : undefined
              }
              initialAgentId={schedules.agentId}
              onOpenResult={async (_agentId, threadId) => {
                await service.refresh();
                open(threadId);
                setSchedules(null);
              }}
            />
          </Suspense>
        </SchedulesDialog>
      ) : null}
      {accountDialog ? (
        <Suspense fallback={null}>
          <AccountDialog
            kind={accountDialog}
            name={profileName}
            records={usage}
            onClose={() => setAccountDialog(null)}
            onSignOut={async () => {
              for (const work of service
                .getSnapshot()
                .data.work.filter((work) => activeWork(work) && !work.parentId))
                await service.stop(work.id);
              await runtime.signOutIdentity();
            }}
          />
        </Suspense>
      ) : null}
    </main>
  );
}
