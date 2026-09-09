import { describe, expect, it } from "vitest";
import { builtinPluginInstructions, builtinPluginMentions, mentionedBuiltinPlugins } from "./builtin-plugins";
import { conversationComputerTools } from "./computer-tools";

describe("callable built-in plugins", () => {
  it("offers only enabled mentions and recognizes complete case-insensitive tokens", () => {
    expect(builtinPluginMentions()).toEqual([]);
    expect(builtinPluginMentions({ browser: true, computer: false }).map((entry) => entry.id)).toEqual(["browser"]);
    expect(mentionedBuiltinPlugins("Try @Browser, then @computer. @browser").map((entry) => entry.id)).toEqual(["browser", "computer"]);
    expect(mentionedBuiltinPlugins("email@browser.com @computerized @browser-extra")).toEqual([]);
  });
  it("selects the real browser tools without granting computer access", () => {
    const plugins = { browser: true, computer: false };
    const tools = conversationComputerTools([], true, true, plugins);
    const instructions = builtinPluginInstructions("@browser read this page", plugins, tools.map((tool) => tool.name));
    expect(instructions).toContain("local-browser tools");
    expect(tools.some((tool) => tool.name === "local-browser-observe")).toBe(true);
    expect(tools.some((tool) => tool.name === "run-shell")).toBe(false);
  });
  it("rejects stale disabled mentions and unavailable runtime on new turns or retries", () => {
    expect(() => builtinPluginInstructions("@computer make a file", { browser: true, computer: false }, ["run-shell"])).toThrow("Enable Computer Use");
    expect(() => builtinPluginInstructions("@browser open this", { browser: true, computer: false }, ["web-fetch"])).toThrow("Start the agent's computer");
    expect(() => builtinPluginInstructions("@browser", undefined, [])).toThrow("Enable Browser");
  });
  it("reports visual-route limitations while keeping terminal work callable", () => {
    const plugins = { browser: false, computer: true };
    const names = conversationComputerTools([], true, false, plugins).map((tool) => tool.name);
    expect(builtinPluginInstructions("@computer run tests", plugins, names)).toContain("Visual desktop control is unavailable");
    expect(builtinPluginInstructions("Ordinary chat", undefined, [])).toBe("");
  });
});
