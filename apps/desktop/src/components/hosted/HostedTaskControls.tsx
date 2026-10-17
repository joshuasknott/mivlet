import { useEffect, useId, useRef, useState } from "react";
import type { ApprovalResolutionRequest, ApprovalResolutionResponse, CollaborationWorkItem, HostedProviderConnection, HostedRepositoryCandidates, HostedTaskCommit, HostedTaskControlResult, HostedTaskPrepare, HostedTaskResult, HostedTaskReview, HostedTaskReviewTarget, HostedTaskTarget } from "@mivlet/protocol";
import { canonicalHostedTaskJson, HOSTED_CODING_IMAGE } from "@mivlet/protocol";
import { Cloud } from "@phosphor-icons/react/dist/csr/Cloud";
import { Clock } from "@phosphor-icons/react/dist/csr/Clock";
import { FileText } from "@phosphor-icons/react/dist/csr/FileText";
import { ShieldCheck } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { ProviderIcon } from "../ProviderIcon";
import { useModalFocusTrap } from "../../hooks/useModalFocusTrap";
import { getActiveRuntimeDataScope } from "../../runtime-scope";
import { resolveRuntimeApprovalRequest } from "../../runtime/domains/approvals";
import { admitHostedTextTask, cancelHostedTextReview, listHostedProviders, prepareHostedCodingTask, prepareHostedPublicWebTask, prepareHostedTextTask, refreshHostedTextTask, stopHostedTextTask } from "../../runtime/domains/hosted-tasks";
import { applyHostedRepositoryImport, listHostedRepositoryCandidates, reviewHostedRepositoryImport } from "../../runtime/domains/hosted-repositories";
import { boundedHostedRead, hostedProviderLabels, hostedScopeKey } from "./hosted-ui";
import { researchScopeFromPages } from "./hosted-research";
import type { HostedCodingApi } from "./hosted-coding-api";
import { emptyCodingSelection, prepareCodingSelection } from "./hosted-coding-selection";
import { HostedCodingScope, HostedCodingSelection } from "./HostedCodingSelection";
import { HostedCodingImport } from "./HostedCodingImport";
import "./hosted-controls.css";

export interface HostedTaskApi {
  list: typeof listHostedProviders;
  prepare: (request: HostedTaskPrepare) => Promise<HostedTaskReview>;
  preparePublicWeb: typeof prepareHostedPublicWebTask;
  cancel: (request: HostedTaskReviewTarget) => Promise<HostedTaskControlResult>;
  admit: (request: HostedTaskCommit) => Promise<HostedTaskControlResult>;
  refresh: (request: HostedTaskTarget) => Promise<HostedTaskControlResult>;
  stop: (request: HostedTaskTarget) => Promise<HostedTaskControlResult>;
  approve: (request: ApprovalResolutionRequest) => Promise<ApprovalResolutionResponse | null>;
  coding?: HostedCodingApi;
}
const defaultApi: HostedTaskApi = { list: listHostedProviders, prepare: prepareHostedTextTask, preparePublicWeb: prepareHostedPublicWebTask, cancel: cancelHostedTextReview, admit: admitHostedTextTask, refresh: refreshHostedTextTask, stop: stopHostedTextTask, approve: resolveRuntimeApprovalRequest, coding: { prepare: prepareHostedCodingTask, candidates: listHostedRepositoryCandidates, reviewImport: reviewHostedRepositoryImport, applyImport: applyHostedRepositoryImport } };
export interface HostedTaskControlsProps {
  item: CollaborationWorkItem;
  onChanged: () => Promise<void>;
  disabled?: boolean;
  api?: HostedTaskApi;
}

