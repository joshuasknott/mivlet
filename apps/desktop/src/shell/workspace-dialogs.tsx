import type {
  CollaborationWorkItem,
  ExecutionAttempt,
  LocalProject,
  SearchResult,
} from "@mivlet/protocol";
import { Suspense } from "react";
import { SchedulesDialog } from "../components/agents/SchedulesDialog";
import type { ConversationDraft } from "../components/projects/ConversationDialogs";
import type { SettingsTab } from "../components/pages/settings-tabs";
import { SettingsModal } from "../components/settings/SettingsModal";
import type { ShellRuntime } from "../hooks/useShellRuntime";
import type { useLocalProjects } from "../hooks/useLocalProjects";
import {
  addLocalProjectShare,
  removeLocalProjectShare,
} from "../runtime/domains/local-projects";
import { activeWork, type WorkspaceExecution, type WorkspaceExecutionState } from "../lib/workspace-execution";
import {
  AccountDialog,
  AgentEditor,
  LocalSchedules,
  ProjectDetailsDialog,
  SearchOverlay,
  SettingsPage,
} from "./workspace-lazy";
import {
  WorkspaceConversationDialogs,
  type ConversationDialogTarget,
} from "./WorkspaceConversationDialogs";
import { planSearchOpen } from "./workspace-presentation";
import type { WorkspaceNavigation } from "./useWorkspaceNavigation";

