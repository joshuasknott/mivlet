import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";

vi.mock("./lib/query-client", () => ({
  FableQueryProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="query-boundary">{children}</div>
  )
}));

vi.mock("./shell/DesktopShell", () => ({
  DesktopShell: () => <main>Conversation workspace</main>
}));

describe("App", () => {
  it("mounts the conversation shell inside the shared data boundary", () => {
    render(<App />);

    expect(screen.getByTestId("query-boundary")).toContainElement(
      screen.getByText("Conversation workspace")
    );
  });
});
