import { useEffect, useState } from "react";
import type { CollaborationWorkItem, ConversationRoom, WorkOutput } from "@mivlet/protocol";
import { panelWork } from "../components/navigation/workspace-panel-data";
import { CoordinationActivity } from "../components/work/CoordinationActivity";
import { WorkDetails } from "../components/work/WorkDetails";
import type { ShellRuntime } from "../hooks/useShellRuntime";
import { useScopedComposer } from "../hooks/useScopedComposer";
import { workspaceMentionToken } from "../lib/collaboration-mentions";
import { promoteWorkOutputToMemory } from "../lib/work-memory";
import type {
  WorkspaceExecution,
  WorkspaceExecutionState,
} from "../lib/workspace-execution";

export function WorkspaceHistory({
  room,
  runtime,
  service,
  state,
  selectedWorkId,
  onOpenConversation,
  workItems,
}: {
  room?: ConversationRoom;
  runtime: ShellRuntime;
  service: WorkspaceExecution;
  state: WorkspaceExecutionState;
  selectedWorkId: string | null;
  onOpenConversation: (id: string, source?: Pick<WorkOutput, "branchId" | "messageId" | "sourceRevisionId">) => void;
  workItems?: CollaborationWorkItem[];
}) {
  const [selection, setSelection] = useState(selectedWorkId);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(20);
  const [reply, setReply] = useState<{
    room: ConversationRoom;
    agentId: string;
    name: string;
    workId: string;
  } | null>(null);
  useEffect(() => setSelection(selectedWorkId), [selectedWorkId]);
  const owner = runtime.accountWorkspaceStatus.activeContextOwner;
  const draftRoom = reply?.room ?? room;
  const composer = useScopedComposer(
    draftRoom
      ? {
          workspaceId: service.workspaceId,
          accountId: `${owner?.internalUserId}:${owner?.memberId ?? ""}`,
          agentId: draftRoom.facilitatorId ?? "unavailable",
          projectId: draftRoom.projectId,
          threadId: draftRoom.id,
        }
      : undefined,
  );
  useEffect(() => {
    if (!reply) return;
    composer.setReplyWork(reply.workId);
    composer.setText(
      workspaceMentionToken({ id: reply.agentId, name: reply.name }) + ", ",
    );
    onOpenConversation(reply.room.id);
    setReply(null);
  }, [reply]);
  const work =
    workItems ??
    panelWork(service.workspaceId, room ? [room] : [], state.data.work);
  const matches = new Set(
    work
      .filter((item) =>
        (item.userRequest + " " + item.prompt + " " + item.agentName)
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
      )
      .map((item) => item.rootId),
  );
  const roots = work
    .filter((item) => !item.parentId && matches.has(item.rootId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const visibleRoots = new Set(
    roots.slice(0, limit).map((item) => item.rootId),
  );
  const visible = work.filter((item) => visibleRoots.has(item.rootId));
  const selected = work.find((item) => item.id === selection);
  return selected ? (
    <section aria-label="Activity details">
      <button type="button" onClick={() => setSelection(null)}>
        Back to activity
      </button>
      <WorkDetails
        key={selected.id}
        item={selected}
        onOpen={onOpenConversation}
        onProviderReset={(command) => service.command(command)}
        onStop={(id) => service.stop(id)}
        onContinue={async (id, generation) => {
          await service.command({
            action: "continue-work",
            id,
            expectedGeneration: generation,
            reconcile: true,
          });
        }}
        onSteer={async (id, generation, text) => {
          await service.steer(id, generation, text);
        }}
        onPromote={async (output, item, value) => {
          await promoteWorkOutputToMemory(
            item,
            output,
            value,
            runtime.memoryState,
          );
        }}
      />
    </section>
  ) : (
    <div className="workspace-history">
      {work.length > 0 && (
        <label className="workspace-library__search">
          <input
            type="search"
            aria-label="Search work history"
            placeholder="Search work history"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setLimit(20);
            }}
          />
        </label>
      )}
      <CoordinationActivity
        work={visible}
        agents={runtime.agents}
        onInspect={setSelection}
        onStop={(id) => {
          void service.stop(id).catch((error) => service.report(error));
        }}
        onFollowUp={(id, name, workId) => {
          const assignment = work.find((item) => item.id === workId);
          const root = work.find((item) => item.id === assignment?.rootId);
          const origin = root
            ? (state.data.conversations?.find(
                (entry) =>
                  entry.workspaceId === service.workspaceId &&
                  entry.id === root.conversationId,
              ) ?? (room?.id === root.conversationId ? room : undefined))
            : undefined;
          if (origin) setReply({ room: origin, agentId: id, name, workId });
        }}
      />
      {roots.length > limit && (
        <button
          type="button"
          className="workspace-panel__link"
          onClick={() => setLimit((value) => value + 20)}
        >
          Show more history ({roots.length - limit})
        </button>
      )}
    </div>
  );
}
