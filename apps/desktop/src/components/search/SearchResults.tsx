import type { SearchResult } from "@mivlet/protocol";
import {
  describeSearchContext,
  highlightSegments,
  searchKindLabel,
  searchResultKey,
} from "../../lib/search/results";
import "./search.css";

function HighlightedText({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlightSegments(text, query).map((segment, index) =>
        segment.match ? (
          <mark key={index}>{segment.text}</mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

/** Reusable scoped-search result list. P8 supplies routing through
 * `onOpenResult`; this component never dispatches or creates an object. */
export function SearchResults({
  query,
  results,
  activeIndex,
  onActiveIndexChange,
  onOpenResult,
}: {
  query: string;
  results: SearchResult[];
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onOpenResult: (result: SearchResult) => void;
}) {
  if (results.length === 0) return null;
  return (
    <ul
      className="search-results"
      id="workspace-search-results"
      role="listbox"
      aria-label="Search results"
    >
      {results.map((result, index) => (
        <li key={searchResultKey(result)} role="presentation">
          <button
            type="button"
            id={`workspace-search-result-${index}`}
            role="option"
            aria-selected={index === activeIndex}
            className={`search-result${index === activeIndex ? " search-result--active" : ""}`}
            onMouseEnter={() => onActiveIndexChange(index)}
            onFocus={() => onActiveIndexChange(index)}
            onClick={() => onOpenResult(result)}
          >
            <span className="search-result__heading">
              <span className="search-result__kind">
                {searchKindLabel(result.objectKind)}
              </span>
              {result.archived ? (
                <span className="search-result__archived">Archived</span>
              ) : null}
              <strong className="search-result__title">
                <HighlightedText text={result.title} query={query} />
              </strong>
            </span>
            <span className="search-result__context">
              {describeSearchContext(result)}
            </span>
            {result.snippet ? (
              <span className="search-result__snippet">
                <HighlightedText text={result.snippet} query={query} />
              </span>
            ) : null}
          </button>
        </li>
      ))}
    </ul>
  );
}
