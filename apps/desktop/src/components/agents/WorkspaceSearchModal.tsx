import { Clock } from "@phosphor-icons/react/dist/csr/Clock";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { Plugs } from "@phosphor-icons/react/dist/csr/Plugs";
import { Stack } from "@phosphor-icons/react/dist/csr/Stack";
import { X } from "@phosphor-icons/react/dist/csr/X";
import type { FableAgentProfile } from "@fable/protocol";
import { useMemo, useRef, useState } from "react";
import { useModalFocusTrap } from "../../hooks/useModalFocusTrap";
import { ProfileAgentAvatar } from "./agent-icons";

export type WorkspaceSearchScope = "all" | "agents" | "work" | "knowledge" | "connections";
export type WorkspaceSearchAction = "agent" | "project" | "schedule" | "knowledge" | "connection";

export interface WorkspaceSearchItem {
  id: string;
  scope: Exclude<WorkspaceSearchScope, "all">;
  action: WorkspaceSearchAction;
  title: string;
  description: string;
  meta?: string;
  keywords?: string;
  agent?: FableAgentProfile;
}

const filters: { id: WorkspaceSearchScope; label: string }[] = [
  { id: "all", label: "All" },
  { id: "agents", label: "Agents" },
  { id: "work", label: "Work" },
  { id: "knowledge", label: "Knowledge" },
  { id: "connections", label: "Connections" }
];

export function WorkspaceSearchModal({
  open,
  items,
  onClose,
  onSelect
}: {
  open: boolean;
  items: WorkspaceSearchItem[];
  onClose: () => void;
  onSelect: (item: WorkspaceSearchItem) => void;
}) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<WorkspaceSearchScope>("all");
  const dialogRef = useRef<HTMLElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useModalFocusTrap({
    active: open,
    containerRef: dialogRef,
    initialFocusRef: searchInputRef,
    onClose
  });

  const results = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return items.filter((item) => {
      if (scope !== "all" && item.scope !== scope) return false;
      if (!normalized) return true;
      return [item.title, item.description, item.meta, item.keywords]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase()
        .includes(normalized);
    });
  }, [items, query, scope]);

  if (!open) return null;

  return (
    <div
      className="workspace-search-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="workspace-search-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-search-title"
        tabIndex={-1}
      >
        <header className="workspace-search-modal__header">
          <div>
            <h2 id="workspace-search-title">Search this workspace</h2>
            <p>Find agents, work, knowledge, and connections.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close search"><X size={17} /></button>
        </header>

        <label className="workspace-search-modal__input">
          <MagnifyingGlass size={18} aria-hidden="true" />
          <span className="sr-only">Search this workspace</span>
          <input
            ref={searchInputRef}
            type="search"
            aria-label="Search this workspace"
            placeholder="Search anything"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <kbd>Esc</kbd>
        </label>

        <div className="workspace-search-modal__filters" role="group" aria-label="Search filters">
          {filters.map((filter) => (
            <button
              key={filter.id}
              type="button"
              className={scope === filter.id ? "is-active" : ""}
              aria-pressed={scope === filter.id}
              onClick={() => setScope(filter.id)}
            >
              {filter.label}
            </button>
          ))}
        </div>

        <div className="workspace-search-modal__results" aria-live="polite">
          {results.map((item) => (
            <button
              key={`${item.action}:${item.id}`}
              type="button"
              className="workspace-search-result"
              onClick={() => onSelect(item)}
            >
              <span className={`workspace-search-result__icon workspace-search-result__icon--${item.scope}`} aria-hidden="true">
                {item.scope === "agents" && item.agent ? <ProfileAgentAvatar agent={item.agent} iconSize={30} /> : null}
                {item.scope === "work" ? <Clock size={18} /> : null}
                {item.scope === "knowledge" ? <Stack size={18} /> : null}
                {item.scope === "connections" ? <Plugs size={18} /> : null}
              </span>
              <span className="workspace-search-result__copy">
                <strong>{item.title}</strong>
                <small>{item.description}</small>
              </span>
              <span className="workspace-search-result__meta">{item.meta ?? item.scope}</span>
            </button>
          ))}
          {results.length === 0 ? (
            <div className="workspace-search-modal__empty">
              <strong>No matches</strong>
              <span>Try another phrase or search the whole workspace.</span>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
