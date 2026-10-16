import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { DesktopMcpTransportHandle } from "../../lib/mcp-transport-contract";
import { McpAppFrame } from "./McpAppFrame";

const mocks = vi.hoisted(() => ({
  dispose: vi.fn(),
  result: vi.fn(),
  input: vi.fn(),
  constructorCount: vi.fn(),
  attachCount: vi.fn(),
  deferNextLoad: false,
  resolveNextLoad: undefined as (() => void) | undefined,
  sessionOptions: [] as Array<{ onRequestTeardown?: () => void }>,
  stateListener: undefined as
    | ((snapshot: { status: string; error?: string }) => void)
    | undefined,
}));
vi.mock("../../lib/mcp-app-host", () => ({
  McpAppHostSession: class {
    private loaded = false;
    constructor(options: { onRequestTeardown?: () => void }) {
      mocks.constructorCount();
      mocks.sessionOptions.push(options);
    }
    loadResource = async () => {
      if (mocks.deferNextLoad) {
        mocks.deferNextLoad = false;
        await new Promise<void>((resolve) => {
          mocks.resolveNextLoad = resolve;
        });
        mocks.resolveNextLoad = undefined;
      }
      this.loaded = true;
      return { html: "<p>App</p>" };
    };
    attach = async () => {
      if (!this.loaded) throw new Error("MCP App resource must load before attach.");
      mocks.attachCount();
    };
    snapshot = () => ({ status: "ready" });
    subscribeState = (
      listener: (snapshot: { status: string; error?: string }) => void,
    ) => {
      mocks.stateListener = listener;
      listener({ status: "loading" });
      return () => {
        if (mocks.stateListener === listener) mocks.stateListener = undefined;
      };
    };
    sendToolInput = mocks.input;
    sendToolResult = mocks.result;
    dispose = mocks.dispose;
  },
}));

beforeEach(() => {
  mocks.dispose.mockClear();
  mocks.result.mockClear();
  mocks.input.mockReset().mockResolvedValue(undefined);
  mocks.constructorCount.mockClear();
  mocks.attachCount.mockClear();
  mocks.deferNextLoad = false;
  mocks.resolveNextLoad = undefined;
  mocks.sessionOptions.length = 0;
  mocks.stateListener = undefined;
});

it("sends changed payloads once per live session without replaying identical rerenders", async () => {
  mocks.result.mockResolvedValue(undefined);
  const transport = {} as DesktopMcpTransportHandle;
  const tool = { name: "get-time", inputSchema: { type: "object" as const } };
  const frame = (text: string, generation = 1) => <McpAppFrame
    workspaceId="workspace" conversationId="conversation" resultId="revision" generation={generation}
    transport={transport} tool={tool} toolInput={{ zone: "UTC" }}
    toolResult={{ content: [{ type: "text", text }] }}
    registerResource={async () => "http://127.0.0.1:40000/token/index.html"}
  />;
  const view = render(frame("12:00"));
  await waitFor(() => expect(mocks.result).toHaveBeenCalledOnce());
  view.rerender(frame("12:00"));
  expect(mocks.result).toHaveBeenCalledOnce();
  expect(mocks.input).toHaveBeenCalledOnce();
  view.rerender(frame("12:01"));
  await waitFor(() => expect(mocks.result).toHaveBeenCalledTimes(2));
  expect(mocks.input).toHaveBeenCalledOnce();
  view.rerender(frame("12:01", 2));
  await waitFor(() => expect(mocks.result).toHaveBeenCalledTimes(3));
  expect(mocks.input).toHaveBeenCalledTimes(2);
});

