import type {
  ProviderAllowance,
  ProviderUsagePrice,
  ProviderUsageReport,
  ProviderUsageQuery,
  ProviderUsagePricingStatus,
  ProviderUsageImportSummary,
} from "@mivlet/protocol";
import { activeDataScope, invokeNative } from "../bridge";
import { providerDriverForInstance } from "@mivlet/connectors/backends/driver-registry";

/** Account routes own subscriptions; API-key and custom routes do not. */
export const isSubscriptionProvider = (providerId: string) =>
  providerDriverForInstance(providerId)?.category === "account";

const noScope = {};
const requests = new WeakMap<object, Map<string, Promise<unknown>>>();

/** Share native work; a renderer timeout never cancels or duplicates a running probe. */
function scopedRequest<T>(
  command: string,
  args?: Record<string, unknown>,
  key?: string,
): Promise<T | null> {
  const scope = activeDataScope();
  const owner = scope ?? noScope;
  let pending = requests.get(owner);
  if (!pending) {
    pending = new Map();
    requests.set(owner, pending);
  }
  const held = key ? pending.get(key) : undefined;
  if (held) return held as Promise<T | null>;
  const request = invokeNative<T>(command, args).then((value) => {
    if (activeDataScope() !== scope)
      throw new Error("The account or workspace changed. Reopen Usage.");
    return value;
  });
  if (key) {
    pending.set(key, request);
    void request
      .finally(() => {
        if (pending.get(key) === request) pending.delete(key);
      })
      .catch(() => {});
  }
  return request;
}

export async function boundedUsageRead<T>(request: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error("Usage request timed out. Try Refresh again.")),
          10_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export const readProviderUsage = (query?: ProviderUsageQuery) =>
  scopedRequest<ProviderUsageReport>("provider_usage_report", { query });
export const readProviderAllowance = (providerId: string) =>
  scopedRequest<ProviderAllowance>("provider_allowance", { providerId });
export const refreshProviderAllowance = (providerId: string) =>
  scopedRequest<ProviderAllowance>(
    "refresh_provider_allowance",
    { providerId },
    `allowance:${providerId}`,
  );
export const saveProviderUsagePrice = (price: ProviderUsagePrice) =>
  scopedRequest<void>("set_provider_usage_price", { price });
export const resetProviderUsagePrice = (providerId: string, model: string) =>
  scopedRequest<void>("reset_provider_usage_price", { providerId, model });
export const refreshProviderUsagePrices = (force = false) =>
  scopedRequest<ProviderUsagePricingStatus>(
    "refresh_provider_usage_prices",
    { force },
    "prices",
  );
export const importProviderUsageHistory = (providerId: "codex" | "claude") =>
  scopedRequest<ProviderUsageImportSummary>("import_provider_usage_history", {
    providerId,
  });
export const clearImportedProviderUsage = () =>
  scopedRequest<void>("clear_imported_provider_usage");

export function allowanceNeedsRefresh(
  report: ProviderAllowance | null,
  now = Date.now(),
) {
  if (currentAllowance(report, now)?.status === "available") return false;
  const age = now - Date.parse(report?.checkedAt ?? "");
  return !Number.isFinite(age) || age < 0 || age >= 300_000;
}

/** UI freshness only; native authority separately validates every continuation. */
export function currentAllowance(
  report: ProviderAllowance | null,
  now = Date.now(),
): ProviderAllowance | null {
  if (!report || report.status !== "available") return report;
  const age = now - Date.parse(report.observedAt ?? "");
  return !Number.isFinite(age) || age < 0 || age > 300_000
    ? { ...report, status: "stale", resetOpportunity: undefined }
    : report;
}
