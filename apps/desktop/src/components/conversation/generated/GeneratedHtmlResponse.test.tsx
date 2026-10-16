import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import GeneratedHtmlResponse from "./GeneratedHtmlResponse";
import { extractGeneratedHtml } from "../../../lib/generated-html";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("../../../runtime/domains/conversation-ui", () => ({
  conversationUi: invoke,
}));
const source =
  "Try this.\n```mivlet-html\n<html><body><button>Increase</button></body></html>\n```\nIt runs locally.";
const resource = {
  resourceId: "a".repeat(64),
  url: `http://127.0.0.2:43127/${"a".repeat(64)}/index.html`,
};
const props = {
  text: source,
  source,
  streaming: false,
  workspaceId: "workspace",
  conversationId: "room",
  agentId: "agent",
  runId: "run",
};
beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(resource);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
describe("generated HTML authority and lifecycle", () => {
  it("removes executable content when its native resource lifetime expires", async () => {
    vi.useFakeTimers();
    render(<GeneratedHtmlResponse {...props} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open preview" }));
    });
    expect(document.querySelector("iframe")).not.toBeNull();
    fireEvent.load(document.querySelector("iframe")!);
    act(() => {
      vi.advanceTimersByTime(15 * 60 * 1000);
    });
    expect(document.querySelector("iframe")).toBeNull();
    expect(invoke).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "close-html" }),
    );
  });
  it("stops executable previews when their compact conversation pane is hidden", async () => {
    const view = render(
      <div className="conversation-dock">
        <GeneratedHtmlResponse {...props} />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open preview" }));
    await screen.findByRole("button", { name: "Close preview" });
    view.container.firstElementChild!.setAttribute("hidden", "");
    await waitFor(() => expect(document.querySelector("iframe")).toBeNull());
    expect(invoke).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "close-html" }),
    );
  });
  it("parses complete bounded previews while preserving ordinary text", () => {
    expect(extractGeneratedHtml(source)).toMatchObject({
      before: "Try this.\n",
      after: "\nIt runs locally.",
      complete: true,
      error: "",
    });
    expect(extractGeneratedHtml("ordinary text")).toBeNull();
    expect(extractGeneratedHtml("```mivlet-html\nunfinished")).toMatchObject({
      complete: false,
    });
    expect(extractGeneratedHtml(source + source)?.error).toBeTruthy();
    expect(
      extractGeneratedHtml("```mivlet-html\n" + "x".repeat(80001) + "\n```")
        ?.error,
    ).toBeTruthy();
    expect(extractGeneratedHtml("```mivlet-html\n" + "界".repeat(27000) + "\n```")?.error).toBeTruthy();
    expect(extractGeneratedHtml("```mivlet-html\n  \n```")?.error).toBeTruthy();
  });
  it("requires a user gesture and passes only the exact source to native validation", async () => {
    render(<GeneratedHtmlResponse {...props} />);
    expect(invoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open preview" }));
    const close = await screen.findByRole("button", { name: "Close preview" });
    expect(invoke).toHaveBeenCalledWith(
      { workspaceId: "workspace", conversationId: "room", agentId: "agent" },
      { action: "render-html", runId: "run", source },
    );
    const frame = document.querySelector("iframe")!;
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(frame).not.toHaveAttribute("srcdoc");
    fireEvent.click(close);
    expect(document.querySelector("iframe")).toBeNull();
    expect(invoke).toHaveBeenLastCalledWith(expect.anything(), {
      action: "close-html",
      runId: "run",
      resourceId: resource.resourceId,
    });
  });
  it("does not execute incomplete, streaming or unsaved responses", () => {
    const view = render(<GeneratedHtmlResponse {...props} streaming />);
    expect(screen.getByRole("button", { name: "Open preview" })).toBeDisabled();
    view.rerender(<GeneratedHtmlResponse {...props} source={undefined} />);
    expect(screen.getByRole("button", { name: "Open preview" })).toBeDisabled();
    view.rerender(
      <GeneratedHtmlResponse {...props} text={"```mivlet-html\nunfinished"} />,
    );
    expect(screen.getByRole("button", { name: "Open preview" })).toBeDisabled();
    expect(invoke).not.toHaveBeenCalled();
  });
  it("releases late registration after unmount without ever displaying the guest", async () => {
    let resolve!: (value: typeof resource) => void;
    invoke.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const view = render(<GeneratedHtmlResponse {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Open preview" }));
    view.unmount();
    resolve(resource);
    await waitFor(() =>
      expect(invoke).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "close-html" }),
      ),
    );
    expect(document.querySelector("iframe")).toBeNull();
  });
  it("recovers from a stalled native open and releases its late resource", async () => {
    vi.useFakeTimers();
    let finish!: (value: typeof resource) => void;
    invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(<GeneratedHtmlResponse {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Open preview" }));
    act(() => { vi.advanceTimersByTime(20_000); });
    expect(screen.getByRole("button", { name: "Retry preview" })).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent(/too long/);
    await act(async () => finish(resource));
    expect(document.querySelector("iframe")).toBeNull();
    expect(invoke).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ action: "close-html", resourceId: resource.resourceId }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry preview" })); });
    expect(document.querySelector("iframe")).not.toBeNull();
  });
  it("refuses a mismatched resource capability and allows retry when the guest does not load", async () => {
    invoke.mockResolvedValueOnce({ ...resource, resourceId: "b".repeat(64) });
    render(<GeneratedHtmlResponse {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Open preview" }));
    expect(await screen.findByRole("status")).toHaveTextContent(/isolated preview origin/);
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry preview" })); });
    act(() => { vi.advanceTimersByTime(20_000); });
    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.getByRole("button", { name: "Retry preview" })).toBeEnabled();
  });
  it("releases the old owner on branch/source change and rejects external or IPC URLs", async () => {
    const view = render(<GeneratedHtmlResponse {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Open preview" }));
    await screen.findByRole("button", { name: "Close preview" });
    view.rerender(
      <GeneratedHtmlResponse
        {...props}
        conversationId="other-room"
        source="another revision"
      />,
    );
    expect(document.querySelector("iframe")).toBeNull();
    expect(invoke).toHaveBeenLastCalledWith(
      expect.objectContaining({ conversationId: "room" }),
      expect.objectContaining({ action: "close-html" }),
    );
    invoke.mockResolvedValueOnce({ ...resource, url: "http://ipc.localhost/" });
    fireEvent.click(screen.getByRole("button", { name: "Open preview" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      /isolated preview origin/,
    );
    expect(document.querySelector("iframe")).toBeNull();
  });
});
