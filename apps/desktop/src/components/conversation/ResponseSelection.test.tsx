import "@testing-library/jest-dom/vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { ResponseSelection } from "./ResponseSelection";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
let bounds = new DOMRect(80, 160, 200, 40);
const originalRangeBounds = Object.getOwnPropertyDescriptor(
  Range.prototype,
  "getBoundingClientRect",
);
beforeAll(() =>
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => bounds,
  }),
);
afterAll(() => {
  if (originalRangeBounds)
    Object.defineProperty(
      Range.prototype,
      "getBoundingClientRect",
      originalRangeBounds,
    );
  else Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
});
vi.mock("../../runtime/domains/conversation-ui", () => ({
  conversationUi: mocks.invoke,
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  bounds = new DOMRect(80, 160, 200, 40);
  window.getSelection()?.removeAllRanges();
});

describe("response contextual actions", () => {
  it("sends the canonical persisted source while selecting rendered text", async () => {
    const canonical = "A **quiet** conversation with `tools`.";
    mocks.invoke.mockResolvedValue({
      sourceRevision: "revision-1",
      reference: "Conversation chat, response run, revision revision-1",
      selection: "**quiet** conversation with `tools`",
    });
    render(
      <ResponseSelection
        text="A quiet conversation with tools."
        source={canonical}
        workspaceId="workspace"
        conversationId="chat"
        runId="run"
        agentId="agent"
        responseMessageId="message"
        responseRevisionId="revision-1"
        streaming={false}
        onDraft={vi.fn()}
        onSaveMemory={vi.fn()}
      >
        <span>quiet conversation with tools</span>
      </ResponseSelection>,
    );
    const content = screen.getByLabelText(
      "Response content; select a passage for actions",
    );
    const range = document.createRange();
    range.selectNodeContents(content.firstElementChild!);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.pointerUp(content);
    fireEvent.click(await screen.findByRole("button", { name: "Add to chat" }));
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        { workspaceId: "workspace", conversationId: "chat", agentId: "agent" },
        expect.objectContaining({
          action: "quote-response",
          source: canonical,
        }),
      ),
    );
  });

  it("keeps the final paragraph selection when selectionchange follows pointerup", async () => {
    const onDraft = vi.fn();
    mocks.invoke.mockResolvedValue({
      sourceRevision: "revision-1",
      reference: "Conversation chat, response run, revision revision-1",
      selection: "First paragraph with drinks and citrus.",
    });
    render(
      <ResponseSelection
        text="First paragraph with drinks and citrus.\n\nSecond paragraph."
        workspaceId="workspace"
        conversationId="chat"
        runId="run"
        agentId="agent"
        responseMessageId="message"
        responseRevisionId="revision-1"
        streaming={false}
        onDraft={onDraft}
        onSaveMemory={vi.fn()}
      >
        <span>First paragraph with drinks and citrus.</span>
        <span> Second paragraph.</span>
      </ResponseSelection>,
    );
    const content = screen.getByLabelText(
      "Response content; select a passage for actions",
    );
    const rendered = content.firstElementChild!;
    const selection = window.getSelection()!;
    const initial = document.createRange();
    initial.setStart(rendered.firstChild!, 23);
    initial.setEnd(rendered.firstChild!, 29);
    selection.removeAllRanges();
    selection.addRange(initial);
    fireEvent.pointerUp(content);

    const final = document.createRange();
    final.selectNodeContents(rendered);
    selection.removeAllRanges();
    selection.addRange(final);
    fireEvent(document, new Event("selectionchange"));

    fireEvent.click(await screen.findByRole("button", { name: "Add to chat" }));
    await waitFor(() =>
      expect(onDraft).toHaveBeenCalledWith(
        expect.stringContaining("> First paragraph with drinks and citrus."),
      ),
    );
    expect(mocks.invoke).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        selection: "First paragraph with drinks and citrus.",
      }),
    );
  });

  function setup(
    overrides: Partial<Parameters<typeof ResponseSelection>[0]> = {},
  ) {
    mocks.invoke.mockResolvedValue({
      sourceRevision: "revision-1",
      reference: "Verified source revision-1",
      selection: "Selected passage.",
    });
    const props = {
      text: "Selected passage.",
      workspaceId: "workspace",
      conversationId: "chat",
      runId: "run",
      agentId: "agent",
      responseRevisionId: "revision-1",
      streaming: false,
      onDraft: vi.fn(),
      onAskSideChat: vi.fn().mockResolvedValue(undefined),
      onSaveMemory: vi.fn().mockResolvedValue(undefined),
      children: <span>Selected passage.</span>,
      ...overrides,
    };
    const view = render(<ResponseSelection {...props} />);
    const content = screen.getByLabelText(
      "Response content; select a passage for actions",
    );
    const range = document.createRange();
    range.selectNodeContents(content.firstElementChild!);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.pointerUp(content);
    return { ...view, content, props };
  }

  it("offers exactly three actions above the selection without changing message flow", () => {
    const { container } = setup();
    const toolbar = screen.getByRole("toolbar", {
      name: "Selected response actions",
    });
    expect(
      within(toolbar)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Add to chat", "Ask in side chat", "Add to memory"]);
    expect(container.contains(toolbar)).toBe(false);
    expect(toolbar).toHaveStyle({ left: "30px", top: "120px" });
  });

  it("stages a validated quote in a side chat without modifying the current draft", async () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Ask in side chat" }));
    await waitFor(() =>
      expect(props.onAskSideChat).toHaveBeenCalledWith(
        expect.stringContaining("> Selected passage."),
      ),
    );
    expect(props.onAskSideChat).toHaveBeenCalledWith(
      expect.stringContaining("Source: Verified source revision-1"),
    );
    expect(props.onDraft).not.toHaveBeenCalled();
    expect(props.onSaveMemory).not.toHaveBeenCalled();
  });

  it("adds selected text and its verified source to conversation memory", async () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Add to memory" }));
    await waitFor(() =>
      expect(props.onSaveMemory).toHaveBeenCalledWith(
        "Saved response passage",
        "Selected passage.\n\nSource: Verified source revision-1",
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Saved to this conversation’s memory",
    );
    fireEvent(document, new Event("selectionchange"));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Saved to this conversation’s memory",
    );
    expect(props.onDraft).not.toHaveBeenCalled();
  });

  it("clamps to the viewport and moves below a selection near its top edge", () => {
    vi.stubGlobal("innerWidth", 320);
    bounds = new DOMRect(270, 4, 40, 20);
    setup();
    expect(screen.getByRole("toolbar")).toHaveStyle({
      left: "12px",
      top: "32px",
    });
    bounds = new DOMRect(80, 300, 200, 40);
    fireEvent.scroll(document);
    expect(screen.getByRole("toolbar")).toHaveStyle({ top: "260px" });
  });

  it("supports keyboard navigation and Escape without a close button", () => {
    const { content } = setup();
    const chat = screen.getByRole("button", { name: "Add to chat" });
    act(() => chat.focus());
    fireEvent.keyDown(chat, { key: "ArrowRight" });
    expect(
      screen.getByRole("button", { name: "Ask in side chat" }),
    ).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(screen.getByRole("button", { name: "Add to memory" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    fireEvent.keyUp(content, { key: "Escape" });
    fireEvent(document, new Event("selectionchange"));
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(content).toHaveFocus();
    expect(window.getSelection()?.isCollapsed).toBe(true);
  });

  it("keeps the portal actions in tab order before the following response control", async () => {
    const user = userEvent.setup();
    mocks.invoke.mockResolvedValue({
      sourceRevision: "revision-1",
      reference: "Verified source revision-1",
      selection: "Selected passage.",
    });
    const props = {
      text: "Selected passage.",
      workspaceId: "workspace",
      conversationId: "chat",
      runId: "run",
      agentId: "agent",
      responseRevisionId: "revision-1",
      streaming: false,
      onDraft: vi.fn(),
      onAskSideChat: vi.fn().mockResolvedValue(undefined),
      onSaveMemory: vi.fn().mockResolvedValue(undefined),
      children: (
        <>
          <a href="/source">Reference link</a>
          <button type="button">Copy code</button>
          <span>Selected passage.</span>
        </>
      ),
    };
    render(
      <>
        <button type="button">Previous response control</button>
        <ResponseSelection {...props} />
        <button type="button" style={{ display: "none" }}>
          Hidden response control
        </button>
        <button type="button">Following response control</button>
      </>,
    );
    const content = screen.getByLabelText(
      "Response content; select a passage for actions",
    );
    await user.tab();
    await user.tab();
    expect(content).toHaveFocus();
    const range = document.createRange();
    range.selectNodeContents(content.querySelector("span")!);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.pointerUp(content);
    await screen.findByRole("toolbar", { name: "Selected response actions" });
    expect(content).toHaveFocus();

    await user.tab();
    expect(screen.getByRole("link", { name: "Reference link" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Copy code" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Add to chat" })).toHaveFocus();
    await user.tab();
    expect(
      screen.getByRole("button", { name: "Ask in side chat" }),
    ).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Add to memory" })).toHaveFocus();
    await user.tab();
    expect(
      screen.getByRole("button", { name: "Following response control" }),
    ).toHaveFocus();
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("returns to response content when reverse tabbing from the first action", async () => {
    const user = userEvent.setup();
    const { content } = setup();
    const quote = screen.getByRole("button", { name: "Add to chat" });
    act(() => quote.focus());

    await user.tab({ shift: true });
    expect(content).toHaveFocus();
  });

  it("returns to the last focusable response descendant on reverse tab", async () => {
    const user = userEvent.setup();
    render(
      <ResponseSelection
        text="Selected passage."
        workspaceId="workspace"
        conversationId="chat"
        runId="run"
        agentId="agent"
        responseRevisionId="revision-1"
        streaming={false}
        onDraft={vi.fn()}
        onAskSideChat={vi.fn().mockResolvedValue(undefined)}
        onSaveMemory={vi.fn().mockResolvedValue(undefined)}
      >
        <>
          <a href="/source">Reference link</a>
          <button type="button">Copy code</button>
          <span>Selected passage.</span>
        </>
      </ResponseSelection>,
    );
    const content = screen.getByLabelText(
      "Response content; select a passage for actions",
    );
    content.focus();
    const range = document.createRange();
    range.selectNodeContents(content.querySelector("span")!);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.pointerUp(content);
    await screen.findByRole("toolbar", { name: "Selected response actions" });
    const quote = screen.getByRole("button", { name: "Add to chat" });
    act(() => quote.focus());

    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Copy code" })).toHaveFocus();
  });

  it("dismisses a collapsed selection from pointer and keyboard clearing", () => {
    const view = setup();
    view.content.focus();
    window.getSelection()!.removeAllRanges();
    fireEvent.pointerUp(view.content);
    expect(screen.queryByRole("toolbar")).toBeNull();

    const range = document.createRange();
    range.selectNodeContents(view.content.firstElementChild!);
    window.getSelection()!.addRange(range);
    fireEvent.pointerUp(view.content);
    expect(screen.getByRole("toolbar")).toBeVisible();
    window.getSelection()!.removeAllRanges();
    fireEvent.keyUp(view.content, { key: "ArrowRight" });
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("dismisses cleared selections and outside clicks", () => {
    const { content } = setup();
    window.getSelection()!.removeAllRanges();
    fireEvent(document, new Event("selectionchange"));
    expect(screen.queryByRole("toolbar")).toBeNull();
    const range = document.createRange();
    range.selectNodeContents(content.firstElementChild!);
    window.getSelection()!.addRange(range);
    fireEvent.pointerUp(content);
    expect(screen.getByRole("toolbar")).toBeVisible();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("disables unavailable side chat and hides actions while streaming", () => {
    const view = setup({ onAskSideChat: undefined });
    expect(
      screen.getByRole("button", { name: "Ask in side chat" }),
    ).toBeDisabled();
    view.rerender(<ResponseSelection {...view.props} streaming />);
    fireEvent.pointerUp(view.content);
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("keeps native validation failures visible without staging a draft", async () => {
    const { props } = setup();
    mocks.invoke.mockRejectedValue(new Error("The saved response changed."));
    fireEvent.click(screen.getByRole("button", { name: "Ask in side chat" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "The saved response changed",
    );
    expect(props.onAskSideChat).not.toHaveBeenCalled();
    expect(screen.getByRole("toolbar")).toBeVisible();
  });

  it("ignores late validation after the saved revision changes", async () => {
    const { props, rerender } = setup();
    let finish!: (result: {
      selection: string;
      reference: string;
      sourceRevision: string;
    }) => void;
    mocks.invoke.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add to chat" }));
    expect(
      screen.getByRole("button", { name: "Add to memory" }),
    ).toBeDisabled();
    rerender(<ResponseSelection {...props} responseRevisionId="revision-2" />);
    await act(async () =>
      finish({
        selection: "Selected passage.",
        reference: "Old source",
        sourceRevision: "revision-1",
      }),
    );
    expect(props.onDraft).not.toHaveBeenCalled();
    expect(screen.queryByRole("toolbar")).toBeNull();
  });
});
