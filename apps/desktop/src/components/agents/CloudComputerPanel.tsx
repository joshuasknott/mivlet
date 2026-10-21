import { useCallback, useEffect, useRef } from "react";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { useCloudComputer } from "../../hooks/useCloudComputer";
import { useCloudViewer } from "../../hooks/useCloudViewer";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useModalFocusTrap } from "../../hooks/useModalFocusTrap";
import "../settings/computers-settings.css";

export function CloudComputerPanel({
  workspaceId,
  machineId,
  invalid = false,
  onClose,
}: {
  workspaceId: string;
  machineId?: string;
  invalid?: boolean;
  onClose: () => void;
}) {
  const { status, pending, error, refresh, act } =
    useCloudComputer(workspaceId);
  const ref = useRef<HTMLElement>(null);
  const slot = useRef<HTMLDivElement>(null);
  const compact = useMediaQuery("(max-width: 850px)");
  const machine = status?.connected ? status.machine : null;
  const changed = invalid || Boolean(machineId && machine?.id !== machineId);
  const target = changed ? undefined : machine?.id;
  const desktop = useCloudViewer(
    workspaceId,
    target,
    status?.connectionRevision ?? 0,
  );
  const closePanel = useCallback(() => {
    void desktop.close().then((closed) => {
      if (closed) onClose();
    });
  }, [desktop.close, onClose]);
  useModalFocusTrap({
    active: compact,
    containerRef: ref,
    onClose: closePanel,
  });
  const bounds = useCallback(() => {
    const box = slot.current?.getBoundingClientRect();
    if (!box || box.width < 240 || box.height < 240 || box.x < 0 || box.y < 0)
      return null;
    return {
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.floor(box.width),
      height: Math.floor(box.height),
    };
  }, []);
  useEffect(() => {
    if (!desktop.viewer?.open || !slot.current) return;
    let frame = 0;
    const resize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = bounds();
        if (next) void desktop.resize(next);
        else void desktop.close();
      });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(slot.current);
    window.addEventListener("resize", resize);
    window.addEventListener("scroll", resize, true);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
      window.removeEventListener("scroll", resize, true);
    };
  }, [desktop.viewer?.open, desktop.resize, desktop.close, bounds]);
  useEffect(() => {
    if (!desktop.viewer?.open) return;
    // Native child views draw above DOM overlays. Close before another modal
    // can cover this panel, retaining native revocation recovery if needed.
    let closing = false;
    const checkModal = () => {
      if (closing) return;
      const panel = ref.current;
      if (
        panel &&
        Array.from(document.querySelectorAll('[aria-modal="true"]')).some(
          (modal) =>
            !modal.contains(panel) &&
            !panel.contains(modal) &&
            modal.getClientRects().length > 0,
        )
      ) {
        closing = true;
        void desktop.close();
      }
    };
    const observer = new MutationObserver(checkModal);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-modal", "hidden"],
    });
    checkModal();
    return () => observer.disconnect();
  }, [desktop.viewer?.open, desktop.close]);
  const uncertain =
    desktop.viewer?.revoke === "unconfirmed" ||
    desktop.viewer?.revoke === "pending";
  const busy = pending || desktop.pending;
  return (
    <aside
      ref={ref}
      className="cloud-computer-panel"
      role={compact ? "dialog" : undefined}
      aria-modal={compact || undefined}
      aria-label="Cloud computer"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !compact) {
          event.stopPropagation();
          closePanel();
        }
      }}
    >
      <header>
        <h2>Cloud · Instabox</h2>
        <button type="button" onClick={closePanel} aria-label="Close computer">
          <X size={18} />
        </button>
      </header>
      {pending ? <p role="status">Checking your computer…</p> : null}
      {error || status?.error ? (
        <p role="alert">{error || status?.error}</p>
      ) : null}
      {desktop.error ? <p role="alert">{desktop.error}</p> : null}
      {changed ? (
        <p role="alert">
          This work's computer is unavailable. Choose its exact machine in
          Settings → Computers, or correct the agent's computer setting.
        </p>
      ) : machine ? (
        <>
          <p>
            <strong>{machine.name}</strong>
            <br />
            {machine.status} · View only
          </p>
          <div
            className="cloud-computer-panel__viewer"
            ref={slot}
            aria-label="Native desktop viewer"
          >
            {!desktop.viewer?.open ? (
              <p>Open a view-only stream of this computer.</p>
            ) : (
              <span className="sr-only">
                The remote desktop is displayed in a native view.
              </span>
            )}
          </div>
          <div className="computers-settings__actions">
            {desktop.viewer?.open || uncertain ? (
              <button
                type="button"
                disabled={desktop.pending}
                onClick={() => void desktop.close()}
              >
                {uncertain ? "Retry stop viewing" : "Stop viewing"}
              </button>
            ) : (
              <button
                type="button"
                disabled={
                  busy ||
                  Boolean(status?.pendingAction) ||
                  Boolean(error || status?.error) ||
                  machine.status !== "running"
                }
                onClick={() => {
                  const next = bounds();
                  if (next) void desktop.open(next);
                }}
              >
                View desktop
              </button>
            )}
            <button
              type="button"
              disabled={
                busy ||
                Boolean(status?.pendingAction) ||
                machine.status !== "running"
              }
              onClick={() =>
                void desktop.close().then((closed) => {
                  if (closed)
                    void act({ kind: "pause", machineId: machine.id });
                })
              }
            >
              Pause computer
            </button>
          </div>
          <p>
            Agent commands, file access and desktop control are unavailable
            until a restricted runtime is verified.
          </p>
          <small>
            Stopping this view revokes all Instabox desktop streams for this
            machine, including viewers opened elsewhere.
          </small>
          <small>
            Shared machine storage is not private between agents. Pause
            preserves remote processes. Closing Mivlet does not guarantee remote
            cleanup.
          </small>
        </>
      ) : !pending && !error ? (
        <p>Connect and select your machine in Settings → Computers.</p>
      ) : null}
      {status?.pendingAction ? (
        <p role="status">Remote change awaiting confirmation.</p>
      ) : null}
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          void (status?.pendingAction ? act({ kind: "reconcile" }) : refresh())
        }
      >
        {status?.pendingAction ? "Check operation result" : "Refresh"}
      </button>
    </aside>
  );
}
