import type {
  ProviderUsageModel,
  ProviderUsagePeriod,
  ProviderUsageQuery,
  ProviderUsageSource,
} from "@mivlet/protocol";
import { providerDriverForInstance } from "@mivlet/connectors/backends/driver-registry";

export const periods: { id: ProviderUsagePeriod; label: string }[] = [
  { id: "24h", label: "24 hours" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "90d", label: "90 days" },
];

export function usageWindow(
  period: ProviderUsagePeriod,
  source: ProviderUsageSource,
  now = new Date(),
): ProviderUsageQuery {
  const until = new Date(now.getTime() + 1);
  let cursor = new Date(now);
  const starts: string[] = [];
  if (period === "24h") {
    cursor = new Date(now.getTime() - 24 * 3600_000);
    starts.push(cursor.toISOString());
    cursor.setMinutes(0, 0, 0);
    cursor = new Date(cursor.getTime() + 3600_000);
    while (cursor < until) {
      starts.push(cursor.toISOString());
      cursor = new Date(cursor.getTime() + 3600_000);
    }
  } else {
    cursor.setHours(0, 0, 0, 0);
    cursor.setDate(cursor.getDate() - (Number.parseInt(period) - 1));
    while (cursor < until) {
      starts.push(cursor.toISOString());
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  return {
    since: starts[0],
    until: until.toISOString(),
    bucketStarts: starts,
    source,
  };
}

export const providerName = (id: string) =>
  providerDriverForInstance(id)?.createProvider().label ?? id;
export const tokenTotal = (
  model: Pick<
    ProviderUsageModel,
    "inputTokens" | "outputTokens" | "cacheWriteTokens"
  >,
) => model.inputTokens + model.outputTokens + (model.cacheWriteTokens ?? 0);
export const number = (value: number) => value.toLocaleString();
export const compact = (value: number) =>
  new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
export const dollars = (value: number, abbreviated = false) => {
  const tiny = value > 0 && value < 0.0001;
  return `${tiny ? "<" : ""}${new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    currencyDisplay: abbreviated ? "narrowSymbol" : "symbol",
    notation: abbreviated ? "compact" : "standard",
    minimumFractionDigits: 2,
    maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2,
  }).format(tiny ? 0.0001 : value)}`;
};
export const timestamp = (value?: string) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString()
    : "Not measured";

export function sumUsage(models: ProviderUsageModel[]) {
  return models.reduce(
    (sum, model) => ({
      tokens: sum.tokens + tokenTotal(model),
      input: sum.input + model.inputTokens,
      output: sum.output + model.outputTokens,
      cached: sum.cached + (model.cachedInputTokens ?? 0),
      writes: sum.writes + (model.cacheWriteTokens ?? 0),
      attempts: sum.attempts + model.attempts,
      reported: sum.reported + model.reportedCostUsd,
      reportedCount: sum.reportedCount + model.reportedCostAttempts,
      estimated: sum.estimated + model.estimatedCostUsd,
      estimatedCount: sum.estimatedCount + model.estimatedCostAttempts,
      unpriced: sum.unpriced + model.unpricedAttempts,
      cacheSavings: sum.cacheSavings + (model.cacheSavingsUsd ?? 0),
      savingsKnown: sum.savingsKnown || model.cacheSavingsUsd !== undefined,
      cacheKnown: sum.cacheKnown || model.cachedInputTokens !== undefined,
    }),
    {
      tokens: 0,
      input: 0,
      output: 0,
      cached: 0,
      writes: 0,
      attempts: 0,
      reported: 0,
      reportedCount: 0,
      estimated: 0,
      estimatedCount: 0,
      unpriced: 0,
      cacheSavings: 0,
      savingsKnown: false,
      cacheKnown: false,
    },
  );
}
