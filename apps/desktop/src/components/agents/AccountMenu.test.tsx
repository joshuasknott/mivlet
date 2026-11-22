import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AccountMenu } from "./AccountMenu";

describe("AccountMenu keyboard opening", () => {
  it.each([
    ["ArrowDown", "Usage"],
    ["ArrowUp", "Sign out"],
  ])("focuses %s's opening item, %s", (key, label) => {
    render(<AccountMenu name="Alex" onUsage={vi.fn()} onSettings={vi.fn()} onSignOut={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Account for Alex" });

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.keyDown(trigger, { key });

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menuitem", { name: label })).toHaveFocus();
  });
});
