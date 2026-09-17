import type {
  CollaborationWorkItem,
  ConversationRoom,
  LocalProject,
  WorkOutput,
  WorkspaceView,
} from "@mivlet/protocol";
import { Suspense, type MutableRefObject, type ReactNode } from "react";
import { ConversationGrid } from "../components/conversation/ConversationGrid";
interface NewAction { id: string; label: string; run: () => void; }
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
import { MarketplacePage } from "./workspace-lazy";
import { continueConversationDraft } from "./workspace-presentation";
import type { WorkspaceNavigation } from "./useWorkspaceNavigation";

function WorkspaceConversationView({
  view,
  room,
  project,
  runtime,
  service,
  state,
  active,
  profileName,
  onAgentSettings,
  selectedWorkId,
  onOpenWork,
  onClose,
  onArtifact,
  onEdit,
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
  onAgentSettings: (id: string) => void;
  selectedWorkId: string | null;
  onOpenWork: (id: string | null) => void;
  onClose: () => void;
  onArtifact: (output: string, agentId: string) => void;
  onEdit: () => void;
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
      onAgentSettings={onAgentSettings}
      selectedWorkId={selectedWorkId}
      onOpenWork={onOpenWork}
      onClose={onClose}
      onArtifact={onArtifact}
      onEdit={onEdit}
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
  onAgentSettings: (id: string) => void;
  onEditConversation: (roomId: string) => void;
  onPlaceConversation: (id: string) => void;
  onMigrateConversation: (id: string) => void;
  onProjectUpdate: (
    project: LocalProject,
    patch: Pick<LocalProject, "name" | "instructions" | "knowledgeSourceIds">,
  ) => Promise<void>;
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
      onAgentSettings={input.onAgentSettings}
      selectedWorkId={input.nav.navWorkId}
      onOpenWork={input.nav.selectNavWork}
      onClose={onClose}
      onArtifact={input.nav.openPanelArtifact}
      onEdit={() => {
        if (project) input.nav.setProjectDetailsId(project.id);
        else input.onEditConversation(room.id);
      }}
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
  panelOpen,
  onTogglePanel,
  onOpenSchedules,
  onSetSettingsTab,
  onOpenSettings,
  onAgentSettings,
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
  panelOpen: boolean;
  onTogglePanel: () => void;
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
  onAgentSettings: (id: string) => void;
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
    onAgentSettings,
  });
  return (
    <section
      className="workspace-views"
      aria-label="Conversation workspace"
    >
      <button type="button" className="workspace-history-toggle" aria-label={panelOpen ? "Hide workspace panel" : "Show workspace panel"} title={panelOpen ? "Hide workspace panel" : "Show workspace panel"} aria-expanded={panelOpen} onClick={onTogglePanel}><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="4.5" width="18" height="15" rx="1" /><path d="M9 4.5v15" /></svg></button>
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
                  role="region"
                  id={view ? `panel-${view.id}` : undefined}
                  aria-label={room?.title ?? "Conversation"}
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
