import { describe, expect, it } from "vitest";
import type { MivletAgentProfile } from "@mivlet/protocol";
import { reconcileWorkspaceAgents } from "./workspace-agent-reconciliation";

const agent = (id: string): MivletAgentProfile => ({ id, name: id, instructions: "Original",
  modelId: "provider::model", icon: "agent", iconColor: "#865DFA", permissionLabel: "Ask Me",
  connectorIds: [], knowledgeSourceIds: [] });

describe("workspace agent reconciliation", () => {
  it("retains an unrelated settings edit and both independently created agents", () => {
    const before = agent("lead");
    const local = { ...before, iconImageDataUrl: "data:image/png;base64,avatar" };
    const saved = { ...before, instructions: "Own the research" };
    const result = reconcileWorkspaceAgents([before], [local, agent("manual")], [saved, agent("chat")]);
    expect(result).toEqual({ conflict: false, agents: [
      { ...saved, iconImageDataUrl: local.iconImageDataUrl }, agent("chat"), agent("manual"),
    ] });
  });

  it("keeps the saved value and reports conflicting edits to the same field", () => {
    const before = agent("lead");
    expect(reconcileWorkspaceAgents([before], [{ ...before, name: "Local name" }], [{ ...before, name: "Chat name" }]))
      .toEqual({ conflict: true, agents: [{ ...before, name: "Chat name" }] });
  });

  it("never resurrects a natively deleted agent after a late settings edit", () => {
    const before = agent("retired");
    expect(reconcileWorkspaceAgents([before], [{ ...before, name: "Late edit" }], []))
      .toEqual({ conflict: true, agents: [] });
  });

  it("retains local deletion when the native action touched a different agent", () => {
    const before = agent("retired");
    expect(reconcileWorkspaceAgents([before], [], [before, agent("new")]))
      .toEqual({ conflict: false, agents: [agent("new")] });
  });

  it("keeps a surviving agent when simultaneous deletions would empty the workspace", () => {
    const first = agent("first");
    const second = agent("second");
    expect(reconcileWorkspaceAgents([first, second], [first], [second]))
      .toEqual({ conflict: true, agents: [second] });
  });
});
