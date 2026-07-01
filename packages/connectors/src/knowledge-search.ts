import type {
  CitationRanking,
  KnowledgeCitation,
  KnowledgeSearchResponse,
  KnowledgeSource,
  SourceStatus
} from "@fable/protocol";

const DEFAULT_RESULT_LIMIT = 5;
const MAX_SNIPPET_CHARACTERS = 240;
const DEFAULT_BUDGET_CHARS = 6_000;

/** Sources that must never produce a citation regardless of score. */
const EXCLUDED_STATUSES: ReadonlySet<SourceStatus> = new Set(["error", "stale", "indexing"]);

/**
 * True when a source is eligible for retrieval: not disabled and not in an
 * excluded status. Deleted sources are not passed in (the store drops them);
 * disabled/error/stale/indexing sources are excluded here so this adapter does
 * not surface ineligible material even when the caller has not pre-filtered.
 */
function isRetrievable(source: KnowledgeSource): boolean {
  if (source.disabled) return false;
  if (source.status && EXCLUDED_STATUSES.has(source.status)) return false;
  return true;
}

function tokenize(value: string) {
  return Array.from(
    new Set(
      value
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length > 1)
    )
  );
}

function countMatches(value: string, tokens: string[]) {
  const normalized = value.toLowerCase();
  return tokens.reduce((count, token) => {
    let cursor = 0;
    let matches = 0;

    while (cursor < normalized.length) {
      const match = normalized.indexOf(token, cursor);
      if (match < 0) {
        break;
      }

      matches += 1;
      cursor = match + token.length;
    }

    return count + matches;
  }, 0);
}

function sourceScore(
  source: KnowledgeSource,
  tokens: string[],
  pinBoost: number,
  freshnessBoost: number
) {
  if (tokens.length === 0) {
    return source.pinned ? 1 : 0;
  }

  const titleScore = countMatches(source.title, tokens) * 4;
  const contentScore = countMatches(source.contentPreview ?? "", tokens);
  const provenanceScore = countMatches(source.provenance, tokens) * 0.75;
  const matchScore = titleScore + contentScore + provenanceScore;
  if (matchScore === 0) {
    return 0;
  }

  return matchScore + pinBoost + freshnessBoost;
}

function sourceSnippet(source: KnowledgeSource, tokens: string[]) {
  const content = (source.contentPreview ?? source.provenance).replace(/\s+/g, " ").trim();
  if (content.length <= MAX_SNIPPET_CHARACTERS) {
    return content;
  }

  const normalized = content.toLowerCase();
  const firstMatch = tokens
    .map((token) => normalized.indexOf(token))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  const start = Math.max(0, (firstMatch ?? 0) - 60);
  const end = Math.min(content.length, start + MAX_SNIPPET_CHARACTERS);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < content.length ? "..." : "";

  return `${prefix}${content.slice(start, end).trim()}${suffix}`;
}

function toCitation(
  source: KnowledgeSource,
  tokens: string[],
  score: number,
  pinContribution: number,
  freshnessContribution: number
): KnowledgeCitation {
  const relevance = Math.max(0, score - pinContribution - freshnessContribution);
  const ranking: CitationRanking = {
    relevance: Number(relevance.toFixed(2)),
    recency: 0,
    authority: Number((source.authority ?? 0.5).toFixed(2)),
    pin: Number(pinContribution.toFixed(2)),
    feedback: 0
  };
  const citation: KnowledgeCitation = {
    sourceId: source.id,
    title: source.title,
    snippet: sourceSnippet(source, tokens),
    provenance: source.provenance,
    freshness: source.freshness,
    trust: source.trust ?? "untrusted",
    pinned: source.pinned,
    score: Number(score.toFixed(2)),
    chunkId: `${source.id}#0`,
    ranking
  };
  if (source.sourcePath) citation.sourcePath = source.sourcePath;
  if (source.mediaType) citation.mediaType = source.mediaType;
  if (source.scope) citation.scope = source.scope;
  if (source.account) citation.account = source.account;
  return citation;
}

export interface KnowledgeSearchOptions {
  /** Max number of citations. Default 5. */
  limit?: number;
  /** Character budget across all returned snippets. Default 6000. */
  budgetChars?: number;
}

export function searchKnowledgeSources(
  query: string,
  sources: KnowledgeSource[],
  limitOrOptions: number | KnowledgeSearchOptions = DEFAULT_RESULT_LIMIT
): KnowledgeSearchResponse {
  const options =
    typeof limitOrOptions === "number"
      ? { limit: limitOrOptions, budgetChars: DEFAULT_BUDGET_CHARS }
      : {
          limit: limitOrOptions.limit ?? DEFAULT_RESULT_LIMIT,
          budgetChars: limitOrOptions.budgetChars ?? DEFAULT_BUDGET_CHARS
        };

  const normalizedQuery = query.trim();
  const tokens = tokenize(normalizedQuery);

  // De-duplicate the input by source id so the same source cannot produce
  // multiple citations.
  const seenIds = new Set<string>();
  const unique = sources.filter((source) => {
    if (seenIds.has(source.id)) return false;
    seenIds.add(source.id);
    return true;
  });

  const ranked = unique
    .filter(isRetrievable)
    .map((source) => {
      const pinContribution = source.pinned ? 0.75 : 0;
      const freshnessContribution = /now|today|current|just|min|h ago|d ago/i.test(source.freshness)
        ? 0.25
        : 0;
      return { source, score: sourceScore(source, tokens, pinContribution, freshnessContribution) };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      // Deterministic tie-break: title, then sourceId.
      const byTitle = left.source.title.localeCompare(right.source.title);
      if (byTitle !== 0) return byTitle;
      return left.source.id.localeCompare(right.source.id);
    })
    .slice(0, Math.max(0, options.limit));

  // Apply the character budget across snippets (always keep the top citation).
  const citations: KnowledgeCitation[] = [];
  let used = 0;
  for (const { source, score } of ranked) {
    const citation = toCitation(
      source,
      tokens,
      score,
      source.pinned ? 0.75 : 0,
      /now|today|current|just|min|h ago|d ago/i.test(source.freshness) ? 0.25 : 0
    );
    if (used + citation.snippet.length > options.budgetChars && citations.length > 0) break;
    citations.push(citation);
    used += citation.snippet.length;
  }

  return {
    query: normalizedQuery,
    mode: "lexical-fallback",
    citations
  };
}
