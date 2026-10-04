import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "@mivlet/protocol";
import { createDesktopToolExecutor } from "./desktop-tool-runtime";
import { customMcpConnectorId } from "./custom-mcp";
const open = vi.hoisted(() => vi.fn());
const providerCheck = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("./connector-mcp", () => ({ openConnectorTools: open }));
vi.mock("../runtime/domains/providers", () => ({ checkRuntimeManagedTool: providerCheck }));
const approval = { id: "source", action: "connector-call", riskLevel: "critical" } as ApprovalRequest;
const input = JSON.stringify({ connectorId: "notion", toolName: "search", input: { query: "test" } });
const options = { workspaceId: "workspace-1", connectorIds: ["notion"], queueApproval: vi.fn() };
const fixture = () => ({
  resources: [{ uri: "notion://safe", name: "Brief" }, { uri: "notion://disabled", name: "Private" }],
  tools: [{ name: "search", inputSchema: { type: "object" } }, { name: "delete", inputSchema: { type: "object" } }],
  discovery: { enabledTools: ["search"], enabledResources: ["notion://safe"] }, client: { close: vi.fn().mockResolvedValue(undefined) },
  transport: {
    prepareResourceRead: vi.fn().mockResolvedValue({ proposal: { operation: "resource", toolName: "resources/read", arguments: { uri: "notion://safe" } }, prepared: { approval: { ...approval, id: "native-resource" } } }),
    prepareToolCall: vi.fn().mockResolvedValue({ proposal: { toolName: "search" }, prepared: { approval: { ...approval, id: "native" } } }),
    authorizeToolCall: vi.fn().mockResolvedValue({ permitId: "permit" }),
    executeAuthorizedToolCall: vi.fn().mockResolvedValue({ trust: "untrusted", content: [] }),
  },
});
beforeEach(() => vi.clearAllMocks());
describe("official connector agent tools", () => {
  it("closes an in-flight app task on Stop and discards a later success", async () => {
    vi.useFakeTimers();
    try {
      const connection = fixture(); open.mockResolvedValue(connection);
      let cancelled = false;
      let finish!: (value: unknown) => void;
      let started!: () => void;
      const dispatched = new Promise<void>(resolve => { started = resolve; });
      connection.transport.executeAuthorizedToolCall.mockImplementationOnce(() => { started(); return new Promise(resolve => { finish = resolve; }); });
      const executor = createDesktopToolExecutor({ waitForDecision: vi.fn().mockResolvedValue("granted") }, { ...options, shouldCancel: () => cancelled });
      const pending = executor(approval, input);
      const result = expect(pending).rejects.toThrow("External effects already accepted");
      await dispatched;
      cancelled = true;
      await vi.advanceTimersByTimeAsync(50);
      await result;
      expect(connection.client.close).toHaveBeenCalledOnce();
      finish({ trust: "untrusted", content: [{ type: "text", text: "late success" }] });
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it("uses an admitted custom server through the same exact native tool permit", async () => {
    const connection = fixture(); open.mockResolvedValue(connection);
    const connectorId = customMcpConnectorId("local-brief")!;
    const executor = createDesktopToolExecutor({ waitForDecision: vi.fn().mockResolvedValue("granted") }, { ...options, connectorIds: [connectorId] });
    await executor(approval, JSON.stringify({ connectorId, toolName: "search", input: { query: "test" } }));
    expect(open).toHaveBeenCalledWith("workspace-1", "local-brief");
    expect(connection.transport.executeAuthorizedToolCall).toHaveBeenCalledWith({ toolName: "search" }, "permit");
  });
  it("reads only an enabled resource through its exact native proposal and closes the session", async () => {
    const connection = fixture(); open.mockResolvedValue(connection);
    const executor = createDesktopToolExecutor({ waitForDecision: vi.fn().mockResolvedValue("granted") }, options);
    await executor({ ...approval, action: "connector-resource" }, JSON.stringify({ connectorId: "notion", uri: "notion://safe" }));
    expect(connection.transport.prepareResourceRead).toHaveBeenCalledWith("notion://safe");
    expect(connection.transport.prepareToolCall).not.toHaveBeenCalled();
    expect(connection.transport.executeAuthorizedToolCall).toHaveBeenCalledWith({ operation: "resource", toolName: "resources/read", arguments: { uri: "notion://safe" } }, "permit");
    expect(connection.client.close).toHaveBeenCalled();
  });
  it("rejects undiscovered or disabled resources before preparing a permit", async () => {
    const connection = fixture(); open.mockResolvedValue(connection);
    const executor = createDesktopToolExecutor({ waitForDecision: vi.fn().mockResolvedValue("granted") }, options);
    await expect(executor({ ...approval, action: "connector-resource" }, JSON.stringify({ connectorId: "notion", uri: "notion://disabled" }))).rejects.toThrow("enabled connector");
    expect(connection.transport.prepareResourceRead).not.toHaveBeenCalled();
  });
  it("blocks Stop during approval before an app operation is authorized", async () => {
    const connection = fixture(); open.mockResolvedValue(connection);
    let cancelled = false;
    const executor = createDesktopToolExecutor({ waitForDecision: vi.fn(async () => { cancelled = true; return "granted" as const; }) }, { ...options, shouldCancel: () => cancelled });
    await expect(executor(approval, input)).rejects.toThrow("This connected app task was cancelled or its access changed.");
    expect(connection.transport.authorizeToolCall).not.toHaveBeenCalled();
  });
  it("rejects an old generation at the approval boundary before its first timer tick", async () => {
    const connection = fixture(); open.mockResolvedValue(connection);
    let current = { workspaceId: "workspace-1", agentId: "agent", generation: 1, ready: false, controller: "agent" as const };
    const executor = createDesktopToolExecutor({ waitForDecision: vi.fn(async () => { current = { ...current, generation: 2 }; return "granted" as const; }) }, { ...options, localComputerCurrent: () => current });
    await expect(executor(approval, input)).rejects.toThrow("This connected app task was cancelled or its access changed.");
    expect(connection.transport.authorizeToolCall).not.toHaveBeenCalled();
    expect(connection.client.close).toHaveBeenCalledOnce();
  });
  it("blocks Stop during the final provider check before external dispatch", async () => {
    const connection = fixture(); open.mockResolvedValue(connection);
    let cancelled = false;
    providerCheck.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => { cancelled = true; });
    const executor = createDesktopToolExecutor({ waitForDecision: vi.fn().mockResolvedValue("granted") }, { ...options, shouldCancel: () => cancelled });
    await expect(executor({ ...approval, id: "mivlet-shared-test" }, input)).rejects.toThrow("cancelled");
    expect(connection.transport.authorizeToolCall).toHaveBeenCalledOnce();
    expect(connection.transport.executeAuthorizedToolCall).not.toHaveBeenCalled();
    expect(connection.client.close).toHaveBeenCalledOnce();
  });
  it("propagates provider isError as failure and closes the connection", async () => {
    const connection = fixture(); connection.client.close.mockResolvedValue(undefined);
    connection.transport.executeAuthorizedToolCall.mockResolvedValue({ isError: true, content: [{ type: "text", text: "Permission denied. Reconnect Notion." }] });
    open.mockResolvedValue(connection);
    const executor = createDesktopToolExecutor({ waitForDecision: vi.fn().mockResolvedValue("granted") }, options);
    await expect(executor(approval, input)).rejects.toThrow("Permission denied. Reconnect Notion.");
    expect(connection.client.close).toHaveBeenCalledOnce();
  });
  it("executes native-classified routine reads without a user prompt and retains exact permits", async () => {
    const connection = fixture();
    connection.client.close.mockResolvedValue(undefined);
    connection.transport.prepareToolCall.mockResolvedValue({ proposal: { toolName: "search" }, prepared: { approval: { ...approval, id: "native" }, requiresApproval: false } });
    open.mockResolvedValue(connection);
    const waitForDecision = vi.fn();
    await createDesktopToolExecutor({ waitForDecision }, options)(approval, input);
    expect(waitForDecision).not.toHaveBeenCalled();
    expect(options.queueApproval).not.toHaveBeenCalled();
    expect(connection.transport.authorizeToolCall).toHaveBeenCalledWith({ toolName: "search" }, expect.objectContaining({ request: expect.objectContaining({ id: "native" }) }));
    expect(connection.transport.executeAuthorizedToolCall).toHaveBeenCalledWith({ toolName: "search" }, "permit");
  });
  it("blocks unavailable workspace connectors before network access", async () => {
    const executor = createDesktopToolExecutor({ waitForDecision: vi.fn().mockResolvedValue("granted") }, { ...options, connectorIds: [] });
    await expect(executor(approval, input)).rejects.toThrow(/workspace's Plugins page/);
    expect(open).not.toHaveBeenCalled();
  });
  it("lists only enabled tools as untrusted metadata", async () => {
    const connection = fixture(); connection.client.close.mockResolvedValue(undefined); open.mockResolvedValue(connection);
    const executor = createDesktopToolExecutor({ waitForDecision: vi.fn().mockResolvedValue("granted") }, options);
    const output = await executor({ ...approval, action: "connector-tools" }, input);
    expect(output).toContain('"instructionAuthority":"none"'); expect(output).toContain("search"); expect(output).not.toContain("delete");
    expect(output).toContain("notion://safe"); expect(output).not.toContain("notion://disabled");
    expect(connection.client.close).toHaveBeenCalled();
  });
  it("uses the exact native proposal and single-use permit", async () => {
    const connection = fixture(); connection.client.close.mockResolvedValue(undefined); open.mockResolvedValue(connection);
    const waitForDecision = vi.fn().mockResolvedValue("granted");
    const executor = createDesktopToolExecutor({ waitForDecision }, options);
    await executor(approval, input);
    expect(waitForDecision).toHaveBeenCalledTimes(1);
    expect(waitForDecision).toHaveBeenCalledWith(expect.objectContaining({ id: "native" }));
    expect(options.queueApproval).toHaveBeenCalledWith(expect.objectContaining({ id: "native" }), "connector-call", input);
    expect(connection.transport.executeAuthorizedToolCall).toHaveBeenCalledWith({ toolName: "search" }, "permit");
  });
  it("denies native approval and closes without an external action", async () => {
    const connection = fixture(); connection.client.close.mockResolvedValue(undefined); open.mockResolvedValue(connection);
    const executor = createDesktopToolExecutor({ waitForDecision: vi.fn().mockResolvedValueOnce("denied") }, options);
    await expect(executor(approval, input)).rejects.toThrow("Connector action was denied");
    expect(connection.transport.authorizeToolCall).not.toHaveBeenCalled(); expect(connection.client.close).toHaveBeenCalled();
  });
  it("rejects access removed during discovery", async () => {
    const connection = fixture(); connection.discovery.enabledTools = []; connection.client.close.mockResolvedValue(undefined); open.mockResolvedValue(connection);
    const executor = createDesktopToolExecutor({ waitForDecision: vi.fn().mockResolvedValue("granted") }, options);
    await expect(executor(approval, input)).rejects.toThrow("Choose an enabled connector tool");
    expect(connection.transport.prepareToolCall).not.toHaveBeenCalled();
  });
  it("rechecks agent access after approval before granting a native permit", async () => {
    const connection = fixture(); connection.client.close.mockResolvedValue(undefined); open.mockResolvedValue(connection);
    let allowed = true;
    const decision = vi.fn().mockImplementationOnce(async () => { allowed = false; return "granted"; });
    const executor = createDesktopToolExecutor({ waitForDecision: decision }, { ...options, connectorAccessCurrent: () => allowed });
    await expect(executor(approval, input)).rejects.toThrow("This connected app task was cancelled or its access changed.");
    expect(connection.transport.authorizeToolCall).not.toHaveBeenCalled();
    expect(connection.transport.executeAuthorizedToolCall).not.toHaveBeenCalled();
  });
});
