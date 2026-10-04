import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { NativeExecutionSetup } from "./NativeExecutionSetup";
import {
  inspectNativeExecution,
  setupNativeExecution,
} from "../../runtime/domains/coding";
vi.mock("../../runtime/domains/coding", () => ({
  inspectNativeExecution: vi.fn(),
  setupNativeExecution: vi.fn(),
}));
beforeEach(() => vi.resetAllMocks());
function show() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <NativeExecutionSetup />
    </QueryClientProvider>,
  );
}
it("shows an explicit setup action and reinspects after repair", async () => {
  vi.mocked(inspectNativeExecution)
    .mockResolvedValueOnce({ available: false, message: "Setup required" })
    .mockResolvedValue({ available: true, message: null });
  vi.mocked(setupNativeExecution).mockResolvedValue(undefined);
  show();
  fireEvent.click(
    await screen.findByRole("button", { name: "Set up native execution" }),
  );
  await waitFor(() =>
    expect(setupNativeExecution).toHaveBeenCalledWith(false, expect.anything()),
  );
  expect(await screen.findByText(/Coding and analysis · ready/)).toBeVisible();
});
it("keeps denied setup unavailable and explains the failure", async () => {
  vi.mocked(inspectNativeExecution).mockResolvedValue({
    available: false,
    message: "Setup required",
  });
  vi.mocked(setupNativeExecution).mockRejectedValue(
    new Error("Administrator approval was declined"),
  );
  show();
  fireEvent.click(
    await screen.findByRole("button", { name: "Set up native execution" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Administrator approval was declined",
  );
  expect(screen.queryByText(/· ready/)).not.toBeInTheDocument();
});
it("does not advertise native setup in a browser", async () => {
  vi.mocked(inspectNativeExecution).mockResolvedValue(null);
  const view = show();
  await waitFor(() => expect(inspectNativeExecution).toHaveBeenCalled());
  expect(view.container).toBeEmptyDOMElement();
});