it("retains an initialized guest when its initial load completes after the handshake", async () => {
  mocks.result.mockResolvedValue(undefined);
  const release = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn();
  const transport = { subscribeClose: () => () => undefined } as unknown as DesktopMcpTransportHandle;
  const { unmount } = render(<McpAppFrame
    workspaceId="workspace" conversationId="conversation" resultId="result" generation={1}
    transport={transport} tool={{ name: "get-time", inputSchema: { type: "object" } }}
    toolResult={{ content: [{ type: "text", text: "12:00" }] }}
    registerResource={async () => "http://127.0.0.1:40000/token/index.html"}
    releaseResource={release}
    onRequestTeardown={close}
  />);
  await waitFor(() => expect(mocks.result).toHaveBeenCalledOnce());
  fireEvent.load(screen.getByTitle("Interactive MCP App"));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(mocks.dispose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Close interactive result" }));
  expect(close).toHaveBeenCalledOnce();
  unmount();
  expect(mocks.dispose).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledOnce();
});

it("preserves the guest when an already-mounted panel announces the same target", async () => {
  const target = document.createElement("div");
  document.body.append(target);
  const view = render(<McpAppFrame
    workspaceId="workspace" conversationId="conversation" resultId="result" generation={1}
    transport={{} as DesktopMcpTransportHandle}
    tool={{ name: "get-time", inputSchema: { type: "object" } }}
    registerResource={async () => "http://127.0.0.1:40000/token/index.html"}
  />);
  await waitFor(() => expect(mocks.constructorCount).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "Expand interactive result" }));
  const announce = () => window.dispatchEvent(new CustomEvent("mivlet:mcp-app-panel-ready", {
    detail: { id: "mcp-app:workspace:conversation:result:1", target },
  }));
  act(announce);
  await waitFor(() => expect(mocks.constructorCount).toHaveBeenCalledTimes(2));
  act(announce);
  expect(mocks.constructorCount).toHaveBeenCalledTimes(2);
  expect(mocks.dispose).toHaveBeenCalledOnce();
  view.unmount();
  target.remove();
});

it("waits for the replacement session resource before attaching after docking", async () => {
  const target = document.createElement("div");
  document.body.append(target);
  const view = render(<McpAppFrame
    workspaceId="workspace" conversationId="conversation" resultId="result" generation={1}
    transport={{} as DesktopMcpTransportHandle}
    tool={{ name: "get-time", inputSchema: { type: "object" } }}
    registerResource={async () => "http://127.0.0.1:40000/token/index.html"}
  />);
  await waitFor(() => expect(mocks.constructorCount).toHaveBeenCalledOnce());
  await waitFor(() => expect(mocks.attachCount).toHaveBeenCalledOnce());
  mocks.deferNextLoad = true;
  fireEvent.click(screen.getByRole("button", { name: "Expand interactive result" }));
  act(() => window.dispatchEvent(new CustomEvent("mivlet:mcp-app-panel-ready", {
    detail: { id: "mcp-app:workspace:conversation:result:1", target },
  })));
  await waitFor(() => expect(mocks.constructorCount).toHaveBeenCalledTimes(2));
  expect(mocks.attachCount).toHaveBeenCalledOnce();
  expect(mocks.resolveNextLoad).toBeDefined();
  act(() => mocks.resolveNextLoad?.());
  await waitFor(() => expect(mocks.attachCount).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  view.unmount();
  target.remove();
});

it("announces docked panel teardown when the interactive result closes", async () => {
  const target = document.createElement("div");
  document.body.append(target);
  const closed = vi.fn();
  window.addEventListener("mivlet:mcp-app-panel-closed", closed);
  const view = render(<McpAppFrame
    workspaceId="workspace" conversationId="conversation" resultId="result" generation={1}
    transport={{} as DesktopMcpTransportHandle}
    tool={{ name: "get-time", inputSchema: { type: "object" } }}
    registerResource={async () => "http://127.0.0.1:40000/token/index.html"}
    onRequestTeardown={vi.fn()}
  />);
  await waitFor(() => expect(mocks.constructorCount).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "Expand interactive result" }));
  act(() => window.dispatchEvent(new CustomEvent("mivlet:mcp-app-panel-ready", {
    detail: { id: "mcp-app:workspace:conversation:result:1", target },
  })));
  await waitFor(() => expect(screen.getByRole("button", { name: "Close interactive result" })).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "Close interactive result" }));
  expect(closed).toHaveBeenCalledWith(expect.objectContaining({ detail: { id: "mcp-app:workspace:conversation:result:1" } }));
  window.removeEventListener("mivlet:mcp-app-panel-closed", closed);
  view.unmount();
  target.remove();
});

it("reconnects the guest when returning a docked result to the conversation", async () => {
  const target = document.createElement("div");
  document.body.append(target);
  const view = render(<McpAppFrame
    workspaceId="workspace" conversationId="conversation" resultId="result" generation={1}
    transport={{} as DesktopMcpTransportHandle}
    tool={{ name: "get-time", inputSchema: { type: "object" } }}
    registerResource={async () => "http://127.0.0.1:40000/token/index.html"}
  />);
  await waitFor(() => expect(mocks.attachCount).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "Expand interactive result" }));
  act(() => window.dispatchEvent(new CustomEvent("mivlet:mcp-app-panel-ready", {
    detail: { id: "mcp-app:workspace:conversation:result:1", target },
  })));
  await waitFor(() => expect(mocks.attachCount).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole("button", { name: "Return to conversation" }));
  await waitFor(() => {
    expect(mocks.constructorCount).toHaveBeenCalledTimes(3);
    expect(mocks.attachCount).toHaveBeenCalledTimes(3);
  });
  view.unmount();
  target.remove();
});

