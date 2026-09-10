import { useEffect, useRef, useState } from "react";
import { DotsThree } from "@phosphor-icons/react/dist/csr/DotsThree";
import { Clock } from "@phosphor-icons/react/dist/csr/Clock";
import { NotePencil } from "@phosphor-icons/react/dist/csr/NotePencil";

export function WorkspaceMenu({ onSchedules, onEdit, label = "Agent options" }: {
  onSchedules: () => void;
  onEdit?: () => void;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return <div className="workspace-menu" ref={ref} onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  }} onKeyDown={(event) => {
    if (event.key === "Escape" && open) { event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
  }}>
    <button ref={trigger} type="button" className="project-room-action" aria-label={label} title={label} aria-expanded={open} onClick={() => setOpen(!open)}><DotsThree size={20} /></button>
    {open ? <div className="workspace-menu__popover" aria-label={label}>
      <button type="button" onClick={() => { trigger.current?.focus(); setOpen(false); onSchedules(); }}><Clock size={17} />Schedules</button>
      {onEdit ? <button type="button" onClick={() => { trigger.current?.focus(); setOpen(false); onEdit(); }}><NotePencil size={17} />Edit project</button> : null}
    </div> : null}
  </div>;
}
