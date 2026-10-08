import { useEffect, useRef, useState } from "react";
import { ArrowClockwise } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { ArrowRight } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import type {
  BackendProvider,
  ProviderAllowance,
  ProviderUsageWindow,
} from "@mivlet/protocol";
import { ProviderIcon } from "../ProviderIcon";
import { listRuntimeBackends } from "../../runtime/domains/providers";
import {
  currentAllowance,
  isSubscriptionProvider,
  readProviderAllowance,
  refreshProviderAllowance,
} from "../../runtime/domains/provider-usage";
import "./provider-usage.css";

export const connectedSubscriptions = (
  providers: BackendProvider[],
  connectedProviderIds?: string[],
) =>
  providers.filter(
    (provider) =>
      provider.authState === "connected" &&
      (!connectedProviderIds || connectedProviderIds.includes(provider.id)) &&
      provider.setup?.kind !== "api-key" &&
      isSubscriptionProvider(provider.id),
  );

function resetLabel(value: string | undefined, now: number) {
  const reset = Date.parse(value ?? "");
  if (!Number.isFinite(reset)) return "Reset time unavailable";
  const minutes = Math.ceil((reset - now) / 60_000);
  if (minutes <= 0) return "Reset time passed — refresh to verify";
  const [amount, unit] =
    minutes < 60
      ? [minutes, "minute"]
      : minutes < 1440
        ? [Math.ceil(minutes / 60), "hour"]
        : [Math.ceil(minutes / 1440), "day"];
  return `Resets in ${amount} ${unit}${amount === 1 ? "" : "s"}`;
}

function windowLabel(window: ProviderUsageWindow, providerId: string) {
  const label =
    window.windowDurationMins === 300
      ? "5-hour limit"
      : window.windowDurationMins === 10080
        ? "Weekly limit"
        : window.label;
  // Retain model/bucket names instead of merging different provider limits.
  if (window.id.startsWith("model:")) return window.label;
  const bucket = window.id.split(":").slice(0, -1).join(":");
  return bucket && bucket !== providerId ? `${label} · ${bucket}` : label;
}

