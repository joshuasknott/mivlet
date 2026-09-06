import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ComposerInput, type ComposerInputHandle } from "./ComposerInput";
import { ConnectorMentionText } from "./ConnectorMention";

const connectors = [
  { id: "google-drive", name: "Google Drive" },
  { id: "gmail", name: "Gmail" },
];
describe("connector mention input", () => {
  it("renders inline chips while selection and dictation use canonical text offsets", () => {
    const ref = createRef<ComposerInputHandle>();
    const { rerender } = render(
      <ComposerInput
        inputRef={ref}
        value="Check @google-drive now"
        onChange={vi.fn()}
        onKeyDown={vi.fn()}
        placeholder="Message"
        connectors={connectors}
      />,
    );
    const input = screen.getByRole("textbox");
    expect(input).toHaveTextContent("Check Google Drive now");
    expect(input.querySelector("[data-mention]")).toHaveAttribute(
      "contenteditable",
      "false",
    );
    ref.current!.focus();
    ref.current!.setSelectionRange(19, 19);
    expect(ref.current!.selectionStart).toBe(19);
    rerender(
      <ComposerInput
        inputRef={ref}
        value=""
        onChange={vi.fn()}
        onKeyDown={vi.fn()}
        placeholder="Message"
        connectors={connectors}
      />,
    );
    expect(input).toBeEmptyDOMElement();
  });
  it("serializes chips as IDs when text is edited and preserves unknown mentions", () => {
    const onChange = vi.fn();
    render(
      <ComposerInput
        inputRef={createRef()}
        value="@gmail "
        onChange={onChange}
        onKeyDown={vi.fn()}
        placeholder="Message"
        connectors={connectors}
      />,
    );
    const input = screen.getByRole("textbox");
    input.append(document.createTextNode("latest"));
    fireEvent.input(input);
    expect(onChange).toHaveBeenCalledWith("@gmail latest");
    const { container } = render(
      <ConnectorMentionText
        text="email@gmail.com @unknown @gmail."
        connectors={connectors}
      />,
    );
    expect(container).toHaveTextContent("email@gmail.com @unknown Gmail.");
  });
});