export function WorkspaceDialogs({
  nav,
  runtime,
  service,
  state,
  projects,
  profileName,
  theme,
  onTheme,
  searchOpen,
  setSearchOpen,
  setMarketplace,
  conversationDialog,
  setConversationDialog,
  agentEditor,
  setAgentEditor,
  setCreatedAgentId,
  settings,
  setSettings,
  settingsTab,
  setSettingsTab,
  schedules,
  setSchedules,
  accountDialog,
  setAccountDialog,
  usage,
  createRoom,
  updateProject,
  selectAgent,
}: {
  nav: WorkspaceNavigation;
  runtime: ShellRuntime;
  service: WorkspaceExecution;
  state: WorkspaceExecutionState;
  projects: ReturnType<typeof useLocalProjects>;
  profileName: string;
  theme: "light" | "dark";
  onTheme: (theme: "light" | "dark") => void;
  searchOpen: boolean;
  setSearchOpen: (open: boolean) => void;
  setMarketplace: (value: { id?: string } | null) => void;
  conversationDialog: ConversationDialogTarget | null;
  setConversationDialog: (value: ConversationDialogTarget | null) => void;
  agentEditor: { id?: string } | null;
  setAgentEditor: (value: { id?: string } | null) => void;
  setCreatedAgentId: (id: string | null) => void;
  settings: boolean;
  setSettings: (open: boolean) => void;
  settingsTab: SettingsTab;
  setSettingsTab: (tab: SettingsTab) => void;
  schedules: { agentId?: string; projectId?: string } | null;
  setSchedules: (value: { agentId?: string; projectId?: string } | null) => void;
  accountDialog: "usage" | "sign-out" | null;
  setAccountDialog: (value: "usage" | "sign-out" | null) => void;
  usage: NonNullable<ExecutionAttempt["usage"]>[];
  createRoom: (
    draft: ConversationDraft,
    projectId?: string,
    seedText?: string,
  ) => Promise<string>;
  updateProject: (
    project: LocalProject,
    patch: Pick<LocalProject, "name" | "instructions" | "knowledgeSourceIds">,
  ) => Promise<void>;
  selectAgent: (
    agent: import("@mivlet/protocol").MivletAgentProfile,
    newConversation?: boolean,
    text?: string,
  ) => Promise<string>;
}) {
  const workspaceId =
    runtime.accountWorkspaceStatus.activeWorkspace.localWorkspaceId;
  const detailsProject = projects.projects.find(
    (project) => project.id === nav.projectDetailsId,
  );
  const detailsRoom = state.data.conversations.find(
    (room) => room.id === detailsProject?.threadId,
  );
  return (
    <>
      {searchOpen ? (
        <Suspense fallback={null}>
          <SearchOverlay
            workspaceId={workspaceId}
            open={searchOpen}
            onClose={() => setSearchOpen(false)}
            enabled={!runtime.accountWorkspacePending}
            dataRevision={JSON.stringify([
              state.data,
              runtime.agents,
              runtime.workspaceKnowledgeSources,
              projects.projects,
            ])}
            onOpenResult={(result: SearchResult) => {
              const plan = planSearchOpen({
                result,
                workspaceId,
                conversations: state.data.conversations,
                knowledgeSources: runtime.workspaceKnowledgeSources,
              });
              if (plan.kind === "unavailable") {
                service.report(new Error("This result is unavailable."));
                return;
              }
              setSearchOpen(false);
              setMarketplace(null);
              if (plan.kind === "conversation") nav.open(plan.conversationId);
              else if (plan.kind === "project") nav.open(plan.threadId);
              else if (plan.kind === "work") {
                nav.open(plan.conversationId);
                nav.selectNavWork(plan.workId);
              } else if (plan.kind === "agent-room") nav.open(plan.conversationId);
              else if (plan.kind === "agent-editor") {
                nav.setProjectDetailsId(null);
                setAgentEditor({ id: plan.agentId });
              }
              else {
                nav.setPanelRequest(plan.request);
                nav.setComputer(null);
                nav.setContextOpen(true);
              }
            }}
          />
        </Suspense>
      ) : null}
      {detailsProject && detailsRoom ? (
        <Suspense fallback={null}>
          <ProjectDetailsDialog
            project={detailsProject}
            room={detailsRoom}
            data={state.data}
            runtime={runtime}
            service={service}
            onClose={() => nav.setProjectDetailsId(null)}
            onOpen={(id) => {
              nav.setProjectDetailsId(null);
              nav.open(id);
            }}
            onEdit={() => {
              nav.setProjectDetailsId(null);
              setConversationDialog({
                kind: "edit",
                projectId: detailsProject.id,
              });
            }}
            onSchedules={() => {
              nav.setProjectDetailsId(null);
              setSchedules({
                projectId: detailsProject.id,
                agentId: detailsRoom.facilitatorId,
              });
            }}
            onUpdate={updateProject}
            onAddShare={async (share) => {
              const updated = await addLocalProjectShare({
                workspaceId,
                projectId: detailsProject.id,
                expectedRevision: detailsProject.revision,
                share,
              });
              projects.setProjects((current) =>
                current.map((project) =>
                  project.id === updated.id ? updated : project,
                ),
              );
              await service.refresh();
            }}
            onRemoveShare={async (shareId) => {
              const updated = await removeLocalProjectShare({
                workspaceId,
                projectId: detailsProject.id,
                expectedRevision: detailsProject.revision,
                shareId,
              });
              projects.setProjects((current) =>
                current.map((project) =>
                  project.id === updated.id ? updated : project,
                ),
              );
              await service.refresh();
            }}
          />
        </Suspense>
      ) : null}
      {conversationDialog ? (
        <WorkspaceConversationDialogs
          target={conversationDialog}
          onClose={() => setConversationDialog(null)}
          runtime={runtime}
          service={service}
          projects={projects}
          state={state}
          createRoom={createRoom}
          updateProject={updateProject}
          onOpen={nav.open}
        />
      ) : null}
      {agentEditor && !nav.projectDetailsId ? (
        <Suspense fallback={null}>
          <AgentEditor
            presentation={agentEditor.id ? "panel" : "modal"}
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
                nav.open(threadId);
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
                .data.work.filter(
                  (work: CollaborationWorkItem) =>
                    activeWork(work) && !work.parentId,
                ))
                await service.stop(work.id);
              await runtime.signOutIdentity();
            }}
          />
        </Suspense>
      ) : null}
    </>
  );
}
