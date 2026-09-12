import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("./TeammateWorkspace", () => ({
  TeammateWorkspace: () => <div data-testid="chat-workspace">workspace</div>
}));

import { DesktopShell } from "./DesktopShell";

describe("DesktopShell", () => {
  it("keeps the app shell as a thin composition boundary around the chat workspace", () => {
    render(<DesktopShell />);
    expect(screen.getByTestId("chat-workspace")).toHaveTextContent("workspace");
  });
});
