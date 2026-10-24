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
  let draftProjectId = projectId;
  if (draft.kind === "project" && !projectId) {
    const project = await createLocalProject({
      workspaceId: deps.workspaceId,
      id: `project-${crypto.randomUUID()}`,
      threadId: id,
      name: draft.title,
      instructions: draft.instructions,
      knowledgeSourceIds: draft.knowledgeSourceIds ?? [],
      participantIds: draft.participantIds,
      leadAgentId: draft.facilitatorId || undefined,
    });
    draftProjectId = project.id;
    deps.projects.setProjects((current) => [...current, project]);
    await deps.service.refresh();
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
    await deps.saveDraft(id, draft.facilitatorId, seedText, draftProjectId);
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
