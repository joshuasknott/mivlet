import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { CaretDown } from "@phosphor-icons/react/dist/csr/CaretDown";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { SidebarMenu } from "./SidebarMenu";

export function SidebarSection({ title, collapsed, onToggle, sort, onSort, onCreate, empty = false, children }: {
  title: "Projects" | "Agents";
  collapsed: boolean;
  onToggle: () => void;
  sort: "recent" | "manual";
  onSort: (sort: "recent" | "manual") => void;
  onCreate?: () => void;
  empty?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!collapsed && list.current) list.current.scrollTop = 0;
  }, [collapsed, sort]);
  return <section className="sidebar-section" data-collapsed={collapsed} data-empty={empty || undefined} aria-label={title}>
    <header className="sidebar-section__header">
      {empty ? <span className="sidebar-section__title">{title}</span> : <button className="sidebar-section__toggle" type="button" aria-expanded={!collapsed}
        aria-controls={id} onClick={onToggle}>{title}<CaretDown size={13} aria-hidden="true" /></button>}
      <div className={`sidebar-section__actions${empty ? " sidebar-section__actions--visible" : ""}`}>
        {!empty && <SidebarMenu label={`Organize ${title.toLowerCase()}`} items={[
          { label: "Most recent", checked: sort === "recent", run: () => onSort("recent") },
          { label: "Manual order", checked: sort === "manual", run: () => onSort("manual") },
        ]} />}
        {onCreate && <button className="sidebar-icon-button" type="button" onClick={onCreate}
          aria-label={`Create ${title === "Projects" ? "project" : "agent"}`} title={`Create ${title === "Projects" ? "project" : "agent"}`}>
          <Plus size={16} aria-hidden="true" />
        </button>}
      </div>
    </header>
    <div ref={list} id={id} className="sidebar-section__list" hidden={!empty && collapsed}>{children}</div>
  </section>;
}
