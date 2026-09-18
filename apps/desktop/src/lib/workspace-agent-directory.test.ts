import { describe, expect, it } from "vitest";
import type { BackendProvider, MivletAgentProfile } from "@mivlet/protocol";
import { workspaceAgentDirectory } from "./workspace-agent-directory";
import { providerModelOptions } from "./provider-models";

describe("workspace agent discovery", () => {
  const provider = { id: "fixture", label: "Fixture", backendType: "native-api", authState: "connected", capabilities: ["tool-requests", "approvals"], models: [{ id: "model", label: "Model", available: true }] } as BackendProvider;
  const models = providerModelOptions([{ provider, models: provider.models }]);
  const agent = { id: "reviewer", name: "Reviewer", modelId: models[0].id, permissionLabel: "Ask Me", instructions: "PRIVATE INSTRUCTIONS", threadId: "PRIVATE CHAT", learnedTasks: [{ id: "skill", title: "Review", instruction: "PRIVATE SKILL DETAILS" }] } as MivletAgentProfile;
  it("discovers configured IDs and capability labels without sharing private profile context", () => {
    const result = workspaceAgentDirectory([agent], models, [provider]);
    expect(result[0]).toMatchObject({ agentId: "reviewer", name: "Reviewer", available: true, coordination: true, skills: ["Review"] });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
  it("reports missing or disconnected routes without substituting a provider", () => {
    expect(workspaceAgentDirectory([{ ...agent, modelId: "gone::model" }], models, [provider])[0]).toMatchObject({ available: false, coordination: false });
    expect(workspaceAgentDirectory([agent], models, [{ ...provider, authState: "failed" }])[0]).toMatchObject({ available: false, prerequisite: expect.stringContaining("Connect") });
  });
});
