import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeneratedResponse } from "./GeneratedResponse";
import instructions from "../../../lib/rich-interface-instructions.json";
import { extractGeneratedInterface } from "../../../lib/generated-interface";
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
  vi.useRealTimers();
});
describe("production generated response", () => {
  it("renders the shipped provider example, restores persisted state, and reviews a deliberate follow-up", async () => {
    const example = extractGeneratedInterface(instructions.instructions)!;
    const answer = `Here is the calculator.\n\`\`\`openui-v2\n${example.code}\`\`\``;
    const draft = vi.fn();
    let revision = 1;
    mocks.invoke.mockImplementation(async (_owner, request) => {
      if (request.action === "review-interface") return {
        state: { revision: ++revision, sourceRevision: "saved-example", values: {}, reviewedEvents: ["reviewed"] },
        draft: "Refine the plan with four people.",
      };
      return {
        revision: request.action === "save-interface" ? ++revision : revision,
        sourceRevision: "saved-example",
        values: request.values ?? { openuiState: '{"$people":2}' },
        reviewedEvents: [],
      };
    });
    render(<GeneratedResponse {...owner} source={answer} text={answer} streaming={false} onDraft={draft} />);
    expect(await screen.findByText("Each person pays £40", {}, { timeout: 10000 })).toBeVisible();
    fireEvent.change(screen.getByLabelText("People"), { target: { value: "4" } });
    expect(await screen.findByText("Each person pays £20")).toBeVisible();
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "save-interface", source: answer, values: expect.objectContaining({ openuiState: expect.stringContaining('"$people":4') }),
    })));
    expect(draft).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Refine this plan" }));
    await waitFor(() => expect(draft).toHaveBeenCalledWith("Refine the plan with four people."));
  }, 15000); // Includes a cold lazy import of OpenUI's chart/schema graph.
  it("offers repair for a provider-generated unsupported component without granting authority", async () => {
    const invalid = '```openui-v2\nroot = Query("run", {})\n```';
    mocks.invoke.mockResolvedValue({ revision: 0, sourceRevision: "saved", values: {}, reviewedEvents: [] });
    const draft = vi.fn();
    render(<GeneratedResponse {...owner} source={invalid} text={invalid} streaming={false} onDraft={draft} />);
    const repair = await screen.findByRole("button", { name: "Ask agent to repair response" });
    expect(draft).not.toHaveBeenCalled();
    fireEvent.click(repair);
    expect(draft).toHaveBeenCalledWith(expect.stringContaining("revision revision-1"));
    expect(mocks.invoke.mock.calls.every(([, request]) => request.action === "load-interface")).toBe(true);
  });
  it("reloads saved answers after a native read failure", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("Store is temporarily unavailable")).mockResolvedValue({ revision: 1, sourceRevision: "saved", values: { route: "Detailed" }, reviewedEvents: [] });
    render(<GeneratedResponse {...owner} text={text} streaming={false} onDraft={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Reload saved answers" }));
    expect(await screen.findByRole("radio", { name: "Detailed" })).toBeChecked();
    expect(screen.queryByText("Store is temporarily unavailable")).not.toBeInTheDocument();
  });
  it("ends a stalled native state wait and ignores the late response", async () => {
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    mocks.invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(<GeneratedResponse {...owner} text={text} streaming={false} onDraft={vi.fn()} />);
    await act(async () => { vi.advanceTimersByTime(20_000); });
    expect(screen.getByRole("button", { name: "Reload saved answers" })).toBeEnabled();
    expect(screen.getByRole("alert")).toHaveTextContent(/did not respond in time/);
    await act(async () => finish({ revision: 4, sourceRevision: "late", values: { route: "Detailed" }, reviewedEvents: [] }));
    expect(screen.queryByText("Saved on this device")).toBeNull();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });
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
