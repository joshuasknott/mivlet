import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DotsThree } from "@phosphor-icons/react/dist/csr/DotsThree";
import { Check } from "@phosphor-icons/react/dist/csr/Check";

/** Portalled to keep organization controls usable inside the scrolling lists. */
export function SidebarMenu({ label, items }: {
  label: string;
  items: { label: string; run: () => void; checked?: boolean; disabled?: boolean }[];
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = (restore = false) => { setOpen(false); if (restore) trigger.current?.focus(); };
  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const bounds = menu.current.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(rect.right - bounds.width, window.innerWidth - bounds.width - 8)),
      top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - bounds.height - 8)) });
    menu.current.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close();
    };
    const resize = () => close();
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    document.addEventListener("scroll", outside, true);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("scroll", outside, true);
      window.removeEventListener("resize", resize);
    };
  }, [open]);
  return <>
    <button ref={trigger} type="button" className="sidebar-icon-button sidebar-more" aria-label={label}
      title={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => setOpen(!open)} onKeyDown={(event) => {
        if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); setOpen(true); }
      }}><DotsThree size={20} aria-hidden="true" /></button>
    {open && createPortal(<div ref={menu} id={id} role="menu" aria-label={label}
      className="sidebar-menu" style={position} onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }}>
      {items.map((item) => <button type="button" key={item.label}
        role={item.checked === undefined ? "menuitem" : "menuitemradio"}
        aria-checked={item.checked} disabled={item.disabled}
        onClick={() => { close(true); item.run(); }}>
        <span>{item.label}</span>{item.checked ? <Check size={15} aria-hidden="true" /> : null}
      </button>)}
    </div>, document.body)}
  </>;
}
