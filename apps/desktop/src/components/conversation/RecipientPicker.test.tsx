import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { RecipientPicker } from "./RecipientPicker";
it("opens above the composer, skips unavailable agents and selects Everyone by keyboard", () => {
  const onChange = vi.fn();
  render(
    <RecipientPicker
      value="lead"
      onChange={onChange}
      options={[
        { id: "lead", name: "Chief · Lead" },
        { id: "gone", name: "Unavailable", disabled: true },
        { id: "discussion", name: "Everyone" },
      ]}
    />,
  );
  fireEvent.click(screen.getByRole("combobox"));
  expect(screen.getByRole("option", { name: "Chief · Lead" })).toHaveFocus();
  fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
  expect(screen.getByRole("option", { name: "Everyone" })).toHaveFocus();
  fireEvent.click(screen.getByRole("option", { name: "Everyone" }));
  expect(onChange).toHaveBeenCalledWith("discussion");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(screen.getByRole("combobox")).toHaveFocus();
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
  fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
});
