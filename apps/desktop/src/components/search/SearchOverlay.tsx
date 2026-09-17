import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { SpinnerGap } from "@phosphor-icons/react/dist/csr/SpinnerGap";
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { FableAgentProfile, SearchResult } from "@fable/protocol";
import { useModalFocusTrap } from "../../hooks/useModalFocusTrap";
import { useWorkspaceSearch } from "../../lib/search/useWorkspaceSearch";
import { SearchResults } from "./SearchResults";
import "./search.css";

export interface SearchOverlayProps {
  workspaceId: string;
  /** Profiles from the active, hydrated workspace only. */
  agents?: readonly FableAgentProfile[];
  open: boolean;
  onClose: () => void;
  onOpenResult: (result: SearchResult) => void;
  enabled?: boolean;
  dataRevision?: number | string;
  debounceMs?: number;
}

const NO_AGENTS: readonly FableAgentProfile[] = [];

export function SearchOverlay({
  workspaceId, agents = NO_AGENTS, open, onClose, onOpenResult,
  enabled = true, dataRevision, debounceMs,
}: SearchOverlayProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const search = useWorkspaceSearch({
    workspaceId, enabled: enabled && open, dataRevision, debounceMs,
  });
  useModalFocusTrap({
    active: open, containerRef: panelRef, initialFocusRef: inputRef, onClose,
  });
  const trimmedQuery = search.query.trim();
  const browsingAgents = trimmedQuery.length < 2;
  const results = useMemo<SearchResult[]>(() => {
    if (!enabled || !workspaceId) return [];
    if (!browsingAgents) return search.results;
    const query = trimmedQuery.toLocaleLowerCase();
    return agents.filter(agent => `${agent.name} ${agent.instructions}`.toLocaleLowerCase().includes(query))
      .map(agent => ({
        reference: { workspaceId, kind: "agent", id: agent.id },
        objectKind: "agent", title: agent.name,
        snippet: agent.instructions.replace(/\s+/g, " ").trim().slice(0, 200),
        matchedField: "title", score: 0, archived: false,
        context: { agentId: agent.id, agentName: agent.name },
      }));
  }, [agents, browsingAgents, enabled, search.results, trimmedQuery, workspaceId]);

  useLayoutEffect(() => { setActiveIndex(0); }, [results]);
  if (!open) return null;

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex(index => Math.min(index + 1, Math.max(0, results.length - 1)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(index => Math.max(index - 1, 0));
    } else if (event.key === "Enter" && results[activeIndex]) {
      event.preventDefault();
      onOpenResult(results[activeIndex]);
    }
  };

  return (
    <div className="search-overlay" role="presentation"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={panelRef} className="search-overlay__panel" role="dialog"
        aria-modal="true" aria-label="Search Mivlet">
        <div className="search-overlay__field">
          <MagnifyingGlass size={16} aria-hidden="true" />
          <input ref={inputRef} type="search" role="combobox" aria-expanded="true"
            aria-controls="workspace-search-results"
            aria-activedescendant={results.length ? `workspace-search-result-${activeIndex}` : undefined}
            aria-label="Search agents, projects, chats, work and files"
            placeholder="Search" value={search.query}
            onChange={event => search.setQuery(event.target.value)}
            onKeyDown={handleKeyDown} />
          {!browsingAgents && search.loading
            ? <SpinnerGap size={16} className="search-overlay__spinner" aria-label="Searching" /> : null}
        </div>
        {!browsingAgents && search.error
          ? <p className="search-overlay__error" role="alert">{search.error}</p> : null}
        {(browsingAgents || (!search.loading && !search.error)) && !results.length
          ? <p className="search-overlay__empty">{trimmedQuery ? `No results for “${trimmedQuery}”.` : "No agents yet."}</p> : null}
        <SearchResults query={search.query} results={results} agents={agents}
          activeIndex={activeIndex} onActiveIndexChange={setActiveIndex} onOpenResult={onOpenResult} />
        {!browsingAgents && search.hasMore
          ? <button type="button" className="search-overlay__more"
              onClick={search.loadMore} disabled={search.loading}>Load more</button> : null}
      </div>
    </div>
  );
}
