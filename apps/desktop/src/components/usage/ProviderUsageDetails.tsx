import { useEffect, useState } from "react";
import type {
  ProviderAllowance,
  ProviderUsageModel,
  ProviderUsageReport,
} from "@mivlet/protocol";
import {
  allowanceLabel,
  currentAllowance,
  readProviderUsage,
  refreshProviderAllowance,
  saveProviderUsagePrice,
} from "../../runtime/domains/provider-usage";
import "./provider-usage.css";

const dollars = (value: number) =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
  }).format(value);
const tokens = (value: number | undefined) =>
  value === undefined ? "Unavailable" : value.toLocaleString();
const stamp = (value: string | undefined) =>
  value ? new Date(value).toLocaleString() : "Not measured";
const unavailable = "Unavailable";

export function ProviderUsageDetails({
  initialProviderId = "",
}: {
  initialProviderId?: string;
}) {
  const [report, setReport] = useState<ProviderUsageReport | null>(null);
  const [provider, setProvider] = useState(initialProviderId);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string[]>([]);
  const [selected, setSelected] = useState<ProviderUsageModel | null>(null);
  const reload = async () => {
    const result = await readProviderUsage();
    setReport(result);
    return result;
  };
  useEffect(() => {
    let current = true;
    void readProviderUsage()
      .then((result) => {
        if (current) setReport(result);
      })
      .catch((failure) => {
        if (current) setError(String(failure));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, []);
  const refresh = async (id: string) => {
    setPending((ids) => [...ids, id]);
    setError("");
    try {
      const value = await refreshProviderAllowance(id);
      if (value)
        setReport((current) =>
          current
            ? {
                ...current,
                allowances: current.allowances.map((a) =>
                  a.providerId === id ? value : a,
                ),
              }
            : current,
        );
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Provider measurements could not be refreshed.",
      );
    } finally {
      setPending((ids) => ids.filter((value) => value !== id));
    }
  };
  const providers = [
    ...new Set([
      ...(report?.allowances.map((a) => a.providerId) ?? []),
      ...(report?.models.map((m) => m.providerId) ?? []),
    ]),
  ];
  const models =
    report?.models.filter((m) => !provider || m.providerId === provider) ?? [];
  const total = models.reduce(
    (sum, model) => ({
      input: sum.input + model.inputTokens,
      output: sum.output + model.outputTokens,
      reported: sum.reported + model.reportedCostUsd,
      estimated: sum.estimated + model.estimatedCostUsd,
      unpriced: sum.unpriced + model.unpricedAttempts,
      reportedCount: sum.reportedCount + model.reportedCostAttempts,
      estimatedCount: sum.estimatedCount + model.estimatedCostAttempts,
    }),
    {
      input: 0,
      output: 0,
      reported: 0,
      estimated: 0,
      unpriced: 0,
      reportedCount: 0,
      estimatedCount: 0,
    },
  );
  return (
    <div className="provider-usage-details">
      <p className="provider-usage-intro">
        Saved Mivlet usage over the last 30 days. Provider allowance is measured
        separately. These amounts are not your subscription bill or all activity
        on your provider account.
      </p>
      {loading ? (
        <p role="status">Loading saved usage…</p>
      ) : !report ? (
        <p role="status">
          Usage requires the installed desktop app and a signed-in Mivlet
          account.
        </p>
      ) : (
        <>
          <label className="provider-usage-filter">
            Provider{" "}
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
                  {id}
                </option>
              ))}
            </select>
          </label>
          <dl className="provider-usage-totals">
            <div>
              <dt>Input tokens</dt>
              <dd>{tokens(total.input)}</dd>
            </div>
            <div>
              <dt>Output tokens</dt>
              <dd>{tokens(total.output)}</dd>
            </div>
            <div>
              <dt>Provider-reported amount</dt>
              <dd>
                {total.reportedCount ? dollars(total.reported) : unavailable}
              </dd>
            </div>
            <div>
              <dt>API-equivalent estimates</dt>
              <dd>
                {total.estimatedCount ? dollars(total.estimated) : unavailable}
              </dd>
            </div>
          </dl>
          {total.unpriced > 0 ? (
            <p>
              {total.unpriced} saved attempts have no trusted price. They are
              excluded from cost totals.
            </p>
          ) : null}
          <section aria-label="Subscription allowance">
            <h3>Provider allowance</h3>
            {report.allowances
              .filter((a) => !provider || a.providerId === provider)
              .map((a) => (
                <Allowance
                  key={a.providerId}
                  report={a}
                  pending={pending.includes(a.providerId)}
                  onRefresh={() => void refresh(a.providerId)}
                />
              ))}
            {!report.allowances.length ? (
              <p>
                Connect a provider to collect supported allowance measurements.
              </p>
            ) : null}
          </section>
          <section aria-label="Model breakdown">
            <h3>Model breakdown</h3>
            {models.length ? (
              <div className="provider-usage-models">
                {models.map((model) => (
                  <button
                    key={`${model.providerId}:${model.model}`}
                    type="button"
                    onClick={() => setSelected(model)}
                  >
                    <span>
                      <strong>{model.model}</strong>
                      <small>
                        {model.providerId} · {model.attempts} attempts
                      </small>
                    </span>
                    <span>
                      {tokens(model.inputTokens + model.outputTokens)} tokens
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <p>No saved token measurements for this selection.</p>
            )}
          </section>
          {selected ? (
            <section
              className="provider-usage-model-detail"
              aria-label={`${selected.model} usage details`}
            >
              <h3>{selected.model}</h3>
              <dl>
                <dt>Cached input, reported portions</dt>
                <dd>{tokens(selected.cachedInputTokens)}</dd>
                <dt>Cache writes, reported portions</dt>
                <dd>{tokens(selected.cacheWriteTokens)}</dd>
                <dt>Reasoning, included in output</dt>
                <dd>{tokens(selected.reasoningTokens)}</dd>
                <dt>Provider-reported amount</dt>
                <dd>
                  {selected.reportedCostAttempts
                    ? dollars(selected.reportedCostUsd)
                    : unavailable}
                </dd>
                <dt>API-equivalent estimate</dt>
                <dd>
                  {selected.estimatedCostAttempts
                    ? dollars(selected.estimatedCostUsd)
                    : unavailable}
                </dd>
                <dt>Latest receipt</dt>
                <dd>{stamp(selected.latestObservedAt)}</dd>
              </dl>
              <p>
                Missing token categories remain unavailable. Totals count each
                canonical attempt once, including partial failed or interrupted
                attempts.
              </p>
              <PriceEditor
                key={`${selected.providerId}:${selected.model}`}
                model={selected}
                report={report}
                onSave={async () => {
                  const next = await reload();
                  setSelected((current) =>
                    current?.providerId === selected.providerId &&
                    current.model === selected.model
                      ? (next?.models.find(
                          (m) =>
                            m.providerId === selected.providerId &&
                            m.model === selected.model,
                        ) ?? null)
                      : current,
                  );
                }}
              />
            </section>
          ) : null}
        </>
      )}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
function Allowance({
  report,
  pending,
  onRefresh,
}: {
  report: ProviderAllowance;
  pending: boolean;
  onRefresh: () => void;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const current = currentAllowance(report, now)!;
  return (
    <article className="provider-usage-allowance" data-status={current.status}>
      <header>
        <strong>{report.providerId}</strong>
        <button type="button" disabled={pending} onClick={onRefresh}>
          {pending ? "Checking…" : "Refresh allowance"}
        </button>
      </header>
      <p>{allowanceLabel(current)}</p>
      {report.windows.map((window) => (
        <div className="provider-usage-window" key={window.id}>
          <span>
            {window.label}
            {window.windowDurationMins
              ? ` · ${window.windowDurationMins} min window`
              : ""}
          </span>
          <progress
            max={100}
            value={window.usedPercent}
            aria-label={`${window.label}: ${window.usedPercent}% used`}
          />
          <small>
            {window.usedPercent}% used · Reset: {stamp(window.resetsAt)}
          </small>
        </div>
      ))}
      <small>
        Observed: {stamp(report.observedAt)} · Checked:{" "}
        {stamp(report.checkedAt)} ·{" "}
        {report.identityKind === "reported-account"
          ? "Provider account identified"
          : "This managed connection; account identity unavailable"}
      </small>
      {current.reason ? <p>{current.reason}</p> : null}
    </article>
  );
}
function PriceEditor({
  model,
  report,
  onSave,
}: {
  model: ProviderUsageModel;
  report: ProviderUsageReport;
  onSave: () => Promise<void>;
}) {
  const price = report.prices.find(
    (p) => p.providerId === model.providerId && p.model === model.model,
  );
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  return (
    <details key={`${model.providerId}:${model.model}`}>
      <summary>Exact-model estimate rates</summary>
      <p>
        Enter rates from the provider’s published pricing. Estimates apply to
        this model only. Cache categories require their own rates.
      </p>
      {price ? (
        <p>
          Source: <span>{price.source}</span> · Observed{" "}
          {stamp(price.observedAt)}
        </p>
      ) : null}
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (pending) return;
          setPending(true);
          setError("");
          const values = new FormData(event.currentTarget);
          const optional = (name: string) =>
            values.get(name) === "" ? undefined : Number(values.get(name));
          try {
            await saveProviderUsagePrice({
              providerId: model.providerId,
              model: model.model,
              inputPerMillionUsd: Number(values.get("input")),
              outputPerMillionUsd: Number(values.get("output")),
              cachedInputPerMillionUsd: optional("cached"),
              cacheWritePerMillionUsd: optional("write"),
              source: String(values.get("source")),
              observedAt: new Date().toISOString(),
            });
            await onSave();
          } catch (failure) {
            setError(
              failure instanceof Error
                ? failure.message
                : "Rates could not be saved.",
            );
          } finally {
            setPending(false);
          }
        }}
      >
        <div className="provider-usage-price-fields">
          {[
            ["input", "Input", price?.inputPerMillionUsd],
            ["output", "Output", price?.outputPerMillionUsd],
            ["cached", "Cached input", price?.cachedInputPerMillionUsd],
            ["write", "Cache write", price?.cacheWritePerMillionUsd],
          ].map(([name, label, value]) => (
            <label key={String(name)}>
              {label} USD / 1M
              <input
                type="number"
                name={String(name)}
                min={0}
                max={10000}
                step="any"
                required={name === "input" || name === "output"}
                defaultValue={value ?? ""}
              />
            </label>
          ))}
        </div>
        <label>
          Pricing source
          <input
            type="url"
            name="source"
            required
            defaultValue={price?.source ?? ""}
            placeholder="https://"
          />
        </label>
        <button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save estimate rates"}
        </button>
        {error ? <p role="alert">{error}</p> : null}
      </form>
    </details>
  );
}
