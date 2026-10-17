/** Static public HTTPS research. This grants no browser input or local tools. */
export const HOSTED_PUBLIC_WEB_LIMITS = {
  modelCalls: 4,
  pageReads: 6,
  outputTokens: 4_096,
  tokensPerCall: 1_024,
  elapsedMs: 120_000,
  sourceBytes: 65_536,
  pageTextBytes: 16_384,
  htmlBytes: 512 * 1024,
  contextBytes: 192 * 1024,
  domains: 8,
  initialUrls: 4,
  linksPerPage: 24,
  redirectsPerRead: 3,
  readMs: 10_000,
} as const;

export interface HostedPublicWebScope {
  /** Exact DNS hostnames. No wildcards, ports, credentials or IP literals. */
  allowedDomains: string[];
  /** Exact initial public URLs; later reads remain in the reviewed domains. */
  initialUrls: string[];
}
export interface HostedPublicWebBudget {
  maxModelCalls: number;
  /** Aggregate server-requested token allocation across all provider calls. */
  maxOutputTokens: number;
  maxElapsedMs: number;
  maxResultBytes: number;
  maxPageReads: number;
  maxSourceBytes: number;
}
export interface HostedPublicWebProgress {
  modelCalls: number;
  pageReads: number;
  sourceBytes: number;
  /** Bounded public evidence only; source bodies expire with task text. */
  sources: HostedPublicWebSource[];
}
export interface HostedPublicWebSource {
  citationId: string;
  title: string;
  finalUri: string;
  fetchedAt: string;
  contentSha256: string;
  contentBytes: number;
  truncated: boolean;
}
