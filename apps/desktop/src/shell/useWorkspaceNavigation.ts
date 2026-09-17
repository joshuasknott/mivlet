import type { ConversationLayout, LocalProject } from "@fable/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RightPanelTab } from "../components/navigation/right-panel-state";
import type { NavContext } from "../components/navigation/WorkspaceRightNav";
import { useConversationDrag } from "../hooks/useConversationDrag";
import { useMediaQuery } from "../hooks/useMediaQuery";
import type { ShellRuntime } from "../hooks/useShellRuntime";
import { parseComputerArtifact } from "../lib/computer-artifacts";
import {
  emptyLayout,
  reduceLayout,
  restoreLayout,
  type LayoutAction,
} from "../lib/conversation-layout";
import type {
  WorkspaceExecution,
  WorkspaceExecutionState,
} from "../lib/workspace-execution";

/** Owns view layout and navigation only. Closing or restoring a view never owns execution. */
export function useWorkspaceNavigation(options: {
  runtime: ShellRuntime;
  service: WorkspaceExecution;
  state: WorkspaceExecutionState;
  projects: LocalProject[];
  marketplace: boolean;
  onNavigate: () => void;
  onSearch: () => void;
}) {
  const { runtime, service, state, projects } = options;
  const callbacks = useRef(options);
  callbacks.current = options;
  const [layout, setLayout] = useState<ConversationLayout>(emptyLayout);
  const restored = useRef(false);
  const narrow = useMediaQuery("(max-width: 850px)");
  const phone = useMediaQuery("(max-width: 700px)");
  // One contextual right panel replaces history, details and computer panels.
  const [contextOpen, setContextOpen] = useState(!narrow);
  const [projectDetailsId, setProjectDetailsId] = useState<string | null>(null);
  const [panelFocused, setPanelFocused] = useState(false);
  const [panelRequest, setPanelRequest] = useState<RightPanelTab | null>(null);
  const [navWorkId, setNavWorkId] = useState<string | null>(null);
  const [mobileNavigation, setMobileNavigation] = useState(false);
  const [computer, setComputer] = useState<string | null>(null);
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

  // The context the right panel describes: an explicitly selected
  // Work item, else the active view's loaded Project, else its Agent, else the
  // remembered active agent. A Project that has not loaded yet is not faked.
  const activeProject = projects.find(
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
        ? (runtime.agents.find(
            (agent) => agent.id === navContext.item.agentId,
          ) ?? activeProfile)
        : undefined;
  const navProject =
    navContext?.kind === "project"
      ? navContext.project
      : navContext?.kind === "work" && navContext.item.projectId
        ? projects.find((project) => project.id === navContext.item.projectId)
        : undefined;
  const navTeam = state.data.teams.find(
    (team) => team.projectId === navProject?.id,
  );
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
        type: "navigate",
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
  const actLayout = (action: LayoutAction) => {
    setLayout((current) => reduceLayout(current, action));
    callbacks.current.onNavigate();
    setMobileNavigation(false);
  };
  const open = (id: string) => {
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
      type: "navigate",
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
        callbacks.current.onSearch();
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
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const openPanelWeb = useCallback((url: string) => {
    setPanelRequest({
      id: `web:${url}`,
      kind: "web",
      title: new URL(url).hostname,
      url,
    });
    setComputer(null);
    setContextOpen(true);
    setPanelFocused(false);
  }, []);
  const openPanelArtifact = (output: string, agentId: string) => {
    const artifact = parseComputerArtifact(output);
    if (!artifact) return;
    setPanelFocused(false);
    setPanelRequest({
      id: `artifact:${agentId}:${artifact.id}`,
      kind: "artifact",
      title: artifact.title,
      output,
      agentId,
    });
    setComputer(null);
    setContextOpen(true);
  };
  const openPanelChat = (roomId: string) => {
    const room = service
      .getSnapshot()
      .data.conversations.find((room) => room.id === roomId);
    if (!room) return;
    setPanelFocused(true);
    setPanelRequest({
      id: `chat:${roomId}`,
      kind: "chat",
      title: room.title,
      roomId,
    });
    setComputer(null);
    setContextOpen(true);
  };
  const onConversationPointerDown = useConversationDrag(
    layout,
    actLayout,
    !narrow,
  );
  const selectNavWork = (id: string | null) => {
    if (id) {
      const item = state.data.work.find(work => work.id === id);
      if (!item) return;
      open(item.conversationId);
    }
    setNavWorkId(id);
  };

  return {
    layout,
    narrow,
    phone,
    contextOpen,
    setContextOpen,
    projectDetailsId,
    setProjectDetailsId,
    panelFocused,
    setPanelFocused,
    panelRequest,
    setPanelRequest,
    navWorkId,
    setNavWorkId,
    mobileNavigation,
    setMobileNavigation,
    computer,
    setComputer,
    activeView,
    activeRoom,
    activeProfile,
    activeProject,
    selectedWork,
    navContext,
    navAgent,
    navProject,
    navTeam,
    actLayout,
    open,
    onConversationPointerDown,
    selectNavWork,
    openPanelWeb,
    openPanelArtifact,
    openPanelChat,
  };
}
