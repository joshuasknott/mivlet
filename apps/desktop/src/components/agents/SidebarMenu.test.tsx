import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SidebarMenu } from "./SidebarMenu";

describe("SidebarMenu keyboard opening", () => {
  it("focuses the last enabled item when opened with ArrowUp", () => {
    render(
      <SidebarMenu
        label="Tools"
        items={[
          { label: "First", run: vi.fn() },
          { label: "Disabled", disabled: true, run: vi.fn() },
          { label: "Last", run: vi.fn() },
        ]}
      />,
    );

    fireEvent.keyDown(screen.getByRole("button", { name: "Tools" }), {
      key: "ArrowUp",
    });

    expect(screen.getByRole("menuitem", { name: "Last" })).toHaveFocus();
    expect(screen.getByRole("menuitem", { name: "Disabled" })).toBeDisabled();
  });
});
