import { useEffect, useRef, useState } from "react";
import { CaretDown } from "@phosphor-icons/react/dist/csr/CaretDown";
import { ChartBar } from "@phosphor-icons/react/dist/csr/ChartBar";
import { Gear } from "@phosphor-icons/react/dist/csr/Gear";
import { SignOut } from "@phosphor-icons/react/dist/csr/SignOut";

export function AccountMenu({ name, onUsage, onSettings, onSignOut }: {
  name: string;
  onUsage: () => void;
  onSettings: () => void;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  const choose = (action: () => void) => {
    setOpen(false);
    triggerRef.current?.focus();
    action();
  };
  return (
    <div className="account-menu" ref={rootRef} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }} onKeyDown={(event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
      if (!open || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
        : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }}>
      <button ref={triggerRef} className="agent-sidebar__profile" type="button"
        aria-label={`Account for ${name}`}
        aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="agent-sidebar__profile-avatar">{name.trim().slice(0, 1).toUpperCase() || "F"}</span>
        <span>{name}</span><CaretDown size={14} aria-hidden="true" />
      </button>
      {open ? <div ref={menuRef} className="account-menu__popover" role="menu" aria-label="Account">
        <button type="button" role="menuitem" onClick={() => choose(onUsage)}><ChartBar size={17} />Usage</button>
        <button type="button" role="menuitem" onClick={() => choose(onSettings)}><Gear size={17} />Settings</button>
        <button type="button" role="menuitem" onClick={() => choose(onSignOut)}><SignOut size={17} />Sign out</button>
      </div> : null}
    </div>
  );
}
