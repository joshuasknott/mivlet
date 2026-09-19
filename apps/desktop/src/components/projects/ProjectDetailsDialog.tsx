import { useEffect, useId, useRef, type ComponentProps } from "react";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useModalFocusTrap } from "../../hooks/useModalFocusTrap";
import { ProjectContextPanel } from "./ProjectContextPanel";

/** Project settings share the conversation's right panel with agent settings. */
export function ProjectDetailsDialog({ onClose, ...props }: ComponentProps<typeof ProjectContextPanel> & { onClose: () => void }) {
  const title = useId();
  const panel = useRef<HTMLElement>(null);
  const compact = useMediaQuery("(max-width: 850px)");
  useModalFocusTrap({ active: compact, containerRef: panel, onClose });
  useEffect(() => {
    if (compact) return;
    const previous = document.activeElement;
    panel.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [compact, props.project.id]);
  return <div className="workspace-context agent-settings-panel" role="presentation">
    <section ref={panel} tabIndex={-1} className="agent-editor" role="dialog" aria-modal={compact || undefined} aria-labelledby={title}
      onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
      <header className="agent-editor__header"><h2 id={title}>{props.project.name} settings</h2><button type="button" aria-label="Close project settings" onClick={onClose}><X size={18} /></button></header>
      <div className="agent-editor__body"><ProjectContextPanel {...props} /></div>
    </section>
  </div>;
}
