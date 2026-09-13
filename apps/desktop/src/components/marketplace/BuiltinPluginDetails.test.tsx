import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { builtinPluginEntries } from "../../lib/builtin-plugins";
import { BuiltinPluginDetails } from "./BuiltinPluginDetails";

const entry = builtinPluginEntries[0];
afterEach(cleanup);

const props = () => ({
  entry,
  enabled: false,
  unavailable: false,
  busy: false,
  notice: "",
  workspaceId: "workspace-local",
  titleId: "computer-title",
  onToggle: vi.fn(),
  onUse: vi.fn(),
});

describe("built-in plugin detail", () => {
  it("enables and disables in the ordinary modal without borrowing connection language", () => {
    const onToggle = vi.fn();
    const view = render(<BuiltinPluginDetails {...props()} onToggle={onToggle} />);
    expect(screen.getByText("Disabled")).toBeInTheDocument();
    expect(screen.queryByText("Connected")).toBeNull();
    expect(screen.queryByRole("button", { name: "Use in chat" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Enable" }));
    expect(onToggle).toHaveBeenCalledWith(true);

    view.rerender(<BuiltinPluginDetails {...props()} enabled onToggle={onToggle} />);
    expect(screen.getByText("Enabled")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use in chat" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    expect(onToggle).toHaveBeenLastCalledWith(false);
  });

  it("does not claim capability from enablement and keeps permission separate", () => {
    render(<BuiltinPluginDetails {...props()} enabled />);
    expect(screen.getByText(/Enablement alone never grants permission/)).toBeInTheDocument();
    expect(screen.getByText(/stops any active application control immediately/i)).toBeInTheDocument();
  });

  it("fails closed without a desktop workspace", () => {
    render(<BuiltinPluginDetails {...props()} unavailable workspaceId={undefined} />);
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enable" })).toBeDisabled();
    expect(screen.getByText(/belong to the desktop app/i)).toBeInTheDocument();
  });
});
