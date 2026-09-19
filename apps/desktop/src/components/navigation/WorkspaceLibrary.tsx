import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { MivletAgentProfile } from "@mivlet/protocol";
import { FileText } from "@phosphor-icons/react/dist/csr/FileText";
import { ArrowRight } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { listRuntimeLocalComputerFiles } from "../../runtime/domains/local-computer";
import type { RightPanelTab } from "./right-panel-state";

export function WorkspaceLibrary({
  workspaceId,
  agents,
  onOpen,
}: {
  workspaceId: string;
  agents: MivletAgentProfile[];
  onOpen: (tab: RightPanelTab) => void;
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
  const visible = rows.filter((file) =>
    `${file.name} ${file.path} ${agents.find((agent) => agent.id === file.agentId)?.name ?? ""}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  return (
    <section className="workspace-library" aria-label="Library">
      <header className="workspace-library__heading">
        <div>
          <h2>Library</h2>
          <p>
            {rows.length} {rows.length === 1 ? "file" : "files"}
          </p>
        </div>
        <button
          type="button"
          disabled={files.isFetching}
          onClick={() => void files.refetch()}
        >
          Refresh
        </button>
      </header>
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
      !visible.length ? (
        <p className="right-panel__empty">
          {query.trim()
            ? "No files match your search."
            : "Files saved in your agents’ workspaces appear here."}
        </p>
      ) : null}
      {files.data?.some((result) => result.snapshot?.truncated) ? (
        <p>Showing a limited list of workspace files.</p>
      ) : null}
    </section>
  );
}
