import { describe, expect, it } from "vitest";
import { conversationComputerTools, conversationToolsForModel, supportsComputerVision, computerToolsReady, isLocalComputerTool } from "./computer-tools";
import type { BackendProvider, LocalComputerSnapshot } from "@fable/protocol";

describe("conversation computer tools", () => {
  const enabled = { browser: true, computer: true };
  const connector = { name: "gmail-read", description: "Read Gmail", parameters: "{}" };
  it("requires a separate image API connection and Computer plugin even for previously discovered image tools", () => {
    const discovered = ["generate-image", "edit-image"].map((name) => ({ name, description: "Image API", parameters: "{}" }));
    expect(conversationComputerTools(discovered, true, true, enabled).map((tool) => tool.name)).not.toContain("generate-image");
    expect(conversationComputerTools(discovered, true, true, { browser: true, computer: false }, true).map((tool) => tool.name)).not.toContain("edit-image");
    expect(conversationComputerTools(discovered, false, true, enabled, true).map((tool) => tool.name)).not.toContain("generate-image");
    expect(conversationComputerTools(discovered, true, false, enabled, true).map((tool) => tool.name)).toEqual(expect.arrayContaining(["generate-image", "edit-image"]));
    expect(isLocalComputerTool("generate-image", "{}")).toBe(true);
    expect(isLocalComputerTool("edit-image", "{}")).toBe(true);
  });
  it("offers first-use startup only when Docker is available and control has not been paused", () => {
    const computer = { lifecycle: "unprovisioned", browserAvailable: true, controller: "agent" } as LocalComputerSnapshot;
    expect(computerToolsReady(computer)).toBe(true);
    expect(computerToolsReady({ ...computer, browserAvailable: false })).toBe(false);
    expect(computerToolsReady({ ...computer, controller: "paused" })).toBe(false);
    expect(computerToolsReady({ ...computer, controller: "human" })).toBe(false);
    expect(computerToolsReady({ ...computer, lifecycle: "stopped" })).toBe(false);
  });
  it("keeps computer tools alongside connected apps and excludes hosted runtimes", () => {
    const tools = conversationComputerTools([connector], true, false, enabled).map((tool) => tool.name);
    expect(tools).toEqual(expect.arrayContaining(["gmail-read", "run-shell", "read-file", "write-file", "local-browser-observe"]));
    expect(tools).not.toContain("cloud-browser");
    expect(new Set(tools).size).toBe(tools.length);
  });
  it("fails closed for unknown settings and removes stale connected computer tools", () => {
    const previous = conversationComputerTools([], true, true, enabled);
    expect(conversationComputerTools(previous, true, true).map(tool => tool.name)).toEqual(["web-fetch"]);
  });
  it("browser enablement never grants shell, desktop or filesystem tools", () => {
    const names = conversationComputerTools([], true, true, { browser: true, computer: false }).map(tool => tool.name);
    expect(names).toContain("local-browser-observe");
    expect(names).toContain("computer-artifact");
    expect(names).not.toContain("run-shell");
    expect(names).not.toContain("read-file");
    expect(names).not.toContain("local-desktop-action");
    const computer = conversationComputerTools([], true, true, { browser: false, computer: true }).map(tool => tool.name);
    expect(computer).toContain("run-shell");
    expect(computer).not.toContain("local-browser-action");
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
