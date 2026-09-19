import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceLoadingPage } from "./WorkspaceLoadingPage";

afterEach(() => vi.useRealTimers());
it("reveals recovery on a slow load and keeps a failed retry recoverable", async () => {
  vi.useFakeTimers();
  const retry = vi.fn().mockRejectedValue(new Error("Still offline"));
  const signOut = vi.fn().mockResolvedValue(undefined);
  render(<WorkspaceLoadingPage onRetry={retry} onSignOut={signOut} />);
  expect(screen.queryByRole("button")).toBeNull();
  act(() => vi.advanceTimersByTime(10_000));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Try again" })));
  expect(screen.getByRole("alert")).toHaveTextContent("Still offline");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Back to login" })));
  expect(signOut).toHaveBeenCalledOnce();
});
