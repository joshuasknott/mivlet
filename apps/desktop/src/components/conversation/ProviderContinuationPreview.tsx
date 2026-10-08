import { ArrowRight } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { ArrowsClockwise } from "@phosphor-icons/react/dist/csr/ArrowsClockwise";
import { CaretDown } from "@phosphor-icons/react/dist/csr/CaretDown";
import { Paperclip } from "@phosphor-icons/react/dist/csr/Paperclip";
import { Robot } from "@phosphor-icons/react/dist/csr/Robot";
import { User } from "@phosphor-icons/react/dist/csr/User";
import type { ProviderContinuation } from "@mivlet/protocol";
import type { ProviderModelOption } from "../../lib/provider-models";

export function ProviderContinuationPreview({ preview, model, reviewed, pending, blocked, onReviewed, onCancel, onContinue }: {
  preview: ProviderContinuation; model?: ProviderModelOption;
  reviewed: boolean; pending: boolean; blocked: boolean;
  onReviewed: (value: boolean) => void; onCancel: () => void; onContinue: () => void;
}) {
  return <>
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
      <label className="provider-continuation-review"><input type="checkbox" checked={reviewed} onChange={e => onReviewed(e.target.checked)} />
        <span>I reviewed saved results and any uncertain external actions. Continue without replaying them.</span></label>
      <div className="provider-continuation-actions">
        <button type="button" className="button button--secondary" disabled={pending} onClick={onCancel}>Cancel</button>
        <button type="button" className="button button--primary" disabled={!reviewed || blocked || pending} onClick={onContinue}>
          Continue <ArrowRight size={16} aria-hidden="true" /></button>
      </div>
  </>;
}
