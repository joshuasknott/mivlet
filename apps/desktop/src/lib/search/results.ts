import type { SearchObjectKind, SearchResult } from "@mivlet/protocol";

const KIND_LABELS: Record<SearchObjectKind, string> = {
  agent: "Agent",
  project: "Project",
  conversation: "Chat",
  work: "Work",
  file: "File",
};

export interface SearchHighlightSegment {
  text: string;
  match: boolean;
}

/** Tokens mirror the bounded ASCII lexical matching used by native search. */
export function searchTokens(query: string): string[] {
  const tokens: string[] = [];
  for (const candidate of query.toLowerCase().split(/[^a-z0-9]+/)) {
    if (candidate.length > 1 && !tokens.includes(candidate)) tokens.push(candidate);
  }
  return tokens;
}

export function searchKindLabel(kind: SearchObjectKind): string {
  return KIND_LABELS[kind] ?? "Result";
}

/** Stable key for deduplicating incrementally paged results in React state. */
export function searchResultKey(result: SearchResult): string {
  return `${result.objectKind}:${result.reference.kind}:${result.reference.id}`;
}

/** One-line owning context for a result row. Only fields already present in the
 * native response are described; nothing is inferred from a title. */
export function describeSearchContext(result: SearchResult): string {
  const context = result.context;
  switch (result.objectKind) {
    case "agent":
      return context.agentName ? `Agent · ${context.agentName}` : "Agent";
    case "project":
      return context.projectName ? `Project · ${context.projectName}` : "Project";
    case "conversation": {
      const parts = ["Chat"];
      if (context.conversationTitle) parts.push(context.conversationTitle);
      if (context.projectId) parts.push("Project chat");
      if (context.messageId) parts.push("message match");
      return parts.join(" · ");
    }
    case "work":
      return ["Work", context.agentName, context.workStatus]
        .filter((part): part is string => Boolean(part))
        .join(" · ");
    case "file":
      return context.fileKind === "artifact"
        ? `Artifact · ${context.agentName ?? "Agent"}`
        : "File · Knowledge";
    default:
      return "Result";
  }
}

/** Split bounded display text into plain and matching segments for highlighting.
 * The window is capped so a result row never renders a whole transcript. */
export function highlightSegments(
  text: string,
  query: string,
  maxLength = 200,
): SearchHighlightSegment[] {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length === 0) return [{ text: "", match: false }];
  const clipped =
    compact.length > maxLength ? `${compact.slice(0, maxLength)}…` : compact;
  const tokens = searchTokens(query);
  if (tokens.length === 0) return [{ text: clipped, match: false }];
  const lower = clipped.toLowerCase();
  const segments: SearchHighlightSegment[] = [];
  let cursor = 0;
  while (cursor < clipped.length) {
    let bestIndex = -1;
    let bestToken = "";
    for (const token of tokens) {
      const index = lower.indexOf(token, cursor);
      if (index === -1) continue;
      if (
        bestIndex === -1 ||
        index < bestIndex ||
        (index === bestIndex && token.length > bestToken.length)
      ) {
        bestIndex = index;
        bestToken = token;
      }
    }
    if (bestIndex === -1) {
      segments.push({ text: clipped.slice(cursor), match: false });
      break;
    }
    if (bestIndex > cursor) {
      segments.push({ text: clipped.slice(cursor, bestIndex), match: false });
    }
    segments.push({
      text: clipped.slice(bestIndex, bestIndex + bestToken.length),
      match: true,
    });
    cursor = bestIndex + bestToken.length;
  }
  return segments.length > 0 ? segments : [{ text: clipped, match: false }];
}
