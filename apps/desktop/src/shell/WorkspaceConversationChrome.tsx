import type {
  CollaborationWorkItem,
  ConversationRoom,
  LocalProject,
  WorkOutput,
  WorkspaceView,
} from "@mivlet/protocol";
import { SidebarSimple } from "@phosphor-icons/react/dist/csr/SidebarSimple";
import { Suspense, type MutableRefObject, type ReactNode } from "react";
import {
  ConversationGrid,
  ConversationTabs,
  type NewAction,
} from "../components/conversation/ConversationTabs";
import type { ConversationDraft } from "../components/projects/ConversationDialogs";
import type { SettingsTab } from "../components/pages/settings-tabs";
import type { ShellRuntime } from "../hooks/useShellRuntime";
import type { LocalScheduleDispatchStatus } from "../hooks/useLocalScheduleDispatcher";
import type { useLocalProjects } from "../hooks/useLocalProjects";
import {
  type WorkspaceExecution,
  type WorkspaceExecutionState,
} from "../lib/workspace-execution";
import { ConversationPane } from "./ConversationPane";
import { MarketplacePage, WorkModeView } from "./workspace-lazy";
import { continueConversationDraft } from "./workspace-presentation";
import type { WorkspaceNavigation } from "./useWorkspaceNavigation";

function WorkspaceModeBar({
  mode,
  onChat,
  onWork,
}: {
  mode: "chat" | "work";
  onChat: () => void;
  onWork: () => void;
}) {
  return (
    <div
      className="workspace-mode-bar"
      role="tablist"
      aria-label="Workspace mode"
    >
      <button
        type="button"
        role="tab"
        aria-selected={mode === "chat"}
        onClick={onChat}
      >
        Chat
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === "work"}
        onClick={onWork}
      >
        Work
      </button>
    </div>
  );
}

function WorkspaceConversationView({
  view,
  room,
  project,
  runtime,
  service,
  state,
  active,
  profileName,
  headerActions,
  onOpenWork,
  onClose,
  onArtifact,
  onEdit,
  onPlace,
  onMigrate,
  onComputer,
  onPlugins,
  onProviders,
  onProjectUpdate,
  onDraftReady,
  onNew,
}: {
  view: WorkspaceView;
  room: ConversationRoom;
  project: LocalProject | undefined;
  runtime: ShellRuntime;
  service: WorkspaceExecution;
  state: WorkspaceExecutionState;
  active: boolean;
  profileName: string;
  headerActions?: ReactNode;
  onOpenWork: (id: string | null) => void;
  onClose: () => void;
  onArtifact: (output: string, agentId: string) => void;
  onEdit: () => void;
  onPlace: () => void;
  onMigrate: () => void;
  onComputer: (agentId: string) => void;
  onPlugins: (id?: string) => void;
  onProviders: () => void;
  onProjectUpdate: (
    project: LocalProject,
    patch: Pick<LocalProject, "name" | "instructions" | "knowledgeSourceIds">,
  ) => Promise<void>;
  onDraftReady: (append: (text: string) => void) => void;
  onNew: (draft?: string) => Promise<string | void>;
}) {
  return (
    <ConversationPane
      key={view.id}
      view={view}
      room={room}
      project={project}
      runtime={runtime}
      service={service}
      state={state}
      active={active}
      profileName={profileName}
      headerActions={headerActions}
      onOpenWork={onOpenWork}
      onClose={onClose}
      onArtifact={onArtifact}
      onEdit={onEdit}
      onPlace={onPlace}
      onMigrate={onMigrate}
      onComputer={onComputer}
      onPlugins={onPlugins}
      onProviders={onProviders}
      onProjectUpdate={onProjectUpdate}
      onDraftReady={onDraftReady}
      onNew={onNew}
    />
  );
}

export type RenderWorkspaceConversation = (
  view: WorkspaceView,
  room: ConversationRoom,
  project: LocalProject | undefined,
  active: boolean,
  onClose: () => void,
) => ReactNode;