it("surfaces a late protocol failure and keeps close and reconnect available", async () => {
  const close = vi.fn();
  const transport = { subscribeClose: () => () => undefined } as unknown as DesktopMcpTransportHandle;
  render(<McpAppFrame
    workspaceId="workspace" conversationId="conversation" resultId="result" generation={1}
    transport={transport} tool={{ name: "get-time", inputSchema: { type: "object" } }}
    registerResource={async () => "http://127.0.0.1:40000/token/index.html"}
    onRequestTeardown={close}
  />);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Expand interactive result" }),
    ).toBeInTheDocument(),
  );
  expect(mocks.stateListener).toBeDefined();
  act(() => {
    mocks.stateListener?.({
      status: "error",
      error: "The MCP App channel closed; reopen the result.",
    });
  });
  await waitFor(() => {
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The MCP App channel closed",
    );
    fireEvent.click(screen.getByRole("button", { name: "Close and reconnect" }));
  });
  expect(close).toHaveBeenCalledOnce();
});

it("keeps latest boundary callbacks and restarts only when the transport changes", async () => {
  const transport = { subscribeClose: () => () => undefined } as unknown as DesktopMcpTransportHandle;
  const replacementTransport = { subscribeClose: () => () => undefined } as unknown as DesktopMcpTransportHandle;
  const tool = { name: "get-time", inputSchema: { type: "object" as const } };
  const firstClose = vi.fn();
  const latestClose = vi.fn();
  const view = render(
    <McpAppFrame
      workspaceId="workspace"
      conversationId="conversation"
      resultId="result"
      generation={1}
      transport={transport}
      tool={tool}
      registerResource={async () => "http://127.0.0.1:40000/token/index.html"}
      onRequestTeardown={firstClose}
    />,
  );
  await waitFor(() => expect(mocks.constructorCount).toHaveBeenCalledTimes(1));

  act(() => view.rerender(
    <McpAppFrame
      workspaceId="workspace"
      conversationId="conversation"
      resultId="result"
      generation={1}
      transport={transport}
      tool={tool}
      registerResource={async () => "http://127.0.0.1:40000/token/index.html"}
      onRequestTeardown={latestClose}
    />,
  ));
  act(() => mocks.sessionOptions[0]?.onRequestTeardown?.());
  expect(firstClose).not.toHaveBeenCalled();
  expect(latestClose).toHaveBeenCalledOnce();
  expect(mocks.constructorCount).toHaveBeenCalledTimes(1);

  act(() => view.rerender(
    <McpAppFrame
      workspaceId="workspace"
      conversationId="conversation"
      resultId="result"
      generation={1}
      transport={replacementTransport}
      tool={tool}
      registerResource={async () => "http://127.0.0.1:40000/token/index.html"}
      onRequestTeardown={latestClose}
    />,
  ));
  await waitFor(() => expect(mocks.constructorCount).toHaveBeenCalledTimes(2));
  expect(mocks.dispose).toHaveBeenCalledOnce();
});

it("creates a fresh host session when StrictMode replays an effect", async () => {
  mocks.result.mockResolvedValue(undefined);
  const transport = { subscribeClose: () => () => undefined } as unknown as DesktopMcpTransportHandle;
  const { unmount } = render(
    <StrictMode>
      <McpAppFrame
        workspaceId="workspace"
        conversationId="conversation"
        resultId="result"
        generation={1}
        transport={transport}
        tool={{ name: "get-time", inputSchema: { type: "object" } }}
        toolResult={{ content: [{ type: "text", text: "12:00" }] }}
        registerResource={async () => "http://127.0.0.1:40000/token/index.html"}
      />
    </StrictMode>,
  );

  await waitFor(() => expect(mocks.constructorCount).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(mocks.result).toHaveBeenCalledOnce());
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  unmount();
  expect(mocks.dispose).toHaveBeenCalledTimes(2);
});
