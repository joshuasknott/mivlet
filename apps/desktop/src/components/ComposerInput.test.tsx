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
  it("renders workspace agent mentions as stable-ID chips and preserves the token", () => {
    const token = "@[Renamed](agent:agent-1)";
    render(
      <ComposerInput
        inputRef={createRef()}
        value={`Ask ${token} to review`}
        onChange={vi.fn()}
        onKeyDown={vi.fn()}
        placeholder="Message"
        connectors={[]}
        agentMentions={[{ id: "agent-1", name: "Current Name" }]}
      />,
    );
    const input = screen.getByRole("textbox");
    expect(input).toHaveTextContent("Ask Current Name to review");
    expect(input.querySelector(".agent-mention")).toHaveAttribute("data-mention", token);
  });

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
  it("holds the draft during IME composition and commits the final value once", () => {
    const onChange = vi.fn();
    render(
      <ComposerInput
        inputRef={createRef()}
        value=""
        onChange={onChange}
        onKeyDown={vi.fn()}
        placeholder="Message"
        connectors={[]}
      />,
    );
    const input = screen.getByRole("textbox");
    fireEvent.compositionStart(input);
    input.append(document.createTextNode("かな"));
    fireEvent.input(input);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    expect(onChange).toHaveBeenCalledExactlyOnceWith("かな");
  });
});
