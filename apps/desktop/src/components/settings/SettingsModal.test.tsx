import { useRef, useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { SettingsModal } from "./SettingsModal";
import { useModalFocusTrap } from "../../hooks/useModalFocusTrap";
import type { SettingsTab } from "../pages/settings-tabs";

const TAB_TITLES: Record<SettingsTab, string> = {
  general: "General",
  providers: "Providers",
  models: "Models",
  privacy: "Memory",
};

function SettingsHarness({
  initialTab = "general",
}: {
  initialTab?: SettingsTab;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open settings
      </button>
      {open ? (
        <SettingsModal
          activeTab={tab}
          onSelectTab={setTab}
          onClose={() => setOpen(false)}
        >
          <h1 id="settings-modal-title">{TAB_TITLES[tab]}</h1>
          {tab === "general" ? (
            <button type="button">First setting</button>
          ) : null}
          {tab === "providers" ? (
            <button type="button">Provider setting</button>
          ) : null}
        </SettingsModal>
      ) : null}
    </>
  );
}

function NestedControlHarness() {
  const [open, setOpen] = useState(false);
  const [nestedOpen, setNestedOpen] = useState(false);
  const nestedRef = useRef<HTMLElement>(null);
  useModalFocusTrap({
    active: nestedOpen,
    containerRef: nestedRef,
    onClose: () => setNestedOpen(false),
  });
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open settings
      </button>
      {open ? (
        <SettingsModal
          activeTab="general"
          onSelectTab={() => {}}
          onClose={() => setOpen(false)}
        >
          <h1 id="settings-modal-title">General</h1>
          <button type="button" onClick={() => setNestedOpen(true)}>
            Open nested control
          </button>
          {nestedOpen ? (
            <section
              ref={nestedRef}
              role="dialog"
              aria-modal="true"
              aria-label="Nested control"
              tabIndex={-1}
            >
              <p>Confirm inside the settings dialog.</p>
              <button type="button">Confirm action</button>
            </section>
          ) : null}
        </SettingsModal>
      ) : null}
    </>
  );
}

describe("SettingsModal", () => {
  it("opens on the active section, keeps keyboard focus inside, and restores the invoking control on close", async () => {
    const user = userEvent.setup();
    render(<SettingsHarness />);

    const trigger = screen.getByRole("button", { name: "Open settings" });
    await user.click(trigger);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAccessibleName("General");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "General" })).toHaveFocus(),
    );
    expect(trigger).toHaveAttribute("inert");

    await user.click(screen.getByRole("button", { name: "Memory" }));
    expect(
      screen.getByRole("heading", { name: "Memory" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Memory" })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(trigger).not.toHaveAttribute("inert");
  });

  it("focuses the section the dialog was opened on, not the first tab", async () => {
    const user = userEvent.setup();
    render(<SettingsHarness initialTab="providers" />);

    await user.click(screen.getByRole("button", { name: "Open settings" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Providers" })).toHaveFocus(),
    );
  });

  it("wraps Tab at both ends of the dialog", async () => {
    const user = userEvent.setup();
    render(<SettingsHarness initialTab="providers" />);

    await user.click(screen.getByRole("button", { name: "Open settings" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Providers" })).toHaveFocus(),
    );

    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "General" })).toHaveFocus();
    await user.tab({ shift: true });
    expect(
      screen.getByRole("button", { name: "Provider setting" }),
    ).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "General" })).toHaveFocus();
  });

  it("keeps the settings dialog open while a nested control is active, then closes it and restores focus", async () => {
    const user = userEvent.setup();
    render(<NestedControlHarness />);

    const trigger = screen.getByRole("button", { name: "Open settings" });
    await user.click(trigger);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "General" })).toHaveFocus(),
    );

    await user.click(
      screen.getByRole("button", { name: "Open nested control" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Nested control" }),
    ).toBeVisible();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Confirm action" }),
      ).toHaveFocus(),
    );

    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("dialog", { name: "Nested control" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "General" })).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Open nested control" }),
      ).toHaveFocus(),
    );

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("keeps the close control reachable in the dialog tab order", async () => {
    const user = userEvent.setup();
    render(<SettingsHarness />);

    const trigger = screen.getByRole("button", { name: "Open settings" });
    await user.click(trigger);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "General" })).toHaveFocus(),
    );

    const close = screen.getByRole("button", { name: "Close settings" });
    for (let index = 0; index < 4; index += 1) await user.tab();
    expect(close).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
