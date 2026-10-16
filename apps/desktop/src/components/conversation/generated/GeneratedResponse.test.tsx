import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeneratedResponse } from "./GeneratedResponse";
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../../runtime/domains/conversation-ui", () => ({
  conversationUi: mocks.invoke,
}));
const text =
  'Choose a route.\n```openui\nroot = Stack([choice])\nchoice = Options("route", "Direction", ["Simple", "Detailed"])\n```';
const owner = {
  workspaceId: "workspace",
  conversationId: "chat",
  runId: "run",
  agentId: "agent",
  generation: 1,
  source: text,
  responseRevisionId: "revision-1",
};
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
describe("production generated response", () => {
  it("waits for a durable source before invoking native interface state", async () => {
    render(
      <GeneratedResponse
        {...owner}
        source={undefined}
        responseRevisionId={undefined}
        text={text}
        streaming={false}
        onDraft={vi.fn()}
      />,
    );
    expect(
      await screen.findByText(
        /Waiting for this response to be saved before enabling controls/,
      ),
    ).toBeVisible();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("restores saved values, persists edits, and only stages a draft on a deliberate review", async () => {
    let revision = 1;
    const draft = vi.fn();
    mocks.invoke.mockImplementation(async (_owner, request) => {
      if (request.action === "review-interface")
        return {
          state: {
            revision: ++revision,
            sourceRevision: "saved-rev",
            values: { route: "Detailed" },
            reviewedEvents: ["event"],
          },
          draft: "Review this exact selection",
        };
      return {
        revision: request.action === "save-interface" ? ++revision : revision,
        sourceRevision: "saved-rev",
        values: request.values ?? { route: "Simple" },
        reviewedEvents: [],
      };
    });
    render(
      <GeneratedResponse
        {...owner}
        text={text}
        streaming={false}
        onDraft={draft}
      />,
    );
    expect(
      await screen.findByRole("radio", { name: "Simple" }, { timeout: 5000 }),
    ).toBeChecked();
    expect(draft).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("radio", { name: "Detailed" }));
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: "chat" }),
        expect.objectContaining({
          action: "save-interface",
          expectedRevision: 1,
          values: { route: "Detailed" },
        }),
      ),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Review selection in composer" }),
    );
    await waitFor(() =>
      expect(draft).toHaveBeenCalledWith("Review this exact selection"),
    );
  });
  it("uses the exact persisted revision source for native interface actions", async () => {
    const canonicalSource = `${text}\n`;
    mocks.invoke.mockResolvedValue({
      revision: 1,
      sourceRevision: "saved-rev",
      values: { route: "Simple" },
      reviewedEvents: [],
    });
    render(
      <GeneratedResponse
        {...owner}
        text={text.trimEnd()}
        source={canonicalSource}
        responseRevisionId="revision-1"
        streaming={false}
        onDraft={vi.fn()}
      />,
    );
    expect(
      await screen.findByRole("radio", { name: "Simple" }, { timeout: 5000 }),
    ).toBeChecked();
    expect(mocks.invoke).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "chat" }),
      expect.objectContaining({ action: "load-interface", source: canonicalSource }),
    );
    fireEvent.click(screen.getByRole("radio", { name: "Detailed" }));
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "save-interface", source: canonicalSource }),
      ),
    );
  });
  it("does not load or dispatch actions while streaming, and keeps invalid content inspectable", async () => {
    const { rerender } = render(
      <GeneratedResponse {...owner} text={text} streaming onDraft={vi.fn()} />,
    );
    expect(await screen.findByRole("radio", { name: "Simple" })).toBeDisabled();
    expect(mocks.invoke).not.toHaveBeenCalled();
    rerender(
      <GeneratedResponse
        {...owner}
        text={'```openui\nroot = Query("steal", {})\n```'}
        streaming={false}
        onDraft={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Unknown");
    expect(screen.queryByText("Loading saved answers…")).not.toBeInTheDocument();
    expect(screen.getByText(/Ask the agent to revise this response/)).toBeVisible();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("never applies a late saved response to another conversation", async () => {
    let finish!: (value: unknown) => void;
    mocks.invoke
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({
        revision: 0,
        sourceRevision: "other",
        values: {},
        reviewedEvents: [],
      });
    const { rerender } = render(
      <GeneratedResponse
        {...owner}
        text={text}
        streaming={false}
        onDraft={vi.fn()}
      />,
    );
    rerender(
      <GeneratedResponse
        {...owner}
        conversationId="other"
        text={text}
        streaming={false}
        onDraft={vi.fn()}
      />,
    );
    finish({
      revision: 1,
      values: { route: "Simple" },
      sourceRevision: "old",
      reviewedEvents: [],
    });
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "Simple" })).not.toBeChecked(),
    );
  });
  it("keeps interrupted incomplete output readable without claiming saved answers", async () => {
    render(
      <GeneratedResponse
        {...owner}
        text={text.slice(0, -3)}
        streaming={false}
        onDraft={vi.fn()}
      />,
    );
    expect(
      screen.getByText(/Incomplete response; controls are unavailable/),
    ).toBeInTheDocument();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(await screen.findByRole("radio", { name: "Simple" })).toBeDisabled();
  });
  it("does not put credential inputs in generated forms", async () => {
    mocks.invoke.mockResolvedValue({
      revision: 0,
      sourceRevision: "revision",
      values: {},
      reviewedEvents: [],
    });
    render(
      <GeneratedResponse
        {...owner}
        text={
          '```openui\nroot = Stack([secret])\nsecret = Form("setup", "Connect", [{"name":"apiKey","label":"API key","required":true}], "Continue")\n```'
        }
        streaming={false}
        onDraft={vi.fn()}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Generated forms cannot request secrets",
    );
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});
