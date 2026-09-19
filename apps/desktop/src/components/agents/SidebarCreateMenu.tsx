import { useEffect, useId, useRef, useState } from "react";
import type { MivletAgentProfile } from "@mivlet/protocol";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { Users } from "@phosphor-icons/react/dist/csr/Users";
import { ProfileAgentAvatar } from "./agent-icons";
import "./sidebar-create-menu.css";

export function SidebarCreateMenu({ agents, onCreateAgent, onCreateProject, onSelectAgent }: {
  agents: MivletAgentProfile[];
  onCreateAgent: () => void;
  onCreateProject?: () => void;
  onSelectAgent: (agent: MivletAgentProfile) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  const choose = (action: () => void) => {
    setOpen(false);
    trigger.current?.focus();
    action();
  };
  const matches = agents.filter(agent => agent.name.toLowerCase().includes(query.trim().toLowerCase()));
  return <div className="sidebar-create" ref={root} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }} onKeyDown={event => {
    if (!open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      choose(() => {});
    }
    if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(panel.current?.querySelectorAll<HTMLElement>("input, button") ?? []);
    const current = items.indexOf(document.activeElement as HTMLElement);
    items[(current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  }}>
    <button ref={trigger} type="button" className="agent-sidebar__new" aria-label="Create or message" title="Create or message"
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => { setQuery(""); setOpen(!open); }}><Plus size={19} aria-hidden="true" /></button>
    {open ? <div ref={panel} id={id} role="dialog" aria-label="Create or message" className="sidebar-create__popover">
      <input ref={input} type="search" aria-label="Find an agent to message" placeholder="Search or create an agent…"
        value={query} onChange={event => setQuery(event.target.value)} />
      <div className="sidebar-create__items">
        <button type="button" onClick={() => choose(onCreateAgent)}><span className="sidebar-create__icon"><Plus size={17} /></span><span>Create agent</span></button>
        {onCreateProject ? <button type="button" onClick={() => choose(onCreateProject)}><span className="sidebar-create__icon"><Users size={17} /></span><span>Create project</span></button> : null}
        {matches.map(agent => <button key={agent.id} type="button" aria-label={`Message ${agent.name}`} onClick={() => choose(() => onSelectAgent(agent))}>
          <ProfileAgentAvatar agent={agent} iconSize={25} /><span>{agent.name}</span>
        </button>)}
        {!matches.length ? <p>{agents.length ? "No matching agents." : "Create your first agent to start messaging."}</p> : null}
      </div>
    </div> : null}
  </div>;
}
