import { Fragment, useEffect, useRef, useState } from "react";
import { ArrowClockwise } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { CaretDown } from "@phosphor-icons/react/dist/csr/CaretDown";
import type {
  ProviderUsagePeriod,
  ProviderUsageQuery,
  ProviderUsageReport,
  ProviderUsageSource,
} from "@mivlet/protocol";
import {
  boundedUsageRead,
  readProviderUsage,
  refreshProviderUsagePrices,
} from "../../runtime/domains/provider-usage";
import { ProviderIcon } from "../ProviderIcon";
import { UsageChart } from "./UsageChart";
import { UsageModelDetail } from "./UsageModelDetail";
import { UsageSources } from "./UsageSources";
import "./usage-history.css";
import {
  compact,
  dollars,
  number,
  periods,
  providerName,
  sumUsage,
  tokenTotal,
  usageWindow,
} from "./usage-data";

export function UsageHistory({
  metric,
  initialProviderId,
}: {
  metric: "cost" | "tokens";
  initialProviderId: string;
}) {
  const [period, setPeriod] = useState<ProviderUsagePeriod>("30d");
  const [source, setSource] = useState<ProviderUsageSource>("mivlet");
  const [provider, setProvider] = useState(initialProviderId);
  const [data, setData] = useState<{
    report: ProviderUsageReport;
    query: ProviderUsageQuery;
  } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pricing, setPricing] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const force = useRef(false);
  const generation = useRef(0);
  const selection = useRef("");
  const reload = async () => {
    force.current = false;
    setRevision((value) => value + 1);
  };
  useEffect(() => {
    const request = ++generation.current;
    const query = usageWindow(period, source);
    const key = `${period}:${source}`;
    if (selection.current !== key) {
      setData(null);
      setSelected(null);
    }
    selection.current = key;
    setLoading(true);
    setPricing(false);
    setError("");
    const shouldForce = force.current;
    force.current = false;
    void (async () => {
      try {
        const report = await boundedUsageRead(readProviderUsage(query));
        if (request !== generation.current) return;
        setData(report ? { report, query } : null);
        setLoading(false);
        if (!report) return;
        setPricing(true);
        try {
          const status = await boundedUsageRead(
            refreshProviderUsagePrices(shouldForce),
          );
          if (request !== generation.current || !status) return;
          if (
            status.observedAt === report.pricing?.observedAt &&
            status.status === report.pricing?.status
          ) {
            setData({ report: { ...report, pricing: status }, query });
            return;
          }
          const next = await boundedUsageRead(readProviderUsage(query));
          if (request === generation.current && next)
            setData({ report: next, query });
        } catch {
          // Cached receipts and their explicit pricing status remain usable offline.
        } finally {
          if (request === generation.current) setPricing(false);
        }
      } catch (failure) {
        if (request === generation.current)
          setError(
            failure instanceof Error
              ? failure.message
              : "Saved usage could not be loaded. Try Refresh again.",
          );
      } finally {
        if (request === generation.current) setLoading(false);
      }
    })();
    return () => {
      generation.current++;
    };
  }, [period, source, revision]);

  const report = data?.report;
  const models =
    report?.models.filter((m) => !provider || m.providerId === provider) ?? [];
  const total = sumUsage(models);
  const providers = [
    ...new Set([
      ...(report?.models.map((m) => m.providerId) ?? []),
      ...(report?.allowances.map((a) => a.providerId) ?? []),
      ...(provider ? [provider] : []),
    ]),
  ];
  const cost = metric === "cost";
  const hasPriced = total.estimatedCount + total.reportedCount > 0;
  const cacheComplete =
    models.length > 0 &&
    models.every(
      (m) =>
        (m.cachedInputAttempts ??
          (m.cachedInputTokens === undefined ? 0 : m.attempts)) === m.attempts,
    );
  const buckets =
    report?.buckets?.filter((b) => !provider || b.providerId === provider) ??
    [];
  const rows = [...models].sort((a, b) =>
    cost
      ? b.estimatedCostUsd +
          b.reportedCostUsd -
          (a.estimatedCostUsd + a.reportedCostUsd) ||
        tokenTotal(b) - tokenTotal(a)
      : tokenTotal(b) - tokenTotal(a),
  );
  return (
    <div className="usage-history" aria-busy={loading}>
      <div className="usage-controls">
        <div className="usage-periods" role="group" aria-label="Usage period">
          {periods.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={period === item.id}
              onClick={() => setPeriod(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="usage-controls__filters">
          <label>
            <span className="sr-only">Usage source</span>
            <select
              value={source}
              onChange={(event) =>
                setSource(event.target.value as ProviderUsageSource)
              }
            >
              <option value="mivlet">Mivlet</option>
              <option value="imported">Imported history</option>
            </select>
          </label>
          <label>
            <span className="sr-only">Provider</span>
            <select
              value={provider}
              onChange={(event) => {
                setProvider(event.target.value);
                setSelected(null);
              }}
            >
              <option value="">All providers</option>
              {providers.map((id) => (
                <option key={id} value={id}>
                  {providerName(id)}
                </option>
              ))}
            </select>
          </label>
          <button
            className="usage-icon-button"
            type="button"
            aria-label="Refresh usage"
            disabled={loading || pricing}
            onClick={() => {
              force.current = true;
              setRevision((value) => value + 1);
            }}
          >
            <ArrowClockwise size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
      {loading && !report ? (
        <div className="usage-empty" role="status">
          <span className="usage-loading-line" />
          Loading saved usage…
        </div>
      ) : !report ? (
        <div
          className={error ? "usage-empty usage-error" : "usage-empty"}
          role={error ? "alert" : "status"}
        >
          {error ||
            "Usage history is available in the installed desktop app, after signing in."}
        </div>
      ) : (
        <>
          <dl className="usage-summary">
            <div className="usage-summary__primary">
              <dt>{cost ? "Estimated API equivalent" : "Total tokens"}</dt>
              <dd>
                {cost
                  ? total.estimatedCount
                    ? dollars(total.estimated)
                    : "Unavailable"
                  : number(total.tokens)}
              </dd>
              <small>
                {number(total.attempts)}{" "}
                {source === "mivlet"
                  ? total.attempts === 1
                    ? "run"
                    : "runs"
                  : total.attempts === 1
                    ? "imported request"
                    : "imported requests"}
              </small>
            </div>
            <div>
              <dt>{cost ? "Provider reported" : "Output tokens"}</dt>
              <dd>
                {cost
                  ? total.reportedCount
                    ? dollars(total.reported)
                    : "Unavailable"
                  : compact(total.output)}
              </dd>
              <small>
                {cost ? "Reported amounts only" : "Includes reasoning"}
              </small>
            </div>
            <div>
              <dt>{cost ? "Unpriced" : "Cache hit rate"}</dt>
              <dd>
                {cost
                  ? number(total.unpriced)
                  : cacheComplete && total.input > 0
                    ? `${Math.round((total.cached / total.input) * 100)}%`
                    : "Unavailable"}
              </dd>
              <small>
                {cost
                  ? "Excluded from cost totals"
                  : cacheComplete
                    ? `${compact(total.cached)} cached input tokens`
                    : "Cache categories are incomplete"}
              </small>
            </div>
          </dl>
          <p className="usage-caption">
            {cost
              ? "API estimates and provider amounts are separate. Subscription fees aren’t included."
              : "Input + cache writes + output. Reasoning stays within output."}
          </p>
          {total.attempts && (!cost || hasPriced) && buckets.length ? (
            <UsageChart
              buckets={buckets}
              query={data!.query}
              period={period}
              metric={metric}
            />
          ) : (
            <div className="usage-empty usage-empty--chart" role="status">
              {!total.attempts
                ? source === "imported"
                  ? "No imported measurements in this period. Import session files under Coverage and pricing."
                  : "No saved measurements in this period."
                : hasPriced
                  ? "Daily detail is unavailable for these measurements."
                  : "No priced measurements yet. Open a model to inspect or set its rates."}
            </div>
          )}
          <section className="usage-breakdown" aria-label="Model breakdown">
            <div className="usage-section-heading">
              <h3>Breakdown</h3>
              <span>
                {rows.length} {rows.length === 1 ? "model" : "models"}
                {!cost && total.savingsKnown
                  ? ` · ${dollars(total.cacheSavings)} priced cache savings`
                  : ""}
              </span>
            </div>
            {rows.length ? (
              <>
                <div
                  className="usage-model-row usage-model-row--head"
                  aria-hidden="true"
                >
                  <span>Model / provider</span>
                  <span>Tokens</span>
                  <span>{cost ? "API estimate" : "Cache read"}</span>
                  <span>{cost ? "Reported" : "Output"}</span>
                  <span />
                </div>
                {rows.map((model) => {
                  const key = `${model.providerId}:${model.model}`;
                  const open = selected === key;
                  return (
                    <Fragment key={key}>
                      <button
                        className="usage-model-row"
                        type="button"
                        aria-expanded={open}
                        onClick={() => setSelected(open ? null : key)}
                      >
                        <span className="usage-model-row__name">
                          <ProviderIcon provider={model.providerId} size={22} />
                          <span>
                            <strong>{model.model}</strong>
                            <small>
                              {providerName(model.providerId)} ·{" "}
                              {number(model.attempts)}{" "}
                              {source === "mivlet"
                                ? model.attempts === 1
                                  ? "run"
                                  : "runs"
                                : model.attempts === 1
                                  ? "request"
                                  : "requests"}
                            </small>
                          </span>
                        </span>
                        <span>
                          <span className="usage-model-row__mobile-label">
                            Tokens
                          </span>
                          {compact(tokenTotal(model))}
                        </span>
                        <span>
                          <span className="usage-model-row__mobile-label">
                            {cost ? "Estimate" : "Cache read"}
                          </span>
                          {cost ? (
                            model.estimatedCostAttempts ? (
                              dollars(model.estimatedCostUsd)
                            ) : model.unpricedAttempts ? (
                              <span className="usage-unpriced">Unpriced</span>
                            ) : (
                              "—"
                            )
                          ) : model.cachedInputTokens === undefined ? (
                            "—"
                          ) : (
                            compact(model.cachedInputTokens)
                          )}
                        </span>
                        <span>
                          <span className="usage-model-row__mobile-label">
                            {cost ? "Reported" : "Output"}
                          </span>
                          {cost
                            ? model.reportedCostAttempts
                              ? dollars(model.reportedCostUsd)
                              : "—"
                            : compact(model.outputTokens)}
                        </span>
                        <CaretDown
                          className="usage-model-row__caret"
                          size={14}
                          aria-hidden="true"
                        />
                      </button>
                      {open ? (
                        <UsageModelDetail
                          model={model}
                          report={report}
                          query={data!.query}
                          period={period}
                          metric={metric}
                          onSave={reload}
                        />
                      ) : null}
                    </Fragment>
                  );
                })}
              </>
            ) : (
              <p className="usage-caption">
                Models appear after measured activity is saved.
              </p>
            )}
          </section>
          <div className="usage-footnote">
            <span>
              {source === "mivlet"
                ? "Mivlet activity on this device"
                : "Explicitly imported activity"}{" "}
              ·{" "}
              {new Date(data!.query.since).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
              })}
              –
              {new Date(data!.query.until).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
              })}
            </span>
            <span role="status">{pricing ? "Updating prices…" : ""}</span>
          </div>
          <UsageSources report={report} onChange={reload} />
        </>
      )}
      {error && report ? (
        <p className="usage-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
