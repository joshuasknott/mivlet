import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

const inertClaims = new Map<HTMLElement, { count: number; originallyInert: boolean }>();

function focusableElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) =>
      !element.hidden &&
      element.getAttribute("aria-hidden") !== "true" &&
      !element.closest("[hidden]")
  );
}

function claimModalBackground(container: HTMLElement) {
  const claimed: HTMLElement[] = [];
  let branch: HTMLElement = container;
  let parent = branch.parentElement;

  while (parent) {
    for (const sibling of parent.children) {
      if (!(sibling instanceof HTMLElement) || sibling === branch) continue;
      const existing = inertClaims.get(sibling);
      if (existing) {
        existing.count += 1;
      } else {
        inertClaims.set(sibling, {
          count: 1,
          originallyInert: sibling.hasAttribute("inert")
        });
        sibling.setAttribute("inert", "");
      }
      claimed.push(sibling);
    }
    if (parent === document.body) break;
    branch = parent;
    parent = parent.parentElement;
  }

  return () => {
    for (const element of claimed) {
      const claim = inertClaims.get(element);
      if (!claim) continue;
      claim.count -= 1;
      if (claim.count > 0) continue;
      inertClaims.delete(element);
      if (!claim.originallyInert) element.removeAttribute("inert");
    }
  };
}

/**
 * Keeps keyboard focus inside an active modal, focuses its first useful
 * control, removes background branches from keyboard and assistive-technology
 * navigation, closes it on Escape, and returns focus to the opening control.
 *
 * A parent modal yields while a nested aria-modal dialog is present so only
 * the top-most dialog owns the keyboard.
 */
export function useModalFocusTrap({
  active,
  containerRef,
  initialFocusRef,
  returnFocusRef,
  onClose
}: {
  active: boolean;
  containerRef: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onClose?: () => void;
}) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!active) return;

    const container = containerRef.current;
    if (!container) return;

    const inferredReturnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const releaseModalBackground = claimModalBackground(container);
    const focusInitial = () => {
      const target = initialFocusRef?.current ?? focusableElements(container)[0] ?? container;
      target.focus();
    };
    const frame = window.requestAnimationFrame(focusInitial);

    const handleKeyDown = (event: KeyboardEvent) => {
      const nestedModal = container.querySelector<HTMLElement>(
        '[role="dialog"][aria-modal="true"]'
      );
      if (nestedModal) return;

      if (event.key === "Escape" && onCloseRef.current) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = focusableElements(container);
      if (focusable.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const current = document.activeElement;

      if (event.shiftKey && (current === first || !container.contains(current))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (current === last || !container.contains(current))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
      releaseModalBackground();
      const returnFocus = returnFocusRef?.current ?? inferredReturnFocus;
      if (returnFocus?.isConnected) {
        returnFocus.focus();
      }
    };
  }, [active, containerRef, initialFocusRef, returnFocusRef]);
}