export function buildConversationRenderer(input: {
  nav: WorkspaceNavigation;
  runtime: ShellRuntime;
  service: WorkspaceExecution;
  state: WorkspaceExecutionState;
  profileName: string;
  appendDraft: MutableRefObject<(text: string) => void>;
  createRoom: (
    draft: ConversationDraft,
    projectId?: string,
    seedText?: string,
  ) => Promise<string>;
  onOpenMarketplace: (value: { id?: string } | null) => void;
  onSetSettingsTab: (tab: SettingsTab) => void;
  onOpenSettings: () => void;
  onEditConversation: (roomId: string) => void;
  onPlaceConversation: (id: string) => void;
  onMigrateConversation: (id: string) => void;
  onProjectUpdate: (
    project: LocalProject,
    patch: Pick<LocalProject, "name" | "instructions" | "knowledgeSourceIds">,
  ) => Promise<void>;
  headerActions?: ReactNode;
}): RenderWorkspaceConversation {
  return (view, room, project, active, onClose) => (
    <WorkspaceConversationView
      view={view}
      room={room}
      project={project}
      runtime={input.runtime}
      service={input.service}
      state={input.state}
      active={active}
      profileName={input.profileName}
      headerActions={
        view.id === input.nav.activeView?.id ? input.headerActions : undefined
      }
      onOpenWork={input.nav.selectNavWork}
      onClose={onClose}
      onArtifact={input.nav.openPanelArtifact}
      onEdit={() => {
        if (project) input.nav.setProjectDetailsId(project.id);
        else input.onEditConversation(room.id);
      }}
      onPlace={() => input.onPlaceConversation(room.id)}
      onMigrate={() => input.onMigrateConversation(room.id)}
      onComputer={(agentId) => {
        input.nav.setComputer(agentId);
        input.nav.setContextOpen(true);
      }}
      onPlugins={(id) => input.onOpenMarketplace({ id })}
      onProviders={() => {
        input.onSetSettingsTab("providers");
        input.onOpenSettings();
      }}
      onProjectUpdate={input.onProjectUpdate}
      onDraftReady={(append) => {
        if (active) input.appendDraft.current = append;
      }}
      onNew={async (text) => {
        const continued = continueConversationDraft(room, project?.id, text);
        return input.createRoom(
          continued.draft,
          continued.projectId,
          continued.seedText,
        );
      }}
    />
  );
}

