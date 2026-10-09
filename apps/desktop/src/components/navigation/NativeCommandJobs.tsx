import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  MivletAgentProfile,
  NativeCommandFrame,
  NativeCommandJob,
} from "@mivlet/protocol";
import {
  listNativeCommandJobs,
  readNativeCommandOutput,
  stopNativeCommandJob,
} from "../../runtime/domains/command-jobs";
import { loadRuntimeLocalComputer } from "../../runtime/domains/local-computer";
import "./native-command-jobs.css";

const active = (job: NativeCommandJob) =>
  ["preparing", "running", "stopping"].includes(job.status);
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Commands are unavailable.";
const desktopRequired = () =>
  new Error("Open Mivlet desktop to view commands.");

export function retainCommandFrames(
  previous: NativeCommandFrame[],
  incoming: NativeCommandFrame[],
) {
  const frames = [
    ...previous,
    ...incoming.filter(
      (frame) => frame.sequence > (previous.at(-1)?.sequence ?? 0),
    ),
  ];
  let bytes = frames.reduce(
    (sum, frame) => sum + new TextEncoder().encode(frame.text).length,
    0,
  );
  while (frames.length > 512 || bytes > 64 * 1024)
    bytes -= new TextEncoder().encode(frames.shift()!.text).length;
  return frames;
}

export function NativeCommandJobs({
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
      className="native-command-jobs"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Commands</summary>
      <p>Live logs for your agent. Closing this panel keeps jobs running.</p>
      {agents.length > 1 && (
        <label>
          Agent{" "}
          <select
            aria-label="Command agent"
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
      {open && agent ? (
        <CommandList
          key={`${workspaceId}:${agent.id}`}
          workspaceId={workspaceId}
          agentId={agent.id}
        />
      ) : !agent ? (
        <p>Create an agent to run commands.</p>
      ) : null}
    </details>
  );
}
function CommandList({
  workspaceId,
  agentId,
}: {
  workspaceId: string;
  agentId: string;
}) {
  const [selected, setSelected] = useState("");
  const epoch = async () => {
    const computer = await loadRuntimeLocalComputer({ workspaceId, agentId });
    if (!computer) throw desktopRequired();
    return { workspaceId, agentId, expectedGeneration: computer.generation };
  };
  const query = useQuery({
    queryKey: ["native-command-jobs", workspaceId, agentId],
    retry: false,
    gcTime: 0,
    queryFn: async () => {
      const target = await epoch();
      const result = await listNativeCommandJobs(target);
      if (!result) throw desktopRequired();
      return { ...result, generation: target.expectedGeneration };
    },
    refetchInterval: 1000,
  });
  const jobs = query.data?.jobs ?? [];
  const job = jobs.find((item) => item.id === selected) ?? jobs[0];
  const stop = useMutation({
    mutationFn: async (target: NativeCommandJob) =>
      stopNativeCommandJob({
        ...(await epoch()),
        jobId: target.id,
        jobGeneration: target.generation,
      }),
    onSuccess: () => {
      void query.refetch();
    },
  });
  return (
    <div>
      {query.isPending && <p role="status">Loading commands…</p>}
      {(query.error || stop.error) && (
        <p role="alert">{errorText(query.error || stop.error)}</p>
      )}
      {!query.isPending && !query.error && jobs.length === 0 && (
        <p>No commands yet. Ask your agent to run one.</p>
      )}
      {jobs.length > 0 && (
        <label>
          Command{" "}
          <select
            aria-label="Command history"
            value={job?.id}
            onChange={(event) => setSelected(event.target.value)}
          >
            {jobs.map((item) => (
              <option key={item.id} value={item.id}>
                {item.persistent ? "Job" : "Command"} {item.id.slice(0, 8)} ·{" "}
                {item.status}
              </option>
            ))}
          </select>
        </label>
      )}
      {job && (
        <>
          <header>
            <p role="status">
              {job.status.replaceAll("-", " ")}
              {job.exitCode !== null ? ` · exit ${job.exitCode}` : ""}
            </p>
            <span>{job.persistent ? "Persistent job" : "Command"}</span>
            {active(job) && job.generation === query.data?.generation && (
              <button
                type="button"
                disabled={stop.isPending || job.status === "stopping"}
                onClick={() => stop.mutate(job)}
              >
                {job.status === "stopping" ? "Stopping…" : "Stop job"}
              </button>
            )}
          </header>
          <dl>
            <div>
              <dt>Started</dt>
              <dd>{new Date(job.createdAt).toLocaleString()}</dd>
            </div>
            <div>
              <dt>Time limit</dt>
              <dd>{job.timeoutSeconds}s</dd>
            </div>
            <div>
              <dt>Network</dt>
              <dd>{job.network ? "Approved" : "Off"}</dd>
            </div>
          </dl>
          {job.persistent && (
            <p>
              Snapshot writes are discarded; Stop ends the job.
              {job.repositoryId && " Stop before editing the repository."}
            </p>
          )}
          {job.message && <p>{job.message}</p>}
          <CommandOutput
            key={`${job.id}:${job.generation}`}
            workspaceId={workspaceId}
            agentId={agentId}
            job={job}
          />
        </>
      )}
    </div>
  );
}
function CommandOutput({
  workspaceId,
  agentId,
  job,
}: {
  workspaceId: string;
  agentId: string;
  job: NativeCommandJob;
}) {
  const [frames, setFrames] = useState<NativeCommandFrame[]>([]);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [redacted, setRedacted] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let disposed = false;
    let cursor = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const computer = await loadRuntimeLocalComputer({
          workspaceId,
          agentId,
        });
        if (disposed) return;
        if (!computer) throw desktopRequired();
        if (computer.generation !== job.generation) {
          setNotice("This generation has ended. Output is closed.");
          return;
        }
        const result = await readNativeCommandOutput(
          {
            workspaceId,
            agentId,
            expectedGeneration: computer.generation,
            jobId: job.id,
            jobGeneration: job.generation,
          },
          cursor,
        );
        if (disposed) return;
        if (!result) throw desktopRequired();
        if (result.outputUnavailable || !result.output) {
          setNotice("Output expired; the job was not replayed.");
          return;
        }
        if (result.output.dropped)
          setNotice("Older output exceeded the history limit.");
        setRedacted(result.output.redacted);
        setFrames((current) =>
          retainCommandFrames(current, result.output!.frames),
        );
        cursor = result.output.nextCursor;
        if (!result.output.closed) timer = setTimeout(() => void poll(), 500);
      } catch (failure) {
        if (!disposed) setError(errorText(failure));
      }
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [workspaceId, agentId, job.id, job.generation, retry]);
  return (
    <div>
      <h3>Output</h3>
      {error && (
        <>
          <p role="alert">{error}</p>
          <button
            type="button"
            onClick={() => {
              setError("");
              setRetry((value) => value + 1);
            }}
          >
            Retry output
          </button>
        </>
      )}
      <pre tabIndex={0} aria-label="Command output">
        {frames.length
          ? frames.map((frame) => frame.text).join("")
          : notice || error
            ? "Output unavailable."
            : "No output yet."}
      </pre>
      {notice && <p>{notice}</p>}
      {redacted && <p>Some output was redacted or omitted.</p>}
    </div>
  );
}
