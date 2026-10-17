import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { useModalFocusTrap } from "../../hooks/useModalFocusTrap";

export function HostedConsentFrame({ label, title, closeLabel, pending, onClose, children }: {
  label: string; title: string; closeLabel: string; pending: boolean;
  onClose: () => void; children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const heading = useId();
  useModalFocusTrap({ active: true, containerRef: panel, onClose: () => { if (!pending) onClose(); } });
  return <div className="cloud-panel-consent-backdrop"><div className="cloud-panel-consent" role="dialog" aria-modal="true" aria-labelledby={heading} ref={panel} tabIndex={-1}>
    <header><span>{label}</span><button type="button" aria-label={closeLabel} disabled={pending} onClick={onClose}><X size={18} aria-hidden="true" /></button></header>
    <h2 id={heading}>{title}</h2>{children}
  </div></div>;
}

export function ApprovalConfirmation({ phrase, value, onChange, pending }: {
  phrase: string | undefined; value: string; onChange: (value: string) => void; pending: boolean;
}) {
  return phrase && <label>Type <code>{phrase}</code><input value={value} onChange={event => onChange(event.target.value)} disabled={pending} autoComplete="off" /></label>;
}

export function useReviewExpiry(expiresAt: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  return now >= expiresAt;
}
