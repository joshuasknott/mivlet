import "@testing-library/jest-dom/vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderAllowance, ProviderUsageReport } from "@mivlet/protocol";
import { ProviderUsageDetails } from "../pages/SettingsPage";
import { ModelPicker } from "../ModelPicker";
import {
  clearActiveRuntimeDataScope,
  setActiveRuntimeDataScope,
} from "../../runtime-scope";
import {
  currentAllowance,
  readProviderUsage,
  readProviderAllowance,
  refreshProviderUsagePrices,
  saveProviderUsagePrice,
  resetProviderUsagePrice,
} from "../../runtime/domains/provider-usage";

vi.mock("../../runtime/domains/provider-usage", async (original) => ({
  ...(await original<typeof import("../../runtime/domains/provider-usage")>()),
  readProviderUsage: vi.fn(),
  readProviderAllowance: vi.fn(),
  refreshProviderUsagePrices: vi.fn(),
  saveProviderUsagePrice: vi.fn(),
  resetProviderUsagePrice: vi.fn(),
}));
const at = new Date().toISOString();
const allowance = (): ProviderAllowance => ({
  providerId: "codex",
  identity: "opaque",
  identityKind: "managed-connection",
  status: "available",
  checkedAt: at,
  observedAt: at,
  windows: [
    {
      id: "five-hour",
      label: "Five hour",
      usedPercent: 80,
      windowDurationMins: 300,
    },
  ],
});
const report: ProviderUsageReport = {
  checkedAt: at,
  since: at,
  coverage: "saved-mivlet-attempts",
  prices: [],
  allowances: [],
  models: [
    {
      providerId: "openai",
      model: "unknown-model",
      attempts: 1,
      inputTokens: 140,
      outputTokens: 20,
      cachedInputTokens: 40,
      cacheWriteTokens: 10,
      reasoningTokens: 5,
      cachedInputAttempts: 1,
      reportedCostUsd: 0,
      reportedCostAttempts: 0,
      estimatedCostUsd: 0,
      estimatedCostAttempts: 0,
      unpricedAttempts: 1,
      latestObservedAt: at,
    },
    {
      providerId: "openrouter",
      model: "free-model",
      attempts: 1,
      inputTokens: 20,
      outputTokens: 10,
      cachedInputTokens: 0,
      reportedCostUsd: 0,
      reportedCostAttempts: 1,
      estimatedCostUsd: 0,
      estimatedCostAttempts: 0,
      unpricedAttempts: 0,
      latestObservedAt: at,
    },
  ],
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(readProviderUsage).mockResolvedValue(report);
  vi.mocked(refreshProviderUsagePrices).mockResolvedValue(null);
});

