import { lazy, Suspense, useEffect, useState } from "react";
import { isLiveSource } from "@mivlet/knowledge";
import { useQuery } from "@tanstack/react-query";
import type {
  MivletAgentProfile,
  ConversationRoom,
  CollaborationWorkItem,
  LocalProject,
  KnowledgeSource,
} from "@mivlet/protocol";
import { FileText } from "@phosphor-icons/react/dist/csr/FileText";
import { ArrowRight } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { listRuntimeLocalComputerFiles } from "../../runtime/domains/local-computer";
import { listRuntimeOutputs } from "../../runtime/domains/outputs";
import type { RightPanelTab } from "./right-panel-state";
import { NativeExecutionSetup } from "./NativeExecutionSetup";
import { NativeCommandJobs } from "./NativeCommandJobs";
import { MessageAttachments } from "../conversation/MessageAttachments";
import { parseComputerArtifact } from "../../lib/computer-artifacts";
import { subscribeOutputPinned } from "../../lib/output-revision-events";
import type { ReactNode } from "react";

const RepositoryFiles = lazy(() =>
  import("./RepositoryFiles").then((module) => ({
    default: module.RepositoryFiles,
  })),
);

export function WorkspaceLibrary({
  workspaceId,
  agents,
  onOpen,
  room,
  work = [],
  project,
  sources = [],
  addFiles,
}: {
  workspaceId: string;
  agents: MivletAgentProfile[];
  onOpen: (tab: RightPanelTab) => void;
  room?: ConversationRoom;
  work?: CollaborationWorkItem[];
  project?: LocalProject;
  sources?: KnowledgeSource[];
  addFiles?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const files = useQuery({
    queryKey: [
      "workspace-library",
      workspaceId,
      agents.map((agent) => agent.id),
    ],
    enabled: Boolean(workspaceId),
    retry: false,
    gcTime: 0,
    queryFn: async () =>
      Promise.all(
        agents.map(async (agent) => {
          try {
            const snapshot = await listRuntimeLocalComputerFiles({
              workspaceId,
              agentId: agent.id,
            });
            return {
              agentId: agent.id,
              snapshot,
              error: snapshot
                ? ""
                : "Open the desktop app to view saved files.",
            };
          } catch (error) {
            return {
              agentId: agent.id,
              snapshot: null,
              error:
                error instanceof Error
                  ? error.message
                  : "Files could not be loaded.",
            };
          }
        }),
      ),
  });
  const rows = (files.data ?? []).flatMap(({ agentId, snapshot }) =>
    (snapshot?.entries ?? [])
      .filter((file) => file.kind === "file")
      .map((file) => ({ ...file, agentId })),
  );
  const pinnedOutputs = useQuery({
    queryKey: ["workspace-pinned-outputs", workspaceId],
    enabled: Boolean(workspaceId),
    retry: false,
    queryFn: async () => {
      try {
        return await listRuntimeOutputs({
          includeUnpinned: false,
          expectedWorkspaceId: workspaceId,
        });
      } catch {
        return [];
      }
    },
  });
  useEffect(() => {
    return subscribeOutputPinned((event) => {
      if (event.workspaceId === workspaceId) void pinnedOutputs.refetch();
    });
  }, [workspaceId, pinnedOutputs.refetch]);
  const visible = rows.filter((file) =>
    `${file.name} ${file.path} ${agents.find((agent) => agent.id === file.agentId)?.name ?? ""}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const matches = (text: string) =>
    text.toLowerCase().includes(query.trim().toLowerCase());
  const visiblePinnedOutputs = (pinnedOutputs.data ?? []).filter((output) =>
    matches(output.title),
  );
  const chatWork = room
    ? work.filter(
        (item) =>
          item.workspaceId === workspaceId && item.conversationId === room.id,
      )
    : [];
  const seenAttachments = new Set<string>();
  const attachments = chatWork.flatMap((item) =>
    (item.attachments ?? [])
      .filter((file) => {
        const key = `${item.agentId}:${file.id}`;
        if (seenAttachments.has(key)) return false;
        seenAttachments.add(key);
        return matches(file.name);
      })
      .map((file) => ({ file, agentId: item.agentId })),
  );
  const created = chatWork
    .flatMap((item) =>
      item.outputs.flatMap((output) => {
        const artifact = parseComputerArtifact(output.text);
        return artifact && matches(artifact.title)
          ? [{ artifact, output: output.text, agentId: item.agentId }]
          : [];
      }),
    )
    .filter(
      (entry, index, all) =>
        all.findIndex(
          (other) =>
            other.artifact.id === entry.artifact.id &&
            other.agentId === entry.agentId,
        ) === index,
    );
  const projectFiles = sources.filter(
    (source) =>
      project?.knowledgeSourceIds.includes(source.id) &&
      source.connectorId === "local-files" &&
      isLiveSource(source) &&
      (!source.workspaceId || source.workspaceId === workspaceId) &&
      matches(source.title),
  );
  return (
    <section className="workspace-library" aria-label="Files">
      <header className="workspace-library__heading">
        <div>
          <h2>Files</h2>
          <p>
            {room?.title ??
              `${rows.length} ${rows.length === 1 ? "file" : "files"}`}
          </p>
        </div>
        {addFiles ?? (
          <button
            type="button"
            disabled={files.isFetching}
            onClick={() => void files.refetch()}
          >
            Refresh
          </button>
        )}
      </header>
      <NativeExecutionSetup />
      <NativeCommandJobs workspaceId={workspaceId} agents={agents} />
      <Suspense fallback={<p role="status">Loading repository…</p>}>
        <RepositoryFiles workspaceId={workspaceId} agents={agents} />
      </Suspense>
      <label className="workspace-library__search">
        <MagnifyingGlass size={17} aria-hidden="true" />
        <input
          type="search"
          aria-label="Search files"
          placeholder="Search files"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {files.isFetching ? <p role="status">Loading files…</p> : null}
      {files.data
        ?.filter((result) => result.error)
        .map((result) => (
          <p role="alert" key={result.agentId}>
            {agents.find((agent) => agent.id === result.agentId)?.name}:{" "}
            {result.error}
          </p>
        ))}
      {attachments.length > 0 && (
        <section className="workspace-library__group">
          <h3>Attached to this chat</h3>
          {attachments.map(({ file, agentId }) =>
            file.sourceId ? (
              <button
                className="workspace-library__card"
                key={`${agentId}:${file.id}`}
                onClick={() => {
                  const source = sources.find(
                    (source) =>
                      source.id === file.sourceId &&
                      isLiveSource(source) &&
                      (!source.workspaceId ||
                        source.workspaceId === workspaceId),
                  );
                  onOpen({
                    id: `attachment:${file.id}`,
                    kind: "file",
                    title: file.name,
                    target: {
                      type: "knowledge-file",
                      workspaceId,
                      sourceId: file.sourceId!,
                    },
                    text:
                      source?.contentPreview ??
                      "Original unavailable. Reattach this file to preview it.",
                  });
                }}
              >
                <FileText size={22} />
                <span>{file.name}</span>
              </button>
            ) : (
              <MessageAttachments
                key={`${agentId}:${file.id}`}
                workspaceId={workspaceId}
                threadId={room?.id}
                agentId={agentId}
                attachments={[
                  {
                    ...file,
                    availability:
                      file.availability === "transient"
                        ? "knowledge-context"
                        : file.availability,
                  },
                ]}
              />
            ),
          )}
        </section>
      )}
      {created.length > 0 && (
        <section className="workspace-library__group">
          <h3>Created here</h3>
          {created.map(({ artifact, output, agentId }) => (
            <button
              className="workspace-library__card"
              key={`${agentId}:${artifact.id}`}
              onClick={() =>
                onOpen({
                  id: `artifact:${agentId}:${artifact.id}`,
                  kind: "artifact",
                  title: artifact.title,
                  output,
                  agentId,
                })
              }
            >
              <FileText size={22} />
              <span>{artifact.title}</span>
            </button>
          ))}
        </section>
      )}
      {visiblePinnedOutputs.length > 0 && (
        <section className="workspace-library__group">
          <h3>Pinned outputs</h3>
          {visiblePinnedOutputs.map((output) => {
            const pinnedRevision = output.pin?.revisionId
              ? output.revisions.find(
                  (revision) => revision.id === output.pin?.revisionId,
                )
              : undefined;
            return (
              <button
                className="workspace-library__card"
                key={output.id}
                onClick={() =>
                  onOpen({
                    id: `output:${output.id}`,
                    kind: "output",
                    title: output.title,
                    outputId: output.id,
                  })
                }
              >
                <span className="workspace-library__icon">
                  <FileText size={22} aria-hidden="true" />
                </span>
                <span className="workspace-library__detail">
                  <strong>{output.title}</strong>
                  <small>
                    {output.format} · pinned revision {pinnedRevision?.number ?? output.currentRevisionNumber}
                  </small>
                </span>
                <ArrowRight size={16} aria-hidden="true" />
              </button>
            );
          })}
        </section>
      )}
      {projectFiles.length > 0 && (
        <section className="workspace-library__group">
          <h3>Project files</h3>
          {projectFiles.map((source) => (
            <button
              className="workspace-library__card"
              key={source.id}
              onClick={() =>
                onOpen({
                  id: `source:${source.id}`,
                  kind: "file",
                  title: source.title,
                  target: {
                    type: "knowledge-file",
                    workspaceId,
                    sourceId: source.id,
                    projectId: project?.id,
                  },
                  text: source.contentPreview ?? "Preview unavailable.",
                })
              }
            >
              <FileText size={22} />
              <span>{source.title}</span>
            </button>
          ))}
        </section>
      )}
      {visible.length > 0 && (
        <h3 className="workspace-library__group-title">
          Agent workspace files
        </h3>
      )}
      <div className="workspace-library__cards">
        {visible.map((file) => (
          <button
            type="button"
            className="workspace-library__card"
            key={`${file.agentId}:${file.path}`}
            onClick={() =>
              onOpen({
                id: `library:${file.agentId}:${file.path}`,
                kind: "file",
                title: file.name,
                target: {
                  type: "artifact",
                  workspaceId,
                  agentId: file.agentId,
                  relativePath: file.path,
                  title: file.name,
                },
              })
            }
          >
            <span className="workspace-library__icon">
              <FileText size={22} aria-hidden="true" />
            </span>
            <span className="workspace-library__detail">
              <strong title={file.path}>{file.name}</strong>
              <small>
                {file.name.includes(".")
                  ? file.name.split(".").pop()?.toUpperCase()
                  : "File"}{" "}
                · {agents.find((agent) => agent.id === file.agentId)?.name}
              </small>
            </span>
            <ArrowRight size={16} aria-hidden="true" />
          </button>
        ))}
      </div>
      {!files.isFetching &&
      !files.data?.some((result) => result.error) &&
      !visible.length &&
      !attachments.length &&
      !created.length &&
      !visiblePinnedOutputs.length &&
      !projectFiles.length ? (
        <p className="right-panel__empty">
          {query.trim()
            ? "No files match your search."
            : "Files saved in your agents’ workspaces appear here."}
        </p>
      ) : null}
      {files.data?.some((result) => result.snapshot?.truncated) ? (
        <p>Showing a limited list of workspace files.</p>
      ) : null}
      {addFiles && (
        <button
          className="workspace-library__refresh"
          type="button"
          disabled={files.isFetching}
          onClick={() => void files.refetch()}
        >
          Refresh files
        </button>
      )}
    </section>
  );
}
