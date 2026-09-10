import { useRef, type ReactNode } from "react";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { useModalFocusTrap } from "../../hooks/useModalFocusTrap";

export function SchedulesDialog({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLElement>(null);
  useModalFocusTrap({ active: true, containerRef: ref, onClose });
  return <div className="settings-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="schedules-dialog" ref={ref} role="dialog" aria-modal="true" aria-labelledby="schedules-title" tabIndex={-1}>
      <header><h1 id="schedules-title">Schedules</h1><button type="button" className="settings-modal__close" aria-label="Close schedules" onClick={onClose}><X size={18} /></button></header>
      {children}
    </section>
  </div>;
}
