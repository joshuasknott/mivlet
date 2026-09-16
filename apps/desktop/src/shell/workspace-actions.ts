import type { LocalProject, MivletAgentProfile } from "@mivlet/protocol";
import type { ConversationDraft } from "../components/projects/ConversationDialogs";
import { composerScopeKey } from "../hooks/useScopedComposer";
import type { ShellRuntime } from "../hooks/useShellRuntime";
import type { WorkspaceExecution } from "../lib/workspace-execution";
import { saveRuntimeConversationDraft } from "../runtime/domains/conversations";
import {
  createLocalProject,
  updateLocalProject,
} from "../runtime/domains/local-projects";

export type WorkspaceProjectStore = {
  projects: LocalProject[];
  setProjects: (
    updater: LocalProject[] | ((current: LocalProject[]) => LocalProject[]),
  ) => void;
};

export async function updateWorkspaceProject(
  deps: {
    workspaceId: string;
    projects: WorkspaceProjectStore;
    service: WorkspaceExecution;
  },
  project: LocalProject,
  patch: Pick<LocalProject, "name" | "instructions" | "knowledgeSourceIds">,
) {
  const updated = await updateLocalProject({
    workspaceId: deps.workspaceId,
    id: project.id,
    expectedRevision: project.revision,
    ...patch,
  });
  deps.projects.setProjects((current) =>
    current.map((entry) => (entry.id === updated.id ? updated : entry)),
  );
  await deps.service.refresh();
}

export async function saveWorkspaceDraft(
  deps: {
    runtime: ShellRuntime;
    workspaceId: string;
  },
  threadId: string,
  agentId: string,
  text: string,
  projectId?: string,
) {
  const owner = deps.runtime.accountWorkspaceStatus.activeContextOwner;
  const draftKey = composerScopeKey({
    workspaceId: deps.workspaceId,
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
    deps.workspaceId,
  );
}

export async function createWorkspaceRoom(
  deps: {
    runtime: ShellRuntime;
    service: WorkspaceExecution;
    workspaceId: string;
    projects: WorkspaceProjectStore;
    open: (id: string, newTab?: boolean) => void;
    saveDraft: (
      threadId: string,
      agentId: string,
      text: string,
      projectId?: string,
    ) => Promise<void>;
  },
  draft: ConversationDraft,
  projectId?: string,
  seedText?: string,
) {
  await deps.runtime.flushSnapshot();
  const id = `thread-${crypto.randomUUID()}`;
  if (draft.kind === "project" && !projectId) {
    const project = await createLocalProject({
      workspaceId: deps.workspaceId,
      id: `project-${crypto.randomUUID()}`,
      threadId: id,
      name: draft.title,
      instructions: draft.instructions,
      knowledgeSourceIds: [],
    });
    deps.projects.setProjects((current) => [...current, project]);
    const data = await deps.service
      .refresh()
      .then(() => deps.service.getSnapshot().data);
    const team = data.teams.find((entry) => entry.projectId === project.id);
    if (!team)
      throw new Error(
        "The project was saved, but its team could not be loaded. Reload the workspace to finish setup.",
      );
    await deps.service.command({
      action: "update-team",
      projectId: project.id,
      expectedRevision: team.revision,
      participantIds: draft.participantIds,
      leadAgentId: draft.facilitatorId || undefined,
      shareHistory: true,
    });
  } else
    await deps.service.command({
      action: "create-conversation",
      id,
      title: draft.title,
      kind: draft.kind === "project" ? "group" : "direct",
      participantIds: draft.participantIds,
      facilitatorId: draft.facilitatorId || undefined,
      projectId,
    });
  if (seedText && draft.facilitatorId)
    await deps.saveDraft(id, draft.facilitatorId, seedText, projectId);
  deps.open(id, true);
  return id;
}

export async function selectWorkspaceAgent(
  deps: {
    runtime: ShellRuntime;
    service: WorkspaceExecution;
    open: (id: string, newTab?: boolean) => void;
    createRoom: (
      draft: ConversationDraft,
      projectId?: string,
      seedText?: string,
    ) => Promise<string>;
  },
  agent: MivletAgentProfile,
  newConversation = false,
  text?: string,
) {
  if (!newConversation) {
    await deps.runtime.flushSnapshot();
    const data = await deps.service.command({
      action: "open-main-chat",
      agentId: agent.id,
    });
    const room = data.conversations.find(
      (entry) =>
        entry.chat?.role === "main" &&
        entry.chat.ownerKind === "agent" &&
        entry.chat.ownerId === agent.id,
    );
    if (!room) throw new Error("The main Chat could not be resolved.");
    deps.open(room.id);
    return room.id;
  }
  return deps.createRoom(
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
}
