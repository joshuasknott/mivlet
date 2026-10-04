import { describe, expect, it } from "vitest";
import { conversationComputerTools, conversationToolsForModel, supportsComputerVision, computerToolsReady, isLocalComputerTool } from "./computer-tools";
import type { BackendProvider, LocalComputerSnapshot } from "@mivlet/protocol";

describe("conversation computer tools", () => {
  it("offers repository tools only on routes with the Mivlet tool bridge", () => {
    const model = { id: "model", label: "model", available: true };
    const provider = { backendType: "codex-app-server", authState: "connected", capabilities: ["tool-requests"] } as BackendProvider;
    const names = (route: BackendProvider) => conversationToolsForModel([], true, route, model, { computer: true }).map(tool => tool.name);
    expect(names(provider)).toContain("repository-run");
    expect(names({ ...provider, backendType: "native-api" })).toContain("repository-publish");
    expect(names({ ...provider, backendType: "claude-agent", driverKind: "claude-agent" })).toContain("repository-run");
    expect(names({ ...provider, backendType: "claude-agent", driverKind: "claude-agent" })).not.toContain("local-desktop-observe");
    expect(names({ ...provider, driverKind: "claude-agent" })).not.toContain("repository-run");
    expect(names({ ...provider, authState: "sign-in-required" })).not.toContain("repository-run");
  });
  const enabled = { computer: true };
  const connector = { name: "gmail-read", description: "Read Gmail", parameters: "{}" };
  it("hides native app tools when the bundled runtime is missing while preserving scoped files", () => {
    const prior = conversationComputerTools([connector], true, true, enabled);
    const names = conversationComputerTools(prior, true, true, enabled, false, false).map(tool => tool.name);
    expect(names).toEqual(expect.arrayContaining(["gmail-read", "read-file", "write-file", "workspace-run", "create-spreadsheet", "create-document", "create-pdf", "computer-artifact"]));
    expect(names.some(name => name.startsWith("local-app-") || name.startsWith("local-desktop-") || name.startsWith("local-browser-"))).toBe(false);
  });
  it("requires a separate image API connection and Computer plugin even for previously discovered image tools", () => {
    const discovered = ["generate-image", "edit-image"].map((name) => ({ name, description: "Image API", parameters: "{}" }));
    expect(conversationComputerTools(discovered, true, true, enabled).map((tool) => tool.name)).not.toContain("generate-image");
    expect(conversationComputerTools(discovered, true, true, { computer: false }, true).map((tool) => tool.name)).not.toContain("edit-image");
    expect(conversationComputerTools(discovered, false, true, enabled, true).map((tool) => tool.name)).not.toContain("generate-image");
    expect(conversationComputerTools(discovered, true, false, enabled, true).map((tool) => tool.name)).toEqual(expect.arrayContaining(["generate-image", "edit-image"]));
    expect(isLocalComputerTool("generate-image", "{}")).toBe(true);
    expect(isLocalComputerTool("edit-image", "{}")).toBe(true);
  });
  it("requires current scope authority for scoped computer tools", () => {
    const computer = { lifecycle: "ready", controller: "agent" } as LocalComputerSnapshot;
    expect(computerToolsReady(computer)).toBe(true);
    expect(computerToolsReady({ ...computer, controller: "paused" })).toBe(false);
    expect(computerToolsReady(null)).toBe(false);
    expect(isLocalComputerTool("create-spreadsheet", "{}")).toBe(true);
    expect(isLocalComputerTool("create-document", "{}")).toBe(true);
  });
  it("keeps Codex on subscription images even with a connected image API", () => {
    const provider = { backendType: "codex-app-server", authState: "connected", capabilities: ["tool-requests"] } as BackendProvider;
    const model = { id: "image-capable", label: "Image capable", available: true };
    const discovered = ["generate-image", "edit-image"].map(name => ({ name, description: "Metered API", parameters: "{}" }));
    const tools = conversationToolsForModel(discovered, true, provider, model, enabled, true);
    expect(tools.some(tool => ["generate-image", "edit-image"].includes(tool.name))).toBe(false);
    expect(tools.map(tool => tool.name)).toContain("computer-artifact");
    const direct = conversationToolsForModel(discovered, true, { ...provider, backendType: "native-api" }, model, enabled, true);
    expect(direct.map(tool => tool.name)).toEqual(expect.arrayContaining(["generate-image", "edit-image"]));
  });
  it("keeps computer tools alongside connected apps and excludes hosted runtimes", () => {
    const tools = conversationComputerTools([connector], true, false, enabled).map((tool) => tool.name);
    expect(tools).toEqual(expect.arrayContaining(["gmail-read", "read-file", "write-file", "local-app-observe"]));
    expect(tools).not.toContain("cloud-browser");
    expect(new Set(tools).size).toBe(tools.length);
  });
  it("fails closed for unknown settings and removes stale connected computer tools", () => {
    const previous = conversationComputerTools([], true, true, enabled);
    expect(conversationComputerTools(previous, true, true).map(tool => tool.name)).toEqual(["web-fetch"]);
  });
  it("replaces stale browser specifications and removes retired action and shell tools", () => {
    const previous = ["run-shell", "local-browser-action", "local-browser-observe"].map(name => ({ name, description: "old", parameters: "{}" }));
    const names = conversationComputerTools(previous, true, true, enabled).map(tool => tool.name);
    expect(names).not.toContain("run-shell");
    expect(names.filter(name => name.startsWith("local-browser"))).toEqual(["local-browser-observe", "local-browser-open", "local-browser-tabs", "local-browser-navigate", "local-browser-click"]);
    expect(conversationComputerTools(previous, true, true, enabled).find(tool => tool.name === "local-browser-observe")?.description).toContain("top-frame");
    expect(names).toContain("local-app-observe");
  });
  it("offers the same text browser reads through Codex, Claude and direct API routes", () => {
    const provider = { backendType: "codex-app-server", authState: "connected", capabilities: ["tool-requests"] } as BackendProvider;
    const model = { id: "text-model", label: "Text model", available: true };
    for (const route of [provider, { ...provider, backendType: "native-api" }, { ...provider, backendType: "claude-agent", driverKind: "claude-agent" }] as BackendProvider[]) {
      const names = conversationToolsForModel([], true, route, model, enabled).map(tool => tool.name);
      expect(names).toEqual(expect.arrayContaining(["local-browser-tabs", "local-browser-observe", "local-browser-navigate", "local-browser-click"]));
      expect(names).not.toContain("local-desktop-observe");
    }
  });
  it("does not advertise unavailable computers", () => {
    expect(conversationComputerTools([connector], false).map((tool) => tool.name)).toEqual(["gmail-read", "web-fetch"]);
  });
  it("keeps public URL reads available without computer control and deduplicates them", () => {
    const tools = conversationComputerTools([], false);
    expect(tools.map((tool) => tool.name)).toEqual(["web-fetch"]);
    expect(conversationComputerTools(tools, false)).toEqual(tools);
  });
  it("resolves visual access against the executing model on every turn", () => {
    const provider = { backendType: "codex-app-server", authState: "connected", capabilities: ["tool-requests"] } as BackendProvider;
    const vision = { id: "vision", label: "Vision", available: true, capabilities: { vision: true } };
    expect(conversationToolsForModel([], true, provider, vision, enabled).map((tool) => tool.name)).toContain("local-desktop-observe");
    expect(conversationToolsForModel([], true, provider, { ...vision, available: false }, enabled).map((tool) => tool.name)).not.toContain("local-desktop-observe");
    expect(conversationToolsForModel([], false, provider, vision).map((tool) => tool.name)).toEqual(["web-fetch"]);
  });
  it("only advertises visual tools with a supported native image route", () => {
    expect(conversationComputerTools([], true).map((tool) => tool.name)).not.toContain("local-desktop-observe");
    expect(conversationComputerTools([], true, true, enabled).map((tool) => tool.name)).toEqual(expect.arrayContaining(["local-desktop-observe", "local-desktop-action"]));
    const provider = { backendType: "codex-app-server", authState: "connected", capabilities: ["tool-requests"] } as BackendProvider;
    expect(supportsComputerVision(provider, {id:"vision",label:"Vision",available:true,capabilities:{vision:true}})).toBe(true);
    expect(supportsComputerVision(provider, {id:"unknown",label:"Unknown",available:true})).toBe(false);
    expect(supportsComputerVision({...provider, backendType:"native-api"}, {id:"vision",label:"Vision",available:true,capabilities:{vision:true}})).toBe(false);
  });
});
