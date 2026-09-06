import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "@fable/protocol";
import { createDesktopToolExecutor } from "./desktop-tool-runtime";
const open = vi.hoisted(() => vi.fn());
vi.mock("./connector-mcp", () => ({ openConnectorTools: open }));
const approval = { id: "source", action: "connector-call", riskLevel: "critical" } as ApprovalRequest;
const input = JSON.stringify({ connectorId: "notion", toolName: "search", input: { query: "test" } });
const options = { workspaceId: "workspace-1", connectorIds: ["notion"], queueApproval: vi.fn() };
const fixture = () => ({
  tools: [{ name: "search", inputSchema: { type: "object" } }, { name: "delete", inputSchema: { type: "object" } }],
  discovery: { enabledTools: ["search"] }, client: { close: vi.fn() },
  transport: {
    prepareToolCall: vi.fn().mockResolvedValue({ proposal: { toolName: "search" }, prepared: { approval: { ...approval, id: "native" } } }),
    authorizeToolCall: vi.fn().mockResolvedValue({ permitId: "permit" }),
    executeAuthorizedToolCall: vi.fn().mockResolvedValue({ trust: "untrusted", content: [] }),
  },
});
beforeEach(() => vi.clearAllMocks());
describe("official connector agent tools", () => {
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
    await expect(executor(approval, input)).rejects.toThrow(/workspace's Connectors page/);
    expect(open).not.toHaveBeenCalled();
  });
  it("lists only enabled tools as untrusted metadata", async () => {
    const connection = fixture(); connection.client.close.mockResolvedValue(undefined); open.mockResolvedValue(connection);
    const executor = createDesktopToolExecutor({ waitForDecision: vi.fn().mockResolvedValue("granted") }, options);
    const output = await executor({ ...approval, action: "connector-tools" }, input);
    expect(output).toContain('"instructionAuthority":"none"'); expect(output).toContain("search"); expect(output).not.toContain("delete");
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
    await expect(executor(approval, input)).rejects.toThrow("connector access changed");
    expect(connection.transport.authorizeToolCall).not.toHaveBeenCalled();
    expect(connection.transport.executeAuthorizedToolCall).not.toHaveBeenCalled();
  });
});