export function HostedTaskControls(props: HostedTaskControlsProps) {
  return <TaskControls key={`${hostedScopeKey()}:${props.item.workspaceId}:${props.item.agentId}:${props.item.id}`} {...props} />;
}
function TaskControls({ item, onChanged, disabled = false, api = defaultApi }: HostedTaskControlsProps) {
  const scope = useRef(getActiveRuntimeDataScope()).current;
  const live = useRef(true);
  const busy = useRef(false);
  const latest = useRef(item); latest.current = item;
  const blocked = useRef(disabled); blocked.current = disabled;
  const [pending, setPending] = useState("");
  const [stopping, setStopping] = useState(false);
  const stopPending = useRef(false);
  const admissionCancelled = useRef(false);
  if (disabled && busy.current) admissionCancelled.current = true;
  const [error, setError] = useState("");
  const [connections, setConnections] = useState<HostedProviderConnection[]>();
  const [credential, setCredential] = useState("");
  const [mode, setMode] = useState<"text" | "research" | "coding">("text");
  const research = mode === "research";
  const coding = mode === "coding";
  const [candidates, setCandidates] = useState<HostedRepositoryCandidates>();
  const [selection, setSelection] = useState(emptyCodingSelection);
  const [startingPages, setStartingPages] = useState("");
  const modeName = useId();
  const pagesHint = useId();
  const [review, setReview] = useState<HostedTaskReview>();
  const [attempted, setAttempted] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [outcome, setOutcome] = useState<HostedTaskResult>();
  const current = () => live.current && scope !== null && getActiveRuntimeDataScope() === scope && scope.workspaceId === item.workspaceId;
  const target = (generation = latest.current.generation): HostedTaskTarget => ({ workspaceId: item.workspaceId, agentId: item.agentId, workId: item.id, expectedGeneration: generation });
  const retainResult = (result: HostedTaskControlResult) => {
    const binding = result.taskResult?.snapshot.binding;
    if (binding && (binding.workId !== item.id || binding.workspaceId !== item.workspaceId || binding.agentId !== item.agentId))
      throw new Error("The cloud result does not belong to this task.");
    if (current() && result.taskResult) setOutcome(result.taskResult);
  };
  const run = async (name: string, action: () => Promise<void>) => {
    if (busy.current || !current()) return;
    busy.current = true; setPending(name); setError("");
    try { await action(); }
    catch (reason) {
      if (current()) {
        setError(reason instanceof Error ? reason.message : "The cloud task could not be checked.");
        if (["prepare", "admit", "cancel"].includes(name)) {
          setUncertain(true);
          // A failed IPC may already have held/admitted the task. Reload only;
          // never infer that failure rolled back native state.
          try { await boundedHostedRead(onChanged()); } catch { /* Original outcome remains visible. */ }
        }
      }
    }
    finally { busy.current = false; if (current()) setPending(""); }
  };
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  // Prepare is allowed to advance exactly to its returned held generation.
  // Any different edit/restart makes this consent unusable.
  const reviewMatches = review && (item.generation === review.workGeneration || item.generation + 1 === review.workGeneration)
    && (!item.hostedTask || item.hostedTask.reviewId === review.reviewId && item.hostedTask.phase === "review");
  const hosted = item.hostedTask;
  const active = hosted && !["reconciled"].includes(hosted.phase);
  const canStart = item.status === "queued" && !item.parentId && item.rootId === item.id && item.runIds.length === 0 && !hosted;
  const loadConnections = () => run("connections", async () => {
    const result = await boundedHostedRead(api.list({ workspaceId: item.workspaceId, agentId: item.agentId }));
    if (current()) {
      const enabled = result.filter(connection => connection.enabled && connection.expiresAt > Date.now());
      setConnections(enabled);
      if (!enabled.some(connection => connection.credentialId === credential)) setCredential("");
    }
  });
  const reload = () => run("refresh", async () => {
    const result = await boundedHostedRead(api.refresh(target()));
    if (!current()) return;
    retainResult(result);
    await boundedHostedRead(onChanged());
    if (current()) { setUncertain(result.reconcileRequired); setReview(undefined); }
  });
  const cancel = () => run("cancel", async () => {
    const reviewId = review?.reviewId ?? hosted?.reviewId;
    if (!reviewId) throw new Error("Refresh this task to check its held review.");
    await boundedHostedRead(api.cancel({ ...target(review?.workGeneration), reviewId }));
    if (!current()) return;
    setReview(undefined); setAttempted(false); setUncertain(false); await boundedHostedRead(onChanged());
  });
  const stop = () => {
    if (stopPending.current || !current()) return;
    admissionCancelled.current = true;
    stopPending.current = true; setStopping(true);
    void boundedHostedRead(api.stop(target(Math.max(latest.current.generation, review?.workGeneration ?? 0)))).then(async result => {
      if (current()) { retainResult(result); setReview(undefined); await boundedHostedRead(onChanged()); }
    }).catch(reason => { if (current()) setError(reason instanceof Error ? reason.message : "Stop outcome is unknown. Refresh cloud status."); })
      .finally(() => { stopPending.current = false; if (current()) setStopping(false); });
  };
  if (!canStart && !hosted && !review && !uncertain && !outcome) return null;
  return <div className="hosted-task-controls">
    {canStart && <div className="hosted-task-controls__start">
      {connections ? <>
        <fieldset className="hosted-task-mode" disabled={Boolean(pending) || disabled || uncertain && attempted}>
          <legend>Cloud task</legend>
          <label><input type="radio" name={modeName} checked={mode === "text"} onChange={() => setMode("text")} />Text task</label>
          <label><input type="radio" name={modeName} checked={research} onChange={() => setMode("research")} />Research public pages</label>
          {api.coding && <label><input type="radio" name={modeName} checked={coding} onChange={() => setMode("coding")} />Work on files</label>}
        </fieldset>
        {research && <div className="hosted-research-pages"><label>Starting pages<textarea value={startingPages} maxLength={8192} rows={3} spellCheck={false} autoComplete="off" aria-describedby={pagesHint} disabled={Boolean(pending) || disabled || uncertain && attempted} onChange={event => setStartingPages(event.target.value)} placeholder="https://example.com/releases" /></label><p id={pagesHint} className="hosted-muted">Up to 4 public HTTPS pages, one per line. The agent may follow links within these exact websites. Pages requiring sign-in or browser interaction are unavailable.</p></div>}
        {coding && api.coding && <HostedCodingSelection candidates={candidates} value={selection} onChange={setSelection} disabled={Boolean(pending) || disabled || uncertain && attempted} onLoad={() => void run("files", async () => {
          const generation = latest.current.generation;
          const result = await boundedHostedRead(api.coding!.candidates(target(generation)));
          if (current() && generation === latest.current.generation) { setCandidates(result); setSelection(emptyCodingSelection()); }
        })} />}
        <label>Cloud API connection<select value={credential} disabled={Boolean(pending) || disabled || uncertain && attempted} onChange={event => setCredential(event.target.value)}>
          <option value="">Choose a connected provider</option>
          {connections.map(connection => <option key={connection.credentialId} value={connection.credentialId}>{hostedProviderLabels[connection.providerId]} · {connection.credentialId.slice(-6)}</option>)}
        </select></label>
        {!connections.length && <p className="hosted-muted">Connect a separate hosted API key in Settings first. Cloud tasks use this request’s saved API provider and model.</p>}
        <button type="button" className="button button--secondary" disabled={Boolean(pending) || !current()} onClick={() => void loadConnections()}>Refresh connections</button>
        <button type="button" className="button button--secondary" disabled={!credential || Boolean(pending) || disabled || uncertain && attempted} onClick={() => void run("prepare", async () => {
          const selected = connections.find(connection => connection.credentialId === credential);
          if (!selected) return;
          const request = { ...target(), credentialId: selected.credentialId, credentialRevision: selected.revision };
          const webScope = research ? researchScopeFromPages(startingPages) : undefined;
          const files = coding ? prepareCodingSelection(selection, candidates) : undefined;
          const result = await boundedHostedRead(files && api.coding ? api.coding.prepare({ ...request, mode: "offline-coding", ...files }) : webScope
            ? api.preparePublicWeb({ ...request, mode: "public-web-research", webScope })
            : api.prepare(request));
          if (!current()) return;
          const binding = result.admission.binding;
          if (result.workId !== item.id || result.admission.binding.workspaceId !== item.workspaceId || result.admission.binding.agentId !== item.agentId
            || result.admission.binding.workId !== item.id || result.admission.binding.workGeneration !== result.workGeneration
            || binding.credentialId !== selected.credentialId || binding.credentialRevision !== selected.revision
            || binding.version !== (coding ? 3 : research ? 2 : 1)
            || files && (binding.version !== 3 || binding.mode !== "offline-coding"
              || binding.repository.snapshot.repositoryId !== candidates?.repositoryId
              || JSON.stringify(binding.repository.snapshot.files.map(file => file.path).sort()) !== JSON.stringify([...files.selectedPaths].sort())
              || JSON.stringify([...binding.repository.snapshot.writablePaths].sort()) !== JSON.stringify([...files.writablePaths].sort())
              || JSON.stringify([...binding.repository.scope.writablePaths].sort()) !== JSON.stringify([...files.writablePaths].sort())
              || canonicalHostedTaskJson(binding.repository.scope.checks) !== canonicalHostedTaskJson(files.checks)
              || binding.repository.scope.network !== "disabled" || binding.repository.scope.image !== HOSTED_CODING_IMAGE)
            || webScope && (binding.version !== 2 || binding.mode !== "public-web-research"
              || JSON.stringify(binding.webScope.allowedDomains) !== JSON.stringify(webScope.allowedDomains)
              || JSON.stringify(binding.webScope.initialUrls) !== JSON.stringify(webScope.initialUrls)))
            throw new Error("The cloud review does not match this task. Refresh its recorded status.");
          admissionCancelled.current = false;
          setReview(result); setAttempted(false); setUncertain(false); await boundedHostedRead(onChanged());
        })}>Review cloud task</button>
      </> : <button type="button" className="button button--secondary" disabled={Boolean(pending) || disabled || !current()} onClick={() => void loadConnections()}><Cloud size={17} aria-hidden="true" /> Continue in cloud…</button>}
    </div>}
    {hosted && <p className="hosted-muted" role="status">{hosted.phase === "review" ? "Task held while you review cloud use." : hosted.phase === "awaiting-import" ? "Returned files are waiting for your review." : hosted.phase === "scope-change-required" ? "The cloud task needs a fresh review for more access." : hosted.phase === "reconcile-required" ? "Cloud outcome needs review before the conversation can advance." : hosted.phase === "stop-pending" ? "Cloud stop requested. Refresh to check the recorded outcome." : hosted.phase === "reconciled" ? "Cloud result reconciled with this task." : hosted.snapshot ? `Cloud task · ${hosted.snapshot.status}` : "Checking cloud admission outcome."}</p>}
    {(hosted || uncertain) && <div className="hosted-actions">
      <button type="button" className="button button--secondary" disabled={Boolean(pending) || !current()} onClick={() => void reload()}>Refresh cloud status</button>
      {hosted?.phase === "review" && !review && <button type="button" className="button button--secondary" disabled={Boolean(pending) || !current()} onClick={() => void cancel()}>Keep on this computer</button>}
      {active && hosted.phase !== "review" && <button type="button" className="button button--secondary" disabled={stopping || !current()} onClick={stop}>Stop cloud task</button>}
    </div>}
    {pending && <p role="status">{pending === "prepare" ? "Holding this task and preparing its exact text…" : pending === "stop" ? "Requesting cloud Stop…" : "Checking cloud task…"}</p>}
    {error && <p role="alert">{error}</p>}
    {outcome && current() && <details className="hosted-task-outcome"><summary>Cloud result · {outcome.snapshot.status}</summary><p className="hosted-muted">Retained text from the cloud provider. Refresh checks whether it can be reconciled with this conversation; it does not replay the task.</p><pre tabIndex={0}>{outcome.text || "No result text was returned."}</pre>{outcome.snapshot.research && <section className="hosted-research-scope" aria-label="Research sources"><h3>Pages read</h3><p className="hosted-muted">{outcome.snapshot.research.modelCalls} model calls · {outcome.snapshot.research.pageReads} page reads</p><ol>{outcome.snapshot.research.sources.map(source => <li key={source.citationId}><strong>{source.citationId} · {source.title}</strong><span>{source.finalUri}</span>{source.truncated && <small>Page text was shortened to fit this task’s limit.</small>}</li>)}</ol></section>}</details>}
    {stopping && <p role="status">Requesting cloud Stop…</p>}
    {api.coding && hosted?.snapshot?.coding && ["awaiting-import", "scope-change-required"].includes(hosted.phase) && <HostedCodingImport key={hosted.snapshot.coding.output.outputManifestSha256} item={item} snapshot={hosted.snapshot} api={api.coding} approve={api.approve} onChanged={reload} onStop={stop} disabled={disabled || Boolean(pending) || stopping} />}
    {review && current() && <HostedTaskConsent review={review} task={item.userRequest} agentName={item.agentName} pending={Boolean(pending)} attempted={attempted} stopping={stopping} onStop={stop} error={error} unavailable={disabled || !reviewMatches || attempted || uncertain} onRefresh={() => { setReview(undefined); void reload(); }} onCancel={() => { if (attempted) setReview(undefined); else void cancel(); }} onContinue={confirmationText => void run("admit", async () => {
      if (!reviewMatches || attempted || uncertain || review.expiresAt <= Date.now()) return;
      // Consume the visible attempt before approval or IPC. Failed/lost replies
      // preserve the evidence sheet but never offer the old admission again.
      setAttempted(true);
      const resolution: ApprovalResolutionRequest = { request: review.approval, decision: "once", decidedAt: new Date().toISOString(), ...(confirmationText ? { confirmationText } : {}) };
      const recorded = await boundedHostedRead(api.approve(resolution));
      if (!current() || admissionCancelled.current) return;
      if (blocked.current) throw new Error("This task is unavailable or stopping. Refresh its status before continuing.");
      if (!recorded?.persisted || recorded.auditEntry.requestId !== review.approval.id || recorded.auditEntry.decision !== "once"
        || !Object.entries(review.approval).every(([key, value]) => JSON.stringify(recorded.effectiveRequest[key as keyof typeof recorded.effectiveRequest]) === JSON.stringify(value))
        || recorded.grant && recorded.grant.requestId !== review.approval.id)
        throw new Error("A matching one-time native approval was not recorded. Refresh this task before continuing.");
      const latestWork = latest.current;
      if (latestWork.generation !== review.workGeneration && latestWork.generation + 1 !== review.workGeneration
        || latestWork.hostedTask && (latestWork.hostedTask.reviewId !== review.reviewId || latestWork.hostedTask.phase !== "review"))
        throw new Error("This task changed during approval. Refresh its recorded status.");
      const result = await boundedHostedRead(api.admit({ ...target(review.workGeneration), reviewId: review.reviewId, resolution }));
      if (!current()) return;
      retainResult(result); setReview(undefined); setUncertain(result.reconcileRequired); await boundedHostedRead(onChanged());
    })} />}
  </div>;
}

