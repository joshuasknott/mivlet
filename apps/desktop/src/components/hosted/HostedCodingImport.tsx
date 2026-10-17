import { useEffect, useRef, useState } from "react";
import type { ApprovalResolutionRequest, ApprovalResolutionResponse, CollaborationWorkItem, HostedRepositoryImportReview, HostedRepositoryImportTarget, HostedTaskSnapshot } from "@mivlet/protocol";
import { canonicalHostedTaskJson } from "@mivlet/protocol";
import { HostedConsentFrame, ApprovalConfirmation, useReviewExpiry } from "./HostedConsent";
import { useHostedOperation } from "./useHostedOperation";
import { boundedHostedRead, matchesHostedApproval } from "./hosted-ui";
import type { HostedCodingApi } from "./hosted-coding-api";

export function HostedCodingImport({ item, snapshot, api, approve, onChanged, onStop, disabled }: {
  item: CollaborationWorkItem; snapshot: HostedTaskSnapshot; api: HostedCodingApi;
  approve: (request: ApprovalResolutionRequest) => Promise<ApprovalResolutionResponse | null>;
  onChanged: () => Promise<void>; onStop: () => void; disabled: boolean;
}) {
  const latest = useRef(item); latest.current = item;
  const blocked = useRef(disabled); blocked.current = disabled;
  const cancel = useRef(false);
  const { busy: lock, current, pending: pendingName, error, run } = useHostedOperation(item.workspaceId, "The returned files could not be checked.", undefined, disabled);
  const pending = Boolean(pendingName);
  // A parent Stop/permission change invalidates this attempt even if its
  // temporary disabled state clears before the approval reply arrives.
  if (disabled && lock.current) cancel.current = true;
  const [review, setReview] = useState<HostedRepositoryImportReview>();
  const [target, setTarget] = useState<HostedRepositoryImportTarget>();
  const [attempted, setAttempted] = useState(false);
  useEffect(() => () => { cancel.current = true; }, []);
  const binding = snapshot.binding;
  const progress = snapshot.coding;
  if (binding.version !== 3 || !progress) return null;
  const output = progress.output;
  return <section className="cloud-panel-coding-import" aria-label="Returned cloud files">
    <h3>Cloud files are ready to review</h3>
    <p>Changes stay separate until import. A checkpoint protects the current copy.</p>
    {progress.completedChecks.map(check => <p className="cloud-panel-muted" key={check.id}>{check.id} · exit {check.exitCode}{check.truncated ? " · output shortened" : ""}</p>)}
    {progress.proposal && <div role="status"><p>Paused: the agent requested more access. Importing existing changes grants no new access. Review a fresh task to continue.</p><details><summary>Requested change</summary><pre>{progress.proposal.tool}{"\n"}{progress.proposal.arguments}</pre></details></div>}
    <button type="button" className="button button-secondary" disabled={pending || disabled || !current()} onClick={() => void run("review", async () => {
      const requested = { workspaceId: item.workspaceId, agentId: item.agentId, workId: item.id, expectedGeneration: latest.current.generation, snapshotId: output.snapshotId, outputManifestSha256: output.outputManifestSha256 };
      const result = await boundedHostedRead(api.reviewImport(requested));
      if (!current()) return;
      if (latest.current.generation !== requested.expectedGeneration || canonicalHostedTaskJson(result.snapshot) !== canonicalHostedTaskJson(binding.repository.snapshot)
        || canonicalHostedTaskJson(result.output) !== canonicalHostedTaskJson(output)) throw new Error("The returned files or task changed. Refresh cloud status before reviewing again.");
      cancel.current = false; setTarget(requested); setReview(result); setAttempted(false);
    })}>Review returned changes</button>
    {error && !review && <p role="alert">{error}</p>}
    {pending && !review && <p role="status">Checking returned files against the current copy…</p>}
    {review && target && current() && <ImportConsent review={review} pending={pending} attempted={attempted} error={error}
      stale={latest.current.generation !== target.expectedGeneration || disabled}
      onClose={() => { if (!pending) setReview(undefined); }}
      onStop={() => { cancel.current = true; setReview(undefined); onStop(); }}
      onImport={confirmationText => void run("import", async () => {
        if (attempted || review.expiresAt <= Date.now() || latest.current.generation !== target.expectedGeneration) return;
        setAttempted(true);
        const resolution: ApprovalResolutionRequest = { request: review.approval, decision: "once", decidedAt: new Date().toISOString(), ...(confirmationText ? { confirmationText } : {}) };
        const recorded = await boundedHostedRead(approve(resolution));
        if (!current() || cancel.current) return;
        if (blocked.current) throw new Error("This task is unavailable or stopping. Refresh its status before importing.");
        if (latest.current.generation !== target.expectedGeneration || !matchesHostedApproval(review.approval, recorded))
          throw new Error("A matching one-time import approval was not recorded. Close this review and refresh the task.");
        const result = await boundedHostedRead(api.applyImport({ ...target, reviewId: review.reviewId, resolution }));
        if (!current()) return;
        if (result.snapshotId !== target.snapshotId || result.outputManifestSha256 !== target.outputManifestSha256
          || result.repositoryId !== review.snapshot.repositoryId || result.outputTreeId !== review.outputTreeId || !result.verificationInvalidated)
          throw new Error("The import outcome needs checking. Close this review and refresh cloud status; do not repeat the import.");
        setReview(undefined); await boundedHostedRead(onChanged());
      })} />}
  </section>;
}