describe("usage dashboard", () => {
  it("hides cached private usage after the owner changes", async () => {
    setActiveRuntimeDataScope("first", "account-a");
    const view = render(<ProviderUsageDetails />);
    try {
      await screen.findByRole("button", { name: /unknown-model/ });
      setActiveRuntimeDataScope("second", "account-b");
      view.rerender(<ProviderUsageDetails />);
      expect(screen.getByRole("status")).toHaveTextContent(
        "account or workspace changed",
      );
      expect(
        screen.queryByRole("button", { name: /unknown-model/ }),
      ).not.toBeInTheDocument();
    } finally {
      view.unmount();
      clearActiveRuntimeDataScope();
    }
  });
  it("shows one retryable error without inventing a desktop prerequisite", async () => {
    vi.mocked(readProviderUsage).mockRejectedValue(
      new Error("History temporarily unavailable"),
    );
    render(<ProviderUsageDetails />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "History temporarily unavailable",
    );
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.queryByText(/installed desktop app/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh usage" })).toBeEnabled();
  });
  it("keeps usage and all background collection out of the model control", () => {
    render(
      <ModelPicker
        models={[
          {
            id: "codex::model",
            providerId: "codex",
            providerLabel: "ChatGPT",
            modelId: "model",
            label: "Model",
            available: true,
          },
        ]}
        selectedId="codex::model"
        label="Model"
        onSelect={vi.fn()}
        open={false}
        onOpenChange={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /usage/i }),
    ).not.toBeInTheDocument();
    expect(readProviderUsage).not.toHaveBeenCalled();
    expect(readProviderAllowance).not.toHaveBeenCalled();
    expect(refreshProviderUsagePrices).not.toHaveBeenCalled();
  });
  it("keeps unknown costs distinct from a provider-reported zero", async () => {
    const user = userEvent.setup();
    render(<ProviderUsageDetails />);
    await screen.findByRole("button", { name: /unknown-model/ });
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Provider" }),
      "openai",
    );
    expect(
      screen.queryByRole("button", { name: /free-model/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/\$0/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /unknown-model/ }));
    expect(
      within(
        screen.getByRole("region", { name: "unknown-model usage details" }),
      ).getAllByText("Unavailable"),
    ).toHaveLength(3);
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Provider" }),
      "openrouter",
    );
    expect(
      screen.queryByRole("region", { name: "unknown-model usage details" }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByText(/\$0\.00$/).length).toBeGreaterThan(0);
  });
  it("includes cache writes in every token total without adding reasoning twice", async () => {
    const user = userEvent.setup();
    render(<ProviderUsageDetails initialProviderId="openai" />);
    await screen.findByRole("button", { name: /unknown-model/ });
    await user.click(screen.getByRole("tab", { name: "Tokens" }));
    expect(
      within(screen.getByText("Total tokens").closest("div")!).getByText("170"),
    ).toBeVisible();
    const row = screen.getByRole("button", { name: /unknown-model/ });
    expect(within(row).getByText("170")).toBeVisible();
    expect(
      within(screen.getByText("Cache hit rate").closest("div")!).getByText(
        "29%",
      ),
    ).toBeVisible();
    await user.click(row);
    const detail = screen.getByRole("region", {
      name: "unknown-model usage details",
    });
    expect(within(detail).getByText("10")).toBeVisible();
    expect(within(detail).getByText("5")).toBeVisible();
  });
  it("sends explicit bounded periods and keeps imported activity separate", async () => {
    const user = userEvent.setup();
    render(<ProviderUsageDetails />);
    await screen.findByRole("button", { name: /unknown-model/ });
    await user.click(screen.getByRole("button", { name: "90 days" }));
    await waitFor(() => expect(readProviderUsage).toHaveBeenCalledTimes(2));
    const query = vi.mocked(readProviderUsage).mock.calls[1][0]!;
    expect(query.bucketStarts).toHaveLength(90);
    expect(query.source).toBe("mivlet");
    expect(
      Date.parse(query.until) - Date.parse(query.since),
    ).toBeLessThanOrEqual(91 * 86400_000);
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Usage source" }),
      "imported",
    );
    await waitFor(() => expect(readProviderUsage).toHaveBeenCalledTimes(3));
    expect(vi.mocked(readProviderUsage).mock.lastCall?.[0]?.source).toBe(
      "imported",
    );
  });
  it("ignores an old period reply after a new selection resolves", async () => {
    let complete!: (value: ProviderUsageReport) => void;
    vi.mocked(readProviderUsage)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      )
      .mockResolvedValueOnce({ ...report, models: [report.models[1]] });
    const user = userEvent.setup();
    render(<ProviderUsageDetails />);
    await user.click(screen.getByRole("button", { name: "7 days" }));
    expect(
      await screen.findByRole("button", { name: /free-model/ }),
    ).toBeVisible();
    await act(async () => complete(report));
    expect(
      screen.queryByRole("button", { name: /unknown-model/ }),
    ).not.toBeInTheDocument();
  });
  it("retains warm receipts after a failed refresh and provides retry", async () => {
    const user = userEvent.setup();
    render(<ProviderUsageDetails />);
    await screen.findByRole("button", { name: /unknown-model/ });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Refresh usage" }),
      ).toBeEnabled(),
    );
    vi.mocked(readProviderUsage).mockRejectedValueOnce(
      new Error("History unavailable. Try Refresh again."),
    );
    await user.click(screen.getByRole("button", { name: "Refresh usage" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "History unavailable",
    );
    expect(screen.getByRole("button", { name: /unknown-model/ })).toBeVisible();
    expect(screen.getByRole("button", { name: "Refresh usage" })).toBeEnabled();
  });
  it("renders history before the independent price update and applies the updated catalogue", async () => {
    let complete!: (
      value: Awaited<ReturnType<typeof refreshProviderUsagePrices>>,
    ) => void;
    vi.mocked(refreshProviderUsagePrices).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const user = userEvent.setup();
    render(<ProviderUsageDetails />);
    expect(
      await screen.findByRole("button", { name: /unknown-model/ }),
    ).toBeVisible();
    expect(screen.getByText("Updating prices…")).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "Tokens" }));
    expect(screen.getByText("Total tokens")).toBeVisible();
    vi.mocked(readProviderUsage).mockResolvedValue({
      ...report,
      models: [
        {
          ...report.models[0],
          estimatedCostAttempts: 1,
          estimatedCostUsd: 1.23,
          unpricedAttempts: 0,
        },
      ],
    });
    await act(async () =>
      complete({
        status: "available",
        source: "https://example.test/prices",
        observedAt: at,
      }),
    );
    await user.click(screen.getByRole("tab", { name: "Cost" }));
    expect(await screen.findAllByText(/\$1\.23$/)).toHaveLength(2);
  });
  it("saves exact-model overrides with cache rates and a source observation, and can reset them", async () => {
    const user = userEvent.setup();
    render(<ProviderUsageDetails initialProviderId="openai" />);
    await user.click(
      await screen.findByRole("button", { name: /unknown-model/ }),
    );
    await user.click(screen.getByText("Set an exact-model price"));
    await user.type(screen.getByLabelText("Input · USD / 1M"), "2");
    await user.type(screen.getByLabelText("Output · USD / 1M"), "8");
    await user.type(screen.getByLabelText("Cache read · USD / 1M"), "0.5");
    await user.type(screen.getByLabelText("Cache write · USD / 1M"), "3");
    await user.type(
      screen.getByLabelText("HTTPS pricing source"),
      "https://example.test/pricing",
    );
    fireEvent.change(screen.getByLabelText("Observation date"), {
      target: { value: "2026-10-01" },
    });
    await user.click(screen.getByRole("button", { name: "Save override" }));
    expect(saveProviderUsagePrice).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "openai",
        model: "unknown-model",
        inputPerMillionUsd: 2,
        outputPerMillionUsd: 8,
        cachedInputPerMillionUsd: 0.5,
        cacheWritePerMillionUsd: 3,
        observedAt: "2026-10-01T00:00:00.000Z",
        source: "https://example.test/pricing",
      }),
    );
    vi.mocked(readProviderUsage).mockResolvedValue({
      ...report,
      prices: [
        {
          providerId: "openai",
          model: "unknown-model",
          inputPerMillionUsd: 2,
          outputPerMillionUsd: 8,
          source: "https://example.test/pricing",
          observedAt: at,
          origin: "override",
        },
      ],
    });
    await user.click(screen.getByRole("button", { name: "Refresh usage" }));
    await user.click(
      await screen.findByRole("button", { name: "Reset to automatic" }),
    );
    expect(resetProviderUsagePrice).toHaveBeenCalledWith(
      "openai",
      "unknown-model",
    );
  });
  it("supports arrow-key tab navigation and fails closed in the browser preview", async () => {
    vi.mocked(readProviderUsage).mockResolvedValue(null);
    const user = userEvent.setup();
    render(<ProviderUsageDetails />);
    expect(
      await screen.findByText(
        /Usage history is available in the installed desktop app/,
      ),
    ).toBeVisible();
    screen.getByRole("tab", { name: "Cost" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Tokens" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Tokens" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });
  it("expires measurements without guessing a reset opportunity", () => {
    const measurement = allowance();
    const observed = Date.parse(at);
    expect(currentAllowance(measurement, observed)?.status).toBe("available");
    expect(currentAllowance(measurement, observed + 300001)?.status).toBe(
      "stale",
    );
    expect(currentAllowance(measurement, observed - 1)?.status).toBe("stale");
    expect(measurement.windows[0].resetsAt).toBeUndefined();
  });
});
