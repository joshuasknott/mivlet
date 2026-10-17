import { WorkspaceFileUpload } from "../components/navigation/WorkspaceFileUpload";
import { lazy, Suspense, useState } from "react";
import { WorkspaceActivity } from "../components/navigation/WorkspaceActivity";
import {
  agentChatOwner,
  panelFiles,
  panelMemories,
  panelRooms,
  panelWork,
  type PanelOwner,
  type PanelScope,
} from "../components/navigation/workspace-panel-data";
import {
  PanelArtifact,
  PanelOutput,
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
import { ComputerInspector, LocalSchedules, WorkspaceLibrary } from "./workspace-lazy";
import type { RenderWorkspaceConversation } from "./WorkspaceConversationChrome";
import type { WorkspaceNavigation } from "./useWorkspaceNavigation";

const WorkspaceHistory = lazy(() =>
  import("./WorkspaceHistory").then(({ WorkspaceHistory: Component }) => ({
    default: Component,
  })),
);
const WorkspaceMemories = lazy(() =>
  import("../components/navigation/WorkspaceMemories").then((module) => ({
    default: module.WorkspaceMemories,
  })),
);

export function WorkspaceContextPanel({
  hidden,
  onReveal,
  nav,
  runtime,
  service,
  state,
  projects,
  renderConversation,
}: {
  hidden: boolean;
  onReveal?: () => void;
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
  const room = nav.activeRoom;
  const project = room?.projectId
    ? projects.projects.find((entry) => entry.id === room.projectId)
    : navProject;
  const agentId = room ? agentChatOwner(room) : navAgent?.id;
  const agent = runtime.agents.find((entry) => entry.id === agentId);
  const owner: PanelOwner | undefined = project
    ? { kind: "project", id: project.id, name: project.name }
    : agent
      ? { kind: "agent", id: agent.id, name: agent.name }
      : undefined;
  const identity = workspaceId + ":" + (room?.id ?? owner?.id ?? "empty");
  const [browsing, setBrowsing] = useState<{
    identity: string;
    scope: PanelScope;
  }>({ identity, scope: "chat" });
  const scope = browsing.identity === identity ? browsing.scope : "chat";
  const scopeKey = identity + ":" + scope;
  const rooms = panelRooms(
    workspaceId,
    room,
    state.data.conversations,
    owner,
    scope,
  );
  const work = panelWork(workspaceId, rooms, state.data.work);
  const files = panelFiles({
    workspaceId,
    work,
    project,
    sources: runtime.workspaceKnowledgeSources,
  });
  const memories = panelMemories(runtime.managedMemoryRecords, room, scope);
  const historyContext = identity + ":" + (nav.navWorkId ?? "");
  const [historySelection, setHistorySelection] = useState<{
    id: string | null;
    version: number;
    context: string;
  }>({ id: null, version: 0, context: "" });
  return (
    <WorkspaceRightNav
      onChatActiveChange={nav.setPanelFocused}
      context={navContext}
      title={scope === "owner" ? owner?.name : room?.title}
      identity={identity}
      scope={scope}
      ownerLabel={room ? owner?.name : undefined}
      onScopeChange={(next) => {
        nav.setComputer(null);
        setBrowsing({ identity, scope: next });
      }}
      open={!hidden && (nav.contextOpen || Boolean(nav.computer))}
      replaced={hidden}
      onOpen={() => { onReveal?.(); nav.setContextOpen(true); }}
      onClose={() => {
        nav.setComputer(null);
        nav.setContextOpen(false);
      }}
      request={nav.panelRequest}
      renderTab={(tab, close) => {
        if (tab.kind === "artifact")
          return (
            <PanelArtifact
              key={tab.id}
              output={tab.output}
              agentId={tab.agentId}
              workspaceId={workspaceId}
              conversationId={tab.conversationId}
              messageId={tab.messageId}
              sourceRevisionId={tab.sourceRevisionId}
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
              imageDataUrl={tab.imageDataUrl}
              onClose={close}
              embedded
            />
          );
        if (tab.kind === "output")
          return (
            <PanelOutput
              key={tab.id}
              outputId={tab.outputId}
              workspaceId={workspaceId}
              onOpenConversation={(conversationId, source) => {
                nav.openConversation(conversationId, {
                  branchId: source.branchId,
                  messageId: source.messageId,
                  sourceRevisionId: source.sourceRevisionId,
                });
              }}
              onClose={close}
            />
          );
        if (tab.kind === "web")
          return <PanelWebPreview key={tab.id} url={tab.url} />;
        if (tab.kind === "mcp-app")
          return (
            <div
              key={tab.id}
              className="right-panel__mcp-app"
              data-mcp-app-panel={tab.id}
              aria-label={`${tab.title} interactive result`}
            />
          );
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
      historyRequestId={nav.navWorkId}
      activity={(navigate) => (
        <WorkspaceActivity
          workspaceId={workspaceId}
          work={work}
          agents={runtime.agents}
          files={files}
          memories={memories}
          memoryDisabled={runtime.memoryDisabled}
          onInspect={(id) =>
            setHistorySelection((current) => ({
              id,
              version: current.version + 1,
              context: historyContext,
            }))
          }
          onStop={(id) => service.stop(id)}
          onOpen={nav.setPanelRequest}
          onNavigate={navigate}
        />
      )}
      history={
        <Suspense fallback={<p role="status">Loading activity…</p>}>
          <WorkspaceHistory
            key={
              scopeKey + ":" + historySelection.version + ":" + nav.navWorkId
            }
            room={room}
            runtime={runtime}
            service={service}
            state={state}
            workItems={work}
            selectedWorkId={
              historySelection.context === historyContext
                ? historySelection.id
                : nav.navWorkId
            }
            onOpenConversation={(conversationId, source) =>
              source?.messageId || source?.branchId || source?.sourceRevisionId
                ? nav.openConversation(conversationId, source)
                : nav.open(conversationId)
            }
          />
        </Suspense>
      }
      memories={
        <Suspense fallback={<p role="status">Loading memory…</p>}>
          <WorkspaceMemories
            key={scopeKey}
            room={room}
            runtime={runtime}
            scope={scope}
            sourceIds={runtime.workspaceKnowledgeSources.map((source) => source.id)}
            onOpenSource={(sourceId) => {
              const source = runtime.workspaceKnowledgeSources.find((entry) => entry.id === sourceId);
              if (source) nav.setPanelRequest({
                id: "memory-source:" + sourceId,
                kind: "file",
                title: source.title,
                target: { type: "knowledge-file", workspaceId, sourceId },
              });
            }}
          />
        </Suspense>
      }
      library={
        <Suspense fallback={<p role="status">Loading files…</p>}>
          <WorkspaceLibrary
            key={scopeKey}
            workspaceId={workspaceId}
            agents={runtime.agents.filter((agent) =>
              navProject
                ? navTeam?.participantIds.includes(agent.id)
                : !navAgent || agent.id === navAgent.id,
            )}
            room={room}
            files={files}
            work={state.data.work}
            project={navProject}
            sources={runtime.workspaceKnowledgeSources}
            addFiles={
              room && scope === "chat" ? (
                <WorkspaceFileUpload room={room} runtime={runtime} />
              ) : undefined
            }
            onOpen={nav.setPanelRequest}
          />
        </Suspense>
      }
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
