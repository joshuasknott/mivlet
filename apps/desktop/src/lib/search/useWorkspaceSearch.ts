import { useCallback, useEffect, useRef, useState } from "react";
import type {
  SearchObjectKind,
  SearchResult,
  SearchScanSummary,
} from "@mivlet/protocol";
import { searchWorkspace } from "../../runtime/domains/search";
import { searchResultKey } from "./results";

export interface UseWorkspaceSearchOptions {
  workspaceId: string | undefined;
  enabled?: boolean;
  includeArchived?: boolean;
  kinds?: readonly SearchObjectKind[];
  /** Bump after a domain mutation or deletion so cached rows are dropped. */
  dataRevision?: number | string;
  debounceMs?: number;
  limit?: number;
}

export interface WorkspaceSearchState {
  query: string;
  setQuery: (value: string) => void;
  results: SearchResult[];
  loading: boolean;
  error: string;
  truncated: boolean;
  hasMore: boolean;
  scanned: SearchScanSummary | null;
  loadMore: () => void;
  refresh: () => void;
  reset: () => void;
}

const MINIMUM_QUERY_LENGTH = 2;

/** Bounded, incrementally paged scoped search. Never loads transcripts into
 * React: each request returns a native-bounded page, stale responses are
 * fenced, and any scope/revision change clears cached rows immediately. */
export function useWorkspaceSearch(
  options: UseWorkspaceSearchOptions,
): WorkspaceSearchState {
  const {
    workspaceId,
    enabled = true,
    includeArchived = false,
    kinds,
    dataRevision,
    debounceMs = 160,
    limit,
  } = options;
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [scanned, setScanned] = useState<SearchScanSummary | null>(null);

  const sequence = useRef(0);
  const kindsKey = (kinds ?? []).join(",");
  const scopeKey = [
    workspaceId ?? "",
    String(dataRevision ?? ""),
    includeArchived ? "1" : "0",
    kindsKey,
    limit ?? "",
    enabled ? "1" : "0",
  ].join("\u0000");
  const scopeRef = useRef(scopeKey);

  const request = useCallback(
    async (text: string, cursor?: string, append = false) => {
      const trimmed = text.trim();
      const requestedKinds = kindsKey
        ? (kindsKey.split(",") as SearchObjectKind[])
        : undefined;
      if (!enabled || !workspaceId || trimmed.length < MINIMUM_QUERY_LENGTH) {
        sequence.current += 1;
        setResults([]);
        setNextCursor(undefined);
        setTruncated(false);
        setScanned(null);
        setError("");
        setLoading(false);
        return;
      }
      const id = sequence.current + 1;
      sequence.current = id;
      setLoading(true);
      if (!append) setError("");
      try {
        const response = await searchWorkspace({
          workspaceId,
          query: trimmed,
          includeArchived: includeArchived || undefined,
          kinds: requestedKinds,
          limit,
          cursor,
        });
        if (id !== sequence.current || scopeRef.current !== scopeKey) return;
        setResults((current) => {
          if (!append) return response.results;
          const seen = new Set(current.map(searchResultKey));
          return [
            ...current,
            ...response.results.filter(
              (result) => !seen.has(searchResultKey(result)),
            ),
          ];
        });
        setNextCursor(response.nextCursor);
        setTruncated(response.truncated);
        setScanned(response.scanned);
        setError("");
      } catch (caught) {
        if (id !== sequence.current || scopeRef.current !== scopeKey) return;
        setError(caught instanceof Error ? caught.message : "Search failed.");
      } finally {
        if (id === sequence.current && scopeRef.current === scopeKey) {
          setLoading(false);
        }
      }
    },
    [enabled, workspaceId, includeArchived, kindsKey, limit, scopeKey],
  );

  useEffect(() => {
    scopeRef.current = scopeKey;
    sequence.current += 1;
    setResults([]);
    setNextCursor(undefined);
    setTruncated(false);
    setScanned(null);
    setError("");
  }, [scopeKey]);

  useEffect(() => {
    if (debounceMs <= 0) {
      setDebouncedQuery(query);
      return;
    }
    const timer = window.setTimeout(() => setDebouncedQuery(query), debounceMs);
    return () => window.clearTimeout(timer);
  }, [query, debounceMs]);

  useEffect(() => {
    void request(debouncedQuery);
  }, [request, debouncedQuery]);

  const loadMore = useCallback(() => {
    if (!nextCursor || loading) return;
    void request(debouncedQuery, nextCursor, true);
  }, [nextCursor, loading, request, debouncedQuery]);

  const refresh = useCallback(() => {
    void request(debouncedQuery);
  }, [request, debouncedQuery]);

  const reset = useCallback(() => {
    sequence.current += 1;
    setQuery("");
    setDebouncedQuery("");
    setResults([]);
    setNextCursor(undefined);
    setTruncated(false);
    setScanned(null);
    setError("");
    setLoading(false);
  }, []);

  return {
    query,
    setQuery,
    results,
    loading,
    error,
    truncated,
    hasMore: Boolean(nextCursor),
    scanned,
    loadMore,
    refresh,
    reset,
  };
}
