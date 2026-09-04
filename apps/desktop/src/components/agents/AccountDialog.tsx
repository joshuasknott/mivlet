import { useRef, useState } from "react";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { useModalFocusTrap } from "../../hooks/useModalFocusTrap";

interface UsageRecord {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  costEstimated?: boolean;
  costUnknown?: boolean;
}

export function AccountDialog({ kind, name, records, onClose, onSignOut }: {
  kind: "usage" | "sign-out";
  name: string;
  records: UsageRecord[];
  onClose: () => void;
  onSignOut: () => Promise<unknown>;
}) {
  const ref = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useModalFocusTrap({ active: true, containerRef: ref, onClose: () => { if (!busy) onClose(); } });
  const input = records.reduce((sum, record) => sum + record.inputTokens, 0);
  const output = records.reduce((sum, record) => sum + record.outputTokens, 0);
  const knownCosts = records.filter((record) => !record.costUnknown);
  const cost = knownCosts.reduce((sum, record) => sum + record.costUsd, 0);
  return (
    <div className="settings-modal-backdrop">
      <section ref={ref} className="account-dialog" role="dialog" aria-modal="true" aria-labelledby="account-dialog-title" tabIndex={-1}>
        <button className="settings-modal__close" type="button" aria-label="Close account dialog" disabled={busy} onClick={onClose}><X size={18} /></button>
        <h2 id="account-dialog-title">{kind === "usage" ? "Usage" : "Sign out of Fable?"}</h2>
        {kind === "usage" ? <>
          <p>Activity recorded in this workspace.</p>
          {records.length ? <dl className="account-usage">
            <div><dt>Recorded runs</dt><dd>{records.length.toLocaleString()}</dd></div>
            <div><dt>Input tokens</dt><dd>{input.toLocaleString()}</dd></div>
            <div><dt>Output tokens</dt><dd>{output.toLocaleString()}</dd></div>
            <div><dt>Recorded cost{knownCosts.some((record) => record.costEstimated) ? " (estimated)" : ""}</dt><dd>{knownCosts.length ? new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(cost) : "Unavailable"}</dd></div>
          </dl> : <p className="account-dialog__empty">Your recorded usage will appear after a conversation.</p>}
          <small>Provider subscriptions and account limits are managed by your provider. Runs without reported costs are excluded from the cost total.</small>
        </> : <>
          <p>Sign out as {name}. Your saved workspace stays on this computer.</p>
          {error ? <p role="alert">{error}</p> : null}
          <footer><button type="button" onClick={onClose} disabled={busy}>Cancel</button><button type="button" className="account-dialog__primary" disabled={busy} onClick={async () => {
            setBusy(true); setError("");
            try { await onSignOut(); onClose(); }
            catch (cause) { setError(cause instanceof Error ? cause.message : "Sign out could not finish. Try again."); }
            finally { setBusy(false); }
          }}>{busy ? "Signing out…" : "Sign out"}</button></footer>
        </>}
      </section>
    </div>
  );
}
