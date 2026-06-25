import type {
  KnowledgeCitation,
  KnowledgeSearchResponse,
  KnowledgeSource
} from "@praxis/protocol";

const DEFAULT_RESULT_LIMIT = 5;
const MAX_SNIPPET_CHARACTERS = 240;

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

function sourceScore(source: KnowledgeSource, tokens: string[]) {
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

  const pinBoost = source.pinned ? 0.75 : 0;
  const freshnessBoost = /now|today|current/i.test(source.freshness) ? 0.25 : 0;

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
  score: number
): KnowledgeCitation {
  return {
    sourceId: source.id,
    title: source.title,
    snippet: sourceSnippet(source, tokens),
    provenance: source.provenance,
    freshness: source.freshness,
    trust: source.trust ?? "untrusted",
    pinned: source.pinned,
    score: Number(score.toFixed(2))
  };
}

export function searchKnowledgeSources(
  query: string,
  sources: KnowledgeSource[],
  limit = DEFAULT_RESULT_LIMIT
): KnowledgeSearchResponse {
  const normalizedQuery = query.trim();
  const tokens = tokenize(normalizedQuery);

  const citations = sources
    .map((source) => ({
      source,
      score: sourceScore(source, tokens)
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.source.title.localeCompare(right.source.title);
    })
    .slice(0, Math.max(0, limit))
    .map(({ source, score }) => toCitation(source, tokens, score));

  return {
    query: normalizedQuery,
    mode: "lexical-fallback",
    citations
  };
}
