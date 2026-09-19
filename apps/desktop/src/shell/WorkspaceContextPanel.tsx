import { WorkspaceLibrary } from "../components/navigation/WorkspaceLibrary";
import { Suspense } from "react";
import {
  PanelArtifact,
  PanelWebPreview,
} from "../components/navigation/PanelContent";
import { WorkspaceRightNav } from "../components/navigation/WorkspaceRightNav";
import { SearchFileDialog } from "../components/search/SearchFileDialog";
import { SideChatList } from "../components/conversation/SideChats";
import type { ShellRuntime } from "../hooks/useShellRuntime";
import type { useLocalProjects } from "../hooks/useLocalProjects";
import {
  createSideChat,
  deleteSideChat,
  renameSideChat,
  setSideChatArchived,
} from "../lib/conversation-service";
import type {
  WorkspaceExecution,
  WorkspaceExecutionState,
} from "../lib/workspace-execution";
import { ComputerInspector, LocalSchedules } from "./workspace-lazy";
import type { RenderWorkspaceConversation } from "./WorkspaceConversationChrome";
import type { WorkspaceNavigation } from "./useWorkspaceNavigation";

export function WorkspaceContextPanel({
  hidden,
  nav,
  runtime,
  service,
  state,
  projects,
  renderConversation,
  onNewSideChat,
}: {
  hidden: boolean;
  nav: WorkspaceNavigation;
  runtime: ShellRuntime;
  service: WorkspaceExecution;
  state: WorkspaceExecutionState;
  projects: ReturnType<typeof useLocalProjects>;
  renderConversation: RenderWorkspaceConversation;
  onNewSideChat: () => void;
}) {
  const workspaceId =
    runtime.accountWorkspaceStatus.activeWorkspace.localWorkspaceId;
  const navContext = nav.navContext;
  const navProject = nav.navProject;
  const navAgent = nav.navAgent;
  const navTeam = nav.navTeam;
  return (
    <WorkspaceRightNav
      onChatActiveChange={nav.setPanelFocused}
      context={navContext}
      rooms={state.data.conversations}
      work={state.data.work}
      runtime={runtime}
      open={!hidden && (nav.contextOpen || Boolean(nav.computer))}
      onClose={() => {
        nav.setComputer(null);
        nav.setContextOpen(false);
      }}
      onOpenConversation={nav.openPanelChat}
      onNewSideChat={onNewSideChat}
      request={nav.panelRequest}
      renderTab={(tab, close) => {
        if (tab.kind === "artifact")
          return (
            <PanelArtifact
              key={tab.id}
              output={tab.output}
              agentId={tab.agentId}
              workspaceId={workspaceId}
              onClose={close}
            />
          );
        if (tab.kind === "file")
          return (
            <SearchFileDialog
              key={tab.id}
              target={tab.target}
              title={tab.title}
              text={tab.text}
              onClose={close}
              embedded
            />
          );
        if (tab.kind === "web")
          return <PanelWebPreview key={tab.id} url={tab.url} />;
        const room = state.data.conversations.find(
          (entry) => entry.id === tab.roomId,
        );
        return room ? (
          <div
            className="conversation-panel"
            onFocusCapture={() => nav.setPanelFocused(true)}
          >
            {renderConversation(
              { id: tab.id, kind: "conversation", conversationId: room.id },
              room,
              projects.projects.find(
                (project) => project.id === room.projectId,
              ),
              nav.contextOpen && nav.panelFocused,
              close,
            )}
          </div>
        ) : (
          <p className="right-panel__empty">
            This conversation is no longer available.
          </p>
        );
      }}
      library={<WorkspaceLibrary key={workspaceId} workspaceId={workspaceId} agents={runtime.agents} onOpen={nav.setPanelRequest} />}
      sideChats={
        navContext && navContext.kind !== "work" ? (
          <SideChatList
            compact
            key={navProject?.id ?? navAgent?.id}
            owner={
              navContext.kind === "project"
                ? { kind: "project", id: navContext.project.id }
                : { kind: "agent", id: navContext.agent.id }
            }
            ownerName={
              navContext.kind === "project"
                ? navContext.project.name
                : navContext.agent.name
            }
            chats={state.data.conversations}
            activeId={nav.activeRoom?.id}
            onOpen={(room) => nav.openPanelChat(room.id)}
            onCreate={async (title) => {
              const project = navContext.kind === "project";
              const room = await createSideChat(service, {
                title,
                owner: project
                  ? { kind: "project", id: navContext.project.id }
                  : { kind: "agent", id: navContext.agent.id },
                participantIds: project
                  ? (navTeam?.participantIds ?? [])
                  : [navContext.agent.id],
                facilitatorId: project
                  ? (navTeam?.leadAgentId ?? "")
                  : navContext.agent.id,
              });
              nav.openPanelChat(room.id);
            }}
            onRename={async (room, title) => {
              await renameSideChat(service, room, title);
            }}
            onArchive={async (room, archived) => {
              await setSideChatArchived(service, room, archived);
            }}
            onDelete={async (room) => {
              await deleteSideChat(service, room);
            }}
          />
        ) : undefined
      }
      schedules={
        <Suspense fallback={<p role="status">Loading schedules…</p>}>
          <LocalSchedules
            key={navProject?.id ?? navAgent?.id ?? "workspace"}
            runtime={runtime}
            project={
              navProject
                ? {
                    id: navProject.id,
                    name: navProject.name,
                    participantIds: navTeam?.participantIds ?? [],
                  }
                : undefined
            }
            initialAgentId={navAgent?.id}
            onOpenResult={async (_, threadId) => {
              await service.refresh();
              nav.openPanelChat(threadId);
            }}
          />
        </Suspense>
      }
      computerAgentId={nav.computer}
      computer={
        nav.computer ? (
          <Suspense fallback={null}>
            <ComputerInspector
              key={nav.computer}
              agentId={nav.computer}
              runtime={runtime}
              service={service}
              onClose={() => nav.setComputer(null)}
            />
          </Suspense>
        ) : null
      }
      onCloseComputer={() => nav.setComputer(null)}
    />
  );
}
