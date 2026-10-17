import { useEffect, useRef, useState } from "react";
import { ArrowClockwise } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { ArrowRight } from "@phosphor-icons/react/dist/csr/ArrowRight";
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
  boundedUsageRead,
  allowanceNeedsRefresh,
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

function measurementTime(value: string | undefined) {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toLocaleString()
    : "Not collected";
}

/** Provider-reported allowance, independent of local cost and token history. */
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
  const [phase, setPhase] = useState<"loading" | "ready" | "refreshing">(
    "loading",
  );
  const loading = phase === "loading";
  const pending = phase === "refreshing";
  const [error, setError] = useState("");
  const [checking, setChecking] = useState<string[]>([]);
  const [now, setNow] = useState(Date.now);
  const generation = useRef(0);
  // Model discovery and shell polling can replace these arrays without changing
  // the connections. Such renders must not restart or starve an in-flight read.
  const connectionKey = JSON.stringify([
    providers?.map(({ id, authState, setup }) => [id, authState, setup?.kind]),
    connectedProviderIds,
  ]);
  const subscriptions = connectedSubscriptions(
    providers ?? inventory,
    connectedProviderIds,
  );
  const load = async (refresh = false) => {
    if (refresh && phase !== "ready") return;
    const request = ++generation.current;
    if (!refresh) setReports({});
    setChecking([]);
    setPhase(refresh ? "refreshing" : "loading");
    setError("");
    try {
      const available =
        providers ?? (await boundedUsageRead(listRuntimeBackends()));
      if (request !== generation.current) return;
      if (!available) throw new Error("Provider metadata unavailable");
      setInventory(available);
      await Promise.all(
        connectedSubscriptions(available, connectedProviderIds).map(
          async (provider) => {
            let report: ProviderAllowance | null = null;
            let failed = false;
            try {
              report = await boundedUsageRead(
                (refresh ? refreshProviderAllowance : readProviderAllowance)(
                  provider.id,
                ),
              );
              if (request !== generation.current) return;
              setReports((current) => ({ ...current, [provider.id]: report }));
              // Cached first, including stale data. Failed checks also have a five-minute cooldown.
              if (!refresh && allowanceNeedsRefresh(report)) {
                setChecking((ids) => [...ids, provider.id]);
                report = await boundedUsageRead(
                  refreshProviderAllowance(provider.id),
                );
              }
            } catch {
              failed = true;
            }
            if (request !== generation.current) return;
            setChecking((ids) => ids.filter((id) => id !== provider.id));
            setNow(Date.now());
            if (failed)
              setError(
                refresh
                  ? "Some allowances could not be refreshed. Last measurements remain visible. Try Refresh again."
                  : "Some allowances could not be loaded. Try Refresh again.",
              );
            setReports((current) => ({
              ...current,
              [provider.id]:
                failed && current[provider.id]
                  ? {
                      ...current[provider.id]!,
                      status: "stale",
                      resetOpportunity: undefined,
                    }
                  : report,
            }));
          },
        ),
      );
    } catch {
      if (request === generation.current) {
        setInventory([]);
        setReports({});
        setError("Connected subscriptions could not be loaded.");
      }
    } finally {
      if (request === generation.current) {
        setNow(Date.now());
        setPhase("ready");
      }
    }
  };
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      generation.current++;
      window.clearInterval(timer);
    };
  }, [connectionKey]);
  return (
    <div className="subscription-usage">
      <header>
        <p>Provider-reported subscription limits</p>
        <button
          className="subscription-usage__refresh"
          type="button"
          disabled={loading || pending || (!subscriptions.length && !error)}
          onClick={() => void load(true)}
        >
          <ArrowClockwise size={16} aria-hidden="true" />
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
              <ProviderIcon provider={provider.id} size={26} />
              <div>
                <h3>{provider.label}</h3>
                <p>
                  {checking.includes(provider.id)
                    ? "Updating…"
                    : report?.status === "stale"
                      ? "Measurement stale"
                      : report?.observedAt
                        ? `Checked ${new Date(report.observedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`
                        : "Connected"}
                </p>
              </div>
            </header>
            <div className="subscription-usage__windows">
              {report?.status === "available" || report?.status === "stale"
                ? windows.map((window) => {
                    const label = windowLabel(window, provider.id);
                    return (
                      <div
                        className="subscription-usage__window"
                        key={window.id}
                      >
                        <div>
                          <span>{label}</span>
                          <strong>
                            {window.usedPercent.toLocaleString()}% used
                            {report.status === "stale"
                              ? " · last measured"
                              : ""}
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
            </div>
            {report?.reason ? (
              <p className="subscription-usage__note">{report.reason}</p>
            ) : null}
            {report ? (
              <details className="subscription-usage__measurement">
                <summary>Measurement details</summary>
                <dl>
                  <div>
                    <dt>Account scope</dt>
                    <dd>
                      {report.identityKind === "reported-account"
                        ? "Provider-reported account"
                        : "This managed connection; provider account identity unavailable"}
                    </dd>
                  </div>
                  <div>
                    <dt>Measured</dt>
                    <dd>{measurementTime(report.observedAt)}</dd>
                  </div>
                  <div>
                    <dt>Last checked</dt>
                    <dd>{measurementTime(report.checkedAt)}</dd>
                  </div>
                </dl>
              </details>
            ) : null}
          </section>
        );
      })}
      {error ? <p role="alert">{error}</p> : null}
      {onOpenBreakdowns ? (
        <footer>
          <button type="button" onClick={onOpenBreakdowns}>
            View usage history <ArrowRight size={18} aria-hidden="true" />
          </button>
        </footer>
      ) : null}
    </div>
  );
}
