import type {
  ProviderAllowance,
  ProviderUsagePrice,
  ProviderUsageReport,
} from "@mivlet/protocol";
import { invokeNative } from "../bridge";
import { providerDriverForInstance } from "@mivlet/connectors/backends/driver-registry";

/** Account routes own subscriptions; API-key and custom routes do not. */
export const isSubscriptionProvider = (providerId: string) =>
  providerDriverForInstance(providerId)?.category === "account";

export const readProviderUsage = () =>
  invokeNative<ProviderUsageReport>("provider_usage_report");
export const readProviderAllowance = (providerId: string) =>
  invokeNative<ProviderAllowance>("provider_allowance", { providerId });
export const refreshProviderAllowance = (providerId: string) =>
  invokeNative<ProviderAllowance>("refresh_provider_allowance", { providerId });
export const saveProviderUsagePrice = (price: ProviderUsagePrice) =>
  invokeNative<void>("set_provider_usage_price", { price });

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

export function allowanceLabel(report: ProviderAllowance | null): string {
  if (!report) return "Allowance unavailable";
  if (report.status === "stale") return "Allowance stale";
  if (report.status !== "available" || !report.windows.length)
    return "Allowance unavailable";
  const values = report.windows
    .map((window) => window.usedPercent)
    .filter((value) => Number.isFinite(value) && value >= 0 && value <= 100);
  return values.length
    ? `${Math.max(...values).toLocaleString()}% used`
    : "Allowance unavailable";
}
