import { useEffect, useRef, useState } from "react";
import type { NativeCommandRepositoryReview, NativeCommandTarget } from "@mivlet/protocol";
import { inspectNativeCommandRepository } from "../../../runtime/domains/command-jobs";
import { getActiveRuntimeDataScope } from "../../../runtime-scope";
import "./coding-result.css";

interface Props {
  target: NativeCommandTarget;
  repositoryId: string;
  view: "files" | "changes";
  readRepository?: (target: NativeCommandTarget) => Promise<NativeCommandRepositoryReview | null>;
}

/** Read only: the retained job supplies native repository authority. */
export function CodingRepositoryReview(props: Props) {
  return <RepositoryReview key={JSON.stringify([props.target, props.repositoryId, props.view])} {...props} />;
}

function RepositoryReview({ target, repositoryId, view, readRepository = inspectNativeCommandRepository }: Props) {
  const read = useRef(readRepository);
  read.current = readRepository;
  const [review, setReview] = useState<NativeCommandRepositoryReview>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scope = getActiveRuntimeDataScope();
    setLoading(true); setError(""); setReview(undefined);
    const request = async () => {
      if (!scope || scope.workspaceId !== target.workspaceId)
        throw new Error("Open this result in its current account and workspace.");
      const result = await read.current(target);
      if (getActiveRuntimeDataScope() !== scope)
        throw new Error("The account or workspace changed. Open the current result again.");
      if (!result || result.jobId !== target.jobId || result.jobGeneration !== target.jobGeneration
        || result.repository.id !== repositoryId)
        throw new Error("This repository review no longer matches the command result. Reconnect the session.");
      return result;
    };
    void Promise.race([request(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Repository review did not respond. Refresh to inspect the existing private copy.")), 10_000);
    })]).then(result => { if (!disposed) setReview(result); })
      .catch(failure => { if (!disposed) setError(failure instanceof Error ? failure.message : "Repository review is unavailable."); })
      .finally(() => { clearTimeout(timer); if (!disposed) setLoading(false); });
    return () => { disposed = true; clearTimeout(timer); };
  }, [retry]);
  const changes = review?.changes;
  return <section className="coding-repository-review" aria-label={view === "files" ? "Task repository files" : "Task repository changes"}>
    <div className="coding-result__toolbar"><span>{review ? `${review.repository.name} · ${review.repository.branch}` : "Task’s private repository copy"}</span>
      <button type="button" disabled={loading} onClick={() => setRetry(value => value + 1)}>Refresh {view}</button>
    </div>
    {loading && <p className="coding-result__notice" role="status">Reading {view}…</p>}
    {error && <p role="alert">{error}</p>}
    {review && <>
      <p className="coding-result__notice">Current state of this task’s private copy. Changes still require the usual approvals.</p>
      {review.busy && <p className="coding-result__notice" role="status">This copy has an active operation. Stop the session before changing files.</p>}
      {review.recoveryRequired && <p role="alert">This copy needs recovery. Review its recorded outcome before making another change.</p>}
      {view === "files" ? review.files.length ? <ul className="coding-repository-review__files">{review.files.map(path => <li key={path}><code>{path}</code></li>)}</ul>
        : <p className="coding-result__notice">{review.busy || review.recoveryRequired ? "Files are unavailable while this copy is busy or needs recovery. Refresh after resolving its recorded operation." : "No files in this private copy."}</p>
        : changes ? changes.diff || changes.files ? <>
          {changes.files && <pre tabIndex={0} aria-label="Changed files">{changes.files}</pre>}
          <pre tabIndex={0} aria-label="Task repository diff">{changes.diff || "No text diff is available for these file changes."}</pre>
        </> : <p className="coding-result__notice">No changes from the starting commit.</p>
        : <p className="coding-result__notice">Changes are unavailable. Refresh after the current operation finishes.</p>}
      {(review.truncated || view === "changes" && changes?.truncated) && <p className="coding-result__notice" role="status">This review is truncated. Ask the agent to inspect the remaining files before approving changes.</p>}
    </>}
  </section>;
}
