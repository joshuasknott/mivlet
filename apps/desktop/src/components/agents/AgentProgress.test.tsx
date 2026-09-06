import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { FableAgentProfile } from "@fable/protocol";
import { AgentProgress } from "./AgentProgress";
import { ProfileAgentAvatar } from "./agent-icons";
const agent: FableAgentProfile = { id: "a", name: "Chief of Staff", icon: "agent", iconColor: "#24bb77", instructions: "", modelId: "", connectorIds: [], knowledgeSourceIds: [], permissionLabel: "Ask Me" };

describe("agent progress", () => {
  it("shows public summaries separately from answers and stops the avatar when complete", () => {
    const props = { agent, transcript: "The answer", summaries: { r1: "Checking the files.", r2: "Comparing the results." } };
    const view = render(<AgentProgress {...props} running activity="Using: read-file" />);
    expect(screen.getByText("Reasoning summary").closest("details")).toHaveAttribute("open");
    expect(screen.getByRole("status")).toHaveTextContent("Using: read-file");
    expect(screen.getByText("The answer")).toBeVisible();
    expect(view.container.querySelector(".agent-avatar--thinking")).not.toBeNull();
    view.rerender(<AgentProgress {...props} running={false} />);
    expect(screen.getByText("Reasoning summary").closest("details")).not.toHaveAttribute("open");
    expect(view.container.querySelector(".agent-avatar--thinking")).toBeNull();
  });
  it("does not fabricate a summary when the provider has not supplied one", () => {
    render(<AgentProgress agent={agent} running transcript="" />);
    expect(screen.getByText("Thinking…")).toBeVisible();
    expect(screen.queryByText("Reasoning summary")).toBeNull();
  });
  it("leaves uploaded portrait colours intact", () => {
    const view = render(<ProfileAgentAvatar agent={{ ...agent, iconImageDataUrl: "data:image/png;base64,a" }} thinking />);
    expect(view.container.querySelector("img")?.style.filter).toBe("");
    expect(view.container.querySelector("feColorMatrix")).toBeNull();
  });
});
