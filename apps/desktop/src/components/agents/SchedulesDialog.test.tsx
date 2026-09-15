import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { SchedulesDialog } from "./SchedulesDialog";
import { SettingsModal } from "../settings/SettingsModal";

it("opens schedules contextually and restores focus to the durable trigger", async () => {
  function Workspace() {
    const [open, setOpen] = useState(false);
    return <><button onClick={() => setOpen(true)}>Schedules</button>{open ? <SchedulesDialog onClose={() => setOpen(false)}><p>Scheduled work</p></SchedulesDialog> : null}</>;
  }
  const user = userEvent.setup();
  render(<Workspace />);
  await user.tab();
  expect(screen.getByRole("button", { name: "Schedules" })).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("dialog", { name: "Schedules" })).toBeVisible();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.getByRole("button", { name: "Schedules" })).toHaveFocus());
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("keeps schedules out of settings navigation", () => {
  render(<SettingsModal activeTab="general" onSelectTab={vi.fn()} onClose={vi.fn()}><h1 id="settings-modal-title">General</h1></SettingsModal>);
  expect(screen.getByRole("button", { name: "General" })).toHaveAttribute("aria-current", "page");
  expect(screen.queryByRole("button", { name: "Schedules" })).toBeNull();
});
