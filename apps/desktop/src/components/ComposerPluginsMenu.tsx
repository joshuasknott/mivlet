import { useId, useRef, useState, type KeyboardEvent } from "react";
import { CaretRight } from "@phosphor-icons/react/dist/csr/CaretRight";
import { Check } from "@phosphor-icons/react/dist/csr/Check";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { PluginsIcon } from "./PluginsIcon";
import { ConnectorIcon } from "./ConnectorIcon";

/** Only receives callable plugins from the current workspace's connection snapshot. */
export function ComposerPluginsMenu({ connectors, onMention, onAdd }: {
  connectors: { id: string; name: string }[];
  onMention: (id: string) => void;
  onAdd: () => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const submenu = useRef<HTMLDivElement>(null);
  const id = useId();
  const enter = () => {
    setOpen(true);
    requestAnimationFrame(() => submenu.current?.querySelector<HTMLButtonElement>("button")?.focus());
  };
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.key === "Escape" || event.key === "ArrowLeft") {
      event.preventDefault(); setOpen(false); trigger.current?.focus(); return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };
  return <div className="composer-plugins" onMouseEnter={(event) => {
    const pane = event.currentTarget.closest<HTMLElement>(".conversation-pane");
    // Inline submenus move their trigger when expanded; open those on click,
    // so a mouse entering just before pointerdown cannot move the click target.
    if (window.innerWidth > 650 && (!pane || pane.clientWidth > 600)) setOpen(true);
  }}
    onMouseLeave={() => { if (!submenu.current?.contains(document.activeElement)) setOpen(false); }}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button ref={trigger} type="button" role="menuitem" aria-label="Plugins" aria-haspopup="menu"
      aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={enter}
      onKeyDown={(event) => { if (event.key === "ArrowRight") { event.preventDefault(); event.stopPropagation(); enter(); } }}>
      <PluginsIcon size={18} /><span>Plugins</span>
      <span className="composer-plugins__icons" aria-hidden="true">{connectors.slice(0, 3).map(connector =>
        <ConnectorIcon key={connector.id} id={connector.id} />)}</span>
      <CaretRight size={14} />
    </button>
    {open ? <div className="composer-plugins__flyout"><div ref={submenu} id={id} className="composer-plugins__menu"
      role="menu" aria-label="Attached plugins" onKeyDown={navigate}>
      {connectors.map(connector => <button key={connector.id} type="button" role="menuitem"
        onClick={() => onMention(connector.id)}><ConnectorIcon id={connector.id} /><span>{connector.name}</span><Check size={14} /></button>)}
      {!connectors.length ? <p className="composer-plugins__empty">No plugins attached</p> : null}
      <button type="button" role="menuitem" className="composer-plugins__add" onClick={onAdd}><Plus size={18} /><span>Add plugins</span></button>
    </div></div> : null}
  </div>;
}
