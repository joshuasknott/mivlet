import { describe, expect, it } from "vitest";
import { conversationComputerTools, conversationToolsForModel, supportsComputerVision } from "./computer-tools";
import type { BackendProvider } from "@fable/protocol";

describe("conversation computer tools", () => {
  const connector = { name: "gmail-read", description: "Read Gmail", parameters: "{}" };
  it("keeps computer tools alongside connected apps and excludes hosted runtimes", () => {
    const tools = conversationComputerTools([connector], true).map((tool) => tool.name);
    expect(tools).toEqual(expect.arrayContaining(["gmail-read", "run-shell", "read-file", "write-file", "local-browser-observe"]));
    expect(tools).not.toContain("cloud-browser");
    expect(new Set(tools).size).toBe(tools.length);
  });
  it("does not advertise unavailable computers", () => {
    expect(conversationComputerTools([connector], false).map((tool) => tool.name)).toEqual(["gmail-read", "web-fetch"]);
  });
  it("keeps public URL reads available without Docker and deduplicates them", () => {
    const tools = conversationComputerTools([], false);
    expect(tools.map((tool) => tool.name)).toEqual(["web-fetch"]);
    expect(conversationComputerTools(tools, false)).toEqual(tools);
  });
  it("resolves visual access against the executing model on every turn", () => {
    const provider = { backendType: "codex-app-server", authState: "connected", capabilities: ["tool-requests"] } as BackendProvider;
    const vision = { id: "vision", label: "Vision", available: true, capabilities: { vision: true } };
    expect(conversationToolsForModel([], true, provider, vision).map((tool) => tool.name)).toContain("local-desktop-observe");
    expect(conversationToolsForModel([], true, provider, { ...vision, available: false }).map((tool) => tool.name)).not.toContain("local-desktop-observe");
    expect(conversationToolsForModel([], false, provider, vision).map((tool) => tool.name)).toEqual(["web-fetch"]);
  });
  it("only advertises visual tools with a supported native image route", () => {
    expect(conversationComputerTools([], true).map((tool) => tool.name)).not.toContain("local-desktop-observe");
    expect(conversationComputerTools([], true, true).map((tool) => tool.name)).toEqual(expect.arrayContaining(["local-desktop-observe", "local-desktop-action"]));
    const provider = { backendType: "codex-app-server", authState: "connected", capabilities: ["tool-requests"] } as BackendProvider;
    expect(supportsComputerVision(provider, {id:"vision",label:"Vision",available:true,capabilities:{vision:true}})).toBe(true);
    expect(supportsComputerVision(provider, {id:"unknown",label:"Unknown",available:true})).toBe(false);
    expect(supportsComputerVision({...provider, backendType:"native-api"}, {id:"vision",label:"Vision",available:true,capabilities:{vision:true}})).toBe(false);
  });
});