function HostedTaskConsent({ review, task, agentName, pending, attempted, stopping, error, unavailable, onCancel, onContinue, onRefresh, onStop }: {
  review: HostedTaskReview; task: string; agentName: string; pending: boolean; attempted: boolean; stopping: boolean; error: string; unavailable: boolean;
  onCancel: () => void; onContinue: (confirmation: string) => void; onRefresh: () => void; onStop: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const heading = useId();
  const [confirmation, setConfirmation] = useState("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useModalFocusTrap({ active: true, containerRef: panel, onClose: () => { if (!pending) onCancel(); } });
  const binding = review.admission.binding;
  const expired = review.expiresAt <= now;
  return <div className="hosted-consent-backdrop"><div className="hosted-consent" ref={panel} role="dialog" aria-modal="true" aria-labelledby={heading} tabIndex={-1}>
    <header><span>{agentName}</span><button type="button" aria-label={attempted ? "Close cloud review" : "Close cloud review and keep on this computer"} disabled={pending} onClick={onCancel}><X size={18} aria-hidden="true" /></button></header>
    <h2 id={heading}>{binding.version === 3 ? "Work on files in cloud" : binding.version === 2 ? "Research in cloud" : "Continue in cloud"}</h2>
    <p>Review exactly what leaves this computer. This queued task is held until you decide.</p>
    <div className="hosted-consent__task"><FileText size={21} aria-hidden="true" /><div><small>Task</small><strong>{task}</strong></div></div>
    {binding.version === 3 && <HostedCodingScope repository={binding.repository} />}
    {binding.version === 2 && <section className="hosted-research-scope" aria-label="Reviewed websites"><h3>Websites this task may read</h3><ul>{binding.webScope.allowedDomains.map(domain => <li key={domain}><strong>{domain}</strong></li>)}</ul><h3>Starting pages</h3><ul>{binding.webScope.initialUrls.map(url => <li key={url}>{url}</li>)}</ul><p className="hosted-muted">Only these exact websites may be read. Pages requiring sign-in or browser interaction are unavailable.</p></section>}
    <section aria-label="Full text to be sent" className="hosted-consent__text"><h3>Text to be sent · read only</h3>{review.admission.input.messages.map((message, index) => <div key={index}><strong>{message.role}</strong><pre tabIndex={0}>{message.content}</pre></div>)}</section>
    <ul className="hosted-consent__facts">
      <li><ProviderIcon provider={binding.providerId} /><span>{hostedProviderLabels[binding.providerId]} · {binding.model} · hosted connection</span></li>
      <li><ShieldCheck size={20} aria-hidden="true" /><span>{binding.version === 3 ? "Your request and selected files go to your cloud provider. Changes return here for a separate review before import." : binding.version === 2 ? "Your request and public page text go to your selected provider. Local files and app connections stay on this computer." : "This text leaves your computer. Local files and app connections stay on this device. No tools or computer access."}</span></li>
      <li><Clock size={20} aria-hidden="true" /><span>{binding.version === 3 ? `Up to ${binding.budget.maxModelCalls} model calls · ${binding.budget.maxToolCalls} tool calls` : binding.version === 2 ? `Up to ${binding.budget.maxModelCalls} model calls · ${binding.budget.maxPageReads} page reads` : "One model call"} · up to {binding.budget.maxElapsedMs / 1000} seconds</span></li>
      <li><FileText size={20} aria-hidden="true" /><span>Up to {binding.budget.maxOutputTokens.toLocaleString()} output tokens{binding.version !== 1 ? " across all calls" : ""} · {review.inputBytes.toLocaleString()} instruction bytes · {binding.version === 3 ? "32 MiB file limit · 256 KiB per file" : "64 KiB input/output limits"}{binding.version === 2 ? ` · ${binding.budget.maxSourceBytes / 1024} KiB total page text` : ""}</span></li>
    </ul>
    <p className="hosted-muted">{binding.version === 3 ? "Cloud task text, selected files and returned files are retained for up to 24 hours." : binding.version === 2 ? "Cloud copies of task text, page text and website receipts are retained for 24 hours." : "Cloud task text is retained for 24 hours; receipts for 7 days."} Your separate cloud key expires after 30 days. This uses Mivlet’s development service. Provider charges apply; no price cap is promised.</p>
    <details className="hosted-consent__destination"><summary>Cloud service</summary><code>{review.runnerUrl}</code></details>
    <p>{review.approval.consequence}</p>
    {review.approval.confirmationPhrase && <label>Type <code>{review.approval.confirmationPhrase}</code><input autoComplete="off" disabled={pending} value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>}
    {(expired || unavailable) && <p role="alert">{expired ? "This review expired. Keep the task on this computer, then prepare a fresh review." : "This review cannot be sent again. Check the task’s recorded cloud status before continuing."}</p>}
    {error && <p role="alert">{error}</p>}
    {attempted && <button type="button" className="button button--secondary" disabled={stopping} onClick={onStop}>{stopping ? "Stopping task…" : "Stop task"}</button>}
    <footer><button type="button" className="button button--secondary" disabled={pending} onClick={onCancel}>{attempted ? "Close review" : "Keep on this computer"}</button>{attempted || unavailable ? <button type="button" className="button button--secondary" disabled={pending} onClick={onRefresh}>Check cloud outcome</button> : <button type="button" className="button button--primary" disabled={pending || expired || Boolean(review.approval.confirmationPhrase && confirmation !== review.approval.confirmationPhrase)} onClick={() => onContinue(confirmation)}>Continue in cloud once</button>}</footer>
  </div></div>;
}
