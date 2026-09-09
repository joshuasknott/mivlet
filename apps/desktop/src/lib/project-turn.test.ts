import { describe, expect, it } from "vitest";
import type { FableAgentProfile } from "@fable/protocol";
import { projectContributions } from "./project-turn";

const profile = (id: string, modelId: string): FableAgentProfile => ({ id, name: id, modelId, instructions: "", icon: "agent", iconColor: "#000000", connectorIds: [], knowledgeSourceIds: [], permissionLabel: "Ask Me" });
const models = ["first", "second"].map((providerId) => ({ id: `${providerId}::shared-name`, modelId: "shared-name", providerId, providerLabel: providerId, label: "Shared name", available: true }));
describe("project contribution routes", () => {
  it("keeps each recipient's exact provider when model names overlap", () => {
    expect(projectContributions([profile("a", models[0].id), profile("b", models[1].id)], "all", models).map(({ agentId, providerId }) => ({ agentId, providerId }))).toEqual([{ agentId: "a", providerId: "first" }, { agentId: "b", providerId: "second" }]);
  });
  it("fails before any batch starts if a recipient's model is unavailable", () => {
    expect(() => projectContributions([profile("a", models[0].id), profile("b", "missing")], "all", models)).toThrow("Choose a connected model for b");
    expect(projectContributions([profile("a", models[0].id), profile("b", "missing")], "a", models)).toHaveLength(1);
  });
});
