import { useRef, useState } from "react";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { useModalFocusTrap } from "../../hooks/useModalFocusTrap";
import type { BackendProvider } from "@mivlet/protocol";
import { SubscriptionUsage } from "../usage/SubscriptionUsage";

export function AccountDialog({ kind, name, providers, connectedProviderIds, onOpenBreakdowns, onClose, onSignOut }: {
  kind: "usage" | "sign-out";
  name: string;
  providers?: BackendProvider[];
  connectedProviderIds?: string[];
  onOpenBreakdowns?: () => void;
  onClose: () => void;
  onSignOut: () => Promise<unknown>;
}) {
  const ref = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useModalFocusTrap({ active: true, containerRef: ref, onClose: () => { if (!busy) onClose(); } });
  return (
    <div className="settings-modal-backdrop">
      <section ref={ref} className={`account-dialog${kind === "usage" ? " account-dialog--usage" : ""}`} role="dialog" aria-modal="true" aria-labelledby="account-dialog-title" tabIndex={-1}>
        <button className="settings-modal__close" type="button" aria-label="Close account dialog" disabled={busy} onClick={onClose}><X size={18} /></button>
        <h2 id="account-dialog-title">{kind === "usage" ? "Usage" : "Sign out of Mivlet?"}</h2>
        {kind === "usage" ? <SubscriptionUsage providers={providers} connectedProviderIds={connectedProviderIds} onOpenBreakdowns={onOpenBreakdowns} /> : <>
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
