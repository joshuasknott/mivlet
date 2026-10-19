import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  CollaborationWorkItem,
  ConversationRoom,
  KnowledgeSource,
  LocalProject,
  MivletAgentProfile,
} from "@mivlet/protocol";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { useWorkspaceLocalFiles } from "../../hooks/useWorkspaceLocalFiles";
import { NativeExecutionSetup } from "./NativeExecutionSetup";
import { NativeCommandJobs } from "./NativeCommandJobs";
import { listRuntimeOutputs } from "../../runtime/domains/outputs";
import { subscribeOutputPinned } from "../../lib/output-revision-events";
import { PanelFileRow } from "./PanelFileRow";
import { PanelPagination } from "./PanelPagination";
import { panelFiles, type PanelFile } from "./workspace-panel-data";
import type { RightPanelTab } from "./right-panel-state";

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
  type FileOrigin = PanelFile["origin"];
  const [origin, setOrigin] = useState<FileOrigin | "all">("all");
  const [page, setPage] = useState(0);
  const [workingPage, setWorkingPage] = useState(0);
  const region = useRef<HTMLElement>(null);
  const pageSize = 24;
  const [technical, setTechnical] = useState(false);
  const pinned = useQuery({
    queryKey: ["workspace-pinned-outputs", workspaceId],
    enabled: Boolean(workspaceId),
    retry: false,
    queryFn: () =>
      listRuntimeOutputs({
        includeUnpinned: false,
        expectedWorkspaceId: workspaceId,
      }),
  });
  useEffect(
    () =>
      subscribeOutputPinned((event) => {
        if (event.workspaceId === workspaceId) void pinned.refetch();
      }),
    [workspaceId, pinned.refetch],
  );
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
  const files: PanelFile[] = [
    ...scopedFiles,
    ...(pinned.data ?? []).map((output) => ({
      id: "pinned:" + output.id,
      title: output.title,
      detail: "Pinned output",
      origin: "created" as const,
      updatedAt: output.updatedAt,
      tab: {
        id: "output:" + output.id,
        kind: "output" as const,
        title: output.title,
        outputId: output.id,
      },
    })),
  ];
  const search = query.trim().toLowerCase();
  const origins = [...new Set(files.map((file) => file.origin))];
  const showOriginFilter = origins.length > 1;
  const activeOrigin =
    showOriginFilter && origin !== "all" && origins.includes(origin)
      ? origin
      : "all";
  useEffect(() => {
    if (!showOriginFilter && origin !== "all") setOrigin("all");
  }, [origin, showOriginFilter]);
  const filtered = files.filter(
    (file) =>
      (activeOrigin === "all" || file.origin === activeOrigin) &&
      (file.title + " " + file.detail).toLowerCase().includes(search),
  );
  const listing = useWorkspaceLocalFiles(
    workspaceId,
    technical ? agents.map((agent) => agent.id) : [],
    work,
  );
  const workingFiles = (listing.data ?? []).flatMap(({ agentId, snapshot }) =>
    (snapshot?.entries ?? [])
      .filter((file) => file.kind === "file")
      .map((file) => ({ ...file, agentId })),
  );
  const visibleWorkingFiles = workingFiles.filter((file) =>
    (file.name + " " + file.path).toLowerCase().includes(search),
  );
  const currentPage = Math.min(
    page,
    Math.max(0, Math.ceil(filtered.length / pageSize) - 1),
  );
  const currentWorkingPage = Math.min(
    workingPage,
    Math.max(0, Math.ceil(visibleWorkingFiles.length / pageSize) - 1),
  );
  return (
    <section ref={region} className="workspace-library" aria-label="Files">
      <div className="panel-collection__controls">
        <div className="workspace-library__toolbar">
          <label className="workspace-library__search">
            <MagnifyingGlass size={17} aria-hidden="true" />
            <input
              type="search"
              aria-label="Search files"
              placeholder="Search files"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(0);
                setWorkingPage(0);
              }}
            />
          </label>
          {addFiles}
        </div>
        {files.length > 0 && (
          <div className="workspace-library__filters">
            {showOriginFilter ? <select
                aria-label="File collection"
                value={activeOrigin}
                onChange={(event) => {
                  setOrigin(event.target.value as FileOrigin | "all");
                  setPage(0);
                  setWorkingPage(0);
                }}
              >
                <option value="all">All files</option>
                {origins.includes("created") ? <option value="created">Created here</option> : null}
                {origins.includes("attached") ? <option value="attached">Added to chat</option> : null}
                {origins.includes("shared") ? <option value="shared">Shared with agent</option> : null}
              </select> : <span>{origins[0] === "created" ? "Created here" : origins[0] === "attached" ? "Added to chat" : "Shared with agent"}</span>}
            <span>
              {filtered.length} {filtered.length === 1 ? "file" : "files"}
            </span>
          </div>
        )}
      </div>
      <div className="workspace-library__file-list">
        {filtered
          .slice(currentPage * pageSize, (currentPage + 1) * pageSize)
          .map((file) => (
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
      <PanelPagination
        total={filtered.length}
        page={currentPage}
        pageSize={pageSize}
        label="Files"
        onChange={(next) => {
          setPage(next);
          if (region.current) region.current.scrollTop = 0;
        }}
      />
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
            <div className="workspace-library__file-list">
              {visibleWorkingFiles
                .slice(
                  currentWorkingPage * pageSize,
                  (currentWorkingPage + 1) * pageSize,
                )
                .map((file) => (
                  <PanelFileRow
                    key={file.agentId + ":" + file.path}
                    workspaceId={workspaceId}
                    onOpen={onOpen}
                    file={{
                      id: "library:" + file.agentId + ":" + file.path,
                      title: file.name,
                      detail:
                        agents.find((agent) => agent.id === file.agentId)
                          ?.name ?? "Agent workspace",
                      origin: "created",
                      updatedAt: "",
                      tab: {
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
                      },
                    }}
                  />
                ))}
            </div>
            <PanelPagination
              total={visibleWorkingFiles.length}
              page={currentWorkingPage}
              pageSize={pageSize}
              label="Agent files"
              onChange={setWorkingPage}
            />
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
