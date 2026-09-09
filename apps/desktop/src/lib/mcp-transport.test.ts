import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  close: vi.fn(),
  closeRemote: vi.fn(),
  authorize: vi.fn(),
  execute: vi.fn(),
  listen: vi.fn(),
  prepare: vi.fn(),
  openRemote: vi.fn(),
  pollRemote: vi.fn(),
  record: vi.fn(),
  spawn: vi.fn(),
  sendRemote: vi.fn(),
  write: vi.fn()
}));

vi.mock("../runtime", () => ({
  authorizeRuntimeMcpToolCall: runtime.authorize,
  closeRuntimeMcpProcess: runtime.close,
  closeRuntimeRemoteMcpSession: runtime.closeRemote,
  executeRuntimeApprovedMcpToolCall: runtime.execute,
  listenRuntimeMcpFrames: runtime.listen,
  recordRuntimeMcpDiscovery: runtime.record,
  prepareRuntimeMcpToolCall: runtime.prepare,
  openRuntimeRemoteMcpSession: runtime.openRemote,
  pollRuntimeRemoteMcpMessages: runtime.pollRemote,
  spawnRuntimeMcpProcess: runtime.spawn,
  sendRuntimeRemoteMcpFrame: runtime.sendRemote,
  writeRuntimeMcpFrame: runtime.write
}));

import { createDesktopMcpTransport, createDesktopRemoteMcpTransport } from "./mcp-transport";

let onLine: ((line: string) => void) | undefined;
let unlisten: ReturnType<typeof vi.fn>;

beforeEach(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {},
    writable: true
  });
  onLine = undefined;
  unlisten = vi.fn();
  runtime.spawn.mockReset().mockResolvedValue({
    sessionId: "mcp-1234567890abcdef1234567890abcdef",
    channel: "fable://mcp/mcp-1234567890abcdef1234567890abcdef",
    launchReference: "files"
  });
  runtime.listen.mockReset().mockImplementation(async (_channel, handler) => {
    onLine = handler;
    return unlisten;
  });
  runtime.write.mockReset().mockResolvedValue(null);
  runtime.record.mockReset().mockResolvedValue({ discoveryState: "discovered" });
  runtime.close.mockReset().mockResolvedValue(null);
  runtime.closeRemote.mockReset().mockResolvedValue(null);
  runtime.openRemote.mockReset().mockResolvedValue({
    sessionId: "mcp-fedcba0987654321fedcba0987654321",
    configurationReference: "remote-tools"
  });
  runtime.sendRemote.mockReset().mockResolvedValue([
    '{"jsonrpc":"2.0","id":"one","result":{"ok":true}}'
  ]);
  runtime.pollRemote.mockReset().mockResolvedValue({ supported: false, frames: [], retryAfterMs: 1000 });
  runtime.prepare.mockReset().mockResolvedValue({
    proposalFingerprint: "fingerprint",
    approval: {
      id: "approval-1", service: "MCP tools", action: "run MCP tool read",
      mode: "full-access", riskLevel: "critical", dataUsed: ["proposal fingerprint: fingerprint"],
      consequence: "Runs an enabled tool in user-managed local software.", requestedAt: "now",
      decisions: ["once", "deny"], confirmationPhrase: "run read"
    }
  });
  runtime.authorize.mockReset().mockResolvedValue({ permitId: "permit-1", expiresInSeconds: 60 });
  runtime.execute.mockReset().mockImplementation(async (_proposal, _permit, requestId) => {
    if (_proposal.sessionId === "mcp-fedcba0987654321fedcba0987654321") {
      return [JSON.stringify({
        jsonrpc: "2.0", id: requestId,
        result: { content: [{ type: "text", text: "remote-ok" }] }
      })];
    }
    queueMicrotask(() => onLine?.(JSON.stringify({ jsonrpc: "2.0", id: requestId, result: { content: [{ type: "text", text: "ok" }] } })));
    return [];
  });
});

