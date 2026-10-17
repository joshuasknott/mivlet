import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { NativeCommandJob, NativeCommandTarget } from "@mivlet/protocol";
import { listNativeCommandJobs, stopNativeCommandJob } from "../../../runtime/domains/command-jobs";
import { loadRuntimeLocalComputer } from "../../../runtime/domains/local-computer";
import { readNativeAppPreview, closeNativeAppPreview, validateNativePreviewPick } from "../../../runtime/domains/live-preview";

const CodingTerminal = lazy(() => import("./CodingTerminal").then(module => ({ default: module.CodingTerminal })));
const CodingPreview = lazy(() => import("./CodingPreview").then(module => ({ default: module.CodingPreview })));
const CodingResultTabs = lazy(() => import("./CodingResultTabs").then(module => ({ default: module.CodingResultTabs })));
const CodingRepositoryReview = lazy(() => import("./CodingRepositoryReview").then(module => ({ default: module.CodingRepositoryReview })));
interface Props {
  workspaceId: string; agentId: string; jobId: string; jobGeneration: number; onDraft?: (text: string) => void;
}
export function NativeCodingResult(props: Props) {
  return <CodingSession key={JSON.stringify([props.workspaceId, props.agentId, props.jobId, props.jobGeneration])} {...props} />;
}
function CodingSession({ workspaceId, agentId, jobId, jobGeneration, onDraft }: Props) {
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<{ job: NativeCommandJob; target: NativeCommandTarget }>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!open) return;
    let current = true;
    setState(undefined); setError("");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reconnect = (async () => {
      const computer = await loadRuntimeLocalComputer({ workspaceId, agentId });
      if (!computer || computer.workspaceId !== workspaceId || computer.agentId !== agentId)
        throw new Error("Open this agent's native desktop computer to reconnect its command session.");
      const target = { workspaceId, agentId, expectedGeneration: computer.generation, jobId, jobGeneration };
      const result = await listNativeCommandJobs({ workspaceId, agentId, expectedGeneration: computer.generation });
      const job = result?.jobs.find(job => job.id === jobId && job.generation === jobGeneration);
      if (!job) throw new Error("This native command session is unavailable in this agent's scope. It was not restarted.");
      return { target, job };
    })();
    void Promise.race([reconnect, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Reconnecting timed out. Retry to inspect the existing session; it will not be restarted.")), 20_000);
    })]).then(result => { if (current) setState(result); })
      .catch(error => { if (current) setError(error instanceof Error ? error.message : "Command session unavailable."); })
      .finally(() => clearTimeout(timer));
    return () => { current = false; clearTimeout(timer); };
  }, [open, workspaceId, agentId, jobId, jobGeneration, retry]);
  return <section aria-label="Command result">
    <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? "Hide session" : "Open session"}</button>
    {open && error ? <><p role="status">{error}</p><button type="button" onClick={() => setRetry(value => value + 1)}>Retry connection</button></> : null}
    {open && !state && !error ? <p role="status">Reconnecting…</p> : null}
    {open && state ? <Suspense fallback={<p role="status">Opening session controls…</p>}>
      <CodingResultTabs terminal={<CodingTerminal key={`${workspaceId}:${agentId}:${jobId}:${jobGeneration}`} target={state.target} job={state.job}
        onJobChange={job => setState(previous => previous && { ...previous, job })} />}
        files={state.job.repositoryId ? <CodingRepositoryReview target={state.target} repositoryId={state.job.repositoryId} view="files" /> : undefined}
        changes={state.job.repositoryId ? <CodingRepositoryReview target={state.target} repositoryId={state.job.repositoryId} view="changes" /> : undefined}
        preview={state.job.previewPort && state.job.repositoryId && state.job.status === "running" && onDraft ? <CodingPreview target={state.target}
          readPreview={async target => { const result = await readNativeAppPreview(target); if (!result) throw new Error("Native app preview requires Mivlet desktop."); return result; }}
          closePreview={async target => { const result = await closeNativeAppPreview(target); if (!result) throw new Error("Native preview owner is unavailable."); return result; }}
          validatePreviewPick={async (target, pick) => { const result = await validateNativePreviewPick(target, pick); if (!result) throw new Error("Native preview evidence validation is unavailable."); return result; }}
          onStop={async () => {
            const result = await stopNativeCommandJob(state.target);
            if (!result || result.job.id !== state.target.jobId || result.job.generation !== state.target.jobGeneration)
              throw new Error("The Stop receipt did not match this session. Reconnect to inspect its outcome.");
            if (mounted.current) setState(previous => previous && { ...previous, job: result.job });
          }} onDraft={onDraft} /> : undefined} />
    </Suspense> : null}
  </section>;
}
