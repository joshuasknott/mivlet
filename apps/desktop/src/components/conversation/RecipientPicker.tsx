import { useEffect, useId, useRef, useState } from "react";
import { CaretDown } from "@phosphor-icons/react/dist/csr/CaretDown";

export function RecipientPicker({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { id: string; name: string; description?: string; disabled?: boolean }[];
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null),
    list = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const selected =
      list.current?.querySelector<HTMLButtonElement>(
        '[aria-selected="true"]:not(:disabled)',
      ) ??
      list.current?.querySelector<HTMLButtonElement>(
        '[role="option"]:not(:disabled)',
      );
    selected?.focus();
    const outside = (event: PointerEvent) => {
      if (!anchor.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return (
    <div className="team-recipient" ref={anchor}>
      <span>To</span>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        aria-label="Message recipient"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={id}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp"].includes(event.key)) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span>
          {options.find((option) => option.id === value)?.name ??
            "Choose participant"}
        </span>
        <CaretDown size={11} />
      </button>
      {open ? (
        <div
          ref={list}
          id={id}
          className="team-recipient__menu"
          role="listbox"
          aria-label="Message recipient"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close();
              return;
            }
            if (event.key === "Tab") {
              setOpen(false);
              return;
            }
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
              return;
            event.preventDefault();
            const items = [
                ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  '[role="option"]:not(:disabled)',
                ),
              ],
              index = items.indexOf(
                document.activeElement as HTMLButtonElement,
              );
            items[
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? items.length - 1
                  : (index +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      items.length) %
                    items.length
            ]?.focus();
          }}
        >
          {options.map((option) => (
            <button
              type="button"
              role="option"
              key={option.id}
              aria-selected={option.id === value}
              disabled={option.disabled}
              tabIndex={-1}
              onClick={() => {
                onChange(option.id);
                close();
              }}
            >
              <span>{option.name}</span>
              {option.description ? <small>{option.description}</small> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