function ImportConsent({ review, pending, attempted, stale, error, onClose, onStop, onImport }: {
  review: HostedRepositoryImportReview; pending: boolean; attempted: boolean; stale: boolean; error: string;
  onClose: () => void; onStop: () => void; onImport: (confirmation: string) => void;
}) {
  const [confirmation, setConfirmation] = useState("");
  const expired = useReviewExpiry(review.expiresAt);
  const unavailable = stale || expired || attempted;
  return <HostedConsentFrame label="Returned files" title="Review cloud changes" closeLabel="Close import review" pending={pending} onClose={onClose}><p>Review these changes before importing them into this task’s working copy.</p>
    <ul className="cloud-panel-coding-file-summary">{review.changes.map(change => <li key={change.path}><code>{change.path}</code><span>{change.status}</span></li>)}</ul>
    <pre className="cloud-panel-coding-diff" aria-label="Cloud changes diff" tabIndex={0}>{review.diff || "No text changes."}</pre>
    {review.truncated && <p role="alert">This diff is shortened. The complete file names and hashes are in Technical details.</p>}
    <p>A checkpoint is saved before importing. Run checks again on this computer after import.</p>
    <details><summary>Technical details</summary><pre>{JSON.stringify({ snapshot: review.snapshot, output: review.output, currentTreeId: review.currentTreeId, outputTreeId: review.outputTreeId, head: review.head }, null, 2)}</pre></details>
    <p>{review.approval.consequence}</p>
    <ApprovalConfirmation phrase={review.approval.confirmationPhrase} value={confirmation} onChange={setConfirmation} pending={pending} />
    {unavailable && <p role="alert">This review is unavailable. Close it and refresh cloud status for a new review.</p>}
    {error && <p role="alert">{error}</p>}
    {pending && <button type="button" className="button button-secondary" onClick={onStop}>Stop task</button>}
    <footer><button type="button" className="button button-secondary" disabled={pending} onClick={onClose}>Keep changes for later</button><button type="button" className="button button-primary" disabled={pending || unavailable || Boolean(review.approval.confirmationPhrase && confirmation !== review.approval.confirmationPhrase)} onClick={() => onImport(confirmation)}>Import changes once</button></footer>
  </HostedConsentFrame>;
}
