import { useEffect, useRef, useState } from "react";
import type { ConversationRestoreIntent, ConversationRestoreListing, ConversationRestoreOwner, ConversationRestoreReview } from "@mivlet/protocol";
import { conversationRestore, executeConversationRestore, listConversationRestorePoints, prepareConversationRestore } from "../../runtime/domains/conversation-restore";
import type { CheckpointAction } from "../../runtime/domains/repository-checkpoints";
import "./conversation-restore.css";

type Props = ConversationRestoreOwner & {
  blockedReason?: string;
  onReloadHistory: () => Promise<void>;
};
export function ConversationRestore(props: Props) {
  return <RestoreContent key={JSON.stringify([props.workspaceId, props.conversationId, props.agentId])} {...props} />;
}
function RestoreContent({ workspaceId, conversationId, agentId, blockedReason, onReloadHistory }: Props) {
  const owner = { workspaceId, conversationId, agentId };
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<ConversationRestoreListing>();
  const [review, setReview] = useState<ConversationRestoreReview>();
  const [action, setAction] = useState<CheckpointAction>();
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const live = useRef(true);
  const busy = useRef(false);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const load = async () => {
    const result = await listConversationRestorePoints(owner);
    if (live.current) setListing(result);
  };
  const perform = async (task: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true; setPending(true); setError(""); setStatus("");
    try { await task(); }
    catch (reason) { if (live.current) setError(reason instanceof Error ? reason.message : "Recovery stopped. Check the recorded outcome before continuing."); }
    finally { busy.current = false; if (live.current) setPending(false); }
  };
  useEffect(() => { if (open) void perform(load); }, [open]);
  const preview = (command: { pointId: string } | { intentId: string }) => perform(async () => {
    const next = await conversationRestore<ConversationRestoreReview>(owner, { action: "pointId" in command ? "preview" : "preview-revert", ...command });
    if (!live.current) return;
    setReview(next); setAction(undefined); setConfirmation("");
  });
  const incomplete = listing?.intents.filter((intent) => !["complete", "reverted", "cancelled"].includes(intent.state)) ?? [];
  const reconcile = (intent: ConversationRestoreIntent) => perform(async () => {
    const result = await conversationRestore<ConversationRestoreListing>(owner, { action: "reconcile", intentId: intent.id });
    if (live.current) setListing(result);
  });
  return <details className="conversation-restore" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Restore conversation and files</summary>
    {open && <div className="conversation-restore__body">
      <p>Return this conversation and the agent’s private code copy to before a task. Earlier messages stay in history. Published changes, sent messages and other external actions cannot be undone here.</p>
      <div className="conversation-restore__actions"><button type="button" disabled={pending} onClick={() => void perform(load)}>Reload recovery history</button></div>
      {blockedReason && <p role="status">{blockedReason}</p>}
      {!listing && !pending && error && <button type="button" onClick={() => void perform(load)}>Retry recovery history</button>}
      {listing?.points.length === 0 && <p>No linked recovery points yet. New coding tasks save one before their first file change. Older tasks and tasks without a private repository copy have no linked file restore.</p>}
      {incomplete.map((intent) => <section key={intent.id} aria-label="Incomplete restore">
        <strong>{intent.review.point.label}</strong>
        <p>{intent.state === "files-restored" ? "Files restored. The conversation step still needs your attention." : "A restore was prepared. Check the native outcome before continuing."}</p>
        <div className="conversation-restore__actions">
          <button type="button" disabled={pending} onClick={() => void reconcile(intent)}>Check restore outcome</button>
          {(intent.state === "files-restored" || listing?.observed?.intentId === intent.id && listing?.observed.kind === "files-restored") && <>
            <button type="button" disabled={pending || !!blockedReason} onClick={() => void perform(async () => {
              const observed = listing?.observed?.intentId === intent.id ? listing.observed : undefined;
              await conversationRestore(owner, { action: "finish", intentId: intent.id, ...(observed ? { expectedHeadId: observed.currentHeadId, expectedLastSequence: observed.currentLastSequence } : {}) });
              if (!live.current) return;
              await onReloadHistory(); await load();
              if (live.current) setStatus("Conversation and files restored. Run code checks again.");
            })}>Finish conversation restore</button>
            <button type="button" disabled={pending || !!blockedReason} onClick={() => void preview({ intentId: intent.id })}>Review reverting files</button>
          </>}
          {listing?.observed?.intentId === intent.id && listing?.observed.kind === "unchanged" && <button type="button" disabled={pending} onClick={() => void perform(async () => {
            await conversationRestore(owner, { action: "cancel", intentId: intent.id }); await load();
          })}>Cancel pending restore</button>}
        </div>
        {listing?.observed?.intentId === intent.id && <p role="status">{listing?.observed.kind === "unchanged" ? "The original files are unchanged. This pending restore can be cancelled." : listing?.observed.kind === "files-restored" ? "The native file tree and backup match the approved restore." : "Files changed or the outcome needs repository recovery. Inspect the private copy before continuing."}</p>}
        {listing?.observed?.intentId === intent.id && listing.observed.conversationChanged && <p>The conversation changed after the original preview. Finishing switches the current conversation to before this request; newer messages stay in its saved history.</p>}
      </section>)}
      {!incomplete.length && !review && listing && <ul>{listing.points.slice().reverse().map((point) => <li key={point.id}>
        <div><strong>{point.label}</strong><small>{new Date(point.createdAt).toLocaleString()} · {point.checkpoint.fileCount} saved files</small></div>
        <button type="button" disabled={pending || !!blockedReason} onClick={() => void preview({ pointId: point.id })}>Preview restore</button>
        <button type="button" disabled={pending} title="Remove this conversation link; the saved file checkpoint stays in Files" onClick={() => void perform(async () => { await conversationRestore(owner, { action: "forget-point", pointId: point.id }); await load(); })}>Remove linked point</button>
      </li>)}</ul>}
      {listing && listing.intents.some((intent) => ["complete", "reverted", "cancelled"].includes(intent.state)) && <button type="button" disabled={pending} title="File checkpoints and conversation messages stay saved" onClick={() => void perform(async () => { await conversationRestore(owner, { action: "clear-completed" }); await load(); })}>Clear completed restore records</button>}
      {!!listing?.points.length && <small>Up to 24 points and 24 restore records are retained. Remove old file checkpoints in Files when storage is full. Removing a linked point keeps its file checkpoint.</small>}
      {review && <section aria-label="Conversation and file restore preview">
        <h4>{review.direction === "revert-files" ? "Revert the file restore" : `Before “${review.point.label}”`}</h4>
        <p>{review.checkpoint.files.length} file changes in this agent’s private copy. {review.direction === "restore" ? review.point.targetHeadId ? "Conversation returns to the message before this request." : "Conversation returns to an empty starting point." : "The conversation stays at its current point."} Current code is saved before restoring. Git HEAD and external actions stay in place; run checks again afterward.</p>
        <ul>{review.checkpoint.files.map((file) => <li key={file.path}><code>{file.path}</code><span>{file.status}</span></li>)}</ul>
        <pre tabIndex={0} aria-label="Recovery file diff">{review.checkpoint.diff || "No code changes."}</pre>
        {review.checkpoint.truncated && <p role="status">Diff truncated. Review the full files before approving.</p>}
        {!action && <div className="conversation-restore__actions">
          <button type="button" disabled={pending || !!blockedReason} onClick={() => { setAction(prepareConversationRestore(review)); setConfirmation(""); }}>Review restore approval</button>
          <button type="button" disabled={pending} onClick={() => setReview(undefined)}>Cancel preview</button>
        </div>}
        {action && <form aria-label="Approve connected restore" onSubmit={(event) => {
          event.preventDefault();
          if (confirmation !== action.approval.confirmationPhrase) return;
          void perform(async () => {
            // Clear approval locally even on uncertain outcomes; never replay it.
            setAction(undefined); setReview(undefined); setConfirmation("");
            try {
              await executeConversationRestore(owner, review, action, confirmation);
              if (!live.current) return;
              await onReloadHistory();
              if (live.current) setStatus(review.direction === "restore" ? "Conversation and files restored. Run code checks again." : "File restore reverted. The conversation stays in place.");
            } finally { if (live.current) await load(); }
          });
        }}>
          <p>{action.approval.consequence}</p>
          <label>Type <code>{action.approval.confirmationPhrase}</code><input autoComplete="off" value={confirmation} disabled={pending} onChange={(event) => setConfirmation(event.target.value)} /></label>
          <div className="conversation-restore__actions">
            <button type="submit" disabled={pending || !!blockedReason || confirmation !== action.approval.confirmationPhrase}>{review.direction === "restore" ? "Restore files and conversation once" : "Revert files once"}</button>
            <button type="button" disabled={pending} onClick={() => { setAction(undefined); setConfirmation(""); }}>Cancel approval</button>
          </div>
        </form>}
      </section>}
      {pending && <p role="status">Checking native recovery…</p>}
      {status && <p role="status">{status}</p>}
      {error && <p role="alert">{error}</p>}
    </div>}
  </details>;
}
