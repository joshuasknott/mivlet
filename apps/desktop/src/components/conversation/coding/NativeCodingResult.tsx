import { lazy, Suspense, useEffect, useState } from "react";
import type { NativeCommandJob, NativeCommandTarget } from "@mivlet/protocol";
import { listNativeCommandJobs, stopNativeCommandJob } from "../../../runtime/domains/command-jobs";
import { loadRuntimeLocalComputer } from "../../../runtime/domains/local-computer";
import { readNativeAppPreview, closeNativeAppPreview, validateNativePreviewPick } from "../../../runtime/domains/live-preview";

const CodingTerminal = lazy(() => import("./CodingTerminal").then(module => ({ default: module.CodingTerminal })));
const CodingPreview = lazy(() => import("./CodingPreview").then(module => ({ default: module.CodingPreview })));
const CodingResultTabs = lazy(() => import("./CodingResultTabs").then(module => ({ default: module.CodingResultTabs })));
export function NativeCodingResult({ workspaceId, agentId, jobId, jobGeneration, onDraft }: {
  workspaceId: string; agentId: string; jobId: string; jobGeneration: number; onDraft?: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<{ job: NativeCommandJob; target: NativeCommandTarget }>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    let current = true;
    setState(undefined); setError("");
    void (async () => {
      const computer = await loadRuntimeLocalComputer({ workspaceId, agentId });
      if (!computer || computer.workspaceId !== workspaceId || computer.agentId !== agentId)
        throw new Error("Open this agent's native desktop computer to reconnect its command session.");
      const target = { workspaceId, agentId, expectedGeneration: computer.generation, jobId, jobGeneration };
      const result = await listNativeCommandJobs({ workspaceId, agentId, expectedGeneration: computer.generation });
      const job = result?.jobs.find(job => job.id === jobId && job.generation === jobGeneration);
      if (!job) throw new Error("This native command session is unavailable in this agent's scope. It was not restarted.");
      if (current) setState({ target, job });
    })().catch(error => { if (current) setError(error instanceof Error ? error.message : "Native command session unavailable."); });
    return () => { current = false; };
  }, [open, workspaceId, agentId, jobId, jobGeneration]);
  return <section aria-label="Native command result">
    <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? "Hide native session" : "Open native session"}</button>
    {open && error ? <p role="status">{error}</p> : null}
    {open && !state && !error ? <p role="status">Reconnecting to the native owner…</p> : null}
    {open && state ? <Suspense fallback={<p role="status">Opening session controls…</p>}>
      <CodingResultTabs terminal={<CodingTerminal key={`${workspaceId}:${agentId}:${jobId}:${jobGeneration}`} target={state.target} job={state.job}
        onJobChange={job => setState(previous => previous && { ...previous, job })} />}
        preview={state.job.previewPort && state.job.repositoryId && state.job.status === "running" && onDraft ? <CodingPreview target={state.target}
          readPreview={async target => { const result = await readNativeAppPreview(target); if (!result) throw new Error("Native app preview requires Mivlet desktop."); return result; }}
          closePreview={async target => { const result = await closeNativeAppPreview(target); if (!result) throw new Error("Native preview owner is unavailable."); return result; }}
          validatePreviewPick={async (target, pick) => { const result = await validateNativePreviewPick(target, pick); if (!result) throw new Error("Native preview evidence validation is unavailable."); return result; }}
          onStop={async () => { const result = await stopNativeCommandJob(state.target); if (result) setState(previous => previous && { ...previous, job: result.job }); }} onDraft={onDraft} /> : undefined} />
    </Suspense> : null}
  </section>;
}
