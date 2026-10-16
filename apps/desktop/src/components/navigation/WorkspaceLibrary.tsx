import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  CollaborationWorkItem,
  ConversationRoom,
  KnowledgeSource,
  LocalProject,
  MivletAgentProfile,
} from "@mivlet/protocol";
import { FileText } from "@phosphor-icons/react/dist/csr/FileText";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { useWorkspaceLocalFiles } from "../../hooks/useWorkspaceLocalFiles";
import { NativeExecutionSetup } from "./NativeExecutionSetup";
import { NativeCommandJobs } from "./NativeCommandJobs";
import { listRuntimeOutputs } from "../../runtime/domains/outputs";
import { subscribeOutputPinned } from "../../lib/output-revision-events";
import { PanelFileRow } from "./PanelFileRow";
import { panelFiles, type PanelFile } from "./workspace-panel-data";
import type { RightPanelTab } from "./right-panel-state";

const RepositoryFiles = lazy(() => import("./RepositoryFiles").then((module) => ({ default: module.RepositoryFiles })));

export function WorkspaceLibrary({
  workspaceId,
  agents,
  onOpen,
  room,
  work = [],
  project,
  sources = [],
  addFiles,
  files: suppliedFiles,
}: {
  workspaceId: string;
  agents: MivletAgentProfile[];
  onOpen: (tab: RightPanelTab) => void;
  room?: ConversationRoom;
  work?: CollaborationWorkItem[];
  project?: LocalProject;
  sources?: KnowledgeSource[];
  addFiles?: ReactNode;
  files?: PanelFile[];
}) {
  const [query, setQuery] = useState("");
  const [origin, setOrigin] = useState("all");
  const [limit, setLimit] = useState(40);
  const [technical, setTechnical] = useState(false);
  const pinned = useQuery({
    queryKey: ["workspace-pinned-outputs", workspaceId],
    enabled: Boolean(workspaceId),
    retry: false,
    queryFn: () => listRuntimeOutputs({ includeUnpinned: false, expectedWorkspaceId: workspaceId }),
  });
  useEffect(() => subscribeOutputPinned((event) => {
    if (event.workspaceId === workspaceId) void pinned.refetch();
  }), [workspaceId, pinned.refetch]);
  const scopedFiles =
    suppliedFiles ??
    panelFiles({
      workspaceId,
      work: work.filter(
        (item) =>
          item.workspaceId === workspaceId && item.conversationId === room?.id,
      ),
      project,
      sources,
    });
  const files: PanelFile[] = [...scopedFiles, ...(pinned.data ?? []).map((output) => ({
    id: "pinned:" + output.id, title: output.title, detail: "Pinned output", origin: "created" as const,
    updatedAt: output.updatedAt, tab: { id: "output:" + output.id, kind: "output" as const, title: output.title, outputId: output.id },
  }))];
  const search = query.trim().toLowerCase();
  const filtered = files.filter(
    (file) =>
      (origin === "all" || file.origin === origin) &&
      (file.title + " " + file.detail).toLowerCase().includes(search),
  );
  const listing = useWorkspaceLocalFiles(workspaceId, technical ? agents.map(agent => agent.id) : [], work);
  const workingFiles = (listing.data ?? []).flatMap(({ agentId, snapshot }) =>
    (snapshot?.entries ?? [])
      .filter((file) => file.kind === "file")
      .map((file) => ({ ...file, agentId })),
  );
  const visibleWorkingFiles = workingFiles.filter((file) =>
    (file.name + " " + file.path).toLowerCase().includes(search),
  );
  return (
    <section className="workspace-library" aria-label="Files">
      <header className="workspace-library__heading">
        <h2>Files</h2>
        {addFiles}
      </header>
      <label className="workspace-library__search">
        <MagnifyingGlass size={17} aria-hidden="true" />
        <input
          type="search"
          aria-label="Search files"
          placeholder="Search files"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setLimit(40);
          }}
        />
      </label>
      {files.length > 0 && (
        <div className="workspace-library__filters">
          <select
            aria-label="File collection"
            value={origin}
            onChange={(event) => {
              setOrigin(event.target.value);
              setLimit(40);
            }}
          >
            <option value="all">All files</option>
            <option value="created">Created here</option>
            <option value="attached">Added to chat</option>
            <option value="shared">Shared with agent</option>
          </select>
          <span>
            {filtered.length} {filtered.length === 1 ? "file" : "files"}
          </span>
        </div>
      )}
      <div className="workspace-library__cards">
        {filtered.slice(0, limit).map((file) => (
          <PanelFileRow
            key={file.id}
            workspaceId={workspaceId}
            file={file}
            onOpen={onOpen}
          />
        ))}
      </div>
      {!filtered.length && (
        <p className="right-panel__empty">
          {search || origin !== "all"
            ? "No files match your search."
            : "Files shared or created here will appear here."}
        </p>
      )}
      {filtered.length > limit && (
        <button
          type="button"
          className="workspace-panel__link"
          onClick={() => setLimit((value) => value + 40)}
        >
          Show more files ({filtered.length - limit})
        </button>
      )}
      <details
        className="workspace-library__technical"
        onToggle={(event) => setTechnical(event.currentTarget.open)}
      >
        <summary>Agent files &amp; setup</summary>
        {technical && (
          <>
            <NativeExecutionSetup />
            <NativeCommandJobs workspaceId={workspaceId} agents={agents} />
            <Suspense fallback={<p role="status">Loading repository…</p>}>
              <RepositoryFiles workspaceId={workspaceId} agents={agents} />
            </Suspense>
            <h3>Agent workspace files</h3>
            {listing.isFetching && <p role="status">Loading files…</p>}
            {listing.data
              ?.filter((result) => result.error)
              .map((result) => (
                <p role="alert" key={result.agentId}>
                  {agents.find((agent) => agent.id === result.agentId)?.name}:{" "}
                  {result.error}
                </p>
              ))}
            <div className="workspace-library__cards">
              {visibleWorkingFiles.slice(0, limit).map((file) => (
                <button
                  type="button"
                  className="workspace-library__card"
                  key={file.agentId + ":" + file.path}
                  onClick={() =>
                    onOpen({
                      id: "library:" + file.agentId + ":" + file.path,
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
                  <FileText size={21} aria-hidden="true" />
                  <span className="workspace-library__detail">
                    <strong>{file.name}</strong>
                    <small>
                      {agents.find((agent) => agent.id === file.agentId)?.name}
                    </small>
                  </span>
                </button>
              ))}
            </div>
            {visibleWorkingFiles.length > limit && (
              <button
                type="button"
                className="workspace-panel__link"
                onClick={() => setLimit((value) => value + 40)}
              >
                Show more agent files
              </button>
            )}
            {!listing.isFetching &&
              !listing.data?.some((result) => result.error) &&
              !visibleWorkingFiles.length && (
                <p className="workspace-activity__quiet">
                  {search
                    ? "No files match your search."
                    : "No agent workspace files yet."}
                </p>
              )}
            {listing.data?.some((result) => result.snapshot?.truncated) && (
              <p>Showing a limited list of workspace files.</p>
            )}
            <button
              className="workspace-panel__link"
              type="button"
              disabled={listing.isFetching}
              onClick={() => void listing.refetch()}
            >
              Refresh files
            </button>
          </>
        )}
      </details>
    </section>
  );
}
