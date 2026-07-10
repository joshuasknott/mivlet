import type { AcpRequest, AcpTransport } from "@fable/connectors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  close: vi.fn(),
  listen: vi.fn(),
  spawn: vi.fn(),
  write: vi.fn()
}));

vi.mock("../runtime", () => ({
  closeRuntimeAcpProcess: runtime.close,
  listenRuntimeAcpFrames: runtime.listen,
  spawnRuntimeAcpProcess: runtime.spawn,
  writeRuntimeAcpFrame: runtime.write
}));

import {
  createDesktopAcpTransportFactory,
  type DesktopAcpTransportOptions
} from "./acp-transport";

const initializeRequest: AcpRequest = {
  jsonrpc: "2.0",
  id: "initialize-1",
  method: "initialize",
  params: {}
};

let onFrame: ((line: string) => void) | null;
let unlisten: ReturnType<typeof vi.fn>;

function installDesktopRuntime(): void {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {},
    writable: true
  });
}

async function startedTransport(
  options: DesktopAcpTransportOptions = {}
): Promise<AcpTransport> {
  const transport = createDesktopAcpTransportFactory(options)({ id: "copilot" });
  expect(transport).not.toBeNull();
  await transport!.send({
    jsonrpc: "2.0",
    method: "client/ready",
    params: {}
  });
  runtime.write.mockClear();
  return transport!;
}

beforeEach(() => {
  installDesktopRuntime();
  onFrame = null;
  unlisten = vi.fn();
  runtime.spawn.mockReset().mockResolvedValue({
    sessionId: "acp-session-1",
    cwd: "C:\\workspace"
  });
  runtime.listen.mockReset().mockImplementation(async (_sessionId, callback) => {
    onFrame = callback;
    return unlisten;
  });
  runtime.write.mockReset().mockResolvedValue(null);
  runtime.close.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("desktop ACP transport lifecycle", () => {
  it("settles every pending request and ends frame iteration when the process exits", async () => {
    const transport = await startedTransport();
    const initialize = transport.request(initializeRequest);
    const newSession = transport.request({
      jsonrpc: "2.0",
      id: "session-1",
      method: "session/new",
      params: {}
    });
    const nextFrame = transport.frames()[Symbol.asyncIterator]().next();

    await vi.waitFor(() => expect(runtime.write).toHaveBeenCalledTimes(2));
    onFrame?.("[ACP-CLOSED]");

    await expect(initialize).resolves.toMatchObject({
      ok: false,
      error: { code: -32001 }
    });
    await expect(newSession).resolves.toMatchObject({
      ok: false,
      error: { code: -32001 }
    });
    await expect(nextFrame).resolves.toEqual({ done: true, value: undefined });
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(runtime.close).toHaveBeenCalledTimes(1);

    await expect(transport.request({ ...initializeRequest, id: "after-close" })).resolves
      .toMatchObject({ ok: false, error: { code: -32001 } });
  });

  it("uses separate bounded timeouts for lifecycle and prompt requests", async () => {
    vi.useFakeTimers();
    const transport = await startedTransport({
      controlRequestTimeoutMs: 25,
      promptRequestTimeoutMs: 60
    });

    const control = transport.request(initializeRequest);
    const prompt = transport.request({
      jsonrpc: "2.0",
      id: "prompt-1",
      method: "session/prompt",
      params: {}
    });
    const promptSettled = vi.fn();
    void prompt.then(promptSettled);

    await vi.advanceTimersByTimeAsync(25);
    await expect(control).resolves.toMatchObject({
      ok: false,
      error: { code: -32002, message: "ACP initialize timed out after 25 ms." }
    });
    expect(promptSettled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(35);
    await expect(prompt).resolves.toMatchObject({
      ok: false,
      error: { code: -32002, message: "ACP session/prompt timed out after 60 ms." }
    });
  });

  it("clears a request timeout when a correlated response arrives", async () => {
    vi.useFakeTimers();
    const transport = await startedTransport({ controlRequestTimeoutMs: 10 });
    const reply = transport.request(initializeRequest);
    await vi.advanceTimersByTimeAsync(0);

    onFrame?.(
      JSON.stringify({
        jsonrpc: "2.0",
        id: initializeRequest.id,
        result: { protocolVersion: 1 }
      })
    );

    await expect(reply).resolves.toEqual({
      ok: true,
      result: { protocolVersion: 1 }
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles pending work and shuts the process down once on explicit close", async () => {
    const transport = await startedTransport();
    const pending = transport.request(initializeRequest);
    const nextFrame = transport.frames()[Symbol.asyncIterator]().next();
    await vi.waitFor(() => expect(runtime.write).toHaveBeenCalledTimes(1));

    await Promise.all([transport.close(), transport.close()]);

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: -32001 }
    });
    await expect(nextFrame).resolves.toEqual({ done: true, value: undefined });
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(runtime.close).toHaveBeenCalledTimes(1);
    await expect(transport.send({ jsonrpc: "2.0", method: "after-close" })).rejects.toThrow(
      "ACP process closed"
    );
  });

  it("removes a spawned process when listener setup fails", async () => {
    runtime.listen.mockResolvedValue(null);
    const transport = createDesktopAcpTransportFactory()({ id: "copilot" });
    expect(transport).not.toBeNull();

    await expect(transport!.request(initializeRequest)).rejects.toThrow(
      "Fable could not listen to the ACP CLI."
    );
    expect(runtime.close).toHaveBeenCalledTimes(1);
    expect(runtime.close).toHaveBeenCalledWith("acp-session-1");
  });

  it("kills a process that finishes spawning after close has started", async () => {
    let finishSpawn!: (value: { sessionId: string; cwd: string }) => void;
    runtime.spawn.mockReturnValue(
      new Promise((resolve) => {
        finishSpawn = resolve;
      })
    );
    const transport = createDesktopAcpTransportFactory()({ id: "copilot" });
    expect(transport).not.toBeNull();

    const request = transport!.request(initializeRequest);
    await Promise.resolve();
    const closing = transport!.close();
    finishSpawn({ sessionId: "late-session", cwd: "C:\\workspace" });

    await closing;
    await expect(request).rejects.toThrow("ACP process closed");
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(runtime.close).toHaveBeenCalledTimes(1);
    expect(runtime.close).toHaveBeenCalledWith("late-session");
  });
});
