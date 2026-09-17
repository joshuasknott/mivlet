import { useEffect, useRef } from "react";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import type { FableAgentProfile, SearchResult } from "@fable/protocol";
import { AgentAvatar, ProfileAgentAvatar } from "../agents/agent-icons";
import { describeSearchContext, highlightSegments, searchResultKey } from "../../lib/search/results";
import "./search.css";

function HighlightedText({ text, query }: { text: string; query: string }) {
  return <>{highlightSegments(text, query).map((segment, index) =>
    segment.match ? <mark key={index}>{segment.text}</mark> : <span key={index}>{segment.text}</span>,
  )}</>;
}

export function SearchResults({
  query, results, agents = [], activeIndex, onActiveIndexChange, onOpenResult,
}: {
  query: string;
  results: SearchResult[];
  agents?: readonly FableAgentProfile[];
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onOpenResult: (result: SearchResult) => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);
  return (
    <ul ref={listRef} className="search-results" id="workspace-search-results"
      role="listbox" aria-label="Search results">
      {results.map((result, index) => {
        const agent = result.objectKind === "agent"
          ? agents.find(item => item.id === result.reference.id) : undefined;
        const snippet = result.objectKind === "agent" ? result.snippet
          : `${describeSearchContext(result)}${result.snippet ? ` · ${result.snippet}` : ""}`;
        return (
          <li key={searchResultKey(result)} role="presentation">
            <button type="button" id={`workspace-search-result-${index}`} role="option"
              aria-selected={index === activeIndex}
              className={`search-result${index === activeIndex ? " search-result--active" : ""}`}
              onMouseEnter={() => onActiveIndexChange(index)}
              onFocus={() => onActiveIndexChange(index)}
              onClick={() => onOpenResult(result)}>
              <span className="search-result__icon" aria-hidden="true">
                {agent ? <ProfileAgentAvatar agent={agent} iconSize={24} />
                  : result.objectKind === "agent" ? <AgentAvatar seed={`blob-v1:${result.reference.id}`} iconSize={24} />
                    : <MagnifyingGlass size={20} />}
              </span>
              <span className="search-result__body">
                <span className="search-result__heading">
                  <strong className="search-result__title"><HighlightedText text={result.title} query={query} /></strong>
                  {result.archived ? <span className="search-result__archived">Archived</span> : null}
                </span>
                {snippet ? <span className="search-result__snippet"><HighlightedText text={snippet} query={query} /></span> : null}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
