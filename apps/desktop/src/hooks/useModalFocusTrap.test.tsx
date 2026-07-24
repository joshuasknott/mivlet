import { useRef, useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { useModalFocusTrap } from "./useModalFocusTrap";

function ModalHarness() {
  const [open, setOpen] = useState(false);
  const modalRef = useRef<HTMLElement>(null);
  const initialFocusRef = useRef<HTMLInputElement>(null);

  useModalFocusTrap({
    active: open,
    containerRef: modalRef,
    initialFocusRef,
    onClose: () => setOpen(false)
  });

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open modal
      </button>
      {open ? (
        <section
          ref={modalRef}
          role="dialog"
          aria-modal="true"
          aria-label="Test modal"
          tabIndex={-1}
        >
          <input ref={initialFocusRef} aria-label="First field" />
          <button type="button">Last action</button>
        </section>
      ) : null}
    </>
  );
}

function TransientTriggerHarness() {
  const [open, setOpen] = useState(false);
  const modalRef = useRef<HTMLElement>(null);
  const stableReturnRef = useRef<HTMLButtonElement>(null);

  useModalFocusTrap({
    active: open,
    containerRef: modalRef,
    returnFocusRef: stableReturnRef,
    onClose: () => setOpen(false)
  });

  return (
    <>
      <button ref={stableReturnRef} type="button">
        Stable control
      </button>
      {!open ? (
        <button type="button" onClick={() => setOpen(true)}>
          Transient action
        </button>
      ) : (
        <section
          ref={modalRef}
          role="dialog"
          aria-modal="true"
          aria-label="Transient modal"
          tabIndex={-1}
        >
          <button type="button">Close target</button>
        </section>
      )}
    </>
  );
}

describe("useModalFocusTrap", () => {
  it("focuses the modal, wraps Tab in both directions, closes on Escape, and restores focus", async () => {
    const user = userEvent.setup();
    render(<ModalHarness />);

    const trigger = screen.getByRole("button", { name: "Open modal" });
    await user.click(trigger);
    const first = screen.getByRole("textbox", { name: "First field" });
    const last = screen.getByRole("button", { name: "Last action" });
    await waitFor(() => expect(first).toHaveFocus());

    await user.click(last);
    await user.tab();
    expect(first).toHaveFocus();

    await user.tab({ shift: true });
    expect(last).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("returns focus to an explicit stable control when the opener unmounts", async () => {
    const user = userEvent.setup();
    render(<TransientTriggerHarness />);

    await user.click(screen.getByRole("button", { name: "Transient action" }));
    await user.keyboard("{Escape}");

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Stable control" })).toHaveFocus()
    );
  });
});
