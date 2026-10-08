import { useEffect, useRef, useState } from "react";
import type { BackendProvider, ProviderContinuation, ProviderContinuationInput } from "@mivlet/protocol";
import type { ProviderModelOption } from "../../lib/provider-models";
import { providerContinuationAvailable } from "../../lib/provider-continuation";
import { previewProviderContinuation } from "../../runtime/domains/provider-continuation";
import "./provider-continuation.css";

export function ProviderContinuationControl({ workspaceId, ownerKey, conversationId, agentId, model,
  provider, prompt, disabled, attachmentCount, prepare, onContinue,
}: {
  workspaceId: string; ownerKey: string; conversationId: string; agentId: string;
  model?: ProviderModelOption; provider?: BackendProvider; prompt: string;
  disabled: boolean; attachmentCount: number; prepare: () => Promise<unknown>;
  onContinue: (input: ProviderContinuationInput, fingerprint: string) => Promise<void>;
}) {
  const [preview, setPreview] = useState<ProviderContinuation>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const generation = useRef(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const previewRegion = useRef<HTMLElement>(null);
  useEffect(() => {
    if (pending) return;
    if (preview) previewRegion.current?.focus();
    else if (error) trigger.current?.focus();
  }, [preview, error, pending]);
  const closePreview = () => {
    setPreview(undefined);
    requestAnimationFrame(() => trigger.current?.focus());
  };
  const key = JSON.stringify([workspaceId, ownerKey, conversationId, agentId, model?.id,
    model?.capabilities?.contextWindow, prompt, disabled, attachmentCount, provider?.authState]);
  const currentKey = useRef(key);
  currentKey.current = key;
  useEffect(() => {
    generation.current++;
    setPreview(undefined); setReviewed(false); setError(""); setPending(false);
    return () => { generation.current++; };
  }, [key]);
  const available = providerContinuationAvailable(provider) && model?.available;
  const blocked = disabled || !available || !prompt.trim() || attachmentCount > 0;
  const input = (): ProviderContinuationInput => ({
    conversationId, agentId, modelOptionId: model!.id, prompt,
    contextWindow: model?.capabilities?.contextWindow,
  });
  async function review() {
    const ticket = ++generation.current;
    const requestKey = key;
    setPending(true); setError(""); setPreview(undefined); setReviewed(false);
    try {
      await prepare();
      if (ticket !== generation.current || requestKey !== currentKey.current) return;
      const result = await previewProviderContinuation(workspaceId, input());
      if (ticket === generation.current && requestKey === currentKey.current) setPreview(result);
    } catch (e) {
      if (ticket === generation.current) setError(e instanceof Error ? e.message : "Could not prepare continuation.");
    } finally { if (ticket === generation.current) setPending(false); }
  }
  async function submit() {
    if (!preview || blocked || !reviewed || pending) return;
    const ticket = ++generation.current;
    setPending(true); setError("");
    try {
      await onContinue(input(), preview.fingerprint);
      if (ticket === generation.current) closePreview();
    } catch (e) {
      if (ticket === generation.current) {
        setPreview(undefined);
        setError(e instanceof Error ? e.message : "Could not continue.");
      }
    } finally { if (ticket === generation.current) setPending(false); }
  }
  return <div className="provider-continuation">
    <button ref={trigger} type="button" className="provider-continuation-trigger" disabled={blocked || pending}
      title={attachmentCount ? "Remove draft attachments before reviewing a text continuation." :
        disabled ? "Stop or finish active work first." :
        !available ? "Choose a connected supported provider and model." :
        !prompt.trim() ? "Write your next request, then review its context transfer." :
        "Uses the selected model in a fresh provider session."}
      onClick={() => void review()}>{pending ? "Preparing continuation…" : "Continue with selected model…"}</button>
    {error && <p role="alert">{error}</p>}
    {preview && <section ref={previewRegion} tabIndex={-1} aria-label="Provider continuation preview" className="provider-continuation-preview">
      <h3>Continue with {model?.label}</h3>
      <p>A fresh {model?.providerLabel} session receives {preview.messages.length} saved messages.
        {" "}{preview.omittedCount} remain in saved history. Your new request stays unchanged.</p>
      <p>{preview.historyBytes.toLocaleString()} bytes of selected history; {preview.capacitySource === "reported"
        ? "reported model capacity" : "conservative estimate: model capacity is unknown"}.
        {" "}Attachments, reasoning and previous approvals are not transferred.</p>
      {preview.attachmentCount > 0 && <p role="status">{preview.attachmentCount} earlier attachment references need reattachment if relevant.</p>}
      <details><summary>Review selected messages and source references</summary>
        <ol>{preview.messages.map(message => <li key={message.messageId}>
          <strong>{message.role} · {message.kind}{message.state !== "terminal" ? " · unfinished" : ""}</strong>
          <small>{message.messageId} · {message.revisionId}</small><pre>{message.text}</pre>
        </li>)}</ol><p>{preview.reference}</p>
      </details>
      <label><input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)} />
        I reviewed saved results and any uncertain external actions. Continue without replaying them.</label>
      <div className="provider-continuation-actions">
        <button type="button" disabled={!reviewed || blocked || pending} onClick={() => void submit()}>Continue</button>
        <button type="button" disabled={pending} onClick={closePreview}>Cancel</button>
      </div>
    </section>}
  </div>;
}
