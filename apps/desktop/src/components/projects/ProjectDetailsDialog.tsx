import { useId, useRef, type ComponentProps } from "react";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { useModalFocusTrap } from "../../hooks/useModalFocusTrap";
import { ProjectContextPanel } from "./ProjectContextPanel";

/** Project configuration is reached through its conversation title, outside the content panel. */
export function ProjectDetailsDialog({ onClose, ...props }: ComponentProps<typeof ProjectContextPanel> & { onClose: () => void }) {
  const panel = useRef<HTMLElement>(null);
  const title = useId();
  useModalFocusTrap({ active: true, containerRef: panel, onClose });
  return <div className="settings-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="schedules-dialog" ref={panel} role="dialog" aria-modal="true" aria-labelledby={title} tabIndex={-1}>
      <header><h1 id={title}>{props.project.name} settings</h1><button type="button" className="settings-modal__close" aria-label="Close project settings" onClick={onClose}><X size={18} /></button></header>
      <div style={{ padding: "8px 24px 24px", overflow: "auto" }}><ProjectContextPanel {...props} /></div>
    </section>
  </div>;
}
