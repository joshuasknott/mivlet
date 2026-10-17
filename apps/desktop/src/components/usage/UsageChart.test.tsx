import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import type { ProviderUsageBucket, ProviderUsageQuery } from "@mivlet/protocol";
import { UsageChart } from "./UsageChart";

it("keeps an unpriced bucket distinct from a measured zero through mouse and keyboard inspection", async () => {
  const query: ProviderUsageQuery = {
    since: "2026-10-16T00:00:00.000Z",
    until: "2026-10-18T00:00:00.000Z",
    source: "mivlet",
    bucketStarts: ["2026-10-16T00:00:00.000Z", "2026-10-17T00:00:00.000Z"],
  };
  const measured: ProviderUsageBucket = {
    startsAt: query.since,
    providerId: "openrouter",
    model: "free",
    attempts: 1,
    inputTokens: 100,
    outputTokens: 20,
    reportedCostUsd: 0,
    reportedCostAttempts: 1,
    estimatedCostUsd: 0,
    estimatedCostAttempts: 0,
    unpricedAttempts: 0,
    latestObservedAt: query.since,
  };
  const user = userEvent.setup();
  render(
    <UsageChart
      buckets={[
        measured,
        {
          ...measured,
          startsAt: query.bucketStarts[1],
          reportedCostAttempts: 0,
          unpricedAttempts: 1,
        },
      ]}
      query={query}
      period="7d"
      metric="cost"
    />,
  );
  const unknown = screen.getByRole("button", {
    name: /Cost unavailable; 1 unpriced/,
  });
  await user.click(unknown);
  expect(screen.getByText(/· Cost unavailable$/)).toBeVisible();
  await user.keyboard("{ArrowLeft}");
  expect(screen.getByRole("button", { name: /0\.00$/ })).toHaveFocus();
  expect(screen.getByText(/· .*0\.00$/)).toBeVisible();
});
