import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerPluginsMenu } from "./ComposerPluginsMenu";
afterEach(() => vi.unstubAllGlobals());

describe("composer plugin flyout", () => {
  it("opens on hover and inserts only a connected plugin chosen by the user", () => {
    const mention = vi.fn();
    render(<ComposerPluginsMenu connectors={[{ id: "github", name: "GitHub" }]} onMention={mention} onAdd={vi.fn()} />);
    expect(screen.queryByRole("menu", { name: "Attached plugins" })).toBeNull();
    fireEvent.mouseEnter(screen.getByRole("menuitem", { name: "Plugins" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Plugins" }));
    expect(screen.getByRole("menu", { name: "Attached plugins" })).toBeVisible();
    fireEvent.click(screen.getByRole("menuitem", { name: "GitHub" }));
    expect(mention).toHaveBeenCalledWith("github");
    expect(screen.queryByText("Figma")).toBeNull();
  });
  it("does not move the narrow-layout trigger on hover before a click", () => {
    vi.stubGlobal("innerWidth", 390);
    render(<ComposerPluginsMenu connectors={[]} onMention={vi.fn()} onAdd={vi.fn()} />);
    const trigger = screen.getByRole("menuitem", { name: "Plugins" });
    fireEvent.mouseEnter(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    expect(screen.getByText("No plugins attached")).toBeVisible();
  });
  it("supports touch, keyboard entry, left-arrow return and the empty state", async () => {
    const add = vi.fn();
    render(<ComposerPluginsMenu connectors={[]} onMention={vi.fn()} onAdd={add} />);
    const trigger = screen.getByRole("menuitem", { name: "Plugins" });
    fireEvent.click(trigger);
    expect(screen.getByText("No plugins attached")).toBeVisible();
    const action = screen.getByRole("menuitem", { name: "Add plugins" });
    await vi.waitFor(() => expect(action).toHaveFocus());
    fireEvent.keyDown(action, { key: "ArrowLeft" });
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.keyDown(trigger, { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Add plugins" }));
    expect(add).toHaveBeenCalledOnce();
  });
});
