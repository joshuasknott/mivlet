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
  it("advertises action-specific inputs without flat irrelevant fields", () => {
    const app = JSON.parse(actionTools.find((tool) => tool.name === "local-app-action")!.parameters);
    expect(app.required).toEqual(["observationId", "input"]);
    expect(app.properties.input.anyOf).toHaveLength(4);
    expect(app.properties.input.anyOf.map((branch: { required: string[] }) => branch.required)).toEqual([
      ["action", "elementRef"],
      ["action", "elementRef", "text"],
      ["action", "elementRef", "deltaY"],
      ["action", "key", "modifiers"]
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
    expect(app.properties.input.anyOf).toHaveLength(4);
    expect(desktop.properties.input.anyOf).toHaveLength(6);
    expect(desktop.properties.input.anyOf.filter((branch: { properties: object }) =>
      "x" in branch.properties)).toHaveLength(2);
  });

  it("describes github-read as a classic OAuth App without private-repo grant", () => {
    const github = registeredToolSpecs().find((tool) => tool.name === "github-read");
    expect(github?.description).toMatch(/Classic OAuth App/);
    expect(github?.description).toMatch(/does not grant private repositories/);
    expect(github?.description).not.toMatch(/GitHub App with read-only/);
  });
});
