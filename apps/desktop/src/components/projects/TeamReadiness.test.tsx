import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { BackendProvider, FableAgentProfile } from "@fable/protocol";
import { TeamReadiness, teamRouteReadiness } from "./TeamReadiness";
import type { ProviderModelOption } from "../../lib/provider-models";

const agent = (id: string, name: string, modelId: string): FableAgentProfile => ({
  id,
  name,
  instructions: "",
  modelId,
  icon: "agent",
  iconColor: "#865DFA",
  connectorIds: [],
  knowledgeSourceIds: [],
  permissionLabel: "Ask Me",
});

const model = (providerId: string, id: string): ProviderModelOption => ({
  id: `${providerId}::${id}`,
  providerId,
  providerLabel: providerId,
  modelId: id,
  label: id,
  available: true,
  capabilities: { tools: true },
});

const provider = (id: string): BackendProvider => ({
  id,
  backendType: "native-api",
  label: id,
  description: "",
  authState: "connected",
  capabilities: ["tool-requests"],
  models: [],
});

describe("Project Team route readiness", () => {
  it("does not advertise an unavailable model on a connected provider as ready", () => {
    const readiness = teamRouteReadiness(
      ["agent"],
      [agent("agent", "Agent", "openai::gpt")],
      [{ ...model("openai", "gpt"), available: false }],
      [provider("openai")],
    );
    expect(readiness[0].state).toBe("model-missing");
  });

  it("reports ready, disconnected, unsupported and missing routes accurately", () => {
    const readiness = teamRouteReadiness(
      ["ready", "offline", "owned", "gone"],
      [
        agent("ready", "Ready", "openai::gpt"),
        agent("offline", "Offline", "anthropic::claude"),
        agent("owned", "Owned", "cursor::auto"),
      ],
      [
        model("openai", "gpt"),
        model("anthropic", "claude"),
        model("cursor", "auto"),
      ],
      [
        provider("openai"),
        { ...provider("anthropic"), authState: "needs-auth" },
        { ...provider("cursor"), backendType: "cursor-acp" },
      ],
    );
    expect(readiness.map((entry) => entry.state)).toEqual([
      "ready",
      "provider-disconnected",
      "route-unsupported",
      "agent-missing",
    ]);
    expect(readiness[1].prerequisite).toContain("Connect anthropic");
    expect(readiness[2].prerequisite).toContain("collaboration tools");
    expect(readiness[3].prerequisite).toContain("current agent");
  });

  it("renders each prerequisite in an accessible list", () => {
    render(
      <TeamReadiness
        participantIds={["offline"]}
        agents={[agent("offline", "Offline", "anthropic::claude")]}
        models={[model("anthropic", "claude")]}
        providers={[{ ...provider("anthropic"), authState: "needs-auth" }]}
      />,
    );
    expect(
      screen.getByRole("list", { name: "Participant route readiness" }),
    ).toBeVisible();
    expect(screen.getByText(/Connect anthropic/)).toBeVisible();
  });
});
