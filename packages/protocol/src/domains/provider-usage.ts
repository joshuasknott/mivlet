/** Measurements from native managed custody. Never credentials or a subscription bill. */
export interface ProviderUsageWindow {
  id: string;
  label: string;
  usedPercent: number;
  windowDurationMins?: number;
  resetsAt?: string;
}

export interface ProviderAllowance {
  providerId: string;
  /** Opaque hash of a provider-reported account id, or the exact managed custody. */
  identity: string;
  identityKind: "reported-account" | "managed-connection";
  status: "available" | "unavailable" | "stale";
  checkedAt: string;
  observedAt?: string;
  windows: ProviderUsageWindow[];
  reason?: string;
  /** All exhausted windows must reset. Missing reset information leaves this absent. */
  resetOpportunity?: { id: string; resetsAt: string };
}

export interface UsageTokenCategories {
  /** Input includes cached reads; cache writes are additive where the provider reports them separately. */
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface ProviderUsageModel extends UsageTokenCategories {
  providerId: string;
  model: string;
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  reportedCostUsd: number;
  reportedCostAttempts: number;
  estimatedCostUsd: number;
  estimatedCostAttempts: number;
  unpricedAttempts: number;
  latestObservedAt: string;
  cachedInputAttempts?: number;
  cacheWriteAttempts?: number;
  reasoningAttempts?: number;
  cacheSavingsUsd?: number;
}

export type ProviderUsagePeriod = "24h" | "7d" | "30d" | "90d";
export type ProviderUsageSource = "mivlet" | "imported";

/** Explicit UTC instants at local calendar boundaries, including DST changes. */
export interface ProviderUsageQuery {
  since: string;
  until: string;
  bucketStarts: string[];
  source: ProviderUsageSource;
}

export interface ProviderUsageBucket extends ProviderUsageModel {
  startsAt: string;
}

export interface ProviderUsageImportSummary {
  records: number;
  skipped: number;
  importedAt?: string;
  providers: string[];
}

export interface ProviderUsagePricingStatus {
  status: "available" | "stale" | "unavailable";
  source: string;
  observedAt?: string;
  checkedAt?: string;
  reason?: string;
}

export interface ProviderUsageReport {
  checkedAt: string;
  coverage: "saved-mivlet-attempts" | "imported-provider-history";
  models: ProviderUsageModel[];
  allowances: ProviderAllowance[];
  prices: ProviderUsagePrice[];
  since: string;
  until?: string;
  buckets?: ProviderUsageBucket[];
  pricing?: ProviderUsagePricingStatus;
  imports?: ProviderUsageImportSummary;
  missingUsageAttempts?: number;
}

/** User supplied exact-model rates; source and date remain inspectable with estimates. */
export interface ProviderUsagePrice {
  providerId: string;
  model: string;
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  cachedInputPerMillionUsd?: number;
  cacheWritePerMillionUsd?: number;
  source: string;
  observedAt: string;
  origin?: "automatic" | "override";
}

export interface ProviderResetContinuation {
  /** Native connection revision fence; legacy choices without it require review. */
  connectionRevision?: string;
  opportunityId: string;
  resetsAt: string;
  providerId: string;
  identity: string;
  generation: number;
  runId: string;
  state: "armed" | "consumed" | "review-required";
  reason?: string;
}