afterEach(() => {
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("desktop MCP transport", () => {
  it("routes validated frames and binds writes to workspace and session", async () => {
    const transport = await createDesktopMcpTransport("workspace-a", "files");
    expect(transport).not.toBeNull();
    const received = vi.fn();
    transport!.subscribe(received);
    onLine?.('{"jsonrpc":"2.0","id":"one","result":{"ok":true}}');
    onLine?.("server log");
    expect(received).toHaveBeenCalledTimes(1);

    await transport!.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(runtime.write).toHaveBeenCalledWith(
      "workspace-a",
      "mcp-1234567890abcdef1234567890abcdef",
      '{"jsonrpc":"2.0","method":"notifications/initialized"}'
    );
  });

  it("signals process exit once and makes later writes fail", async () => {
    const transport = await createDesktopMcpTransport("workspace-a", "files");
    const closed = vi.fn();
    transport!.subscribeClose(closed);
    onLine?.("[MCP-CLOSED]");
    onLine?.("[MCP-CLOSED]");
    expect(closed).toHaveBeenCalledTimes(1);
    expect(unlisten).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(runtime.close).toHaveBeenCalledTimes(1));
    await expect(transport!.send({ jsonrpc: "2.0", method: "after" })).rejects.toThrow(
      "closed"
    );
  });

  it("cleans up a spawned child when listener setup fails", async () => {
    runtime.listen.mockResolvedValue(null);
    await expect(createDesktopMcpTransport("workspace-a", "files")).rejects.toThrow(
      "could not listen"
    );
    expect(runtime.close).toHaveBeenCalledWith(
      "workspace-a",
      "mcp-1234567890abcdef1234567890abcdef"
    );
  });

  it("closes the native process idempotently", async () => {
    const transport = await createDesktopMcpTransport("workspace-a", "files");
    await Promise.all([transport!.close(), transport!.close()]);
    expect(runtime.close).toHaveBeenCalledTimes(1);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("records discovery against the live native session", async () => {
    const transport = await createDesktopMcpTransport("workspace-a", "files");
    await transport!.recordDiscovery(["read"], ["file:///safe"]);
    expect(runtime.record).toHaveBeenCalledWith(
      "workspace-a",
      "mcp-1234567890abcdef1234567890abcdef",
      ["read"],
      ["file:///safe"]
    );
  });

  it("prepares, authorizes, and correlates an exact native tool call", async () => {
    const transport = await createDesktopMcpTransport("workspace-a", "files");
    const { proposal, prepared } = await transport!.prepareToolCall("read", { path: "safe.txt" });
    const resolution = {
      request: prepared.approval,
      decision: "once" as const,
      decidedAt: "2026-07-11T20:00:01Z",
      confirmationText: "run read"
    };
    const authorized = await transport!.authorizeToolCall(proposal, resolution);
    await expect(transport!.executeAuthorizedToolCall(proposal, authorized.permitId)).resolves.toMatchObject({
      trust: "untrusted",
      instructionAuthority: "none",
      content: [{ kind: "text", text: "ok", trust: "untrusted" }]
    });
    expect(runtime.prepare).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-a", toolName: "read", arguments: { path: "safe.txt" }
    }));
    expect(runtime.authorize).toHaveBeenCalledWith(proposal, resolution);
    expect(runtime.execute).toHaveBeenCalledWith(proposal, "permit-1", "native-mcp-tool-1");
  });

  it("routes remote frames only through the native HTTP session", async () => {
    const transport = await createDesktopRemoteMcpTransport("workspace-a", "remote-tools");
    const received = vi.fn();
    transport!.subscribe(received);
    await transport!.send({ jsonrpc: "2.0", id: "one", method: "tools/list" });
    expect(runtime.sendRemote).toHaveBeenCalledWith(
      "workspace-a",
      "mcp-fedcba0987654321fedcba0987654321",
      '{"jsonrpc":"2.0","id":"one","method":"tools/list"}'
    );
    expect(received).toHaveBeenCalledWith({
      jsonrpc: "2.0", id: "one", result: { ok: true }
    });
    await transport!.close();
    expect(runtime.closeRemote).toHaveBeenCalledWith(
      "workspace-a", "mcp-fedcba0987654321fedcba0987654321"
    );
  });

  it("starts optional standalone listening only after remote initialization", async () => {
    runtime.sendRemote.mockResolvedValueOnce([
      '{"jsonrpc":"2.0","id":"initialize-1","result":{"protocolVersion":"2025-11-25","capabilities":{},"serverInfo":{"name":"remote","version":"1"}}}'
    ]);
    const transport = await createDesktopRemoteMcpTransport("workspace-a", "remote-tools");
    await transport!.send({
      jsonrpc: "2.0",
      id: "initialize-1",
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "Mivlet", version: "0.1.0" } }
    });
    await vi.waitFor(() => expect(runtime.pollRemote).toHaveBeenCalledWith(
      "workspace-a", "mcp-fedcba0987654321fedcba0987654321"
    ));
    await transport!.close();
  });

  it("prepares, authorizes, and returns an exact remote tool response", async () => {
    const transport = await createDesktopRemoteMcpTransport("workspace-a", "remote-tools");
    const { proposal, prepared } = await transport!.prepareToolCall("read", { path: "safe.txt" });
    const resolution = {
      request: prepared.approval,
      decision: "once" as const,
      decidedAt: "2026-07-11T20:00:01Z",
      confirmationText: "run read"
    };
    const authorized = await transport!.authorizeToolCall(proposal, resolution);
    await expect(transport!.executeAuthorizedToolCall(proposal, authorized.permitId)).resolves.toMatchObject({
      trust: "untrusted",
      instructionAuthority: "none",
      content: [{ kind: "text", text: "remote-ok", trust: "untrusted" }]
    });
    expect(runtime.execute).toHaveBeenCalledWith(proposal, "permit-1", "native-mcp-tool-1");
    await transport!.close();
  });
});
