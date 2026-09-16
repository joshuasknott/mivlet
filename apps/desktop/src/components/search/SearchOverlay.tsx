import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { SpinnerGap } from "@phosphor-icons/react/dist/csr/SpinnerGap";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { SearchResult } from "@mivlet/protocol";
import { useModalFocusTrap } from "../../hooks/useModalFocusTrap";
import { useWorkspaceSearch } from "../../lib/search/useWorkspaceSearch";
import { SearchResults } from "./SearchResults";
import "./search.css";

export interface SearchOverlayProps {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
  /** P8 routes the target with `navigationTargetFor`; search never creates. */
  onOpenResult: (result: SearchResult) => void;
  enabled?: boolean;
  /** Bump after a domain mutation or deletion to drop cached rows. */
  dataRevision?: number | string;
  debounceMs?: number;
}

/** Reusable unified search dialog. P8 owns mounting, the keyboard chord and
 * final placement; this component owns the scoped query lifecycle. */
export function SearchOverlay({
  workspaceId,
  open,
  onClose,
  onOpenResult,
  enabled = true,
  dataRevision,
  debounceMs,
}: SearchOverlayProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const search = useWorkspaceSearch({
    workspaceId,
    enabled: enabled && open,
    includeArchived,
    dataRevision,
    debounceMs,
  });

  useModalFocusTrap({
    active: open,
    containerRef: panelRef,
    initialFocusRef: inputRef,
    onClose,
  });

  useLayoutEffect(() => {
    setActiveIndex(0);
  }, [search.results]);

  if (!open) return null;

  const trimmedQuery = search.query.trim();
  const showEmpty =
    trimmedQuery.length >= 2 &&
    !search.loading &&
    !search.error &&
    search.results.length === 0;

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) =>
        search.results.length > 0
          ? Math.min(index + 1, search.results.length - 1)
          : 0,
      );
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      const result = search.results[activeIndex];
      if (result) {
        event.preventDefault();
        onOpenResult(result);
      }
    }
  };

  return (
    <div
      className="search-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className="search-overlay__panel"
        role="dialog"
        aria-modal="true"
        aria-label="Search Mivlet"
      >
        <div className="search-overlay__field">
          <MagnifyingGlass size={17} aria-hidden="true" />
          <input
            ref={inputRef}
            type="search"
            role="combobox"
            aria-expanded="true"
            aria-controls="workspace-search-results"
            aria-activedescendant={
              search.results.length > 0
                ? `workspace-search-result-${activeIndex}`
                : undefined
            }
            aria-label="Search agents, projects, chats, work and files"
            placeholder="Search agents, projects, chats, work and files"
            value={search.query}
            onChange={(event) => search.setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          {search.loading ? (
            <SpinnerGap
              size={16}
              className="search-overlay__spinner"
              aria-label="Searching"
            />
          ) : null}
          <button
            type="button"
            className="search-overlay__close"
            onClick={onClose}
            aria-label="Close search"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="search-overlay__options">
          <label>
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(event) => setIncludeArchived(event.target.checked)}
            />
            <span>Include archived</span>
          </label>
          {search.truncated ? (
            <span className="search-overlay__status" role="status">
              Bounded results. Load more to continue searching.
            </span>
          ) : null}
        </div>
        {search.error ? (
          <p className="search-overlay__error" role="alert">
            {search.error}
          </p>
        ) : null}
        {showEmpty ? (
          <p className="search-overlay__empty">
            No results for “{trimmedQuery}”.
          </p>
        ) : null}
        {trimmedQuery.length < 2 ? (
          <p className="search-overlay__hint">
            Type at least two characters to search this workspace.
          </p>
        ) : null}
        <SearchResults
          query={search.query}
          results={search.results}
          activeIndex={activeIndex}
          onActiveIndexChange={setActiveIndex}
          onOpenResult={onOpenResult}
        />
        {search.hasMore ? (
          <button
            type="button"
            className="search-overlay__more"
            onClick={search.loadMore}
            disabled={search.loading}
          >
            Load more
          </button>
        ) : null}
      </div>
    </div>
  );
}
