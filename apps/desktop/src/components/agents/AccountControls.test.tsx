import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SettingsModal } from "../settings/SettingsModal";
import type { SettingsTab } from "../pages/settings-tabs";
import { AccountDialog } from "./AccountDialog";
import { AccountMenu } from "./AccountMenu";

function AccountSettingsHarness() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<SettingsTab>("general");
  return <>
    <AccountMenu name="Joshua" onUsage={() => {}} onSignOut={() => {}} onSettings={() => setOpen(true)} />
    {open ? <SettingsModal activeTab={tab} onSelectTab={setTab} onClose={() => setOpen(false)}>
      <h1 id="settings-modal-title">{tab}</h1>
      <button type="button">Last setting</button>
      <details><summary>Advanced settings</summary><button type="button">Hidden setting</button></details>
    </SettingsModal> : null}
  </>;
}

describe("account controls", () => {
  it("opens the menu before settings, keeps keyboard focus in settings, and restores the profile trigger", async () => {
    const user = userEvent.setup();
    render(<AccountSettingsHarness />);
    const trigger = screen.getByRole("button", { name: "Account for Joshua" });
    await user.click(trigger);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Usage" })).toHaveFocus();
    await user.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(screen.getByRole("button", { name: "General" })).toHaveFocus());
    await user.click(screen.getByRole("button", { name: "Providers" }));
    expect(screen.getByRole("heading", { name: "providers" })).toBeInTheDocument();
    // jsdom does not model the native summary tab order; exercise the trap boundary directly.
    act(() => screen.getByText("Advanced settings").focus());
    await user.tab();
    expect(screen.getByRole("button", { name: "General" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("waits for sign out, prevents repeat submissions, and keeps failures visible", async () => {
    const user = userEvent.setup();
    let rejectSignOut!: (error: Error) => void;
    const onSignOut = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectSignOut = reject; }));
    const onClose = vi.fn();
    render(<AccountDialog kind="sign-out" name="Joshua" records={[]} onSignOut={onSignOut} onClose={onClose} />);
    expect(onSignOut).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(screen.getByRole("button", { name: "Signing out…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => rejectSignOut(new Error("Account service is unavailable.")));
    expect(screen.getByRole("alert")).toHaveTextContent("Account service is unavailable.");
    expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled();
    expect(onSignOut).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not present unreported costs as free usage or invent subscription limits", () => {
    render(<AccountDialog kind="usage" name="Joshua" records={[
      { inputTokens: 100, outputTokens: 50, costUsd: 0, costUnknown: true }
    ]} onSignOut={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.getByText("100")).toBeInTheDocument();
    expect(screen.queryByText(/\$0/)).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });
});
