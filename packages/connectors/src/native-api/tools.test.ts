import { describe, expect, it } from "vitest";
import type { NativeCompletionRequest } from "@mivlet/protocol";
import { shapeAnthropicRequest } from "./anthropic";
import { shapeOpenAiRequest } from "./openai-compat";
import { registeredToolSpecs } from "./tools";

const actionTools = registeredToolSpecs().filter((tool) =>
  ["local-app-action", "local-desktop-action"].includes(tool.name)
);
const request: NativeCompletionRequest = {
  providerId: "openai",
  model: "gpt-5",
  messages: [{ role: "user", content: "Use Calculator" }],
  tools: actionTools,
  maxTokens: 100
};

describe("native application action schemas", () => {
  it("shares bounded browser scrolling without coordinate, amount or script inputs", () => {
    const tool = registeredToolSpecs().find(tool => tool.name === "local-browser-scroll")!;
    const schema = JSON.parse(tool.parameters);
    expect(schema.required).toEqual(["scrollRef", "origin", "direction"]);
    expect(Object.keys(schema.properties)).toEqual(["scrollRef", "origin", "direction"]);
    expect(schema.properties.direction.enum).toEqual(["up", "down"]);
    expect(schema.additionalProperties).toBe(false);
    const requestWithScroll = { ...request, tools: [tool] };
    const openAi = shapeOpenAiRequest(requestWithScroll) as { tools: Array<{ function: { parameters: unknown } }> };
    const anthropic = shapeAnthropicRequest({ ...requestWithScroll, providerId: "anthropic" }) as { tools: Array<{ input_schema: unknown }> };
    expect(openAi.tools[0].function.parameters).toEqual(schema);
    expect(anthropic.tools[0].input_schema).toEqual(schema);
  });
  it("shares exact observed browser click scope without script, selector or coordinate inputs", () => {
    const tool = registeredToolSpecs().find(tool => tool.name === "local-browser-click")!;
    const schema = JSON.parse(tool.parameters);
    expect(schema.required).toEqual(["controlRef", "origin", "name"]);
    expect(Object.keys(schema.properties)).toEqual(["controlRef", "origin", "name"]);
    expect(schema.additionalProperties).toBe(false);
    const requestWithClick = { ...request, tools: [tool] };
    const openAi = shapeOpenAiRequest(requestWithClick) as { tools: Array<{ function: { parameters: unknown } }> };
    const anthropic = shapeAnthropicRequest({ ...requestWithClick, providerId: "anthropic" }) as { tools: Array<{ input_schema: unknown }> };
    expect(openAi.tools[0].function.parameters).toEqual(schema);
    expect(anthropic.tools[0].input_schema).toEqual(schema);
  });
  it("advertises action-specific inputs without flat irrelevant fields", () => {
    const app = JSON.parse(actionTools.find((tool) => tool.name === "local-app-action")!.parameters);
    expect(app.required).toEqual(["observationId", "input"]);
    expect(app.properties.input.anyOf).toHaveLength(5);
    expect(app.properties.input.anyOf.map((branch: { required: string[] }) => branch.required)).toEqual([
      ["action", "elementRef"],
      ["action", "elementRef", "text"],
      ["action", "elementRef", "deltaY"],
      ["action", "key", "modifiers"],
      ["action", "shortcut"]
    ]);
    expect(app.properties).not.toHaveProperty("text");
    expect(app.properties.input.anyOf.every((branch: { additionalProperties: boolean }) =>
      branch.additionalProperties === false)).toBe(true);
  });

  it("preserves the same nested schema through OpenAI and Anthropic transports", () => {
    const expected = JSON.parse(actionTools[0].parameters);
    const openAi = shapeOpenAiRequest(request) as { tools: Array<{ function: { parameters: unknown } }> };
    const anthropic = shapeAnthropicRequest({ ...request, providerId: "anthropic" }) as {
      tools: Array<{ input_schema: unknown }>;
    };
    expect(openAi.tools[0].function.parameters).toEqual(expected);
    expect(anthropic.tools[0].input_schema).toEqual(expected);
  });

  it("limits pixel branches to foreground desktop actions", () => {
    const app = JSON.parse(actionTools[0].parameters);
    const desktop = JSON.parse(actionTools[1].parameters);
    expect(app.properties.input.anyOf).toHaveLength(5);
    expect(desktop.properties.input.anyOf).toHaveLength(7);
    expect(desktop.properties.input.anyOf.filter((branch: { properties: object }) =>
      "x" in branch.properties)).toHaveLength(2);
  });

  it("describes github-read as a classic OAuth App without private-repo grant", () => {
    const github = registeredToolSpecs().find((tool) => tool.name === "github-read");
    expect(github?.description).toMatch(/Classic OAuth App/);
    expect(github?.description).toMatch(/does not grant private repositories/);
    expect(github?.description).not.toMatch(/GitHub App with read-only/);
  });
  it("offers a closed shortcut vocabulary without caller-controlled keys or modifiers", () => {
    for (const tool of actionTools) {
      const branches = JSON.parse(tool.parameters).properties.input.anyOf;
      const shortcut = branches.find((branch: { properties: { action: { enum: string[] } } }) => branch.properties.action.enum[0] === "shortcut");
      expect(shortcut.properties.shortcut.enum).toEqual(["select-all", "find", "address-bar", "browser-back", "browser-forward", "browser-reload"]);
      expect(shortcut.properties).not.toHaveProperty("key");
      expect(shortcut.properties).not.toHaveProperty("modifiers");
      expect(shortcut.additionalProperties).toBe(false);
    }
  });
});
