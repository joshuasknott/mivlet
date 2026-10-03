import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { MivletAgentProfile } from "@mivlet/protocol";
import {
  attachCodingRepository,
  inspectCodingRepository,
} from "../../runtime/domains/coding";
import {
  cancelRuntimeLocalComputer,
  loadRuntimeLocalComputer,
} from "../../runtime/domains/local-computer";
import "./repository-files.css";

export function RepositoryFiles({
  workspaceId,
  agents,
}: {
  workspaceId: string;
  agents: MivletAgentProfile[];
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState("");
  const agent = agents.find((item) => item.id === selected) ?? agents[0];
  return (
    <details
      className="repository-files"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Repository</summary>
      <p>
        Give a named agent a coding task using a separate copy of a Git
        repository.
      </p>
      {agents.length > 1 && (
        <label>
          Agent{" "}
          <select
            value={agent?.id ?? ""}
            onChange={(event) => setSelected(event.target.value)}
          >
            {agents.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {agent && open ? (
        <RepositoryDetails
          key={`${workspaceId}:${agent.id}`}
          workspaceId={workspaceId}
          agentId={agent.id}
          name={agent.name}
        />
      ) : !agent ? (
        <p>Create a named agent first.</p>
      ) : null}
    </details>
  );
}

function RepositoryDetails({
  workspaceId,
  agentId,
  name,
}: {
  workspaceId: string;
  agentId: string;
  name: string;
}) {
  const target = { workspaceId, agentId };
  const epoch = async () => {
    const computer = await loadRuntimeLocalComputer(target);
    if (!computer)
      throw new Error("Open the desktop app to attach a repository.");
    if (!computer.plugins?.computer)
      throw new Error(
        "Enable Computer Use in Plugins to use repository tools.",
      );
    return { ...target, expectedGeneration: computer.generation };
  };
  const status = useQuery({
    queryKey: ["coding-repository", workspaceId, agentId],
    retry: false,
    gcTime: 0,
    queryFn: async () => inspectCodingRepository(await epoch()),
    refetchInterval: (query) => (query.state.data?.busy ? 1000 : 5000),
  });
  const attach = useMutation({
    mutationFn: async () => attachCodingRepository(await epoch()),
    onSuccess: () => {
      void status.refetch();
    },
  });
  const stop = useMutation({
    mutationFn: async () => cancelRuntimeLocalComputer(await epoch()),
    onSuccess: () => {
      void status.refetch();
    },
  });
  const repo = status.data?.repository;
  const changes = status.data?.changes;
  const error = attach.error ?? stop.error ?? status.error;
  return (
    <div>
      <p>
        Starts at committed HEAD. Your existing files and uncommitted changes
        stay untouched. Earlier attached copies are kept.
      </p>
      <div className="repository-files__actions">
        <button
          type="button"
          disabled={
            attach.isPending ||
            status.data?.busy ||
            repo?.operation.startsWith("publication")
          }
          onClick={() => attach.mutate()}
        >
          {attach.isPending
            ? "Attaching…"
            : repo
              ? "Attach another repository"
              : "Attach repository"}
        </button>
        {repo && (
          <button
            type="button"
            disabled={status.isFetching}
            onClick={() => void status.refetch()}
          >
            Review changes
          </button>
        )}
        {status.data?.busy && (
          <button
            type="button"
            disabled={stop.isPending}
            onClick={() => stop.mutate()}
          >
            Stop
          </button>
        )}
      </div>
      {error && (
        <p role="alert">
          {error instanceof Error
            ? error.message
            : "Repository operation failed."}
        </p>
      )}
      {repo && (
        <>
          <p>
            <strong>{repo.name}</strong> · {name}
            <br />
            <code>{repo.branch}</code>
          </p>
          {repo.remote && (
            <p>
              Publication destination: <code>{repo.remote}</code>
            </p>
          )}
          <p>
            Ask {name} to make the change, run its tests and review the diff.
          </p>
          <details>
            <summary>Execution requirements</summary>
            <p>
              Coding tools support ChatGPT/Codex and direct API routes that
              bridge Mivlet tools. Other account routes are unavailable.
            </p>
            <p>
              Windows with WSL Ubuntu, Bubblewrap, Python 3 and your Linux build
              tools under /usr. Commands run inside the copied repository,
              without Windows files, home files or credentials. Network access
              requires an exact approval. No Windows shell fallback.
            </p>
            <p>
              Commit and GitHub publication use the existing approvals.
              Publication requires GitHub CLI login and a github.com origin. It
              targets the source branch ({repo.baseBranch}).
            </p>
          </details>
          {status.data?.busy && (
            <p role="status">
              Repository operation running. Output appears when it finishes.
            </p>
          )}
          {status.data?.recoveryRequired && (
            <p role="alert">
              {repo.operation}. Review files and any remote effects before
              continuing. Mivlet does not replay interrupted operations.
            </p>
          )}
          {repo.lastResult && (
            <details open>
              <summary>
                Last command:{" "}
                {repo.lastResult.interrupted
                  ? "interrupted"
                  : `exit ${repo.lastResult.exitCode ?? "unknown"}`}
              </summary>
              <pre>{repo.lastCommand}</pre>
              <pre>{repo.lastResult.output || "No output."}</pre>
              {repo.lastResult.truncated && <p>Output was truncated.</p>}
              {changes && repo.commandDiffId !== changes.diffId && (
                <p>Current changes have not been verified by this command.</p>
              )}
            </details>
          )}
          {changes && (
            <details>
              <summary>
                Changes{changes.files ? " in this branch" : ": none"}
              </summary>
              <pre>{changes.files}</pre>
              <pre aria-label="Repository diff">
                {changes.diff || "No changes from the starting commit."}
              </pre>
              {changes.truncated && (
                <p>
                  Diff is truncated. Ask the agent to inspect the affected files
                  before approving a commit.
                </p>
              )}
            </details>
          )}
          {repo.publication && (
            <p>
              Pull request:{" "}
              <a href={repo.publication} target="_blank" rel="noreferrer">
                {repo.publication}
              </a>
            </p>
          )}
        </>
      )}
    </div>
  );
}
