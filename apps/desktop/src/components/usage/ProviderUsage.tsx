import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { ProviderAllowance } from "@mivlet/protocol";
import {
  allowanceLabel,
  currentAllowance,
  readProviderAllowance,
} from "../../runtime/domains/provider-usage";
import { useModalFocusTrap } from "../../hooks/useModalFocusTrap";
import "./provider-usage.css";

const Details = lazy(() =>
  import("./ProviderUsageDetails").then((module) => ({
    default: module.ProviderUsageDetails,
  })),
);

function ProviderUsageDialog({
  providerId,
  onClose,
}: {
  providerId?: string;
  onClose: () => void;
}) {
  const root = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useModalFocusTrap({
    active: true,
    containerRef: root,
    initialFocusRef: close,
    onClose,
  });
  return (
    <div
      className="provider-usage-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={root}
        className="provider-usage-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="provider-usage-title"
        tabIndex={-1}
      >
        <header>
          <h2 id="provider-usage-title">Usage and allowance</h2>
          <button
            ref={close}
            type="button"
            onClick={onClose}
            aria-label="Close usage"
          >
            Close
          </button>
        </header>
        <Suspense fallback={<p role="status">Loading usage…</p>}>
          <Details initialProviderId={providerId} />
        </Suspense>
      </section>
    </div>
  );
}

/** Compact additive entry next to the existing model control. */
export function ProviderAllowanceIndicator({
  providerId,
}: {
  providerId?: string;
}) {
  const [report, setReport] = useState<ProviderAllowance | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let current = true;
    setReport(null);
    if (!providerId) return;
    const read = () => {
      void readProviderAllowance(providerId)
        .then((value) => {
          if (current) setReport(value);
        })
        .catch(() => {
          if (current) setReport(null);
        });
    };
    read();
    const timer = window.setInterval(read, 60_000);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [providerId, open]);
  if (!providerId) return null;
  const measured = currentAllowance(report);
  return (
    <>
      <button
        type="button"
        className="provider-allowance-indicator"
        onClick={() => setOpen(true)}
        aria-label={`Provider usage: ${allowanceLabel(measured)}`}
        title="Usage and allowance"
      >
        {measured?.status === "available"
          ? allowanceLabel(measured)
          : measured?.status === "stale"
            ? "Usage stale"
            : "Usage"}
      </button>
      {open ? (
        <ProviderUsageDialog
          providerId={providerId}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
