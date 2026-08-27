import { describe, expect, it } from "vitest";
import type { BackendProvider, FableAgentProfile, ScheduledExecutionRoute } from "@fable/protocol";
import {
  scheduledAgentForRun,
  scheduledModelForRun,
  scheduledPromptForAgent,
  scheduledProviderForRun
} from "./useScheduledAgent";

function provider(
  id: string,
  models: Array<{ id: string; available?: boolean }>,
  authState: BackendProvider["authState"] = "connected"
): BackendProvider {
  return {
    id,
    backendType: "native-api",
    label: id,
    description: `${id} API`,
    authState,
    capabilities: authState === "connected" ? ["authentication", "streaming"] : [],
    models: models.map((model) => ({
      id: model.id,
      label: model.id,
      available: model.available ?? true
    }))
  };
}

const researcher: FableAgentProfile = {
  id: "agent-research",
  name: "Researcher",
  instructions: "Verify every material claim.",
  modelId: "model-research",
  icon: "agent",
  iconColor: "#865DFA",
  connectorIds: [],
  knowledgeSourceIds: [],
  learnedTasks: [{
    id: "task-citations",
    title: "Citations",
    instruction: "Include a source for each factual conclusion.",
    createdAt: "2026-08-27T09:00:00.000Z",
    updatedAt: "2026-08-27T09:00:00.000Z"
  }],
  permissionLabel: "Ask Me"
};

const currentDefault: ScheduledExecutionRoute = {
  policy: "current-default",
  backendId: "",
  modelId: "",
  permissionMode: "read-only"
};

describe("scheduled teammate routing", () => {
  it("resolves only the exact teammate bound to the Routine", () => {
    expect(scheduledAgentForRun({ agentId: researcher.id }, [researcher])).toBe(researcher);
    expect(scheduledAgentForRun({ agentId: "agent-missing" }, [researcher])).toBeUndefined();
    expect(scheduledAgentForRun({}, [researcher])).toBeUndefined();
  });

  it("uses the connected provider that can run the teammate's selected model", () => {
    const fallback = provider("fallback", [{ id: "model-default" }]);
    const matching = provider("matching", [{ id: researcher.modelId }]);
    const selected = scheduledProviderForRun(
      { execution: currentDefault },
      researcher,
      [fallback, matching],
      fallback
    );

    expect(selected).toBe(matching);
    expect(scheduledModelForRun({ execution: currentDefault }, researcher, selected))
      .toBe(researcher.modelId);
  });

  it("fails closed instead of drifting to a fallback model", () => {
    const fallback = provider("fallback", [{ id: "model-default" }]);
    expect(scheduledProviderForRun(
      { execution: currentDefault },
      researcher,
      [fallback, provider("offline-match", [{ id: researcher.modelId }], "needs-auth")],
      fallback
    )).toBeUndefined();
  });

  it("honours an explicitly pinned legacy route", () => {
    const fallback = provider("fallback", [{ id: "model-default" }]);
    const pinned = provider("pinned", [{ id: "model-pinned" }]);
    const execution: ScheduledExecutionRoute = {
      policy: "pinned",
      backendId: pinned.id,
      modelId: "model-pinned",
      permissionMode: "read-only"
    };

    expect(scheduledProviderForRun({ execution }, researcher, [fallback, pinned], fallback))
      .toBe(pinned);
    expect(scheduledModelForRun({ execution }, researcher, pinned)).toBe("model-pinned");
  });

  it("adds the teammate's instructions and learned responsibilities to the request", () => {
    const prompt = scheduledPromptForAgent("Prepare the daily brief.", researcher);
    expect(prompt).toContain("Agent instructions:\nVerify every material claim.");
    expect(prompt).toContain("Citations: Include a source for each factual conclusion.");
    expect(prompt).toContain("Scheduled request:\nPrepare the daily brief.");
    expect(scheduledPromptForAgent("Legacy request", undefined)).toBe("Legacy request");
  });
});
