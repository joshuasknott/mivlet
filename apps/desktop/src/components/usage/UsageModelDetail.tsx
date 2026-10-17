import type {
  ProviderUsageModel,
  ProviderUsagePeriod,
  ProviderUsageQuery,
  ProviderUsageReport,
} from "@mivlet/protocol";
import { UsageChart } from "./UsageChart";
import { UsagePriceEditor } from "./UsagePriceEditor";
import { dollars, number, timestamp } from "./usage-data";

export function UsageModelDetail({
  model,
  report,
  query,
  period,
  metric,
  onSave,
}: {
  model: ProviderUsageModel;
  report: ProviderUsageReport;
  query: ProviderUsageQuery;
  period: ProviderUsagePeriod;
  metric: "cost" | "tokens";
  onSave: () => Promise<void>;
}) {
  const category = (value: number | undefined, count?: number) =>
    value === undefined
      ? "Unavailable"
      : `${number(value)}${count !== undefined && count < model.attempts ? ` · ${number(count)} of ${number(model.attempts)} receipts` : ""}`;
  return (
    <section
      className="usage-model-detail"
      aria-label={`${model.model} usage details`}
    >
      <dl className="usage-model-detail__categories">
        <div>
          <dt>Input, including cache reads</dt>
          <dd>{number(model.inputTokens)}</dd>
        </div>
        <div>
          <dt>Output, including reasoning</dt>
          <dd>{number(model.outputTokens)}</dd>
        </div>
        <div>
          <dt>Cache read</dt>
          <dd>
            {category(model.cachedInputTokens, model.cachedInputAttempts)}
          </dd>
        </div>
        <div>
          <dt>Cache write</dt>
          <dd>{category(model.cacheWriteTokens, model.cacheWriteAttempts)}</dd>
        </div>
        <div>
          <dt>Reasoning within output</dt>
          <dd>{category(model.reasoningTokens, model.reasoningAttempts)}</dd>
        </div>
        <div>
          <dt>API-equivalent estimate</dt>
          <dd>
            {model.estimatedCostAttempts
              ? dollars(model.estimatedCostUsd)
              : "Unavailable"}
          </dd>
        </div>
        <div>
          <dt>Provider-reported amount</dt>
          <dd>
            {model.reportedCostAttempts
              ? dollars(model.reportedCostUsd)
              : "Unavailable"}
          </dd>
        </div>
        <div>
          <dt>Estimated cache savings</dt>
          <dd>
            {model.cacheSavingsUsd === undefined
              ? "Unavailable"
              : dollars(model.cacheSavingsUsd)}
          </dd>
        </div>
      </dl>
      <p className="usage-model-detail__note">
        Missing categories are unknown. Cache writes add to the total; reasoning
        is already in output. Latest receipt:{" "}
        {timestamp(model.latestObservedAt)}.
      </p>
      {report.buckets?.length ? (
        <UsageChart
          buckets={report.buckets.filter(
            (b) => b.providerId === model.providerId && b.model === model.model,
          )}
          query={query}
          period={period}
          metric={metric}
          label="Model activity"
        />
      ) : null}
      <UsagePriceEditor model={model} report={report} onSave={onSave} />
    </section>
  );
}
