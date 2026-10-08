import { useEffect, useRef, useState } from "react";
import { ArrowRight } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { ArrowsClockwise } from "@phosphor-icons/react/dist/csr/ArrowsClockwise";
import { CaretDown } from "@phosphor-icons/react/dist/csr/CaretDown";
import { Paperclip } from "@phosphor-icons/react/dist/csr/Paperclip";
import { Robot } from "@phosphor-icons/react/dist/csr/Robot";
import { User } from "@phosphor-icons/react/dist/csr/User";
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
      onClick={() => void review()}><ArrowsClockwise size={16} aria-hidden="true" />
      {pending ? "Preparing continuation…" : "Continue with selected model…"}</button>
    {error && <p className="provider-continuation-error" role="alert">{error}</p>}
    {preview && <section ref={previewRegion} tabIndex={-1} aria-label="Provider continuation preview" className="provider-continuation-preview">
      <div className="provider-continuation-heading">
        <span className="provider-continuation-symbol"><ArrowsClockwise size={24} aria-hidden="true" /></span>
        <div><h3>Continue with {model?.label}</h3><p>Fresh {model?.providerLabel} session</p></div>
      </div>
      <dl className="provider-continuation-stats">
        <div><dt>messages selected</dt><dd>{preview.messages.length.toLocaleString()}</dd></div>
        <div><dt>in saved history</dt><dd>{preview.omittedCount.toLocaleString()}</dd></div>
        <div><dt>selected history</dt><dd>{preview.historyBytes.toLocaleString()} bytes</dd></div>
      </dl>
      <p>Your new request stays unchanged.</p>
      <p className="provider-continuation-note">{preview.capacitySource === "reported"
        ? "Uses the reported model capacity." : "Model capacity is unknown; a conservative estimate is used."}
        {" "}Attachments, reasoning and previous approvals are not transferred.</p>
      {preview.attachmentCount > 0 && <p className="provider-continuation-attachments" role="status">
        <Paperclip size={20} aria-hidden="true" /><span>{preview.attachmentCount} earlier attachment {preview.attachmentCount === 1
          ? "reference needs" : "references need"} reattachment if relevant.</span></p>}
      <details className="provider-continuation-sources"><summary><CaretDown size={16} aria-hidden="true" />
        Review selected messages and source references</summary>
        <ol>{preview.messages.map(message => <li key={message.messageId}>
          <span className="provider-continuation-role">{message.role === "user"
            ? <User size={20} aria-hidden="true" /> : <Robot size={20} aria-hidden="true" />}</span>
          <div><strong>{message.role} · {message.kind}{message.state !== "terminal" ? " · unfinished" : ""}</strong>
          <small>{message.messageId} · {message.revisionId}</small><pre>{message.text}</pre>
          </div>
        </li>)}</ol><p className="provider-continuation-note">{preview.reference}</p>
      </details>
      <label className="provider-continuation-review"><input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)} />
        <span>I reviewed saved results and any uncertain external actions. Continue without replaying them.</span></label>
      <div className="provider-continuation-actions">
        <button type="button" className="button button--secondary" disabled={pending} onClick={closePreview}>Cancel</button>
        <button type="button" className="button button--primary" disabled={!reviewed || blocked || pending} onClick={() => void submit()}>
          Continue <ArrowRight size={16} aria-hidden="true" /></button>
      </div>
    </section>}
  </div>;
}
