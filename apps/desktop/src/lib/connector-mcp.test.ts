import { beforeEach, describe, expect, it, vi } from "vitest";
import { openConnectorTools } from "./connector-mcp";
const mocks = vi.hoisted(() => ({ create: vi.fn(), initialize: vi.fn(), tools: vi.fn(), resources: vi.fn(), close: vi.fn() }));
vi.mock("./mcp-transport", () => ({ createDesktopRemoteMcpTransport: mocks.create }));
vi.mock("@fable/connectors/mcp/client", () => ({ McpClient: class {
  initialize = mocks.initialize; listTools = mocks.tools; listResources = mocks.resources; close = mocks.close;
} }));
beforeEach(() => { vi.resetAllMocks(); mocks.initialize.mockResolvedValue({ capabilities: { tools: true } }); mocks.tools.mockResolvedValue([{ name: "list_teams" }]); mocks.close.mockResolvedValue(undefined); });
describe("automatic Vercel account verification", () => {
  it.each([false, true])("requires a successful authenticated read after public discovery (error=%s)", async (isError) => {
    const approval = { id: "exact-read", confirmationPhrase: "read" };
    const transport = {
      recordDiscovery: vi.fn().mockResolvedValue({ enabledTools: ["list_teams"] }),
      prepareToolCall: vi.fn().mockResolvedValue({ proposal: { toolName: "list_teams" }, prepared: { requiresApproval: false, approval } }),
      authorizeToolCall: vi.fn().mockResolvedValue({ permitId: "once" }),
      executeAuthorizedToolCall: vi.fn().mockResolvedValue({ isError, content: [{ type: "text", text: "Account access unavailable" }] }),
    };
    mocks.create.mockResolvedValue(transport);
    const result = openConnectorTools("workspace", "marketplace-vercel");
    if (isError) { await expect(result).rejects.toThrow("Account access unavailable"); expect(mocks.close).toHaveBeenCalledOnce(); }
    else { expect((await result).discovery.enabledTools).toEqual(["list_teams"]); }
    expect(transport.prepareToolCall).toHaveBeenCalledWith("list_teams", {});
    expect(transport.authorizeToolCall).toHaveBeenCalledWith({ toolName: "list_teams" }, expect.objectContaining({ request: approval, decision: "once" }));
    expect(transport.executeAuthorizedToolCall).toHaveBeenCalledWith({ toolName: "list_teams" }, "once");
  });
  it("does not advertise an old public-only installation as ready", async () => {
    mocks.create.mockResolvedValue({ recordDiscovery: vi.fn().mockResolvedValue({ enabledTools: ["search_vercel_documentation"] }) });
    await expect(openConnectorTools("workspace", "marketplace-vercel")).rejects.toThrow("Reconnect Vercel");
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
