import type { LocalProject } from "@fable/protocol";
import { lazy, Suspense } from "react";
import type { ConversationDraft } from "../components/projects/ConversationDialogs";
import type { useLocalProjects } from "../hooks/useLocalProjects";
import type { ShellRuntime } from "../hooks/useShellRuntime";
import type {
  WorkspaceExecution,
  WorkspaceExecutionState,
} from "../lib/workspace-execution";
import { migrateLegacyGroup } from "../runtime/domains/local-projects";

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

export type ConversationDialogTarget =
  | {
      kind: "edit";
      roomId?: string;
      projectId?: string;
      draft?: Partial<ConversationDraft>;
      focused?: boolean;
    }
  | { kind: "place" | "migrate"; id: string };

/** Conversation metadata, sharing and migration dialogs; execution stays with the workspace service. */
export function WorkspaceConversationDialogs({
  target,
  onClose,
  runtime,
  service,
  projects,
  state,
  createRoom,
  updateProject,
  onOpen,
}: {
  target: ConversationDialogTarget;
  onClose: () => void;
  runtime: ShellRuntime;
  service: WorkspaceExecution;
  projects: ReturnType<typeof useLocalProjects>;
  state: WorkspaceExecutionState;
  createRoom: (draft: ConversationDraft, projectId?: string) => Promise<string>;
  updateProject: (
    project: LocalProject,
    patch: Pick<LocalProject, "name" | "instructions" | "knowledgeSourceIds">,
  ) => Promise<void>;
  onOpen: (id: string) => void;
}) {
  const workspaceId =
    runtime.accountWorkspaceStatus.activeWorkspace.localWorkspaceId;
  const editor = target.kind === "edit" ? target : null;
  const placeId = target.kind === "place" ? target.id : null;
  const migrateId = target.kind === "migrate" ? target.id : null;
  const editingRoom = state.data.conversations.find(
    (room) => room.id === editor?.roomId,
  );
  const editingProject = projects.projects.find(
    (project) => project.id === editor?.projectId,
  );
  const editingTeam = state.data.teams.find(
    (team) => team.projectId === editingProject?.id,
  );

  return (
    <>
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
                    kind: editingRoom.kind === "direct" ? "direct" : "project",
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
            onClose={onClose}
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
            onClose={onClose}
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
            onClose={onClose}
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
              onOpen(updated.threadId);
            }}
          />
        </Suspense>
      ) : null}
    </>
  );
}
