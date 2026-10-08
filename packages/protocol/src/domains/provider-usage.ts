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
}

export interface ProviderUsageReport {
  checkedAt: string;
  coverage: "saved-mivlet-attempts";
  models: ProviderUsageModel[];
  allowances: ProviderAllowance[];
  prices: ProviderUsagePrice[];
  since: string;
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
