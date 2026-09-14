import type { ObjectReference } from "./collaboration.js";

/** P7 unified scoped search. Results are stable object references plus
 * bounded, authorized snippets; search never creates a domain object. */
export type SearchObjectKind =
  | "agent"
  | "project"
  | "conversation"
  | "work"
  | "file";

/** Which part of an object matched the query tokens. */
export type SearchMatchField = "title" | "content" | "metadata";

/** Files are either durable imported knowledge sources or published artifacts. */
export type SearchFileKind = "knowledge" | "artifact";

export interface SearchRequest {
  workspaceId: string;
  query: string;
  /** Omit to search every owned domain. Unknown kinds fail closed. */
  kinds?: SearchObjectKind[];
  /** Archived conversations, projects, work and disabled files are hidden by default. */
  includeArchived?: boolean;
  limit?: number;
  /** Opaque cursor returned by a previous response. */
  cursor?: string;
}

/** Owning context for a result. Every field is derived from authorized native
 * reads; absent fields mean the object has no such context. */
export interface SearchResultContext {
  agentId?: string;
  agentName?: string;
  projectId?: string;
  projectName?: string;
  conversationId?: string;
  conversationTitle?: string;
  threadId?: string;
  messageId?: string;
  messageSequence?: number;
  workId?: string;
  workStatus?: string;
  fileKind?: SearchFileKind;
  artifactId?: string;
  relativePath?: string;
  mimeType?: string;
  sourceId?: string;
  sizeBytes?: number;
}

export interface SearchResult {
  /** Resolve only in the active account; never a title, pane or permission. */
  reference: ObjectReference;
  objectKind: SearchObjectKind;
  title: string;
  /** Bounded matching text from the authorized object. */
  snippet: string;
  matchedField: SearchMatchField;
  score: number;
  /** True when this object is archived and only returned with includeArchived. */
  archived: boolean;
  updatedAt?: string;
  context: SearchResultContext;
}

export interface SearchScanSummary {
  conversationsScanned: number;
  messagesScanned: number;
  workScanned: number;
  projectsScanned: number;
  agentsScanned: number;
  filesScanned: number;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  /** Present when more results exist; pass back on the next request. */
  nextCursor?: string;
  /** True when a native scan budget or the result set was cut short. */
  truncated: boolean;
  scanned: SearchScanSummary;
}

export const SEARCH_MAX_QUERY_CHARACTERS = 200;
export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 50;

export const SEARCH_OBJECT_KINDS: readonly SearchObjectKind[] = [
  "agent",
  "project",
  "conversation",
  "work",
  "file",
];
