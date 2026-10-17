import { useMemo, useRef, useState } from "react";
import type {
  ProviderUsageBucket,
  ProviderUsagePeriod,
  ProviderUsageQuery,
} from "@mivlet/protocol";
import { compact, dollars, number, sumUsage } from "./usage-data";

export function UsageChart({
  buckets,
  query,
  period,
  metric,
  label = "Activity",
}: {
  buckets: ProviderUsageBucket[];
  query: ProviderUsageQuery;
  period: ProviderUsagePeriod;
  metric: "cost" | "tokens";
  label?: string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const cost = metric === "cost";
  const points = useMemo(() => {
    const grouped = new Map<string, ProviderUsageBucket[]>();
    for (const bucket of buckets) {
      const rows = grouped.get(bucket.startsAt) ?? [];
      rows.push(bucket);
      grouped.set(bucket.startsAt, rows);
    }
    return query.bucketStarts.map((startsAt) => {
      const total = sumUsage(grouped.get(startsAt) ?? []);
      return {
        startsAt,
        total,
        segments: cost
          ? [total.estimated, total.reported]
          : [
              Math.max(0, total.input - total.cached),
              total.cached,
              total.writes,
              total.output,
            ],
      };
    });
  }, [buckets, query, cost]);
  const max =
    Math.max(...points.map((p) => p.segments.reduce((a, b) => a + b, 0)), 0) ||
    1;
  const format = cost ? dollars : compact;
  const axisFormat = cost ? (value: number) => dollars(value, true) : compact;
  const dateLabel = (stamp: string, full = false) =>
    new Date(stamp).toLocaleString(
      undefined,
      period === "24h"
        ? {
            month: full ? "short" : undefined,
            day: full ? "numeric" : undefined,
            hour: "numeric",
          }
        : { month: "short", day: "numeric" },
    );
  const activeIndex =
    active === null ? null : Math.min(active, points.length - 1);
  const selected = activeIndex === null ? null : points[activeIndex];
  const selectionKnown =
    selected &&
    (cost
      ? selected.total.estimatedCount + selected.total.reportedCount > 0
      : selected.total.attempts > 0);
  const readout =
    selected &&
    (selectionKnown
      ? `${format(selected.segments.reduce((a, b) => a + b, 0))}${cost ? (selected.total.unpriced ? " · partial cost" : "") : " tokens"}`
      : cost && selected.total.unpriced
        ? "Cost unavailable"
        : "No measurements");
  const labels = cost
    ? ["API estimate", "Provider reported"]
    : ["Input", "Cache read", "Cache write", "Output"];
  return (
    <figure
      className="usage-chart"
      aria-label={`${label} by ${period === "24h" ? "hour" : "day"}`}
    >
      <figcaption>
        <span>{label}</span>
        <span className="usage-chart__readout" aria-live="polite">
          {selected
            ? `${dateLabel(selected.startsAt, true)} · ${readout}`
            : period === "24h"
              ? "Hourly · local time"
              : "Daily · local time"}
        </span>
      </figcaption>
      <div className="usage-chart__plot">
        <div className="usage-chart__scale" aria-hidden="true">
          <span>{axisFormat(max)}</span>
          <span>{axisFormat(max / 2)}</span>
          <span>{cost ? "$0" : "0"}</span>
        </div>
        <div
          className="usage-chart__bars"
          style={{
            gridTemplateColumns: `repeat(${points.length}, minmax(0, 1fr))`,
          }}
        >
          {points.map((point, index) => {
            const value = point.segments.reduce((a, b) => a + b, 0);
            const known = cost
              ? point.total.estimatedCount + point.total.reportedCount > 0
              : point.total.attempts > 0;
            return (
              <button
                type="button"
                key={point.startsAt}
                ref={(node) => {
                  buttons.current[index] = node;
                }}
                className="usage-chart__bar"
                data-active={index === activeIndex}
                tabIndex={index === (activeIndex ?? points.length - 1) ? 0 : -1}
                aria-label={`${dateLabel(point.startsAt, true)}: ${known ? (cost ? dollars(value) : `${number(value)} tokens`) : cost && point.total.unpriced ? "Cost unavailable" : "No measurements"}${point.total.unpriced ? `; ${number(point.total.unpriced)} unpriced` : ""}`}
                onFocus={() => setActive(index)}
                onMouseEnter={() => setActive(index)}
                onClick={() => setActive(index)}
                onKeyDown={(event) => {
                  const next =
                    event.key === "ArrowRight"
                      ? Math.min(points.length - 1, index + 1)
                      : event.key === "ArrowLeft"
                        ? Math.max(0, index - 1)
                        : event.key === "Home"
                          ? 0
                          : event.key === "End"
                            ? points.length - 1
                            : null;
                  if (next !== null) {
                    event.preventDefault();
                    setActive(next);
                    buttons.current[next]?.focus();
                  }
                }}
              >
                <span
                  className="usage-chart__stack"
                  style={{
                    height: `${Math.max(known ? 1 : 0, (value / max) * 100)}%`,
                  }}
                >
                  {point.segments.map((amount, category) => (
                    <span
                      key={category}
                      data-series={cost ? category + 4 : category}
                      style={{
                        height: `${value ? (amount / value) * 100 : category === 0 ? 100 : 0}%`,
                      }}
                    />
                  ))}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="usage-chart__dates" aria-hidden="true">
        {[0, Math.floor((points.length - 1) / 2), points.length - 1].map(
          (i) => (
            <span key={i}>{dateLabel(points[i].startsAt)}</span>
          ),
        )}
      </div>
      <div className="usage-legend">
        {labels.map((name, i) => (
          <span key={name}>
            <i data-series={cost ? i + 4 : i} />
            {name}
          </span>
        ))}
      </div>
    </figure>
  );
}