export function WorkspaceConversationChrome({
  nav,
  runtime,
  service,
  state,
  projects,
  profileName,
  marketplace,
  indicators,
  tabMeta,
  newActions,
  scheduleStatus,
  appendDraft,
  createRoom,
  onNewConversation,
  onOpenMarketplace,
  onOpenSchedules,
  onSetSettingsTab,
  onOpenSettings,
  onEditConversation,
  onPlaceConversation,
  onMigrateConversation,
  onProjectUpdate,
  onStopWork,
  onContinueWork,
  onSteerWork,
  onPromoteWorkOutput,
}: {
  nav: WorkspaceNavigation;
  runtime: ShellRuntime;
  service: WorkspaceExecution;
  state: WorkspaceExecutionState;
  projects: ReturnType<typeof useLocalProjects>;
  profileName: string;
  marketplace: { id?: string } | null;
  indicators: Record<string, string>;
  tabMeta: {
    titles: Record<string, string>;
    descriptions: Record<string, string>;
  };
  newActions: NewAction[];
  scheduleStatus: LocalScheduleDispatchStatus;
  appendDraft: MutableRefObject<(text: string) => void>;
  createRoom: (
    draft: ConversationDraft,
    projectId?: string,
    seedText?: string,
  ) => Promise<string>;
  onNewConversation: () => void;
  onOpenMarketplace: (value: { id?: string } | null) => void;
  onOpenSchedules: (value: { agentId?: string; projectId?: string }) => void;
  onSetSettingsTab: (tab: SettingsTab) => void;
  onOpenSettings: () => void;
  onEditConversation: (roomId: string) => void;
  onPlaceConversation: (id: string) => void;
  onMigrateConversation: (id: string) => void;
  onProjectUpdate: (
    project: LocalProject,
    patch: Pick<LocalProject, "name" | "instructions" | "knowledgeSourceIds">,
  ) => Promise<void>;
  onStopWork: (id: string) => void;
  onContinueWork: (id: string, generation: number) => Promise<void>;
  onSteerWork: (
    id: string,
    generation: number,
    text: string,
  ) => Promise<void>;
  onPromoteWorkOutput: (
    output: WorkOutput,
    workItem: CollaborationWorkItem,
    value: string,
  ) => Promise<void>;
}) {
  const workspaceModeControl = (
    <WorkspaceModeBar
      mode={nav.mode}
      onChat={() => nav.setMode("chat")}
      onWork={() => {
        nav.setMode("work");
        nav.setContextOpen(false);
        nav.setComputer(null);
      }}
    />
  );
  const renderConversation = buildConversationRenderer({
    nav,
    runtime,
    service,
    state,
    profileName,
    appendDraft,
    createRoom,
    onOpenMarketplace,
    onSetSettingsTab,
    onOpenSettings,
    onEditConversation,
    onPlaceConversation,
    onMigrateConversation,
    onProjectUpdate,
    headerActions: workspaceModeControl,
  });
  return (
    <section
      className="workspace-views"
      aria-label="Conversation workspace"
    >
      {nav.showWorkspaceNavigation && nav.mode === "work"
        ? workspaceModeControl
        : null}
      {nav.showWorkspaceNavigation && nav.mode === "chat" ? (
        <ConversationTabs
          layout={nav.layout}
          titles={tabMeta.titles}
          indicators={indicators}
          descriptions={tabMeta.descriptions}
          onAction={nav.actLayout}
          onCreate={onNewConversation}
          newActions={newActions}
        />
      ) : null}
      <button
        type="button"
        className="workspace-history-toggle"
        aria-label={
          nav.contextOpen || nav.computer
            ? "Hide workspace panel"
            : "Show workspace panel"
        }
        title={
          nav.contextOpen || nav.computer
            ? "Hide workspace panel"
            : "Show workspace panel"
        }
        aria-expanded={nav.contextOpen || Boolean(nav.computer)}
        onClick={() => {
          nav.setComputer(null);
          nav.setContextOpen(!(nav.contextOpen || nav.computer));
        }}
      >
        <SidebarSimple size={19} />
      </button>
      {nav.phone ? (
        <button
          type="button"
          className="workspace-navigation-toggle"
          onClick={() => nav.setMobileNavigation(!nav.mobileNavigation)}
        >
          {nav.mobileNavigation
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
          <button type="button" onClick={() => onOpenSchedules({})}>
            View schedules
          </button>
        </div>
      ) : null}
      {marketplace ? (
        <Suspense fallback={<p role="status">Loading plugins…</p>}>
          <MarketplacePage
            initialConnectorId={marketplace.id}
            onBack={() => onOpenMarketplace(null)}
            workspaceId={
              runtime.accountWorkspaceStatus.activeWorkspace.localWorkspaceId
            }
            manifests={runtime.connectorManifests.filter(
              (connector) => connector.id !== "local-files",
            )}
            accounts={runtime.connectorAccounts}
            connectorStatus={runtime.connectorStatus}
            onUseConnector={(connector, prompt) => {
              appendDraft.current(`@${connector.id} ${prompt ?? ""}`);
              onOpenMarketplace(null);
            }}
            onUseBuiltinPlugin={(id) => {
              appendDraft.current(`@${id} `);
              onOpenMarketplace(null);
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
      ) : nav.mode === "work" ? (
        <Suspense fallback={<p role="status">Loading work…</p>}>
          <WorkModeView
            project={nav.navProject}
            agent={nav.navAgent}
            work={nav.navWork}
            runtime={runtime}
            service={service}
            approvals={nav.navApprovals}
            selectedWork={nav.selectedWork ?? undefined}
            onOpen={nav.open}
            onOpenWork={nav.selectNavWork}
            onStopWork={onStopWork}
            onContinueWork={onContinueWork}
            onSteerWork={onSteerWork}
            onPromoteWorkOutput={onPromoteWorkOutput}
            onOpenArtifact={nav.openPanelArtifact}
            onOpenComputer={(agentId) => {
              nav.setComputer(agentId);
              nav.setContextOpen(true);
            }}
            onSchedules={() =>
              onOpenSchedules({
                agentId: nav.navAgent?.id,
                projectId: nav.navProject?.id,
              })
            }
            onOpenPlugins={() => onOpenMarketplace({})}
          />
        </Suspense>
      ) : (
        <ConversationGrid
          layout={nav.layout}
          compact={nav.narrow}
          onAction={nav.actLayout}
          renderPane={(pane) => {
            const view = nav.layout.views.find(
              (entry) => entry.id === nav.layout.active[pane],
            );
            const room = state.data.conversations.find(
              (entry) => entry.id === view?.conversationId,
            );
            const project = projects.projects.find(
              (entry) => entry.id === room?.projectId,
            );
            return (
              <section
                className={`conversation-pane${pane === nav.layout.activePane ? " conversation-pane--active" : ""}`}
                onFocusCapture={() => {
                  nav.setPanelFocused(false);
                  if (view && pane !== nav.layout.activePane)
                    nav.actLayout({ type: "activate", id: view.id });
                }}
                onPointerDown={() => {
                  if (view && pane !== nav.layout.activePane)
                    nav.actLayout({ type: "activate", id: view.id });
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
                    renderConversation(
                      view,
                      room,
                      project,
                      pane === nav.layout.activePane &&
                        (!nav.panelFocused || !nav.contextOpen),
                      () => nav.actLayout({ type: "close", id: view.id }),
                    )
                  ) : (
                    <div className="workspace-empty">
                      <h1>Start a conversation</h1>

                      <button
                        type="button"
                        className="button button--primary"
                        onClick={onNewConversation}
                      >
                        New conversation
                      </button>
                      {nav.layout.closed.length ? (
                        <button
                          type="button"
                          onClick={() => nav.actLayout({ type: "reopen" })}
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
  );
}
