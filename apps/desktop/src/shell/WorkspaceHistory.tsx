import { useEffect, useState } from "react";
import type { ConversationRoom } from "@mivlet/protocol";
import { CoordinationActivity } from "../components/work/CoordinationActivity";
import { WorkDetails } from "../components/work/WorkDetails";
import type { ShellRuntime } from "../hooks/useShellRuntime";
import { useScopedComposer } from "../hooks/useScopedComposer";
import { workspaceMentionToken } from "../lib/collaboration-mentions";
import { promoteWorkOutputToMemory } from "../lib/work-memory";
import type { WorkspaceExecution, WorkspaceExecutionState } from "../lib/workspace-execution";

export function WorkspaceHistory({ room, runtime, service, state, selectedWorkId, onOpenConversation }: {
  room?: ConversationRoom;
  runtime: ShellRuntime;
  service: WorkspaceExecution;
  state: WorkspaceExecutionState;
  selectedWorkId: string | null;
  onOpenConversation: (id: string) => void;
}) {
  const [selection, setSelection] = useState(selectedWorkId);
  useEffect(() => setSelection(selectedWorkId), [selectedWorkId]);
  const owner = runtime.accountWorkspaceStatus.activeContextOwner;
  const composer = useScopedComposer(room ? {
    workspaceId: service.workspaceId,
    accountId: `${owner?.internalUserId}:${owner?.memberId ?? ""}`,
    agentId: room.facilitatorId ?? "unavailable",
    projectId: room.projectId,
    threadId: room.id,
  } : undefined);
  const roots = new Set(state.data.work.filter(item => item.conversationId === room?.id && !item.parentId).map(item => item.rootId));
  const work = state.data.work.filter(item => roots.has(item.rootId));
  const selected = work.find(item => item.id === selection);
  return selected ? <section aria-label="History details">
    <button type="button" onClick={() => setSelection(null)}>Back to history</button>
    <WorkDetails key={selected.id} item={selected} onOpen={onOpenConversation}
      onStop={id => service.stop(id)}
      onContinue={async (id, generation) => { await service.command({ action: "continue-work", id, expectedGeneration: generation, reconcile: true }); }}
      onSteer={async (id, generation, text) => { await service.steer(id, generation, text); }}
      onPromote={async (output, item, value) => { await promoteWorkOutputToMemory(item, output, value, runtime.memoryState); }} />
  </section> : <CoordinationActivity work={work} agents={runtime.agents}
    onInspect={setSelection}
    onStop={id => { void service.stop(id).catch(error => service.report(error)); }}
    onFollowUp={(id, name, workId) => {
      if (!room) return;
      composer.setReplyWork(workId);
      composer.setText(`${workspaceMentionToken({ id, name })}, `);
      onOpenConversation(room.id);
    }} />;
}
