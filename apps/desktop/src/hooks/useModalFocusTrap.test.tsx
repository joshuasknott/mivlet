import { useRef, useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
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

function NestedModalHarness() {
  const [parentOpen, setParentOpen] = useState(false);
  const [childOpen, setChildOpen] = useState(false);
  const parentRef = useRef<HTMLElement>(null);
  const childRef = useRef<HTMLElement>(null);

  useModalFocusTrap({
    active: parentOpen,
    containerRef: parentRef,
    onClose: () => setParentOpen(false)
  });
  useModalFocusTrap({
    active: childOpen,
    containerRef: childRef,
    onClose: () => setChildOpen(false)
  });

  return (
    <>
      <button type="button" onClick={() => setParentOpen(true)}>
        Open parent
      </button>
      {parentOpen ? (
        <section
          ref={parentRef}
          role="dialog"
          aria-modal="true"
          aria-label="Parent modal"
          tabIndex={-1}
        >
          <button type="button" onClick={() => setChildOpen(true)}>
            Open child
          </button>
          {childOpen ? (
            <section
              ref={childRef}
              role="dialog"
              aria-modal="true"
              aria-label="Child modal"
              tabIndex={-1}
            >
              <button type="button">Child action</button>
            </section>
          ) : null}
        </section>
      ) : null}
    </>
  );
}

describe("useModalFocusTrap", () => {
  it("does not steal focus when the user acts before the initial frame", () => {
    const frames: FrameRequestCallback[] = [];
    const request = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const view = render(<ModalHarness />);
    try {
      fireEvent.click(screen.getByRole("button", { name: "Open modal" }));
      const last = screen.getByRole("button", { name: "Last action" });
      last.focus();
      act(() => frames.splice(0).forEach((callback) => callback(0)));
      expect(last).toHaveFocus();
    } finally {
      view.unmount();
      request.mockRestore();
    }
  });

  it("focuses the modal, wraps Tab in both directions, closes on Escape, and restores focus", async () => {
    const user = userEvent.setup();
    render(<ModalHarness />);

    const trigger = screen.getByRole("button", { name: "Open modal" });
    await user.click(trigger);
    const first = screen.getByRole("textbox", { name: "First field" });
    const last = screen.getByRole("button", { name: "Last action" });
    await waitFor(() => expect(first).toHaveFocus());
    expect(trigger).toHaveAttribute("inert");

    await user.click(last);
    await user.tab();
    expect(first).toHaveFocus();

    await user.tab({ shift: true });
    expect(last).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(trigger).not.toHaveAttribute("inert");
  });

  it("returns focus to an explicit stable control when the opener unmounts", async () => {
    const user = userEvent.setup();
    render(<TransientTriggerHarness />);

    await user.click(screen.getByRole("button", { name: "Transient action" }));
    expect(screen.getByRole("button", { name: "Stable control", hidden: true })).toHaveAttribute(
      "inert"
    );
    await user.keyboard("{Escape}");

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Stable control" })).toHaveFocus()
    );
  });

  it("reference-counts inert background branches across nested dialogs", async () => {
    const user = userEvent.setup();
    render(<NestedModalHarness />);

    const outerTrigger = screen.getByRole("button", { name: "Open parent" });
    await user.click(outerTrigger);
    await user.click(screen.getByRole("button", { name: "Open child" }));
    expect(outerTrigger).toHaveAttribute("inert");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Child modal" })).not.toBeInTheDocument();
    expect(outerTrigger).toHaveAttribute("inert");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Parent modal" })).not.toBeInTheDocument();
    expect(outerTrigger).not.toHaveAttribute("inert");
  });
});