/** Provider-reported allowance only. Saved attempt/cost breakdowns stay in Settings. */
export function SubscriptionUsage({
  providers,
  connectedProviderIds,
  onOpenBreakdowns,
}: {
  providers?: BackendProvider[];
  connectedProviderIds?: string[];
  onOpenBreakdowns?: () => void;
}) {
  const [inventory, setInventory] = useState<BackendProvider[]>(
    providers ?? [],
  );
  const [reports, setReports] = useState<
    Record<string, ProviderAllowance | null>
  >({});
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now);
  const generation = useRef(0);
  const subscriptions = connectedSubscriptions(
    providers ?? inventory,
    connectedProviderIds,
  );
  useEffect(() => {
    const request = ++generation.current;
    setReports({});
    setLoading(true);
    setPending(false);
    setError("");
    void (async () => {
      try {
        const available = providers ?? (await listRuntimeBackends());
        if (request !== generation.current) return;
        if (!available) {
          setInventory([]);
          throw new Error("Provider metadata unavailable");
        }
        setInventory(available);
        await Promise.all(
          connectedSubscriptions(available, connectedProviderIds).map(
            async (provider) => {
              const report = await readProviderAllowance(provider.id).catch(
                () => null,
              );
              if (request === generation.current) {
                setNow(Date.now());
                setReports((current) => ({
                  ...current,
                  [provider.id]: report,
                }));
              }
            },
          ),
        );
      } catch {
        if (request === generation.current)
          setError("Connected subscriptions could not be loaded.");
      } finally {
        if (request === generation.current) setLoading(false);
      }
    })();
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      generation.current++;
      window.clearInterval(timer);
    };
  }, [providers, connectedProviderIds]);
  const refresh = async () => {
    if (pending || loading) return;
    const request = ++generation.current;
    setPending(true);
    setError("");
    let targets = subscriptions;
    if (!providers) {
      const available = await listRuntimeBackends().catch(() => null);
      if (request !== generation.current) return;
      setInventory(available ?? []);
      if (!available) {
        setReports({});
        setError("Connected subscriptions could not be loaded.");
        setPending(false);
        return;
      }
      targets = connectedSubscriptions(available, connectedProviderIds);
    }
    await Promise.all(
      targets.map(async (provider) => {
        try {
          const report = await refreshProviderAllowance(provider.id);
          if (request === generation.current) {
            setNow(Date.now());
            setReports((current) => ({ ...current, [provider.id]: report }));
          }
        } catch {
          if (request !== generation.current) return;
          setError(
            "Some allowances could not be refreshed. Last measurements remain visible.",
          );
          setReports((current) => ({
            ...current,
            [provider.id]: current[provider.id]
              ? {
                  ...current[provider.id]!,
                  status: "stale",
                  resetOpportunity: undefined,
                }
              : null,
          }));
        }
      }),
    );
    if (request === generation.current) {
      setNow(Date.now());
      setPending(false);
    }
  };
  return (
    <div className="subscription-usage">
      <header>
        <p>Your connected subscriptions</p>
        <button
          className="subscription-usage__refresh"
          type="button"
          disabled={loading || pending || (!subscriptions.length && !error)}
          onClick={() => void refresh()}
        >
          <ArrowClockwise size={21} aria-hidden="true" />
          {pending ? "Checking…" : "Refresh"}
        </button>
      </header>
      {loading ? (
        <p role="status">Loading subscription usage…</p>
      ) : !subscriptions.length && pending ? (
        <p role="status">Checking connected subscriptions…</p>
      ) : !subscriptions.length && !error ? (
        <p role="status">
          No connected subscriptions. Connect an account provider in Settings.
        </p>
      ) : null}
      {subscriptions.map((provider) => {
        const report = currentAllowance(reports[provider.id] ?? null, now);
        const windows =
          report?.windows.filter(
            (window) =>
              Number.isFinite(window.usedPercent) &&
              window.usedPercent >= 0 &&
              window.usedPercent <= 100,
          ) ?? [];
        return (
          <section
            className="subscription-usage__provider"
            key={provider.id}
            aria-label={`${provider.label} subscription usage`}
            data-status={report?.status ?? "unavailable"}
          >
            <header>
              <ProviderIcon provider={provider.id} size={52} />
              <div>
                <h3>{provider.label}</h3>
                <p>
                  <CheckCircle size={14} weight="fill" aria-hidden="true" />
                  Connected
                  {report?.status === "stale" ? " · Measurement stale" : ""}
                </p>
              </div>
            </header>
            {report?.status === "available" || report?.status === "stale"
              ? windows.map((window) => {
                  const label = windowLabel(window, provider.id);
                  return (
                    <div className="subscription-usage__window" key={window.id}>
                      <div>
                        <span>{label}</span>
                        <strong>
                          {window.usedPercent.toLocaleString()}% used
                          {report.status === "stale" ? " · last measured" : ""}
                        </strong>
                      </div>
                      <progress
                        max={100}
                        value={window.usedPercent}
                        aria-label={`${provider.label} ${label}: ${window.usedPercent}% used${report.status === "stale" ? ", stale measurement" : ""}`}
                      />
                      <small title={window.resetsAt}>
                        {resetLabel(window.resetsAt, now)}
                      </small>
                    </div>
                  );
                })
              : null}
            {!windows.length || report?.status === "unavailable" ? (
              <p role="status">
                {loading ? "Loading allowance…" : "Usage unavailable"}
              </p>
            ) : null}
            {report?.reason ? (
              <p className="subscription-usage__note">{report.reason}</p>
            ) : null}
          </section>
        );
      })}
      {error ? <p role="alert">{error}</p> : null}
      {onOpenBreakdowns ? (
        <footer>
          <button type="button" onClick={onOpenBreakdowns}>
            View breakdowns in Settings{" "}
            <ArrowRight size={18} aria-hidden="true" />
          </button>
        </footer>
      ) : null}
    </div>
  );
}
