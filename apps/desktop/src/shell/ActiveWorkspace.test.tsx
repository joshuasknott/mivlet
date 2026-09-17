import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import type { ShellRuntime } from "../hooks/useShellRuntime";
import { ExecutionApprovalRouter } from "../lib/execution-approvals";
import { useRef } from "react";

const snapshot = vi.hoisted(() => ({
  data: {
    conversations: [],
    authors: [],
    teams: [],
    work: [],
    facts: [],
    layout: null,
  },
  sessions: [{ key: "session-1", work: { agentId: "mira" } }],
  histories: {},
  loading: false,
  error: null,
  revision: 1,
}));

vi.mock("../lib/workspace-execution", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/workspace-execution")>();
  class WorkspaceExecution {
    subscribe = (listener: () => void) => {
      void listener;
      return () => undefined;
    };
    getSnapshot = () => snapshot;
    refresh = vi.fn(async () => undefined);
    report = vi.fn();
    admit = vi.fn();
    canSchedule = vi.fn(() => true);
    registerScheduled = vi.fn();
    command = vi.fn();
    stop = vi.fn();
    steer = vi.fn();
    clearError = vi.fn();
  }
  return { ...actual, WorkspaceExecution };
});

vi.mock("../hooks/useLocalProjects", () => ({
  useLocalProjects: () => ({
    projects: [],
    loading: false,
    error: "",
    refresh: vi.fn(),
    setProjects: vi.fn(),
  }),
}));

vi.mock("./useWorkspaceNavigation", () => ({
  useWorkspaceNavigation: () => ({
    layout: { views: [], panes: [[]], active: [null], activePane: 0, closed: [] },
    narrow: false,
    phone: false,
    contextOpen: false,
    setContextOpen: vi.fn(),
    mode: "chat",
    setMode: vi.fn(),
    projectDetailsId: null,
    setProjectDetailsId: vi.fn(),
    panelFocused: false,
    setPanelFocused: vi.fn(),
    panelRequest: null,
    setPanelRequest: vi.fn(),
    navigationCollapsed: false,
    setNavigationCollapsed: vi.fn(),
    mobileNavigation: false,
    setMobileNavigation: vi.fn(),
    computer: null,
    setComputer: vi.fn(),
    activeView: undefined,
    activeRoom: undefined,
    showWorkspaceNavigation: false,
    activeProfile: undefined,
    activeProject: undefined,
    selectedWork: null,
    navContext: null,
    navAgent: undefined,
    navProject: undefined,
    navTeam: undefined,
    navWork: [],
    navApprovals: [],
    actLayout: vi.fn(),
    open: vi.fn(),
    onConversationPointerDown: vi.fn(),
    selectNavWork: vi.fn(),
    openPanelWeb: vi.fn(),
    openPanelArtifact: vi.fn(),
    openPanelChat: vi.fn(),
  }),
}));

vi.mock("../hooks/useLocalScheduleDispatcher", () => ({
  useLocalScheduleDispatcher: vi.fn(),
  useLocalScheduleDispatchStatus: () => ({
    phase: "idle",
    updatedAt: "",
  }),
}));

vi.mock("../runtime/adapters/select", () => ({
  hasNativeRuntimeAdapter: () => false,
}));

vi.mock("../runtime/domains/workspace", () => ({
  recoverRuntimeExecutionAttempts: vi.fn(async () => undefined),
  listRuntimeExecutionAttempts: vi.fn(async () => []),
}));

vi.mock("./WorkspaceConversationChrome", () => ({
  WorkspaceConversationChrome: () => <div data-testid="conversation-chrome" />,
  buildConversationRenderer: () => () => null,
}));

vi.mock("./WorkspaceContextPanel", () => ({
  WorkspaceContextPanel: () => <div data-testid="context-panel" />,
}));

vi.mock("./workspace-dialogs", () => ({
  WorkspaceDialogs: () => <div data-testid="workspace-dialogs" />,
}));

vi.mock("./workspace-lazy", () => ({
  ExecutionWorker: ({ session }: { session: { key: string } }) => (
    <div data-testid="execution-worker">{session.key}</div>
  ),
}));

vi.mock("../components/agents/AgentSidebar", () => ({
  AgentSidebar: () => <div data-testid="agent-sidebar" />,
}));

import { ActiveWorkspace } from "./ActiveWorkspace";

function Harness() {
  const priorClose = useRef(Promise.resolve());
  const runtime = {
    agents: [],
    modelOptions: [],
    backendProviders: [],
    permissionMode: "trusted-scope",
    runtimeSnapshotReady: true,
    runtimeSnapshotError: null,
    openApprovals: [],
    connectorManifests: [],
    identityStatus: {
      enabled: false,
      state: "disabled",
      message: "",
      scopes: [],
    },
    accountWorkspaceStatus: {
      activeWorkspace: { localWorkspaceId: "ws", name: "Local", source: "local" },
    },
    memoryState: {},
    flushSnapshot: vi.fn(async () => undefined),
  } as unknown as ShellRuntime;
  return (
    <ActiveWorkspace
      runtime={runtime}
      approvals={new ExecutionApprovalRouter()}
      theme="light"
      onTheme={vi.fn()}
      priorClose={priorClose}
      onService={vi.fn()}
    />
  );
}

describe("ActiveWorkspace composition", () => {
  it("keeps sidebar, conversation chrome, execution workers, context, and dialogs composed", () => {
    render(<Harness />);
    expect(screen.getByTestId("agent-sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("conversation-chrome")).toBeInTheDocument();
    expect(screen.getByTestId("execution-worker")).toHaveTextContent("session-1");
    expect(screen.getByTestId("context-panel")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-dialogs")).toBeInTheDocument();
    expect(document.querySelector("main.teammates-workspace")).toHaveAttribute(
      "data-theme",
      "light",
    );
  });
});
